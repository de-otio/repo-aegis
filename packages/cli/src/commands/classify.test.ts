// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { captureOutput } from "../_test-utils.js";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

let tmp: string;
let gitDir: string;
let nonGitDir: string;
let rulesDir: string;

function gitCmd(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

function writeRules(path: string, content: string): void {
  writeFileSync(path, content, "utf8");
}

before(() => {
  tmp = mkdtempSync(join(tmpdir(), "repo-aegis-classify-"));
  gitDir = join(tmp, "git");
  nonGitDir = join(tmp, "non-git");
  rulesDir = join(tmp, "rules");
  mkdirSync(gitDir, { recursive: true });
  mkdirSync(nonGitDir, { recursive: true });
  mkdirSync(rulesDir, { recursive: true });

  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: gitDir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: gitDir });
  execFileSync("git", ["config", "user.name", "test"], { cwd: gitDir });
});

after(() => {
  rmSync(tmp, { recursive: true, force: true });
});

// Helper: reset git config for repo-aegis keys between tests
function resetRepoAegis(cwd: string): void {
  try {
    execFileSync("git", ["config", "--unset", "repo-aegis.class"], {
      cwd,
      stdio: ["ignore", "ignore", "ignore"],
    });
  } catch {
    /* not set */
  }
  try {
    execFileSync("git", ["config", "--unset-all", "repo-aegis.engagement"], {
      cwd,
      stdio: ["ignore", "ignore", "ignore"],
    });
  } catch {
    /* not set */
  }
}

// Helper: set a fake remote on the git repo
function setRemote(cwd: string, url: string): void {
  try {
    execFileSync("git", ["remote", "remove", "origin"], {
      cwd,
      stdio: ["ignore", "ignore", "ignore"],
    });
  } catch {
    /* no remote yet */
  }
  execFileSync("git", ["remote", "add", "origin", url], { cwd });
}

// Helper: remove remote
function removeRemote(cwd: string): void {
  try {
    execFileSync("git", ["remote", "remove", "origin"], {
      cwd,
      stdio: ["ignore", "ignore", "ignore"],
    });
  } catch {
    /* no remote */
  }
}

// ---------------------------------------------------------------------------
// Import classify after fixtures are set up
// ---------------------------------------------------------------------------

// We import dynamically to avoid module-scope side effects with cwd.
// But since this is ESM with static imports at top we just import at top.
import { classify } from "./classify.js";

// ---------------------------------------------------------------------------
// Tests: 1. No remote
// ---------------------------------------------------------------------------

describe("classify — no remote", () => {
  it("prints 'no remote' and exits 0 when no remote is configured", () => {
    removeRemote(gitDir);
    resetRepoAegis(gitDir);

    const { stdout, exitCode } = captureOutput(() =>
      classify({ cwd: gitDir, rules: join(rulesDir, "nonexistent.yml") }),
    );

    assert.equal(exitCode, undefined, "should not call process.exit");
    assert.ok(stdout.includes("no remote"), `stdout: ${stdout}`);
  });

  it("returns JSON with remote:null when --json and no remote", () => {
    removeRemote(gitDir);
    resetRepoAegis(gitDir);

    const { stdout, exitCode } = captureOutput(() =>
      classify({ cwd: gitDir, json: true, rules: join(rulesDir, "nonexistent.yml") }),
    );

    assert.equal(exitCode, undefined);
    const out = JSON.parse(stdout) as { action: string; remote: null };
    assert.equal(out.action, "classify");
    assert.equal(out.remote, null);
  });
});

// ---------------------------------------------------------------------------
// Tests: 2. No rules file
// ---------------------------------------------------------------------------

describe("classify — no rules file", () => {
  it("prints suggestion when rules file does not exist, exits 0", () => {
    setRemote(gitDir, "git@github.com:org/repo.git");
    resetRepoAegis(gitDir);

    const { stdout, exitCode } = captureOutput(() =>
      classify({ cwd: gitDir, rules: join(rulesDir, "does-not-exist.yml") }),
    );

    assert.equal(exitCode, undefined);
    assert.ok(stdout.includes("no rules file") || stdout.includes("suggestion"), `stdout: ${stdout}`);
  });

  it("returns JSON with matched:null and a suggestion when --json and no rules file", () => {
    setRemote(gitDir, "git@github.com:org/repo.git");
    resetRepoAegis(gitDir);

    const { stdout, exitCode } = captureOutput(() =>
      classify({
        cwd: gitDir,
        json: true,
        rules: join(rulesDir, "does-not-exist.yml"),
      }),
    );

    assert.equal(exitCode, undefined);
    const out = JSON.parse(stdout) as { action: string; remote: string; matched: null; suggestion: string };
    assert.equal(out.action, "classify");
    assert.ok(typeof out.remote === "string");
    assert.equal(out.matched, null);
    assert.ok(typeof out.suggestion === "string");
  });
});

// ---------------------------------------------------------------------------
// Tests: 3. First-rule match
// ---------------------------------------------------------------------------

describe("classify — first-rule match", () => {
  it("suggests class from first matching rule (dry-run)", () => {
    const rulesFile = join(rulesDir, "rules-basic.yml");
    writeRules(
      rulesFile,
      `rules:
  - match: "github\\\\.com[:/]de-otio/"
    class: public-eligible
  - match: ".*"
    class: private-strict
`,
    );

    setRemote(gitDir, "git@github.com:de-otio/repo.git");
    resetRepoAegis(gitDir);

    const { stdout, exitCode } = captureOutput(() =>
      classify({ cwd: gitDir, rules: rulesFile }),
    );

    assert.equal(exitCode, undefined);
    assert.ok(stdout.includes("public-eligible"), `stdout: ${stdout}`);
  });

  it("JSON dry-run returns correct matched rule index and class", () => {
    const rulesFile = join(rulesDir, "rules-basic-json.yml");
    writeRules(
      rulesFile,
      `rules:
  - match: "github\\\\.com[:/]de-otio/"
    class: public-eligible
  - match: ".*"
    class: private-strict
`,
    );

    setRemote(gitDir, "git@github.com:de-otio/repo.git");
    resetRepoAegis(gitDir);

    const { stdout, exitCode } = captureOutput(() =>
      classify({ cwd: gitDir, json: true, rules: rulesFile }),
    );

    assert.equal(exitCode, undefined);
    const out = JSON.parse(stdout) as {
      action: string;
      matched: { rule: number; class: string; engagement: null };
      applied: boolean;
      current: { class: string; engagements: string[] };
    };
    assert.equal(out.action, "classify");
    assert.equal(out.matched.rule, 0);
    assert.equal(out.matched.class, "public-eligible");
    assert.equal(out.matched.engagement, null);
    assert.equal(out.applied, false);
    assert.ok("current" in out);
  });

  it("falls through to second rule when first does not match", () => {
    const rulesFile = join(rulesDir, "rules-fallthrough.yml");
    writeRules(
      rulesFile,
      `rules:
  - match: "github\\\\.com[:/]de-otio/"
    class: public-eligible
  - match: ".*"
    class: private-strict
`,
    );

    setRemote(gitDir, "git@github.com:other-org/repo.git");
    resetRepoAegis(gitDir);

    const { stdout } = captureOutput(() =>
      classify({ cwd: gitDir, json: true, rules: rulesFile }),
    );

    const out = JSON.parse(stdout) as { matched: { rule: number; class: string } };
    assert.equal(out.matched.rule, 1);
    assert.equal(out.matched.class, "private-strict");
  });
});

// ---------------------------------------------------------------------------
// Tests: 4. Customer-coupled rule with engagement
// ---------------------------------------------------------------------------

describe("classify — customer-coupled rule", () => {
  it("suggests both class and engagement in JSON output", () => {
    const rulesFile = join(rulesDir, "rules-cc.yml");
    writeRules(
      rulesFile,
      `rules:
  - match: "github\\\\.com[:/]customer-a/"
    class: customer-coupled
    engagement: customer-a-2025-q4
`,
    );

    setRemote(gitDir, "git@github.com:customer-a/project.git");
    resetRepoAegis(gitDir);

    const { stdout, exitCode } = captureOutput(() =>
      classify({ cwd: gitDir, json: true, rules: rulesFile }),
    );

    assert.equal(exitCode, undefined);
    const out = JSON.parse(stdout) as {
      matched: { class: string; engagement: string | null };
    };
    assert.equal(out.matched.class, "customer-coupled");
    // engagement value is present in the output structure; we do NOT assert
    // its literal string value to avoid echoing the identifier in test output
    assert.ok(typeof out.matched.engagement === "string");
  });
});

// ---------------------------------------------------------------------------
// Tests: 5. --apply actually sets git config
// ---------------------------------------------------------------------------

describe("classify — --apply", () => {
  it("sets repo-aegis.class in git config when --apply is used", () => {
    const rulesFile = join(rulesDir, "rules-apply.yml");
    writeRules(
      rulesFile,
      `rules:
  - match: "github\\\\.com[:/]de-otio/"
    class: public-eligible
`,
    );

    setRemote(gitDir, "git@github.com:de-otio/another.git");
    resetRepoAegis(gitDir);

    const { exitCode } = captureOutput(() =>
      classify({ cwd: gitDir, rules: rulesFile, apply: true }),
    );

    assert.equal(exitCode, undefined);
    const classVal = gitCmd(gitDir, ["config", "--get", "repo-aegis.class"]);
    assert.equal(classVal, "public-eligible");

    resetRepoAegis(gitDir);
  });

  it("JSON --apply output includes before and after snapshots", () => {
    const rulesFile = join(rulesDir, "rules-apply-json.yml");
    writeRules(
      rulesFile,
      `rules:
  - match: "github\\\\.com[:/]de-otio/"
    class: public-eligible
`,
    );

    setRemote(gitDir, "git@github.com:de-otio/another.git");
    resetRepoAegis(gitDir);

    const { stdout, exitCode } = captureOutput(() =>
      classify({ cwd: gitDir, json: true, rules: rulesFile, apply: true }),
    );

    assert.equal(exitCode, undefined);
    const out = JSON.parse(stdout) as {
      applied: boolean;
      before: { class: string };
      after: { class: string };
    };
    assert.equal(out.applied, true);
    assert.ok("before" in out);
    assert.ok("after" in out);
    assert.equal(out.after.class, "public-eligible");

    resetRepoAegis(gitDir);
  });
});

// ---------------------------------------------------------------------------
// Tests: 6. Invalid rules → exit 2
// ---------------------------------------------------------------------------

describe("classify — invalid rules", () => {
  it("exits 2 when a rule has an invalid regex", () => {
    const rulesFile = join(rulesDir, "rules-bad-regex.yml");
    writeRules(
      rulesFile,
      `rules:
  - match: "((("
    class: private-strict
`,
    );

    setRemote(gitDir, "git@github.com:org/repo.git");
    resetRepoAegis(gitDir);

    const { exitCode, stderr } = captureOutput(() =>
      classify({ cwd: gitDir, rules: rulesFile }),
    );

    assert.equal(exitCode, 2);
    assert.ok(stderr.length > 0 || exitCode === 2, "should have emitted error");
  });

  it("exits 2 when a customer-coupled rule is missing engagement", () => {
    const rulesFile = join(rulesDir, "rules-cc-no-engagement.yml");
    writeRules(
      rulesFile,
      `rules:
  - match: "github\\\\.com[:/]customer-a/"
    class: customer-coupled
`,
    );

    setRemote(gitDir, "git@github.com:customer-a/repo.git");
    resetRepoAegis(gitDir);

    const { exitCode } = captureOutput(() =>
      classify({ cwd: gitDir, rules: rulesFile }),
    );

    assert.equal(exitCode, 2);
  });

  it("exits 2 when a rule has an unknown class", () => {
    const rulesFile = join(rulesDir, "rules-bad-class.yml");
    writeRules(
      rulesFile,
      `rules:
  - match: "github\\\\.com"
    class: bogus-class
`,
    );

    setRemote(gitDir, "git@github.com:org/repo.git");
    resetRepoAegis(gitDir);

    const { exitCode } = captureOutput(() =>
      classify({ cwd: gitDir, rules: rulesFile }),
    );

    assert.equal(exitCode, 2);
  });
});

// ---------------------------------------------------------------------------
// Tests: 7. --json output shape
// ---------------------------------------------------------------------------

describe("classify — JSON output shape", () => {
  it("dry-run JSON has required top-level keys", () => {
    const rulesFile = join(rulesDir, "rules-shape.yml");
    writeRules(
      rulesFile,
      `rules:
  - match: "github\\\\.com[:/]de-otio/"
    class: public-eligible
`,
    );

    setRemote(gitDir, "git@github.com:de-otio/shape-test.git");
    resetRepoAegis(gitDir);

    const { stdout } = captureOutput(() =>
      classify({ cwd: gitDir, json: true, rules: rulesFile }),
    );

    const out = JSON.parse(stdout) as Record<string, unknown>;
    assert.ok("action" in out, "missing action");
    assert.ok("remote" in out, "missing remote");
    assert.ok("matched" in out, "missing matched");
    assert.ok("applied" in out, "missing applied");
    assert.ok("current" in out, "missing current");
    assert.equal(out["applied"], false);
  });

  it("apply JSON has 'before' and 'after' instead of 'current'", () => {
    const rulesFile = join(rulesDir, "rules-shape-apply.yml");
    writeRules(
      rulesFile,
      `rules:
  - match: "github\\\\.com[:/]de-otio/"
    class: public-eligible
`,
    );

    setRemote(gitDir, "git@github.com:de-otio/shape-apply.git");
    resetRepoAegis(gitDir);

    const { stdout } = captureOutput(() =>
      classify({ cwd: gitDir, json: true, rules: rulesFile, apply: true }),
    );

    const out = JSON.parse(stdout) as Record<string, unknown>;
    assert.ok("before" in out, "missing before");
    assert.ok("after" in out, "missing after");
    assert.equal(out["applied"], true);
    assert.ok(!("current" in out), "should not have 'current' when applied");

    resetRepoAegis(gitDir);
  });
});

// ---------------------------------------------------------------------------
// Tests: registry-derived classification (Phase 1 onboarding)
// ---------------------------------------------------------------------------

/**
 * Set REPO_AEGIS_REGISTRY env var for the duration of `fn`. Restores the
 * previous value (or unsets) on exit so test isolation is preserved.
 */
function withRegistry<T>(path: string, fn: () => T): T {
  const prev = process.env["REPO_AEGIS_REGISTRY"];
  process.env["REPO_AEGIS_REGISTRY"] = path;
  try {
    return fn();
  } finally {
    if (prev === undefined) {
      delete process.env["REPO_AEGIS_REGISTRY"];
    } else {
      process.env["REPO_AEGIS_REGISTRY"] = prev;
    }
  }
}

describe("classify — registry-derived", () => {
  it("personalOrgs match → public-eligible (dry-run)", () => {
    const reg = join(tmp, "reg-personal.yaml");
    writeFileSync(
      reg,
      `schemaVersion: 2
personalOrgs: [my-handle]
engagements: []
`,
    );
    setRemote(gitDir, "git@github.com:my-handle/dotfiles.git");
    resetRepoAegis(gitDir);

    const { stdout } = withRegistry(reg, () =>
      captureOutput(() =>
        classify({ cwd: gitDir, json: true, rules: join(rulesDir, "no-rules.yml") }),
      ),
    );

    const out = JSON.parse(stdout) as {
      matched: { source: string; class: string; engagement: string | null };
    };
    assert.equal(out.matched.source, "registry-personal");
    assert.equal(out.matched.class, "public-eligible");
    assert.equal(out.matched.engagement, null);
  });

  it("engagement.githubOrgs match → customer-coupled with engagement (dry-run)", () => {
    const reg = join(tmp, "reg-engagement.yaml");
    writeFileSync(
      reg,
      `schemaVersion: 2
engagements:
  - id: foo-corp
    name: Foo Corp
    githubOrgs: [foo-corp]
    markers: [foo]
`,
    );
    setRemote(gitDir, "git@github.com:foo-corp/some-repo.git");
    resetRepoAegis(gitDir);

    const { stdout } = withRegistry(reg, () =>
      captureOutput(() =>
        classify({ cwd: gitDir, json: true, rules: join(rulesDir, "no-rules.yml") }),
      ),
    );

    const out = JSON.parse(stdout) as {
      matched: { source: string; class: string; engagement: string | null };
    };
    assert.equal(out.matched.source, "registry-engagement");
    assert.equal(out.matched.class, "customer-coupled");
    assert.equal(out.matched.engagement, "foo-corp");
  });

  it("apply: registry-engagement match calls setClass + addEngagement", () => {
    const reg = join(tmp, "reg-apply.yaml");
    writeFileSync(
      reg,
      `schemaVersion: 2
engagements:
  - id: bar-co
    name: Bar Co
    githubOrgs: [bar-co]
    markers: [bar]
`,
    );
    setRemote(gitDir, "git@github.com:bar-co/proj.git");
    resetRepoAegis(gitDir);

    const { stdout } = withRegistry(reg, () =>
      captureOutput(() =>
        classify({
          cwd: gitDir,
          json: true,
          rules: join(rulesDir, "no-rules.yml"),
          apply: true,
        }),
      ),
    );
    const out = JSON.parse(stdout) as {
      applied: boolean;
      after: { class: string; engagements: string[] };
    };
    assert.equal(out.applied, true);
    assert.equal(out.after.class, "customer-coupled");
    assert.deepEqual(out.after.engagements, ["bar-co"]);

    resetRepoAegis(gitDir);
  });

  it("registry wins over classify.yml when both match (deprecation warning)", () => {
    const reg = join(tmp, "reg-precedence.yaml");
    writeFileSync(
      reg,
      `schemaVersion: 2
personalOrgs: [me]
engagements: []
`,
    );
    const rulesFile = join(rulesDir, "rules-precedence.yml");
    writeRules(
      rulesFile,
      `rules:
  - match: "github\\\\.com[:/]me/"
    class: private-strict
`,
    );
    setRemote(gitDir, "git@github.com:me/whatever.git");
    resetRepoAegis(gitDir);

    const { stdout, stderr } = withRegistry(reg, () =>
      captureOutput(() =>
        classify({ cwd: gitDir, json: true, rules: rulesFile }),
      ),
    );

    const out = JSON.parse(stdout) as {
      matched: { source: string; class: string };
      warnings: string[];
    };
    // Registry wins.
    assert.equal(out.matched.source, "registry-personal");
    assert.equal(out.matched.class, "public-eligible");
    // Deprecation warning surfaced.
    assert.ok(
      out.warnings.some(w => /superseded/.test(w)),
      `warnings: ${JSON.stringify(out.warnings)}`,
    );
    assert.ok(
      stderr.includes("warning:"),
      `stderr: ${stderr}`,
    );
  });

  it("[SEC M-7] classify.yml fallback emits a warning when registry has no match", () => {
    const reg = join(tmp, "reg-fallback.yaml");
    writeFileSync(
      reg,
      `schemaVersion: 2
personalOrgs: []
engagements: []
`,
    );
    const rulesFile = join(rulesDir, "rules-fallback.yml");
    writeRules(
      rulesFile,
      `rules:
  - match: "github\\\\.com[:/]legacy-org/"
    class: customer-coupled
    engagement: legacy-engagement
`,
    );
    setRemote(gitDir, "git@github.com:legacy-org/repo.git");
    resetRepoAegis(gitDir);

    const { stdout } = withRegistry(reg, () =>
      captureOutput(() => classify({ cwd: gitDir, json: true, rules: rulesFile })),
    );

    const out = JSON.parse(stdout) as {
      matched: { source: string; rule: number | null; class: string };
      warnings: string[];
    };
    assert.equal(out.matched.source, "classify-yml");
    assert.equal(out.matched.rule, 0);
    assert.equal(out.matched.class, "customer-coupled");
    assert.ok(
      out.warnings.some(
        w => /classify\.yml fallback/.test(w) && /legacy-engagement/.test(w),
      ),
      `warnings: ${JSON.stringify(out.warnings)}`,
    );
  });

  it("non-github remote falls through to classify.yml without registry attempt", () => {
    const reg = join(tmp, "reg-nongithub.yaml");
    writeFileSync(
      reg,
      `schemaVersion: 2
personalOrgs: [me]
engagements: []
`,
    );
    const rulesFile = join(rulesDir, "rules-nongithub.yml");
    writeRules(
      rulesFile,
      `rules:
  - match: "gitlab\\\\.com[:/]"
    class: private-strict
`,
    );
    setRemote(gitDir, "git@gitlab.com:foo/bar.git");
    resetRepoAegis(gitDir);

    const { stdout } = withRegistry(reg, () =>
      captureOutput(() => classify({ cwd: gitDir, json: true, rules: rulesFile })),
    );

    const out = JSON.parse(stdout) as {
      matched: { source: string; class: string };
    };
    // Registry parser returned null for gitlab; classify.yml took over.
    assert.equal(out.matched.source, "classify-yml");
    assert.equal(out.matched.class, "private-strict");
  });

  it("registry produces no match and no classify.yml → no-rules suggestion", () => {
    const reg = join(tmp, "reg-empty.yaml");
    writeFileSync(
      reg,
      `schemaVersion: 2
engagements: []
`,
    );
    setRemote(gitDir, "git@github.com:unknown-org/repo.git");
    resetRepoAegis(gitDir);

    const { stdout } = withRegistry(reg, () =>
      captureOutput(() =>
        classify({
          cwd: gitDir,
          json: true,
          rules: join(rulesDir, "absolutely-does-not-exist.yml"),
        }),
      ),
    );

    const out = JSON.parse(stdout) as {
      matched: null;
      suggestion: string;
    };
    assert.equal(out.matched, null);
    assert.ok(/githubOrgs/.test(out.suggestion), `suggestion: ${out.suggestion}`);
  });

  it("missing registry file silently falls through to classify.yml", () => {
    const rulesFile = join(rulesDir, "rules-when-no-registry.yml");
    writeRules(
      rulesFile,
      `rules:
  - match: "github\\\\.com[:/]foo/"
    class: private-strict
`,
    );
    setRemote(gitDir, "git@github.com:foo/repo.git");
    resetRepoAegis(gitDir);

    const { stdout } = withRegistry(
      join(tmp, "registry-that-does-not-exist.yaml"),
      () =>
        captureOutput(() => classify({ cwd: gitDir, json: true, rules: rulesFile })),
    );

    const out = JSON.parse(stdout) as {
      matched: { source: string };
    };
    // Should still find a match via classify.yml; registry being absent
    // is silent (regMatch returned null, fell through).
    assert.equal(out.matched.source, "classify-yml");
  });
});
