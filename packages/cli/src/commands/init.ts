// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
import {
  mkdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
  chmodSync,
  renameSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parse as parseYaml, parseDocument, YAMLSeq, YAMLMap, Scalar, isMap } from "yaml";
import {
  repoAegisHome,
  registryPath,
  markersDir,
  statePath,
  renderMarkers,
  loadRegistry,
  withLockSync,
  ORG_NAME_REGEX,
  RegistryNotFoundError,
  PatternValidationError,
  LockTimeoutError,
  EXIT_USAGE,
  appendAuditRecord,
} from "@de-otio/repo-aegis-core";
import { emitJson, emitText, emitError, type OutputOptions } from "../format.js";

const REGISTRY_STUB = `\
# repo-aegis engagement registry
# See: https://github.com/de-otio/repo-aegis
#
# \`always_block\`: list of regex patterns to block in EVERY repo regardless of class.
# \`engagements\`:  list of customer/employer engagements; each gets its own marker file.

# always_block example: uncomment and replace with your own patterns
# always_block:
#   - PROJECT-CODENAME-EXAMPLE
always_block: []

engagements:
  - id: example-customer
    name: Example Customer
    started: 2026-01-01
    markers: []
    notes: |
      Replace this with a real engagement entry. See the design doc for marker
      pattern conventions.
`;

interface InitOptions extends OutputOptions {
  force?: boolean;
  withHooks?: boolean;
  withClaude?: boolean;
  /** When --with-hooks runs installHooks, this is the cwd it targets. */
  cwd?: string;
  /** Override ~/.claude path used by --with-claude. */
  claudeHome?: string;
  /**
   * Phase 1 onboarding migration. When set, runs only the
   * classify.yml → registry migration and exits. Does not bootstrap or
   * install anything. Idempotent: if the migration has already run
   * (classify.yml.legacy exists, classify.yml absent), returns a clear
   * no-op summary. See {@link runMigrateClassify}.
   */
  migrateClassify?: boolean;
  /**
   * Override the rules-file path. Defaults to
   * `~/.config/repo-aegis/classify.yml`. Used by tests; not exposed via
   * Commander.
   */
  classifyRulesPath?: string;
}

// ---------------------------------------------------------------------------
// classify.yml → registry migration helpers
// ---------------------------------------------------------------------------

interface ClassifyRule {
  match: string;
  class: string;
  engagement?: string;
}

/**
 * Extract a single literal org name from a classify.yml rule pattern.
 * Returns the org for shapes like `github\.com[:/]<org>/`. Returns null
 * when the pattern is non-literal (alternation, character classes
 * beyond the leading `[:/]`, lookaheads, …).
 *
 * Used by `init --migrate-classify` to convert literal-org rules into
 * `personalOrgs` / `engagements[*].githubOrgs` entries; non-literal
 * rules are surfaced for the user to handle manually.
 */
function extractLiteralOrg(pattern: string): string | null {
  const PREFIX = "github\\.com[:/]";
  if (!pattern.startsWith(PREFIX)) return null;
  const rest = pattern.slice(PREFIX.length);
  let i = 0;
  while (i < rest.length) {
    const ch = rest[i]!;
    if (/[a-z0-9-]/i.test(ch)) {
      i++;
    } else {
      break;
    }
  }
  if (i === 0) return null;
  const org = rest.slice(0, i).toLowerCase();
  if (!ORG_NAME_REGEX.test(org)) return null;
  // Whatever follows must be a clean terminator: `/`, `\/`, end-of-pattern.
  // Reject alternation, character classes, quantifiers, etc.
  const after = rest.slice(i);
  if (
    after === "" ||
    after === "/" ||
    after.startsWith("\\/") ||
    after.startsWith("/.git") ||
    after.startsWith("/[") ||
    after.startsWith("\\b") ||
    after.startsWith("/(?:")
  ) {
    return org;
  }
  return null;
}

interface MigrationOutcome {
  /** Org names successfully added to top-level personalOrgs. */
  personalOrgsAdded: string[];
  /** engagementId → orgs successfully added to that engagement's githubOrgs. */
  engagementOrgsAdded: Record<string, string[]>;
  /** Rules that could not be auto-migrated, with the reason. */
  skipped: Array<{ ruleIndex: number; pattern: string; reason: string }>;
  /** Rules that targeted an engagement id not present in the registry. */
  unknownEngagements: Array<{ ruleIndex: number; engagementId: string }>;
}

interface MigrationResult {
  status: "no-classify-yml" | "already-migrated" | "migrated";
  classifyYmlPath: string;
  legacyPath: string;
  outcome?: MigrationOutcome;
  schemaBumped?: boolean;
}

/**
 * Run the classify.yml → registry migration. Returns a structured
 * outcome — caller is responsible for emitting JSON or text.
 *
 * Idempotent:
 *   - classify.yml absent → status: "no-classify-yml"
 *   - classify.yml.legacy already exists → status: "already-migrated"
 *
 * On success, the registry is updated atomically (under withLockSync),
 * `classify.yml` is renamed to `classify.yml.legacy`, and the result
 * carries the per-rule outcomes for diagnostics.
 */
function runMigrateClassify(opts: InitOptions): MigrationResult {
  const home = repoAegisHome();
  const classifyYmlPath =
    opts.classifyRulesPath ?? join(home, "classify.yml");
  const legacyPath = `${classifyYmlPath}.legacy`;

  // Idempotency checks.
  if (existsSync(legacyPath) && !existsSync(classifyYmlPath)) {
    return { status: "already-migrated", classifyYmlPath, legacyPath };
  }
  if (!existsSync(classifyYmlPath)) {
    return { status: "no-classify-yml", classifyYmlPath, legacyPath };
  }

  // Parse classify.yml.
  let parsedRules: ClassifyRule[];
  try {
    const raw = readFileSync(classifyYmlPath, "utf8");
    const parsed = parseYaml(raw) as { rules?: ClassifyRule[] } | null;
    if (!parsed || !Array.isArray(parsed.rules)) {
      emitError(
        {
          code: "RULES_PARSE_ERROR",
          error: "classify.yml must be a YAML mapping with a top-level 'rules:' list",
        },
        opts,
      );
    }
    parsedRules = parsed.rules ?? [];
  } catch (err) {
    emitError(
      {
        code: "RULES_PARSE_ERROR",
        error: `failed to parse classify.yml: ${(err as Error).message}`,
        details: classifyYmlPath,
      },
      opts,
    );
  }

  // Load the registry as a YAML doc (preserves comments / formatting).
  const regPath = registryPath(home);
  const regRaw = readFileSync(regPath, "utf8");
  const regDoc = parseDocument(regRaw);

  // Collect existing engagement ids and build name → node map for
  // efficient githubOrgs append.
  const engagementsSeq = regDoc.get("engagements") as YAMLSeq | null;
  const engagementNodes = new Map<string, YAMLMap>();
  if (engagementsSeq && engagementsSeq.items) {
    for (const item of engagementsSeq.items) {
      if (!isMap(item)) continue;
      const idNode = item.get("id");
      const id =
        typeof idNode === "string"
          ? idNode
          : idNode instanceof Scalar && typeof idNode.value === "string"
          ? idNode.value
          : null;
      if (id) engagementNodes.set(id, item as YAMLMap);
    }
  }

  // Plan the migration without mutating until we know everything is OK.
  const outcome: MigrationOutcome = {
    personalOrgsAdded: [],
    engagementOrgsAdded: {},
    skipped: [],
    unknownEngagements: [],
  };

  const personalOrgsToAdd: string[] = [];
  const engagementOrgsToAdd: Array<{ engagementId: string; org: string }> = [];

  for (let i = 0; i < parsedRules.length; i++) {
    const rule = parsedRules[i]!;
    if (typeof rule.match !== "string" || typeof rule.class !== "string") {
      outcome.skipped.push({
        ruleIndex: i,
        pattern: typeof rule.match === "string" ? rule.match : "<non-string>",
        reason: "rule shape does not match { match: string, class: string }",
      });
      continue;
    }
    const org = extractLiteralOrg(rule.match);
    if (org === null) {
      outcome.skipped.push({
        ruleIndex: i,
        pattern: rule.match,
        reason:
          "could not extract a literal org name; pattern uses alternation, " +
          "character class, or other regex metachars beyond the standard prefix",
      });
      continue;
    }
    if (rule.class === "public-eligible") {
      personalOrgsToAdd.push(org);
      outcome.personalOrgsAdded.push(org);
    } else if (rule.class === "customer-coupled") {
      const engagementId = rule.engagement;
      if (!engagementId) {
        outcome.skipped.push({
          ruleIndex: i,
          pattern: rule.match,
          reason: "customer-coupled rule has no `engagement` field",
        });
        continue;
      }
      if (!engagementNodes.has(engagementId)) {
        outcome.unknownEngagements.push({ ruleIndex: i, engagementId });
        continue;
      }
      engagementOrgsToAdd.push({ engagementId, org });
      const list = outcome.engagementOrgsAdded[engagementId] ?? [];
      list.push(org);
      outcome.engagementOrgsAdded[engagementId] = list;
    } else {
      outcome.skipped.push({
        ruleIndex: i,
        pattern: rule.match,
        reason: `unsupported class "${rule.class}" for migration`,
      });
    }
  }

  // Apply mutations under the registry lock. Lock scope covers the
  // YAML mutate, write, and rename so a concurrent registry edit can't
  // corrupt the in-flight migration.
  let schemaBumped = false;
  try {
    withLockSync(() => {
      // Bump schemaVersion to 2 if needed.
      const sv = regDoc.get("schemaVersion");
      const svNum =
        typeof sv === "number"
          ? sv
          : sv instanceof Scalar && typeof sv.value === "number"
          ? sv.value
          : 1;
      if (svNum < 2) {
        regDoc.set("schemaVersion", 2);
        schemaBumped = true;
      }

      // Append personalOrgs (dedupe).
      let personalOrgsSeq = regDoc.get("personalOrgs") as YAMLSeq | null;
      if (!personalOrgsSeq || !(personalOrgsSeq instanceof YAMLSeq)) {
        personalOrgsSeq = new YAMLSeq();
        regDoc.set("personalOrgs", personalOrgsSeq);
      }
      const personalSet = new Set<string>();
      for (const item of personalOrgsSeq.items ?? []) {
        if (typeof item === "string") personalSet.add(item);
        else if (item instanceof Scalar && typeof item.value === "string")
          personalSet.add(item.value);
      }
      for (const org of personalOrgsToAdd) {
        if (!personalSet.has(org)) {
          personalOrgsSeq.add(org);
          personalSet.add(org);
        }
      }

      // Append engagement githubOrgs (dedupe per engagement).
      for (const { engagementId, org } of engagementOrgsToAdd) {
        const node = engagementNodes.get(engagementId);
        if (!node) continue;
        let orgsSeq = node.get("githubOrgs") as YAMLSeq | null;
        if (!orgsSeq || !(orgsSeq instanceof YAMLSeq)) {
          orgsSeq = new YAMLSeq();
          node.set("githubOrgs", orgsSeq);
        }
        const seen = new Set<string>();
        for (const item of orgsSeq.items ?? []) {
          if (typeof item === "string") seen.add(item);
          else if (item instanceof Scalar && typeof item.value === "string")
            seen.add(item.value);
        }
        if (!seen.has(org)) orgsSeq.add(org);
      }

      // Atomic write: tmp + rename.
      const tmpPath = `${regPath}.migrate-classify.tmp.${process.pid}`;
      writeFileSync(tmpPath, regDoc.toString(), { mode: 0o600 });
      try {
        chmodSync(tmpPath, 0o600);
      } catch {
        /* platform-restricted */
      }
      renameSync(tmpPath, regPath);

      // Rename classify.yml to classify.yml.legacy.
      renameSync(classifyYmlPath, legacyPath);
    });
  } catch (err) {
    if (err instanceof LockTimeoutError) {
      emitError({ code: err.code, error: err.message }, opts);
    }
    emitError(
      {
        code: "MIGRATION_FAILED",
        error: `migration failed: ${(err as Error).message}`,
      },
      opts,
    );
  }

  return {
    status: "migrated",
    classifyYmlPath,
    legacyPath,
    outcome,
    schemaBumped,
  };
}

export async function init(opts: InitOptions): Promise<void> {
  // --migrate-classify: standalone migration; does not bootstrap or
  // install. Returns immediately with a structured outcome.
  if (opts.migrateClassify) {
    const result = runMigrateClassify(opts);
    if (opts.json) {
      emitJson({ action: "migrate-classify", ...result });
      return;
    }
    if (result.status === "no-classify-yml") {
      emitText("migrate-classify: no classify.yml found — nothing to migrate");
      return;
    }
    if (result.status === "already-migrated") {
      emitText(
        `migrate-classify: classify.yml.legacy already exists; ` +
          `no-op. (${result.legacyPath})`,
      );
      return;
    }
    // status === "migrated"
    const o = result.outcome!;
    emitText(`migrate-classify: ${result.classifyYmlPath} → ${result.legacyPath}`);
    if (result.schemaBumped) {
      emitText("  schemaVersion: bumped 1 → 2");
    }
    emitText(`  personalOrgs added: ${o.personalOrgsAdded.length}`);
    const engagementCount = Object.keys(o.engagementOrgsAdded).length;
    emitText(`  engagement githubOrgs touched: ${engagementCount}`);
    if (o.skipped.length > 0) {
      emitText(`  skipped (${o.skipped.length} rule(s) — handle manually):`);
      for (const s of o.skipped) {
        emitText(`    rules[${s.ruleIndex}]: ${s.reason}`);
      }
    }
    if (o.unknownEngagements.length > 0) {
      emitText(`  unknown engagements (${o.unknownEngagements.length} rule(s)):`);
      for (const u of o.unknownEngagements) {
        emitText(`    rules[${u.ruleIndex}]: engagement "${u.engagementId}" not in registry`);
      }
    }

    // Audit-log entry. Engagement ids and structural metadata only —
    // no rule patterns, no org literals.
    try {
      appendAuditRecord({
        action: "migrate-classify",
        details: {
          personalOrgsAdded: o.personalOrgsAdded.length,
          engagementsTouched: engagementCount,
          skipped: o.skipped.length,
          unknownEngagements: o.unknownEngagements.length,
          schemaBumped: !!result.schemaBumped,
        },
      });
    } catch {
      /* audit log must not break user-facing ops */
    }
    return;
  }

  const home = repoAegisHome();
  const markers = markersDir(home);
  const state = statePath(home);
  const registry = registryPath(home);

  // Step 1: create directories with required permissions
  try {
    mkdirSync(home, { recursive: true, mode: 0o700 });
    try {
      chmodSync(home, 0o700);
    } catch {
      /* platform-restricted */
    }

    mkdirSync(markers, { recursive: true, mode: 0o700 });
    try {
      chmodSync(markers, 0o700);
    } catch {
      /* platform-restricted */
    }

    mkdirSync(state, { recursive: true, mode: 0o700 });
    try {
      chmodSync(state, 0o700);
    } catch {
      /* platform-restricted */
    }
  } catch (err) {
    emitError({ code: "FS_ERROR", error: `failed to create home directories: ${(err as Error).message}` }, opts);
  }

  // Step 2: scaffold registry if missing or --force.
  // The scaffold-then-render flow runs under withLockSync so a concurrent
  // `engagements add` can't race the registry write or the subsequent
  // render. Without the lock, two parallel `init --force` runs (rare but
  // possible in scripted setup) could half-write the YAML.
  let registryScaffolded = false;
  let registryAlreadyExisted = false;

  try {
    withLockSync(() => {
      if (!existsSync(registry) || opts.force) {
        registryAlreadyExisted = existsSync(registry) && !!opts.force;
        writeFileSync(registry, REGISTRY_STUB, { mode: 0o600 });
        try {
          chmodSync(registry, 0o600);
        } catch {
          /* platform-restricted */
        }
        registryScaffolded = true;
      } else {
        registryAlreadyExisted = true;
      }
    });
  } catch (err) {
    if (err instanceof LockTimeoutError) {
      emitError({ code: err.code, error: err.message }, opts);
    }
    emitError({ code: "FS_ERROR", error: `failed to write registry: ${(err as Error).message}` }, opts);
  }

  if (!opts.json) {
    if (registryScaffolded) emitText("scaffolded engagements.yaml");
    else emitText(`registry already exists at ${registry}`);
  }

  // Step 3: render markers
  let reg;
  try {
    reg = loadRegistry(registry);
  } catch (err) {
    if (err instanceof RegistryNotFoundError) {
      emitError(
        {
          code: "REGISTRY_NOT_FOUND",
          error: "engagement registry not found after init",
          details: `expected at ${err.path}`,
        },
        opts,
      );
    }
    emitError({ code: "REGISTRY_ERROR", error: (err as Error).message }, opts);
  }

  let rendered;
  try {
    rendered = withLockSync(() => renderMarkers(reg));
  } catch (err) {
    if (err instanceof LockTimeoutError) {
      emitError({ code: err.code, error: err.message }, opts);
    }
    if (err instanceof PatternValidationError) {
      if (opts.json) {
        process.stderr.write(
          JSON.stringify({ code: "PATTERN_VALIDATION", error: err.message, invalidPatterns: err.invalid }) + "\n",
        );
      } else {
        emitText(`repo-aegis: ${err.message} — render aborted`);
        for (const inv of err.invalid) {
          emitText(`  ${inv.engagementId ?? "?"}: ${inv.reason}`);
        }
      }
      process.exit(EXIT_USAGE);
    }
    emitError({ code: "RENDER_ERROR", error: (err as Error).message }, opts);
  }

  // Step 4: install hooks (per-repo) when --with-hooks. Default on.
  // Side-loaded via dynamic import to avoid a cycle (install-hooks.ts
  // doesn't import init, but init keeps the import out of the module
  // top-level so test suites that don't exercise this path stay fast).
  type HooksResult =
    | { ran: true; hooksDir: string }
    | { ran: false; reason: string };
  let hooksResult: HooksResult = { ran: false, reason: "--no-with-hooks" };
  if (opts.withHooks !== false) {
    try {
      const { installHooks } = await import("./install-hooks.js");
      installHooks({
        ...(opts.cwd !== undefined && { cwd: opts.cwd }),
        force: opts.force,
        silent: true,
      });
      hooksResult = { ran: true, hooksDir: `${home}/hooks` };
    } catch (err) {
      // installHooks calls process.exit via emitError on hard failures
      // (NOT_GIT_REPO, FS_ERROR, HOOKS_PATH_CONFLICT). Catching here is
      // best-effort: in practice the throw aborts the process, so we
      // only see this branch on truly unexpected exceptions.
      hooksResult = { ran: false, reason: `install-hooks failed: ${(err as Error).message}` };
    }
  }

  type ClaudeResult =
    | { ran: true; claudeHome: string }
    | { ran: false; reason: string };
  let claudeResult: ClaudeResult = { ran: false, reason: "--no-with-claude" };
  if (opts.withClaude !== false) {
    try {
      const { installClaudeMd } = await import("./install-claude-md.js");
      installClaudeMd({
        ...(opts.claudeHome !== undefined && { claudeHome: opts.claudeHome }),
        silent: true,
        // Phase 1 onboarding: fresh installs get the SessionStart
        // hook by default so JIT classify works out of the box.
        // Existing installs (running `install claude-md` standalone)
        // must opt in via the explicit --first-touch flag.
        firstTouch: true,
      });
      claudeResult = { ran: true, claudeHome: opts.claudeHome ?? "~/.claude" };
    } catch (err) {
      claudeResult = { ran: false, reason: `install-claude-md failed: ${(err as Error).message}` };
    }
  }

  if (!opts.json) {
    if (hooksResult.ran) emitText(`hooks: installed at ${hooksResult.hooksDir}`);
    else emitText(`hooks: skipped (${hooksResult.reason})`);
    if (claudeResult.ran) emitText(`claude-md: installed at ${claudeResult.claudeHome}`);
    else emitText(`claude-md: skipped (${claudeResult.reason})`);
  }

  // Audit (best-effort). One record per init invocation so the trail
  // captures bootstrap events alongside ongoing operator actions.
  try {
    appendAuditRecord({
      action: "init",
      details: {
        home,
        registryScaffolded,
        registryAlreadyExisted,
        withHooks: hooksResult.ran,
        withClaude: claudeResult.ran,
      },
    });
  } catch {
    /* audit log must not break user-facing ops */
  }

  if (opts.json) {
    emitJson({
      action: "init",
      home,
      registry: {
        path: registry,
        scaffolded: registryScaffolded,
        alreadyExisted: registryAlreadyExisted,
      },
      rendered: {
        written: rendered.written,
        removed: rendered.removed,
      },
      hooks: hooksResult,
      claude: claudeResult,
    });
    return;
  }
}
