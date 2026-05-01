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
