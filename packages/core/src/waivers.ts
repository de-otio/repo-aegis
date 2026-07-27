// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// Reviewed-benign waivers for always-block findings.
//
// The only escape from a blocked finding is `--no-verify`, which disables
// the *entire* hook — and which an agent classifier correctly refuses to
// run on the user's behalf. That leaves no way to dismiss a finding a human
// has actually reviewed and judged benign (a test-fixture keypair, a
// deliberately fake token) without turning off protection wholesale.
//
// A waiver closes that gap narrowly: it is keyed on the exact
// (pattern id, blob sha) pair, so it covers precisely the bytes a human
// reviewed, survives history rewrites and re-scans (blob shas are content
// addressed), and does NOT cover a superficially similar secret introduced
// later in a new blob. See "D. Reviewed-benign waivers" in
// doc/plan-tag-push-and-hook-liveness.md for the full design, including the
// three independent controls (elsewhere in the CLI/hook layer) that keep a
// waiver from becoming an agent-reachable `--no-verify`.

import { createHash } from "node:crypto";
import { z } from "zod";
import { formatZodError } from "./schemas.js";

/**
 * Only patterns loaded from the `_always` marker file may be waived.
 *
 * Two reasons, both hard requirements, not style preferences:
 *
 * 1. The design's own non-goal forbids weakening the customer-marker deny
 *    set. Engagement-scoped and `_private_infra` patterns exist to protect
 *    a specific customer or this machine's private infrastructure; a
 *    waiver mechanism for those would let a single reviewer silently widen
 *    what a given repo may leak about a customer who has no visibility
 *    into that decision.
 * 2. A pattern digest committed to a *public* repo is an offline oracle.
 *    `patternId` embeds `sha256(pattern).slice(0, 12)` — for a generic
 *    `_always` secret shape (an AWS-key regex, a PEM header) that digest
 *    reveals nothing, because the pattern is public knowledge already. For
 *    an engagement marker (typically a customer name or domain, regex-
 *    escaped), the digest would let anyone hash candidate customer names
 *    offline and confirm a match against the committed waiver file —
 *    reconstructing exactly the fact the marker exists to keep private.
 *
 * `assertWaivable` throws {@link NotWaivableError} for any other stem; the
 * CLI `waive` command surfaces both reasons and points at
 * `repo-aegis allow <engagement>` as the correct tool for engagement-scoped
 * findings.
 */
export const WAIVABLE_STEM = "_always";

/**
 * Thrown by {@link assertWaivable} when a caller attempts to waive a
 * pattern whose id is not rooted at {@link WAIVABLE_STEM}. Carries the
 * offending id so callers can render it without re-deriving the stem.
 */
export class NotWaivableError extends Error {
  readonly code = "NOT_WAIVABLE" as const;
  constructor(public patternId: string) {
    super(
      `pattern "${patternId}" is not waivable: only "${WAIVABLE_STEM}/*" patterns ` +
        `may be waived. (1) Engagement-scoped and "_private_infra" patterns are ` +
        `excluded from waivers by design — weakening the customer-marker deny set ` +
        `is a non-goal. (2) A waived pattern's digest is committed to this ` +
        `(potentially public) repo; for a generic "${WAIVABLE_STEM}" secret shape ` +
        `that digest reveals nothing, but for an engagement marker it would let ` +
        `anyone hash candidate customer names offline and confirm a match. ` +
        `Use \`repo-aegis allow <engagement>\` for engagement-scoped findings.`,
    );
    this.name = "NotWaivableError";
  }
}

/**
 * Thrown by {@link parseWaivers} when the input does not conform to the
 * waiver schema. Deliberately fail-closed: a malformed entry is a thrown
 * error, never a silently-dropped or silently-kept waiver. Silently
 * dropping a malformed-but-intended entry would leave the operator
 * believing a finding is waived when it is not (surprising re-block);
 * silently keeping a malformed entry (e.g. coercing a bad date) could
 * widen what it covers without review. Both are wrong; loud failure is
 * the only option that can't drift from operator intent.
 */
export class WaiverParseError extends Error {
  readonly code = "WAIVER_PARSE" as const;
  constructor(message: string) {
    super(message);
    this.name = "WaiverParseError";
  }
}

/**
 * Mint a stable identifier for a deny-set pattern: `<stem>/<digest>`, where
 * `digest` is the first 12 hex characters of `sha256(pattern)`.
 *
 * Patterns themselves are unnamed (a marker file is just a list of regex
 * literals), so this is the only stable handle a human or a `waive`
 * command can reference. It is deterministic in the pattern text alone —
 * independent of file ordering — so it survives marker-file edits that
 * reorder or reformat surrounding lines. Truncated to 12 hex characters
 * (48 bits) purely for a shorter, copy-pasteable id; collision risk at
 * this scale is not a security boundary (see {@link NotWaivableError} for
 * why exposing the digest at all is safe only for `_always` patterns).
 */
export function patternId(stem: string, pattern: string): string {
  const digest = createHash("sha256").update(pattern).digest("hex").slice(0, 12);
  return `${stem}/${digest}`;
}

/**
 * Throws {@link NotWaivableError} unless `id`'s stem (the segment before
 * the first `/`) is {@link WAIVABLE_STEM}. Pure guard — callers minting or
 * applying a waiver call this before writing anything.
 */
export function assertWaivable(id: string): void {
  const stem = id.slice(0, id.indexOf("/") === -1 ? id.length : id.indexOf("/"));
  if (stem !== WAIVABLE_STEM) {
    throw new NotWaivableError(id);
  }
}

const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Matches the id shape minted by {@link patternId}: `<stem>/<12-hex>`. The
 * stem character class mirrors marker-file stem conventions (reserved
 * system stems and engagement ids: alphanumerics, `_`, `.`, `-`).
 */
const PATTERN_ID_REGEX = /^[A-Za-z0-9_.-]+\/[0-9a-f]{12}$/;

/** 40 lowercase hex characters: a git blob sha (sha1) in canonical form. */
const BLOB_SHA_REGEX = /^[0-9a-f]{40}$/;

const waiverSchema = z
  .object({
    pattern: z
      .string()
      .regex(PATTERN_ID_REGEX, {
        message: `'pattern' must look like "${WAIVABLE_STEM}/0123456789ab" (stem/12-hex-digest)`,
      }),
    blob: z.string().regex(BLOB_SHA_REGEX, {
      message: "'blob' must be a 40-character lowercase hex git blob sha",
    }),
    reason: z.string().min(1, "'reason' must be non-empty"),
    approver: z.string().min(1, "'approver' must be non-empty"),
    date: z.string().regex(DATE_REGEX, { message: "'date' must be YYYY-MM-DD" }),
    expires: z
      .string()
      .regex(DATE_REGEX, { message: "'expires' must be YYYY-MM-DD" })
      .optional(),
  })
  .passthrough();

export type Waiver = z.infer<typeof waiverSchema>;

/**
 * Parse the raw `waivers:` list from `.repo-aegis.yml` (or any other
 * source) into {@link Waiver}[]. Fail closed: the whole input is rejected
 * (thrown {@link WaiverParseError}) if *any* entry is malformed — see the
 * class doc for why partial acceptance is never correct here.
 *
 * `undefined`/`null` (the field is optional in the on-disk schema) parses
 * to `[]`; anything else that isn't an array of valid entries throws.
 */
export function parseWaivers(input: unknown): Waiver[] {
  if (input === undefined || input === null) return [];
  const result = z.array(waiverSchema).safeParse(input);
  if (!result.success) {
    throw new WaiverParseError(formatZodError(result.error, "waivers"));
  }
  return result.data;
}

/**
 * True if `now` is strictly after `expires` (both compared as YYYY-MM-DD).
 *
 * Boundary decision: a waiver dated `expires: 2027-07-26` is still valid
 * ON 2027-07-26 and expires starting 2027-07-27. This matches the ordinary
 * reading of "expires on this date" (the date is the last day of
 * validity, not the first day of invalidity) and avoids a reviewer who
 * set `expires` to "one year from today" finding the waiver already
 * inert on the date they wrote down. String comparison is safe and
 * timezone-independent because YYYY-MM-DD sorts lexicographically in
 * calendar order and `now` is reduced to the same shape before comparing.
 */
function isPastExpiry(expires: string, now: Date): boolean {
  const nowDate = now.toISOString().slice(0, 10);
  return nowDate > expires;
}

/**
 * True if `hit` is covered by an unexpired entry in `waivers`.
 *
 * `now` is an injected parameter — never `Date.now()`/`new Date()` inside
 * this module — so expiry behaviour is deterministic under test (the repo
 * design defaults require pinned nondeterminism for anything time-based).
 *
 * A hit with no `blob` can never be waived: a waiver covers specific
 * reviewed bytes, and a hit without a blob sha (e.g. a hit synthesised
 * from something other than a diffed/committed blob) has no bytes to key
 * against. Matching such a hit against every waiver's pattern id
 * regardless of content would silently widen coverage beyond what any
 * human reviewed.
 */
export function isWaived(
  hit: { patternId: string; blob?: string },
  waivers: readonly Waiver[],
  now: Date,
): boolean {
  if (hit.blob === undefined) return false;
  return waivers.some(w => {
    if (w.pattern !== hit.patternId) return false;
    if (w.blob !== hit.blob) return false;
    if (w.expires !== undefined && isPastExpiry(w.expires, now)) return false;
    return true;
  });
}

/**
 * Every waiver in `waivers` whose `expires` date has passed as of `now`.
 * The CLI uses this to warn on a still-configured-but-inert waiver — a
 * waiver that silently stopped applying is exactly the kind of drift the
 * plan's "always report `waived: N`" requirement exists to surface.
 */
export function expiredWaivers(waivers: readonly Waiver[], now: Date): Waiver[] {
  return waivers.filter(w => w.expires !== undefined && isPastExpiry(w.expires, now));
}
