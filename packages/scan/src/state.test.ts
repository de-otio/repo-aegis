import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hitKey, loadState, saveStateAtomic } from "./state.js";

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
  });

  it("returns empty state when file is empty", () => {
    writeFileSync(path, "");
    const s = loadState(path);
    assert.deepEqual(s.seen, {});
  });

  it("loads seen map and lastRunIso", () => {
    writeFileSync(
      path,
      JSON.stringify({ seen: { "k1": true, "k2": true }, lastRunIso: "2026-05-01T00:00:00Z" }),
    );
    const s = loadState(path);
    assert.deepEqual(Object.keys(s.seen).sort(), ["k1", "k2"]);
    assert.equal(s.lastRunIso, "2026-05-01T00:00:00Z");
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
    const j = JSON.parse(readFileSync(path, "utf8")) as { seen: Record<string, boolean> };
    assert.equal(j.seen["x"], true);
  });

  it("file mode is 0600", () => {
    saveStateAtomic(path, { seen: {} });
    const st = statSync(path);
    assert.equal(st.mode & 0o777, 0o600);
  });

  it("round-trips through load+save", () => {
    saveStateAtomic(path, { seen: { "a b c": true }, lastRunIso: "2026-05-01T00:00:00Z" });
    const s = loadState(path);
    assert.equal(s.seen["a b c"], true);
    assert.equal(s.lastRunIso, "2026-05-01T00:00:00Z");
  });
});

describe("hitKey", () => {
  it("includes query, repo, path, and line joined by |", () => {
    assert.equal(hitKey("q", "owner/repo", "src/foo.ts", 12), "q|owner/repo|src/foo.ts|12");
  });

  it("renders null line as empty", () => {
    assert.equal(hitKey("q", "o/r", "p", null), "q|o/r|p|");
  });
});
