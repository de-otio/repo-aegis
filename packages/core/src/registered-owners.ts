// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// Registered owners: the one answer to "does repo-aegis know this GitHub
// owner?" (doc/plan-unregistered-owner-egress.md, issue #151, decision D2).
//
// An owner is registered when it appears in `personalOrgs` or in any
// engagement's `githubOrgs`. Nothing else counts: not the destination cache,
// not a repo-local `repo-aegis.class`, not an egress approval. An agent can
// write each of those, so none can be allowed to widen the set rule h trusts.
// Only the registry's own owner lists (and `allowedUpstreams`, below) do, and
// adding to them needs a person at a terminal.
//
// This module is the single implementation. The agent hook, the `gh` shim,
// the pre-push hook and `doctor` all call it, so they cannot disagree about
// which owners are ours.
import type { EgressVerb } from "./egress-intent.js";
import type { Registry } from "./registry.js";

/**
 * Verbs an `allowedUpstreams` entry lifts rule h for (decision D6): PRs,
 * issues and comments aimed at a repository the operator contributes to but
 * does not own. Deliberately excludes `git push`, merge, release, repo,
 * workflow and `gh api` writes: an upstream is somewhere to propose changes,
 * never somewhere to publish directly.
 */
export const UPSTREAM_ADMITTED_VERBS: ReadonlySet<EgressVerb> = new Set<EgressVerb>([
  "gh-pr-create",
  "gh-pr-edit",
  "gh-pr-comment",
  "gh-pr-review",
  "gh-issue-create",
  "gh-issue-edit",
  "gh-issue-comment",
]);

/** `personalOrgs ∪ ⋃ engagements[*].githubOrgs`, lower-cased. */
export function registeredOwners(registry: Registry): Set<string> {
  const owners = new Set<string>();
  for (const o of registry.personalOrgs ?? []) owners.add(o.toLowerCase());
  for (const e of registry.engagements) {
    for (const o of e.githubOrgs ?? []) owners.add(o.toLowerCase());
  }
  return owners;
}

/** Whether rule h is judging, and if not, why not (D4: every skip says which state applied). */
export type RuleHStatus = "applied" | "skipped:missing" | "skipped:no-owners";

/**
 * Rule h's standing for a registry state. `unreadable` is `applied`: it
 * refuses. Layers use this to say so when rule h did NOT run, so an operator
 * is never left believing an owner check happened when there was nothing to
 * check against. Carries no registry contents.
 */
export function ruleHStatus(state: "loaded" | "missing" | "unreadable", registry: Registry): RuleHStatus {
  if (state === "missing") return "skipped:missing";
  if (state === "loaded" && registeredOwners(registry).size === 0) return "skipped:no-owners";
  return "applied";
}

/** One-line, content-free note for a skipped rule h; `null` when it applied. */
export function ruleHSkipNote(status: RuleHStatus): string | null {
  switch (status) {
    case "skipped:missing":
      return "rule h (unregistered-owner check) skipped: no registry file exists";
    case "skipped:no-owners":
      return "rule h (unregistered-owner check) skipped: the registry declares no owners";
    case "applied":
      return null;
  }
}

/** The destination fields {@link ownerAdmitted} reads. */
export interface OwnerCandidate {
  org: string;
  repo: string;
  /** Set when nothing offline can name the repository (e.g. a GraphQL mutation). */
  unresolved?: string;
}

/**
 * Whether rule h admits this destination: its owner is registered, or it is
 * an exact `owner/repo` in `allowedUpstreams` and the verb is one of
 * {@link UPSTREAM_ADMITTED_VERBS}.
 *
 * An unresolved destination is never admitted: a write whose owner cannot be
 * named offline counts as unregistered (D5). `allowedUpstreams` entries are
 * exact, with no wildcards, so `upstream-org/other` is not admitted by an
 * entry for `upstream-org/lib`, and neither is the owner as a whole.
 */
export function ownerAdmitted(
  destination: OwnerCandidate,
  intent: { verb: EgressVerb },
  owners: ReadonlySet<string>,
  registry: Pick<Registry, "allowedUpstreams">,
): boolean {
  if (destination.unresolved !== undefined) return false;
  const org = destination.org.toLowerCase();
  if (owners.has(org)) return true;
  if (!UPSTREAM_ADMITTED_VERBS.has(intent.verb)) return false;
  const key = `${org}/${destination.repo.toLowerCase()}`;
  return (registry.allowedUpstreams ?? []).some(u => u.toLowerCase() === key);
}
