// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { denySetFloorShortfall, resolveMinPatterns } from "./deny-set-floor.js";

const NO_ENV = {} as NodeJS.ProcessEnv;

describe("resolveMinPatterns", () => {
  it("is 0 with no flag and no env", () => {
    assert.equal(resolveMinPatterns({}, NO_ENV), 0);
  });

  it("--min-patterns wins over --require-deny-set and over env", () => {
    assert.equal(resolveMinPatterns({ minPatterns: 3, requireDenySet: true }, { REPO_AEGIS_MIN_PATTERNS: "9" }), 3);
  });

  it("--min-patterns 0 is an explicit opt-out, even when env asks for a floor", () => {
    assert.equal(resolveMinPatterns({ minPatterns: 0 }, { REPO_AEGIS_MIN_PATTERNS: "5" }), 0);
  });

  it("--require-deny-set means 1 and beats env", () => {
    assert.equal(resolveMinPatterns({ requireDenySet: true }, { REPO_AEGIS_MIN_PATTERNS: "5" }), 1);
  });

  it("reads REPO_AEGIS_MIN_PATTERNS, ignoring empty, zero, negative and junk", () => {
    assert.equal(resolveMinPatterns({}, { REPO_AEGIS_MIN_PATTERNS: "4" }), 4);
    for (const bad of ["", "0", "-2", "many"]) {
      assert.equal(resolveMinPatterns({}, { REPO_AEGIS_MIN_PATTERNS: bad }), 0, `env=${JSON.stringify(bad)}`);
    }
  });

  it("clamps a negative or fractional flag value", () => {
    assert.equal(resolveMinPatterns({ minPatterns: -4 }, NO_ENV), 0);
    assert.equal(resolveMinPatterns({ minPatterns: 2.9 }, NO_ENV), 2);
  });
});

describe("denySetFloorShortfall", () => {
  it("is null when no floor is set, however small the deny set", () => {
    assert.equal(denySetFloorShortfall(0, 0, {}, NO_ENV), null);
  });

  it("is null at exactly the floor and an error one below it", () => {
    assert.equal(denySetFloorShortfall(3, 1, { minPatterns: 3 }, NO_ENV), null);
    const s = denySetFloorShortfall(2, 1, { minPatterns: 3 }, NO_ENV);
    assert.ok(s);
    assert.equal(s.code, "DENY_SET_BELOW_FLOOR");
    assert.deepEqual(s.details, { patternCount: 2, minPatterns: 3, markerFiles: 1 });
  });

  it("an empty deny set under --require-deny-set is the fork-PR case it exists for", () => {
    const s = denySetFloorShortfall(0, 0, { requireDenySet: true }, NO_ENV);
    assert.ok(s);
    assert.match(s.error, /a fork PR cannot read secrets/);
  });
});
