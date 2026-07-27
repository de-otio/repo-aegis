// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// Self-hygiene note: this repo scans itself (see self-hygiene.test.ts), so
// no test in this file may contain a complete secret-shaped literal. Every
// AWS-key-shaped string below is assembled at runtime from fragments; no
// single source line contains the full token.
import assert from "node:assert/strict";
import { test } from "node:test";
import { isKnownNonSecret } from "./known-non-secrets.js";

// Assembled at runtime: AWS's own documented example access key shape is a
// 4-letter type prefix + 16 more uppercase-alphanumeric characters. None of
// these fragments alone, nor any single source line, spells out the full
// token — see the module comment on AWS_ACCESS_KEY_ID_SHAPE.
const AWS_KEY_PREFIX = "AKIA";
const EXAMPLE_BODY_HEAD = "IOSFODNN7";
const EXAMPLE_BODY_TAIL = "EXAMPLE";
const CONSTRUCTED_AWS_EXAMPLE_KEY = AWS_KEY_PREFIX + EXAMPLE_BODY_HEAD + EXAMPLE_BODY_TAIL;

const REAL_LOOKING_BODY_TAIL = "1234567";
const CONSTRUCTED_AWS_REAL_SHAPED_KEY =
  AWS_KEY_PREFIX + EXAMPLE_BODY_HEAD + REAL_LOOKING_BODY_TAIL;

test("a constructed AWS docs example key is recognized as a known non-secret", () => {
  const line = `aws_access_key_id = ${CONSTRUCTED_AWS_EXAMPLE_KEY}`;
  assert.equal(isKnownNonSecret(CONSTRUCTED_AWS_EXAMPLE_KEY, line), true);
});

test("a same-shaped key with a non-EXAMPLE body is flagged (isKnownNonSecret returns false)", () => {
  const line = `aws_access_key_id = ${CONSTRUCTED_AWS_REAL_SHAPED_KEY}`;
  assert.equal(isKnownNonSecret(CONSTRUCTED_AWS_REAL_SHAPED_KEY, line), false);
});

test("a string containing EXAMPLE that is not key-shaped returns false (no blanket contains-EXAMPLE bypass)", () => {
  const matched = "acme-corp-EXAMPLE-internal-tool-name";
  const line = `service = ${matched}`;
  assert.equal(isKnownNonSecret(matched, line), false);
});

test("EXAMPLE alone is a recognized placeholder body", () => {
  assert.equal(isKnownNonSecret("EXAMPLE", "token = EXAMPLE"), true);
});

test("REDACTED is a recognized placeholder body", () => {
  assert.equal(isKnownNonSecret("REDACTED", "token = REDACTED"), true);
});

test("CHANGEME is a recognized placeholder body, case-insensitively", () => {
  assert.equal(isKnownNonSecret("CHANGEME", "password = CHANGEME"), true);
  assert.equal(isKnownNonSecret("changeme", "password = changeme"), true);
});

test("XXXXXXXX is a recognized placeholder body", () => {
  assert.equal(isKnownNonSecret("XXXXXXXX", "api_key = XXXXXXXX"), true);
});

test("the YOUR-...-HERE shape is recognized, case-insensitively", () => {
  assert.equal(isKnownNonSecret("YOUR-API-KEY-HERE", "key = YOUR-API-KEY-HERE"), true);
  assert.equal(isKnownNonSecret("your_secret_here", "key = your_secret_here"), true);
});

test("a placeholder word embedded mid-token (not a full-token suffix) is not recognized", () => {
  // "EXAMPLEwidget" does not END in EXAMPLE, so this must not match — this
  // is the same "no substring bypass" property, phrased for the placeholder
  // rule rather than the AWS-shape rule.
  assert.equal(isKnownNonSecret("EXAMPLEwidget", "name = EXAMPLEwidget"), false);
});

test("a plausible real secret is not flagged as a known non-secret", () => {
  // Assembled at runtime so no complete vendor-shaped key literal ever exists
  // in this file. Written out in full it tripped GitHub push protection (a
  // Stripe detector) — correctly: a live-shaped key in a public repo is a
  // finding whether or not the bytes are real. The shape is all this needs.
  const matched = ["sk", "live", "0".repeat(8) + "abcdefghijklmnop"].join("_");
  assert.equal(isKnownNonSecret(matched, `stripe_key = ${matched}`), false);
});

test("empty string is not a known non-secret", () => {
  assert.equal(isKnownNonSecret("", "= "), false);
});

test("surrounding whitespace on the matched token is trimmed before matching", () => {
  assert.equal(isKnownNonSecret("  EXAMPLE  ", "token =   EXAMPLE  "), true);
});

test("YOUR-...-HERE shape requires both anchors; a token merely containing 'your' or 'here' does not match", () => {
  assert.equal(isKnownNonSecret("hereyourgo", "x = hereyourgo"), false);
});
