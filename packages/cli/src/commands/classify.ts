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
  type RepoClass,
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
// Main export
// --------------------------------------------------------------------------

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

  // 2. Load rules file
  const config = loadClassifyConfig(rulesPath, opts);
  if (config === null) {
    if (opts.json) {
      emitJson({
        action: "classify",
        remote,
        matched: null,
        applied: false,
        suggestion: `create ${rulesPath} with a 'rules:' list to enable auto-classification`,
      });
    } else {
      emitText(`repo-aegis classify: no rules file found at ${rulesPath}`);
      emitText(`  suggestion: create ${rulesPath} with a 'rules:' list`);
      emitText("  example:");
      emitText("    rules:");
      emitText(`      - match: "github\\.com[:/]my-org/"`);
      emitText(`        class: public-eligible`);
    }
    return;
  }

  // 3. Match rules
  const match = matchRule(remote, config.rules);
  const current = readRepoConfig(cwd);

  const currentSnapshot = {
    class: current.class,
    engagements: current.engagements,
  };

  if (match === null) {
    // No rule matched — print suggestion based on default
    if (opts.json) {
      emitJson({
        action: "classify",
        remote,
        matched: null,
        applied: false,
        current: currentSnapshot,
      });
    } else {
      emitText("repo-aegis classify: no rule matched");
      emitText(`  remote: ${remote}`);
      emitText("  suggestion: add a matching rule or set class manually");
    }
    return;
  }

  const { ruleIndex, rule } = match;
  const matchedPayload = {
    rule: ruleIndex,
    class: rule.class,
    engagement: rule.engagement ?? null,
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
      });
    } else {
      emitText(`repo-aegis classify: suggested class: ${rule.class}`);
      if (rule.engagement) {
        emitText(`  engagement: (redacted)`);
      }
      emitText(`  remote: ${remote}`);
      emitText("  run with --apply to set");
    }
    return;
  }

  // 4. Apply: set class and optionally engagement
  if (!current.isGitRepo) {
    emitError({ code: "NOT_GIT_REPO", error: "not inside a git repository" }, opts);
  }

  setClass(rule.class, cwd);

  if (rule.engagement) {
    addEngagement(rule.engagement, cwd);
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
    });
  } else {
    emitText(`repo-aegis classify: set class to ${rule.class}`);
    if (rule.engagement) {
      emitText(`  engagement added`);
    }
    emitText(`  remote: ${remote}`);
  }
}
