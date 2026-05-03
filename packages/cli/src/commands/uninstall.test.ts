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

  it("--yes applies all 'always-on' steps", () => {
    const aegisHome = makeAegisHome("apply");
    const claudeHome = makeClaudeHome("apply");
    const gitignore = join(tmp, "apply-gitignore");
    writeFileSync(gitignore, "");

    withEnv("REPO_AEGIS_HOME", aegisHome, () => {
      captureOutput(() => installClaudeMd({ claudeHome, silent: true }));
      captureOutput(() =>
        installGitignore({ gitignorePath: gitignore, silent: true }),
      );

      captureOutput(() =>
        uninstall({
          claudeHome,
          yes: true,
          json: true,
          // Don't purge home or repos in this test.
        }),
      );

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

describe("repo-aegis uninstall — --purge-home", () => {
  it("--yes --purge-home deletes ~/.config/repo-aegis", () => {
    const aegisHome = makeAegisHome("purge-home");
    const claudeHome = makeClaudeHome("purge-home");

    assert.ok(existsSync(aegisHome));
    withEnv("REPO_AEGIS_HOME", aegisHome, () => {
      captureOutput(() =>
        uninstall({
          claudeHome,
          yes: true,
          purgeHome: true,
          json: true,
        }),
      );
    });
    assert.equal(existsSync(aegisHome), false);
  });

  it("refuses to purge a home path that doesn't end in 'repo-aegis'", () => {
    const weirdHome = join(tmp, "not-repo-aegis-shaped");
    mkdirSync(weirdHome, { recursive: true });
    const claudeHome = makeClaudeHome("weird");

    withEnv("REPO_AEGIS_HOME", weirdHome, () => {
      const r = captureOutput(() =>
        uninstall({
          claudeHome,
          yes: true,
          purgeHome: true,
          json: true,
        }),
      );
      assert.equal(r.exitCode, 2);
      assert.ok(r.stderr.includes("home path does not end in 'repo-aegis'"));
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

    withEnv("REPO_AEGIS_HOME", aegisHome, () => {
      captureOutput(() =>
        uninstall({
          claudeHome,
          yes: true,
          purgeRepos: true,
          scanRoot: [root],
          json: true,
        }),
      );
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

