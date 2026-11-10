// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// The decision log's surface beyond the entry points (complexity-review P1-I): `doctor`'s three codes, and `uninstall`
// (every install path has its opposite). Each test has its own home and its own `$TMPDIR`, set through the environment
// the code under test reads; the clock is pinned through the records' own timestamps.
import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureOutput, withEnv } from "../_test-utils.js";
import {
  appendDecisionRecord,
  buildDecisionRecord,
  decisionLogPath,
  decisionLogStatePath,
  fallbackDecisionDir,
  realDecisionLogOps,
  setDecisionLogEnabled,
  type DecisionLogOps,
} from "@de-otio/repo-aegis-core";
import { decisionLogChecks, doctor } from "./doctor.js";
import { uninstall } from "./uninstall.js";

const T = (s: number): Date => new Date(Date.parse("2026-11-10T12:00:00.000Z") + s * 1000);
const rec = (s: number) => buildDecisionRecord({ layer: "pre-push", outcome: "refuse", code: "SOME_CODE", version: "0.14.0", now: T(s) });

let root: string;
let originalCwd: string;
let n = 0;
before(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "repo-aegis-decision-surface-")));
  originalCwd = process.cwd();
});
after(() => {
  process.chdir(originalCwd);
  rmSync(root, { recursive: true, force: true });
});
afterEach(() => process.chdir(originalCwd));

/** A home whose directory ends in `repo-aegis` (uninstall's purge guard needs that), and a fresh `$TMPDIR`. */
function world(): { home: string; tmp: string } {
  const base = join(root, `s${n++}`);
  const home = join(base, "repo-aegis");
  const tmp = join(base, "tmp");
  mkdirSync(join(home, "state"), { recursive: true });
  mkdirSync(join(home, "markers"), { recursive: true });
  mkdirSync(tmp, { recursive: true });
  return { home, tmp };
}

const inWorld = <T,>(w: { home: string; tmp: string }, fn: () => T): T =>
  withEnv("REPO_AEGIS_HOME", w.home, () => withEnv("TMPDIR", w.tmp, fn));

const brokenPrimary = (home: string): DecisionLogOps => ({
  ...realDecisionLogOps,
  mkdir: dir => {
    if (dir.startsWith(home)) throw new Error("read-only home");
    realDecisionLogOps.mkdir(dir);
  },
});

describe("doctor: the decision log's three codes", () => {
  it("nothing to report when it is on and writable", () => {
    const w = world();
    appendDecisionRecord(w.home, rec(0), { tmp: w.tmp });
    assert.deepEqual(inWorld(w, () => decisionLogChecks(w.home)), []);
  });

  it("DECISION_LOG_OFF (info) when a person switched it off, with the way back", () => {
    const w = world();
    setDecisionLogEnabled(false, w.home);
    const checks = inWorld(w, () => decisionLogChecks(w.home));
    assert.equal(checks.length, 1);
    assert.equal(checks[0]!.code, "DECISION_LOG_OFF");
    assert.equal(checks[0]!.ok, false);
    assert.equal(checks[0]!.severity, "info");
    assert.equal(checks[0]!.fix, "repo-aegis log --on");
  });

  it("DECISION_LOG_FALLBACK (info) only when the fallback holds records NEWER than the primary's last", () => {
    const w = world();
    appendDecisionRecord(w.home, rec(10), { tmp: w.tmp });
    // an older record in the fallback: nothing to say
    appendDecisionRecord(w.home, rec(5), { tmp: w.tmp, ops: brokenPrimary(w.home) });
    assert.deepEqual(inWorld(w, () => decisionLogChecks(w.home)), []);
    // a newer one: report
    appendDecisionRecord(w.home, rec(20), { tmp: w.tmp, ops: brokenPrimary(w.home) });
    const checks = inWorld(w, () => decisionLogChecks(w.home));
    assert.deepEqual(checks.map(c => c.code), ["DECISION_LOG_FALLBACK"]);
    assert.equal(checks[0]!.severity, "info");
    assert.match(checks[0]!.detail, /\$TMPDIR/);
  });

  it("an untrusted fallback directory (world-writable, planted lines) is neither reported nor counted as writable (review F1)", { skip: process.getuid?.() === 0 }, () => {
    const w = world();
    const state = join(w.home, "state");
    appendDecisionRecord(w.home, rec(1), { tmp: w.tmp });
    const dir = join(w.tmp, `repo-aegis-${process.getuid?.() ?? "user"}`);
    mkdirSync(dir, { mode: 0o700 });
    writeFileSync(join(dir, "decisions.jsonl"), JSON.stringify(rec(500)) + "\n");
    chmodSync(dir, 0o777);
    try {
      assert.deepEqual(inWorld(w, () => decisionLogChecks(w.home)), [], "no DECISION_LOG_FALLBACK from a directory the writer refuses");
      chmodSync(state, 0o500);
      assert.deepEqual(inWorld(w, () => decisionLogChecks(w.home)).map(c => c.code), ["DECISION_LOG_UNWRITABLE"], "and no 'fallback' where the writer says none");
    } finally {
      chmodSync(state, 0o700);
      chmodSync(dir, 0o700);
    }
  });

  it("DECISION_LOG_UNWRITABLE (warn) when neither the home nor $TMPDIR can be written", { skip: process.getuid?.() === 0 }, () => {
    const w = world();
    chmodSync(join(w.home, "state"), 0o500);
    chmodSync(w.tmp, 0o500);
    try {
      const checks = inWorld(w, () => decisionLogChecks(w.home));
      assert.deepEqual(checks.map(c => c.code), ["DECISION_LOG_UNWRITABLE"]);
      assert.equal(checks[0]!.severity, "warn");
      assert.equal(checks[0]!.ok, false);
    } finally {
      chmodSync(join(w.home, "state"), 0o700);
      chmodSync(w.tmp, 0o700);
    }
  });

  it("a writable home with an unwritable $TMPDIR is fine (the primary works)", { skip: process.getuid?.() === 0 }, () => {
    const w = world();
    chmodSync(w.tmp, 0o500);
    try {
      assert.deepEqual(inWorld(w, () => decisionLogChecks(w.home)), []);
    } finally {
      chmodSync(w.tmp, 0o700);
    }
  });

  it("doctor reports them whatever --no-egress-checks says, as info and warn", () => {
    const w = world();
    setDecisionLogEnabled(false, w.home);
    const emptyRoot = join(root, `empty${n++}`);
    mkdirSync(emptyRoot);
    const r = inWorld(w, () => captureOutput(() => doctor({ scanRoot: [emptyRoot], json: true, egressChecks: false })));
    const j = JSON.parse(r.stdout) as { machine: Array<{ code: string; severity?: string }> };
    const c = j.machine.find(m => m.code === "DECISION_LOG_OFF");
    assert.ok(c, r.stdout);
    assert.equal(c.severity, "info");
    assert.notEqual(r.exitCode, 1, "an info finding does not fail the run");
  });
});

describe("uninstall removes the decision log (every install path has its opposite)", () => {
  function claudeHome(): string {
    const dir = join(root, `claude${n++}`);
    mkdirSync(dir, { recursive: true });
    return dir;
  }
  function gitRepo(): string {
    const dir = join(root, `r${n++}`);
    mkdirSync(dir, { recursive: true });
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
    return dir;
  }
  function isolated<T>(name: string, fn: () => T): T {
    const base = join(root, name);
    mkdirSync(base, { recursive: true });
    return withEnv("GIT_CONFIG_GLOBAL", join(base, "gitconfig-global"), () => withEnv("GIT_CONFIG_SYSTEM", "/dev/null", () => withEnv("GIT_CONFIG_NOSYSTEM", "1", fn)));
  }
  /** A world with every decision-log file present: the log and a rotation, the switch, the legacy file, the fallback. */
  function populated(): { home: string; tmp: string } {
    const w = world();
    for (let i = 0; i < 3; i++) appendDecisionRecord(w.home, rec(i), { tmp: w.tmp, rotateBytes: 1 });
    setDecisionLogEnabled(true, w.home);
    writeFileSync(join(w.home, "state", "gh-decisions.jsonl"), "{}\n");
    appendDecisionRecord(w.home, rec(50), { tmp: w.tmp, ops: brokenPrimary(w.home) });
    assert.ok(existsSync(decisionLogPath(w.home)) && existsSync(`${decisionLogPath(w.home)}.1`) && existsSync(decisionLogStatePath(w.home)));
    assert.ok(existsSync(fallbackDecisionDir(w.tmp)));
    return w;
  }
  const run = (w: { home: string; tmp: string }, opts: Record<string, unknown>) =>
    isolated(`iso${n++}`, () => inWorld(w, () => captureOutput(() => uninstall({ claudeHome: claudeHome(), cwd: gitRepo(), json: true, ...opts }))));
  const left = (home: string): string[] => readdirSync(join(home, "state")).filter(f => /decision|gh-decisions/.test(f));

  it("a dry run lists it and removes nothing", () => {
    const w = populated();
    const r = run(w, {});
    const step = (JSON.parse(r.stdout) as { steps: Array<{ step: string; details?: { wouldRemove?: string | null } }> }).steps.find(s => s.step === "remove decision log");
    assert.match(step?.details?.wouldRemove ?? "", /decisions\.jsonl.*decision-log\.json.*gh-decisions\.jsonl.*\$TMPDIR fallback/);
    assert.ok(left(w.home).length > 0);
    assert.ok(existsSync(fallbackDecisionDir(w.tmp)));
  });

  it("--yes removes decisions.jsonl and its rotations, the switch, the legacy file and the $TMPDIR fallback; the rest of the home stays", () => {
    const w = populated();
    writeFileSync(join(w.home, "engagements.yaml"), "schemaVersion: 2\nengagements: []\n");
    const r = run(w, { yes: true });
    const step = (JSON.parse(r.stdout) as { steps: Array<{ step: string; ok: boolean }> }).steps.find(s => s.step === "remove decision log");
    assert.equal(step?.ok, true);
    assert.deepEqual(left(w.home), []);
    assert.ok(!existsSync(fallbackDecisionDir(w.tmp)), "the fallback directory is gone");
    assert.ok(existsSync(join(w.home, "engagements.yaml")), "the registry is not the decision log's to remove");
  });

  it("--yes on a home with no decision log is a no-op, not an error", () => {
    const w = world();
    const r = run(w, { yes: true });
    assert.notEqual(r.exitCode, 1, r.stderr);
  });
});
