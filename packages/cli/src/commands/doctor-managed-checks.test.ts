// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// `doctor`'s checks for the managed drop-in
// (doc/plan-pin-enforcement-binary.md D6/D8.6, D8.7, D8.11, D8.12): T18
// (MANAGED_DROPIN_NOT_ROOT_OWNED over a tree with a group-writable parent) and the
// rest of the codes. The drop-in is written by the real installer over a simulated
// system; ownership, the privileged runner and the sessions are injected.
import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EnforcementPin } from "@de-otio/repo-aegis-core";
import { captureOutput, withEnv } from "../_test-utils.js";
import { makeDir, makeFakeSystem, putFile, type FakeSystem } from "../_managed-test-utils.js";
import type { DoctorCheck, DoctorCheckCode } from "./doctor-checks.js";
import {
  HEARTBEAT_MARGIN_MS,
  managedDropinChecks,
  readDropInSettings,
  sessionStartTimes,
  userSettingsEnforcementCheck,
} from "./doctor-managed-checks.js";
import { checkGuardHook, checkRegistryAgentWritable, installClaudeMd, registryDenyPlan } from "./install-claude-md.js";
import { managedPaths } from "./managed-dropin.js";
import { managedHeartbeatPath, managedLedgerPath, readManagedLedger } from "./managed-ledger.js";
import { scanSessions } from "./managed-heartbeat-check.js";
import { sudoEnvironment } from "./managed-privileged.js";

let tmp: string;
let n = 0;
const systems: FakeSystem[] = [];
before(() => {
  tmp = mkdtempSync(join(tmpdir(), "repo-aegis-doctor-managed-"));
});
after(() => {
  rmSync(tmp, { recursive: true, force: true });
});
afterEach(() => {
  for (const s of systems.splice(0)) rmSync(s.root, { recursive: true, force: true });
});

const PERSON = { stderrIsTTY: true, stdinIsTTY: true, readAnswer: () => "y" };

interface Env {
  claudeHome: string;
  aegisHome: string;
  pin: EnforcementPin;
  sys: FakeSystem;
  paths: NonNullable<ReturnType<typeof managedPaths>>;
}

/** A pin whose files exist, so a healthy drop-in is not orphaned. */
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

function makeEnv(platform: NodeJS.Platform = "linux"): Env {
  const base = join(tmp, `case-${n++}`);
  const claudeHome = join(base, "claude");
  const aegisHome = join(base, "aegis");
  mkdirSync(claudeHome, { recursive: true });
  mkdirSync(join(aegisHome, "state"), { recursive: true });
  const uid = platform === "darwin" ? 501 : 1000;
  const sys = makeFakeSystem({ platform, uid });
  systems.push(sys);
  return { claudeHome, aegisHome, pin: makePin(base), sys, paths: managedPaths(platform, uid)! };
}

const inHome = <T>(e: Env, fn: () => T): T =>
  withEnv("REPO_AEGIS_MARKERS_DIR", undefined, () => withEnv("REPO_AEGIS_REGISTRY", undefined, () => withEnv("REPO_AEGIS_HOME", e.aegisHome, fn)));

function install(e: Env, over: Record<string, unknown> = {}): void {
  const out = inHome(e, () =>
    captureOutput(() => installClaudeMd({ claudeHome: e.claudeHome, pin: e.pin, managed: { env: e.sys.env, terminal: PERSON }, ...over })),
  );
  assert.equal(out.exitCode, undefined, out.stderr);
  e.sys.calls.length = 0;
}

function checks(e: Env, over: Partial<Parameters<typeof managedDropinChecks>[0]> = {}): DoctorCheck[] {
  return inHome(e, () => managedDropinChecks({ env: e.sys.env, claudeHome: e.claudeHome, pin: e.pin, sessionBirths: () => [], ...over }));
}
const byCode = (found: DoctorCheck[], code: DoctorCheckCode): DoctorCheck => {
  const c = found.find(x => x.code === code);
  assert.ok(c, `no ${code} in ${found.map(f => f.code).join(", ")}`);
  return c;
};
const failing = (found: DoctorCheck[]): string[] => found.filter(c => !c.ok && (c.severity ?? "fail") === "fail").map(c => c.code);

const ALL_CODES: DoctorCheckCode[] = [
  "MANAGED_DROPIN_STALE",
  "MANAGED_DROPIN_NOT_ROOT_OWNED",
  "MANAGED_DROPIN_UNREADABLE",
  "MANAGED_DROPIN_ORPHANED",
  "MANAGED_DROPIN_LEDGER_STALE",
  "MANAGED_HOOKS_DISABLED",
  "MANAGED_SOURCE_SHADOWED",
  "MANAGED_HOOKS_NOT_FIRING",
  "SUDO_NOPASSWD",
];

describe("managedDropinChecks: a healthy install", () => {
  for (const platform of ["linux", "darwin"] as const) {
    it(`${platform}: every check is reported and passes`, () => {
      const e = makeEnv(platform);
      install(e);
      const found = checks(e);
      assert.deepEqual(found.map(c => c.code).sort(), [...ALL_CODES].sort());
      assert.deepEqual(found.filter(c => !c.ok).map(c => `${c.code}: ${c.detail}`), []);
    });
  }

  it("with no drop-in and no ledger nothing is reported (the other checks cover an absent install)", () => {
    const e = makeEnv();
    assert.deepEqual(checks(e), []);
  });

  it("a platform with no managed location reports nothing", () => {
    const e = makeEnv();
    assert.deepEqual(checks(e, { env: { ...e.sys.env, platform: "win32" } }), []);
  });
});

describe("T18: MANAGED_DROPIN_NOT_ROOT_OWNED (D8.7)", () => {
  it("a group-writable parent directory fails and names it", () => {
    const e = makeEnv();
    install(e);
    chmodSync(e.sys.at("/etc"), 0o775);
    const c = byCode(checks(e), "MANAGED_DROPIN_NOT_ROOT_OWNED");
    assert.equal(c.ok, false);
    assert.ok(c.detail.includes("/etc") && /writable by group or others/.test(c.detail), c.detail);
    assert.ok((c.fix ?? "").includes(`sudo rm '${e.paths.file}'`) || (c.fix ?? "").includes("repo-aegis install claude-md"), c.fix ?? "");
  });

  it("a world-writable system directory, and a group-writable drop-in directory, fail", () => {
    const known = managedPaths("linux", 1000)!;
    for (const dir of [known.systemDir, known.dropinDir]) {
      const e = makeEnv();
      install(e);
      chmodSync(e.sys.at(dir), 0o777);
      assert.equal(byCode(checks(e), "MANAGED_DROPIN_NOT_ROOT_OWNED").ok, false, dir);
    }
  });

  it("a file owned by the user, or writable by group or others, fails", () => {
    const owned = makeEnv();
    install(owned);
    owned.sys.owners.set(owned.paths.file, { uid: 1000, gid: 1000 });
    assert.equal(byCode(checks(owned), "MANAGED_DROPIN_NOT_ROOT_OWNED").ok, false);

    for (const mode of [0o664, 0o646, 0o666]) {
      const e = makeEnv();
      install(e);
      chmodSync(e.sys.at(e.paths.file), mode);
      const c = byCode(checks(e), "MANAGED_DROPIN_NOT_ROOT_OWNED");
      assert.equal(c.ok, false, mode.toString(8));
    }
  });

  it("a directory owned by the user fails; a symlinked parent fails", () => {
    const owned = makeEnv();
    install(owned);
    owned.sys.owners.set(owned.paths.dropinDir, { uid: 1000, gid: 1000 });
    assert.equal(byCode(checks(owned), "MANAGED_DROPIN_NOT_ROOT_OWNED").ok, false);

    const linked = makeEnv();
    install(linked);
    makeDir(linked.sys, "/home/u");
    renameSync(linked.sys.at(linked.paths.systemDir), linked.sys.at("/home/u/real"));
    symlinkSync(linked.sys.at("/home/u/real"), linked.sys.at(linked.paths.systemDir));
    assert.equal(byCode(checks(linked), "MANAGED_DROPIN_NOT_ROOT_OWNED").ok, false);
  });
});

describe("MANAGED_DROPIN_UNREADABLE (D8.7)", () => {
  it("a file that is not 0644 fails (Claude Code starts without a source it cannot read)", () => {
    const e = makeEnv();
    install(e);
    chmodSync(e.sys.at(e.paths.file), 0o600);
    const found = checks(e);
    assert.equal(byCode(found, "MANAGED_DROPIN_UNREADABLE").ok, false);
    assert.equal(byCode(found, "MANAGED_DROPIN_NOT_ROOT_OWNED").ok, true, "0600 is not writable by others");
  });

  it("a directory that is not 0755 fails", () => {
    const e = makeEnv();
    install(e);
    chmodSync(e.sys.at(e.paths.dropinDir), 0o700);
    assert.equal(byCode(checks(e), "MANAGED_DROPIN_UNREADABLE").ok, false);
    const sys = makeEnv();
    install(sys);
    chmodSync(sys.sys.at(sys.paths.systemDir), 0o750);
    assert.equal(byCode(checks(sys), "MANAGED_DROPIN_UNREADABLE").ok, false);
  });
});

describe("MANAGED_DROPIN_STALE (D8.7)", () => {
  it("passes for the pin it was rendered for and fails once the pin moves", () => {
    const e = makeEnv();
    install(e);
    assert.equal(byCode(checks(e), "MANAGED_DROPIN_STALE").ok, true);
    const moved = makePin(join(tmp, `moved-${n++}`));
    const c = byCode(checks(e, { pin: moved }), "MANAGED_DROPIN_STALE");
    assert.equal(c.ok, false);
    assert.match(c.fix ?? "", /repo-aegis install claude-md/);
  });

  it("fails for a file edited after install", () => {
    const e = makeEnv();
    install(e);
    putFile(e.sys, e.paths.file, '{"hooks":{}}\n');
    e.sys.owners.set(e.paths.file, { uid: 0, gid: 0 });
    assert.equal(byCode(checks(e), "MANAGED_DROPIN_STALE").ok, false);
  });

  it("follows a first-touch hook that is already registered rather than calling it stale", () => {
    const e = makeEnv();
    install(e, { firstTouch: true });
    assert.equal(byCode(checks(e), "MANAGED_DROPIN_STALE").ok, true);
  });
});

describe("D8.11: MANAGED_DROPIN_ORPHANED and MANAGED_DROPIN_LEDGER_STALE", () => {
  it("a drop-in with no ledger entry is orphaned and the message carries the sudo rm line", () => {
    const e = makeEnv();
    install(e);
    rmSync(inHome(e, () => managedLedgerPath()));
    const c = byCode(checks(e), "MANAGED_DROPIN_ORPHANED");
    assert.equal(c.ok, false);
    assert.ok((c.fix ?? "").includes(`sudo rm '${e.paths.file}'`), c.fix ?? "");
  });

  it("a drop-in whose pin points at missing files is orphaned, with or without a ledger", () => {
    for (const keepLedger of [true, false]) {
      const e = makeEnv();
      install(e);
      rmSync(e.pin.cli);
      if (!keepLedger) rmSync(inHome(e, () => managedLedgerPath()));
      const c = byCode(checks(e), "MANAGED_DROPIN_ORPHANED");
      assert.equal(c.ok, false, `keepLedger=${keepLedger}`);
      assert.ok(c.detail.includes(e.pin.cli), c.detail);
      assert.ok((c.fix ?? "").includes(`sudo rm '${e.paths.file}'`));
    }
  });

  it("a ledger entry with no file is stale (after a manual sudo rm)", () => {
    const e = makeEnv();
    install(e);
    rmSync(e.sys.at(e.paths.file));
    const found = checks(e);
    const c = byCode(found, "MANAGED_DROPIN_LEDGER_STALE");
    assert.equal(c.ok, false);
    assert.match(c.fix ?? "", /--uninstall/);
    assert.equal(byCode(found, "MANAGED_DROPIN_ORPHANED").ok, true);
  });
});

describe("MANAGED_HOOKS_DISABLED and MANAGED_SOURCE_SHADOWED (D8.7)", () => {
  it("a sibling drop-in or managed-settings.json with disableAllHooks: true is reported", () => {
    for (const rel of ["managed-settings.d/10-corp.json", "managed-settings.json"]) {
      const e = makeEnv();
      install(e);
      putFile(e.sys, `${e.paths.systemDir}/${rel}`, '{"disableAllHooks": true}\n');
      const c = byCode(checks(e), "MANAGED_HOOKS_DISABLED");
      assert.equal(c.ok, false, rel);
      assert.ok(c.detail.includes(rel), c.detail);
    }
  });

  it("disableAllHooks: false, an unreadable sibling and our own file are fine", () => {
    const e = makeEnv();
    install(e);
    putFile(e.sys, `${e.paths.dropinDir}/10-corp.json`, '{"disableAllHooks": false}\n');
    putFile(e.sys, `${e.paths.dropinDir}/20-broken.json`, "{not json");
    assert.equal(byCode(checks(e), "MANAGED_HOOKS_DISABLED").ok, true);
  });

  it("a com.anthropic.claudecode profile shadows the files on macOS, also under a per-user directory", () => {
    for (const rel of ["com.anthropic.claudecode.plist", "someone/com.anthropic.claudecode.plist"]) {
      const e = makeEnv("darwin");
      install(e);
      putFile(e.sys, `/Library/Managed Preferences/${rel}`, "<plist/>");
      assert.equal(byCode(checks(e), "MANAGED_SOURCE_SHADOWED").ok, false, rel);
    }
  });

  it("an unrelated profile does not", () => {
    const e = makeEnv("darwin");
    install(e);
    putFile(e.sys, "/Library/Managed Preferences/com.example.other.plist", "<plist/>");
    assert.equal(byCode(checks(e), "MANAGED_SOURCE_SHADOWED").ok, true);
  });
});

describe("D8.12: MANAGED_HOOKS_NOT_FIRING (the heartbeat)", () => {
  const T = Date.UTC(2026, 10, 4, 12, 0, 0);
  /** The clock is injected: these timestamps are fixed, and a heartbeat later than the real now is rightly refused (L1). */
  const now = (): number => T + 3_600_000;
  const iso = (ms: number): string => new Date(ms).toISOString();
  function withHeartbeat(e: Env, at: number | null): void {
    if (at === null) return;
    inHome(e, () => {
      writeFileSync(managedHeartbeatPath(), iso(at) + "\n");
    });
  }
  function installedAt(e: Env, at: number): void {
    inHome(e, () => {
      const l = readManagedLedger()!;
      writeFileSync(managedLedgerPath(), JSON.stringify({ ...l, installedAt: iso(at) }));
    });
  }

  it("fires when a session started after the last heartbeat", () => {
    const e = makeEnv();
    install(e);
    installedAt(e, T - 3_600_000);
    withHeartbeat(e, T - 2 * HEARTBEAT_MARGIN_MS);
    const c = byCode(checks(e, { sessionBirths: () => [T - 10_000_000, T], now }), "MANAGED_HOOKS_NOT_FIRING");
    assert.equal(c.ok, false);
    assert.match(c.detail, /server-managed|first-wins|MDM|profile/);
    assert.ok((c.fix ?? "").includes("/status"));
  });

  it("fires when there is no heartbeat at all but a session started after the install", () => {
    const e = makeEnv();
    install(e);
    installedAt(e, T - 3_600_000);
    assert.equal(byCode(checks(e, { sessionBirths: () => [T], now }), "MANAGED_HOOKS_NOT_FIRING").ok, false);
  });

  it("passes when the heartbeat is at or after the newest session start, or within the margin before it (the file can appear after the hook ran)", () => {
    for (const hb of [T + 1000, T, T - 1000, T - HEARTBEAT_MARGIN_MS + 1000]) {
      const e = makeEnv();
      install(e);
      installedAt(e, T - 3_600_000);
      withHeartbeat(e, hb);
      assert.equal(byCode(checks(e, { sessionBirths: () => [T], now }), "MANAGED_HOOKS_NOT_FIRING").ok, true, `hb=${T - hb}`);
    }
  });

  it("an ongoing session does not fire it: only when a session STARTED later, not when its file was written later", () => {
    const e = makeEnv();
    install(e);
    installedAt(e, T - 3_600_000);
    withHeartbeat(e, T - 60_000);
    assert.equal(byCode(checks(e, { sessionBirths: () => [T - 60_000], now }), "MANAGED_HOOKS_NOT_FIRING").ok, true);
  });

  it("says nothing it cannot prove: no sessions, or none since the install, is a skip", () => {
    const e = makeEnv();
    install(e);
    installedAt(e, T);
    const none = byCode(checks(e, { sessionBirths: () => [], now }), "MANAGED_HOOKS_NOT_FIRING");
    assert.equal(none.ok, true);
    assert.equal(none.skipped, true);
    const old = byCode(checks(e, { sessionBirths: () => [T - 86_400_000], now }), "MANAGED_HOOKS_NOT_FIRING");
    assert.equal(old.ok, true);
    assert.equal(old.skipped, true);
  });
});

// Security review M2: every D8.12 test above injects `sessionBirths`, so the code that
// reads the real transcripts had no test at all.
describe("D8.12: sessions read from real transcript files", () => {
  /** `<claudeHome>/projects/<dir>/<name>` files, created now. */
  function transcripts(claudeHome: string, files: Record<string, string>): void {
    for (const [rel, body] of Object.entries(files)) {
      const abs = join(claudeHome, "projects", rel);
      mkdirSync(join(abs, ".."), { recursive: true });
      writeFileSync(abs, body);
    }
  }
  /** The file system under the temp dir reports a creation time. Skipped tests say so rather than pass vacuously. */
  const hasBirthtime = (p: string): boolean => statSync(p).birthtimeMs > 0;

  it("sessionStartTimes counts one birth for projects/<dir>/<id>.jsonl and ignores a non-.jsonl sibling", t => {
    const home = join(tmp, `home-${n++}`);
    transcripts(home, { "-proj-a/abc.jsonl": "{}\n", "-proj-a/notes.txt": "x", "-proj-a/abc.jsonl.bak": "x" });
    if (!hasBirthtime(join(home, "projects", "-proj-a", "abc.jsonl"))) return t.skip("this file system reports no creation time");
    const births = sessionStartTimes(home);
    assert.equal(births.length, 1);
    assert.ok(births[0]! > 0);
    assert.ok(Math.abs(births[0]! - Date.now()) < 60_000, "the birth is when the file was created");
  });

  it("a missing projects directory, and an empty one, give no sessions", () => {
    const home = join(tmp, `home-${n++}`);
    assert.deepEqual(scanSessions(home), { births: [], transcripts: 0, unknownBirth: 0 });
    mkdirSync(join(home, "projects", "-empty"), { recursive: true });
    assert.deepEqual(scanSessions(home), { births: [], transcripts: 0, unknownBirth: 0 });
  });

  it("without the seam, a real transcript newer than the install and no heartbeat fails MANAGED_HOOKS_NOT_FIRING", t => {
    const e = makeEnv();
    install(e);
    // The install happened an hour ago; the session's file is created now.
    inHome(e, () => {
      const l = readManagedLedger()!;
      writeFileSync(managedLedgerPath(), JSON.stringify({ ...l, installedAt: new Date(Date.now() - 3_600_000).toISOString() }));
    });
    transcripts(e.claudeHome, { "-proj-a/abc.jsonl": "{}\n", "-proj-a/notes.txt": "x" });
    if (!hasBirthtime(join(e.claudeHome, "projects", "-proj-a", "abc.jsonl"))) return t.skip("this file system reports no creation time");
    const found = inHome(e, () => managedDropinChecks({ env: e.sys.env, claudeHome: e.claudeHome, pin: e.pin }));
    const c = byCode(found, "MANAGED_HOOKS_NOT_FIRING");
    assert.equal(c.ok, false, c.detail);
    assert.match(c.detail, /never been recorded/);
  });

  it("the same transcript passes once a heartbeat was recorded after it", t => {
    const e = makeEnv();
    install(e);
    inHome(e, () => {
      const l = readManagedLedger()!;
      writeFileSync(managedLedgerPath(), JSON.stringify({ ...l, installedAt: new Date(Date.now() - 3_600_000).toISOString() }));
      writeFileSync(managedHeartbeatPath(), new Date().toISOString() + "\n");
    });
    transcripts(e.claudeHome, { "-proj-a/abc.jsonl": "{}\n" });
    if (!hasBirthtime(join(e.claudeHome, "projects", "-proj-a", "abc.jsonl"))) return t.skip("this file system reports no creation time");
    const found = inHome(e, () => managedDropinChecks({ env: e.sys.env, claudeHome: e.claudeHome, pin: e.pin }));
    assert.equal(byCode(found, "MANAGED_HOOKS_NOT_FIRING").ok, true);
  });

  it("a file system that reports no creation time is a skip with its own reason, not 'no session found'", () => {
    const e = makeEnv();
    install(e);
    transcripts(e.claudeHome, { "-proj-a/abc.jsonl": "{}\n", "-proj-a/def.jsonl": "{}\n" });
    const noBirth = inHome(e, () =>
      managedDropinChecks({ env: e.sys.env, claudeHome: e.claudeHome, pin: e.pin, sessionScan: () => scanSessions(e.claudeHome, () => 0) }),
    );
    const c = byCode(noBirth, "MANAGED_HOOKS_NOT_FIRING");
    assert.equal(c.ok, true);
    assert.equal(c.skipped, true);
    assert.match(c.detail, /no creation time/);
    assert.doesNotMatch(c.detail, /no Claude Code session was found/);

    const none = inHome(e, () => managedDropinChecks({ env: e.sys.env, claudeHome: join(tmp, `nowhere-${n++}`), pin: e.pin }));
    const c2 = byCode(none, "MANAGED_HOOKS_NOT_FIRING");
    assert.equal(c2.skipped, true);
    assert.match(c2.detail, /no Claude Code session was found/);
  });
});

// Security review L1: a timestamp that has not happened yet satisfies "the heartbeat is
// newer than every session" until then. state/ is agent-writable.
describe("D8.12: a timestamp in the future is not trusted (L1)", () => {
  const NOW = Date.UTC(2026, 10, 4, 12, 0, 0);
  const iso = (ms: number): string => new Date(ms).toISOString();
  function setup(over: { heartbeat?: number; installedAt?: number }): Env {
    const e = makeEnv();
    install(e);
    inHome(e, () => {
      const l = readManagedLedger()!;
      writeFileSync(managedLedgerPath(), JSON.stringify({ ...l, installedAt: iso(over.installedAt ?? NOW - 3_600_000) }));
      if (over.heartbeat !== undefined) writeFileSync(managedHeartbeatPath(), iso(over.heartbeat) + "\n");
    });
    return e;
  }
  const run = (e: Env, births: number[]): DoctorCheck =>
    byCode(checks(e, { sessionBirths: () => births, now: () => NOW }), "MANAGED_HOOKS_NOT_FIRING");

  it("a heartbeat later than now plus the margin fails and says it is in the future, even when it would cover the newest session", () => {
    const e = setup({ heartbeat: NOW + 24 * 3_600_000 });
    const c = run(e, [NOW - 60_000]);
    assert.equal(c.ok, false, c.detail);
    assert.notEqual(c.skipped, true);
    assert.match(c.detail, /in the future/);
    assert.match(c.detail, /rewritten/);
  });

  it("it fails even when no session has started yet (a forged heartbeat is not a skip)", () => {
    const e = setup({ heartbeat: NOW + 24 * 3_600_000 });
    const c = run(e, []);
    assert.equal(c.ok, false, c.detail);
    assert.match(c.detail, /in the future/);
  });

  it("a ledger installedAt later than now fails, instead of hiding every session as 'before the install'", () => {
    const e = setup({ installedAt: NOW + 24 * 3_600_000 });
    const c = run(e, [NOW - 60_000]);
    assert.equal(c.ok, false, c.detail);
    assert.notEqual(c.skipped, true);
    assert.match(c.detail, /in the future/);
  });

  it("a little clock skew is not an alarm: a heartbeat a minute ahead still passes", () => {
    const e = setup({ heartbeat: NOW + 60_000 });
    assert.equal(run(e, [NOW - 60_000]).ok, true);
  });

  it("the doctor result carries a fix", () => {
    const e = setup({ heartbeat: NOW + 24 * 3_600_000 });
    assert.ok((run(e, []).fix ?? "").length > 0);
  });
});

describe("SUDO_NOPASSWD (D8.7, P7)", () => {
  const probe = (c: { args: readonly string[] }): boolean => c.args[0] === "-n";

  it("warns when `sudo -n -k true` succeeds: an agent with a fake terminal could remove the drop-in", () => {
    const e = makeEnv();
    install(e);
    e.sys.intercept = c => (probe(c) ? { status: 0, stdout: "", stderr: "" } : undefined);
    const c = byCode(checks(e), "SUDO_NOPASSWD");
    assert.equal(c.ok, false);
    assert.equal(c.severity, "warn");
    assert.match(c.detail, /no longer stronger than|no stronger than|user file/);
    const call = e.sys.calls.find(probe)!;
    assert.deepEqual([call.file, ...call.args], ["/usr/bin/sudo", "-n", "-k", "/usr/bin/true"]);
    assert.deepEqual(call.options.env, sudoEnvironment(e.sys.env.processEnv));
    assert.equal(call.options.shell, false);
    assert.equal(call.options.input, undefined);
  });

  it("passes when sudo needs a password", () => {
    const e = makeEnv();
    install(e);
    e.sys.intercept = c => (probe(c) ? { status: 1, stdout: "", stderr: "a password is required" } : undefined);
    assert.equal(byCode(checks(e), "SUDO_NOPASSWD").ok, true);
  });

  it("does not run sudo at all when no drop-in is installed", () => {
    const e = makeEnv();
    checks(e);
    assert.equal(e.sys.calls.length, 0);
  });

  it("does not run a sudo that root does not own (P1): the check is skipped", () => {
    const e = makeEnv();
    install(e);
    e.sys.owners.set("/usr/bin/sudo", { uid: 1000, gid: 1000 });
    const c = byCode(checks(e), "SUDO_NOPASSWD");
    assert.equal(c.ok, true);
    assert.equal(c.skipped, true);
    assert.equal(e.sys.calls.length, 0);
  });
});

describe("ENFORCEMENT_IN_USER_SETTINGS (D8.6)", () => {
  it("warns when repo-aegis's hooks are in the user's settings.json, saying the file must stay per machine", () => {
    const e = makeEnv();
    install(e, { userSettings: true });
    const c = userSettingsEnforcementCheck(e.claudeHome)!;
    assert.equal(c.ok, false);
    assert.equal(c.severity, "warn");
    assert.match(c.detail, /per machine/);
    assert.match(c.fix ?? "", /repo-aegis install claude-md/);
  });

  it("also catches the older by-name form", () => {
    const e = makeEnv();
    writeFileSync(
      join(e.claudeHome, "settings.json"),
      JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "repo-aegis hook guard-egress --agent claude" }] }] } }),
    );
    assert.equal(userSettingsEnforcementCheck(e.claudeHome)!.ok, false);
  });

  it("is silent once the drop-in has replaced them, and for a settings file with only the user's own hooks", () => {
    const e = makeEnv();
    install(e);
    assert.equal(userSettingsEnforcementCheck(e.claudeHome), null);
    writeFileSync(join(e.claudeHome, "settings.json"), JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo mine" }] }] } }));
    assert.equal(userSettingsEnforcementCheck(e.claudeHome), null);
  });
});

describe("the older checks read the drop-in too", () => {
  it("GUARD_HOOK_UNREGISTERED passes on the drop-in alone, and still fails with neither", () => {
    const e = makeEnv();
    install(e);
    const dropin = readDropInSettings(e.sys.env);
    assert.ok(dropin !== null);
    const home = join(tmp, `empty-${n++}`);
    mkdirSync(home);
    assert.equal(checkGuardHook(home, dropin)[0]!.ok, true);
    assert.equal(checkGuardHook(home, null)[0]!.ok, false);
  });

  it("REGISTRY_AGENT_WRITABLE passes on the drop-in's deny rules alone", () => {
    const e = makeEnv();
    install(e);
    const dropin = readDropInSettings(e.sys.env);
    const home = join(tmp, `empty-${n++}`);
    mkdirSync(home);
    const plan = inHome(e, () => registryDenyPlan(e.pin));
    assert.equal(checkRegistryAgentWritable(home, plan, dropin).ok, true);
    assert.equal(checkRegistryAgentWritable(home, plan, null).ok, false);
  });
});
