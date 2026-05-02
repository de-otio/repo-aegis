// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
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

  it("conflict message names the prior path verbatim and warns --force destroys it", () => {
    const result = withEnv("REPO_AEGIS_HOME", home, () =>
      captureOutput(() => installHooks({ cwd: repo })),
    );
    assert.equal(result.exitCode, 2);
    // The prior path must appear verbatim so the operator can see what
    // they would lose; the message must also flag that --force overwrites.
    assert.ok(
      result.stderr.includes("/some/other/path"),
      "conflict message should include the prior core.hooksPath verbatim",
    );
    assert.ok(
      /OVERWRITE|overwrite/.test(result.stderr) && /--force/.test(result.stderr),
      "conflict message should warn that --force overwrites the prior path",
    );
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

describe("install-hooks — --uninstall", () => {
  it("unsets core.hooksPath and removes pre-commit/pre-push", () => {
    const home = join(tmp, "uninstall-home");
    mkdirSync(home, { recursive: true });
    const repo = makeRepo("uninstall-repo");

    withEnv("REPO_AEGIS_HOME", home, () => {
      captureOutput(() => installHooks({ cwd: repo }));
      const result = captureOutput(() => installHooks({ cwd: repo, uninstall: true }));
      assert.equal(result.exitCode, undefined);
      assert.ok(result.stdout.includes("unset core.hooksPath"));
      assert.ok(result.stdout.includes("removed"));
    });

    // core.hooksPath is no longer set
    let stillSet = "";
    try {
      stillSet = execFileSync("git", ["config", "--get", "core.hooksPath"], {
        cwd: repo,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      // git config exits 1 when the key is unset; swallow.
    }
    assert.equal(stillSet, "", "core.hooksPath should be unset after uninstall");

    assert.ok(!existsSync(join(home, "hooks", "pre-commit")));
    assert.ok(!existsSync(join(home, "hooks", "pre-push")));
    // Hooks dir itself is preserved (other tools may live there).
    assert.ok(existsSync(join(home, "hooks")));
  });

  it("is idempotent when nothing is installed", () => {
    const home = join(tmp, "uninstall-noop-home");
    mkdirSync(home, { recursive: true });
    const repo = makeRepo("uninstall-noop-repo");

    const result = withEnv("REPO_AEGIS_HOME", home, () =>
      captureOutput(() => installHooks({ cwd: repo, uninstall: true })),
    );
    assert.equal(result.exitCode, undefined);
    assert.ok(
      result.stdout.includes("not set") || result.stdout.includes("nothing to remove"),
      "uninstall on a clean repo should report a clear no-op",
    );
  });

  it("emits the expected JSON shape", () => {
    const home = join(tmp, "uninstall-json-home");
    mkdirSync(home, { recursive: true });
    const repo = makeRepo("uninstall-json-repo");

    const result = withEnv("REPO_AEGIS_HOME", home, () => {
      captureOutput(() => installHooks({ cwd: repo }));
      return captureOutput(() =>
        installHooks({ cwd: repo, uninstall: true, json: true }),
      );
    });

    const j = JSON.parse(result.stdout) as {
      action: string;
      hooksDir: string;
      removed: string[];
      coreHooksPathUnset: boolean;
      previousCoreHooksPath: string | null;
    };
    assert.equal(j.action, "uninstall-hooks");
    assert.equal(j.hooksDir, join(home, "hooks"));
    assert.equal(j.coreHooksPathUnset, true);
    assert.equal(j.previousCoreHooksPath, join(home, "hooks"));
    assert.equal(j.removed.length, 2);
  });

  it("respects silent: no stdout/stderr on uninstall", () => {
    const home = join(tmp, "uninstall-silent-home");
    mkdirSync(home, { recursive: true });
    const repo = makeRepo("uninstall-silent-repo");

    const result = withEnv("REPO_AEGIS_HOME", home, () => {
      captureOutput(() => installHooks({ cwd: repo }));
      return captureOutput(() =>
        installHooks({ cwd: repo, uninstall: true, silent: true }),
      );
    });
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
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
