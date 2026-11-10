// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// `repo-aegis upgrade` (P1-H): a stale install, made the way doctor's own stale tests make one, goes through the
// real installers and `doctor` stops reporting it; a second run is a no-op; `--dry-run` changes nothing; an
// installer that needs a person is listed, not run, when none is at a terminal. Temp homes, temp git config,
// a simulated `sudo`; placeholder names only.
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectHookScripts, parsePinFromScript, pinnedHookCommand, type EnforcementPin } from "@de-otio/repo-aegis-core";
import { captureOutput, fakeGh, scrubGitEnv, type CaptureResult } from "../_test-utils.js";
import { makeFakeSystem, type FakeSystem } from "../_managed-test-utils.js";
import { currentEnforcementPin } from "../enforcement-pin.js";
import { lastVersionPath, readLastVersion } from "../version-notice.js";
import { doctor } from "./doctor.js";
import { explanationFor, loadDocs } from "./explain.js";
import { gitCredentialHelperStale } from "./doctor-git-credential-checks.js";
import { managedDropinStaleCheck } from "./doctor-managed-checks.js";
import { installClaudeMd } from "./install-claude-md.js";
import { writeHookScripts } from "./install-hooks.js";
import { checkShim } from "./install-shim.js";
import { managedPaths } from "./managed-dropin.js";
import { resolveManagedEnv } from "./managed-privileged.js";
import { parseTaaadPinFromScript, renderShimScript, SHIM_HEADER_LINE } from "./shim-script.js";
import { isEphemeralCli, upgrade, type UpgradeDeps, type UpgradeReport } from "./upgrade.js";

let tmp: string;
let n = 0;
let restoreGit: () => void;
const fakeSystems: FakeSystem[] = [];

before(() => {
  restoreGit = scrubGitEnv();
  tmp = mkdtempSync(join(tmpdir(), "repo-aegis-upgrade-"));
});
after(() => {
  for (const s of fakeSystems) rmSync(s.root, { recursive: true, force: true });
  restoreGit();
  rmSync(tmp, { recursive: true, force: true });
});

const VERSION = "9.9.9";
const NO_PERSON = { stderrIsTTY: false } as const;
const PERSON = { stderrIsTTY: true, stdinIsTTY: true, readAnswer: () => "y" } as const;

interface Fixture {
  base: string;
  home: string;
  scanRoot: string;
  userHome: string;
  claudeHome: string;
  globalConfig: string;
  /** Run `fn` with every environment variable the commands read pointed into this fixture. */
  run: <T>(fn: () => T) => T;
}

function makeFixture(): Fixture {
  const base = join(tmp, `case-${n++}`);
  const home = join(base, "home");
  const scanRoot = join(base, "scan-root");
  const userHome = join(base, "user-home");
  const claudeHome = join(base, "claude-home");
  const globalConfig = join(base, "gitconfig-global");
  for (const d of [home, scanRoot, userHome, claudeHome]) mkdirSync(d, { recursive: true });
  writeFileSync(globalConfig, "");
  const loggedOutGh = fakeGh(join(base, "gh-logged-out"), "exit 1");
  const env: Record<string, string> = {
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    REPO_AEGIS_HOME: home,
    HOME: userHome,
    PATH: `${join(home, "bin")}${delimiter}${loggedOutGh}${delimiter}${process.env["PATH"] ?? ""}`,
  };
  const unset = ["REPO_AEGIS_REGISTRY", "REPO_AEGIS_MARKERS_DIR"];
  const run = <T>(fn: () => T): T => {
    const prev = new Map<string, string | undefined>();
    for (const k of [...Object.keys(env), ...unset]) prev.set(k, process.env[k]);
    for (const [k, v] of Object.entries(env)) process.env[k] = v;
    for (const k of unset) delete process.env[k];
    try {
      return fn();
    } finally {
      for (const [k, v] of prev) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  };
  return { base, home, scanRoot, userHome, claudeHome, globalConfig, run };
}

/** The scripts an earlier release wrote: right names and modes, other contents. */
const OLD_HOOK = "#!/bin/sh\n# an earlier release\nexec true\n";
function writeStaleHooks(fx: Fixture): void {
  fx.run(() => writeHookScripts(join(fx.home, "hooks"), currentEnforcementPin()));
  for (const name of ["pre-commit", "pre-push"]) {
    const p = join(fx.home, "hooks", name);
    writeFileSync(p, OLD_HOOK, { mode: 0o755 });
    chmodSync(p, 0o755);
  }
}
function writeStaleShim(fx: Fixture): void {
  mkdirSync(join(fx.home, "bin"), { recursive: true });
  const p = join(fx.home, "bin", "gh");
  writeFileSync(p, `#!/usr/bin/env bash\n${SHIM_HEADER_LINE}\nexec gh "$@"\n`, { mode: 0o755 });
  chmodSync(p, 0o755);
}

/** A repo under the scan root whose local `core.hooksPath` is repo-aegis's hooks directory. */
function repoUsingHooks(fx: Fixture): void {
  const dir = join(fx.scanRoot, "some-repo");
  mkdirSync(dir, { recursive: true });
  fx.run(() => {
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
    execFileSync("git", ["config", "core.hooksPath", join(fx.home, "hooks")], { cwd: dir });
  });
}

interface DoctorJson {
  machine: Array<{ code: string; ok: boolean }>;
  results: Array<{ code: string; checks: Array<{ code: string; ok: boolean }> }>;
}
function doctorJson(fx: Fixture): DoctorJson {
  const out = fx.run(() =>
    captureOutput(() =>
      doctor({ scanRoot: [fx.scanRoot], json: true, claudeHome: fx.claudeHome, homeDir: fx.userHome, sshDir: join(fx.userHome, ".ssh"), readGlobalHooksPath: () => null }),
    ),
  );
  return JSON.parse(out.stdout) as DoctorJson;
}
const staleCodes = (d: DoctorJson): string[] => [
  ...d.machine.filter(c => !c.ok && c.code.endsWith("_STALE")).map(c => c.code),
  ...d.results.filter(r => r.code === "HOOKS_SCRIPT_STALE").map(r => r.code),
  ...d.results.flatMap(r => r.checks).filter(c => !c.ok && c.code.endsWith("_STALE")).map(c => c.code),
];

// `ephemeral: false` unless a test says otherwise: the build under test sits in a git worktree, which is exactly what
// the real check calls temporary.
function runUpgrade(fx: Fixture, over: { dryRun?: boolean; json?: boolean; force?: boolean; claudeHome?: string } = {}, deps: UpgradeDeps = {}): CaptureResult {
  return fx.run(() => captureOutput(() => void upgrade(over, { version: VERSION, terminal: NO_PERSON, ephemeral: false, ...deps })));
}

const snapshot = (fx: Fixture): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const rel of ["hooks/pre-commit", "hooks/pre-push", "bin/gh"]) {
    const p = join(fx.home, rel);
    out[rel] = existsSync(p) ? `${readFileSync(p, "utf8")}@${statSync(p).mtimeMs}` : "absent";
  }
  return out;
};

describe("upgrade: stale hooks and shim", () => {
  it("a stale fixture goes in, doctor shows no *_STALE after, and the second run is a no-op", () => {
    const fx = makeFixture();
    writeStaleHooks(fx);
    writeStaleShim(fx);
    repoUsingHooks(fx);

    // The fixture is stale the way doctor says it is, so the assertion below is about the fix.
    const before = doctorJson(fx);
    assert.deepEqual(staleCodes(before).sort(), ["HOOKS_SCRIPT_STALE", "SHIM_STALE"]);

    const first = runUpgrade(fx);
    assert.equal(first.exitCode, undefined, first.stderr);
    assert.match(first.stdout, /upgrade: hooks\s+done/);
    assert.match(first.stdout, /upgrade: shim\s+done/);
    assert.doesNotMatch(first.stdout, /nothing to upgrade/);
    assert.match(first.stdout, /next: repo-aegis doctor\n$/);

    assert.deepEqual(staleCodes(doctorJson(fx)), []);
    assert.equal(fx.run(() => checkShim()[0]?.ok), true);
    const state = inspectHookScripts(join(fx.home, "hooks"), currentEnforcementPin());
    assert.deepEqual([state["pre-commit"].current, state["pre-push"].current], [true, true]);

    const after = snapshot(fx);
    const second = runUpgrade(fx);
    assert.equal(second.exitCode, undefined, second.stderr);
    assert.match(second.stdout, /^nothing to upgrade\nnext: repo-aegis doctor\n$/);
    assert.deepEqual(snapshot(fx), after, "a second run rewrites nothing");
  });

  it("--dry-run changes nothing (files, mtimes, the version record) and says what it would do", () => {
    const fx = makeFixture();
    writeStaleHooks(fx);
    writeStaleShim(fx);
    const before = snapshot(fx);

    const dry = runUpgrade(fx, { dryRun: true });
    assert.equal(dry.exitCode, undefined, dry.stderr);
    assert.match(dry.stdout, /dry run/);
    assert.match(dry.stdout, /upgrade: hooks\s+would/);
    assert.match(dry.stdout, /upgrade: shim\s+would/);
    assert.deepEqual(snapshot(fx), before);
    assert.equal(existsSync(lastVersionPath(fx.home)), false, "a dry run does not record the version");

    // And it did not hide anything: the real run still finds both.
    const real = runUpgrade(fx);
    assert.match(real.stdout, /upgrade: hooks\s+done/);
    assert.match(real.stdout, /upgrade: shim\s+done/);
    assert.notDeepEqual(snapshot(fx), before);
  });

  it("never installs what was not installed: an empty home is nothing to upgrade and stays empty", () => {
    const fx = makeFixture();
    const out = runUpgrade(fx);
    assert.equal(out.exitCode, undefined, out.stderr);
    assert.equal(out.stdout, "nothing to upgrade\nnext: repo-aegis doctor\n");
    assert.equal(existsSync(join(fx.home, "hooks")), false);
    assert.equal(existsSync(join(fx.home, "bin")), false);
  });

  it("a hooks directory that is current is left alone, and one script missing next to a stale one is rewritten", () => {
    const fx = makeFixture();
    fx.run(() => writeHookScripts(join(fx.home, "hooks"), currentEnforcementPin()));
    const before = snapshot(fx);
    assert.match(runUpgrade(fx).stdout, /^nothing to upgrade/);
    assert.deepEqual(snapshot(fx), before);

    rmSync(join(fx.home, "hooks", "pre-push"));
    assert.match(runUpgrade(fx).stdout, /upgrade: hooks\s+done/);
    assert.equal(existsSync(join(fx.home, "hooks", "pre-push")), true);
  });

  it("an installer that fails is a failed step, exit 1, and the version is not recorded", () => {
    const fx = makeFixture();
    writeStaleHooks(fx);
    // A directory where pre-push should be: the rewrite cannot succeed.
    rmSync(join(fx.home, "hooks", "pre-push"));
    mkdirSync(join(fx.home, "hooks", "pre-push"));

    const out = runUpgrade(fx);
    assert.equal(out.exitCode, 1);
    assert.match(out.stdout, /upgrade: hooks\s+FAILED/);
    assert.equal(readLastVersion(fx.home), null);
  });

  it("the shim's taaad pin survives an upgrade run from a PATH that does not reach taaad", () => {
    const fx = makeFixture();
    const taaad = { launcher: "/opt/example/venv/bin/taaad", interpreter: "/usr/bin/python3", packageDir: "/opt/example/venv" };
    const old: EnforcementPin = { node: "/opt/example/old-node/bin/node", cli: "/opt/example/old/dist/index.js" };
    mkdirSync(join(fx.home, "bin"), { recursive: true });
    writeFileSync(join(fx.home, "bin", "gh"), renderShimScript(old, { home: fx.home, taaad }), { mode: 0o755 });
    chmodSync(join(fx.home, "bin", "gh"), 0o755);
    assert.equal(fx.run(() => checkShim()[0]?.code), "SHIM_STALE");

    // A PATH with no taaad on it (the developer's own may have one).
    const out = runUpgrade(fx, {}, { path: join(fx.base, "no-taaad-here") });
    assert.match(out.stdout, /upgrade: shim\s+done/);
    assert.deepEqual(parseTaaadPinFromScript(readFileSync(join(fx.home, "bin", "gh"), "utf8")), taaad);
    assert.equal(fx.run(() => checkShim()[0]?.ok), true);
  });

  it("--json: one object with a status per step, the next step, and the same exit code", () => {
    const fx = makeFixture();
    writeStaleHooks(fx);
    const out = runUpgrade(fx, { json: true });
    const report = JSON.parse(out.stdout) as UpgradeReport;
    assert.equal(report.action, "upgrade");
    assert.equal(report.next, "repo-aegis doctor");
    assert.deepEqual(
      report.steps.map(s => [s.step, s.status]),
      [
        ["hooks", "upgraded"],
        ["shim", "not-installed"],
        ["claude-md", "not-installed"],
        ["user-settings", "current"],
        ["git-credential", "current"],
      ],
    );
    assert.equal(report.nothingToUpgrade, false);
    assert.equal(report.refused, false);
  });

  it("a `gh` at <home>/bin that is not a repo-aegis shim is the person's: left alone, not a failure on every run", () => {
    const fx = makeFixture();
    mkdirSync(join(fx.home, "bin"), { recursive: true });
    writeFileSync(join(fx.home, "bin", "gh"), "#!/bin/sh\nexec /usr/bin/true\n", { mode: 0o755 });
    const out = runUpgrade(fx);
    assert.equal(out.exitCode, undefined, out.stderr);
    assert.match(out.stdout, /^nothing to upgrade/);
    assert.equal(readFileSync(join(fx.home, "bin", "gh"), "utf8"), "#!/bin/sh\nexec /usr/bin/true\n");
  });

  it("with no <home> at all it does nothing: nothing to upgrade, and the directory is not created", () => {
    const fx = makeFixture();
    const home = join(fx.base, "never-created");
    const out = fx.run(() => captureOutput(() => void upgrade({}, { version: VERSION, terminal: NO_PERSON, home })));
    assert.equal(out.exitCode, undefined, out.stderr);
    assert.match(out.stdout, /^nothing to upgrade/);
    assert.equal(existsSync(home), false);
  });

  it("records the version after a completed run (and only then)", () => {
    const fx = makeFixture();
    writeStaleHooks(fx);
    runUpgrade(fx);
    assert.equal(readLastVersion(fx.home), VERSION);
  });
});

// ---------------------------------------------------------------------------
// The two installers that need a person
// ---------------------------------------------------------------------------

function makePin(base: string): EnforcementPin {
  const pkg = join(base, "pin", "node_modules", "@de-otio", "repo-aegis");
  mkdirSync(join(pkg, "dist"), { recursive: true });
  const cli = join(pkg, "dist", "index.js");
  writeFileSync(cli, "// stub\n");
  mkdirSync(join(base, "pin", "bin"), { recursive: true });
  const node = join(base, "pin", "bin", "node");
  writeFileSync(node, "// stub\n", { mode: 0o755 });
  chmodSync(node, 0o755);
  return { node, cli };
}

interface ManagedCase {
  fx: Fixture;
  sys: FakeSystem;
  oldPin: EnforcementPin;
  newPin: EnforcementPin;
  file: string;
}

/** A managed drop-in installed for one pin, and a second pin that makes it stale. */
function staleDropIn(): ManagedCase {
  const fx = makeFixture();
  const sys = makeFakeSystem({ platform: "linux", uid: 1000 });
  fakeSystems.push(sys);
  const oldPin = makePin(join(fx.base, "old"));
  const newPin = makePin(join(fx.base, "new"));
  const out = fx.run(() => captureOutput(() => installClaudeMd({ claudeHome: fx.claudeHome, pin: oldPin, managed: { env: sys.env, terminal: PERSON } })));
  assert.equal(out.exitCode, undefined, out.stderr);
  sys.calls.length = 0;
  return { fx, sys, oldPin, newPin, file: managedPaths("linux", 1000)!.file };
}

const dropInText = (c: ManagedCase): string => readFileSync(c.sys.at(c.file), "utf8");
const dropInStale = (c: ManagedCase, pin: EnforcementPin): boolean =>
  c.fx.run(() => !managedDropinStaleCheck(resolveManagedEnv(c.sys.env), dropInText(c), pin).ok);

describe("upgrade: the managed drop-in (a root write behind a sudo password)", () => {
  it("without a person at a terminal it is listed under `run yourself:` with the exact command, and nothing runs as root", () => {
    const c = staleDropIn();
    const before = dropInText(c);
    assert.equal(dropInStale(c, c.newPin), true, "the fixture is stale");

    const out = runUpgrade(c.fx, {}, { pin: c.newPin, managedEnv: c.sys.env, terminal: NO_PERSON });
    assert.equal(out.exitCode, undefined, `listing is not a failure: ${out.stderr}`);
    assert.match(out.stdout, /upgrade: claude-md\s+needs you/);
    assert.match(out.stdout, /run yourself:\n {2}repo-aegis install claude-md\n/);
    assert.doesNotMatch(out.stdout, /nothing to upgrade/);
    assert.match(out.stdout, /next: repo-aegis doctor\n$/);
    assert.equal(c.sys.toolCalls().length, 0, "no sudo, no tee, no mv: the installer was not run");
    assert.equal(dropInText(c), before, "the drop-in is untouched");
    assert.equal(dropInStale(c, c.newPin), true, "and still stale");
  });

  it("--json lists it with the command and exits 0; --dry-run without a person lists it too", () => {
    const c = staleDropIn();
    const out = runUpgrade(c.fx, { json: true }, { pin: c.newPin, managedEnv: c.sys.env, terminal: NO_PERSON });
    assert.equal(out.exitCode, undefined);
    const report = JSON.parse(out.stdout) as UpgradeReport;
    assert.deepEqual(report.runYourself, [{ step: "claude-md", command: "repo-aegis install claude-md" }]);
    const dry = runUpgrade(c.fx, { dryRun: true }, { pin: c.newPin, managedEnv: c.sys.env, terminal: NO_PERSON });
    assert.match(dry.stdout, /run yourself:\n {2}repo-aegis install claude-md\n/);
    assert.equal(c.sys.toolCalls().length, 0);
  });

  it("a custom --claude-home is carried into the command the person is told to run", () => {
    const c = staleDropIn();
    const out = runUpgrade(c.fx, { claudeHome: c.fx.claudeHome }, { pin: c.newPin, managedEnv: c.sys.env, terminal: NO_PERSON });
    assert.match(out.stdout, new RegExp(`repo-aegis install claude-md --claude-home ${c.fx.claudeHome.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n`));
  });

  it("with a person at a terminal it runs the installer (their typed y still gates the write) and the drop-in is current", () => {
    const c = staleDropIn();
    const out = runUpgrade(c.fx, { claudeHome: c.fx.claudeHome }, { pin: c.newPin, managedEnv: c.sys.env, terminal: PERSON });
    assert.equal(out.exitCode, undefined, out.stderr);
    assert.match(out.stdout, /upgrade: claude-md\s+done/);
    assert.doesNotMatch(out.stdout, /run yourself/);
    assert.ok(c.sys.toolCalls().length > 0, "the root step ran");
    assert.equal(dropInStale(c, c.newPin), false);
    assert.equal(dropInStale(c, c.oldPin), true, "it was rewritten for the new pin");
    assert.match(runUpgrade(c.fx, {}, { pin: c.newPin, managedEnv: c.sys.env, terminal: NO_PERSON }).stdout, /^nothing to upgrade/, "and a re-run is a no-op");
  });

  it("M-C: a running CLI that will not last is refused before the root write: nothing is written even with a person at the terminal", () => {
    const c = staleDropIn();
    const before = dropInText(c);
    const out = runUpgrade(c.fx, { claudeHome: c.fx.claudeHome }, { pin: c.newPin, managedEnv: c.sys.env, terminal: PERSON, ephemeral: true });
    assert.equal(out.exitCode, 1, out.stdout);
    assert.match(out.stdout, /upgrade: claude-md\s+REFUSED.*looks temporary.*`repo-aegis install claude-md/);
    assert.doesNotMatch(out.stdout, /upgrade: claude-md\s+done/);
    assert.equal(c.sys.toolCalls().length, 0, "no privileged call at all");
    assert.equal(dropInText(c), before, "the drop-in is untouched");
    assert.equal(dropInStale(c, c.newPin), true);
    const forced = runUpgrade(c.fx, { claudeHome: c.fx.claudeHome, force: true }, { pin: c.newPin, managedEnv: c.sys.env, terminal: PERSON, ephemeral: true });
    assert.match(forced.stdout, /upgrade: claude-md\s+done/, "--force still pins there on purpose");
  });

  it("a person who answers no has declined, not failed: nothing written, exit 0, the command to retry is listed", () => {
    const c = staleDropIn();
    const before = dropInText(c);
    const out = runUpgrade(c.fx, { claudeHome: c.fx.claudeHome }, { pin: c.newPin, managedEnv: c.sys.env, terminal: { ...PERSON, readAnswer: () => "n" } });
    assert.equal(out.exitCode, undefined, out.stderr);
    assert.match(out.stdout, /upgrade: claude-md\s+declined\s+you answered no/);
    assert.doesNotMatch(out.stdout, /FAILED/);
    assert.match(out.stdout, /run yourself:\n {2}repo-aegis install claude-md --claude-home /);
    assert.equal(dropInText(c), before);
    assert.equal(c.sys.toolCalls().length, 0);
  });
});

describe("upgrade: the git credential helper (its own terminal gate)", () => {
  const KEY = "credential.https://github.com.helper";
  let fx: Fixture;
  beforeEach(() => {
    fx = makeFixture();
    // A repo-aegis helper from another install: the stale shape doctor reports.
    fx.run(() => execFileSync("git", ["config", "--global", "--add", KEY, "!'/opt/example/old-node' '/opt/example/old/dist/index.js' git-credential --home '/opt/example/home'"], { cwd: fx.base }));
  });
  const credential = (): UpgradeDeps["credential"] => ({ cwd: fx.base });
  const stale = (): boolean => fx.run(() => gitCredentialHelperStale({ cwd: fx.base }));

  it("without a person it is listed, not run; the config is untouched", () => {
    const before = readFileSync(fx.globalConfig, "utf8");
    assert.equal(stale(), true, "the fixture is stale");
    const out = runUpgrade(fx, {}, { credential: credential(), terminal: NO_PERSON });
    assert.equal(out.exitCode, undefined, out.stderr);
    assert.match(out.stdout, /upgrade: git-credential\s+needs you/);
    assert.match(out.stdout, /run yourself:\n {2}repo-aegis install git-credential\n/);
    assert.equal(readFileSync(fx.globalConfig, "utf8"), before);
  });

  it("with a person it re-pins the helper; doctor's stale finding clears and a re-run is a no-op", () => {
    const out = runUpgrade(fx, {}, { credential: credential(), terminal: { stderrIsTTY: true } });
    assert.equal(out.exitCode, undefined, out.stderr);
    assert.match(out.stdout, /upgrade: git-credential\s+done/);
    assert.equal(stale(), false);
    assert.match(runUpgrade(fx, {}, { credential: credential(), terminal: NO_PERSON }).stdout, /^nothing to upgrade/);
  });

  it("M-C: a running CLI that will not last is refused, and the helper's config is untouched even with a person", () => {
    const before = readFileSync(fx.globalConfig, "utf8");
    const out = runUpgrade(fx, {}, { credential: credential(), terminal: { stderrIsTTY: true }, ephemeral: true });
    assert.equal(out.exitCode, 1, out.stdout);
    assert.match(out.stdout, /upgrade: git-credential\s+REFUSED.*looks temporary.*`repo-aegis install git-credential`/);
    assert.equal(readFileSync(fx.globalConfig, "utf8"), before);
    assert.equal(stale(), true);
  });

  it("no repo-aegis helper configured: nothing to do, and none is installed", () => {
    const clean = makeFixture();
    const out = runUpgrade(clean, {}, { credential: { cwd: clean.base }, terminal: { stderrIsTTY: true } });
    assert.match(out.stdout, /^nothing to upgrade/);
    assert.equal(readFileSync(clean.globalConfig, "utf8"), "");
  });
});

// ---------------------------------------------------------------------------
// H1: the pin belongs to whichever install enforces, not to whichever one ran `upgrade`
// ---------------------------------------------------------------------------

const escapeRe = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

describe("upgrade: it never moves the pin to an install that merely ran it", () => {
  const readPin = (fx: Fixture, rel: string): EnforcementPin | null => parsePinFromScript(readFileSync(join(fx.home, rel), "utf8"));

  /** Hooks and shim as they would be had `pin`'s install written them. */
  function pinnedTo(fx: Fixture, pin: EnforcementPin): void {
    writeHookScripts(join(fx.home, "hooks"), pin);
    mkdirSync(join(fx.home, "bin"), { recursive: true });
    writeFileSync(join(fx.home, "bin", "gh"), renderShimScript(pin, { home: fx.home }), { mode: 0o755 });
    chmodSync(join(fx.home, "bin", "gh"), 0o755);
  }
  const readVersion = (fx: Fixture): string | null => readLastVersion(fx.home);

  it("the nvm / Homebrew case: a new global, the old install still on disk with an older version, is re-pinned and exits 0", () => {
    const fx = makeFixture();
    const old = { ...makePin(join(fx.base, "old-global")), version: "0.0.1" };
    pinnedTo(fx, old);
    const now = fx.run(() => currentEnforcementPin());

    const out = runUpgrade(fx);
    assert.equal(out.exitCode, undefined, out.stdout + out.stderr);
    assert.match(out.stdout, /upgrade: hooks\s+done/);
    assert.match(out.stdout, /upgrade: shim\s+done/);
    assert.doesNotMatch(out.stdout, /REFUSED/);
    assert.equal(readPin(fx, "hooks/pre-commit")?.cli, now.cli);
    assert.equal(readPin(fx, "bin/gh")?.cli, now.cli);
    assert.deepEqual(staleCodes(doctorJson(fx)), []);
    assert.match(runUpgrade(fx).stdout, /^nothing to upgrade/, "and the second run is a no-op");
  });

  it("mixed pins (hooks already on the running CLI, the shim on another install): one upgrade resolves both", () => {
    const fx = makeFixture();
    const now = fx.run(() => currentEnforcementPin());
    writeHookScripts(join(fx.home, "hooks"), { ...now, version: "0.0.1" }); // this CLI, an earlier release's script: stale
    mkdirSync(join(fx.home, "bin"), { recursive: true });
    const other = { ...makePin(join(fx.base, "other-install")), version: "0.0.1" };
    writeFileSync(join(fx.home, "bin", "gh"), renderShimScript(other, { home: fx.home }), { mode: 0o755 });
    chmodSync(join(fx.home, "bin", "gh"), 0o755);

    const out = runUpgrade(fx);
    assert.equal(out.exitCode, undefined, out.stdout + out.stderr);
    assert.match(out.stdout, /upgrade: hooks\s+done/);
    assert.match(out.stdout, /upgrade: shim\s+done/);
    assert.deepEqual(readPin(fx, "hooks/pre-commit"), now);
    assert.equal(readPin(fx, "bin/gh")?.cli, now.cli);
    assert.deepEqual(staleCodes(doctorJson(fx)), []);
  });

  describe("a running CLI that will not last (a git checkout, an npx cache, a project node_modules)", () => {
    const ephemeralRefusal =
      /looks temporary.*npm link.*run upgrade from the global install \(`npm i -g @de-otio\/repo-aegis`, then `repo-aegis upgrade`\), or run `repo-aegis install \w+( [\w-]+)?` from a lasting install\. To pin to this copy anyway, knowing that, pass --force \(UPGRADE_REFUSED\)/;

    it("is refused while the old pin still works: nothing rewritten, exit 1, the version not recorded", () => {
      const fx = makeFixture();
      pinnedTo(fx, { ...makePin(join(fx.base, "old-global")), version: "0.0.1" });
      const before = snapshot(fx);

      const out = runUpgrade(fx, {}, { ephemeral: true });
      assert.equal(out.exitCode, 1, out.stdout);
      assert.match(out.stdout, /upgrade: hooks\s+REFUSED/);
      assert.match(out.stdout, /upgrade: shim\s+REFUSED/);
      assert.match(out.stdout, ephemeralRefusal);
      assert.doesNotMatch(out.stdout, /nothing to upgrade/);
      assert.deepEqual(snapshot(fx), before, "no script was rewritten");
      assert.equal(readVersion(fx), null, "a refused run does not record the version");

      const json = JSON.parse(runUpgrade(fx, { json: true }, { ephemeral: true }).stdout) as UpgradeReport;
      assert.equal(json.refused, true);
      assert.deepEqual(json.steps.filter(s => s.status === "refused").map(s => s.step), ["hooks", "shim"]);
      assert.deepEqual(snapshot(fx), before);
    });

    it("is refused when the old pin is already gone too (the lockout is reachable from a pin that is missing)", () => {
      const fx = makeFixture();
      pinnedTo(fx, { node: "/opt/example/gone/bin/node", cli: "/opt/example/gone/dist/index.js", version: "0.0.1" });
      const before = snapshot(fx);
      const out = runUpgrade(fx, {}, { ephemeral: true });
      assert.equal(out.exitCode, 1, out.stdout);
      assert.match(out.stdout, ephemeralRefusal);
      assert.deepEqual(snapshot(fx), before);
      assert.equal(readVersion(fx), null);
    });

    it("is refused for by-name scripts too (the first pin must not be a temporary copy)", () => {
      const fx = makeFixture();
      writeStaleHooks(fx);
      const before = snapshot(fx);
      const out = runUpgrade(fx, {}, { ephemeral: true });
      assert.equal(out.exitCode, 1, out.stdout);
      assert.match(out.stdout, /upgrade: hooks\s+REFUSED/);
      assert.deepEqual(snapshot(fx), before);
    });

    it("--force pins to it anyway", () => {
      const fx = makeFixture();
      pinnedTo(fx, { node: "/opt/example/gone/bin/node", cli: "/opt/example/gone/dist/index.js", version: "0.0.1" });
      const now = fx.run(() => currentEnforcementPin());
      const out = runUpgrade(fx, { force: true }, { ephemeral: true });
      assert.equal(out.exitCode, undefined, out.stdout + out.stderr);
      assert.match(out.stdout, /upgrade: hooks\s+done/);
      assert.match(out.stdout, /upgrade: shim\s+done/);
      assert.equal(readPin(fx, "hooks/pre-commit")?.cli, now.cli);
    });

    it("--force does not override a version rollback", () => {
      const fx = makeFixture();
      pinnedTo(fx, { ...makePin(join(fx.base, "newer-install")), version: "999.0.0" });
      const before = snapshot(fx);
      const out = runUpgrade(fx, { force: true }, { ephemeral: true });
      assert.equal(out.exitCode, 1, out.stdout);
      assert.match(out.stdout, /newer than this install/);
      assert.deepEqual(snapshot(fx), before);
    });

    it("is fine when the scripts already point at this very CLI (nothing moves)", () => {
      const fx = makeFixture();
      const now = fx.run(() => currentEnforcementPin());
      pinnedTo(fx, { ...now, version: "0.0.1" });
      const out = runUpgrade(fx, {}, { ephemeral: true });
      assert.equal(out.exitCode, undefined, out.stdout + out.stderr);
      assert.match(out.stdout, /upgrade: hooks\s+done/);
    });

    it("--dry-run reports the refusal too and changes nothing", () => {
      const fx = makeFixture();
      pinnedTo(fx, { ...makePin(join(fx.base, "old-global")), version: "0.0.1" });
      const before = snapshot(fx);
      const out = runUpgrade(fx, { dryRun: true }, { ephemeral: true });
      assert.match(out.stdout, /upgrade: hooks\s+REFUSED/);
      assert.deepEqual(snapshot(fx), before);
    });
  });

  describe("isEphemeralCli", () => {
    const cliIn = (root: string, ...parts: string[]): string => {
      const dir = join(root, ...parts);
      mkdirSync(dir, { recursive: true });
      const cli = join(dir, "index.js");
      writeFileSync(cli, "// stub\n");
      return cli;
    };
    const prefixed = (root: string): { execPath: string; env: NodeJS.ProcessEnv } => ({ execPath: join(root, "prefix", "bin", "node"), env: {} });

    it("a directory under a .git (file or directory) ancestor is ephemeral: a worktree build", () => {
      const root = join(tmp, `eph-${n++}`);
      const checkout = join(root, "checkout");
      mkdirSync(checkout, { recursive: true });
      writeFileSync(join(checkout, ".git"), "gitdir: /elsewhere\n"); // a worktree's .git is a file
      assert.equal(isEphemeralCli(cliIn(checkout, "packages", "cli", "dist"), prefixed(root)), true);
      mkdirSync(join(root, "repo", ".git"), { recursive: true });
      assert.equal(isEphemeralCli(cliIn(root, "repo", "dist"), prefixed(root)), true);
    });

    it("an npx cache is ephemeral", () => {
      const root = join(tmp, `eph-${n++}`);
      assert.equal(isEphemeralCli(cliIn(root, ".npm", "_npx", "abc123", "node_modules", "@de-otio", "repo-aegis", "dist"), prefixed(root)), true);
    });

    it("a project devDependency (its project is a git repository) is ephemeral; the npm global one is not", () => {
      const root = join(tmp, `eph-${n++}`);
      mkdirSync(join(root, "project", ".git"), { recursive: true });
      assert.equal(isEphemeralCli(cliIn(root, "project", "node_modules", "@de-otio", "repo-aegis", "dist"), prefixed(root)), true);
      const global = cliIn(root, "prefix", "lib", "node_modules", "@de-otio", "repo-aegis", "dist");
      assert.equal(isEphemeralCli(global, prefixed(root)), false);
    });

    // M-A: these managers have a `node_modules` in the path but no `lib/node_modules`; a bare `node_modules` rule refused every
    // routine upgrade for them. The first assertion has no `.git` anywhere above, so only dropping that rule keeps them global.
    for (const [manager, parts] of [
      ["pnpm", [".local", "share", "pnpm", "global", "5", ".pnpm", "@de-otio+repo-aegis@1.0.0", "node_modules", "@de-otio", "repo-aegis", "dist"]],
      ["yarn", [".config", "yarn", "global", "node_modules", "@de-otio", "repo-aegis", "dist"]],
      ["bun", [".bun", "install", "global", "node_modules", "@de-otio", "repo-aegis", "dist"]],
    ] as const) {
      it(`a ${manager} global install is not ephemeral, with or without a dotfiles .git above it`, () => {
        const root = join(tmp, `eph-${n++}`);
        const cli = cliIn(root, ...parts);
        assert.equal(isEphemeralCli(cli, prefixed(root)), false, "no .git");
        mkdirSync(join(root, ".git"), { recursive: true });
        assert.equal(isEphemeralCli(cli, prefixed(root)), false, "a dotfiles repository above it");
      });
    }

    it("a global install is recognised by the Node prefix, npm_config_prefix, or a lib/node_modules segment, even under a .git", () => {
      const root = join(tmp, `eph-${n++}`);
      mkdirSync(join(root, ".git"), { recursive: true }); // the whole tree sits in a repository (a dotfiles repo in $HOME)
      const viaNode = cliIn(root, "prefix", "lib", "node_modules", "@de-otio", "repo-aegis", "dist");
      assert.equal(isEphemeralCli(viaNode, prefixed(root)), false);
      const custom = cliIn(root, "custom-prefix", "lib", "node_modules", "@de-otio", "repo-aegis", "dist");
      assert.equal(isEphemeralCli(custom, { execPath: "/somewhere/else/bin/node", env: { npm_config_prefix: join(root, "custom-prefix") } }), false);
      const homebrew = cliIn(root, "homebrew", "lib", "node_modules", "@de-otio", "repo-aegis", "dist"); // execPath resolves into a Cellar
      assert.equal(isEphemeralCli(homebrew, { execPath: join(root, "homebrew", "Cellar", "node", "22", "bin", "node"), env: {} }), false);
    });

    it("a plain directory with no .git ancestor and no node_modules is not ephemeral", () => {
      const root = join(tmp, `eph-${n++}`);
      assert.equal(isEphemeralCli(cliIn(root, "opt", "repo-aegis", "dist"), prefixed(root)), false);
    });
  });

  it("an older running version is refused, naming only the step's own installer (never `run that install's upgrade` for an older one)", () => {
    const fx = makeFixture();
    const newer = { ...makePin(join(fx.base, "newer-install")), version: "999.0.0" };
    pinnedTo(fx, newer);
    const before = snapshot(fx);

    const out = runUpgrade(fx);
    assert.equal(out.exitCode, 1, out.stdout);
    assert.match(out.stdout, new RegExp(`upgrade: hooks\\s+REFUSED\\s+the pin in the git hooks is ${escapeRe(newer.cli)} \\(version 999\\.0\\.0\\), which is newer than this install \\(.*\\): run the newer install's upgrade, or \`repo-aegis install hooks\` from this one to roll back on purpose \\(UPGRADE_REFUSED\\)`));
    assert.match(out.stdout, new RegExp(`upgrade: shim\\s+REFUSED\\s+the pin in the gh shim is ${escapeRe(newer.cli)} .*or \`repo-aegis install shim\` from this one`));
    const hooksLine = out.stdout.split("\n").find(l => l.startsWith("upgrade: hooks")) ?? "";
    assert.doesNotMatch(hooksLine, /install shim/, "each refusal names only its own installer");
    assert.deepEqual(snapshot(fx), before);
    assert.equal(readVersion(fx), null, "a refused run does not record the version");
  });

  it("a refusal ends with a code `repo-aegis explain` knows, and the guide row says what to do for both causes", () => {
    const docs = loadDocs();
    if (docs === null) return; // the guide is not next to a source-only run; the build copies it
    const row = explanationFor(docs, "UPGRADE_REFUSED");
    assert.ok(row !== null, "UPGRADE_REFUSED has no row in doc/agent-guide.md");
    assert.match(row.recovery, /global install/);
    assert.match(row.recovery, /newer install's `upgrade`/);
  });

  it("a prerelease running version is older than the release it would replace: refused (one comparator with the notice)", () => {
    const fx = makeFixture();
    const now = fx.run(() => currentEnforcementPin());
    pinnedTo(fx, { ...makePin(join(fx.base, "release-install")), version: "0.14.0" });
    const before = snapshot(fx);
    const out = runUpgrade(fx, {}, { pin: { ...now, version: "0.14.0-rc.1" } });
    assert.equal(out.exitCode, 1, out.stdout);
    assert.match(out.stdout, /upgrade: hooks\s+REFUSED.*newer than this install/);
    assert.deepEqual(snapshot(fx), before);
  });

  // Every other test injects `ephemeral`; this one runs the real wiring (`isEphemeralCli` on the running CLI). The tests run
  // from a checkout (a `.git` directory, or a worktree's `.git` file, above dist), which is exactly what it must call temporary.
  const inCheckout = existsSync(join(resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", ".."), ".git"));
  it("without the seam, the build under test is judged temporary and refused", { skip: !inCheckout }, () => {
    const fx = makeFixture();
    pinnedTo(fx, { ...makePin(join(fx.base, "old-global")), version: "0.0.1" });
    const before = snapshot(fx);
    const out = runUpgrade(fx, {}, { ephemeral: undefined });
    assert.equal(out.exitCode, 1, out.stdout);
    assert.match(out.stdout, /upgrade: hooks\s+REFUSED.*looks temporary/);
    assert.deepEqual(snapshot(fx), before);
    const forced = runUpgrade(fx, { force: true }, { ephemeral: undefined });
    assert.match(forced.stdout, /upgrade: hooks\s+done/);
  });

  it("the same CLI path with a newer pinned version is refused too (an in-place downgrade is a person's choice)", () => {
    const fx = makeFixture();
    pinnedTo(fx, { ...fx.run(() => currentEnforcementPin()), version: "999.0.0" });
    const before = snapshot(fx);
    const out = runUpgrade(fx);
    assert.equal(out.exitCode, 1, out.stdout);
    assert.match(out.stdout, /upgrade: hooks\s+REFUSED.*newer than this install/);
    assert.deepEqual(snapshot(fx), before);
  });

  it("a pinned CLI that is gone is re-pinned (the scripts are broken until it is), even when its version was newer", () => {
    const fx = makeFixture();
    pinnedTo(fx, { node: "/opt/example/gone/bin/node", cli: "/opt/example/gone/dist/index.js", version: "999.0.0" });
    const out = runUpgrade(fx);
    assert.equal(out.exitCode, undefined, out.stdout + out.stderr);
    assert.match(out.stdout, /upgrade: hooks\s+done/);
    assert.match(out.stdout, /upgrade: shim\s+done/);
    const now = fx.run(() => currentEnforcementPin());
    assert.equal(readPin(fx, "hooks/pre-push")?.cli, now.cli);
    assert.equal(readPin(fx, "bin/gh")?.cli, now.cli);
    assert.deepEqual(staleCodes(doctorJson(fx)), []);
  });

  it("the same CLI path is re-pinned: an in-place `npm i -g` over the pinned install", () => {
    const fx = makeFixture();
    const now = fx.run(() => currentEnforcementPin());
    pinnedTo(fx, { ...now, version: "0.0.1" }); // same node and CLI, an earlier release's pin
    const out = runUpgrade(fx);
    assert.equal(out.exitCode, undefined, out.stdout + out.stderr);
    assert.match(out.stdout, /upgrade: hooks\s+done/);
    assert.match(out.stdout, /upgrade: shim\s+done/);
    assert.deepEqual(readPin(fx, "hooks/pre-commit"), now);
    assert.deepEqual(staleCodes(doctorJson(fx)), []);
  });

  it("an unpinned (by-name) older install has no pin to protect: it is re-pinned", () => {
    const fx = makeFixture();
    writeStaleHooks(fx);
    writeStaleShim(fx);
    const out = runUpgrade(fx);
    assert.match(out.stdout, /upgrade: hooks\s+done/);
    assert.match(out.stdout, /upgrade: shim\s+done/);
  });

  describe("the taaad the shim pins", () => {
    function taaadFixture(fx: Fixture): { pinned: { launcher: string; interpreter: string; packageDir: string }; pathDir: string; onPath: string } {
      const pinnedDir = join(fx.base, "vetted-taaad", "bin");
      mkdirSync(pinnedDir, { recursive: true });
      const launcher = join(pinnedDir, "taaad");
      writeFileSync(launcher, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      const pinned = { launcher, interpreter: "/bin/sh", packageDir: join(fx.base, "vetted-taaad") };
      const pathDir = join(fx.base, "other-bin");
      mkdirSync(pathDir, { recursive: true });
      const onPath = join(pathDir, "taaad");
      writeFileSync(onPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      // The shim is stale because its CLI pin is gone, so the re-pin is allowed.
      mkdirSync(join(fx.home, "bin"), { recursive: true });
      const gone: EnforcementPin = { node: "/opt/example/gone/bin/node", cli: "/opt/example/gone/dist/index.js" };
      writeFileSync(join(fx.home, "bin", "gh"), renderShimScript(gone, { home: fx.home, taaad: pinned }), { mode: 0o755 });
      chmodSync(join(fx.home, "bin", "gh"), 0o755);
      return { pinned, pathDir, onPath };
    }

    it("a different taaad on PATH does not replace a pinned one whose launcher exists", () => {
      const fx = makeFixture();
      const { pinned, pathDir } = taaadFixture(fx);
      const out = runUpgrade(fx, {}, { path: pathDir });
      assert.match(out.stdout, /upgrade: shim\s+done/);
      assert.deepEqual(parseTaaadPinFromScript(readFileSync(join(fx.home, "bin", "gh"), "utf8")), pinned);
    });

    it("when the pinned launcher is gone, the one on PATH is taken", () => {
      const fx = makeFixture();
      const { pinned, pathDir, onPath } = taaadFixture(fx);
      rmSync(pinned.launcher);
      const out = runUpgrade(fx, {}, { path: pathDir });
      assert.match(out.stdout, /upgrade: shim\s+done/);
      assert.equal(parseTaaadPinFromScript(readFileSync(join(fx.home, "bin", "gh"), "utf8"))?.launcher, realpathSync(onPath));
    });
  });
});

describe("upgrade: Claude Code's user settings (what `init` writes by default)", () => {
  const settingsWith = (fx: Fixture, pin: EnforcementPin): void => {
    const command = pinnedHookCommand(pin, "hook guard-egress --agent claude");
    writeFileSync(join(fx.claudeHome, "settings.json"), JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command }] }] } }));
  };

  it("hooks pinned to a Node or install that has moved are listed under `run yourself:`, never rewritten", () => {
    const fx = makeFixture();
    settingsWith(fx, { node: "/opt/example/old-node/bin/node", cli: "/opt/example/old/dist/index.js", version: "0.1.0" });
    const before = readFileSync(join(fx.claudeHome, "settings.json"), "utf8");
    const out = runUpgrade(fx, { claudeHome: fx.claudeHome });
    assert.equal(out.exitCode, undefined, out.stderr);
    assert.match(out.stdout, /upgrade: user-settings\s+needs you/);
    assert.match(out.stdout, new RegExp(`run yourself:\\n {2}repo-aegis install claude-md --user-settings --claude-home ${escapeRe(fx.claudeHome)}\\n`));
    assert.equal(readFileSync(join(fx.claudeHome, "settings.json"), "utf8"), before);
  });

  it("hooks pinned to a newer working install are refused (naming `install claude-md --user-settings`), not listed as current", () => {
    const fx = makeFixture();
    const newer = { ...makePin(join(fx.base, "newer-install")), version: "999.0.0" };
    settingsWith(fx, newer);
    const before = readFileSync(join(fx.claudeHome, "settings.json"), "utf8");
    const out = runUpgrade(fx, { claudeHome: fx.claudeHome });
    assert.equal(out.exitCode, 1, out.stdout);
    assert.match(out.stdout, /upgrade: user-settings\s+REFUSED.*newer than this install.*`repo-aegis install claude-md --user-settings --claude-home /);
    assert.doesNotMatch(out.stdout, /needs you/);
    assert.equal(readFileSync(join(fx.claudeHome, "settings.json"), "utf8"), before);
  });

  it("with a running CLI that will not last it is refused too", () => {
    const fx = makeFixture();
    settingsWith(fx, { node: "/opt/example/old-node/bin/node", cli: "/opt/example/old/dist/index.js", version: "0.1.0" });
    const out = runUpgrade(fx, { claudeHome: fx.claudeHome }, { ephemeral: true });
    assert.equal(out.exitCode, 1, out.stdout);
    assert.match(out.stdout, /upgrade: user-settings\s+REFUSED.*looks temporary/);
  });

  it("hooks pinned to this install are current: nothing to upgrade", () => {
    const fx = makeFixture();
    settingsWith(fx, fx.run(() => currentEnforcementPin()));
    assert.match(runUpgrade(fx, { claudeHome: fx.claudeHome }).stdout, /^nothing to upgrade/);
  });

  it("no settings.json at all: nothing to say", () => {
    const fx = makeFixture();
    assert.match(runUpgrade(fx, { claudeHome: fx.claudeHome }).stdout, /^nothing to upgrade/);
  });
});
