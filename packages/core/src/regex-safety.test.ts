// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import {
  validatePattern,
  validatePatterns,
  getRegexBackend,
  setRegexBackendForTesting,
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

describe("validatePatterns({ strict: true })", () => {
  it("accepts ordinary patterns", () => {
    const r = validatePatterns(["acme-corp", "\\d{12}"], { strict: true });
    assert.equal(r.valid.length, 2);
    assert.equal(r.invalid.length, 0);
  });

  it("rejects syntactically invalid regex without spawning", () => {
    const r = validatePatterns(["(unclosed"], { strict: true });
    assert.equal(r.invalid.length, 1);
    assert.match(r.invalid[0]!.reason, /invalid regex/);
  });

  it("rejects patterns over the length cap without spawning", () => {
    const r = validatePatterns(["a".repeat(3000)], { strict: true });
    assert.equal(r.invalid.length, 1);
    assert.match(r.invalid[0]!.reason, /exceeds/);
  });

  it("flags catastrophic-backtracking patterns via subprocess", () => {
    // Classic ReDoS shape: nested unbounded quantifier with a literal
    // that the all-'a' stress input cannot satisfy, forcing the regex
    // engine to try every possible split.
    const r = validatePatterns(["^(a+)+b$"], { strict: true });
    assert.equal(r.invalid.length, 1, `expected the pattern to be rejected; got valid=${JSON.stringify(r.valid)}`);
    assert.match(r.invalid[0]!.reason, /catastrophic|timed out|>/i);
  });

  it("returns empty for empty input without spawning", () => {
    const r = validatePatterns([], { strict: true });
    assert.equal(r.valid.length, 0);
    assert.equal(r.invalid.length, 0);
  });

  it("preserves order across mixed valid/invalid input", () => {
    const r = validatePatterns(
      ["acme-corp", "(bad", "\\d+", ""],
      { strict: true },
    );
    assert.deepEqual(r.valid, ["acme-corp", "\\d+"]);
    assert.equal(r.invalid.length, 2);
  });

  it("reports trailing patterns when subprocess is killed mid-batch", () => {
    // Strict-batch truncation contract: if the worker subprocess hangs on
    // a catastrophic pattern and gets SIGTERMed, we must still report the
    // patterns it never got to. The first pattern is fine and should be
    // valid, the second is catastrophic-backtracking and should be in
    // invalid (with a "timed out" or "catastrophic" reason), and the
    // third — which the subprocess likely never reached — must also be
    // reported (most likely as "produced no result" if truncation
    // occurred mid-batch).
    const r = validatePatterns(
      ["acme-corp", "^(a+)+b$", "\\d{12}"],
      { strict: true },
    );

    // The first pattern is well-formed; it should always come back valid.
    assert.ok(
      r.valid.includes("acme-corp"),
      `expected first pattern to validate; got valid=${JSON.stringify(r.valid)}`,
    );

    // The catastrophic pattern must end up in the invalid bucket with a
    // reason that names the failure mode.
    const cata = r.invalid.find(x => x.pattern === "^(a+)+b$");
    assert.ok(cata, `expected ^(a+)+b$ in invalid; got invalid=${JSON.stringify(r.invalid)}`);
    assert.match(cata!.reason, /timed out|catastrophic|>/i);

    // The third pattern is well-formed *but* may have been trampled by
    // the kill-on-timeout. It must show up in *one* of the result sets:
    // valid (if the worker got that far before timeout), or invalid with
    // a "no result" / "timed out" reason (if truncation hit it).
    const reported =
      r.valid.includes("\\d{12}") ||
      r.invalid.some(x => x.pattern === "\\d{12}");
    assert.ok(
      reported,
      `third pattern must be reported in valid or invalid; ` +
        `valid=${JSON.stringify(r.valid)} invalid=${JSON.stringify(r.invalid)}`,
    );

    // Total accounting: every input pattern must show up exactly once
    // across the two buckets.
    assert.equal(r.valid.length + r.invalid.length, 3);
  });
});

describe("getRegexBackend", () => {
  after(() => setRegexBackendForTesting(null));

  it("returns 're2' or 'in-process' depending on optional dep availability", () => {
    setRegexBackendForTesting(null);
    const backend = getRegexBackend();
    assert.ok(
      backend === "re2" || backend === "in-process",
      `unexpected backend: ${backend}`,
    );
  });

  it("respects setRegexBackendForTesting override", () => {
    setRegexBackendForTesting("in-process");
    assert.equal(getRegexBackend(), "in-process");
    setRegexBackendForTesting("re2");
    assert.equal(getRegexBackend(), "re2");
    setRegexBackendForTesting(null);
  });

  it("validatePattern accepts ordinary patterns under both backends", () => {
    setRegexBackendForTesting("in-process");
    assert.equal(validatePattern("acme-corp").ok, true);
    setRegexBackendForTesting("re2");
    assert.equal(validatePattern("acme-corp").ok, true);
    setRegexBackendForTesting(null);
  });

  it("validatePattern falls back to time-budget when re2 rejects (e.g. lookahead)", () => {
    // Lookahead is a re2-incompatible feature. Whether re2 is installed
    // or not, validatePattern must still accept this pattern because
    // the scanner uses native RegExp, which supports lookahead.
    setRegexBackendForTesting("re2");
    const r = validatePattern("foo(?=bar)");
    assert.equal(r.ok, true, `expected lookahead pattern to validate; reason=${r.reason}`);
    setRegexBackendForTesting(null);
  });
});
