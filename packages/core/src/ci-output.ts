// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// Attribution redaction for output that leaves the machine.
//
// The redaction policy that already exists (`redaction.ts`) covers the matched
// *literal* — the customer string itself. It says nothing about *attribution*:
// which engagement a hit belongs to, which engagements this repo is allowed to
// carry, which marker files the deny set was built from. Attribution was never
// treated as sensitive because, before CI, `check --json` and `audit --json`
// only ever reached a local terminal or an agent's tool result, both of which
// are already inside the trust boundary.
//
// CI is not. A PR comment, an issue body, a step output consumed by a
// downstream action, and a job log are all world-readable on a public repo. An
// engagement id IS the customer name in most registries — it is the string the
// whole tool exists to keep out of public places. Publishing it as part of a
// leak *report* would be the tool leaking the thing it guards.
//
// Two consequences that are easy to miss:
//
//   1. A CLEAN run leaks too. `audit --json` emits `engagements: [...]` at the
//      top level regardless of findings, so a repo with zero hits still
//      publishes its full engagement list. Redaction cannot be conditional on
//      there being hits.
//   2. `patternId` is attribution. It is `<stem>/<12 hex of sha256(pattern)>`.
//      For an `_always` stem that is a generic secret shape and safe — it is
//      also what makes a waiver referenceable, so it must survive. For an
//      engagement stem the digest is an offline oracle for guessing the
//      literal it came from (the same argument `waive` already makes when it
//      refuses to waive a non-`_always` pattern), and the stem itself is the
//      customer name in plaintext. Both must go.
//
// What survives redaction is what makes a finding actionable to someone who
// can already read the repo: path, line, column, the redacted preview, and
// counts. "3 hits across 2 engagements in src/foo.ts" is enough to act on; the
// operator resolves which engagements by re-running locally.
import { ALWAYS_FILE_STEM } from "./deny-set.js";

/**
 * True when a marker-file stem is safe to name in published output.
 *
 * Only `_always` qualifies: it is the universal secret-shape set, identical in
 * every install, and names no customer. Every other stem is either an
 * engagement id or `_private_infra` — the first is a customer name, the second
 * discloses that the operator has private infrastructure markers and, by
 * position in a hit list, where they matched.
 */
export function isPublishableStem(stem: string): boolean {
  return stem === ALWAYS_FILE_STEM;
}

/** The placeholder a redacted stem collapses to. Fixed, so it cannot be counted apart. */
export const REDACTED_STEM = "<redacted>";

/** Shape of the attribution fields any scan hit may carry. */
export interface AttributedHit {
  engagement?: string;
  patternId?: string;
}

/**
 * Strip attribution from one hit. Returns a new object; the input is untouched.
 *
 * `engagement` is dropped outright rather than replaced with a placeholder:
 * a `"<redacted>"` value in every hit is noise, and the distinct-engagement
 * count reported alongside the hit list carries the only aggregate signal a
 * reader can act on anyway.
 */
export function redactHitAttribution<T extends AttributedHit>(hit: T): T {
  const { engagement, patternId, ...rest } = hit;
  return {
    ...rest,
    ...(patternId !== undefined && isPublishablePatternId(patternId) && { patternId }),
  } as T;
}

/**
 * True when a `<stem>/<digest>` pattern id is safe to publish.
 *
 * `_always/<digest>` is: the digest is of a generic secret shape, and it is
 * the handle `repo-aegis waive` records a decision against, so a CI report
 * that dropped it would leave the reader unable to act on the finding. Any
 * other stem is not, on both counts — the stem is a customer name in
 * plaintext, and the digest is an offline oracle for guessing the pattern it
 * came from.
 */
export function isPublishablePatternId(patternId: string): boolean {
  return isPublishableStem(stemOf(patternId));
}

/** Apply {@link redactHitAttribution} across a list. */
export function redactHits<T extends AttributedHit>(hits: readonly T[]): T[] {
  return hits.map(redactHitAttribution);
}

/**
 * Collapse a list of marker-file stems to publishable ones, replacing the rest
 * with {@link REDACTED_STEM}.
 *
 * Position is preserved rather than filtered out so `denySet.files` still
 * conveys how many marker files contributed — a deny set that silently lost an
 * engagement file is exactly the regression `--min-patterns` exists to catch,
 * and a redacted list that also hid the count would defeat it.
 */
export function redactStems(stems: readonly string[]): string[] {
  return stems.map(s => (isPublishableStem(s) ? s : REDACTED_STEM));
}

/** Count distinct engagements represented in a hit list, before redaction. */
export function distinctEngagementCount(hits: readonly AttributedHit[]): number {
  const seen = new Set<string>();
  for (const h of hits) {
    if (h.engagement !== undefined && !isPublishableStem(h.engagement)) seen.add(h.engagement);
  }
  return seen.size;
}

/** The stem half of a `<stem>/<digest>` pattern id. */
function stemOf(patternId: string): string {
  const slash = patternId.lastIndexOf("/");
  return slash === -1 ? patternId : patternId.slice(0, slash);
}

/**
 * Whether attribution should be redacted for this invocation.
 *
 * Two ways in, because the two callers are different kinds of user:
 * `--redact-attribution` for a human or a workflow author who knows the output
 * is being published, and `REPO_AEGIS_REDACT_ATTRIBUTION=1` for the composite
 * Action, which sets it for every invocation without having to thread a flag
 * through an `args` string a consumer might overwrite.
 *
 * Deliberately NOT the default for local runs: at a terminal, attribution is
 * the single most useful field ("which customer's marker did I just trip?"),
 * and the terminal is not a publication channel.
 */
export function shouldRedactAttribution(flag: boolean | undefined, env = process.env): boolean {
  if (flag) return true;
  return env.REPO_AEGIS_REDACT_ATTRIBUTION === "1";
}
