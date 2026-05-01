import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, existsSync, readFileSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureOutput, withEnv } from "../_test-utils.js";
import { installHooks } from "./install-hooks.js";

let tmp: string;

before(() => {
  tmp = mkdtempSync(join(tmpdir(), "repo-aegis-install-hooks-test-"));
});

after(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function makeRepo(name: string): string {
  const dir = join(tmp, name);
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: dir });
  return dir;
}

describe("install-hooks — fresh install in a git repo", () => {
  let home: string;
  let repo: string;

  before(() => {
    home = join(tmp, "fresh-home");
    mkdirSync(home, { recursive: true });
    repo = makeRepo("fresh-repo");
    withEnv("REPO_AEGIS_HOME", home, () => {
      captureOutput(() => installHooks({ cwd: repo }));
    });
  });

  it("creates the hooks directory under home", () => {
    assert.ok(existsSync(join(home, "hooks")), "hooks dir should exist");
  });

  it("writes pre-commit and pre-push", () => {
    assert.ok(existsSync(join(home, "hooks", "pre-commit")));
    assert.ok(existsSync(join(home, "hooks", "pre-push")));
  });

  it("scripts are executable", () => {
    const st = statSync(join(home, "hooks", "pre-commit"));
    assert.equal(st.mode & 0o111, 0o111, "pre-commit must have all execute bits set");
  });

  it("scripts contain the hook stub body", () => {
    const body = readFileSync(join(home, "hooks", "pre-commit"), "utf8");
    assert.ok(body.includes("repo-aegis check --staged"));
    assert.ok(body.includes("set -euo pipefail"));
  });

  it("sets core.hooksPath in git config", () => {
    const out = execFileSync("git", ["config", "--get", "core.hooksPath"], {
      cwd: repo,
      encoding: "utf8",
    }).trim();
    assert.equal(out, join(home, "hooks"));
  });
});

describe("install-hooks — idempotent re-install", () => {
  it("re-running install hooks does not error and keeps config stable", () => {
    const home = join(tmp, "idem-home");
    mkdirSync(home, { recursive: true });
    const repo = makeRepo("idem-repo");
    withEnv("REPO_AEGIS_HOME", home, () => {
      captureOutput(() => installHooks({ cwd: repo }));
      const result = captureOutput(() => installHooks({ cwd: repo }));
      assert.equal(result.exitCode, undefined);
    });
    const out = execFileSync("git", ["config", "--get", "core.hooksPath"], {
      cwd: repo,
      encoding: "utf8",
    }).trim();
    assert.equal(out, join(home, "hooks"));
  });
});

describe("install-hooks — conflict with existing core.hooksPath", () => {
  let home: string;
  let repo: string;

  before(() => {
    home = join(tmp, "conflict-home");
    mkdirSync(home, { recursive: true });
    repo = makeRepo("conflict-repo");
    execFileSync("git", ["config", "core.hooksPath", "/some/other/path"], { cwd: repo });
  });

  it("refuses without --force and exits 2", () => {
    const result = withEnv("REPO_AEGIS_HOME", home, () =>
      captureOutput(() => installHooks({ cwd: repo })),
    );
    assert.equal(result.exitCode, 2);
    assert.ok(result.stderr.includes("core.hooksPath"));
  });

  it("--force overwrites the conflicting config", () => {
    const result = withEnv("REPO_AEGIS_HOME", home, () =>
      captureOutput(() => installHooks({ cwd: repo, force: true })),
    );
    assert.equal(result.exitCode, undefined);
    const out = execFileSync("git", ["config", "--get", "core.hooksPath"], {
      cwd: repo,
      encoding: "utf8",
    }).trim();
    assert.equal(out, join(home, "hooks"));
  });
});

describe("install-hooks — outside a git repo", () => {
  it("exits 2 with NOT_GIT_REPO", () => {
    const home = join(tmp, "no-git-home");
    mkdirSync(home, { recursive: true });
    const notRepo = join(tmp, "not-a-repo");
    mkdirSync(notRepo, { recursive: true });
    const result = withEnv("REPO_AEGIS_HOME", home, () =>
      captureOutput(() => installHooks({ cwd: notRepo })),
    );
    assert.equal(result.exitCode, 2);
    assert.ok(result.stderr.includes("not inside a git repository"));
  });
});

describe("install-hooks — JSON output", () => {
  it("emits the expected shape", () => {
    const home = join(tmp, "json-home");
    mkdirSync(home, { recursive: true });
    const repo = makeRepo("json-repo");
    const result = withEnv("REPO_AEGIS_HOME", home, () =>
      captureOutput(() => installHooks({ cwd: repo, json: true })),
    );
    const j = JSON.parse(result.stdout) as {
      action: string;
      hooksDir: string;
      installed: string[];
      coreHooksPath: string;
      previousCoreHooksPath: string | null;
      overwritten: boolean;
    };
    assert.equal(j.action, "install-hooks");
    assert.deepEqual(j.installed, ["pre-commit", "pre-push"]);
    assert.equal(j.coreHooksPath, join(home, "hooks"));
    assert.equal(j.previousCoreHooksPath, null);
    assert.equal(j.overwritten, false);
  });
});
