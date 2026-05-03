// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addMarkerPattern, addMarkerPatterns } from "./registry-mutate.js";
import {
  EngagementNotFoundError,
  PatternValidationError,
} from "./exceptions.js";

let tmp: string;
let home: string;
let registryPath: string;

const STUB = `\
schemaVersion: 2
always_block: []
engagements:
  - id: foo-corp
    name: Foo Corp
    started: 2026-01-01
    markers: [\\bfoo\\b]
  - id: bar-co
    name: Bar Co
    started: 2026-01-15
    markers: []
`;

before(() => {
  tmp = mkdtempSync(join(tmpdir(), "repo-aegis-registry-mutate-"));
  home = join(tmp, "home");
  registryPath = join(home, "engagements.yaml");
});

after(() => {
  rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
  rmSync(home, { recursive: true, force: true });
  mkdirSync(join(home, "markers"), { recursive: true });
  mkdirSync(join(home, "state"), { recursive: true });
  writeFileSync(registryPath, STUB);
  process.env["REPO_AEGIS_HOME"] = home;
});

describe("addMarkerPattern — happy path", () => {
  it("appends a single pattern and renders markers", () => {
    const result = addMarkerPattern("bar-co", "\\bbar-co\\b", { registryPath });
    assert.deepEqual(result.added, ["\\bbar-co\\b"]);
    assert.deepEqual(result.skipped, []);
    const reg = readFileSync(registryPath, "utf8");
    assert.match(reg, /\\bbar-co\\b/);
  });

  it("idempotent — re-adding the same pattern is a no-op", () => {
    addMarkerPattern("bar-co", "\\bbar-co\\b", { registryPath });
    const r2 = addMarkerPattern("bar-co", "\\bbar-co\\b", { registryPath });
    assert.deepEqual(r2.added, []);
    assert.deepEqual(r2.skipped, ["\\bbar-co\\b"]);
  });
});

describe("addMarkerPatterns — bulk add", () => {
  it("appends multiple patterns with mixed new/duplicate handling", () => {
    addMarkerPattern("bar-co", "\\bbar-co\\b", { registryPath });
    const result = addMarkerPatterns(
      "bar-co",
      ["\\bbar-co\\b", "\\bbar\\.example\\b", "\\bBC-[0-9]+\\b"],
      { registryPath },
    );
    assert.equal(result.added.length, 2);
    assert.equal(result.skipped.length, 1);
    assert.ok(result.added.includes("\\bbar\\.example\\b"));
    assert.ok(result.added.includes("\\bBC-[0-9]+\\b"));
  });
});

describe("addMarkerPatterns — error paths", () => {
  it("throws EngagementNotFoundError for unknown id", () => {
    assert.throws(
      () => addMarkerPattern("nonexistent", "\\bfoo\\b", { registryPath }),
      EngagementNotFoundError,
    );
  });

  it("throws PatternValidationError on invalid regex", () => {
    assert.throws(
      () => addMarkerPattern("foo-corp", "(?<unclosed", { registryPath }),
      PatternValidationError,
    );
  });

  it("validates ALL patterns before mutating any", () => {
    // First pattern good, second bad — registry must be unchanged.
    const before = readFileSync(registryPath, "utf8");
    assert.throws(
      () =>
        addMarkerPatterns("bar-co", ["\\bgood\\b", "(?<bad"], { registryPath }),
      PatternValidationError,
    );
    const after = readFileSync(registryPath, "utf8");
    assert.equal(before, after);
  });
});

describe("addMarkerPatterns — [SEC M-3] lock scope", () => {
  it("two parallel calls on different engagements both succeed without lost updates", async () => {
    // Run two adds concurrently — using Promise.all as a parallel-ish
    // proxy. The lock is sync (withLockSync), so they will serialise via
    // proper-lockfile. Asserting both sets land is the correctness goal.
    const a = Promise.resolve().then(() =>
      addMarkerPatterns("foo-corp", ["\\bnew-foo\\b"], { registryPath }),
    );
    const b = Promise.resolve().then(() =>
      addMarkerPatterns("bar-co", ["\\bnew-bar\\b"], { registryPath }),
    );
    const [ra, rb] = await Promise.all([a, b]);
    assert.deepEqual(ra.added, ["\\bnew-foo\\b"]);
    assert.deepEqual(rb.added, ["\\bnew-bar\\b"]);
    const reg = readFileSync(registryPath, "utf8");
    assert.match(reg, /\\bnew-foo\\b/);
    assert.match(reg, /\\bnew-bar\\b/);
  });
});
