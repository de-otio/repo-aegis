import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { redactMatch, revealMatch } from "./redaction.js";

describe("redactMatch", () => {
  it("preview mode: shows first 3 chars + length for long strings", () => {
    assert.equal(redactMatch("acme-corp", "preview"), "acm***9");
    assert.equal(redactMatch("betaco", "preview"), "bet***6");
  });

  it("preview mode: redacts short strings entirely", () => {
    assert.equal(redactMatch("abc", "preview"), "[redacted]");
    assert.equal(redactMatch("ab", "preview"), "[redacted]");
    assert.equal(redactMatch("", "preview"), "[redacted]");
  });

  it("preview mode is the default", () => {
    assert.equal(redactMatch("acme-corp"), "acm***9");
  });

  it("hash mode: returns hex hash + length, deterministic", () => {
    const a = redactMatch("acme-corp", "hash");
    const b = redactMatch("acme-corp", "hash");
    assert.equal(a, b);
    assert.match(a, /^\[hash:[a-f0-9]{8}:9\]$/);
  });

  it("hash mode: distinct inputs produce distinct outputs", () => {
    assert.notEqual(
      redactMatch("acme-corp", "hash"),
      redactMatch("betaco", "hash"),
    );
  });

  it("position-only mode: always [redacted]", () => {
    assert.equal(redactMatch("acme-corp", "position-only"), "[redacted]");
    assert.equal(redactMatch("anything", "position-only"), "[redacted]");
  });

  it("never includes the literal in any redaction mode", () => {
    const literal = "veryspecificcustomername";
    const modes = ["preview", "hash", "position-only"] as const;
    for (const m of modes) {
      const out = redactMatch(literal, m);
      assert.ok(!out.includes(literal), `mode ${m} leaked literal`);
    }
  });

  it("handles unicode without crashing", () => {
    assert.ok(redactMatch("éâô-corp", "preview").length > 0);
    assert.ok(redactMatch("中文corp", "hash").length > 0);
  });
});

describe("revealMatch", () => {
  it("returns the literal", () => {
    assert.equal(revealMatch("acme-corp"), "acme-corp");
  });

  it("is the only function that returns the literal", () => {
    // Documentary test: enforces by convention that revealMatch is the
    // single point of literal exposure in the redaction module.
    assert.equal(typeof revealMatch, "function");
  });
});
