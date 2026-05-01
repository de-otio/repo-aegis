import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validatePattern, validatePatterns } from "./regex-safety.js";

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
});
