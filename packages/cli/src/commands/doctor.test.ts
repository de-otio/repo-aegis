// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { doctor } from "./doctor.js";
import { HOOK_SCRIPTS } from "@de-otio/repo-aegis-core";

// SAFETY: every case below runs against throwaway repos under a
// per-case temp scan root, with GIT_CONFIG_GLOBAL/SYSTEM redirected to
// files under that same temp dir and REPO_AEGIS_HOME redirected to a
// temp "home". No test reads or writes the real ~/.config/repo-aegis,
// real global git config, or real system git config. `--fix --yes`
// only ever runs against repos created inside this temp tree — never
// call `git config --global` or point `--fix` outside a temp dir.

let root: string;

before(() => {
  root = mkdtempSync(join(tmpdir(), "repo-aegis-doctor-"));
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

interface Fixture {
  base: string;
  scanRoot: string;
  home: string;
  run: <T>(fn: () => T) => T;
}

function makeFixture(name: string): Fixture {
  const base = join(root, name);
  const scanRoot = join(base, "scan-root");
  const home = join(base, "home");
  const globalConfig = join(base, "gitconfig-global");
  mkdirSync(scanRoot, { recursive: true });
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

  return { base, scanRoot, home, run };
}

function initRepo(dir: string, fx: Fixture): void {
  mkdirSync(dir, { recursive: true });
  fx.run(() => {
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "test"], { cwd: dir });
  });
}

function gitConfig(dir: string, fx: Fixture, args: string[]): void {
  fx.run(() => execFileSync("git", ["config", ...args], { cwd: dir }));
}

function readLocalConfig(dir: string, fx: Fixture, key: string): string | null {
  try {
    return fx
      .run(() =>
        execFileSync("git", ["config", "--local", "--get", key], { cwd: dir, encoding: "utf8" }),
      )
      .trim();
  } catch {
    return null;
  }
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

function expectedHooksDir(fx: Fixture): string {
  return join(fx.home, "hooks");
}

// Silences emitJson/emitText during tests that don't inspect stdout, and
// captures it for tests that do (the JSON-shape assertions).
function captureStdout<T>(fn: () => T): { result: T; stdout: string } {
  const chunks: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stdout as any).write = (chunk: any) => {
    chunks.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
    return true;
  };
  try {
    const result = fn();
    return { result, stdout: chunks.join("") };
  } finally {
    process.stdout.write = orig;
  }
}

/** doctor() calls process.exit() when it finds failures. Intercept it
 * so the test process itself doesn't die; capture the code instead. */
function runDoctorCapturingExit(fn: () => void): number | undefined {
  const origExit = process.exit;
  let code: number | undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process as any).exit = (c?: number) => {
    code = c;
    // Throw to unwind exactly like a real process.exit would stop
    // further execution, without actually killing the test runner.
    throw new DoctorExitSignal();
  };
  try {
    fn();
  } catch (err) {
    if (!(err instanceof DoctorExitSignal)) throw err;
  } finally {
    process.exit = origExit;
  }
  return code;
}

class DoctorExitSignal extends Error {}

describe("doctor", () => {
  it("two repos, one healthy one with a local override shadowing a correct global -> one failure, exit 1, names the failing tree", () => {
    const fx = makeFixture("basic");

    const healthyDir = join(fx.scanRoot, "healthy-repo");
    initRepo(healthyDir, fx);
    const hooksDir = expectedHooksDir(fx);
    writeCorrectHooks(hooksDir);
    gitConfig(healthyDir, fx, ["core.hooksPath", hooksDir]);

    const brokenDir = join(fx.scanRoot, "broken-repo");
    initRepo(brokenDir, fx);
    // The incident: correct global, shadowed by an empty local override.
    gitConfig(brokenDir, fx, ["--global", "core.hooksPath", hooksDir]);
    const emptyDir = join(fx.base, "empty-hooks");
    mkdirSync(emptyDir, { recursive: true });
    gitConfig(brokenDir, fx, ["core.hooksPath", emptyDir]);

    let exitCode: number | undefined;
    const { stdout } = captureStdout(() => {
      exitCode = runDoctorCapturingExit(() =>
        fx.run(() => doctor({ scanRoot: [fx.scanRoot] })),
      );
    });

    assert.equal(exitCode, 1);
    assert.match(stdout, /broken-repo/);
    assert.doesNotMatch(stdout, /healthy-repo/);
  });

  it("all-healthy fleet -> exit 0 (no process.exit call), reports clean", () => {
    const fx = makeFixture("all-healthy");
    const hooksDir = expectedHooksDir(fx);
    writeCorrectHooks(hooksDir);

    const dir = join(fx.scanRoot, "only-repo");
    initRepo(dir, fx);
    gitConfig(dir, fx, ["core.hooksPath", hooksDir]);

    const exitCode = runDoctorCapturingExit(() => fx.run(() => doctor({ scanRoot: [fx.scanRoot] })));
    assert.equal(exitCode, undefined);
  });

  it("--fix without --yes mutates nothing and says so", () => {
    const fx = makeFixture("fix-dry-run");
    const hooksDir = expectedHooksDir(fx);
    writeCorrectHooks(hooksDir);

    const dir = join(fx.scanRoot, "broken-repo");
    initRepo(dir, fx);
    gitConfig(dir, fx, ["--global", "core.hooksPath", hooksDir]);
    const emptyDir = join(fx.base, "empty-hooks");
    mkdirSync(emptyDir, { recursive: true });
    gitConfig(dir, fx, ["core.hooksPath", emptyDir]);

    const before = readLocalConfig(dir, fx, "core.hooksPath");
    assert.equal(before, emptyDir);

    let exitCode: number | undefined;
    const { stdout } = captureStdout(() => {
      exitCode = runDoctorCapturingExit(() =>
        fx.run(() => doctor({ scanRoot: [fx.scanRoot], fix: true })),
      );
    });

    const after = readLocalConfig(dir, fx, "core.hooksPath");
    assert.equal(after, emptyDir, "local override must be unchanged after --fix without --yes");
    assert.equal(exitCode, 1);
    assert.match(stdout, /would fix/);
  });

  it("--fix --yes unsets the local override, and a re-run then passes", () => {
    const fx = makeFixture("fix-apply");
    const hooksDir = expectedHooksDir(fx);
    writeCorrectHooks(hooksDir);

    const dir = join(fx.scanRoot, "broken-repo");
    initRepo(dir, fx);
    gitConfig(dir, fx, ["--global", "core.hooksPath", hooksDir]);
    const emptyDir = join(fx.base, "empty-hooks");
    mkdirSync(emptyDir, { recursive: true });
    gitConfig(dir, fx, ["core.hooksPath", emptyDir]);

    runDoctorCapturingExit(() => fx.run(() => doctor({ scanRoot: [fx.scanRoot], fix: true, yes: true })));

    const after = readLocalConfig(dir, fx, "core.hooksPath");
    assert.equal(after, null, "local override must be unset after --fix --yes");

    // Re-run: the repo now resolves through the correct global value,
    // so the fleet is clean and doctor does not call process.exit.
    const exitCode = runDoctorCapturingExit(() => fx.run(() => doctor({ scanRoot: [fx.scanRoot] })));
    assert.equal(exitCode, undefined);
  });

  it("repo with its own executable .git/hooks/pre-commit while a foreign (correct) global hooksPath is set -> reported as shadowed", () => {
    const fx = makeFixture("shadowed");
    const hooksDir = expectedHooksDir(fx);
    writeCorrectHooks(hooksDir);

    const dir = join(fx.scanRoot, "shadow-repo");
    initRepo(dir, fx);
    gitConfig(dir, fx, ["--global", "core.hooksPath", hooksDir]);

    const realHooks = join(dir, ".git", "hooks");
    mkdirSync(realHooks, { recursive: true });
    const shadowed = join(realHooks, "pre-commit");
    writeFileSync(shadowed, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    chmodSync(shadowed, 0o755);

    let exitCode: number | undefined;
    const { stdout } = captureStdout(() => {
      exitCode = runDoctorCapturingExit(() =>
        fx.run(() => doctor({ scanRoot: [fx.scanRoot] })),
      );
    });

    assert.equal(exitCode, 1);
    assert.match(stdout, /shadow-repo/);
    assert.match(stdout, /shadowed \.git\/hooks scripts: pre-commit/);
  });

  it("--json shape: action, dryRun, roots, results[], summary", () => {
    const fx = makeFixture("json-shape");
    const hooksDir = expectedHooksDir(fx);
    writeCorrectHooks(hooksDir);

    const healthyDir = join(fx.scanRoot, "healthy-repo");
    initRepo(healthyDir, fx);
    gitConfig(healthyDir, fx, ["core.hooksPath", hooksDir]);

    const brokenDir = join(fx.scanRoot, "broken-repo");
    initRepo(brokenDir, fx);
    const emptyDir = join(fx.base, "empty-hooks");
    mkdirSync(emptyDir, { recursive: true });
    gitConfig(brokenDir, fx, ["core.hooksPath", emptyDir]);

    // captureStdout must be the OUTER wrapper: doctor() calls
    // process.exit(1) after emitJson has already written to stdout, and
    // runDoctorCapturingExit turns that into a thrown DoctorExitSignal.
    // If capture were the inner wrapper, that throw would unwind past
    // the point where captureStdout returns its captured chunks.
    const { stdout } = captureStdout(() => {
      runDoctorCapturingExit(() => fx.run(() => doctor({ scanRoot: [fx.scanRoot], json: true })));
    });

    const parsed = JSON.parse(stdout) as {
      action: string;
      dryRun: boolean;
      roots: string[];
      results: Array<{
        workingTree: string;
        code: string;
        ok: boolean;
        effectivePath: string | null;
        shadowedRepoHooks: string[];
        fixed: boolean;
      }>;
      summary: { scanned: number; failed: number; fixed: number };
    };

    assert.equal(parsed.action, "doctor");
    assert.equal(parsed.dryRun, true);
    assert.deepEqual(parsed.roots, [fx.scanRoot]);
    assert.equal(parsed.results.length, 1);
    const r = parsed.results[0]!;
    assert.match(r.workingTree, /broken-repo$/);
    assert.equal(r.ok, false);
    assert.equal(r.fixed, false);
    assert.deepEqual(r.shadowedRepoHooks, []);
    assert.equal(typeof r.code, "string");
    assert.equal(parsed.summary.scanned, 2);
    assert.equal(parsed.summary.failed, 1);
    assert.equal(parsed.summary.fixed, 0);
  });
});
