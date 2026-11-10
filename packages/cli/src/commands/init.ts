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
import { join } from "node:path";
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
import {
  requireTerminalForOwnerAdd,
  recordOwnerAdd,
  ownerSetEmptyRefusal,
  OWNER_SET_EMPTY_NEEDS_TTY,
} from "../owner-add-gate.js";
import { confirmOnTerminal, isHumanTerminal } from "../require-terminal.js";
import {
  RegistryCliError,
  assertValidRegistryText,
  personalOrgItemName,
  writeRegistryText,
} from "./registry-mutate.js";

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

# engagements example: uncomment and replace with your own entry.
#
# Deliberately commented out, exactly like always_block above. An engagement
# id is auto-blocked as a literal in every repo that does not declare it (see
# computeDenySet's self-marker rule), so shipping an ACTIVE example entry
# would add a generic placeholder string to every new user's deny set on the
# day they run \`init\` — flagging any file that happens to contain it,
# including this project's own fixtures. An inert example cannot do that.
#
# engagements:
#   - id: acme-2026-q1
#     name: Acme Corp
#     started: 2026-01-01
#     markers:
#       - acme-?corp[^a-zA-Z0-9]
#     notes: |
#       See the design doc for marker pattern conventions.
engagements: []
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
  /**
   * Test seam: defaults to `process.stderr.isTTY`. The migration adds owners
   * to the registry, which only a person at a terminal may do (D8).
   */
  stderrIsTTY?: boolean;
  /** Test seam: defaults to `process.stdin.isTTY`. The migration's confirmation is read from stdin. */
  stdinIsTTY?: boolean;
  /** Test seam: the typed y/N answer to the migration's confirmation. */
  readAnswer?: () => string;
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

/** Engagement id → YAML node, for appending githubOrgs. */
function indexEngagements(doc: ReturnType<typeof parseDocument>): Map<string, YAMLMap> {
  const nodes = new Map<string, YAMLMap>();
  const seq = doc.get("engagements") as YAMLSeq | null;
  if (seq && seq.items) {
    for (const item of seq.items) {
      if (!isMap(item)) continue;
      const idNode = item.get("id");
      const id =
        typeof idNode === "string"
          ? idNode
          : idNode instanceof Scalar && typeof idNode.value === "string"
          ? idNode.value
          : null;
      if (id) nodes.set(id, item as YAMLMap);
    }
  }
  return nodes;
}

/** True when the registry text declares anything a `--force` would destroy. */
function registryDeclaresContent(text: string): boolean {
  if (text.trim() === "") return false;
  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch {
    // Unreadable: cannot show it is empty, so treat it as content (fail closed).
    return true;
  }
  if (parsed === null || parsed === undefined) return false;
  if (typeof parsed !== "object" || Array.isArray(parsed)) return true;
  const r = parsed as Record<string, unknown>;
  const nonEmpty = (v: unknown): boolean => (Array.isArray(v) ? v.length > 0 : v !== undefined && v !== null);
  // Any engagement counts, even one with no owners or markers: its id is a
  // deny-set literal. Everything else listed is an owner, upstream, marker
  // or always-block entry.
  return (
    nonEmpty(r["always_block"]) ||
    nonEmpty(r["personalOrgs"]) ||
    nonEmpty(r["allowedUpstreams"]) ||
    // schemaVersion 3: identities and the requirement are as much the operator's as the owners they map.
    nonEmpty(r["identities"] !== null && typeof r["identities"] === "object" ? Object.keys(r["identities"] as object) : undefined) ||
    r["requireIdentity"] !== undefined ||
    nonEmpty(r["engagements"]) ||
    nonEmpty(r["selfIdentity"]) ||
    nonEmpty(r["privateInfra"]) ||
    nonEmpty(r["publicRegistries"]) ||
    // An explicit `[]` is a deliberate "no exemptions at all" (see
    // `alwaysBlockExemptPaths` in the registry schema), so presence counts.
    (r["alwaysBlockExemptPaths"] !== undefined && r["alwaysBlockExemptPaths"] !== null)
  );
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

  // Collect existing engagement ids (name → node map) for planning. The
  // mutation below re-reads the file under the lock and re-indexes.
  const engagementNodes = indexEngagements(regDoc);

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

  // D8: the migration would add owners to the registry. That tells repo-aegis
  // publishing there is safe, so it needs a person at a terminal. Gate here:
  // the plan is complete (nothing has been written, classify.yml is still in
  // place) and any non-empty plan counts, even if every owner is already
  // present (fail closed; the person can re-run it).
  if (personalOrgsToAdd.length > 0 || engagementOrgsToAdd.length > 0) {
    requireTerminalForOwnerAdd({ kind: "init-migrate" }, opts);

    // The person approves what will be written, not a count: classify.yml is
    // a file an agent can plant a rule in. List every owner and where it
    // goes, then require an explicit y from a stdin TTY. Anything else aborts
    // with nothing written.
    const lines = [
      "init --migrate-classify would register these owners (read from classify.yml):",
      ...[...new Set(personalOrgsToAdd)].map(o => `  personal org      ${o}`),
      ...engagementOrgsToAdd.map(e => `  engagement ${e.engagementId}  github org  ${e.org}`),
      "Registering an owner tells repo-aegis that publishing there is safe.",
    ];
    if (!confirmOnTerminal(lines.join("\n"), "Register these owners?", opts)) {
      emitError(
        {
          code: "MIGRATION_NOT_CONFIRMED",
          error:
            "init --migrate-classify: aborted, nothing was written. " +
            "The owners above need an explicit 'y' typed at a terminal (stdin must be a TTY).",
        },
        opts,
      );
    }
  }

  // Apply mutations under the registry lock. Lock scope covers the
  // YAML mutate, write, and rename so a concurrent registry edit can't
  // corrupt the in-flight migration.
  let schemaBumped = false;
  let ownersActuallyAdded = 0;
  try {
    withLockSync(() => {
      // Read inside the lock: a stale read would overwrite a concurrent edit.
      const lockedDoc = parseDocument(readFileSync(regPath, "utf8"));
      const lockedNodes = indexEngagements(lockedDoc);
      // Bump schemaVersion to 2 if needed.
      const sv = lockedDoc.get("schemaVersion");
      const svNum =
        typeof sv === "number"
          ? sv
          : sv instanceof Scalar && typeof sv.value === "number"
          ? sv.value
          : 1;
      if (svNum < 2) {
        lockedDoc.set("schemaVersion", 2);
        schemaBumped = true;
      }

      // Append personalOrgs (dedupe).
      let personalOrgsSeq = lockedDoc.get("personalOrgs") as YAMLSeq | null;
      if (!personalOrgsSeq || !(personalOrgsSeq instanceof YAMLSeq)) {
        personalOrgsSeq = new YAMLSeq();
        lockedDoc.set("personalOrgs", personalOrgsSeq);
      }
      const personalSet = new Set<string>();
      for (const item of personalOrgsSeq.items ?? []) {
        const name = personalOrgItemName(item);
        if (name !== null) personalSet.add(name);
      }
      for (const org of personalOrgsToAdd) {
        if (!personalSet.has(org)) {
          personalOrgsSeq.add(org);
          personalSet.add(org);
          ownersActuallyAdded++;
        }
      }

      // Append engagement githubOrgs (dedupe per engagement).
      for (const { engagementId, org } of engagementOrgsToAdd) {
        const node = lockedNodes.get(engagementId);
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
        if (!seen.has(org)) {
          orgsSeq.add(org);
          ownersActuallyAdded++;
        }
      }

      // Validate in memory, then write atomically (tmp + rename): a failed
      // migration must never leave an unreadable registry, and must leave
      // classify.yml in place.
      const text = lockedDoc.toString();
      assertValidRegistryText(text);
      writeRegistryText(text, regPath);

      // Rename classify.yml to classify.yml.legacy.
      renameSync(classifyYmlPath, legacyPath);
    });
  } catch (err) {
    if (err instanceof LockTimeoutError) {
      emitError({ code: err.code, error: err.message }, opts);
    }
    if (err instanceof RegistryCliError) {
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

  if (ownersActuallyAdded > 0) {
    recordOwnerAdd({
      kind: "init-migrate",
      added: ownersActuallyAdded,
      via: "init-migrate-classify",
    });
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
      // Exclusive create first: whether the registry already existed is
      // decided by the create itself, not by a separate existsSync probe.
      try {
        writeFileSync(registry, REGISTRY_STUB, { mode: 0o600, flag: "wx" });
        registryScaffolded = true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        registryAlreadyExisted = true;
      }
      if (registryAlreadyExisted && opts.force) {
        // Overwriting a populated registry with the empty stub empties the
        // owner set (rule h switches itself off under D4) and discards the
        // deny set: a person must do it. An empty or stub registry is fine.
        if (registryDeclaresContent(readFileSync(registry, "utf8")) && !isHumanTerminal(opts)) {
          throw new RegistryCliError(OWNER_SET_EMPTY_NEEDS_TTY, ownerSetEmptyRefusal({ kind: "init-force" }));
        }
        writeFileSync(registry, REGISTRY_STUB, { mode: 0o600 });
        registryScaffolded = true;
      }
      if (registryScaffolded) {
        try {
          chmodSync(registry, 0o600);
        } catch {
          /* platform-restricted */
        }
      }
    });
  } catch (err) {
    if (err instanceof LockTimeoutError) {
      emitError({ code: err.code, error: err.message }, opts);
    }
    if (err instanceof RegistryCliError) {
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
  // `failed` distinguishes "you told me not to" from "I tried and couldn't".
  // Both leave the repo unprotected, but only the second is a problem the
  // operator needs to act on, and reporting them with the same word is the
  // ambiguity this whole release is about removing.
  type HooksResult =
    | { ran: true; hooksDir: string }
    | { ran: false; reason: string; failed?: boolean };
  let hooksResult: HooksResult = { ran: false, reason: "--no-with-hooks" };
  if (opts.withHooks !== false) {
    try {
      const { installHooks } = await import("./install-hooks.js");
      installHooks({
        ...(opts.cwd !== undefined && { cwd: opts.cwd }),
        force: opts.force,
        silent: true,
        // Hook installation must not be able to abort an otherwise-successful
        // init. Since the v0.7 default flip this writes GLOBAL git config,
        // which can legitimately be unwritable; before `throwOnError` existed
        // that exited 2 and reported total failure for a partial one, with the
        // home dir already scaffolded. Degrading to "hooks not installed, here
        // is why" is safe now that `status`/`audit`/`doctor` check hook
        // liveness — an uninstalled hook is no longer a silent gap.
        throwOnError: true,
      });
      hooksResult = { ran: true, hooksDir: `${home}/hooks` };
    } catch (err) {
      hooksResult = {
        ran: false,
        reason: `install-hooks failed: ${(err as Error).message}`,
        failed: true,
      };
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
    else if (hooksResult.failed) {
      emitText(`hooks: NOT INSTALLED — ${hooksResult.reason}`);
      emitText(`       this repo is unprotected; fix the cause and run \`repo-aegis install hooks\``);
      emitText(`       (or \`repo-aegis install hooks --local\` for this repo only)`);
    } else emitText(`hooks: skipped (${hooksResult.reason})`);
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
