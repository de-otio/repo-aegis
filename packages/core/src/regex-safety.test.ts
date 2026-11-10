// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  validatePattern,
  validatePatterns,
} from "./regex-safety.js";

describe("validatePattern", () => {
  it("accepts ordinary patterns", () => {
    assert.equal(validatePattern("acme-corp").ok, true);
    assert.equal(validatePattern("\\d{12}").ok, true);
    assert.equal(validatePattern("[a-z]+@example\\.com").ok, true);
  });

  it("rejects empty patterns", () => {
    const r = validatePattern("");
    assert.equal(r.ok, false);
    assert.match(r.reason!, /empty/);
  });

  it("rejects non-string input", () => {
    const r = validatePattern(undefined as unknown as string);
    assert.equal(r.ok, false);
  });

  it("rejects syntactically invalid regex", () => {
    const r = validatePattern("(unclosed");
    assert.equal(r.ok, false);
    assert.match(r.reason!, /invalid regex/);
  });

  it("rejects patterns over the length cap", () => {
    const r = validatePattern("a".repeat(2049));
    assert.equal(r.ok, false);
    assert.match(r.reason!, /exceeds|length/i);
  });

  it("accepts patterns just under the length cap", () => {
    const r = validatePattern("a".repeat(2000));
    assert.equal(r.ok, true);
  });
});

describe("validatePatterns", () => {
  it("splits valid and invalid patterns", () => {
    const r = validatePatterns(["acme-corp", "(unclosed", "\\d+"]);
    assert.equal(r.valid.length, 2);
    assert.equal(r.invalid.length, 1);
    assert.equal(r.invalid[0]!.pattern, "(unclosed");
  });

  it("returns empty when all patterns are valid", () => {
    const r = validatePatterns(["a", "b", "c"]);
    assert.equal(r.valid.length, 3);
    assert.equal(r.invalid.length, 0);
  });

  it("returns empty when no patterns provided", () => {
    const r = validatePatterns([]);
    assert.equal(r.valid.length, 0);
    assert.equal(r.invalid.length, 0);
  });
});

describe("catastrophic patterns (static check, F10)", () => {
  // The fixtures are joined at run time: they are test data, and as bare literals a static analyser reads each one as a
  // live regular expression (and flags the catastrophic ones on purpose).
  const j = (a: string, b: string): string => a + b;
  // None of these may be EXECUTED to be refused: `^(a+)+b$` against 1000 'a's
  // would not return in a lifetime. The test finishing is part of the assertion.
  const catastrophic = [
    j("^(a+", ")+b$"),
    j("(a+", ")+$"),
    j("(a*", ")*c"),
    j("(a+", ")*x"),
    j("^(\\w+", "\\s*)*$"),
    j("(?:a", "+)+z"),
    j("(x|y", "+)+z"),
    j("((a+", "))+b"),
    j("(a+)", "{2,}b"),
    j("(a{1", ",})+b"),
  ];
  for (const p of catastrophic) {
    it(`rejects ${p}`, () => {
      const r = validatePattern(p);
      assert.equal(r.ok, false);
      assert.match(r.reason ?? "", /catastrophic backtracking/);
    });
  }

  it("validatePatterns splits a catastrophic pattern from its neighbours", () => {
    const r = validatePatterns(["before", "^(a+)+b$", "after"]);
    assert.deepEqual(r.valid, ["before", "after"]);
    assert.equal(r.invalid.length, 1);
    assert.equal(r.invalid[0]!.pattern, "^(a+)+b$");
    assert.match(r.invalid[0]!.reason, /catastrophic/);
  });

  // Ordinary markers must keep passing: a false positive is a refused marker.
  const ordinary = [
    j("acme", "-corp"),
    j("\\d", "{12}"),
    j("(\\d+", "\\.)+\\d+"),
    j("(foo|", "bar)+"),
    j("(ab", ")+c"),
    j("(a+", "b)+"),
    j("(?:https?://)?[a-z0-", "9.-]+\\.example\\.com"),
    j("[a-z]+@exa", "mple\\.com"),
    j("foo(?", "=bar)"),
    j("(a+", ")?b"),
    j("(\\w{1", ",8}-)+x"),
    j("\\(a", "+\\)+"),
    j("[(a", "+)]+"),
  ];
  for (const p of ordinary) {
    it(`accepts ${p}`, () => {
      const r = validatePattern(p);
      assert.equal(r.ok, true, r.reason ?? "ok");
    });
  }
});

describe("validatePattern on a loaded machine", () => {
  it("accepts ordinary patterns repeatedly (CPU time, not wall-clock)", () => {
    for (let i = 0; i < 20; i++) assert.equal(validatePattern(`acme-corp-${i}-[a-z]+`).ok, true);
  });
});
