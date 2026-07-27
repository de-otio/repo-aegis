// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
  chmodSync,
  statSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureOutput, withEnv } from "../_test-utils.js";
import { installHooks } from "./install-hooks.js";

let root: string;

before(() => {
  root = mkdtempSync(join(tmpdir(), "repo-aegis-install-hooks-test-"));
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

// SAFETY: `install hooks` writes core.hooksPath to the GLOBAL git
// config by default (the v0.7 behaviour this file tests). Every case
// below therefore runs inside an isolated Fixture whose
// GIT_CONFIG_GLOBAL/SYSTEM point at per-fixture temp files (never the
// developer's real ~/.gitconfig) and whose REPO_AEGIS_HOME points at a
// per-fixture temp dir. Never call `installHooks` or `git config
// --global` outside `Fixture.run`. Same isolation pattern as
// packages/core/src/hooks-state.test.ts and
// packages/cli/src/commands/status.test.ts's withHooksIsolation.
interface Fixture {
  base: string;
  repo: string;
  home: string;
  globalConfig: string;
  run: <T>(fn: () => T) => T;
}

function makeFixture(name: string): Fixture {
  const base = join(root, name);
  const repo = join(base, "repo");
  const home = join(base, "home");
  const globalConfig = join(base, "gitconfig-global");
  mkdirSync(repo, { recursive: true });
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

  run(() => {
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "test"], { cwd: repo });
  });

  return { base, repo, home, globalConfig, run };
}

function expectedHooksDir(fx: Fixture): string {
  return join(fx.home, "hooks");
}

function readScoped(fx: Fixture, scope: "global" | "local"): string {
  return fx.run(() => {
    try {
      return execFileSync("git", ["config", `--${scope}`, "--get", "core.hooksPath"], {
        cwd: fx.repo,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      return "";
    }
  });
}

function setLocal(fx: Fixture, value: string): void {
  fx.run(() => execFileSync("git", ["config", "core.hooksPath", value], { cwd: fx.repo }));
}

function enableAuditLog(fx: Fixture): void {
  const stateDir = join(fx.home, "state");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "audit-log.json"), JSON.stringify({ enabled: true }));
}

interface AuditRecord {
  ts: string;
  action: string;
  details?: Record<string, unknown>;
}

function readAuditRecords(fx: Fixture): AuditRecord[] {
  const p = join(fx.home, "state", "audit.log");
  if (!existsSync(p)) return [];
  const raw = readFileSync(p, "utf8").trim();
  if (raw === "") return [];
  return raw.split("\n").map(line => JSON.parse(line) as AuditRecord);
}

// ---------------------------------------------------------------------------
// Basic install behaviour
// ---------------------------------------------------------------------------

describe("install-hooks — fresh install (global, the default)", () => {
  let fx: Fixture;

  before(() => {
    fx = makeFixture("fresh");
    fx.run(() => captureOutput(() => installHooks({ cwd: fx.repo })));
  });

  it("creates the hooks directory under home", () => {
    assert.ok(existsSync(join(fx.home, "hooks")));
  });

  it("writes pre-commit and pre-push", () => {
    assert.ok(existsSync(join(fx.home, "hooks", "pre-commit")));
    assert.ok(existsSync(join(fx.home, "hooks", "pre-push")));
  });

  it("scripts are executable", () => {
    const st = statSync(join(fx.home, "hooks", "pre-commit"));
    assert.equal(st.mode & 0o111, 0o111, "pre-commit must have all execute bits set");
  });

  it("scripts contain the hook stub body", () => {
    const body = readFileSync(join(fx.home, "hooks", "pre-commit"), "utf8");
    assert.ok(body.includes("repo-aegis check --staged"));
    assert.ok(body.includes("set -euo pipefail"));
  });

  it("sets core.hooksPath in the GLOBAL scope", () => {
    assert.equal(readScoped(fx, "global"), expectedHooksDir(fx));
  });

  it("leaves the LOCAL scope untouched", () => {
    assert.equal(readScoped(fx, "local"), "");
  });
});

describe("install-hooks — idempotent re-install", () => {
  it("re-running install hooks does not error and keeps global config stable", () => {
    const fx = makeFixture("idem");
    fx.run(() => {
      captureOutput(() => installHooks({ cwd: fx.repo }));
      const result = captureOutput(() => installHooks({ cwd: fx.repo }));
      assert.equal(result.exitCode, undefined);
    });
    assert.equal(readScoped(fx, "global"), expectedHooksDir(fx));
  });
});

describe("install-hooks — outside a git repo", () => {
  it("exits 2 with NOT_GIT_REPO", () => {
    const fx = makeFixture("no-git");
    const notRepo = join(fx.base, "not-a-repo");
    mkdirSync(notRepo, { recursive: true });
    const result = fx.run(() => captureOutput(() => installHooks({ cwd: notRepo })));
    assert.equal(result.exitCode, 2);
    assert.ok(result.stderr.includes("not inside a git repository"));
  });
});

describe("install-hooks — JSON output (global default)", () => {
  it("emits the expected shape", () => {
    const fx = makeFixture("json");
    const result = fx.run(() => captureOutput(() => installHooks({ cwd: fx.repo, json: true })));
    const j = JSON.parse(result.stdout) as {
      action: string;
      hooksDir: string;
      installed: string[];
      coreHooksPath: string;
      scope: string;
      previousCoreHooksPath: string | null;
      overwritten: boolean;
      shadowingLocalValue: string | null;
    };
    assert.equal(j.action, "install-hooks");
    assert.deepEqual(j.installed, ["pre-commit", "pre-push"]);
    assert.equal(j.coreHooksPath, expectedHooksDir(fx));
    assert.equal(j.scope, "global");
    assert.equal(j.previousCoreHooksPath, null);
    assert.equal(j.overwritten, false);
    assert.equal(j.shadowingLocalValue, null);
  });
});

// ---------------------------------------------------------------------------
// --local (explicit opt-out)
// ---------------------------------------------------------------------------

describe("install-hooks — --local", () => {
  it("writes repo-local core.hooksPath and leaves global untouched", () => {
    const fx = makeFixture("local-write");
    const result = fx.run(() => captureOutput(() => installHooks({ cwd: fx.repo, local: true })));
    assert.equal(result.exitCode, undefined);
    assert.equal(readScoped(fx, "local"), expectedHooksDir(fx));
    assert.equal(readScoped(fx, "global"), "");
  });

  it("JSON output reports scope: local", () => {
    const fx = makeFixture("local-json");
    const result = fx.run(() =>
      captureOutput(() => installHooks({ cwd: fx.repo, local: true, json: true })),
    );
    const j = JSON.parse(result.stdout) as { scope: string };
    assert.equal(j.scope, "local");
  });

  it("a differing LOCAL value refuses without --force (same-scope conflict, not the shadow guard)", () => {
    const fx = makeFixture("local-conflict");
    setLocal(fx, "/some/other/local-path");
    const result = fx.run(() =>
      captureOutput(() => installHooks({ cwd: fx.repo, local: true, json: true })),
    );
    assert.equal(result.exitCode, 2);
    const j = JSON.parse(result.stderr) as { code: string; error: string; details: string };
    assert.equal(j.code, "HOOKS_PATH_CONFLICT");
    assert.ok(j.details.includes("/some/other/local-path"));
    assert.ok(/OVERWRITE|overwrite/.test(j.details) && /--force/.test(j.details));
  });

  it("--local with a differing global value does NOT refuse (writing local never destroys global)", () => {
    const fx = makeFixture("local-over-global");
    fx.run(() => captureOutput(() => installHooks({ cwd: fx.repo })));
    // Global now correctly set. A --local install is an explicit,
    // single-repo opt-in to shadowing it — no guard applies here (the
    // guard only fires the other direction: writing global while a
    // differing local value exists).
    const result = fx.run(() => captureOutput(() => installHooks({ cwd: fx.repo, local: true })));
    assert.equal(result.exitCode, undefined);
    assert.equal(readScoped(fx, "local"), expectedHooksDir(fx));
  });
});

// ---------------------------------------------------------------------------
// The footgun guard: writing global while local shadows it
// ---------------------------------------------------------------------------

describe("install-hooks — global install vs. a shadowing local value", () => {
  it("refuses without --force, naming the local value", () => {
    const fx = makeFixture("shadow-refuse");
    setLocal(fx, "/some/other/local-path");
    const result = fx.run(() =>
      captureOutput(() => installHooks({ cwd: fx.repo, json: true })),
    );
    assert.equal(result.exitCode, 2);
    const j = JSON.parse(result.stderr) as { code: string; error: string; details: string };
    assert.equal(j.code, "HOOKS_PATH_LOCAL_SHADOW");
    assert.ok(
      j.details.includes("/some/other/local-path"),
      "message should name the shadowing local value verbatim",
    );
    assert.ok(/OVERWRITE|overwrite/.test(j.details) && /--force|--unset-local/.test(j.details));
    // Global must NOT have been written — refused before any mutation.
    assert.equal(readScoped(fx, "global"), "");
  });

  it("--force proceeds, writes global, and leaves the local shadow in place (still warns)", () => {
    const fx = makeFixture("shadow-force");
    setLocal(fx, "/some/other/local-path");
    const result = fx.run(() =>
      captureOutput(() => installHooks({ cwd: fx.repo, force: true })),
    );
    assert.equal(result.exitCode, undefined);
    assert.equal(readScoped(fx, "global"), expectedHooksDir(fx));
    // The whole point of the guard: --force alone does not clear the
    // shadow, so it must still be reported.
    assert.equal(readScoped(fx, "local"), "/some/other/local-path");
    assert.ok(result.stdout.includes("/some/other/local-path"));
  });

  it("--unset-local clears the shadowing key in one step, no --force needed", () => {
    const fx = makeFixture("shadow-unset-local");
    setLocal(fx, "/some/other/local-path");
    const result = fx.run(() =>
      captureOutput(() => installHooks({ cwd: fx.repo, unsetLocal: true })),
    );
    assert.equal(result.exitCode, undefined);
    assert.equal(readScoped(fx, "global"), expectedHooksDir(fx));
    assert.equal(readScoped(fx, "local"), "", "local shadow should be cleared");
    assert.ok(result.stdout.includes("cleared shadowing local core.hooksPath"));
  });

  it("no shadow, no refusal: a plain global install with no local value proceeds normally", () => {
    const fx = makeFixture("no-shadow");
    const result = fx.run(() => captureOutput(() => installHooks({ cwd: fx.repo })));
    assert.equal(result.exitCode, undefined);
  });

  it("a local value that already equals the target is not a shadow", () => {
    const fx = makeFixture("local-equals-target");
    setLocal(fx, expectedHooksDir(fx));
    const result = fx.run(() => captureOutput(() => installHooks({ cwd: fx.repo })));
    assert.equal(result.exitCode, undefined, "identical local value should not trigger the guard");
  });
});

// ---------------------------------------------------------------------------
// --uninstall: clears BOTH scopes independently
// ---------------------------------------------------------------------------

describe("install-hooks — --uninstall clears both scopes", () => {
  it("global-only install: uninstall unsets global, local stays unset", () => {
    const fx = makeFixture("uninstall-global-only");
    fx.run(() => {
      captureOutput(() => installHooks({ cwd: fx.repo }));
      const result = captureOutput(() => installHooks({ cwd: fx.repo, uninstall: true }));
      assert.equal(result.exitCode, undefined);
    });
    assert.equal(readScoped(fx, "global"), "");
    assert.equal(readScoped(fx, "local"), "");
    assert.ok(!existsSync(join(fx.home, "hooks", "pre-commit")));
    assert.ok(!existsSync(join(fx.home, "hooks", "pre-push")));
    assert.ok(existsSync(join(fx.home, "hooks")), "hooks dir itself is preserved");
  });

  it("BOTH scopes set (the shadowing scenario): uninstall clears both, not just whichever git finds first", () => {
    const fx = makeFixture("uninstall-both-scopes");
    fx.run(() => captureOutput(() => installHooks({ cwd: fx.repo, force: true })));
    setLocal(fx, expectedHooksDir(fx));
    assert.equal(readScoped(fx, "global"), expectedHooksDir(fx));
    assert.equal(readScoped(fx, "local"), expectedHooksDir(fx));

    const result = fx.run(() =>
      captureOutput(() => installHooks({ cwd: fx.repo, uninstall: true, json: true })),
    );
    const j = JSON.parse(result.stdout) as {
      global: { unset: boolean; previousCoreHooksPath: string | null };
      local: { unset: boolean; previousCoreHooksPath: string | null };
    };
    assert.equal(j.global.unset, true);
    assert.equal(j.global.previousCoreHooksPath, expectedHooksDir(fx));
    assert.equal(j.local.unset, true);
    assert.equal(j.local.previousCoreHooksPath, expectedHooksDir(fx));

    // A bare `git config --unset` would only have cleared whichever
    // scope git finds first (local, since it wins) and left global
    // behind. Confirm BOTH are actually gone.
    assert.equal(readScoped(fx, "global"), "");
    assert.equal(readScoped(fx, "local"), "");
  });

  it("is idempotent when nothing is installed", () => {
    const fx = makeFixture("uninstall-noop");
    const result = fx.run(() => captureOutput(() => installHooks({ cwd: fx.repo, uninstall: true })));
    assert.equal(result.exitCode, undefined);
    assert.ok(result.stdout.includes("global core.hooksPath was not set"));
    assert.ok(result.stdout.includes("local core.hooksPath was not set"));
  });

  it("respects silent: no stdout/stderr on uninstall", () => {
    const fx = makeFixture("uninstall-silent");
    const result = fx.run(() => {
      captureOutput(() => installHooks({ cwd: fx.repo }));
      return captureOutput(() => installHooks({ cwd: fx.repo, uninstall: true, silent: true }));
    });
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
  });
});

// ---------------------------------------------------------------------------
// Forensics: previous value + config mtime in the audit record
// ---------------------------------------------------------------------------

describe("install-hooks — audit forensics", () => {
  it("install audit record carries previousCoreHooksPath and a configMtime captured before the write", () => {
    const fx = makeFixture("audit-install");
    enableAuditLog(fx);
    // Global config file doesn't exist yet; write it now with an
    // unrelated key so it has a real mtime to capture (mirrors a
    // developer machine where ~/.gitconfig already exists for other
    // reasons before repo-aegis ever touches it).
    fx.run(() =>
      execFileSync("git", ["config", "--global", "user.name", "someone"], { cwd: fx.repo }),
    );

    fx.run(() => captureOutput(() => installHooks({ cwd: fx.repo })));

    const records = readAuditRecords(fx).filter(r => r.action === "install-hooks");
    assert.equal(records.length, 1);
    const details = records[0]!.details as {
      scope: string;
      previousCoreHooksPath: string | null;
      configMtime: string | null;
    };
    assert.equal(details.scope, "global");
    assert.equal(details.previousCoreHooksPath, null);
    assert.ok(details.configMtime !== null, "configMtime should be captured, not null");
    // A real ISO timestamp, not a placeholder.
    assert.ok(!Number.isNaN(Date.parse(details.configMtime!)));
  });

  it("a second install over a differing value carries the OLD value as previousCoreHooksPath, not the new one", () => {
    const fx = makeFixture("audit-overwrite");
    enableAuditLog(fx);
    setLocal(fx, "/old/local/path");
    fx.run(() => captureOutput(() => installHooks({ cwd: fx.repo, local: true, force: true })));

    const records = readAuditRecords(fx).filter(r => r.action === "install-hooks");
    assert.equal(records.length, 1);
    const details = records[0]!.details as { previousCoreHooksPath: string | null };
    assert.equal(details.previousCoreHooksPath, "/old/local/path");
  });

  it("uninstall audit record carries both scopes' previous values", () => {
    const fx = makeFixture("audit-uninstall");
    enableAuditLog(fx);
    fx.run(() => captureOutput(() => installHooks({ cwd: fx.repo, force: true })));
    setLocal(fx, expectedHooksDir(fx));

    fx.run(() => captureOutput(() => installHooks({ cwd: fx.repo, uninstall: true })));

    const records = readAuditRecords(fx).filter(r => r.action === "install-hooks-uninstall");
    assert.equal(records.length, 1);
    const details = records[0]!.details as {
      global: { previousCoreHooksPath: string | null };
      local: { previousCoreHooksPath: string | null };
    };
    assert.equal(details.global.previousCoreHooksPath, expectedHooksDir(fx));
    assert.equal(details.local.previousCoreHooksPath, expectedHooksDir(fx));
  });
});

// ---------------------------------------------------------------------------
// Chaining: the generated scripts hand off to a repo's own hooks
// ---------------------------------------------------------------------------

describe("install-hooks — chaining to a repo's own .git/hooks", () => {
  /** A stub `repo-aegis` on PATH ahead of the real one, so no real scan
   * runs. Exit code is controlled by the caller via `rc`. */
  function stubRepoAegis(dir: string, rc: number): void {
    mkdirSync(dir, { recursive: true });
    const p = join(dir, "repo-aegis");
    writeFileSync(p, `#!/bin/sh\nexit ${rc}\n`, { mode: 0o755 });
    chmodSync(p, 0o755);
  }

  function writeChainedHook(repoHooksDir: string, name: string, rc: number, markerPath: string): void {
    mkdirSync(repoHooksDir, { recursive: true });
    const p = join(repoHooksDir, name);
    writeFileSync(
      p,
      `#!/bin/sh\necho chained-ran > "${markerPath}"\nexit ${rc}\n`,
      { mode: 0o755 },
    );
    chmodSync(p, 0o755);
  }

  it("a repo with an executable pre-commit still runs it after a global install", () => {
    const fx = makeFixture("chain-pre-commit-runs");
    const binDir = join(fx.base, "bin");
    stubRepoAegis(binDir, 0);
    const marker = join(fx.base, "chained-marker");
    writeChainedHook(join(fx.repo, ".git", "hooks"), "pre-commit", 0, marker);

    fx.run(() => captureOutput(() => installHooks({ cwd: fx.repo })));

    const hookPath = join(fx.home, "hooks", "pre-commit");
    const rc = fx.run(() => {
      try {
        execFileSync("bash", [hookPath], {
          cwd: fx.repo,
          env: { ...process.env, PATH: `${binDir}:${process.env["PATH"]}` },
          stdio: ["ignore", "pipe", "pipe"],
        });
        return 0;
      } catch (err) {
        return (err as { status?: number }).status ?? 1;
      }
    });

    assert.equal(rc, 0);
    assert.ok(existsSync(marker), "the chained hook must have run");
  });

  it("chained hook's exit 0 does NOT mask a repo-aegis non-zero exit", () => {
    const fx = makeFixture("chain-does-not-mask");
    const binDir = join(fx.base, "bin");
    stubRepoAegis(binDir, 1); // repo-aegis reports a hit
    const marker = join(fx.base, "chained-marker");
    writeChainedHook(join(fx.repo, ".git", "hooks"), "pre-commit", 0, marker); // chained would say "fine"

    fx.run(() => captureOutput(() => installHooks({ cwd: fx.repo })));

    const hookPath = join(fx.home, "hooks", "pre-commit");
    const rc = fx.run(() => {
      try {
        execFileSync("bash", [hookPath], {
          cwd: fx.repo,
          env: { ...process.env, PATH: `${binDir}:${process.env["PATH"]}` },
          stdio: ["ignore", "pipe", "pipe"],
        });
        return 0;
      } catch (err) {
        return (err as { status?: number }).status ?? 1;
      }
    });

    assert.notEqual(rc, 0, "a repo-aegis hit must still block");
    assert.ok(!existsSync(marker), "the chained hook must never have run");
  });

  it("no infinite recursion when core.hooksPath resolves to the repo's own .git/hooks", () => {
    const fx = makeFixture("chain-self-recursion");
    const binDir = join(fx.base, "bin");
    stubRepoAegis(binDir, 0);

    // The footgun scenario itself: install repo-aegis's own hooks
    // DIRECTLY into the repo's real .git/hooks and point
    // core.hooksPath at that same directory, so the chain target and
    // the running script are the exact same file.
    fx.run(() => captureOutput(() => installHooks({ cwd: fx.repo })));
    const realHooksDir = join(fx.repo, ".git", "hooks");
    const installed = readFileSync(join(fx.home, "hooks", "pre-commit"), "utf8");
    writeFileSync(join(realHooksDir, "pre-commit"), installed, { mode: 0o755 });
    chmodSync(join(realHooksDir, "pre-commit"), 0o755);
    fx.run(() =>
      execFileSync("git", ["config", "--global", "core.hooksPath", realHooksDir], { cwd: fx.repo }),
    );

    const rc = fx.run(() => {
      try {
        execFileSync("bash", [join(realHooksDir, "pre-commit")], {
          cwd: fx.repo,
          env: { ...process.env, PATH: `${binDir}:${process.env["PATH"]}` },
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 5000,
        });
        return 0;
      } catch (err) {
        return (err as { status?: number; signal?: string }).status ?? 1;
      }
    });

    // Terminates (no hang/timeout kill) and behaves like a plain,
    // unchained run: repo-aegis passed, nothing to chain to that isn't
    // itself, exit 0.
    assert.equal(rc, 0);
  });
});
