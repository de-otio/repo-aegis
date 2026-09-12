// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureOutput, withEnv, fakeGh, withFakeGh, withoutGh } from "../_test-utils.js";
import { status } from "./status.js";
import { installHooks } from "./install-hooks.js";

let tmp: string;
let originalCwd: string;

before(() => {
  tmp = mkdtempSync(join(tmpdir(), "repo-aegis-status-test-"));
  originalCwd = process.cwd();
});
after(() => {
  process.chdir(originalCwd);
  rmSync(tmp, { recursive: true, force: true });
});
afterEach(() => process.chdir(originalCwd));

function setupHome(name: string): string {
  const home = join(tmp, name + "-home");
  mkdirSync(join(home, "markers"), { recursive: true });
  mkdirSync(join(home, "state"), { recursive: true });
  return home;
}

function makeRepo(name: string, cls: string, visibility?: string): string {
  const dir = join(tmp, name);
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "repo-aegis.class", cls], { cwd: dir });
  if (visibility) {
    // Pre-seed the cache; the live `gh` probe is a no-op in tests (no remote),
    // so resolveVisibility falls back to this value deterministically.
    execFileSync("git", ["config", "repo-aegis.visibility", visibility], { cwd: dir });
  }
  return dir;
}

describe("status — visibility", () => {
  it("JSON reports cached visibility and publicFacing (misclassified-public case)", () => {
    const home = setupHome("status-vis-json");
    const repo = makeRepo("status-vis-json-repo", "private-strict", "public");
    process.chdir(repo);
    const result = withEnv("REPO_AEGIS_HOME", home, () =>
      captureOutput(() => status({ json: true })),
    );
    const j = JSON.parse(result.stdout) as { visibility: string; publicFacing: boolean };
    assert.equal(j.visibility, "public");
    assert.equal(j.publicFacing, true); // public visibility enforces despite private-strict
  });

  it("text output shows the github line and the reclassify hint", () => {
    const home = setupHome("status-vis-text");
    const repo = makeRepo("status-vis-text-repo", "private-strict", "public");
    process.chdir(repo);
    const result = withEnv("REPO_AEGIS_HOME", home, () => captureOutput(() => status({})));
    assert.match(result.stdout, /github:\s+public/);
    assert.match(result.stdout, /egress-hygiene enforced/);
    assert.match(result.stdout, /class=public-eligible/);
  });

  it("private repo is not public-facing", () => {
    const home = setupHome("status-vis-private");
    const repo = makeRepo("status-vis-private-repo", "private-strict", "private");
    process.chdir(repo);
    const result = withEnv("REPO_AEGIS_HOME", home, () =>
      captureOutput(() => status({ json: true })),
    );
    const j = JSON.parse(result.stdout) as { visibility: string; publicFacing: boolean };
    assert.equal(j.visibility, "private");
    assert.equal(j.publicFacing, false);
  });
});

// H2/H6: a repo-local core.hooksPath pointing at an empty (or foreign)
// directory silently disables scanning, and a hook that never runs
// cannot report itself. These tests confirm `status` surfaces the
// state read directly via resolveHookState, instead of relying on
// hook output that would never arrive.
//
// SAFETY: `resolveHookState` reads whichever core.hooksPath git
// resolves to, including the *global* scope — and this machine's real
// ~/.gitconfig has repo-aegis's own core.hooksPath set globally (it is
// itself a repo-aegis-managed repo). Every test below therefore runs
// via `withHooksIsolation`, which redirects GIT_CONFIG_GLOBAL/SYSTEM to
// /dev/null in addition to REPO_AEGIS_HOME, so results depend only on
// this fixture's local git config — never the developer's real global
// config. Same pattern as packages/core/src/hooks-state.test.ts.
function withHooksIsolation<T>(home: string, fn: () => T): T {
  const overrides: Record<string, string> = {
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    REPO_AEGIS_HOME: home,
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

describe("status — hooks (H2)", () => {
  it("healthy install -> hooks.ok true in JSON, terse OK line in text", () => {
    const home = setupHome("status-hooks-ok");
    const repo = makeRepo("status-hooks-ok-repo", "private-strict");

    withHooksIsolation(home, () => {
      // `local: true` is required, not incidental: the default is now a GLOBAL
      // write, and `withHooksIsolation` points GIT_CONFIG_GLOBAL at /dev/null,
      // which git refuses to lock. A repo-local write gives the same healthy
      // effective state without touching (or needing) a global config file.
      installHooks({ cwd: repo, silent: true, local: true });
      process.chdir(repo);

      const jsonResult = captureOutput(() => status({ json: true }));
      const j = JSON.parse(jsonResult.stdout) as {
        hooks: { ok: boolean; code: string; isGitRepo: boolean };
      };
      assert.equal(j.hooks.isGitRepo, true);
      assert.equal(j.hooks.ok, true);
      assert.equal(j.hooks.code, "HOOKS_OK");

      const textResult = captureOutput(() => status({}));
      assert.match(textResult.stdout, /^ {2}hooks:\s+OK — /m);
      assert.ok(!textResult.stdout.includes("FAIL"));
    });
  });

  it("local core.hooksPath pointing at an empty foreign dir -> hooks.ok false, FAIL line with fix", () => {
    const home = setupHome("status-hooks-foreign");
    const repo = makeRepo("status-hooks-foreign-repo", "private-strict");
    const foreignDir = join(tmp, "status-hooks-foreign-empty");
    mkdirSync(foreignDir, { recursive: true });

    withHooksIsolation(home, () => {
      execFileSync("git", ["config", "core.hooksPath", foreignDir], { cwd: repo });
      process.chdir(repo);

      const jsonResult = captureOutput(() => status({ json: true }));
      const j = JSON.parse(jsonResult.stdout) as { hooks: { ok: boolean; code: string } };
      assert.equal(j.hooks.ok, false);
      // No global core.hooksPath is visible in this isolated fixture
      // (only a repo-local override to a bare dir), so there is no
      // "correctly configured global" being shadowed —
      // HOOKS_PATH_FOREIGN, not HOOKS_PATH_LOCAL_OVERRIDE. See
      // hooks-state.ts for the distinction.
      assert.equal(j.hooks.code, "HOOKS_PATH_FOREIGN");

      const textResult = captureOutput(() => status({}));
      assert.match(textResult.stdout, /^ {2}hooks:\s+FAIL — /m);
      assert.ok(textResult.stdout.includes("fix: git config --unset core.hooksPath"));
      // status never gates on this (audit is the gate) — exit code is
      // untouched by the hooks line.
      assert.equal(textResult.exitCode, undefined);
    });
  });

  it("not a git repo -> no hooks line printed in text mode", () => {
    const home = setupHome("status-hooks-nongit");
    const nonGitDir = join(tmp, "status-hooks-nongit-dir");
    mkdirSync(nonGitDir, { recursive: true });

    withHooksIsolation(home, () => {
      process.chdir(nonGitDir);
      const result = captureOutput(() => status({}));
      assert.equal(result.stdout.trim(), "repo-aegis status: not inside a git repository");
      assert.ok(!result.stdout.includes("hooks:"));
    });
  });

  it("[H6] appends an observe-hooks audit record when audit-log is enabled", () => {
    const home = setupHome("status-hooks-auditlog");
    // Enable audit-log directly via its on-disk config shape (state/audit-log.json),
    // mirroring what `repo-aegis audit-log on` writes, without depending on
    // that command's implementation.
    writeFileSync(join(home, "state", "audit-log.json"), JSON.stringify({ enabled: true }));
    const repo = makeRepo("status-hooks-auditlog-repo", "private-strict");

    withHooksIsolation(home, () => {
      process.chdir(repo);
      captureOutput(() => status({ json: true }));

      const logPath = join(home, "state", "audit.log");
      const lines = readFileSync(logPath, "utf8").trim().split("\n");
      const records = lines.map(
        l => JSON.parse(l) as { action: string; details?: { code?: string; ok?: boolean } },
      );
      const rec = records.find(r => r.action === "observe-hooks");
      assert.ok(rec, "expected an observe-hooks record in the audit log");
      // Isolated fixture: core.hooksPath is unset in every visible scope.
      assert.equal(rec!.details?.code, "HOOKS_PATH_UNSET");
      assert.equal(rec!.details?.ok, false);
    });
  });
});

// ---------------------------------------------------------------------------
// Issue #97.1 — the visibility probe collapsed every failure to "unknown".
// On a machine with two `gh` accounts, a repo the active account cannot see
// 404s and reads exactly like "no remote" or "gh not installed" — so a
// private repo sat at whatever class `classify` assigned with nothing to
// contradict it. An unseeable repo is ACTIONABLE; "unknown" is not.
// ---------------------------------------------------------------------------
describe("status — visibility probe diagnostics (#97.1)", () => {
  function repoWithRemote(name: string, cls = "private-strict"): string {
    const dir = makeRepo(name, cls);
    execFileSync("git", ["remote", "add", "origin", "git@github.com:some-org/some-repo.git"], {
      cwd: dir,
    });
    return dir;
  }

  const UNAUTH_GH = `echo "GraphQL: Could not resolve to a Repository with the name 'x/y'. (repository)" >&2\nexit 1`;

  it("JSON reports status=unauthorized, distinct from a plain unknown", () => {
    const home = setupHome("status-probe-unauth");
    const repo = repoWithRemote("status-probe-unauth-repo");
    const gh = fakeGh(join(tmp, "gh-status-unauth"), UNAUTH_GH);
    process.chdir(repo);
    const result = withFakeGh(gh, () =>
      withEnv("REPO_AEGIS_HOME", home, () => captureOutput(() => status({ json: true }))),
    );
    const j = JSON.parse(result.stdout) as {
      visibility: string;
      visibilityProbe: { status: string; fix?: string; fromCache: boolean };
    };
    assert.equal(j.visibility, "unknown");
    assert.equal(j.visibilityProbe.status, "unauthorized");
    assert.ok(j.visibilityProbe.fix, "an unauthorized probe must carry a fix hint");
  });

  it("JSON reports status=no-gh when gh is not installed", () => {
    const home = setupHome("status-probe-nogh");
    const repo = repoWithRemote("status-probe-nogh-repo");
    process.chdir(repo);
    const result = withoutGh(join(tmp, "status-nogh-path"), () =>
      withEnv("REPO_AEGIS_HOME", home, () => captureOutput(() => status({ json: true }))),
    );
    const j = JSON.parse(result.stdout) as {
      visibilityProbe: { status: string; fix?: string };
    };
    assert.equal(j.visibilityProbe.status, "no-gh");
    assert.ok(j.visibilityProbe.fix);
  });

  it("JSON reports status=resolved when gh answers", () => {
    const home = setupHome("status-probe-ok");
    const repo = repoWithRemote("status-probe-ok-repo");
    const gh = fakeGh(join(tmp, "gh-status-ok"), "echo PUBLIC");
    process.chdir(repo);
    const result = withFakeGh(gh, () =>
      withEnv("REPO_AEGIS_HOME", home, () => captureOutput(() => status({ json: true }))),
    );
    const j = JSON.parse(result.stdout) as {
      visibility: string;
      visibilityProbe: { status: string; fromCache: boolean };
    };
    assert.equal(j.visibility, "public");
    assert.equal(j.visibilityProbe.status, "resolved");
    assert.equal(j.visibilityProbe.fromCache, false);
  });

  it("text output warns, with a fix, when the probe could not see the repo", () => {
    const home = setupHome("status-probe-unauth-text");
    const repo = repoWithRemote("status-probe-unauth-text-repo");
    const gh = fakeGh(join(tmp, "gh-status-unauth-text"), UNAUTH_GH);
    process.chdir(repo);
    const result = withFakeGh(gh, () =>
      withEnv("REPO_AEGIS_HOME", home, () => captureOutput(() => status({}))),
    );
    assert.match(result.stdout, /github:\s+unknown/);
    assert.match(result.stdout, /unauthorized/);
    assert.match(result.stdout, /warning:/);
    assert.match(result.stdout, /GH_TOKEN|gh auth|account/i);
  });

  it("an unauthorized probe warns even when a stale cached value exists", () => {
    const home = setupHome("status-probe-stale");
    const repo = repoWithRemote("status-probe-stale-repo");
    execFileSync("git", ["config", "repo-aegis.visibility", "public"], { cwd: repo });
    const gh = fakeGh(join(tmp, "gh-status-stale"), UNAUTH_GH);
    process.chdir(repo);
    const result = withFakeGh(gh, () =>
      withEnv("REPO_AEGIS_HOME", home, () => captureOutput(() => status({ json: true }))),
    );
    const j = JSON.parse(result.stdout) as {
      visibility: string;
      visibilityProbe: { status: string; fromCache: boolean };
    };
    // The cache still answers, but the operator must know the probe is blind.
    assert.equal(j.visibility, "public");
    assert.equal(j.visibilityProbe.status, "unauthorized");
    assert.equal(j.visibilityProbe.fromCache, true);
  });

  it("a repo with no GitHub remote reports no-remote and does not warn", () => {
    const home = setupHome("status-probe-noremote");
    const repo = makeRepo("status-probe-noremote-repo", "private-strict");
    const gh = fakeGh(
      join(tmp, "gh-status-noremote"),
      `echo "none of the git remotes configured for this repository point to a known GitHub host. To tell gh about a new GitHub host, please use \\\`gh auth login\\\`" >&2\nexit 1`,
    );
    process.chdir(repo);
    const result = withFakeGh(gh, () =>
      withEnv("REPO_AEGIS_HOME", home, () => captureOutput(() => status({ json: true }))),
    );
    const j = JSON.parse(result.stdout) as { visibilityProbe: { status: string } };
    assert.equal(j.visibilityProbe.status, "no-remote");
  });

  it("the probe never echoes gh stderr (it can carry a customer repo name)", () => {
    const home = setupHome("status-probe-noecho");
    const repo = repoWithRemote("status-probe-noecho-repo");
    const gh = fakeGh(
      join(tmp, "gh-status-noecho"),
      `echo "Could not resolve to a Repository with the name 'UNIQUE-STDERR-SENTINEL/x'." >&2\nexit 1`,
    );
    process.chdir(repo);
    const result = withFakeGh(gh, () =>
      withEnv("REPO_AEGIS_HOME", home, () => captureOutput(() => status({ json: true }))),
    );
    assert.doesNotMatch(result.stdout, /UNIQUE-STDERR-SENTINEL/);
    assert.doesNotMatch(result.stderr, /UNIQUE-STDERR-SENTINEL/);
  });
});
