// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  scanForSecrets,
  summariseHits,
  type SecretMarkerHit,
} from "./secret-markers.js";

// Test fixtures intentionally do NOT contain real secrets — these are
// shape-matching strings that any plausible regex would also match.
// Keep them well-known dummies so accidentally publishing the test
// fixtures stays harmless.

const DUMMY_PEM_HEADER = "-----BEGIN RSA PRIVATE KEY-----";
const DUMMY_PEM_OPENSSH = "-----BEGIN OPENSSH PRIVATE KEY-----";
const DUMMY_PEM_GENERIC = "-----BEGIN PRIVATE KEY-----";
const DUMMY_PEM_AS_HEX =
  "2D2D2D2D2D424547494E2052534120505249564154"; // hex of "-----BEGIN RSA PRIVAT" (truncated)
const DUMMY_GHS = "ghs_" + "A".repeat(36);
const DUMMY_GHP = "ghp_" + "z".repeat(40);
const DUMMY_GHO = "gho_" + "1".repeat(36);
const DUMMY_GHU = "ghu_" + "9".repeat(36);
const DUMMY_GHR = "ghr_" + "x".repeat(36);
const DUMMY_GH_PAT = "github_pat_" + "Z".repeat(40);
// Three-segment URL-safe base64, header starts with "eyJ"
const DUMMY_JWT =
  "eyJ" + "Q".repeat(20) + "." +
  "eyJ" + "R".repeat(20) + "." +
  "S".repeat(40);

describe("scanForSecrets — PEM headers", () => {
  it("matches RSA private key header", () => {
    const hits = scanForSecrets(`prefix ${DUMMY_PEM_HEADER} suffix`);
    assert.equal(hits.length, 1);
    assert.equal(hits[0]!.kind, "PEM_HEADER");
  });

  it("matches OPENSSH variant", () => {
    const hits = scanForSecrets(DUMMY_PEM_OPENSSH);
    assert.equal(hits.length, 1);
    assert.equal(hits[0]!.kind, "PEM_HEADER");
  });

  it("matches generic PRIVATE KEY (no algorithm prefix)", () => {
    const hits = scanForSecrets(DUMMY_PEM_GENERIC);
    assert.equal(hits.length, 1);
    assert.equal(hits[0]!.kind, "PEM_HEADER");
  });

  it("matches multiple headers in one input", () => {
    const text = `${DUMMY_PEM_HEADER}\nbody\n-----END RSA PRIVATE KEY-----\n${DUMMY_PEM_HEADER}`;
    const hits = scanForSecrets(text);
    const headerHits = hits.filter(h => h.kind === "PEM_HEADER");
    assert.equal(headerHits.length, 2);
  });

  it("does not match the matching END marker (only BEGIN)", () => {
    const hits = scanForSecrets("-----END RSA PRIVATE KEY-----");
    assert.equal(hits.length, 0);
  });
});

describe("scanForSecrets — PEM as ASCII hex", () => {
  it("matches the hex of '-----BEGIN '", () => {
    const hits = scanForSecrets(DUMMY_PEM_AS_HEX);
    const hexHits = hits.filter(h => h.kind === "PEM_AS_HEX");
    assert.equal(hexHits.length, 1);
  });

  it("is case-insensitive on hex digits", () => {
    const upper = DUMMY_PEM_AS_HEX.toUpperCase();
    const lower = DUMMY_PEM_AS_HEX.toLowerCase();
    assert.equal(scanForSecrets(upper).filter(h => h.kind === "PEM_AS_HEX").length, 1);
    assert.equal(scanForSecrets(lower).filter(h => h.kind === "PEM_AS_HEX").length, 1);
  });

  it("ignores arbitrary hex strings that are not PEM headers", () => {
    const hits = scanForSecrets("deadbeef".repeat(50));
    assert.equal(hits.filter(h => h.kind === "PEM_AS_HEX").length, 0);
  });
});

describe("scanForSecrets — GitHub tokens", () => {
  for (const [label, dummy] of [
    ["ghs_", DUMMY_GHS],
    ["ghp_", DUMMY_GHP],
    ["gho_", DUMMY_GHO],
    ["ghu_", DUMMY_GHU],
    ["ghr_", DUMMY_GHR],
    ["github_pat_", DUMMY_GH_PAT],
  ] as const) {
    it(`matches ${label} prefix`, () => {
      const hits = scanForSecrets(`auth: ${dummy}`);
      assert.equal(hits.length, 1, `expected one hit for ${label}`);
      assert.equal(hits[0]!.kind, "GITHUB_TOKEN");
    });
  }

  it("does not match short prefix-only fragments", () => {
    assert.equal(scanForSecrets("ghs_short").length, 0);
    assert.equal(scanForSecrets("ghp_").length, 0);
  });

  it("does not match unrelated `gh` strings", () => {
    assert.equal(scanForSecrets("github.com").length, 0);
    assert.equal(scanForSecrets("ghosts").length, 0);
  });
});

describe("scanForSecrets — JWT shape", () => {
  it("matches a 3-segment JWT", () => {
    const hits = scanForSecrets(`Authorization: Bearer ${DUMMY_JWT}`);
    assert.equal(hits.filter(h => h.kind === "JWT").length, 1);
  });

  it("does not match a 2-segment string", () => {
    const twoSeg = "eyJabc.eyJdef";
    assert.equal(scanForSecrets(twoSeg).filter(h => h.kind === "JWT").length, 0);
  });

  it("does not match base64 blobs without the eyJ prefix", () => {
    const fake = "abcdef.ghijkl.mnopqr";
    assert.equal(scanForSecrets(fake).filter(h => h.kind === "JWT").length, 0);
  });
});

describe("scanForSecrets — clean inputs", () => {
  it("returns no hits on empty string", () => {
    assert.deepEqual(scanForSecrets(""), []);
  });

  it("returns no hits on plain prose", () => {
    const text =
      "This is a normal log message about installing the GitHub App " +
      "for engagement acme. The app slug is acme-alice-bot. No secrets here.";
    assert.deepEqual(scanForSecrets(text), []);
  });

  it("returns no hits on a public key (only private)", () => {
    const text = "-----BEGIN PUBLIC KEY-----\nblah\n-----END PUBLIC KEY-----";
    assert.deepEqual(scanForSecrets(text), []);
  });
});

describe("scanForSecrets — never returns matched bytes", () => {
  it("hit objects only carry kind/offset/length", () => {
    const hits = scanForSecrets(`${DUMMY_PEM_HEADER} ${DUMMY_GHS}`);
    for (const h of hits) {
      const keys = Object.keys(h).sort();
      assert.deepEqual(keys, ["kind", "length", "offset"]);
    }
  });
});

describe("scanForSecrets — multiple kinds in one input", () => {
  it("reports one hit per pattern, sorted by offset", () => {
    const text = `start ${DUMMY_PEM_HEADER} middle ${DUMMY_GHS} end ${DUMMY_JWT}`;
    const hits = scanForSecrets(text);
    assert.ok(hits.length >= 3);
    for (let i = 1; i < hits.length; i++) {
      assert.ok(hits[i]!.offset >= hits[i - 1]!.offset, "hits must be sorted by offset");
    }
  });
});

describe("summariseHits", () => {
  it("returns kinds + count, never bytes", () => {
    const hits: SecretMarkerHit[] = [
      { kind: "PEM_HEADER", offset: 0, length: 30 },
      { kind: "GITHUB_TOKEN", offset: 50, length: 40 },
      { kind: "PEM_HEADER", offset: 100, length: 30 },
    ];
    const s = summariseHits(hits);
    assert.deepEqual(s.kinds, ["GITHUB_TOKEN", "PEM_HEADER"]);
    assert.equal(s.count, 3);
  });

  it("handles empty input", () => {
    assert.deepEqual(summariseHits([]), { kinds: [], count: 0 });
  });
});
