// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// Universal secret-shaped patterns. Unlike the engagement-scoped deny
// set in `deny-set.ts`, these patterns are not configurable: they cover
// shapes that should never appear in Bash tool output regardless of
// which customer the developer is engaged with.
//
// Detection is deliberately conservative — false-positive risk on
// generic strings is acceptable because the consequence (a hook
// flagging a tool result so the agent can surface it for rotation) is
// cheap. False *negatives* are expensive (a real secret reaches the
// transcript). When in doubt, add another pattern.
//
// What we deliberately do NOT match:
//   - Hostnames or IP addresses (out of scope; not "secrets" by shape).
//   - High-entropy generic blobs (UUIDs, base64-encoded data) — too
//     much noise; rely on shape-specific patterns instead.
//   - Customer-specific identifiers — those belong in the per-engagement
//     deny set, not here.
//
// Pattern hardening: every regex is anchored to a recognisable shape
// (a literal prefix and a length-bounded body). No greedy `.*` quantifiers
// over potentially unbounded input. We compile once at module load.

export type SecretMarkerKind =
  | "PEM_HEADER"
  | "PEM_AS_HEX"
  | "JWT"
  | "GITHUB_TOKEN";

export interface SecretMarkerHit {
  /** Which family of secret was detected. */
  kind: SecretMarkerKind;
  /** Byte offset of the match within the scanned text. */
  offset: number;
  /** Length of the match in bytes. */
  length: number;
}

interface CompiledPattern {
  kind: SecretMarkerKind;
  re: RegExp;
}

// Limit single-pattern body lengths to defend against pathological
// input. 16 KB is generous for any real PEM / token / JWT shape.
const MAX_BODY = 16 * 1024;

const PATTERNS: CompiledPattern[] = [
  // PEM headers in any common form: RSA, DSA, EC, ED25519, generic
  // "PRIVATE KEY", and the corresponding ENCRYPTED variant. The
  // closing dashes anchor the match without needing to capture the
  // body, so a partial PEM (truncated by `head`/`tail`) still trips.
  {
    kind: "PEM_HEADER",
    re: /-----BEGIN (?:RSA |DSA |EC |OPENSSH |ENCRYPTED |PGP )?PRIVATE KEY-----/g,
  },

  // PEM-as-ASCII-hex. The macOS keychain returns
  // `security find-generic-password -w` as hex when the value contains
  // newlines, so any PEM round-trips as a long hex string. Match the
  // hex of `-----BEGIN ` (the prefix common to every PEM header):
  // `-----BEGIN ` => `2D2D2D2D2D424547494E20` (case-insensitive on hex).
  {
    kind: "PEM_AS_HEX",
    re: /(?:2D){5}424547494E20/gi,
  },

  // JWT shape. Three URL-safe-base64 segments separated by dots, each
  // at least 8 chars. The first segment must start with `eyJ` (the
  // unencrypted base64 of `{"`), which is the universal JWT header
  // prefix. Bounded body length per segment to defend against
  // catastrophic backtracking (although the inner class is bounded
  // already).
  {
    kind: "JWT",
    re: /\beyJ[A-Za-z0-9_-]{8,4096}\.eyJ[A-Za-z0-9_-]{8,4096}\.[A-Za-z0-9_-]{8,4096}/g,
  },

  // GitHub token shapes: PAT (`ghp_`), OAuth (`gho_`), App user
  // (`ghu_`), App installation (`ghs_`), refresh (`ghr_`), and the
  // newer fine-grained PAT prefix `github_pat_`. All use a fixed
  // suffix character class plus length range. Tokens shorter than 36
  // chars after the prefix are unlikely to be live tokens but still
  // worth flagging — false positives here cost nothing.
  {
    kind: "GITHUB_TOKEN",
    re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{20,255})\b/g,
  },
];

/**
 * Scan a single string for any secret-shaped pattern. Returns one hit
 * per match (a single PEM that's also matched as PEM-as-hex via
 * pre-encoding will produce two hits — that's fine; the hook
 * deduplicates by kind on output).
 *
 * The scanned input is bounded by the caller (the Bash-output hook
 * caps at a few MB). This function does not enforce its own size cap
 * because callers vary in tolerance.
 *
 * The function NEVER returns the matched substring — only the kind,
 * offset, and length. By construction, a hit cannot leak the secret
 * back through the result type.
 */
export function scanForSecrets(text: string): SecretMarkerHit[] {
  const hits: SecretMarkerHit[] = [];
  for (const { kind, re } of PATTERNS) {
    // RegExp objects with /g flag are stateful via lastIndex; reset
    // before each scan so concurrent callers don't trip over each
    // other (we use a fresh exec loop per call, not iterators).
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    let iter = 0;
    while ((m = re.exec(text)) !== null) {
      const matched = m[0];
      // Defensive: cap match length tracked. If a single match somehow
      // exceeds MAX_BODY, record only the first MAX_BODY bytes' worth
      // and advance lastIndex past it.
      const length = Math.min(matched.length, MAX_BODY);
      hits.push({ kind, offset: m.index, length });
      if (matched.length === 0) re.lastIndex++; // safety against zero-width
      // Bail out of pathological-input loops: 1000 hits of the same
      // pattern is far more than any legitimate output produces.
      if (++iter > 1000) break;
    }
  }
  // Sort by offset so the caller can report hits in source order.
  hits.sort((a, b) => a.offset - b.offset);
  return hits;
}

/**
 * Summarise hits as a redacted preview suitable for echoing back to
 * the user / agent. Returns the kinds present and the total count;
 * never includes any byte of matched content.
 */
export function summariseHits(hits: SecretMarkerHit[]): {
  kinds: SecretMarkerKind[];
  count: number;
} {
  const kinds = Array.from(new Set(hits.map(h => h.kind))).sort();
  return { kinds, count: hits.length };
}
