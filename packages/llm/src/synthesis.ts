// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// synthesis.ts — deterministic token-to-regex synthesis for marker discovery.
//
// The LLM *never* produces regex directly. This function is the single
// trusted path that converts an LLM-suggested *token* (a plain string) into
// a compiled-safe regex pattern string. Keeping synthesis here ensures a
// malicious or hallucinating model cannot inject pathological patterns.
//
// [SEC M-4] Unicode boundary note:
//   For tokens containing non-ASCII code points, word boundaries (\b) are
//   not Unicode-aware (JS \b only treats [A-Za-z0-9_] as word chars).
//   Such tokens use lookbehind/lookahead with \p{L} instead:
//     (?<!\p{L})<body>(?!\p{L})
//   Consumers MUST compile patterns that contain \p{ with the `u` flag
//   (e.g. new RegExp(pattern, "ui")) to obtain correct Unicode boundary
//   matching. validatePattern from @de-otio/repo-aegis-core compiles
//   without `u` by default, so \p{L} is treated as literal 'p' there —
//   the pattern still passes validatePattern (it is syntactically valid),
//   but correct runtime behaviour requires the `u` flag. Call-site
//   documentation: if synthesizeMarker returns a pattern containing the
//   literal string '\p{', compile it with the `u` flag.

import { validatePattern } from "@de-otio/repo-aegis-core";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The set of token kinds produced by the token-extraction model call.
 * Each kind drives a different synthesis strategy.
 */
export type TokenKind =
  | "company"
  | "codename"
  | "person-name"
  | "domain"
  | "ticket-prefix"
  | "account-id"
  | "other";

/**
 * Exported prompt-source map used in tests to verify each kind is exercised.
 * Maps a TokenKind to a representative prompt phrase (documentation only).
 */
export const PROMPT_SOURCE_MAP: Record<TokenKind, string> = {
  company: "company name or brand (e.g. FooCorp)",
  codename: "internal project codename (e.g. ProjectAlpha)",
  "person-name": "person's name (e.g. Jane Smith)",
  domain: "internet domain name (e.g. foo.example.com)",
  "ticket-prefix": "JIRA/issue tracker prefix (e.g. FOO for FOO-123)",
  "account-id": "numeric account or resource identifier (6-16 digits)",
  other: "any other identifying token",
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Escape all regex metacharacters in a string so it matches the literal text.
 * Handles: . * + ? ^ $ { } [ ] | ( ) \ /
 */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Returns true if the token contains at least one non-ASCII code point.
 *
 * [SEC M-4] When this returns true, synthesis must use Unicode-aware
 * boundaries ((?<!\p{L})..(?!\p{L})) instead of \b.
 */
function hasNonAscii(token: string): boolean {
  return /[^\x00-\x7f]/.test(token);
}

/**
 * Wrap a regex body in word-boundary markers appropriate for the token.
 *
 * [SEC M-4] For ASCII-only tokens uses \b...\b.
 * For tokens containing non-ASCII code points uses (?<!\p{L})...(?!\p{L}).
 * The consumer must compile \p{L}-containing patterns with the `u` flag.
 */
function wrapBoundary(body: string, unicode: boolean): string {
  if (unicode) {
    return `(?<!\\p{L})${body}(?!\\p{L})`;
  }
  return `\\b${body}\\b`;
}

/**
 * Split a single alphanumeric segment on camelCase transitions.
 *
 * Rules:
 * - Only applies when the segment consists solely of [A-Za-z0-9].
 *   Segments containing other characters (e.g. '.') are returned as-is.
 * - Only splits when both uppercase and lowercase letters are present
 *   (i.e. a true camelCase transition exists). Pure-uppercase acronyms
 *   (e.g. "ACME") and pure-lowercase words are returned as single-element
 *   arrays.
 *
 * Examples:
 *   "FooCorp"    -> ["Foo", "Corp"]
 *   "ABCDef"     -> ["ABC", "Def"]
 *   "HTTPSProxy" -> ["HTTPS", "Proxy"]
 *   "ACME"       -> ["ACME"]   (pure-uppercase: no split)
 *   "foo"        -> ["foo"]    (pure-lowercase: no split)
 *   "foo.corp"   -> ["foo.corp"] (non-alphanumeric: no split)
 */
function splitCamelCase(seg: string): string[] {
  // If the segment contains non-alphanumeric characters, treat as a literal.
  if (!/^[A-Za-z0-9]+$/.test(seg)) {
    return [seg];
  }
  // Only split when both upper and lower case are present (camelCase exists).
  const hasUpper = /[A-Z]/.test(seg);
  const hasLower = /[a-z]/.test(seg);
  if (!hasUpper || !hasLower) {
    return [seg]; // all-caps acronym or all-lowercase word
  }
  // Order matters: longest matches first.
  // [A-Z]+(?=[A-Z][a-z]) catches an all-caps acronym before a TitleCase word.
  // [A-Z][a-z0-9]+ catches a TitleCase word.
  // [A-Z] catches a solo uppercase letter.
  // [a-z0-9]+ catches a lowercase/digit run.
  const parts = seg.match(/[A-Z]+(?=[A-Z][a-z])|[A-Z][a-z0-9]+|[A-Z]|[a-z0-9]+/g);
  return parts && parts.length > 0 ? parts : [seg];
}

/**
 * Build the regex body for company/codename/person-name tokens.
 *
 * Strategy:
 *   1. Split on explicit separators (-, _, and space runs).
 *   2. For ASCII-only tokens: further split each separator-split part on
 *      camelCase transitions (see splitCamelCase).
 *      For non-ASCII tokens: only split on explicit separators (preserves
 *      non-ASCII characters that the ASCII-only camelCase regex would lose).
 *   3. Escape regex metacharacters per part, lowercase, join with [-_ ]?.
 *
 * Examples:
 *   "FooCorp"   -> "foo[-_ ]?corp"
 *   "foo-corp"  -> "foo[-_ ]?corp"
 *   "ACME"      -> "acme"
 *   "Muller"    -> "muller"  (non-ASCII path: preserves umlaut)
 */
function buildNameBody(token: string): string {
  const nonAscii = hasNonAscii(token);

  // Split on explicit separators first.
  const separatorParts = token.split(/[-_ ]+/).filter((p) => p.length > 0);

  let parts: string[];
  if (!nonAscii) {
    // ASCII-only: further split each part on camelCase transitions.
    parts = [];
    for (const seg of separatorParts) {
      parts.push(...splitCamelCase(seg));
    }
  } else {
    // Non-ASCII: preserve non-ASCII characters as-is; only split on
    // explicit separators. camelCase detection is ASCII-only and would
    // incorrectly fragment strings containing non-ASCII letters.
    parts = separatorParts;
  }

  return parts
    .map((p) => escapeRegex(p).toLowerCase())
    .join("[-_ ]?");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Convert a model-suggested token into a deterministic regex pattern string,
 * or return null if the token/kind combination is invalid.
 *
 * The returned pattern (when non-null) is validated via `validatePattern`
 * from `@de-otio/repo-aegis-core` before being returned. Patterns that fail
 * validation are dropped (null returned).
 *
 * [SEC M-4] Patterns that contain `\p{` must be compiled by the consumer
 * with the `u` flag (e.g. `new RegExp(pattern, "ui")`) to get correct
 * Unicode-aware boundary matching. `validatePattern` itself does not use
 * the `u` flag and will accept these patterns as syntactically valid (treating
 * `\p` as a literal `p`), so the validation step does not confirm Unicode
 * correctness — only the consumer compilation does.
 *
 * @param token - The plain-text token extracted by the model.
 * @param kind  - The category of the token.
 * @returns A regex pattern string, or null if the token is rejected.
 */
export function synthesizeMarker(token: string, kind: TokenKind): string | null {
  if (typeof token !== "string" || token.trim().length === 0) {
    return null;
  }

  const unicode = hasNonAscii(token);
  let pattern: string;

  switch (kind) {
    case "company":
    case "codename":
    case "person-name": {
      // Escape metacharacters; insert [-_ ]? at camelCase/kebab boundaries;
      // wrap in word boundaries; lowercase for consistency.
      // Consumers compile with `i` flag — lowercasing the pattern is
      // belt-and-suspenders but also makes the pattern human-readable.
      const body = buildNameBody(token);
      pattern = wrapBoundary(body, unicode);
      break;
    }

    case "domain": {
      // Escape every dot to \. and all other metacharacters.
      // Wrap in word boundaries (left: start of first label; right: end of TLD).
      const body = escapeRegex(token.toLowerCase());
      pattern = wrapBoundary(body, unicode);
      break;
    }

    case "ticket-prefix": {
      // Validate: PREFIX must be [A-Z][A-Z0-9]+ (all-uppercase, 2+ chars).
      // Ticket prefixes are always ASCII (Jira, Linear, etc.) so Unicode
      // boundaries are not applicable; this check is a belt-and-suspenders
      // guard that also enforces the ASCII constraint implicitly.
      if (!/^[A-Z][A-Z0-9]+$/.test(token)) {
        return null;
      }
      const escapedPrefix = escapeRegex(token);
      pattern = `\\b${escapedPrefix}-[0-9]+\\b`;
      break;
    }

    case "account-id": {
      // Validate: must be a numeric string with 6-16 digits.
      // Rejects short numbers that would cause excessive false positives.
      if (!/^[0-9]{6,16}$/.test(token)) {
        return null;
      }
      // account-id tokens are always ASCII digits; \b boundaries are correct.
      const escapedId = escapeRegex(token);
      pattern = `\\b${escapedId}\\b`;
      break;
    }

    case "other": {
      // Word-bounded literal escape; no fancy variants.
      const body = escapeRegex(token.toLowerCase());
      pattern = wrapBoundary(body, unicode);
      break;
    }

    default: {
      // Exhaustiveness guard — TypeScript narrowing should prevent this.
      return null;
    }
  }

  // Validate the synthesised pattern via core's validatePattern.
  // Note: for patterns containing \p{ (Unicode-boundary patterns), this
  // validates without the `u` flag — the pattern is accepted as syntactically
  // valid but \p is interpreted as literal 'p'. Correctness at runtime
  // requires the consumer to use the `u` flag. See [SEC M-4] comment.
  const result = validatePattern(pattern);
  if (!result.ok) {
    return null;
  }

  return pattern;
}
