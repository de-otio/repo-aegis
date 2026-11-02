// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// `doctor`'s checks for residual risks R8, R9 and R11
// (doc/plan-unregistered-owner-egress.md §8.2): shell startup overrides, an ssh
// redirect of github.com, and a missing pre-push hook. Every case builds its
// own temp HOME, ssh directory, REPO_AEGIS_HOME and repo; nothing reads the
// developer's real dotfiles, ssh config or registry.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { execFileSync } from "node:child_process";
import { HOOK_SCRIPTS, resolveHookState } from "@de-otio/repo-aegis-core";
import { doctor } from "./doctor.js";
import {
  checkPrePushHook,
  checkShellStartupOverrides,
  checkSshGithubRedirect,
  watchedVariablesIn,
} from "./doctor-env-checks.js";
import { captureOutput, fakeGh, withEnv } from "../_test-utils.js";
import { GH_SHIM_SCRIPT } from "./shim-script.js";

let root: string;
let n = 0;

before(() => {
  root = mkdtempSync(join(tmpdir(), "repo-aegis-doctor-env-"));
});
after(() => {
  rmSync(root, { recursive: true, force: true });
});

function tmpDir(name: string): string {
  const dir = join(root, `${name}-${n++}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// A value that must never be echoed: it looks like what a startup file might really hold.
const SECRET = "s3cr3t-VALUE-must-not-leak";

// ---------------------------------------------------------------------------
// SHELL_STARTUP_OVERRIDES
// ---------------------------------------------------------------------------

describe("watchedVariablesIn", () => {
  it("finds exports, typeset/declare -x, multi-name exports and bare assignments", () => {
    const text = [
      "export GH_REPO=acme/x",
      "export FOO=1 GIT_SSH_COMMAND='ssh -o X=y'",
      "declare -x REPO_AEGIS_HOME=/tmp/h",
      "typeset -gx SRT_SSH_PROXY_COMMAND=cmd",
      "REPO_AEGIS_REGISTRY=/tmp/r",
      "export SRT_LATER",
      "export GIT_SSH=/usr/bin/wrapper",
    ].join("\n");
    assert.deepEqual(watchedVariablesIn(text), [
      "GH_REPO",
      "GIT_SSH",
      "GIT_SSH_COMMAND",
      "REPO_AEGIS_HOME",
      "REPO_AEGIS_REGISTRY",
      "SRT_LATER",
      "SRT_SSH_PROXY_COMMAND",
    ]);
  });

  it("ignores comments, unset, other variables, and command-prefix assignments", () => {
    const text = [
      "# export GH_REPO=acme/x",
      "unset GH_REPO",
      "export PATH=/usr/bin:$PATH",
      "export MY_GH_REPO=x",
      "GH_REPO=acme/x gh pr list",
      "alias g='GIT_SSH_COMMAND=x git'",
      "echo REPO_AEGIS_HOME",
    ].join("\n");
    assert.deepEqual(watchedVariablesIn(text), []);
  });
});

describe("checkShellStartupOverrides", () => {
  it("names the variable and the file, never the value", () => {
    const home = tmpDir("startup");
    writeFileSync(join(home, ".zshenv"), `export GH_REPO=stranger/${SECRET}\n`);
    writeFileSync(join(home, ".zshrc"), `export SRT_THING="${SECRET}"\nexport EDITOR=vim\n`);
    writeFileSync(join(home, ".bashrc"), `GIT_SSH_COMMAND='ssh -o ProxyCommand=${SECRET}'\n`);
    writeFileSync(join(home, ".profile"), `GH_REPO=stranger/r gh pr list\n`); // command prefix: not an export
    const c = checkShellStartupOverrides(home);
    assert.equal(c.code, "SHELL_STARTUP_OVERRIDES");
    assert.equal(c.ok, false);
    assert.equal(c.severity, "warn");
    assert.match(c.detail, /~\/\.zshenv sets GH_REPO/);
    assert.match(c.detail, /~\/\.zshrc sets SRT_THING/);
    assert.match(c.detail, /~\/\.bashrc sets GIT_SSH_COMMAND/);
    assert.doesNotMatch(c.detail, /\.profile/);
    const blob = JSON.stringify(c);
    assert.doesNotMatch(blob, new RegExp(SECRET));
    assert.doesNotMatch(blob, /stranger/);
  });

  it("is clean for a home with no startup files, or harmless ones", () => {
    const home = tmpDir("startup-clean");
    assert.equal(checkShellStartupOverrides(home).ok, true);
    writeFileSync(join(home, ".zshrc"), "export EDITOR=vim\nalias ll='ls -l'\n");
    assert.equal(checkShellStartupOverrides(home).ok, true);
  });
});

// ---------------------------------------------------------------------------
// SSH_GITHUB_REDIRECT
// ---------------------------------------------------------------------------

describe("checkSshGithubRedirect", () => {
  function sshDirWith(config: string | null): string {
    const dir = tmpDir("ssh");
    if (config !== null) writeFileSync(join(dir, "config"), config);
    return dir;
  }

  it("is info when `Host github.com` sets HostName to another host", () => {
    const c = checkSshGithubRedirect(sshDirWith("Host github.com\n  HostName git.example.net\n  User git\n"));
    assert.equal(c.ok, false);
    assert.equal(c.severity, "info");
    assert.doesNotMatch(c.detail, /example\.net/);
  });

  it("accepts the documented GitHub-over-443 setup, no config, and an unrelated alias", () => {
    assert.equal(checkSshGithubRedirect(sshDirWith("Host github.com\n  HostName ssh.github.com\n  Port 443\n")).ok, true);
    assert.equal(checkSshGithubRedirect(sshDirWith(null)).ok, true);
    assert.equal(checkSshGithubRedirect(sshDirWith("Host gh-work\n  HostName git.example.net\n")).ok, true);
  });
});

// ---------------------------------------------------------------------------
// PREPUSH_HOOK_MISSING
// ---------------------------------------------------------------------------

interface RepoWorld {
  aegisHome: string;
  userHome: string;
  scanRoot: string;
  claudeHome: string;
  repo: string;
  env: Record<string, string>;
}

function makeRepoWorld(name: string): RepoWorld {
  const base = tmpDir(name);
  const aegisHome = join(base, "aegis");
  const userHome = join(base, "home");
  const scanRoot = join(base, "scan");
  const claudeHome = join(base, "claude");
  const repo = join(scanRoot, "repo");
  for (const d of [aegisHome, userHome, claudeHome, repo]) mkdirSync(d, { recursive: true });
  const globalConfig = join(base, "gitconfig");
  writeFileSync(globalConfig, "[push]\n\tdefault = nothing\n");
  // gh is logged out: nothing here may reach the network.
  const loggedOut = fakeGh(join(base, "gh-out"), "exit 1");
  const env: Record<string, string> = {
    REPO_AEGIS_HOME: aegisHome,
    HOME: userHome,
    PATH: `${loggedOut}${delimiter}${process.env["PATH"] ?? ""}`,
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
  };
  const git = (...args: string[]): void => {
    execFileSync("git", args, { cwd: repo, env: { ...process.env, ...env }, stdio: "ignore" });
  };
  git("init", "-q", "-b", "main");
  git("remote", "add", "origin", "git@github.com:acme/x.git");
  return { aegisHome, userHome, scanRoot, claudeHome, repo, env };
}

function withWorld<T>(w: RepoWorld, fn: () => T): T {
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(w.env)) {
    prev[k] = process.env[k];
    process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

function installHooks(w: RepoWorld, only?: "pre-commit"): void {
  const dir = join(w.aegisHome, "hooks");
  mkdirSync(dir, { recursive: true });
  for (const name of Object.keys(HOOK_SCRIPTS) as (keyof typeof HOOK_SCRIPTS)[]) {
    if (only !== undefined && name !== only) continue;
    writeFileSync(join(dir, name), HOOK_SCRIPTS[name], { mode: 0o755 });
    chmodSync(join(dir, name), 0o755);
  }
  withWorld(w, () => execFileSync("git", ["config", "core.hooksPath", dir], { cwd: w.repo }));
}

describe("checkPrePushHook", () => {
  it("is ok when repo-aegis's hooks directory is effective and pre-push is present and executable", () => {
    const w = makeRepoWorld("prepush-ok");
    installHooks(w);
    const c = withWorld(w, () => checkPrePushHook(resolveHookState(w.repo)));
    assert.equal(c.ok, true);
  });

  it("warns when core.hooksPath is unset", () => {
    const w = makeRepoWorld("prepush-unset");
    const c = withWorld(w, () => checkPrePushHook(resolveHookState(w.repo)));
    assert.equal(c.ok, false);
    assert.equal(c.severity, "warn");
    assert.equal(c.fix, "repo-aegis install hooks");
  });

  it("warns when the effective hooks directory has pre-commit but no pre-push", () => {
    const w = makeRepoWorld("prepush-partial");
    installHooks(w, "pre-commit");
    const c = withWorld(w, () => checkPrePushHook(resolveHookState(w.repo)));
    assert.equal(c.ok, false);
  });

  it("does not count a pre-push in some other core.hooksPath as repo-aegis's", () => {
    const w = makeRepoWorld("prepush-foreign");
    const foreign = join(tmpDir("foreign-hooks"));
    writeFileSync(join(foreign, "pre-push"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    chmodSync(join(foreign, "pre-push"), 0o755);
    withWorld(w, () => execFileSync("git", ["config", "core.hooksPath", foreign], { cwd: w.repo }));
    const c = withWorld(w, () => checkPrePushHook(resolveHookState(w.repo)));
    assert.equal(c.ok, false);
  });
});

describe("doctor — R8/R9/R11 end to end", () => {
  it("lists a repo with a GitHub remote and no pre-push hook as PREPUSH_HOOK_MISSING (json carries the code)", () => {
    const w = makeRepoWorld("e2e-prepush");
    const res = withWorld(w, () =>
      captureOutput(() =>
        doctor({ scanRoot: [w.scanRoot], claudeHome: w.claudeHome, homeDir: w.userHome, sshDir: join(w.userHome, ".ssh"), json: true }),
      ),
    );
    const parsed = JSON.parse(res.stdout) as { results: Array<{ checks: Array<{ code: string; severity?: string }> }> };
    const codes = parsed.results.flatMap(r => r.checks);
    const pp = codes.find(c => c.code === "PREPUSH_HOOK_MISSING");
    assert.ok(pp, "PREPUSH_HOOK_MISSING must be reported");
    assert.equal(pp.severity, "warn");
  });

  it("a repo with healthy hooks gets no PREPUSH_HOOK_MISSING entry", () => {
    const w = makeRepoWorld("e2e-prepush-ok");
    installHooks(w);
    const res = withWorld(w, () =>
      captureOutput(() =>
        doctor({ scanRoot: [w.scanRoot], claudeHome: w.claudeHome, homeDir: w.userHome, sshDir: join(w.userHome, ".ssh"), json: true }),
      ),
    );
    assert.doesNotMatch(res.stdout, /PREPUSH_HOOK_MISSING/);
  });

  it("startup-file values and ssh HostName values never reach the output; they are WARN/INFO, not FAIL", () => {
    const w = makeRepoWorld("e2e-startup");
    installHooks(w);
    writeFileSync(join(w.userHome, ".zshenv"), `export GH_REPO=stranger/${SECRET}\n`);
    mkdirSync(join(w.userHome, ".ssh"), { recursive: true });
    writeFileSync(join(w.userHome, ".ssh", "config"), "Host github.com\n  HostName git.example.net\n");
    // Satisfy the other machine checks so only warn/info findings remain: push.default is `nothing`
    // (global config above), the guard hook is registered, and the shim is installed and first on PATH.
    writeFileSync(
      join(w.claudeHome, "settings.json"),
      JSON.stringify({
        hooks: {
          PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "repo-aegis hook guard-egress --agent claude" }] }],
        },
      }),
    );
    // no registry file exists -> the owner checks stay silent
    const shimDir = join(w.aegisHome, "bin");
    mkdirSync(shimDir, { recursive: true });
    writeFileSync(join(shimDir, "gh"), GH_SHIM_SCRIPT, { mode: 0o755 });
    chmodSync(join(shimDir, "gh"), 0o755);

    const res = withWorld(w, () =>
      withEnv("PATH", `${shimDir}${delimiter}${process.env["PATH"] ?? ""}`, () =>
        captureOutput(() =>
          doctor({ scanRoot: [w.scanRoot], claudeHome: w.claudeHome, homeDir: w.userHome, sshDir: join(w.userHome, ".ssh") }),
        ),
      ),
    );
    assert.match(res.stdout, /WARN SHELL_STARTUP_OVERRIDES — ~\/\.zshenv sets GH_REPO/);
    assert.match(res.stdout, /INFO SSH_GITHUB_REDIRECT/);
    assert.doesNotMatch(res.stdout, new RegExp(SECRET));
    assert.doesNotMatch(res.stdout, /example\.net|stranger/);
    // The repo has an unclassified GitHub origin (CLASS_VISIBILITY_UNRESOLVED), which is a real failure,
    // so assert on the machine-level lines only: neither of these two is why doctor would exit 1.
    assert.doesNotMatch(res.stdout, /FAIL SHELL_STARTUP_OVERRIDES|FAIL SSH_GITHUB_REDIRECT/);
  });
});
