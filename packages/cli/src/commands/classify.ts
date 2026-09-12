// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import {
  readRepoConfig,
  setClass,
  addEngagement,
  validatePattern,
  formatZodError,
  appendAuditRecord,
  loadRegistry,
  parseRemoteUrl,
  recordWorkingTree,
  type RepoClass,
  type Registry,
  REPO_CLASSES,
} from "@de-otio/repo-aegis-core";
import { emitJson, emitText, emitError, type OutputOptions } from "../format.js";
import { cacheVisibility, probeGithubVisibility, type VisibilityProbe } from "../visibility.js";

// --------------------------------------------------------------------------
// Types and schema
// --------------------------------------------------------------------------

const classifyRuleSchema = z
  .object({
    match: z.string({ message: "rule missing string 'match'" }),
    class: z.enum(REPO_CLASSES as readonly [RepoClass, ...RepoClass[]], {
      message: `invalid class; must be one of: ${REPO_CLASSES.join(", ")}`,
    }),
    engagement: z.string().optional(),
  })
  .passthrough()
  .refine(
    rule => !(rule.class === "customer-coupled" && rule.engagement === undefined),
    { message: "customer-coupled rules must include an 'engagement' field" },
  );

const classifyConfigSchema = z
  .object({
    rules: z.array(classifyRuleSchema, { message: "'rules' must be a list" }),
  })
  .passthrough();

type ClassifyRule = z.infer<typeof classifyRuleSchema>;
type ClassifyConfig = z.infer<typeof classifyConfigSchema>;

interface ClassifyOptions extends OutputOptions {
  apply?: boolean;
  rules?: string;
  cwd?: string;
  /**
   * Test seam: the GitHub visibility probe. Production uses the real `gh`
   * probe; tests inject so the classification of a `personalOrgs` repo does
   * not depend on the developer's own GitHub account.
   */
  probe?: (cwd: string) => VisibilityProbe;
}

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

function defaultRulesPath(): string {
  return join(homedir(), ".config", "repo-aegis", "classify.yml");
}

function getRemoteUrl(cwd: string): string | null {
  try {
    const out = execFileSync("git", ["remote", "get-url", "origin"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

function loadClassifyConfig(
  rulesPath: string,
  opts: OutputOptions,
): ClassifyConfig | null {
  if (!existsSync(rulesPath)) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = parse(readFileSync(rulesPath, "utf8"));
  } catch (err) {
    emitError(
      {
        code: "RULES_PARSE_ERROR",
        error: `failed to parse rules file: ${(err as Error).message}`,
        details: rulesPath,
      },
      opts,
    );
  }

  // Pre-zod tests pin on this exact wording when the file isn't even a
  // mapping (e.g. raw scalar). Catch it explicitly so the user sees a
  // top-level diagnostic instead of zod's nested-path expansion.
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    emitError(
      {
        code: "RULES_PARSE_ERROR",
        error: "rules file must be a YAML mapping with a top-level 'rules:' list",
        details: rulesPath,
      },
      opts,
    );
  }

  let validated: ClassifyConfig;
  try {
    validated = classifyConfigSchema.parse(parsed);
  } catch (err) {
    if (err instanceof z.ZodError) {
      emitError(
        {
          code: "INVALID_RULES",
          error: `${err.issues.length} invalid rule${err.issues.length === 1 ? "" : "s"} in rules file`,
          details: formatZodError(err, "rules"),
        },
        opts,
      );
    }
    throw err;
  }

  // Pattern-safety validation runs after zod's structural pass: zod
  // confirmed `match` is a string, regex-safety confirms it compiles
  // cleanly within our timeout budget.
  const patternIssues: string[] = [];
  for (let i = 0; i < validated.rules.length; i++) {
    const rule = validated.rules[i]!;
    const validation = validatePattern(rule.match);
    if (!validation.ok) {
      patternIssues.push(
        `  rules[${i}]: invalid match pattern: ${validation.reason ?? "unknown"}`,
      );
    }
  }
  if (patternIssues.length > 0) {
    emitError(
      {
        code: "INVALID_RULES",
        error: `${patternIssues.length} invalid rule${patternIssues.length === 1 ? "" : "s"} in rules file`,
        details: patternIssues.join("\n"),
      },
      opts,
    );
  }

  return validated;
}

function matchRule(
  remote: string,
  rules: ClassifyRule[],
): { ruleIndex: number; rule: ClassifyRule } | null {
  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i]!;
    if (new RegExp(rule.match, "i").test(remote)) {
      return { ruleIndex: i, rule };
    }
  }
  return null;
}

// --------------------------------------------------------------------------
// Registry-derived classification (Phase 1 onboarding work)
// --------------------------------------------------------------------------

interface RegistryMatch {
  class: RepoClass;
  engagement: string | null;
  /** Which registry field produced the match. */
  source: "registry-personal" | "registry-engagement";
}

/**
 * Try to classify the repo by parsing its remote URL and looking up the
 * org in the engagement registry. Returns `null` for any non-fatal
 * reason (no parseable github org, registry unreadable, no match), so
 * callers can fall through to the legacy `classify.yml` path.
 */
function classifyFromRegistry(remote: string): RegistryMatch | null {
  const parsed = parseRemoteUrl(remote);
  if (parsed === null) return null;

  let registry: Registry;
  try {
    registry = loadRegistry();
  } catch {
    // Registry missing / unparseable / encrypted — silently fall through.
    // A broken registry is its own problem and the user will see the
    // error on `engagements list` or any other registry-touching
    // command. Classify shouldn't be the surface that exposes it.
    return null;
  }

  const personalOrgs = registry.personalOrgs ?? [];
  if (personalOrgs.includes(parsed.org)) {
    return {
      // PROVISIONAL. "This org is mine" says nothing about whether this
      // particular repo is public, and `isPublicFacing` treats
      // `public-eligible` as public-facing — so a private repo classified
      // this way starts refusing its own legitimate private-infra hosts
      // (#97.2). The caller replaces this with the visibility-derived class.
      class: "public-eligible",
      engagement: null,
      source: "registry-personal",
    };
  }

  for (const eng of registry.engagements) {
    const orgs = eng.githubOrgs ?? [];
    if (orgs.includes(parsed.org)) {
      return {
        class: "customer-coupled",
        engagement: eng.id,
        source: "registry-engagement",
      };
    }
  }

  return null;
}

// --------------------------------------------------------------------------
// Main export
// --------------------------------------------------------------------------

/**
 * Unified match result. Either source produces this shape; the `source`
 * field tells the JSON envelope which derivation was used and `rule`
 * is non-null only when the legacy `classify.yml` path matched.
 */
interface ClassifyMatch {
  source: "registry-personal" | "registry-engagement" | "classify-yml";
  class: RepoClass;
  engagement: string | null;
  /** classify.yml rule index when source === "classify-yml". */
  rule: number | null;
}

export function classify(opts: ClassifyOptions): void {
  const cwd = opts.cwd ?? process.cwd();
  const rulesPath = opts.rules ?? defaultRulesPath();

  // 1. Get remote URL
  const remote = getRemoteUrl(cwd);
  if (remote === null) {
    if (opts.json) {
      emitJson({
        action: "classify",
        remote: null,
        matched: null,
        applied: false,
        suggestion: "set repo-aegis.class manually: git config repo-aegis.class <class>",
      });
    } else {
      emitText("repo-aegis classify: no remote");
      emitText(
        "  suggestion: set class manually with `git config repo-aegis.class <class>`",
      );
    }
    return;
  }

  // 2. Try registry-derived match (Phase 1 onboarding flow).
  const regMatch = classifyFromRegistry(remote);

  // 3. Load legacy classify.yml (may be null if file missing).
  const legacyConfig = loadClassifyConfig(rulesPath, opts);

  // 4. Resolve final match per the precedence rules. Collect any
  //    deprecation / fallback warnings to surface in stderr (and the
  //    JSON envelope's `warnings` array for tooling).
  const warnings: string[] = [];
  let match: ClassifyMatch | null = null;

  // 4a. #97.2: a `personalOrgs` match is a statement about the ORG, not the
  //     repo. Ask GitHub which this repo actually is before choosing a class.
  //     Only this source needs it — a customer-coupled match and a
  //     classify.yml rule do not depend on visibility.
  let probe: VisibilityProbe | null = null;
  let visibilityUnresolved = false;
  if (regMatch !== null && regMatch.source === "registry-personal") {
    probe = (opts.probe ?? (c => probeGithubVisibility(c)))(cwd);
    visibilityUnresolved = probe.visibility === "unknown";
  }

  if (regMatch !== null && !visibilityUnresolved) {
    let resolvedClass: RepoClass = regMatch.class;
    if (probe !== null) {
      if (probe.visibility === "public") {
        resolvedClass = "public-eligible";
      } else {
        resolvedClass = "private-strict";
        warnings.push(
          "this org is personal, but GitHub reports this repo is not public — " +
            "classifying as private-strict, not public-eligible",
        );
      }
    }
    match = {
      source: regMatch.source,
      class: resolvedClass,
      engagement: regMatch.engagement,
      rule: null,
    };
    if (legacyConfig !== null) {
      // Both sources would produce a result; registry wins. Surface a
      // one-shot deprecation pointer so the user knows classify.yml is
      // now redundant for this repo's mapping.
      warnings.push(
        "classify.yml is superseded by the engagement registry; " +
          "run `repo-aegis init --migrate-classify` to migrate",
      );
    }
  } else if (visibilityUnresolved && probe !== null) {
    // Unresolved visibility on a personal-org repo. Guessing is wrong in both
    // directions: `public-eligible` on a private repo makes egress hygiene
    // reject the repo's own legitimate private-infra hosts, while
    // `private-strict` on a public repo switches that enforcement OFF — the
    // leak this tool exists to stop. So no class is suggested, and `--apply`
    // refuses outright below.
    warnings.push(
      `github visibility unresolved (${probe.status}: ${probe.detail}); ` +
        "cannot tell whether this personal repo is public-eligible or private-strict",
    );
    if (probe.fix) warnings.push(`fix: ${probe.fix}`);
  } else if (legacyConfig !== null) {
    // [SEC M-7] Fallback path: registry produced no result but
    // classify.yml has a rule. Use the legacy match and surface the
    // dual-source state so the user can verify before/after migration.
    const legacy = matchRule(remote, legacyConfig.rules);
    if (legacy !== null) {
      match = {
        source: "classify-yml",
        class: legacy.rule.class,
        engagement: legacy.rule.engagement ?? null,
        rule: legacy.ruleIndex,
      };
      warnings.push(
        `classify.yml fallback: rule[${legacy.ruleIndex}] matched ` +
          `(class=${legacy.rule.class}` +
          (legacy.rule.engagement ? `, engagement=${legacy.rule.engagement}` : "") +
          `). Add this org to the engagement registry to remove the dependency on classify.yml.`,
      );
    }
  }

  const current = readRepoConfig(cwd);
  const currentSnapshot = {
    class: current.class,
    engagements: current.engagements,
  };

  // Print warnings to stderr (always, regardless of JSON/text). Each
  // warning is a single line prefixed with "warning:".
  for (const w of warnings) {
    process.stderr.write(`warning: ${w}\n`);
  }

  // The visibility-derived fields ride on every envelope that had a personal
  // match to resolve, matched or not — a tool reading this output must be able
  // to tell "classified as private-strict because GitHub said private" from
  // "classified as private-strict because a rule said so".
  const visibilityPayload =
    probe === null
      ? {}
      : { visibility: probe.visibility, visibilityProbe: { status: probe.status, detail: probe.detail, ...(probe.fix !== undefined && { fix: probe.fix }) } };

  // 5a. #97.2: unresolved visibility on a personal-org repo. A dry run
  //     reports it (it changes nothing); `--apply` refuses, because writing
  //     either class here is a coin flip on whether egress hygiene is enforced.
  if (visibilityUnresolved && probe !== null) {
    if (opts.apply) {
      emitError(
        {
          code: "VISIBILITY_UNRESOLVED",
          error:
            `cannot classify: this repo is in a personal org but its GitHub ` +
            `visibility is unresolved (${probe.status}: ${probe.detail})`,
          details:
            (probe.fix ? `${probe.fix}\n  ` : "") +
            `or set the class explicitly: git config repo-aegis.class <public-eligible|private-strict>`,
        },
        opts,
      );
    }
    if (opts.json) {
      emitJson({
        action: "classify",
        remote,
        matched: null,
        applied: false,
        current: currentSnapshot,
        ...visibilityPayload,
        warnings,
      });
    } else {
      emitText("repo-aegis classify: no class suggested — github visibility unresolved");
      emitText(`  remote: ${remote}`);
      emitText(`  probe:  ${probe.status} — ${probe.detail}`);
      if (probe.fix) emitText(`  fix:    ${probe.fix}`);
      emitText(
        "  or set the class explicitly: git config repo-aegis.class <public-eligible|private-strict>",
      );
    }
    return;
  }

  // 5. No match path.
  if (match === null) {
    if (regMatch === null && legacyConfig === null) {
      // Neither source available. Old behaviour: surface the no-rules
      // suggestion (back-compat for any tooling that pins on this
      // wording).
      if (opts.json) {
        emitJson({
          action: "classify",
          remote,
          matched: null,
          applied: false,
          suggestion:
            `add a 'githubOrgs' entry to an engagement in the registry, ` +
            `or create ${rulesPath} with a 'rules:' list to enable ` +
            `auto-classification`,
          warnings,
        });
      } else {
        emitText(`repo-aegis classify: no rules file found at ${rulesPath}`);
        emitText(`  suggestion: add a 'githubOrgs' entry to an engagement, or`);
        emitText(`              create ${rulesPath} with a 'rules:' list`);
        emitText("  example:");
        emitText("    rules:");
        emitText(`      - match: "github\\.com[:/]my-org/"`);
        emitText(`        class: public-eligible`);
      }
      return;
    }
    // Registry / classify.yml were available but neither matched.
    if (opts.json) {
      emitJson({
        action: "classify",
        remote,
        matched: null,
        applied: false,
        current: currentSnapshot,
        warnings,
      });
    } else {
      emitText("repo-aegis classify: no rule matched");
      emitText(`  remote: ${remote}`);
      emitText(
        "  suggestion: add a matching rule or `githubOrgs` entry, or set class manually",
      );
    }
    return;
  }

  const matchedPayload = {
    source: match.source,
    rule: match.rule,
    class: match.class,
    engagement: match.engagement,
  };

  if (!opts.apply) {
    // Dry-run: print suggestion only
    if (opts.json) {
      emitJson({
        action: "classify",
        remote,
        matched: matchedPayload,
        applied: false,
        current: currentSnapshot,
        ...visibilityPayload,
        warnings,
      });
    } else {
      emitText(`repo-aegis classify: suggested class: ${match.class}`);
      if (match.engagement) {
        emitText(`  engagement: (redacted)`);
      }
      emitText(`  remote: ${remote}`);
      emitText(`  source: ${match.source}`);
      if (probe !== null) emitText(`  github: ${probe.visibility}`);
      emitText("  run with --apply to set");
    }
    return;
  }

  // 6. Apply: set class and optionally engagement
  if (!current.isGitRepo) {
    emitError({ code: "NOT_GIT_REPO", error: "not inside a git repository" }, opts);
  }

  setClass(match.class, cwd);

  if (match.engagement) {
    addEngagement(match.engagement, cwd);
  }

  // The probe already answered, so cache it here rather than leaving the
  // second half of `classify --apply && status` to the operator; then record
  // this checkout in the machine-wide destination cache so a command that
  // names this repository from elsewhere is judged by the class just set.
  if (probe !== null) cacheVisibility(cwd, probe.visibility);
  recordWorkingTree(cwd);

  // Audit (best-effort). Records the class change + engagement attach
  // (when present) as a single action so the trail captures the actual
  // semantics of `classify --apply`. The `details` carries `source`
  // (registry vs classify-yml) so an operator can reconstruct which
  // derivation was authoritative for any given classify-apply.
  try {
    appendAuditRecord({
      action: "classify-apply",
      cwd,
      repo: cwd,
      ...(match.engagement && { engagement: match.engagement }),
      details: {
        class: match.class,
        source: match.source,
        ...(match.rule !== null && { rule: match.rule }),
        previousClass: current.class,
      },
    });
  } catch {
    /* audit log must not break user-facing ops */
  }

  const after = readRepoConfig(cwd);
  const afterSnapshot = {
    class: after.class,
    engagements: after.engagements,
  };

  if (opts.json) {
    emitJson({
      action: "classify",
      remote,
      matched: matchedPayload,
      applied: true,
      before: currentSnapshot,
      after: afterSnapshot,
      ...visibilityPayload,
      warnings,
    });
  } else {
    emitText(`repo-aegis classify: set class to ${match.class}`);
    if (match.engagement) {
      emitText(`  engagement added`);
    }
    emitText(`  remote: ${remote}`);
    emitText(`  source: ${match.source}`);
    if (probe !== null) emitText(`  github: ${probe.visibility}`);
  }
}
