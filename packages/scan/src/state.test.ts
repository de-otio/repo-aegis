import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CURRENT_STATE_SCHEMA_VERSION,
  hitKey,
  loadState,
  saveStateAtomic,
} from "./state.js";

let tmp: string;

before(() => {
  tmp = mkdtempSync(join(tmpdir(), "repo-aegis-scan-state-test-"));
});

after(() => {
  rmSync(tmp, { recursive: true, force: true });
});

let path: string;

beforeEach(() => {
  path = join(tmp, `state-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
});

describe("loadState", () => {
  it("returns empty state when file is missing", () => {
    const s = loadState(path);
    assert.deepEqual(s.seen, {});
    assert.equal(s.lastRunIso, undefined);
    assert.equal(s.schemaVersion, CURRENT_STATE_SCHEMA_VERSION);
  });

  it("returns empty state when file is empty", () => {
    writeFileSync(path, "");
    const s = loadState(path);
    assert.deepEqual(s.seen, {});
    assert.equal(s.schemaVersion, CURRENT_STATE_SCHEMA_VERSION);
  });

  it("loads seen map and lastRunIso", () => {
    writeFileSync(
      path,
      JSON.stringify({
        schemaVersion: 1,
        seen: { "k1": true, "k2": true },
        lastRunIso: "2026-05-01T00:00:00Z",
      }),
    );
    const s = loadState(path);
    assert.deepEqual(Object.keys(s.seen).sort(), ["k1", "k2"]);
    assert.equal(s.lastRunIso, "2026-05-01T00:00:00Z");
    assert.equal(s.schemaVersion, 1);
  });

  it("loads legacy file (no schemaVersion) as v1", () => {
    writeFileSync(
      path,
      JSON.stringify({ seen: { "k1": true }, lastRunIso: "2026-05-01T00:00:00Z" }),
    );
    const s = loadState(path);
    assert.equal(s.schemaVersion, 1);
    assert.equal(s.seen["k1"], true);
  });

  it("throws on unsupported future schemaVersion", () => {
    writeFileSync(path, JSON.stringify({ schemaVersion: 99, seen: {} }));
    assert.throws(() => loadState(path), /schemaVersion 99/);
  });

  it("throws on invalid JSON", () => {
    writeFileSync(path, "{not valid json");
    assert.throws(() => loadState(path), /failed to parse/);
  });

  it("throws when state is not a JSON object", () => {
    writeFileSync(path, "[]");
    assert.throws(() => loadState(path), /must be a JSON object/);
  });
});

describe("saveStateAtomic", () => {
  it("writes the state file atomically (no .tmp left behind)", () => {
    saveStateAtomic(path, { seen: { "x": true }, lastRunIso: "2026-05-01T00:00:00Z" });
    assert.ok(existsSync(path));
    assert.ok(!existsSync(path + ".tmp"));
    const j = JSON.parse(readFileSync(path, "utf8")) as {
      schemaVersion: number;
      seen: Record<string, boolean>;
    };
    assert.equal(j.seen["x"], true);
    assert.equal(j.schemaVersion, CURRENT_STATE_SCHEMA_VERSION);
  });

  it("file mode is 0600", () => {
    saveStateAtomic(path, { seen: {} });
    const st = statSync(path);
    assert.equal(st.mode & 0o777, 0o600);
  });

  it("always writes the current schemaVersion", () => {
    // Even if caller passes no version (or a stale value), saver must
    // emit the current version.
    saveStateAtomic(path, { seen: {} });
    let j = JSON.parse(readFileSync(path, "utf8")) as { schemaVersion: number };
    assert.equal(j.schemaVersion, CURRENT_STATE_SCHEMA_VERSION);

    saveStateAtomic(path, { schemaVersion: 0, seen: {} });
    j = JSON.parse(readFileSync(path, "utf8")) as { schemaVersion: number };
    assert.equal(j.schemaVersion, CURRENT_STATE_SCHEMA_VERSION);
  });

  it("round-trips through load+save", () => {
    saveStateAtomic(path, { seen: { "a b c": true }, lastRunIso: "2026-05-01T00:00:00Z" });
    const s = loadState(path);
    assert.equal(s.seen["a b c"], true);
    assert.equal(s.lastRunIso, "2026-05-01T00:00:00Z");
    assert.equal(s.schemaVersion, CURRENT_STATE_SCHEMA_VERSION);
  });
});

describe("hitKey", () => {
  it("includes v1 prefix and joins query, repo, path, line by |", () => {
    assert.equal(hitKey("q", "owner/repo", "src/foo.ts", 12), "v1|q|owner/repo|src/foo.ts|12");
  });

  it("renders null line as empty", () => {
    assert.equal(hitKey("q", "o/r", "p", null), "v1|q|o/r|p|");
  });
});
