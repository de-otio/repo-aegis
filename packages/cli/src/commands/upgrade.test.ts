// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// `repo-aegis upgrade` (P1-H): a stale install, made the way doctor's own stale tests make one, goes through the
// real installers and `doctor` stops reporting it; a second run is a no-op; `--dry-run` changes nothing; an
// installer that needs a person is listed, not run, when none is at a terminal. Temp homes, temp git config,
// a simulated `sudo`; placeholder names only.
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { inspectHookScripts, type EnforcementPin } from "@de-otio/repo-aegis-core";
import { captureOutput, fakeGh, scrubGitEnv, type CaptureResult } from "../_test-utils.js";
import { makeFakeSystem, type FakeSystem } from "../_managed-test-utils.js";
import { currentEnforcementPin } from "../enforcement-pin.js";
import { lastVersionPath, readLastVersion } from "../version-notice.js";
import { doctor } from "./doctor.js";
import { gitCredentialHelperStale } from "./doctor-git-credential-checks.js";
import { managedDropinStaleCheck } from "./doctor-managed-checks.js";
import { installClaudeMd } from "./install-claude-md.js";
import { writeHookScripts } from "./install-hooks.js";
import { checkShim } from "./install-shim.js";
import { managedPaths } from "./managed-dropin.js";
import { resolveManagedEnv } from "./managed-privileged.js";
import { parseTaaadPinFromScript, renderShimScript, SHIM_HEADER_LINE } from "./shim-script.js";
import { upgrade, type UpgradeDeps, type UpgradeReport } from "./upgrade.js";

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

function runUpgrade(fx: Fixture, over: { dryRun?: boolean; json?: boolean; claudeHome?: string } = {}, deps: UpgradeDeps = {}): CaptureResult {
  return fx.run(() => captureOutput(() => void upgrade(over, { version: VERSION, terminal: NO_PERSON, ...deps })));
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
        ["git-credential", "current"],
      ],
    );
    assert.equal(report.nothingToUpgrade, false);
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

  it("a person who answers no: the installer's refusal is a failed step, exit 1, the drop-in untouched", () => {
    const c = staleDropIn();
    const before = dropInText(c);
    const out = runUpgrade(c.fx, { claudeHome: c.fx.claudeHome }, { pin: c.newPin, managedEnv: c.sys.env, terminal: { ...PERSON, readAnswer: () => "n" } });
    assert.equal(out.exitCode, 1);
    assert.match(out.stdout, /upgrade: claude-md\s+FAILED/);
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

  it("no repo-aegis helper configured: nothing to do, and none is installed", () => {
    const clean = makeFixture();
    const out = runUpgrade(clean, {}, { credential: { cwd: clean.base }, terminal: { stderrIsTTY: true } });
    assert.match(out.stdout, /^nothing to upgrade/);
    assert.equal(readFileSync(clean.globalConfig, "utf8"), "");
  });
});
