// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureOutput, withEnv } from "../_test-utils.js";
import { uninstall } from "./uninstall.js";
import { installClaudeMd } from "./install-claude-md.js";
import { installGitignore } from "./install-gitignore.js";

let tmp: string;

before(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "repo-aegis-uninstall-test-")));
});

after(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function makeAegisHome(name: string): string {
  // The directory name MUST end in `repo-aegis` to satisfy the
  // safety guard in uninstall.ts:isSafeToPurgeHome (which refuses
  // to delete directories whose name doesn't end in repo-aegis).
  const dir = join(tmp, name, "repo-aegis");
  mkdirSync(join(dir, "state"), { recursive: true });
  mkdirSync(join(dir, "markers"), { recursive: true });
  writeFileSync(join(dir, "engagements.yaml"), "engagements: []\n");
  return dir;
}

function makeClaudeHome(name: string): string {
  const dir = join(tmp, `${name}-claude`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// SAFETY: any `uninstall({ yes: true, ... })` call whose `cwd` resolves
// to a git repo runs the `install-hooks --uninstall` step, which (as
// of the v0.7 default flip) unsets core.hooksPath in BOTH the global
// AND local scope. Every such test below therefore (a) points `cwd` at
// a throwaway repo it creates itself — never relies on
// `process.cwd()` — and (b) wraps the call in `withHooksIsolation`,
// which redirects GIT_CONFIG_GLOBAL/SYSTEM to per-test temp files so
// the global unset can only ever touch that temp file, never the
// developer's real ~/.gitconfig. Same pattern as
// packages/core/src/hooks-state.test.ts and
// packages/cli/src/commands/status.test.ts's withHooksIsolation.
function withHooksIsolation<T>(base: string, fn: () => T): T {
  const overrides: Record<string, string> = {
    GIT_CONFIG_GLOBAL: join(base, "gitconfig-global"),
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
  };
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(overrides)) {
    prev[k] = process.env[k];
    process.env[k] = overrides[k]!;
  }
  try {
    return fn();
  } finally {
    for (const k of Object.keys(overrides)) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
}

function makeGitRepo(dir: string): string {
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  return dir;
}

describe("repo-aegis uninstall — dry run", () => {
  it("default is dry-run; no destructive actions", () => {
    const aegisHome = makeAegisHome("dryrun");
    const claudeHome = makeClaudeHome("dryrun");
    withEnv("REPO_AEGIS_HOME", aegisHome, () => {
      // Pre-install some artefacts so we can prove they survive a dry-run.
      captureOutput(() => installClaudeMd({ claudeHome, silent: true }));
      const before = existsSync(join(claudeHome, "settings.json"));
      assert.ok(before);

      const r = captureOutput(() =>
        uninstall({
          claudeHome,
          purgeHome: true,
          json: true,
        }),
      );
      const j = JSON.parse(r.stdout) as {
        dryRun: boolean;
        purgeHome: { removed: boolean; reason?: string } | null;
      };
      assert.equal(j.dryRun, true);
      assert.equal(j.purgeHome?.removed, false);
      assert.equal(j.purgeHome?.reason, "dry-run");

      // Artefacts still in place.
      assert.ok(existsSync(join(claudeHome, "settings.json")));
      assert.ok(existsSync(aegisHome));
    });
  });

  it("--yes applies all 'always-on' steps, including unsetting hooks in an isolated throwaway repo", () => {
    const aegisHome = makeAegisHome("apply");
    const claudeHome = makeClaudeHome("apply");
    const gitignore = join(tmp, "apply-gitignore");
    writeFileSync(gitignore, "");
    const base = join(tmp, "apply-git-isolation");
    mkdirSync(base, { recursive: true });
    const repo = makeGitRepo(join(base, "repo"));

    withHooksIsolation(base, () => {
      withEnv("REPO_AEGIS_HOME", aegisHome, () => {
        captureOutput(() => installClaudeMd({ claudeHome, silent: true }));
        captureOutput(() =>
          installGitignore({ gitignorePath: gitignore, silent: true }),
        );

        const r = captureOutput(() =>
          uninstall({
            claudeHome,
            cwd: repo,
            yes: true,
            json: true,
            // Don't purge home or repos in this test.
          }),
        );

        const j = JSON.parse(r.stdout) as {
          steps: Array<{ step: string; ok: boolean }>;
        };
        const hooksStep = j.steps.find(s => s.step === "install-hooks --uninstall");
        assert.ok(hooksStep);
        assert.equal(hooksStep!.ok, true);

        // CLAUDE.md block stripped, settings.json hooks removed.
        const settingsBody = JSON.parse(
          readFileSync(join(claudeHome, "settings.json"), "utf8"),
        ) as { hooks?: unknown };
        assert.ok(!settingsBody.hooks || Object.keys(settingsBody.hooks).length === 0);

        // gitignore block stripped.
        const gitignoreBody = readFileSync(gitignore, "utf8");
        assert.ok(!gitignoreBody.includes("repo-aegis: managed block"));

        // Aegis home survives because we didn't pass --purge-home.
        assert.ok(existsSync(aegisHome));
      });
    });
  });
});

describe("repo-aegis uninstall — --purge-home", () => {
  it("--yes --purge-home deletes ~/.config/repo-aegis", () => {
    const aegisHome = makeAegisHome("purge-home");
    const claudeHome = makeClaudeHome("purge-home");
    const base = join(tmp, "purge-home-git-isolation");
    mkdirSync(base, { recursive: true });
    const repo = makeGitRepo(join(base, "repo"));

    assert.ok(existsSync(aegisHome));
    withHooksIsolation(base, () => {
      withEnv("REPO_AEGIS_HOME", aegisHome, () => {
        captureOutput(() =>
          uninstall({
            claudeHome,
            cwd: repo,
            yes: true,
            purgeHome: true,
            json: true,
          }),
        );
      });
    });
    assert.equal(existsSync(aegisHome), false);
  });

  it("refuses to purge a home path that doesn't end in 'repo-aegis'", () => {
    const weirdHome = join(tmp, "not-repo-aegis-shaped");
    mkdirSync(weirdHome, { recursive: true });
    const claudeHome = makeClaudeHome("weird");
    const base = join(tmp, "weird-git-isolation");
    mkdirSync(base, { recursive: true });
    const repo = makeGitRepo(join(base, "repo"));

    withHooksIsolation(base, () => {
      withEnv("REPO_AEGIS_HOME", weirdHome, () => {
        const r = captureOutput(() =>
          uninstall({
            claudeHome,
            cwd: repo,
            yes: true,
            purgeHome: true,
            json: true,
          }),
        );
        assert.equal(r.exitCode, 2);
        assert.ok(r.stderr.includes("home path does not end in 'repo-aegis'"));
      });
    });
    // Path still exists.
    assert.ok(existsSync(weirdHome));
  });

  it("dry-run flags audit-log presence", () => {
    const aegisHome = makeAegisHome("audit-flag");
    const claudeHome = makeClaudeHome("audit-flag");
    // Enable audit log + write a record.
    writeFileSync(
      join(aegisHome, "state", "audit-log.json"),
      JSON.stringify({ enabled: true }),
    );
    writeFileSync(join(aegisHome, "state", "audit.log"), '{"action":"test"}\n');

    withEnv("REPO_AEGIS_HOME", aegisHome, () => {
      const r = captureOutput(() =>
        uninstall({
          claudeHome,
          purgeHome: true,
          json: true,
        }),
      );
      const j = JSON.parse(r.stdout) as {
        purgeHome: { auditLogPresent?: boolean };
      };
      assert.equal(j.purgeHome?.auditLogPresent, true);
    });
  });
});

describe("repo-aegis uninstall — --purge-repos", () => {
  it("--purge-repos --yes sweeps repo-aegis.* config from repos under scan-root", () => {
    const aegisHome = makeAegisHome("sweep");
    const claudeHome = makeClaudeHome("sweep");
    const root = join(tmp, "sweep-root");
    mkdirSync(root);
    const repo = join(root, "the-repo");
    mkdirSync(repo);
    execFileSync("git", ["init", "-q", "--initial-branch=main", repo], { stdio: "ignore" });
    execFileSync("git", ["-C", repo, "config", "repo-aegis.class", "scratch"], {
      stdio: "ignore",
    });
    const base = join(tmp, "sweep-git-isolation");
    mkdirSync(base, { recursive: true });
    const cwdRepo = makeGitRepo(join(base, "cwd-repo"));

    withHooksIsolation(base, () => {
      withEnv("REPO_AEGIS_HOME", aegisHome, () => {
        captureOutput(() =>
          uninstall({
            claudeHome,
            cwd: cwdRepo,
            yes: true,
            purgeRepos: true,
            scanRoot: [root],
            json: true,
          }),
        );
      });
    });

    // The git config should be cleared.
    let cls = "";
    try {
      cls = execFileSync("git", ["-C", repo, "config", "--get", "repo-aegis.class"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      cls = "";
    }
    assert.equal(cls, "");
  });
});

describe("repo-aegis uninstall — outside a git repo", () => {
  it("does not abort the whole uninstall when cwd is not a git repo", () => {
    const aegisHome = makeAegisHome("nogit");
    const claudeHome = makeClaudeHome("nogit");
    const noGit = join(tmp, "nogit-cwd");
    mkdirSync(noGit, { recursive: true });
    const base = join(tmp, "nogit-git-isolation");
    mkdirSync(base, { recursive: true });

    withHooksIsolation(base, () => {
      withEnv("REPO_AEGIS_HOME", aegisHome, () => {
        const r = captureOutput(() =>
          uninstall({
            claudeHome,
            cwd: noGit,
            yes: true,
            json: true,
          }),
        );
        const j = JSON.parse(r.stdout) as {
          steps: Array<{ step: string; ok: boolean; details?: { skipped?: boolean } }>;
        };
        const hooksStep = j.steps.find(s => s.step === "install-hooks --uninstall");
        assert.ok(hooksStep);
        assert.equal(hooksStep!.ok, true);
        assert.equal(hooksStep!.details?.skipped, true);
      });
    });
  });
});
