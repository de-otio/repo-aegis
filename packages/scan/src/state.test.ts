import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CURRENT_STATE_SCHEMA_VERSION,
  hitKey,
  loadState,
  pruneSeenOlderThan,
  saveStateAtomic,
  todayIsoDate,
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

  it("loads seen map and lastRunIso (v1 entries preserved as true)", () => {
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
    assert.equal(s.seen["k1"], true);
    assert.equal(s.seen["k2"], true);
    assert.equal(s.lastRunIso, "2026-05-01T00:00:00Z");
    assert.equal(s.schemaVersion, 1);
  });

  it("loads legacy file (no schemaVersion) as v1, with v1 entries kept as true", () => {
    writeFileSync(
      path,
      JSON.stringify({ seen: { "k1": true }, lastRunIso: "2026-05-01T00:00:00Z" }),
    );
    const s = loadState(path);
    assert.equal(s.schemaVersion, 1);
    assert.equal(s.seen["k1"], true);
  });

  it("loads v2 entries (ISO date strings) as-is", () => {
    writeFileSync(
      path,
      JSON.stringify({
        schemaVersion: 2,
        seen: { "old-key": "2026-01-15", "new-key": "2026-04-30" },
      }),
    );
    const s = loadState(path);
    assert.equal(s.schemaVersion, 2);
    assert.equal(s.seen["old-key"], "2026-01-15");
    assert.equal(s.seen["new-key"], "2026-04-30");
  });

  it("upgrades v1 (true) entries cleanly when stored alongside v2 (string) entries", () => {
    writeFileSync(
      path,
      JSON.stringify({
        schemaVersion: 1, // version is v1 but an editor / migration may have mixed shapes
        seen: { "legacy": true, "dated": "2026-04-01" },
      }),
    );
    const s = loadState(path);
    assert.equal(s.seen["legacy"], true);
    assert.equal(s.seen["dated"], "2026-04-01");
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
      seen: Record<string, boolean | string>;
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

  it("round-trips dated v2 entries through load+save", () => {
    saveStateAtomic(path, {
      seen: { "a b c": "2026-04-15", "legacy": true },
      lastRunIso: "2026-05-01T00:00:00Z",
    });
    const s = loadState(path);
    assert.equal(s.seen["a b c"], "2026-04-15");
    assert.equal(s.seen["legacy"], true);
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

describe("todayIsoDate", () => {
  it("returns YYYY-MM-DD format", () => {
    const d = todayIsoDate(new Date("2026-04-15T18:30:00Z"));
    assert.equal(d, "2026-04-15");
  });

  it("uses UTC, not local time", () => {
    const d = todayIsoDate(new Date(Date.UTC(2026, 3, 15, 23, 59, 59)));
    assert.equal(d, "2026-04-15");
  });
});

describe("pruneSeenOlderThan", () => {
  it("drops dated entries older than the cutoff", () => {
    const now = new Date("2026-05-01T00:00:00Z");
    const { state, pruned } = pruneSeenOlderThan(
      {
        seen: {
          "old": "2026-01-01", // 120d ago
          "fresh": "2026-04-25", // 6d ago
        },
      },
      30,
      now,
    );
    assert.equal(pruned, 1);
    assert.equal(state.seen["old"], undefined);
    assert.equal(state.seen["fresh"], "2026-04-25");
  });

  it("keeps `true`-valued entries (unknown first-seen date) conservatively", () => {
    const now = new Date("2026-05-01T00:00:00Z");
    const { state, pruned } = pruneSeenOlderThan(
      {
        seen: {
          "legacy": true,
          "old-dated": "2025-01-01",
        },
      },
      30,
      now,
    );
    // old-dated dropped; legacy retained because we don't know when it was first seen.
    assert.equal(pruned, 1);
    assert.equal(state.seen["legacy"], true);
    assert.equal(state.seen["old-dated"], undefined);
  });

  it("returns the same shape (preserves lastRunIso, schemaVersion)", () => {
    const now = new Date("2026-05-01T00:00:00Z");
    const { state } = pruneSeenOlderThan(
      {
        schemaVersion: 2,
        seen: { "k": "2026-04-30" },
        lastRunIso: "2026-04-30T00:00:00Z",
      },
      30,
      now,
    );
    assert.equal(state.schemaVersion, 2);
    assert.equal(state.lastRunIso, "2026-04-30T00:00:00Z");
    assert.equal(state.seen["k"], "2026-04-30");
  });

  it("keeps malformed date values rather than silently dropping them", () => {
    const now = new Date("2026-05-01T00:00:00Z");
    const { state, pruned } = pruneSeenOlderThan(
      {
        seen: { "garbage": "not-a-date" },
      },
      30,
      now,
    );
    assert.equal(pruned, 0);
    assert.equal(state.seen["garbage"], "not-a-date");
  });

  it("rejects negative or non-finite olderThanDays", () => {
    assert.throws(() => pruneSeenOlderThan({ seen: {} }, -1), /non-negative/);
    assert.throws(() => pruneSeenOlderThan({ seen: {} }, NaN), /non-negative/);
  });

  it("with olderThanDays=0, drops every dated entry but keeps `true` entries", () => {
    const now = new Date("2026-05-01T00:00:00Z");
    const { state, pruned } = pruneSeenOlderThan(
      {
        seen: { "today": "2026-05-01", "yesterday": "2026-04-30", "legacy": true },
      },
      0,
      now,
    );
    // today is exactly at cutoff (>=) so kept; yesterday dropped; legacy kept.
    assert.equal(pruned, 1);
    assert.equal(state.seen["today"], "2026-05-01");
    assert.equal(state.seen["yesterday"], undefined);
    assert.equal(state.seen["legacy"], true);
  });
});
