// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  NotWaivableError,
  WAIVABLE_STEM,
  WaiverParseError,
  assertWaivable,
  expiredWaivers,
  isWaived,
  parseWaivers,
  patternId,
} from "./waivers.js";

const BLOB_A = "a".repeat(40);
const BLOB_B = "b".repeat(40);

function validEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    pattern: patternId(WAIVABLE_STEM, "some-secret-shape-regex"),
    blob: BLOB_A,
    reason: "fedify test-fixture keypair",
    approver: "alice",
    date: "2026-07-26",
    ...overrides,
  };
}

test("patternId is stable for the same input and differs for different patterns", () => {
  const a1 = patternId(WAIVABLE_STEM, "pattern-one");
  const a2 = patternId(WAIVABLE_STEM, "pattern-one");
  const b = patternId(WAIVABLE_STEM, "pattern-two");
  assert.equal(a1, a2);
  assert.notEqual(a1, b);
  assert.match(a1, /^_always\/[0-9a-f]{12}$/);
});

test("patternId differs across stems for the same pattern text", () => {
  const always = patternId("_always", "same-text");
  const engagement = patternId("acme", "same-text");
  assert.notEqual(always, engagement);
});

test("assertWaivable accepts an _always-rooted id", () => {
  assert.doesNotThrow(() => assertWaivable(patternId(WAIVABLE_STEM, "x")));
});

test("assertWaivable rejects an engagement-scoped id", () => {
  const id = patternId("acme-corp", "x");
  assert.throws(() => assertWaivable(id), NotWaivableError);
  try {
    assertWaivable(id);
    assert.fail("expected throw");
  } catch (err) {
    assert.ok(err instanceof NotWaivableError);
    assert.equal(err.patternId, id);
    // Both reasons must be present in the message so the CLI can surface
    // them verbatim.
    assert.match(err.message, /non-goal/);
    assert.match(err.message, /offline/);
    assert.match(err.message, /repo-aegis allow/);
  }
});

test("assertWaivable rejects a malformed id with no stem separator", () => {
  assert.throws(() => assertWaivable("not-a-pattern-id"), NotWaivableError);
});

test("isWaived: matching (pattern, blob) is waived", () => {
  const id = patternId(WAIVABLE_STEM, "aws-key-shape");
  const waivers = parseWaivers([validEntry({ pattern: id })]);
  const hit = { patternId: id, blob: BLOB_A };
  assert.equal(isWaived(hit, waivers, new Date("2026-08-01T00:00:00Z")), true);
});

test("isWaived: same pattern, different blob does NOT match", () => {
  const id = patternId(WAIVABLE_STEM, "aws-key-shape");
  const waivers = parseWaivers([validEntry({ pattern: id, blob: BLOB_A })]);
  const hit = { patternId: id, blob: BLOB_B };
  assert.equal(isWaived(hit, waivers, new Date("2026-08-01T00:00:00Z")), false);
});

test("isWaived: different pattern, same blob does NOT match", () => {
  const idA = patternId(WAIVABLE_STEM, "shape-a");
  const idB = patternId(WAIVABLE_STEM, "shape-b");
  const waivers = parseWaivers([validEntry({ pattern: idA, blob: BLOB_A })]);
  const hit = { patternId: idB, blob: BLOB_A };
  assert.equal(isWaived(hit, waivers, new Date("2026-08-01T00:00:00Z")), false);
});

test("isWaived: a hit with no blob is never waived", () => {
  const id = patternId(WAIVABLE_STEM, "aws-key-shape");
  const waivers = parseWaivers([validEntry({ pattern: id, blob: BLOB_A })]);
  const hit = { patternId: id };
  assert.equal(isWaived(hit, waivers, new Date("2026-08-01T00:00:00Z")), false);
});

test("isWaived: waiver is still valid ON its expiry date (inclusive boundary)", () => {
  const id = patternId(WAIVABLE_STEM, "aws-key-shape");
  const waivers = parseWaivers([
    validEntry({ pattern: id, blob: BLOB_A, expires: "2027-07-26" }),
  ]);
  const hit = { patternId: id, blob: BLOB_A };
  // Exactly on the expiry date: still valid.
  assert.equal(isWaived(hit, waivers, new Date("2027-07-26T23:59:59Z")), true);
});

test("isWaived: waiver is expired the day AFTER its expiry date", () => {
  const id = patternId(WAIVABLE_STEM, "aws-key-shape");
  const waivers = parseWaivers([
    validEntry({ pattern: id, blob: BLOB_A, expires: "2027-07-26" }),
  ]);
  const hit = { patternId: id, blob: BLOB_A };
  assert.equal(isWaived(hit, waivers, new Date("2027-07-27T00:00:00Z")), false);
});

test("expiredWaivers: returns only entries past their expiry date, using the injected clock", () => {
  const idA = patternId(WAIVABLE_STEM, "shape-a");
  const idB = patternId(WAIVABLE_STEM, "shape-b");
  const waivers = parseWaivers([
    validEntry({ pattern: idA, blob: BLOB_A, expires: "2026-01-01" }), // past
    validEntry({ pattern: idB, blob: BLOB_B, expires: "2030-01-01" }), // future
    validEntry({ pattern: idA, blob: BLOB_B }), // no expiry at all
  ]);
  const now = new Date("2026-07-26T00:00:00Z");
  const expired = expiredWaivers(waivers, now);
  assert.equal(expired.length, 1);
  assert.equal(expired[0]?.pattern, idA);
  assert.equal(expired[0]?.blob, BLOB_A);
});

test("parseWaivers: undefined and null both parse to an empty list", () => {
  assert.deepEqual(parseWaivers(undefined), []);
  assert.deepEqual(parseWaivers(null), []);
});

test("parseWaivers: empty array parses to an empty list", () => {
  assert.deepEqual(parseWaivers([]), []);
});

test("parseWaivers: a well-formed entry round-trips", () => {
  const entry = validEntry();
  const parsed = parseWaivers([entry]);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0]?.pattern, entry.pattern);
  assert.equal(parsed[0]?.approver, "alice");
});

test("parseWaivers: malformed pattern id throws (fail closed)", () => {
  assert.throws(
    () => parseWaivers([validEntry({ pattern: "not-a-valid-id" })]),
    WaiverParseError,
  );
});

test("parseWaivers: malformed blob (not 40 hex) throws", () => {
  assert.throws(() => parseWaivers([validEntry({ blob: "not-hex" })]), WaiverParseError);
});

test("parseWaivers: empty reason throws", () => {
  assert.throws(() => parseWaivers([validEntry({ reason: "" })]), WaiverParseError);
});

test("parseWaivers: empty approver throws", () => {
  assert.throws(() => parseWaivers([validEntry({ approver: "" })]), WaiverParseError);
});

test("parseWaivers: malformed date throws", () => {
  assert.throws(() => parseWaivers([validEntry({ date: "07/26/2026" })]), WaiverParseError);
});

test("parseWaivers: malformed expires throws", () => {
  assert.throws(
    () => parseWaivers([validEntry({ expires: "not-a-date" })]),
    WaiverParseError,
  );
});

test("parseWaivers: one bad entry among good ones rejects the whole input, not just the bad entry", () => {
  const good = validEntry();
  const bad = validEntry({ blob: "short" });
  assert.throws(() => parseWaivers([good, bad]), WaiverParseError);
});

test("parseWaivers: a non-array, non-nullish input throws rather than coercing", () => {
  assert.throws(() => parseWaivers({ not: "an array" }), WaiverParseError);
  assert.throws(() => parseWaivers("nope"), WaiverParseError);
});
