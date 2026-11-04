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
import { pinnedHookCommand, renderHookScript, type HookName } from "@de-otio/repo-aegis-core";
import { currentEnforcementPin } from "../enforcement-pin.js";
import { doctor } from "./doctor.js";
import {
  checkPrePushHook,
  checkShellStartupOverrides,
  checkSshGithubRedirect,
  watchedVariablesIn,
} from "./doctor-env-checks.js";
import { captureOutput, fakeGh, withEnv } from "../_test-utils.js";
import { renderShimScript } from "./shim-script.js";

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
      "export GH_HOST=ghe.example.test",
      "export GH_CONFIG_DIR=/x/gh",
    ].join("\n");
    assert.deepEqual(watchedVariablesIn(text), [
      "GH_CONFIG_DIR",
      "GH_HOST",
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
    writeFileSync(join(home, ".zprofile"), `export GH_HOST=${SECRET}\n`);
    writeFileSync(join(home, ".zlogin"), `export REPO_AEGIS_HOME=/x/${SECRET}\n`);
    writeFileSync(join(home, ".bash_login"), `export GH_REPO=stranger/${SECRET}\n`);
    const c = checkShellStartupOverrides(home);
    assert.equal(c.code, "SHELL_STARTUP_OVERRIDES");
    assert.equal(c.ok, false);
    assert.equal(c.severity, "warn");
    assert.match(c.detail, /~\/\.zshenv sets GH_REPO/);
    assert.match(c.detail, /~\/\.zshrc sets SRT_THING/);
    assert.match(c.detail, /~\/\.bashrc sets GIT_SSH_COMMAND/);
    assert.match(c.detail, /~\/\.zprofile sets GH_HOST/);
    assert.match(c.detail, /~\/\.zlogin sets REPO_AEGIS_HOME/);
    assert.match(c.detail, /~\/\.bash_login sets GH_REPO/);
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
    // Dotless host names: the redaction asserts look for the name, and a dotted
    // one inside `includes` reads to CodeQL as URL sanitization.
    const c = checkSshGithubRedirect(sshDirWith("Host github.com\n  HostName gitmirrorzz\n  User git\n"));
    assert.equal(c.ok, false);
    assert.equal(c.severity, "info");
    assert.ok(!c.detail.includes("gitmirrorzz"), c.detail);
  });

  it("is info when `Host github.com` sets a ProxyCommand or ProxyJump", () => {
    for (const line of ["ProxyCommand nc -X 5 -x proxyhostzz:1080 %h %p", "ProxyJump proxyhostzz"]) {
      const c = checkSshGithubRedirect(sshDirWith(`Host github.com\n  ${line}\n`));
      assert.equal(c.ok, false, line);
      assert.equal(c.severity, "info");
      assert.match(c.detail, /ProxyCommand or ProxyJump/);
      assert.ok(!c.detail.includes("proxyhostzz"), c.detail);
    }
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

function installHooks(w: RepoWorld): void {
  const dir = join(w.aegisHome, "hooks");
  mkdirSync(dir, { recursive: true });
  for (const name of ["pre-commit", "pre-push"] as const satisfies readonly HookName[]) {
    writeFileSync(join(dir, name), renderHookScript(name, currentEnforcementPin()), { mode: 0o755 });
    chmodSync(join(dir, name), 0o755);
  }
  withWorld(w, () => execFileSync("git", ["config", "--local", "core.hooksPath", dir], { cwd: w.repo }));
}

function registerGuard(w: RepoWorld): void {
  writeFileSync(
    join(w.claudeHome, "settings.json"),
    JSON.stringify({
      hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: pinnedHookCommand(currentEnforcementPin(), "hook guard-egress --agent claude") }] }],
      },
    }),
  );
}

describe("checkPrePushHook (machine level)", () => {
  it("is silent when the guard hook is not registered (GUARD_HOOK_UNREGISTERED already says so)", () => {
    assert.equal(checkPrePushHook(false, () => null), null);
  });

  it("warns when the guard is registered and the global core.hooksPath is unset", () => {
    const w = makeRepoWorld("prepush-unset");
    const c = withWorld(w, () => checkPrePushHook(true, () => null));
    assert.ok(c);
    assert.equal(c.ok, false);
    assert.equal(c.severity, "warn");
    assert.match(c.detail, /is unset/);
    assert.equal(c.fix, "repo-aegis install hooks");
  });

  it("warns when the global core.hooksPath points somewhere else", () => {
    const w = makeRepoWorld("prepush-foreign");
    const c = withWorld(w, () => checkPrePushHook(true, () => join(tmpDir("foreign-hooks"))));
    assert.ok(c);
    assert.equal(c.ok, false);
    assert.match(c.detail, /not the repo-aegis hooks directory/);
  });

  it("is ok when the global core.hooksPath is the repo-aegis hooks directory", () => {
    const w = makeRepoWorld("prepush-ok");
    const c = withWorld(w, () => checkPrePushHook(true, () => join(w.aegisHome, "hooks")));
    assert.ok(c);
    assert.equal(c.ok, true);
  });
});

describe("doctor — R8/R9/R11 end to end", () => {
  const ghOptions = { policy: "permissive" as const, confirm: () => false };

  it("PREPUSH_HOOK_MISSING is reported once, at machine level, and never per repo", () => {
    const w = makeRepoWorld("e2e-prepush");
    registerGuard(w);
    const res = withWorld(w, () =>
      captureOutput(() =>
        doctor({
          scanRoot: [w.scanRoot],
          claudeHome: w.claudeHome,
          homeDir: w.userHome,
          sshDir: join(w.userHome, ".ssh"),
          json: true,
          ghOptions,
          readGlobalHooksPath: () => null,
        }),
      ),
    );
    const parsed = JSON.parse(res.stdout) as {
      machine: Array<{ code: string; severity?: string; ok: boolean }>;
      results: Array<{ checks: Array<{ code: string }> }>;
    };
    const pp = parsed.machine.filter(c => c.code === "PREPUSH_HOOK_MISSING");
    assert.equal(pp.length, 1);
    assert.equal(pp[0]!.ok, false);
    assert.equal(pp[0]!.severity, "warn");
    assert.ok(parsed.results.every(r => r.checks.every(c => c.code !== "PREPUSH_HOOK_MISSING")));
  });

  it("it is computed AFTER --fix: a repo-local override that --fix removes does not change the global answer, and the finding is still present", () => {
    const w = makeRepoWorld("e2e-prepush-fix");
    registerGuard(w);
    installHooks(w);
    // A repo-local override to an unrelated directory; --fix --yes unsets it.
    const other = tmpDir("other-hooks");
    withWorld(w, () => execFileSync("git", ["config", "--local", "core.hooksPath", other], { cwd: w.repo }));
    const res = withWorld(w, () =>
      captureOutput(() =>
        doctor({
          scanRoot: [w.scanRoot],
          claudeHome: w.claudeHome,
          homeDir: w.userHome,
          sshDir: join(w.userHome, ".ssh"),
          fix: true,
          yes: true,
          ghOptions,
          readGlobalHooksPath: () => null,
        }),
      ),
    );
    assert.match(res.stdout, /WARN PREPUSH_HOOK_MISSING/);
  });

  it("is quiet when the guard hook is registered and the global hooksPath is the repo-aegis directory", () => {
    const w = makeRepoWorld("e2e-prepush-ok");
    registerGuard(w);
    const res = withWorld(w, () =>
      captureOutput(() =>
        doctor({
          scanRoot: [w.scanRoot],
          claudeHome: w.claudeHome,
          homeDir: w.userHome,
          sshDir: join(w.userHome, ".ssh"),
          ghOptions,
          readGlobalHooksPath: () => join(w.aegisHome, "hooks"),
        }),
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
    registerGuard(w);
    const shimDir = join(w.aegisHome, "bin");
    mkdirSync(shimDir, { recursive: true });
    writeFileSync(join(shimDir, "gh"), renderShimScript(currentEnforcementPin()), { mode: 0o755 });
    chmodSync(join(shimDir, "gh"), 0o755);

    const res = withWorld(w, () =>
      withEnv("PATH", `${shimDir}${delimiter}${process.env["PATH"] ?? ""}`, () =>
        captureOutput(() =>
          doctor({
            scanRoot: [w.scanRoot],
            claudeHome: w.claudeHome,
            homeDir: w.userHome,
            sshDir: join(w.userHome, ".ssh"),
            ghOptions,
            readGlobalHooksPath: () => join(w.aegisHome, "hooks"),
          }),
        ),
      ),
    );
    assert.match(res.stdout, /WARN SHELL_STARTUP_OVERRIDES — ~\/\.zshenv sets GH_REPO/);
    assert.match(res.stdout, /INFO SSH_GITHUB_REDIRECT/);
    assert.doesNotMatch(res.stdout, new RegExp(SECRET));
    assert.doesNotMatch(res.stdout, /example\.net|stranger/);
    assert.doesNotMatch(res.stdout, /FAIL SHELL_STARTUP_OVERRIDES|FAIL SSH_GITHUB_REDIRECT/);
  });

  it("never prints 'all clean' when a WARN or SKIP line was printed", () => {
    // No registry (so no owner checks), a registered guard, push.default nothing, the shim installed and first:
    // the only machine findings are warn/info, so the run has no failure but is not clean.
    const w = makeRepoWorld("e2e-not-clean");
    registerGuard(w);
    rmSync(w.repo, { recursive: true, force: true }); // no repo findings either
    const shimDir = join(w.aegisHome, "bin");
    mkdirSync(shimDir, { recursive: true });
    writeFileSync(join(shimDir, "gh"), renderShimScript(currentEnforcementPin()), { mode: 0o755 });
    chmodSync(join(shimDir, "gh"), 0o755);
    writeFileSync(join(w.userHome, ".zshenv"), "export GH_REPO=x/y\n");
    const res = withWorld(w, () =>
      withEnv("PATH", `${shimDir}${delimiter}${process.env["PATH"] ?? ""}`, () =>
        captureOutput(() =>
          doctor({
            scanRoot: [w.scanRoot],
            claudeHome: w.claudeHome,
            homeDir: w.userHome,
            sshDir: join(w.userHome, ".ssh"),
            ghOptions,
            readGlobalHooksPath: () => join(w.aegisHome, "hooks"),
          }),
        ),
      ),
    );
    assert.match(res.stdout, /WARN /);
    assert.doesNotMatch(res.stdout, /all clean/);
    assert.match(res.stdout, /doctor: no failures \(\d+ warning, info or skipped finding\(s\) above\)/);
  });
});
