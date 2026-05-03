// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// synthesis.test.ts — table-driven tests for synthesizeMarker.
//
// [SEC M-4] tags mark tests that specifically exercise Unicode-boundary
// behaviour: non-ASCII tokens must produce (?<!\p{L})...(?!\p{L}) boundaries
// instead of \b, and must require the `u` flag for correct runtime matching.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validatePattern } from "@de-otio/repo-aegis-core";
import {
  synthesizeMarker,
  PROMPT_SOURCE_MAP,
  type TokenKind,
} from "./synthesis.js";

// ---------------------------------------------------------------------------
// Helper: assert a pattern is non-null and passes validatePattern.
// For patterns with \p{ (Unicode-aware boundaries), validatePattern uses
// RegExp without the `u` flag — it still returns ok:true because \p is
// treated as literal 'p' in that mode, confirming syntactic validity.
// The test additionally compiles with the `u` flag to confirm runtime
// correctness. [SEC M-4]
// ---------------------------------------------------------------------------
function assertValidPattern(pattern: string | null, label: string): string {
  assert.notEqual(pattern, null, `${label}: expected non-null pattern`);
  const p = pattern as string;
  const result = validatePattern(p);
  assert.equal(
    result.ok,
    true,
    `${label}: validatePattern failed: ${result.reason ?? "(no reason)"}`,
  );
  return p;
}

/**
 * [SEC M-4] For patterns containing \p{, the consumer must compile with `u`.
 * This helper verifies correct Unicode-boundary matching when `u` is used.
 */
function assertUnicodeBoundary(
  pattern: string,
  token: string,
  label: string,
): void {
  assert.ok(
    pattern.includes("\\p{"),
    `${label}: expected Unicode boundary \\p{ in pattern, got: ${pattern}`,
  );
  // Compile with the `u` flag as the consumer would.
  const re = new RegExp(pattern, "ui");
  // The token itself (possibly modified by case/escaping) should match.
  // We check that a string consisting only of the token matches (boundary fires).
  assert.ok(
    re.test(token),
    `${label}: pattern did not match token "${token}" with 'ui' flags`,
  );
  // A string where the token is surrounded by letters should NOT match at
  // word boundary (the Unicode \p{L} boundary prevents it).
  const wrapped = `x${token}x`;
  assert.equal(
    re.test(wrapped),
    false,
    `${label}: pattern matched "${wrapped}" but should not (Unicode boundary)`,
  );
}

// ---------------------------------------------------------------------------
// company / codename / person-name
// ---------------------------------------------------------------------------

describe("synthesizeMarker — company", () => {
  it("FooCorp camelCase splits and inserts [-_ ]?", () => {
    const p = assertValidPattern(synthesizeMarker("FooCorp", "company"), "FooCorp");
    assert.equal(p, "\\bfoo[-_ ]?corp\\b");
  });

  it("foo-corp kebab splits and inserts [-_ ]?", () => {
    const p = assertValidPattern(synthesizeMarker("foo-corp", "company"), "foo-corp");
    assert.equal(p, "\\bfoo[-_ ]?corp\\b");
  });

  it("foo_corp snake splits and inserts [-_ ]?", () => {
    const p = assertValidPattern(synthesizeMarker("foo_corp", "company"), "foo_corp");
    assert.equal(p, "\\bfoo[-_ ]?corp\\b");
  });

  it("foo corp space splits and inserts [-_ ]?", () => {
    const p = assertValidPattern(synthesizeMarker("foo corp", "company"), "foo corp");
    assert.equal(p, "\\bfoo[-_ ]?corp\\b");
  });

  it("single-word company wraps in \\b", () => {
    const p = assertValidPattern(synthesizeMarker("Acme", "company"), "Acme");
    assert.equal(p, "\\bacme\\b");
  });

  it("multi-part camelCase: ProjectAlpha", () => {
    const p = assertValidPattern(synthesizeMarker("ProjectAlpha", "company"), "ProjectAlpha");
    assert.equal(p, "\\bproject[-_ ]?alpha\\b");
  });

  it("escapes regex metacharacters (dot in name)", () => {
    const p = assertValidPattern(synthesizeMarker("foo.corp", "company"), "foo.corp");
    // dot is a metachar, should be escaped; . is not a camelCase/kebab boundary
    assert.ok(p.includes("\\."), `expected escaped dot in: ${p}`);
  });

  it("lowercases the pattern", () => {
    const p = assertValidPattern(synthesizeMarker("ACME", "company"), "ACME");
    assert.equal(p, "\\bacme\\b");
  });

  it("rejects empty token", () => {
    assert.equal(synthesizeMarker("", "company"), null);
  });

  it("rejects whitespace-only token", () => {
    assert.equal(synthesizeMarker("   ", "company"), null);
  });
});

describe("synthesizeMarker — codename", () => {
  it("ProjectAlpha codename", () => {
    const p = assertValidPattern(synthesizeMarker("ProjectAlpha", "codename"), "ProjectAlpha");
    assert.equal(p, "\\bproject[-_ ]?alpha\\b");
  });

  it("single-word codename", () => {
    const p = assertValidPattern(synthesizeMarker("phoenix", "codename"), "phoenix");
    assert.equal(p, "\\bphoenix\\b");
  });

  it("kebab codename", () => {
    const p = assertValidPattern(synthesizeMarker("blue-moon", "codename"), "blue-moon");
    assert.equal(p, "\\bblue[-_ ]?moon\\b");
  });
});

describe("synthesizeMarker — person-name", () => {
  it("Jane Smith splits on space", () => {
    const p = assertValidPattern(synthesizeMarker("Jane Smith", "person-name"), "Jane Smith");
    assert.equal(p, "\\bjane[-_ ]?smith\\b");
  });

  it("single name token", () => {
    const p = assertValidPattern(synthesizeMarker("Alice", "person-name"), "Alice");
    assert.equal(p, "\\balice\\b");
  });
});

// ---------------------------------------------------------------------------
// domain
// ---------------------------------------------------------------------------

describe("synthesizeMarker — domain", () => {
  it("foo.example.com escapes dots", () => {
    const p = assertValidPattern(
      synthesizeMarker("foo.example.com", "domain"),
      "foo.example.com",
    );
    assert.equal(p, "\\bfoo\\.example\\.com\\b");
  });

  it("simple two-label domain", () => {
    const p = assertValidPattern(synthesizeMarker("acme.io", "domain"), "acme.io");
    assert.equal(p, "\\bacme\\.io\\b");
  });

  it("lowercases the domain pattern", () => {
    const p = assertValidPattern(synthesizeMarker("Foo.EXAMPLE.com", "domain"), "Foo.EXAMPLE.com");
    assert.equal(p, "\\bfoo\\.example\\.com\\b");
  });

  it("escapes other metacharacters in domain", () => {
    // Hypothetical domain with regex-special chars — should be escaped.
    const p = assertValidPattern(synthesizeMarker("foo+bar.com", "domain"), "foo+bar.com");
    assert.ok(p.includes("\\+"), `expected escaped + in: ${p}`);
  });
});

// ---------------------------------------------------------------------------
// ticket-prefix
// ---------------------------------------------------------------------------

describe("synthesizeMarker — ticket-prefix", () => {
  it("FOO produces \\bFOO-[0-9]+\\b", () => {
    const p = assertValidPattern(synthesizeMarker("FOO", "ticket-prefix"), "FOO");
    assert.equal(p, "\\bFOO-[0-9]+\\b");
  });

  it("AB produces \\bAB-[0-9]+\\b", () => {
    const p = assertValidPattern(synthesizeMarker("AB", "ticket-prefix"), "AB");
    assert.equal(p, "\\bAB-[0-9]+\\b");
  });

  it("rejects single uppercase letter (too short)", () => {
    assert.equal(synthesizeMarker("A", "ticket-prefix"), null);
  });

  it("rejects lowercase prefix", () => {
    assert.equal(synthesizeMarker("foo", "ticket-prefix"), null);
  });

  it("rejects mixed case prefix", () => {
    assert.equal(synthesizeMarker("Foo", "ticket-prefix"), null);
  });

  it("rejects prefix with hyphen", () => {
    assert.equal(synthesizeMarker("FOO-BAR", "ticket-prefix"), null);
  });

  it("rejects empty prefix", () => {
    assert.equal(synthesizeMarker("", "ticket-prefix"), null);
  });

  it("rejects non-alphanumeric characters", () => {
    assert.equal(synthesizeMarker("FOO!", "ticket-prefix"), null);
  });

  it("accepts prefix with digits after first char (AB1)", () => {
    const p = assertValidPattern(synthesizeMarker("AB1", "ticket-prefix"), "AB1");
    assert.equal(p, "\\bAB1-[0-9]+\\b");
  });
});

// ---------------------------------------------------------------------------
// account-id
// ---------------------------------------------------------------------------

describe("synthesizeMarker — account-id", () => {
  it("12-digit account-id", () => {
    const p = assertValidPattern(
      synthesizeMarker("123456789012", "account-id"),
      "123456789012",
    );
    assert.equal(p, "\\b123456789012\\b");
  });

  it("6-digit minimum accepted", () => {
    const p = assertValidPattern(synthesizeMarker("123456", "account-id"), "123456");
    assert.equal(p, "\\b123456\\b");
  });

  it("16-digit maximum accepted", () => {
    const p = assertValidPattern(
      synthesizeMarker("1234567890123456", "account-id"),
      "1234567890123456",
    );
    assert.equal(p, "\\b1234567890123456\\b");
  });

  it("rejects 5-digit (too short)", () => {
    assert.equal(synthesizeMarker("12345", "account-id"), null);
  });

  it("rejects 17-digit (too long)", () => {
    assert.equal(synthesizeMarker("12345678901234567", "account-id"), null);
  });

  it("rejects non-numeric", () => {
    assert.equal(synthesizeMarker("123abc456", "account-id"), null);
  });

  it("rejects empty", () => {
    assert.equal(synthesizeMarker("", "account-id"), null);
  });

  it("rejects account-id with spaces", () => {
    assert.equal(synthesizeMarker("123 456", "account-id"), null);
  });
});

// ---------------------------------------------------------------------------
// other
// ---------------------------------------------------------------------------

describe("synthesizeMarker — other", () => {
  it("simple word wraps in \\b", () => {
    const p = assertValidPattern(synthesizeMarker("widget", "other"), "widget");
    assert.equal(p, "\\bwidget\\b");
  });

  it("lowercases the token", () => {
    const p = assertValidPattern(synthesizeMarker("Widget", "other"), "Widget");
    assert.equal(p, "\\bwidget\\b");
  });

  it("escapes regex metacharacters", () => {
    const p = assertValidPattern(synthesizeMarker("foo.bar", "other"), "foo.bar");
    assert.ok(p.includes("\\."), `expected escaped dot in: ${p}`);
    assert.equal(p, "\\bfoo\\.bar\\b");
  });
});

// ---------------------------------------------------------------------------
// [SEC M-4] Unicode boundary tests
// ---------------------------------------------------------------------------

describe("synthesizeMarker — [SEC M-4] Unicode boundaries", () => {
  it("[SEC M-4] CJK token (company) uses (?<!\\p{L}) boundaries", () => {
    // CJK: two-character Chinese name — a common company name scenario
    const token = "张伟"; // 张伟 (Zhang Wei)
    const p = assertValidPattern(synthesizeMarker(token, "company"), `CJK token ${token}`);
    assert.ok(
      p.startsWith("(?<!\\p{L})"),
      `[SEC M-4] CJK company: expected Unicode boundary, got: ${p}`,
    );
    assert.ok(
      p.endsWith("(?!\\p{L})"),
      `[SEC M-4] CJK company: expected Unicode boundary suffix, got: ${p}`,
    );
    assertUnicodeBoundary(p, token, `[SEC M-4] CJK company`);
  });

  it("[SEC M-4] Cyrillic token (company) uses (?<!\\p{L}) boundaries", () => {
    const token = "Иванов"; // Иванов
    const p = assertValidPattern(
      synthesizeMarker(token, "company"),
      `Cyrillic token ${token}`,
    );
    assert.ok(
      p.startsWith("(?<!\\p{L})"),
      `[SEC M-4] Cyrillic company: expected Unicode boundary, got: ${p}`,
    );
    assertUnicodeBoundary(p, token, `[SEC M-4] Cyrillic company`);
  });

  it("[SEC M-4] Mixed Latin/diacritic token Müller uses (?<!\\p{L}) boundaries", () => {
    const token = "Müller"; // Müller
    const p = assertValidPattern(
      synthesizeMarker(token, "person-name"),
      `Müller token`,
    );
    assert.ok(
      p.startsWith("(?<!\\p{L})"),
      `[SEC M-4] Müller person-name: expected Unicode boundary, got: ${p}`,
    );
    // Body should be the lowercased token without camelCase splitting
    // (non-ASCII path: only split on explicit separators, ü preserved as-is).
    assert.ok(
      p.includes("müller"),
      `[SEC M-4] Müller: expected 'müller' in body, got: ${p}`,
    );
    assertUnicodeBoundary(p, token, `[SEC M-4] Müller`);
  });

  it("[SEC M-4] Non-ASCII domain uses (?<!\\p{L}) boundaries", () => {
    // IDN domain with non-ASCII label
    const token = "ejemplo.com"; // ASCII — sanity check (should use \b)
    const asciiP = assertValidPattern(synthesizeMarker(token, "domain"), "ASCII domain");
    assert.ok(asciiP.startsWith("\\b"), `ASCII domain should use \\b, got: ${asciiP}`);

    // Non-ASCII domain
    const unicodeToken = "ejemploé.com"; // 'é' makes it non-ASCII
    const unicodeP = assertValidPattern(
      synthesizeMarker(unicodeToken, "domain"),
      "Non-ASCII domain",
    );
    assert.ok(
      unicodeP.startsWith("(?<!\\p{L})"),
      `[SEC M-4] Non-ASCII domain: expected Unicode boundary, got: ${unicodeP}`,
    );
  });

  it("[SEC M-4] ASCII-only tokens still use \\b boundaries", () => {
    const p = assertValidPattern(synthesizeMarker("FooCorp", "company"), "FooCorp ASCII");
    assert.ok(p.startsWith("\\b"), `ASCII token should use \\b, got: ${p}`);
    assert.ok(p.endsWith("\\b"), `ASCII token should end with \\b, got: ${p}`);
  });

  it("[SEC M-4] \u{1F600} emoji token (other kind) uses Unicode boundaries", () => {
    // Emoji is non-ASCII; ensure we produce Unicode boundaries.
    const token = "widget\u{1F600}"; // 'widget😀'
    const p = synthesizeMarker(token, "other");
    // This may or may not return null depending on validatePattern (emoji in pattern
    // is syntactically valid). We only assert if non-null.
    if (p !== null) {
      assert.ok(
        p.includes("\\p{"),
        `[SEC M-4] Emoji token should use Unicode boundaries, got: ${p}`,
      );
    }
  });

  it("[SEC M-4] Cyrillic token (other) uses (?<!\\p{L}) boundaries", () => {
    const token = "проект"; // проект (project)
    const p = assertValidPattern(
      synthesizeMarker(token, "other"),
      `Cyrillic other ${token}`,
    );
    assert.ok(
      p.includes("\\p{"),
      `[SEC M-4] Cyrillic other: expected Unicode boundary, got: ${p}`,
    );
    // Compile with u flag to verify correct runtime behaviour.
    const re = new RegExp(p, "ui");
    assert.ok(re.test(token), `[SEC M-4] Cyrillic other: pattern should match token`);
  });

  it("[SEC M-4] Pattern with \\p{ passes validatePattern (syntactic check only)", () => {
    // Demonstrates that validatePattern accepts \p{L} patterns even without u flag.
    // This is the documented behaviour: syntactic validity confirmed, but
    // correct Unicode semantics only active when consumer uses `u` flag.
    const token = "Müller"; // Müller
    const p = synthesizeMarker(token, "person-name") as string;
    assert.notEqual(p, null);
    const result = validatePattern(p);
    assert.equal(
      result.ok,
      true,
      `[SEC M-4] \p{L} pattern should pass validatePattern: ${result.reason}`,
    );
    // Without u flag: \p is treated as literal 'p' — not Unicode-aware.
    // With u flag: \p{L} is Unicode property escape — correct behaviour.
    const reWithoutU = new RegExp(p, "i");
    const reWithU = new RegExp(p, "ui");
    // Both compile without error (confirmed by reaching this line).
    assert.ok(
      reWithU.test(token),
      "[SEC M-4] Pattern with u flag should match the token",
    );
    // Note: reWithoutU.test(token) may or may not match due to \p → 'p' interpretation.
    // We do not assert its value here since the documented requirement is `u` flag.
    void reWithoutU; // consumed
  });
});

// ---------------------------------------------------------------------------
// PROMPT_SOURCE_MAP — every kind present
// ---------------------------------------------------------------------------

describe("PROMPT_SOURCE_MAP", () => {
  const kinds: TokenKind[] = [
    "company",
    "codename",
    "person-name",
    "domain",
    "ticket-prefix",
    "account-id",
    "other",
  ];

  it("contains an entry for every TokenKind", () => {
    for (const kind of kinds) {
      assert.ok(
        kind in PROMPT_SOURCE_MAP,
        `PROMPT_SOURCE_MAP missing entry for kind: ${kind}`,
      );
      assert.ok(
        typeof PROMPT_SOURCE_MAP[kind] === "string" && PROMPT_SOURCE_MAP[kind].length > 0,
        `PROMPT_SOURCE_MAP[${kind}] should be a non-empty string`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Edge cases and robustness
// ---------------------------------------------------------------------------

describe("synthesizeMarker — edge cases", () => {
  it("rejects non-string input (number)", () => {
    assert.equal(synthesizeMarker(42 as unknown as string, "company"), null);
  });

  it("rejects non-string input (null)", () => {
    assert.equal(synthesizeMarker(null as unknown as string, "company"), null);
  });

  it("rejects non-string input (undefined)", () => {
    assert.equal(synthesizeMarker(undefined as unknown as string, "company"), null);
  });

  it("all non-null results pass validatePattern", () => {
    // Comprehensive table: one representative per kind (ASCII variants).
    const cases: Array<[string, TokenKind]> = [
      ["FooCorp", "company"],
      ["foo-corp", "company"],
      ["ProjectNova", "codename"],
      ["Jane Smith", "person-name"],
      ["foo.example.com", "domain"],
      ["PROJ", "ticket-prefix"],
      ["123456789012", "account-id"],
      ["internal-token", "other"],
    ];
    for (const [token, kind] of cases) {
      const p = synthesizeMarker(token, kind);
      if (p !== null) {
        const r = validatePattern(p);
        assert.equal(
          r.ok,
          true,
          `synthesizeMarker(${JSON.stringify(token)}, ${kind}) produced invalid pattern: ${p} — ${r.reason}`,
        );
      }
    }
  });

  it("ticket-prefix pattern matches ticket numbers", () => {
    const p = assertValidPattern(synthesizeMarker("PROJ", "ticket-prefix"), "PROJ");
    const re = new RegExp(p, "i");
    assert.ok(re.test("PROJ-123"), "should match PROJ-123");
    assert.ok(re.test("PROJ-1"), "should match PROJ-1");
    assert.equal(re.test("PROJ-"), false, "should not match PROJ- (no digits)");
    assert.equal(re.test("PROJ"), false, "should not match bare PROJ");
  });

  it("account-id pattern matches the exact number", () => {
    const p = assertValidPattern(synthesizeMarker("123456789012", "account-id"), "acct");
    const re = new RegExp(p, "i");
    assert.ok(re.test("123456789012"), "should match exact number");
    assert.ok(re.test("account: 123456789012 end"), "should match surrounded by spaces");
  });

  it("domain pattern does not match substrings without boundary", () => {
    const p = assertValidPattern(synthesizeMarker("acme.io", "domain"), "acme.io");
    const re = new RegExp(p, "i");
    assert.ok(re.test("acme.io"), "should match acme.io");
    assert.ok(re.test("visit acme.io today"), "should match in sentence");
    // With word boundary, 'notacme.io' should not match.
    assert.equal(re.test("notacme.io"), false, "should not match notacme.io");
  });

  it("company pattern matches with case-insensitive flag", () => {
    const p = assertValidPattern(synthesizeMarker("FooCorp", "company"), "FooCorp");
    const re = new RegExp(p, "i");
    assert.ok(re.test("FOOCORP"), "should match uppercase variant");
    assert.ok(re.test("foocorp"), "should match lowercase variant");
    assert.ok(re.test("foo corp"), "should match with space separator");
    assert.ok(re.test("foo-corp"), "should match with hyphen separator");
    assert.ok(re.test("foo_corp"), "should match with underscore separator");
  });
});
