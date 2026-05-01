import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import {
  readRepoConfig,
  setClass,
  addEngagement,
  validatePattern,
  type RepoClass,
  REPO_CLASSES,
} from "@de-otio/repo-aegis-core";
import { emitJson, emitText, emitError, type OutputOptions } from "../format.js";

// --------------------------------------------------------------------------
// Types
// --------------------------------------------------------------------------

interface ClassifyRule {
  match: string;
  class: RepoClass;
  engagement?: string;
}

interface ClassifyConfig {
  rules: ClassifyRule[];
}

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

function isValidClass(s: string): s is RepoClass {
  return (REPO_CLASSES as readonly string[]).includes(s);
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

  if (!parsed || typeof parsed !== "object" || !("rules" in parsed)) {
    emitError(
      {
        code: "RULES_PARSE_ERROR",
        error: "rules file must be a YAML mapping with a top-level 'rules:' list",
        details: rulesPath,
      },
      opts,
    );
  }

  const root = parsed as { rules: unknown };
  if (!Array.isArray(root.rules)) {
    emitError(
      {
        code: "RULES_PARSE_ERROR",
        error: "'rules' must be a list",
        details: rulesPath,
      },
      opts,
    );
  }

  // Validate each rule
  const invalid: { index: number; reason: string }[] = [];

  for (let i = 0; i < root.rules.length; i++) {
    const rule = root.rules[i];
    if (!rule || typeof rule !== "object") {
      invalid.push({ index: i, reason: "rule must be an object" });
      continue;
    }

    const r = rule as Partial<ClassifyRule & { class: string }>;

    if (typeof r.match !== "string") {
      invalid.push({ index: i, reason: "rule missing string 'match'" });
      continue;
    }

    if (typeof r.class !== "string" || !isValidClass(r.class)) {
      invalid.push({
        index: i,
        reason: `invalid class '${String(r.class)}'; must be one of: ${REPO_CLASSES.join(", ")}`,
      });
      continue;
    }

    if (r.class === "customer-coupled" && typeof r.engagement !== "string") {
      invalid.push({
        index: i,
        reason: "customer-coupled rules must include an 'engagement' field",
      });
      continue;
    }

    const validation = validatePattern(r.match);
    if (!validation.ok) {
      invalid.push({
        index: i,
        reason: `invalid match pattern: ${validation.reason ?? "unknown"}`,
      });
    }
  }

  if (invalid.length > 0) {
    const details = invalid.map(e => `  rule[${e.index}]: ${e.reason}`).join("\n");
    emitError(
      {
        code: "INVALID_RULES",
        error: `${invalid.length} invalid rule${invalid.length === 1 ? "" : "s"} in rules file`,
        details: details,
      },
      opts,
    );
  }

  return { rules: root.rules as ClassifyRule[] };
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
