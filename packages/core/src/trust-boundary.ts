// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// Trust-boundary computation for the path-aware PostToolUse hook.
//
// Two working trees are in the same trust boundary if their derived
// org sets overlap. The org set for a working tree is:
//
//   (engagements[*].githubOrgs of every engagement the repo is
//    allow'd into)
//   ∪ (personalOrgs, if class === public-eligible)
//   ∪ (remote-origin org, if the above is empty)
//
// The classification is the source of truth (per design open question
// #3): a fork's remote may belong to one org while the classification
// declares the canonical engagement-org mapping. The remote is only
// consulted as a last-resort fallback for completely unclassified repos.

import { readRepoConfig, type RepoClass } from "./repo.js";
import { type Registry } from "./registry.js";
import { getRemoteOrg } from "./working-tree.js";

export interface TrustBoundary {
  /** Set of GitHub orgs that span this repo's trust boundary. */
  orgs: Set<string>;
  /**
   * True when `orgs` came from the git remote because no
   * classification could supply orgs. The hook surfaces this as
   * `DEST_UNCLASSIFIED` when the destination tree is in this state.
   */
  fromRemoteFallback: boolean;
  /** The repo's resolved class (private-strict if unclassified). */
  class: RepoClass;
  /** True if class came from explicit git config / `.repo-aegis.yml`. */
  classExplicit: boolean;
}

/**
 * Compute the trust boundary for a working tree against a registry.
 *
 * Reads `git config repo-aegis.class` / `.repo-aegis.yml` for the
 * working tree (via {@link readRepoConfig}), pulls the relevant
 * `githubOrgs` arrays out of the registry, and falls back to the
 * remote URL only when the classification supplies no orgs.
 */
export function computeTrustBoundary(
  workingTree: string,
  registry: Registry,
): TrustBoundary {
  const repo = readRepoConfig(workingTree);
  const orgs = new Set<string>();

  // Engagement-derived orgs.
  for (const engId of repo.engagements) {
    const eng = registry.engagements.find(e => e.id === engId);
    if (!eng) continue;
    for (const org of eng.githubOrgs ?? []) {
      orgs.add(org.toLowerCase());
    }
  }

  // public-eligible repos sit on every personal org. The model says
  // "this repo is not customer-coupled, so anything in personalOrgs
  // is its peer."
  if (repo.class === "public-eligible") {
    for (const org of registry.personalOrgs ?? []) {
      orgs.add(org.toLowerCase());
    }
  }

  let fromRemoteFallback = false;
  if (orgs.size === 0) {
    const remoteOrg = getRemoteOrg(workingTree);
    if (remoteOrg !== null) {
      orgs.add(remoteOrg);
      fromRemoteFallback = true;
    }
  }

  return {
    orgs,
    fromRemoteFallback,
    class: repo.class,
    classExplicit: repo.classExplicit,
  };
}

/**
 * Two trust boundaries overlap iff their org sets share at least one
 * element. Two empty sets do NOT overlap — that's the "neither side
 * has any signal" case, which the policy layer treats as
 * "scan-with-warning" rather than silently allowing.
 */
export function trustBoundariesOverlap(a: TrustBoundary, b: TrustBoundary): boolean {
  if (a.orgs.size === 0 || b.orgs.size === 0) return false;
  for (const o of a.orgs) if (b.orgs.has(o)) return true;
  return false;
}
