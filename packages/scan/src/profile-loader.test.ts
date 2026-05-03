// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAllProfiles } from "./profile-loader.js";

function makeHome(): string {
  return mkdtempSync(join(tmpdir(), "aegis-profile-loader-"));
}

function writeJson(home: string, engagementId: string, body: unknown): void {
  const dir = join(home, "profiles");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${engagementId}.json`), JSON.stringify(body, null, 2));
}

const validBody = {
  schemaVersion: 1,
  engagementId: "ok",
  modelId: "test",
  createdAt: "2026-05-01T00:00:00Z",
  threshold: 0.78,
  vectors: [[0, 1, 0]],
  sourceManifest: [
    { path: "doc.md", sha256: "0".repeat(64), bytes: 4 },
  ],
};

describe("loadAllProfiles", () => {
  it("returns empty profiles + errors when profiles dir does not exist", () => {
    const home = makeHome();
    const r = loadAllProfiles(home);
    assert.deepEqual(r, { profiles: [], errors: [] });
  });

  it("loads valid profiles and converts engagementId from filename", () => {
    const home = makeHome();
    writeJson(home, "customer-a", { ...validBody, engagementId: "customer-a" });
    writeJson(home, "customer-b", { ...validBody, engagementId: "customer-b" });
    const r = loadAllProfiles(home);
    assert.equal(r.profiles.length, 2);
    const ids = r.profiles.map(p => p.engagementId).sort();
    assert.deepEqual(ids, ["customer-a", "customer-b"]);
  });

  it("collects per-file errors but keeps loading the rest", () => {
    const home = makeHome();
    writeJson(home, "good", { ...validBody, engagementId: "good" });
    // Bad: invalid JSON.
    const dir = join(home, "profiles");
    writeFileSync(join(dir, "bad.json"), "not json");
    // Bad: schema mismatch (vectors must be number[][]).
    writeFileSync(
      join(dir, "schema-bad.json"),
      JSON.stringify({ ...validBody, engagementId: "schema-bad", vectors: "nope" }),
    );
    const r = loadAllProfiles(home);
    assert.equal(r.profiles.length, 1);
    assert.equal(r.profiles[0]!.engagementId, "good");
    assert.equal(r.errors.length, 2);
    const ids = r.errors.map(e => e.engagementId).sort();
    assert.deepEqual(ids, ["bad", "schema-bad"]);
  });

  it("ignores .tmp.* sidecar files left by atomic writes", () => {
    const home = makeHome();
    writeJson(home, "real", { ...validBody, engagementId: "real" });
    const dir = join(home, "profiles");
    writeFileSync(join(dir, "real.json.tmp.99999.123"), "garbage");
    const r = loadAllProfiles(home);
    assert.equal(r.profiles.length, 1);
    assert.equal(r.errors.length, 0);
  });

  it("ignores non-.json files", () => {
    const home = makeHome();
    writeJson(home, "real", { ...validBody, engagementId: "real" });
    const dir = join(home, "profiles");
    writeFileSync(join(dir, "README.md"), "# notes");
    const r = loadAllProfiles(home);
    assert.equal(r.profiles.length, 1);
    assert.equal(r.errors.length, 0);
  });
});
