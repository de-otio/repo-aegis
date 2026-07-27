// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// Built-in recognition for documented example/placeholder secrets.
//
// A secret-shaped token that is, by construction, not a secret (a vendor's
// published documentation example, a `CHANGEME`-style placeholder left by a
// scaffolding tool) should never block a commit. Without this, every repo
// that copies an AWS docs snippet or a `.env.example` template trips the
// `_always` deny set and the operator either edits the deny set (weakening
// it) or reaches for `--no-verify` (disabling it entirely) — see
// `waivers.ts` for why both are worse than a narrow, principled allowlist.
//
// Scope cut from the source design: the scanner is line-oriented
// (`scanText` splits on "\n" and matches per line; see scan.ts), so
// recognising a multi-line PEM body (the RFC 7515 / RFC 8037 example keys)
// would need block-level context this module deliberately does not have,
// plus a normalisation rule for line-wrapping and whitespace that is
// brittle by construction. This module only ever looks at one matched
// token plus the line it came from. Multi-line block-aware matching is
// explicitly out of scope here; revisit only if a real PEM false positive
// survives the path-scoped-exemptions work (plan section B).
//
// Scoping is the CALLER's responsibility, not this module's: `scanText` /
// `processDiffLine` must apply `isKnownNonSecret` only to hits whose
// deny-set source stem is `_always` (see `patternSources` on `DenySet`).
// This function has no notion of source stem — it just answers "does this
// token look like a documented example/placeholder" — because engagement
// markers and `_private_infra` patterns must NEVER be suppressed this way:
// a customer name or private host that happens to end in a word like
// "EXAMPLE" is still a real leak, and a customer marker calling something
// "REDACTED" doesn't make it safe to publish. Baking the stem check in here
// would make that safety property depend on this module's internals rather
// than on the explicit call site the design review can audit.

/**
 * AWS access-key-ID shape: a documented 4-letter type prefix (AKIA for a
 * long-term key, ASIA for STS-issued temporary credentials, and the other
 * prefixes AWS documents) followed by 16 more uppercase-alphanumeric
 * characters, 20 characters total. This is how AWS's own published
 * example access keys are structured; matching the shape (rather than a
 * hardcoded literal) lets us recognise "this is the well-known example
 * key" without ever embedding that key's literal text in this repo — see
 * the self-hygiene note below.
 */
const AWS_ACCESS_KEY_ID_SHAPE =
  /^(?:AKIA|ABIA|ACCA|ASIA|AIDA|AROA|AGPA|AIPA|ANPA|ANVA)[A-Z0-9]{16}$/;

/**
 * Placeholder bodies that mark a token as a documented non-secret rather
 * than real credential material. Matched as a case-insensitive SUFFIX
 * (never a substring-anywhere match) so a real secret that merely
 * mentions one of these words mid-string is not swept up — see
 * `isKnownNonSecret`'s doc comment for why "contains" would be wrong.
 *
 * Case-insensitive because these placeholders appear in the wild in both
 * conventions (`CHANGEME` in ops runbooks, `changeme` in scaffolded
 * `.env.example` files); the shape signal (a whole token ending in one of
 * these words) is what marks it as a placeholder, not the letter case.
 */
const PLACEHOLDER_SUFFIXES = ["EXAMPLE", "REDACTED", "CHANGEME", "XXXXXXXX"];

/**
 * The `YOUR-…-HERE` placeholder shape used by countless scaffolding tools
 * (`YOUR-API-KEY-HERE`, `YOUR_SECRET_HERE`). Anchored on both ends so it
 * only matches a token that IS this shape in full, not one that merely
 * contains "your" or "here" somewhere.
 */
const YOUR_DASH_HERE_SHAPE = /^YOUR[-_][A-Za-z0-9_-]*[-_]HERE$/i;

function hasPlaceholderBody(token: string): boolean {
  const upper = token.toUpperCase();
  if (PLACEHOLDER_SUFFIXES.some(suffix => upper.endsWith(suffix))) return true;
  return YOUR_DASH_HERE_SHAPE.test(token);
}

/**
 * True if `matched` — a token the deny-set scanner flagged as secret-
 * shaped — is a recognised documented example or placeholder rather than
 * real credential material.
 *
 * `line` is accepted for interface stability with the line-local scanning
 * model (every other scan primitive in this package threads the
 * containing line alongside the match) and to leave room for line-local
 * context checks later; it is not currently consulted, because every
 * signal this module recognises is fully determined by `matched` alone.
 * Deliberately NOT doing a `line.includes("EXAMPLE")` style check: that
 * would make this a blanket "the line mentions EXAMPLE" bypass, trivially
 * defeated by adding that word as a comment next to a real secret.
 *
 * Matching is suffix/exact-shape based, never substring-anywhere: a token
 * that merely CONTAINS "EXAMPLE" in the middle (e.g. embedded in a larger
 * real credential, or a customer marker whose text happens to include the
 * word) does not match. Only a token whose AWS-key-shaped body ends in
 * "EXAMPLE", or whose entire matched text ends in one of the placeholder
 * words / fits the `YOUR-…-HERE` shape, is recognised.
 */
export function isKnownNonSecret(matched: string, line: string): boolean {
  void line;
  const trimmed = matched.trim();
  if (trimmed.length === 0) return false;

  if (AWS_ACCESS_KEY_ID_SHAPE.test(trimmed) && trimmed.toUpperCase().endsWith("EXAMPLE")) {
    return true;
  }

  return hasPlaceholderBody(trimmed);
}
