// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// The managed drop-in's SessionStart heartbeat (doc/plan-pin-enforcement-binary.md
// D8.12): it records a timestamp under state/ and never fails a session.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withEnv } from "../_test-utils.js";
import { cliBuilt, cliPath } from "../_subprocess-utils.js";
import { recordManagedHeartbeat } from "./hook-managed-heartbeat.js";
import { managedHeartbeatPath } from "./managed-ledger.js";

let tmp: string;
before(() => {
  tmp = mkdtempSync(join(tmpdir(), "repo-aegis-heartbeat-"));
});
after(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("recordManagedHeartbeat", () => {
  it("writes the time as ISO 8601 to state/managed-hooks-seen, creating state/", () => {
    const home = join(tmp, "a");
    withEnv("REPO_AEGIS_HOME", home, () => {
      recordManagedHeartbeat(new Date(Date.UTC(2026, 10, 4, 12, 0, 0)));
      assert.equal(readFileSync(managedHeartbeatPath(), "utf8"), "2026-11-04T12:00:00.000Z\n");
      assert.equal(managedHeartbeatPath(), join(home, "state", "managed-hooks-seen"));
    });
  });

  it("overwrites an older heartbeat", () => {
    const home = join(tmp, "b");
    withEnv("REPO_AEGIS_HOME", home, () => {
      recordManagedHeartbeat(new Date(1000));
      recordManagedHeartbeat(new Date(2000));
      assert.equal(readFileSync(managedHeartbeatPath(), "utf8"), "1970-01-01T00:00:02.000Z\n");
    });
  });

  it("never throws, even when the state directory cannot be created", () => {
    const blocker = join(tmp, "not-a-dir");
    writeFileSync(blocker, "x");
    withEnv("REPO_AEGIS_HOME", blocker, () => {
      assert.doesNotThrow(() => recordManagedHeartbeat());
    });
  });
});

describe("hook managed-heartbeat (subprocess)", { skip: cliBuilt() ? undefined : "built CLI not found" }, () => {
  it("exits 0, prints nothing and records the heartbeat, with the SessionStart payload on stdin", () => {
    const home = join(tmp, "c");
    mkdirSync(home, { recursive: true });
    const r = spawnSync(process.execPath, [cliPath, "hook", "managed-heartbeat"], {
      input: JSON.stringify({ hook_event_name: "SessionStart", source: "startup" }),
      encoding: "utf8",
      env: { ...process.env, REPO_AEGIS_HOME: home },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, "");
    assert.ok(existsSync(join(home, "state", "managed-hooks-seen")));
    assert.ok(!Number.isNaN(Date.parse(readFileSync(join(home, "state", "managed-hooks-seen"), "utf8").trim())));
  });
});
