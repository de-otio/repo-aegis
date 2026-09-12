// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { execFileSync } from "node:child_process";
import { doctor } from "./doctor.js";
import { withEnv } from "../_test-utils.js";
import { HOOK_SCRIPTS, destinationCachePath, readDestinationCache } from "@de-otio/repo-aegis-core";
import { GH_SHIM_SCRIPT } from "./shim-script.js";

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
  /** The temp file GIT_CONFIG_GLOBAL points at — the "machine" git config
   * under test for PUSH_DEFAULT_IMPLICIT. Never the developer's real one. */
  globalConfig: string;
  /** A temp Claude Code home; `settings.json` there carries the guard hook unless `guardHook: false`. */
  claudeHome: string;
  run: <T>(fn: () => T) => T;
}

interface FixtureOptions {
  /** Install the `gh` shim into `<home>/bin` and put it first on PATH (default true). */
  shim?: boolean;
  /** Register `repo-aegis hook guard-egress` in the temp Claude home (default true). */
  guardHook?: boolean;
}

function makeFixture(
  name: string,
  extraEnv: Record<string, string> = {},
  fxOpts: FixtureOptions = {},
): Fixture {
  const base = join(root, name);
  const scanRoot = join(base, "scan-root");
  const home = join(base, "home");
  const globalConfig = join(base, "gitconfig-global");
  const claudeHome = join(base, "claude-home");
  mkdirSync(scanRoot, { recursive: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(claudeHome, { recursive: true });

  // The machine-level egress checks (SHIM_MISSING / SHIM_NOT_FIRST /
  // GUARD_HOOK_UNREGISTERED) are satisfied by default so that every other
  // case tests what it says it tests; the two cases that want them to fire
  // opt out. Nothing here touches the real ~/.claude or the real PATH.
  const binDir = join(home, "bin");
  if (fxOpts.shim !== false) {
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, "gh"), GH_SHIM_SCRIPT, { mode: 0o755 });
    chmodSync(join(binDir, "gh"), 0o755);
  }
  if (fxOpts.guardHook !== false) {
    writeFileSync(
      join(claudeHome, "settings.json"),
      JSON.stringify({
        hooks: {
          PreToolUse: [
            { matcher: "Bash", hooks: [{ type: "command", command: "repo-aegis hook guard-egress --agent claude" }] },
          ],
        },
      }),
    );
  }

  const overrides: Record<string, string> = {
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: globalConfig,
    REPO_AEGIS_HOME: home,
    PATH: `${binDir}${delimiter}${process.env["PATH"] ?? ""}`,
    ...extraEnv,
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

  return { base, scanRoot, home, globalConfig, claudeHome, run };
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

// Every case in this block is about hook LIVENESS, so it passes
// `egressChecks: false`. Without it PUSH_DEFAULT_IMPLICIT fires in all of
// them — the fixture's GIT_CONFIG_GLOBAL is a fresh temp file, which by
// definition has no `push.default` — and the "all clean" assertions would be
// asserting the wrong thing. The egress checks get their own block below.
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
        fx.run(() => doctor({ scanRoot: [fx.scanRoot], egressChecks: false })),
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

    const exitCode = runDoctorCapturingExit(() => fx.run(() => doctor({ scanRoot: [fx.scanRoot], egressChecks: false })));
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
        fx.run(() => doctor({ scanRoot: [fx.scanRoot], egressChecks: false, fix: true })),
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

    runDoctorCapturingExit(() => fx.run(() => doctor({ scanRoot: [fx.scanRoot], egressChecks: false, fix: true, yes: true })));

    const after = readLocalConfig(dir, fx, "core.hooksPath");
    assert.equal(after, null, "local override must be unset after --fix --yes");

    // Re-run: the repo now resolves through the correct global value,
    // so the fleet is clean and doctor does not call process.exit.
    const exitCode = runDoctorCapturingExit(() => fx.run(() => doctor({ scanRoot: [fx.scanRoot], egressChecks: false })));
    assert.equal(exitCode, undefined);
  });

  // A displaced pre-commit is CHAINED by the generated script, so it still
  // runs. Reporting it as a failure would make `doctor` exit 1 forever on a
  // healthy fleet — which is the "guard that fires when it shouldn't" failure
  // this release exists to remove. Regression test for that over-report.
  it("repo whose only repo-local hook is a pre-commit -> NOT reported (chaining runs it)", () => {
    const fx = makeFixture("shadowed-chained");
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
        fx.run(() => doctor({ scanRoot: [fx.scanRoot], egressChecks: false })),
      );
    });

    assert.equal(exitCode, undefined, "a chained pre-commit must not fail the sweep");
    assert.doesNotMatch(stdout, /shadow-repo/);
  });

  // The other half of the same rule: hook types repo-aegis does not install
  // are genuinely lost to the redirect and must still be reported.
  it("repo with a repo-local commit-msg hook -> reported (we do not chain that type)", () => {
    const fx = makeFixture("shadowed-bypassed");
    const hooksDir = expectedHooksDir(fx);
    writeCorrectHooks(hooksDir);

    const dir = join(fx.scanRoot, "bypassed-repo");
    initRepo(dir, fx);
    gitConfig(dir, fx, ["--global", "core.hooksPath", hooksDir]);

    const realHooks = join(dir, ".git", "hooks");
    mkdirSync(realHooks, { recursive: true });
    const bypassed = join(realHooks, "commit-msg");
    writeFileSync(bypassed, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    chmodSync(bypassed, 0o755);

    let exitCode: number | undefined;
    const { stdout } = captureStdout(() => {
      exitCode = runDoctorCapturingExit(() =>
        fx.run(() => doctor({ scanRoot: [fx.scanRoot], egressChecks: false })),
      );
    });

    assert.equal(exitCode, 1);
    assert.match(stdout, /bypassed-repo/);
    assert.match(stdout, /repo-local hooks that never run: commit-msg/);
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
      runDoctorCapturingExit(() => fx.run(() => doctor({ scanRoot: [fx.scanRoot], egressChecks: false, json: true })));
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

// ---------------------------------------------------------------------------
// Egress-guard checks (doc/design/egress-guard.md §7)
//
// Placeholder orgs only (`acme`, `example`): this repository is public and the
// deny-set it ships is exactly about names like these not being real ones.
// ---------------------------------------------------------------------------

/** Writes the fixture's global git config so `push.default` is `nothing`. */
function writeGlobalPushDefaultNothing(fx: Fixture): void {
  writeFileSync(fx.globalConfig, "[push]\n\tdefault = nothing\n");
}

/** Writes a registry YAML under the fixture and returns its path. */
function writeRegistry(fx: Fixture, body: string): string {
  const path = join(fx.base, "engagements.yaml");
  writeFileSync(path, body);
  return path;
}

const REGISTRY_NO_ACME = `\
always_block: []
personalOrgs:
  - example
engagements:
  - id: customer-a
    name: Customer A
    markers:
      - customer-a-marker
`;

const REGISTRY_WITH_ACME = `\
always_block: []
personalOrgs:
  - acme
engagements:
  - id: customer-a
    name: Customer A
    markers:
      - customer-a-marker
`;

/** A repo whose hooks are healthy, so anything doctor reports about it comes
 * from the egress checks and not from the liveness sweep. */
function healthyRepo(fx: Fixture, name: string): string {
  const dir = join(fx.scanRoot, name);
  initRepo(dir, fx);
  const hooksDir = expectedHooksDir(fx);
  writeCorrectHooks(hooksDir);
  gitConfig(dir, fx, ["core.hooksPath", hooksDir]);
  return dir;
}

describe("doctor — egress checks: PUSH_DEFAULT_IMPLICIT", () => {
  it("fires when the GLOBAL push.default is unset, and prints the one-line fix", () => {
    const fx = makeFixture("push-default-unset");
    healthyRepo(fx, "repo-a"); // no remote: contributes no per-repo checks

    let exitCode: number | undefined;
    const { stdout } = captureStdout(() => {
      exitCode = runDoctorCapturingExit(() => fx.run(() => doctor({ scanRoot: [fx.scanRoot], claudeHome: fx.claudeHome })));
    });

    assert.equal(exitCode, 1, "an implicit push.default must fail the sweep");
    assert.match(stdout, /FAIL PUSH_DEFAULT_IMPLICIT/);
    assert.match(stdout, /fix: git config --global push\.default nothing/);
  });

  it("is clean when the GLOBAL push.default is `nothing`", () => {
    const fx = makeFixture("push-default-nothing");
    writeGlobalPushDefaultNothing(fx);
    healthyRepo(fx, "repo-a");

    let exitCode: number | undefined;
    const { stdout } = captureStdout(() => {
      exitCode = runDoctorCapturingExit(() => fx.run(() => doctor({ scanRoot: [fx.scanRoot], claudeHome: fx.claudeHome })));
    });

    assert.equal(exitCode, undefined);
    assert.doesNotMatch(stdout, /PUSH_DEFAULT_IMPLICIT/);
    assert.match(stdout, /all clean/);
  });

  it("reads the GLOBAL scope only: a repo-local push.default=nothing does not satisfy it", () => {
    const fx = makeFixture("push-default-local-only");
    const dir = healthyRepo(fx, "repo-a");
    gitConfig(dir, fx, ["push.default", "nothing"]);

    let exitCode: number | undefined;
    const { stdout } = captureStdout(() => {
      exitCode = runDoctorCapturingExit(() => fx.run(() => doctor({ scanRoot: [fx.scanRoot], claudeHome: fx.claudeHome })));
    });

    assert.equal(exitCode, 1);
    assert.match(stdout, /FAIL PUSH_DEFAULT_IMPLICIT/);
  });

  it("--no-egress-checks (egressChecks: false) runs none of them", () => {
    const fx = makeFixture("egress-checks-off");
    // Global push.default unset AND an unclassified repo with a GitHub
    // remote: three checks would fire if they ran at all.
    const dir = healthyRepo(fx, "repo-a");
    gitConfig(dir, fx, ["remote.origin.url", "git@github.com:acme/x.git"]);

    let exitCode: number | undefined;
    const { stdout } = captureStdout(() => {
      exitCode = runDoctorCapturingExit(() =>
        fx.run(() => doctor({ scanRoot: [fx.scanRoot], egressChecks: false })),
      );
    });

    assert.equal(exitCode, undefined);
    assert.doesNotMatch(stdout, /PUSH_DEFAULT_IMPLICIT|CLASS_VISIBILITY_UNRESOLVED|PERSONAL_ORG_UNREGISTERED/);
  });
});

describe("doctor — egress checks: per-repo", () => {
  it("CLASS_VISIBILITY_UNRESOLVED: a hook-healthy repo with a GitHub remote but no class is now listed", () => {
    const fx = makeFixture("class-unresolved", {});
    writeGlobalPushDefaultNothing(fx);
    const dir = healthyRepo(fx, "unclassified-repo");
    gitConfig(dir, fx, ["remote.origin.url", "git@github.com:acme/x.git"]);

    let exitCode: number | undefined;
    const { stdout } = captureStdout(() => {
      exitCode = runDoctorCapturingExit(() => fx.run(() => doctor({ scanRoot: [fx.scanRoot], claudeHome: fx.claudeHome })));
    });

    assert.equal(exitCode, 1);
    assert.match(stdout, /unclassified-repo/);
    assert.match(stdout, /FAIL CLASS_VISIBILITY_UNRESOLVED/);
    assert.match(stdout, /fix: repo-aegis classify --apply/);
  });

  it("CLASS_VISIBILITY_UNRESOLVED is clean once class and cached visibility are both set", () => {
    const fx = makeFixture("class-resolved");
    writeGlobalPushDefaultNothing(fx);
    const registryPath = writeRegistry(fx, REGISTRY_WITH_ACME);
    const dir = healthyRepo(fx, "classified-repo");
    gitConfig(dir, fx, ["remote.origin.url", "git@github.com:acme/x.git"]);
    gitConfig(dir, fx, ["repo-aegis.class", "public-eligible"]);
    gitConfig(dir, fx, ["repo-aegis.visibility", "public"]);

    let exitCode: number | undefined;
    const { stdout } = captureStdout(() => {
      exitCode = runDoctorCapturingExit(() =>
        withEnv("REPO_AEGIS_REGISTRY", registryPath, () =>
          fx.run(() => doctor({ scanRoot: [fx.scanRoot], claudeHome: fx.claudeHome })),
        ),
      );
    });

    assert.equal(exitCode, undefined);
    assert.match(stdout, /all clean/);
  });

  it("the sweep records every checkout with a GitHub origin into the destination cache", () => {
    const fx = makeFixture("destination-cache");
    writeGlobalPushDefaultNothing(fx);
    const registryPath = writeRegistry(fx, REGISTRY_WITH_ACME);
    const pub = healthyRepo(fx, "pub-repo");
    gitConfig(pub, fx, ["remote.origin.url", "git@github.com:acme/pub.git"]);
    gitConfig(pub, fx, ["repo-aegis.class", "public-eligible"]);
    gitConfig(pub, fx, ["repo-aegis.visibility", "public"]);
    healthyRepo(fx, "no-remote-repo"); // nothing to key on: not recorded

    let exitCode: number | undefined;
    const { stdout } = captureStdout(() => {
      exitCode = runDoctorCapturingExit(() =>
        withEnv("REPO_AEGIS_REGISTRY", registryPath, () =>
          fx.run(() => doctor({ scanRoot: [fx.scanRoot], claudeHome: fx.claudeHome })),
        ),
      );
    });

    assert.equal(exitCode, undefined);
    assert.match(stdout, /recorded 1 checkout\(s\) into the destination cache/);
    const cache = readDestinationCache(destinationCachePath(fx.home));
    assert.deepEqual(Object.keys(cache.repos), ["acme/pub"]);
    assert.equal(cache.repos["acme/pub"]?.workingTree, pub);
    assert.equal(cache.repos["acme/pub"]?.visibility, "public");
    // And --json carries the count.
    const { stdout: json } = captureStdout(() =>
      runDoctorCapturingExit(() =>
        withEnv("REPO_AEGIS_REGISTRY", registryPath, () =>
          fx.run(() => doctor({ scanRoot: [fx.scanRoot], claudeHome: fx.claudeHome, json: true })),
        ),
      ),
    );
    assert.equal((JSON.parse(json) as { summary: { destinationsRecorded: number } }).summary.destinationsRecorded, 1);
  });

  it("CLASS_VISIBILITY_UNRESOLVED still fires when the class is explicit but visibility is uncached", () => {
    const fx = makeFixture("class-explicit-vis-unknown");
    writeGlobalPushDefaultNothing(fx);
    const registryPath = writeRegistry(fx, REGISTRY_WITH_ACME);
    const dir = healthyRepo(fx, "half-classified-repo");
    gitConfig(dir, fx, ["remote.origin.url", "git@github.com:acme/x.git"]);
    gitConfig(dir, fx, ["repo-aegis.class", "public-eligible"]);

    let exitCode: number | undefined;
    const { stdout } = captureStdout(() => {
      exitCode = runDoctorCapturingExit(() =>
        withEnv("REPO_AEGIS_REGISTRY", registryPath, () =>
          fx.run(() => doctor({ scanRoot: [fx.scanRoot], claudeHome: fx.claudeHome })),
        ),
      );
    });

    assert.equal(exitCode, 1);
    assert.match(stdout, /FAIL CLASS_VISIBILITY_UNRESOLVED/);
  });

  it("a repo with NO GitHub remote gets no per-repo checks at all", () => {
    const fx = makeFixture("no-remote");
    writeGlobalPushDefaultNothing(fx);
    healthyRepo(fx, "local-only-repo"); // never gets a remote

    let exitCode: number | undefined;
    const { stdout } = captureStdout(() => {
      exitCode = runDoctorCapturingExit(() => fx.run(() => doctor({ scanRoot: [fx.scanRoot], claudeHome: fx.claudeHome })));
    });

    assert.equal(exitCode, undefined);
    assert.doesNotMatch(stdout, /local-only-repo/);
  });

  it("PERSONAL_ORG_UNREGISTERED fires when the remote org is in neither personalOrgs nor any engagement, and names the org only in `fix`", () => {
    const fx = makeFixture("org-unregistered");
    writeGlobalPushDefaultNothing(fx);
    const registryPath = writeRegistry(fx, REGISTRY_NO_ACME);
    const dir = healthyRepo(fx, "foreign-org-repo");
    gitConfig(dir, fx, ["remote.origin.url", "git@github.com:acme/x.git"]);
    gitConfig(dir, fx, ["repo-aegis.class", "private-strict"]);
    gitConfig(dir, fx, ["repo-aegis.visibility", "private"]);

    let exitCode: number | undefined;
    const { stdout } = captureStdout(() => {
      exitCode = runDoctorCapturingExit(() =>
        withEnv("REPO_AEGIS_REGISTRY", registryPath, () =>
          fx.run(() => doctor({ scanRoot: [fx.scanRoot], claudeHome: fx.claudeHome })),
        ),
      );
    });

    assert.equal(exitCode, 1);
    assert.match(stdout, /FAIL PERSONAL_ORG_UNREGISTERED/);
    assert.match(stdout, /fix: repo-aegis engagements add --personal-org acme/);
    // The detail line must not carry the org — an unregistered org can be a
    // customer's, and `detail` is the line that gets copied into a ticket.
    const detailLine =
      stdout.split("\n").find(l => l.includes("FAIL PERSONAL_ORG_UNREGISTERED")) ?? "";
    assert.notEqual(detailLine, "", "expected a PERSONAL_ORG_UNREGISTERED detail line");
    assert.doesNotMatch(detailLine, /acme/);
  });

  it("PERSONAL_ORG_UNREGISTERED is clean when the org is in personalOrgs", () => {
    const fx = makeFixture("org-registered");
    writeGlobalPushDefaultNothing(fx);
    const registryPath = writeRegistry(fx, REGISTRY_WITH_ACME);
    const dir = healthyRepo(fx, "known-org-repo");
    gitConfig(dir, fx, ["remote.origin.url", "git@github.com:acme/x.git"]);
    gitConfig(dir, fx, ["repo-aegis.class", "public-eligible"]);
    gitConfig(dir, fx, ["repo-aegis.visibility", "public"]);

    let exitCode: number | undefined;
    const { stdout } = captureStdout(() => {
      exitCode = runDoctorCapturingExit(() =>
        withEnv("REPO_AEGIS_REGISTRY", registryPath, () =>
          fx.run(() => doctor({ scanRoot: [fx.scanRoot], claudeHome: fx.claudeHome })),
        ),
      );
    });

    assert.equal(exitCode, undefined);
    assert.doesNotMatch(stdout, /PERSONAL_ORG_UNREGISTERED/);
  });

  it("an unreadable registry skips PERSONAL_ORG_UNREGISTERED rather than reporting it", () => {
    const fx = makeFixture("registry-missing");
    writeGlobalPushDefaultNothing(fx);
    const dir = healthyRepo(fx, "no-registry-repo");
    gitConfig(dir, fx, ["remote.origin.url", "git@github.com:acme/x.git"]);
    gitConfig(dir, fx, ["repo-aegis.class", "private-strict"]);
    gitConfig(dir, fx, ["repo-aegis.visibility", "private"]);

    let exitCode: number | undefined;
    const { stdout } = captureStdout(() => {
      exitCode = runDoctorCapturingExit(() =>
        withEnv("REPO_AEGIS_REGISTRY", join(fx.base, "no-such-registry.yaml"), () =>
          fx.run(() => doctor({ scanRoot: [fx.scanRoot], claudeHome: fx.claudeHome })),
        ),
      );
    });

    assert.equal(exitCode, undefined, "a guardrail must not block on missing context");
    assert.doesNotMatch(stdout, /PERSONAL_ORG_UNREGISTERED/);
  });
});

describe("doctor — egress checks: JSON shape", () => {
  it("--json gains `machine` and a per-repo `checks` array", () => {
    const fx = makeFixture("egress-json");
    const registryPath = writeRegistry(fx, REGISTRY_NO_ACME);
    const dir = healthyRepo(fx, "unclassified-repo");
    gitConfig(dir, fx, ["remote.origin.url", "git@github.com:acme/x.git"]);

    const { stdout } = captureStdout(() => {
      runDoctorCapturingExit(() =>
        withEnv("REPO_AEGIS_REGISTRY", registryPath, () =>
          fx.run(() => doctor({ scanRoot: [fx.scanRoot], claudeHome: fx.claudeHome, json: true })),
        ),
      );
    });

    const parsed = JSON.parse(stdout) as {
      machine: Array<{ code: string; ok: boolean; detail: string; fix?: string }>;
      results: Array<{
        workingTree: string;
        ok: boolean;
        checks: Array<{ code: string; ok: boolean; detail: string; fix?: string }>;
      }>;
      summary: { scanned: number; failed: number; fixed: number };
    };

    const pushDefault = parsed.machine.find(c => c.code === "PUSH_DEFAULT_IMPLICIT");
    assert.ok(pushDefault, "machine[] must carry PUSH_DEFAULT_IMPLICIT");
    assert.equal(pushDefault.ok, false);
    assert.equal(pushDefault.fix, "git config --global push.default nothing");

    assert.equal(parsed.results.length, 1);
    const r = parsed.results[0]!;
    assert.match(r.workingTree, /unclassified-repo$/);
    // Hook liveness is fine here; it is listed purely for the egress checks.
    assert.equal(r.ok, true);
    assert.deepEqual(
      r.checks.map(c => c.code).sort(),
      ["CLASS_VISIBILITY_UNRESOLVED", "PERSONAL_ORG_UNREGISTERED"],
    );
    assert.ok(r.checks.every(c => !c.ok));

    // 1 machine failure + 1 repo carrying failing checks.
    assert.equal(parsed.summary.failed, 2);
  });
});

describe("doctor — egress checks: shim and guard hook", () => {
  it("SHIM_MISSING fires when <home>/bin/gh is absent", () => {
    const fx = makeFixture("shim-missing", {}, { shim: false });
    writeGlobalPushDefaultNothing(fx);
    healthyRepo(fx, "repo-a");

    let exitCode: number | undefined;
    const { stdout } = captureStdout(() => {
      exitCode = runDoctorCapturingExit(() =>
        fx.run(() => doctor({ scanRoot: [fx.scanRoot], claudeHome: fx.claudeHome })),
      );
    });

    assert.equal(exitCode, 1);
    assert.match(stdout, /FAIL SHIM_MISSING/);
    assert.match(stdout, /fix: repo-aegis install shim/);
    assert.doesNotMatch(stdout, /GUARD_HOOK_UNREGISTERED/);
  });

  it("GUARD_HOOK_UNREGISTERED fires when the Claude home has no guard-egress entry", () => {
    const fx = makeFixture("guard-unregistered", {}, { guardHook: false });
    writeGlobalPushDefaultNothing(fx);
    healthyRepo(fx, "repo-a");

    let exitCode: number | undefined;
    const { stdout } = captureStdout(() => {
      exitCode = runDoctorCapturingExit(() =>
        fx.run(() => doctor({ scanRoot: [fx.scanRoot], claudeHome: fx.claudeHome })),
      );
    });

    assert.equal(exitCode, 1);
    assert.match(stdout, /FAIL GUARD_HOOK_UNREGISTERED/);
    assert.match(stdout, /fix: repo-aegis install claude-md/);
    assert.doesNotMatch(stdout, /SHIM_MISSING/);
  });
});
