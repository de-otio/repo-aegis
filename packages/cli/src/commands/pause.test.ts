// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// `repo-aegis pause` / `pause --list` / `resume` (complexity-review P1-E): the terminal gate, the cap, the state file
// and the audit trail. The clock is pinned; placeholder owners only.
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureOutput, withEnv, PERSON_ANCESTRY, UNDER_CLAUDE_ANCESTRY } from "../_test-utils.js";
import { auditLogPath, MAX_PAUSE_MS, pausePath, readPause } from "@de-otio/repo-aegis-core";
import { pause, resume, type PauseOptions } from "./pause.js";

const T0 = new Date("2026-11-10T12:00:00.000Z");
const HOUR = 3_600_000;

describe("pause / resume", () => {
  let root: string;
  let home: string;
  let path: string;

  before(() => {
    root = mkdtempSync(join(tmpdir(), "repo-aegis-pause-cmd-"));
  });
  after(() => rmSync(root, { recursive: true, force: true }));
  beforeEach(() => {
    home = join(root, `h${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(home, "state"), { recursive: true });
    // The audit log is opt-in: switch it on so the records are checkable.
    writeFileSync(join(home, "state", "audit-log.json"), JSON.stringify({ enabled: true }));
    path = pausePath(home);
  });

  const audit = (): Array<{ action: string; details?: Record<string, unknown> }> =>
    existsSync(auditLogPath(home))
      ? readFileSync(auditLogPath(home), "utf8")
          .split("\n")
          .filter(l => l !== "")
          .map(l => JSON.parse(l) as { action: string; details?: Record<string, unknown> })
      : [];

  function runPause(opts: Partial<PauseOptions> = {}, env: string | undefined = undefined) {
    return withEnv("REPO_AEGIS_HOME", home, () =>
      withEnv("REPO_AEGIS_EGRESS_HUMAN", env, () =>
        captureOutput(() => pause({ path, now: () => T0, stderrIsTTY: true, ...opts })),
      ),
    );
  }
  const runResume = (now: Date = T0, opts: { json?: boolean } = {}) =>
    withEnv("REPO_AEGIS_HOME", home, () => captureOutput(() => resume({ path, now: () => now, ...opts })));

  it("refuses without a TTY, and the env escape does not help; nothing is written", () => {
    const r = runPause({ stderrIsTTY: false, json: true }, "1");
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr, /PAUSE_NEEDS_TTY/);
    assert.match(r.stderr, /never switch repo-aegis off for itself/);
    assert.equal(existsSync(path), false);
  });

  it("refuses under an agent host even with a terminal attached (a pty wrapper is not a person)", () => {
    const r = runPause({ stderrIsTTY: true, ancestry: () => UNDER_CLAUDE_ANCESTRY, env: {}, json: true });
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr, /PAUSE_NEEDS_TTY/);
    assert.equal(existsSync(path), false);
  });

  it("a person's terminal (a login session at the root) may pause", () => {
    const r = runPause({ stderrIsTTY: true, ancestry: () => PERSON_ANCESTRY, env: {}, json: true });
    assert.equal(r.exitCode, undefined, r.stderr);
    assert.equal(readPause({ path, now: T0 }).kind, "active");
  });

  it("the gate runs before any validation: a bad --for does not tell a non-person anything", () => {
    const r = runPause({ stderrIsTTY: false, for: "9h", json: true });
    assert.match(r.stderr, /PAUSE_NEEDS_TTY/);
    assert.doesNotMatch(r.stderr, /PAUSE_TOO_LONG/);
  });

  it("defaults to one hour for everything on this machine, mode 0600", () => {
    const r = runPause({ json: true });
    assert.equal(r.exitCode, undefined, r.stderr);
    const j = JSON.parse(r.stdout) as { pause: { createdAt: string; expiresAt: string; repo?: string } };
    assert.equal(j.pause.expiresAt, new Date(T0.getTime() + HOUR).toISOString());
    assert.equal(j.pause.repo, undefined);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    const text = runPause();
    assert.match(text.stdout, /everything on this machine/);
    assert.match(text.stdout, /repo-aegis: paused until \d\d:\d\d \(resume: repo-aegis resume\)/);
  });

  it("--for 9h is refused as PAUSE_TOO_LONG; 8h is the most; nothing is written for the refusal", () => {
    const r = runPause({ for: "9h", json: true });
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr, /PAUSE_TOO_LONG/);
    assert.equal(existsSync(path), false);
    for (const over of ["481m", "1d", "28801s"]) assert.equal(runPause({ for: over, json: true }).exitCode, 2, over);
    const ok = runPause({ for: "8h", json: true });
    assert.equal(ok.exitCode, undefined, ok.stderr);
    const s = readPause({ path, now: T0 });
    assert.equal(s.kind, "active");
    if (s.kind === "active") assert.equal(Date.parse(s.state.expiresAt) - T0.getTime(), MAX_PAUSE_MS);
  });

  it("--for must parse; --repo must be owner/repo (no wildcard); reasons are optional", () => {
    for (const bad of ["soon", "0", "-1h", ""]) assert.match(runPause({ for: bad, json: true }).stderr, /USAGE/, bad);
    for (const bad of ["acme", "acme/*", "*", "a/b/c", "https://github.com/acme/svc"]) {
      assert.match(runPause({ repo: bad, json: true }).stderr, /USAGE/, bad);
    }
    assert.equal(existsSync(path), false);
  });

  it("--repo scopes the pause and lower-cases it", () => {
    const r = runPause({ repo: "Acme/Svc", for: "30m", json: true });
    assert.equal(r.exitCode, undefined, r.stderr);
    const s = readPause({ path, now: T0 });
    assert.equal(s.kind === "active" && s.state.repo, "acme/svc");
  });

  it("the audit log gets a `pause` record with the scope, expiry and the reason's LENGTH, never its text", () => {
    const secret = "customer-zeta outage, ship the fix";
    const r = runPause({ repo: "acme/svc", reason: secret, json: true });
    assert.equal(r.exitCode, undefined, r.stderr);
    const rec = audit().find(a => a.action === "pause");
    assert.ok(rec, "no pause record");
    assert.equal(rec.details?.["scope"], "acme/svc");
    assert.equal(rec.details?.["reasonLength"], secret.length);
    assert.equal(rec.details?.["expiresAt"], new Date(T0.getTime() + HOUR).toISOString());
    assert.doesNotMatch(readFileSync(auditLogPath(home), "utf8"), /zeta/);
    assert.doesNotMatch(readFileSync(path, "utf8"), /zeta/);
    assert.doesNotMatch(r.stdout + r.stderr, /zeta/);
  });

  it("resume ends it at once, and both records are in the audit log", () => {
    runPause({ json: true });
    assert.equal(readPause({ path, now: T0 }).kind, "active");
    const r = runResume(new Date(T0.getTime() + 60_000), { json: true });
    assert.equal(r.exitCode, undefined, r.stderr);
    assert.equal((JSON.parse(r.stdout) as { resumed: boolean }).resumed, true);
    assert.equal(readPause({ path, now: T0 }).kind, "none");
    const actions = audit().map(a => a.action);
    assert.deepEqual(actions.filter(a => a === "pause" || a === "resume"), ["pause", "resume"]);
    assert.equal(audit().find(a => a.action === "resume")?.details?.["cause"], "resume");
  });

  it("resume needs no terminal (it only turns protection back on) and prints no scope", () => {
    runPause({ repo: "acme/svc" });
    const r = runResume();
    assert.equal(r.exitCode, undefined, r.stderr);
    assert.match(r.stdout, /repo-aegis is protecting again/);
    assert.doesNotMatch(r.stdout + r.stderr, /acme/);
  });

  it("resume with nothing active says so", () => {
    const r = runResume();
    assert.equal(r.exitCode, undefined);
    assert.match(r.stdout, /no pause is active/);
  });

  it("an expired pause is retired by the next command, with the `resume` record the audit trail owes", () => {
    runPause({ for: "30m", json: true });
    const later = new Date(T0.getTime() + 2 * HOUR);
    const r = runResume(later);
    assert.match(r.stdout, /had already expired/);
    assert.equal(existsSync(path), false);
    const resumes = audit().filter(a => a.action === "resume");
    assert.equal(resumes.length, 1);
    assert.equal(resumes[0]!.details?.["cause"], "expired");
  });

  it("pausing again after an expiry records the expiry once and then the new pause", () => {
    runPause({ for: "30m" });
    withEnv("REPO_AEGIS_HOME", home, () =>
      captureOutput(() => pause({ path, now: () => new Date(T0.getTime() + 2 * HOUR), stderrIsTTY: true })),
    );
    const actions = audit().map(a => a.action);
    assert.deepEqual(actions, ["pause", "resume", "pause"]);
  });

  it("--list shows the active pause (and the repo, to the person), and nothing when there is none", () => {
    assert.match(runPause({ list: true }).stdout, /no active pause/);
    runPause({ repo: "acme/svc" });
    const text = runPause({ list: true });
    assert.match(text.stdout, /acme\/svc until /);
    const j = JSON.parse(runPause({ list: true, json: true }).stdout) as { active: { repo: string } | null };
    assert.equal(j.active?.repo, "acme/svc");
  });

  it("--list needs no terminal to read (the agent hook refuses the command text instead)", () => {
    runPause({ repo: "acme/svc" });
    assert.equal(runPause({ list: true, stderrIsTTY: false }).exitCode, undefined);
  });

  it("an invalid file is reported as ignored by --list and removed by resume", () => {
    writeFileSync(path, "{}", { mode: 0o666 });
    assert.match(runPause({ list: true }).stdout, /ignored/);
    assert.match(runResume().stdout, /failed its checks/);
    assert.equal(existsSync(path), false);
    assert.deepEqual(audit().filter(a => a.action === "resume"), []);
  });
});
