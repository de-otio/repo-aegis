// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// The rest of the pause's surface (complexity-review P1-E): `status` and `doctor` show an active pause (and only an
// active one, never the repository's name), and `uninstall` removes the state file, plain and with `--purge-home`.
// The pause file is written relative to the real clock with an hour of margin each way.
import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureOutput, withEnv } from "../_test-utils.js";
import { mintPause, pausePath } from "@de-otio/repo-aegis-core";
import { status } from "./status.js";
import { doctor } from "./doctor.js";
import { uninstall } from "./uninstall.js";

const HOUR = 3_600_000;
const NOTICE = /repo-aegis: paused until \d\d:\d\d(?:, cross-org checks stay on)? \(resume: repo-aegis resume\)/;

let tmp: string;
let originalCwd: string;
let n = 0;
before(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "repo-aegis-pause-surface-")));
  originalCwd = process.cwd();
});
after(() => {
  process.chdir(originalCwd);
  rmSync(tmp, { recursive: true, force: true });
});
afterEach(() => process.chdir(originalCwd));

type Kind = "active" | "expired" | "none" | "world-writable";

/** A home whose directory ends in `repo-aegis` (uninstall's purge guard needs that). */
function home(kind: Kind, repo?: string): string {
  const dir = join(tmp, `s${n++}`, "repo-aegis");
  mkdirSync(join(dir, "state"), { recursive: true });
  mkdirSync(join(dir, "markers"), { recursive: true });
  const path = pausePath(dir);
  const now = Date.now();
  const scope = repo !== undefined ? { repo } : {};
  if (kind === "active") mintPause({ path, now: new Date(now - 60_000), durationMs: HOUR, ...scope });
  if (kind === "expired") mintPause({ path, now: new Date(now - 2 * HOUR), durationMs: HOUR, ...scope });
  if (kind === "world-writable") {
    mintPause({ path, now: new Date(now - 60_000), durationMs: HOUR, ...scope });
    chmodSync(path, 0o666);
  }
  return dir;
}

function gitRepo(): string {
  const dir = join(tmp, `r${n++}`);
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  return dir;
}

describe("status shows an active pause", () => {
  it("JSON carries the expiry and the scope word, not the repository", () => {
    process.chdir(gitRepo());
    const r = withEnv("REPO_AEGIS_HOME", home("active", "acme/secret-svc"), () => captureOutput(() => status({ json: true })));
    const j = JSON.parse(r.stdout) as { pause?: { expiresAt: string; scope: string } };
    assert.equal(j.pause?.scope, "repository");
    assert.ok(j.pause?.expiresAt);
    assert.doesNotMatch(r.stdout, /secret-svc|acme/);
    const all = withEnv("REPO_AEGIS_HOME", home("active"), () => captureOutput(() => status({ json: true })));
    assert.equal((JSON.parse(all.stdout) as { pause?: { scope: string } }).pause?.scope, "all");
  });

  it("text prints the ACTIVE line and the fixed notice, and never the repository", () => {
    process.chdir(gitRepo());
    const r = withEnv("REPO_AEGIS_HOME", home("active", "acme/secret-svc"), () => captureOutput(() => status({})));
    assert.match(r.stdout, /pause: {4}ACTIVE for one repository until /);
    assert.match(r.stdout, NOTICE);
    assert.doesNotMatch(r.stdout, /secret-svc|acme/);
  });

  it("an expired, invalid or absent pause shows nothing", () => {
    process.chdir(gitRepo());
    for (const kind of ["expired", "world-writable", "none"] as const) {
      const r = withEnv("REPO_AEGIS_HOME", home(kind), () => captureOutput(() => status({ json: true })));
      assert.equal((JSON.parse(r.stdout) as { pause?: unknown }).pause, undefined, kind);
      const t = withEnv("REPO_AEGIS_HOME", home(kind), () => captureOutput(() => status({})));
      assert.doesNotMatch(t.stdout, /ACTIVE/, kind);
    }
  });
});

describe("doctor reports PAUSE_ACTIVE as a warning", () => {
  const emptyRoot = (): string => {
    const dir = join(tmp, `root${n++}`);
    mkdirSync(dir, { recursive: true });
    return dir;
  };
  type Machine = Array<{ code: string; ok: boolean; severity?: string; detail: string; fix?: string }>;

  it("a warning with the expiry and the way out; it does not fail the run, and --no-egress-checks does not hide it", () => {
    const r = withEnv("REPO_AEGIS_HOME", home("active", "acme/secret-svc"), () =>
      captureOutput(() => doctor({ scanRoot: [emptyRoot()], json: true, egressChecks: false })),
    );
    assert.notEqual(r.exitCode, 1, "a pause is a warning, not a failure");
    const j = JSON.parse(r.stdout) as { machine: Machine };
    const c = j.machine.find(m => m.code === "PAUSE_ACTIVE");
    assert.ok(c, "no PAUSE_ACTIVE finding");
    assert.equal(c.ok, false);
    assert.equal(c.severity, "warn");
    assert.match(c.detail, /paused for one repository until 20\d\d-/);
    assert.match(c.detail, NOTICE);
    assert.equal(c.fix, "repo-aegis resume");
    assert.doesNotMatch(r.stdout, /secret-svc|acme/);
  });

  it("the text report labels it WARN", () => {
    const r = withEnv("REPO_AEGIS_HOME", home("active"), () => captureOutput(() => doctor({ scanRoot: [emptyRoot()], egressChecks: false })));
    assert.match(r.stdout, /WARN PAUSE_ACTIVE — repo-aegis is paused for everything on this machine until /);
    // X-9: only FAIL lines get a `fix:` line; the warning's detail carries the way out itself.
    assert.match(r.stdout, /resume: repo-aegis resume/);
  });

  it("an expired, invalid or absent pause is not reported", () => {
    for (const kind of ["expired", "world-writable", "none"] as const) {
      const r = withEnv("REPO_AEGIS_HOME", home(kind), () => captureOutput(() => doctor({ scanRoot: [emptyRoot()], json: true, egressChecks: false })));
      assert.doesNotMatch(r.stdout, /PAUSE_ACTIVE/, kind);
    }
  });
});

describe("uninstall removes pause.json", () => {
  function withIsolation<T>(name: string, fn: () => T): T {
    const base = join(tmp, name);
    mkdirSync(base, { recursive: true });
    const overrides: Record<string, string> = {
      GIT_CONFIG_GLOBAL: join(base, "gitconfig-global"),
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    };
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

  it("a dry run reports it and removes nothing", () => {
    const h = home("active");
    const claudeHome = join(tmp, `claude${n++}`);
    mkdirSync(claudeHome, { recursive: true });
    const r = withIsolation("iso-dry", () =>
      withEnv("REPO_AEGIS_HOME", h, () => captureOutput(() => uninstall({ claudeHome, cwd: gitRepo(), json: true }))),
    );
    const step = (JSON.parse(r.stdout) as { steps: Array<{ step: string; details?: { wouldRemove?: string | null } }> }).steps.find(s => s.step === "remove pause.json");
    assert.equal(step?.details?.wouldRemove, pausePath(h));
    assert.equal(existsSync(pausePath(h)), true);
  });

  it("--yes removes the pause file and leaves the rest of the home", () => {
    const h = home("active");
    const claudeHome = join(tmp, `claude${n++}`);
    mkdirSync(claudeHome, { recursive: true });
    assert.equal(existsSync(pausePath(h)), true);
    const r = withIsolation("iso-yes", () =>
      withEnv("REPO_AEGIS_HOME", h, () => captureOutput(() => uninstall({ claudeHome, cwd: gitRepo(), yes: true, json: true }))),
    );
    const step = (JSON.parse(r.stdout) as { steps: Array<{ step: string; ok: boolean }> }).steps.find(s => s.step === "remove pause.json");
    assert.equal(step?.ok, true);
    assert.equal(existsSync(pausePath(h)), false);
    assert.equal(existsSync(h), true, "the home survives without --purge-home");
  });

  it("--yes --purge-home covers it too (the whole home goes)", () => {
    const h = home("active");
    const claudeHome = join(tmp, `claude${n++}`);
    mkdirSync(claudeHome, { recursive: true });
    withIsolation("iso-purge", () =>
      withEnv("REPO_AEGIS_HOME", h, () => captureOutput(() => uninstall({ claudeHome, cwd: gitRepo(), yes: true, purgeHome: true, json: true }))),
    );
    assert.equal(existsSync(pausePath(h)), false);
    assert.equal(existsSync(h), false);
  });

  it("with nothing to remove it still succeeds", () => {
    const h = home("none");
    const claudeHome = join(tmp, `claude${n++}`);
    mkdirSync(claudeHome, { recursive: true });
    writeFileSync(join(h, "engagements.yaml"), "engagements: []\n");
    const r = withIsolation("iso-none", () =>
      withEnv("REPO_AEGIS_HOME", h, () => captureOutput(() => uninstall({ claudeHome, cwd: gitRepo(), yes: true, json: true }))),
    );
    assert.equal(r.exitCode, undefined, r.stderr);
  });
});
