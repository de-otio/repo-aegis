// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { resolveHookState } from "./hooks-state.js";
import { HOOK_SCRIPTS } from "./hook-scripts.js";

// SAFETY: every case below runs against a throwaway repo under a
// per-case temp dir, with GIT_CONFIG_GLOBAL/SYSTEM redirected to files
// under that same temp dir and REPO_AEGIS_HOME redirected to a temp
// "home". No test reads or writes the developer's real
// ~/.config/repo-aegis, real global git config, or real system git
// config — `git config --global` calls below only ever touch the
// per-case GIT_CONFIG_GLOBAL file. Never call `git config --global`
// without going through `Fixture.run`.

let root: string;

before(() => {
  root = mkdtempSync(join(tmpdir(), "repo-aegis-hooks-state-"));
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

interface Fixture {
  base: string;
  repoDir: string;
  home: string;
  /** Runs `fn` with GIT_CONFIG_GLOBAL/SYSTEM and REPO_AEGIS_HOME
   * pointed at this fixture's isolated files, restoring the prior
   * environment afterward (including for a throwing `fn`). */
  run: <T>(fn: () => T) => T;
}

function makeFixture(name: string): Fixture {
  const base = join(root, name);
  const repoDir = join(base, "repo");
  const home = join(base, "home");
  const globalConfig = join(base, "gitconfig-global");
  mkdirSync(repoDir, { recursive: true });
  mkdirSync(home, { recursive: true });

  const overrides: Record<string, string> = {
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: globalConfig,
    REPO_AEGIS_HOME: home,
  };

  function run<T>(fn: () => T): T {
    const prev: Record<string, string | undefined> = {};
    for (const k of Object.keys(overrides)) {
      const value = overrides[k];
      if (value === undefined) continue;
      prev[k] = process.env[k];
      process.env[k] = value;
    }
    try {
      return fn();
    } finally {
      for (const k of Object.keys(overrides)) {
        const p = prev[k];
        if (p === undefined) delete process.env[k];
        else process.env[k] = p;
      }
    }
  }

  run(() => {
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repoDir });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoDir });
    execFileSync("git", ["config", "user.name", "test"], { cwd: repoDir });
  });

  return { base, repoDir, home, run };
}

function gitConfig(fx: Fixture, args: string[]): void {
  fx.run(() => execFileSync("git", ["config", ...args], { cwd: fx.repoDir }));
}

/** Writes both hook scripts (byte-identical to HOOK_SCRIPTS) to `dir`,
 * mode 0o755, mirroring exactly what `install-hooks.ts` writes. */
function writeCorrectHooks(dir: string): void {
  mkdirSync(dir, { recursive: true });
  for (const name of Object.keys(HOOK_SCRIPTS) as (keyof typeof HOOK_SCRIPTS)[]) {
    const p = join(dir, name);
    writeFileSync(p, HOOK_SCRIPTS[name], { mode: 0o755 });
    chmodSync(p, 0o755);
  }
}

/** The directory repo-aegis's own installer targets for this fixture:
 * `<fx.home>/hooks`, matching `join(repoAegisHome(), "hooks")` when
 * REPO_AEGIS_HOME=fx.home (which `Fixture.run` sets). */
function expectedHooksDir(fx: Fixture): string {
  return join(fx.home, "hooks");
}

describe("resolveHookState", () => {
  it("core.hooksPath unset -> HOOKS_PATH_UNSET, effectivePath null", () => {
    const fx = makeFixture("unset");
    const state = fx.run(() => resolveHookState(fx.repoDir));
    assert.equal(state.isGitRepo, true);
    assert.equal(state.origin, "unset");
    assert.equal(state.effectivePath, null);
    assert.equal(state.ok, false);
    assert.equal(state.code, "HOOKS_PATH_UNSET");
    assert.equal(state.fix, "repo-aegis install hooks");
    assert.deepEqual(state.shadowedRepoHooks, []);
  });

  it("global-only, correctly installed -> HOOKS_OK", () => {
    const fx = makeFixture("global-correct");
    const hooksDir = expectedHooksDir(fx);
    writeCorrectHooks(hooksDir);
    gitConfig(fx, ["--global", "core.hooksPath", hooksDir]);

    const state = fx.run(() => resolveHookState(fx.repoDir));
    assert.equal(state.origin, "global");
    assert.equal(state.effectivePath, hooksDir);
    assert.equal(state.expectedPath, hooksDir);
    assert.equal(state.ok, true);
    assert.equal(state.code, "HOOKS_OK");
    assert.equal(state.fix, "");
    assert.equal(state.scripts["pre-commit"].present, true);
    assert.equal(state.scripts["pre-commit"].executable, true);
    assert.equal(state.scripts["pre-commit"].current, true);
    assert.equal(state.scripts["pre-push"].current, true);
  });

  it("local override to an empty dir shadowing a correct global -> HOOKS_PATH_LOCAL_OVERRIDE (the incident)", () => {
    const fx = makeFixture("local-override-empty");
    const hooksDir = expectedHooksDir(fx);
    writeCorrectHooks(hooksDir);
    // The correct, working setup: a global core.hooksPath pointing at
    // repo-aegis's installed scripts.
    gitConfig(fx, ["--global", "core.hooksPath", hooksDir]);

    // The incident: a repo-local override to a directory that has
    // nothing in it. Git consults exactly one hooksPath, so this
    // silently disables the correct global setting for this one repo.
    const emptyDir = join(fx.base, "empty-hooks");
    mkdirSync(emptyDir, { recursive: true });
    gitConfig(fx, ["core.hooksPath", emptyDir]);

    const state = fx.run(() => resolveHookState(fx.repoDir));
    assert.equal(state.origin, "local");
    assert.equal(state.effectivePath, emptyDir);
    assert.equal(state.ok, false);
    assert.equal(state.code, "HOOKS_PATH_LOCAL_OVERRIDE");
    assert.equal(state.fix, "git config --unset core.hooksPath");
    assert.equal(state.scripts["pre-commit"].present, false);
    assert.equal(state.scripts["pre-push"].present, false);
  });

  it("local override to a foreign dir with a non-executable pre-commit -> HOOKS_PATH_FOREIGN (path problem, not script problem)", () => {
    const fx = makeFixture("local-override-foreign");
    // No global value at all here, so there is nothing "correct" being
    // shadowed — this is a plain foreign path, distinct from the
    // local-shadows-global incident above.
    const foreignDir = join(fx.base, "foreign-hooks");
    mkdirSync(foreignDir, { recursive: true });
    const preCommitPath = join(foreignDir, "pre-commit");
    writeFileSync(preCommitPath, "#!/bin/sh\nexit 0\n", { mode: 0o644 });
    chmodSync(preCommitPath, 0o644); // deliberately not executable
    gitConfig(fx, ["core.hooksPath", foreignDir]);

    const state = fx.run(() => resolveHookState(fx.repoDir));
    assert.equal(state.origin, "local");
    assert.equal(state.effectivePath, foreignDir);
    assert.equal(state.ok, false);
    // The path itself being wrong takes priority over anything found
    // inside it: this must NOT report HOOKS_SCRIPT_NOT_EXECUTABLE even
    // though `scripts` (below) truthfully shows a non-executable file.
    assert.equal(state.code, "HOOKS_PATH_FOREIGN");
    assert.equal(state.fix, "git config --unset core.hooksPath");
    assert.equal(state.scripts["pre-commit"].present, true);
    assert.equal(state.scripts["pre-commit"].executable, false);
  });

  it("correct path with a stale pre-push -> HOOKS_SCRIPT_STALE", () => {
    const fx = makeFixture("stale-pre-push");
    const hooksDir = expectedHooksDir(fx);
    writeCorrectHooks(hooksDir);
    // Overwrite pre-push with text that does not match hookScriptDigest
    // ("pre-push") — simulates a script left over from an older
    // `install hooks` run after PRE_PUSH_SCRIPT changed upstream.
    const prePushPath = join(hooksDir, "pre-push");
    writeFileSync(prePushPath, "#!/usr/bin/env bash\n# old version\nexit 0\n", { mode: 0o755 });
    chmodSync(prePushPath, 0o755);
    gitConfig(fx, ["core.hooksPath", hooksDir]);

    const state = fx.run(() => resolveHookState(fx.repoDir));
    assert.equal(state.effectivePath, hooksDir);
    assert.equal(state.ok, false);
    assert.equal(state.code, "HOOKS_SCRIPT_STALE");
    assert.equal(state.fix, "repo-aegis install hooks");
    assert.equal(state.scripts["pre-commit"].current, true);
    assert.equal(state.scripts["pre-push"].present, true);
    assert.equal(state.scripts["pre-push"].executable, true);
    assert.equal(state.scripts["pre-push"].current, false);
  });

  it("repo's own executable .git/hooks/pre-commit while a global hooksPath is set -> shadowedRepoHooks non-empty", () => {
    const fx = makeFixture("shadowed-repo-hooks");
    const hooksDir = expectedHooksDir(fx);
    writeCorrectHooks(hooksDir);
    gitConfig(fx, ["--global", "core.hooksPath", hooksDir]);

    // A script installed directly into this repo's own .git/hooks by
    // some other tool (or a human), before core.hooksPath redirected
    // git elsewhere. It will never run while the global hooksPath is
    // in effect — that's the "shadowed" condition this field exists to
    // surface, independent of whether the *active* hooksPath is
    // otherwise perfectly correct.
    const realHooks = join(fx.repoDir, ".git", "hooks");
    mkdirSync(realHooks, { recursive: true });
    const shadowed = join(realHooks, "pre-commit");
    writeFileSync(shadowed, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    chmodSync(shadowed, 0o755);

    const state = fx.run(() => resolveHookState(fx.repoDir));
    assert.equal(state.code, "HOOKS_OK");
    assert.equal(state.ok, true);
    assert.deepEqual(state.shadowedRepoHooks, ["pre-commit"]);
  });

  // `shadowedRepoHooks` is the raw observation; `bypassedRepoHooks` is the
  // actionable subset. The generated scripts chain to a repo-local
  // pre-commit/pre-push, so those still run and must NOT be reported as lost.
  it("separates chained hook types (pre-commit/pre-push) from genuinely bypassed ones", () => {
    const fx = makeFixture("chained-vs-bypassed");
    const hooksDir = expectedHooksDir(fx);
    writeCorrectHooks(hooksDir);
    gitConfig(fx, ["--global", "core.hooksPath", hooksDir]);

    const realHooks = join(fx.repoDir, ".git", "hooks");
    mkdirSync(realHooks, { recursive: true });
    for (const name of ["pre-commit", "pre-push", "commit-msg", "post-merge"]) {
      const p = join(realHooks, name);
      writeFileSync(p, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      chmodSync(p, 0o755);
    }

    const state = fx.run(() => resolveHookState(fx.repoDir));
    assert.deepEqual(state.shadowedRepoHooks, ["commit-msg", "post-merge", "pre-commit", "pre-push"]);
    assert.deepEqual(state.bypassedRepoHooks, ["commit-msg", "post-merge"]);
  });

  it("git init's own .sample hooks are never reported as shadowed", () => {
    // Regression guard for the check above: git ships .git/hooks full
    // of *executable* .sample files (verified on this platform), so
    // the shadowed-hooks scan MUST filter by name, not just by the
    // executable bit, or every fresh repo would report a false
    // positive here.
    const fx = makeFixture("samples-not-shadowed");
    const hooksDir = expectedHooksDir(fx);
    writeCorrectHooks(hooksDir);
    gitConfig(fx, ["--global", "core.hooksPath", hooksDir]);

    const state = fx.run(() => resolveHookState(fx.repoDir));
    assert.deepEqual(state.shadowedRepoHooks, []);
  });

  it("fully correct install -> HOOKS_OK, nothing shadowed", () => {
    const fx = makeFixture("fully-correct");
    const hooksDir = expectedHooksDir(fx);
    writeCorrectHooks(hooksDir);
    gitConfig(fx, ["core.hooksPath", hooksDir]);

    const state = fx.run(() => resolveHookState(fx.repoDir));
    assert.equal(state.isGitRepo, true);
    assert.equal(state.origin, "local");
    assert.equal(state.effectivePath, hooksDir);
    assert.equal(state.expectedPath, hooksDir);
    assert.equal(state.ok, true);
    assert.equal(state.code, "HOOKS_OK");
    assert.equal(state.fix, "");
    assert.deepEqual(state.shadowedRepoHooks, []);
    for (const name of ["pre-commit", "pre-push"] as const) {
      assert.equal(state.scripts[name].present, true);
      assert.equal(state.scripts[name].executable, true);
      assert.equal(state.scripts[name].current, true);
    }
  });

  it("correct path but pre-commit was never written -> HOOKS_SCRIPT_MISSING", () => {
    const fx = makeFixture("script-missing");
    const hooksDir = expectedHooksDir(fx);
    writeCorrectHooks(hooksDir);
    // pre-commit exists from writeCorrectHooks(); remove it to simulate
    // a partial / interrupted install.
    rmSync(join(hooksDir, "pre-commit"));
    gitConfig(fx, ["core.hooksPath", hooksDir]);

    const state = fx.run(() => resolveHookState(fx.repoDir));
    assert.equal(state.ok, false);
    assert.equal(state.code, "HOOKS_SCRIPT_MISSING");
    assert.equal(state.fix, "repo-aegis install hooks");
    assert.equal(state.scripts["pre-commit"].present, false);
    assert.equal(state.scripts["pre-push"].present, true);
  });

  it("correct path but pre-push lost its executable bit -> HOOKS_SCRIPT_NOT_EXECUTABLE", () => {
    const fx = makeFixture("script-not-executable");
    const hooksDir = expectedHooksDir(fx);
    writeCorrectHooks(hooksDir);
    chmodSync(join(hooksDir, "pre-push"), 0o644);
    gitConfig(fx, ["core.hooksPath", hooksDir]);

    const state = fx.run(() => resolveHookState(fx.repoDir));
    assert.equal(state.ok, false);
    assert.equal(state.code, "HOOKS_SCRIPT_NOT_EXECUTABLE");
    assert.equal(state.fix, "repo-aegis install hooks");
    assert.equal(state.scripts["pre-push"].present, true);
    assert.equal(state.scripts["pre-push"].executable, false);
    assert.equal(state.scripts["pre-commit"].executable, true);
  });

  it("outside a git repository -> isGitRepo=false", () => {
    const fx = makeFixture("not-a-repo");
    const nonGitDir = join(fx.base, "non-git");
    mkdirSync(nonGitDir, { recursive: true });

    const state = fx.run(() => resolveHookState(nonGitDir));
    assert.equal(state.isGitRepo, false);
  });
});
