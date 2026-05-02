// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureOutput } from "../_test-utils.js";

// ---------------------------------------------------------------------------
// Setup: point REPO_AEGIS_HOME at a fresh tmpdir for every test
// ---------------------------------------------------------------------------

let tmp: string;
let home: string;
let originalHome: string | undefined;

before(() => {
  tmp = mkdtempSync(join(tmpdir(), "repo-aegis-ctx-test-"));
});

after(() => {
  rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
  // Fresh home subdir for each test so tests are fully isolated
  home = mkdtempSync(join(tmp, "home-"));
  originalHome = process.env["REPO_AEGIS_HOME"];
  process.env["REPO_AEGIS_HOME"] = home;
});

// Restore env after each test (node:test doesn't have afterEach, so we
// restore inline at end of each it() via try/finally via the beforeEach
// approach — use a helper instead).
function restoreHome(): void {
  if (originalHome === undefined) {
    delete process.env["REPO_AEGIS_HOME"];
  } else {
    process.env["REPO_AEGIS_HOME"] = originalHome;
  }
}

// ---------------------------------------------------------------------------
// Dynamic import so REPO_AEGIS_HOME is set before module resolves paths
// ---------------------------------------------------------------------------
// We import the functions after env is set in each test. Because ESM caches
// modules, we import once at the top level after env is ready. Since
// leakContextFlagPath() reads the env at call-time (not module-load-time),
// this is fine — the flag path is computed on each call.

import { contextOn, contextOff, contextStatus } from "./context.js";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("context", () => {
  describe("context status", () => {
    it("reports isOn=false when flag absent (text)", () => {
      const { stdout } = captureOutput(() => contextStatus({}));
      assert.match(stdout, /leak-context strict mode is off/);
      restoreHome();
    });

    it("reports isOn=false when flag absent (json)", () => {
      const { stdout } = captureOutput(() => contextStatus({ json: true }));
      const parsed = JSON.parse(stdout) as { action: string; flagPath: string; isOn: boolean };
      assert.equal(parsed.action, "context-status");
      assert.equal(parsed.isOn, false);
      assert.ok(parsed.flagPath.includes("leak-context-mode"));
      restoreHome();
    });
  });

  describe("context on", () => {
    it("creates the flag file", () => {
      captureOutput(() => contextOn({}));
      const flagPath = join(home, "state", "leak-context-mode");
      assert.ok(existsSync(flagPath), "flag file should exist after context on");
      restoreHome();
    });

    it("reports wasOn=false, isOn=true on first call (json)", () => {
      const { stdout } = captureOutput(() => contextOn({ json: true }));
      const parsed = JSON.parse(stdout) as {
        action: string;
        flagPath: string;
        wasOn: boolean;
        isOn: boolean;
      };
      assert.equal(parsed.action, "context-on");
      assert.equal(parsed.wasOn, false);
      assert.equal(parsed.isOn, true);
      restoreHome();
    });

    it("context on then context status reports isOn=true", () => {
      captureOutput(() => contextOn({}));
      const { stdout } = captureOutput(() => contextStatus({ json: true }));
      const parsed = JSON.parse(stdout) as { isOn: boolean };
      assert.equal(parsed.isOn, true);
      restoreHome();
    });

    it("is idempotent — calling twice does not error", () => {
      captureOutput(() => contextOn({}));
      // Second call must not throw
      assert.doesNotThrow(() => captureOutput(() => contextOn({})));
      // Flag must still exist
      assert.ok(existsSync(join(home, "state", "leak-context-mode")));
      restoreHome();
    });

    it("idempotent second call reports wasOn=true (json)", () => {
      captureOutput(() => contextOn({}));
      const { stdout } = captureOutput(() => contextOn({ json: true }));
      const parsed = JSON.parse(stdout) as { wasOn: boolean; isOn: boolean };
      assert.equal(parsed.wasOn, true);
      assert.equal(parsed.isOn, true);
      restoreHome();
    });
  });

  describe("context off", () => {
    it("removes the flag file", () => {
      captureOutput(() => contextOn({}));
      const flagPath = join(home, "state", "leak-context-mode");
      assert.ok(existsSync(flagPath), "precondition: flag must exist");
      captureOutput(() => contextOff({}));
      assert.equal(existsSync(flagPath), false, "flag file should be gone after context off");
      restoreHome();
    });

    it("reports wasOn=true, isOn=false (json)", () => {
      captureOutput(() => contextOn({}));
      const { stdout } = captureOutput(() => contextOff({ json: true }));
      const parsed = JSON.parse(stdout) as {
        action: string;
        wasOn: boolean;
        isOn: boolean;
      };
      assert.equal(parsed.action, "context-off");
      assert.equal(parsed.wasOn, true);
      assert.equal(parsed.isOn, false);
      restoreHome();
    });

    it("is idempotent when already off — does not error", () => {
      assert.doesNotThrow(() => captureOutput(() => contextOff({})));
      restoreHome();
    });

    it("idempotent off reports wasOn=false (json)", () => {
      const { stdout } = captureOutput(() => contextOff({ json: true }));
      const parsed = JSON.parse(stdout) as { wasOn: boolean; isOn: boolean };
      assert.equal(parsed.wasOn, false);
      assert.equal(parsed.isOn, false);
      restoreHome();
    });
  });

  describe("text output", () => {
    it("context on prints enabled message", () => {
      const { stdout } = captureOutput(() => contextOn({}));
      assert.match(stdout, /leak-context strict mode enabled/);
      restoreHome();
    });

    it("context on prints already-on message when called twice", () => {
      captureOutput(() => contextOn({}));
      const { stdout } = captureOutput(() => contextOn({}));
      assert.match(stdout, /already on/);
      restoreHome();
    });

    it("context off prints disabled message", () => {
      captureOutput(() => contextOn({}));
      const { stdout } = captureOutput(() => contextOff({}));
      assert.match(stdout, /leak-context strict mode disabled/);
      restoreHome();
    });

    it("context off prints already-off message when already off", () => {
      const { stdout } = captureOutput(() => contextOff({}));
      assert.match(stdout, /already off/);
      restoreHome();
    });

    it("context status prints on/off state", () => {
      const { stdout: off } = captureOutput(() => contextStatus({}));
      assert.match(off, /off/);
      captureOutput(() => contextOn({}));
      const { stdout: on } = captureOutput(() => contextStatus({}));
      assert.match(on, / on/);
      restoreHome();
    });
  });
});
