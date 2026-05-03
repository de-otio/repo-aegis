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
  type RepoClass,
  type Registry,
  REPO_CLASSES,
} from "@de-otio/repo-aegis-core";
import { emitJson, emitText, emitError, type OutputOptions } from "../format.js";

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

  if (regMatch !== null) {
    match = {
      source: regMatch.source,
      class: regMatch.class,
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
        warnings,
      });
    } else {
      emitText(`repo-aegis classify: suggested class: ${match.class}`);
      if (match.engagement) {
        emitText(`  engagement: (redacted)`);
      }
      emitText(`  remote: ${remote}`);
      emitText(`  source: ${match.source}`);
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
      warnings,
    });
  } else {
    emitText(`repo-aegis classify: set class to ${match.class}`);
    if (match.engagement) {
      emitText(`  engagement added`);
    }
    emitText(`  remote: ${remote}`);
    emitText(`  source: ${match.source}`);
  }
}
