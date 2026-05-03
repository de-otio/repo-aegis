// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// Decision layer for the path-aware PostToolUse hook.
//
// Given the path the agent just wrote (`filePath`) and the directory
// the agent was launched from (`launcherCwd`), decide:
//
//   - which working tree's classification + deny set to scan against
//     (the destination tree, by file containment),
//   - whether the cross-tree write is allowed at all (same trust
//     boundary, by org membership),
//   - whether to emit an advisory warning about an unclassified
//     destination.
//
// Pure: takes everything it needs as arguments. The hook itself owns
// stdin / process.exit / JSON emission.

import {
  computeTrustBoundary,
  findEnclosingWorkingTree,
  readRepoConfig,
  trustBoundariesOverlap,
  type Registry,
  type RepoConfig,
  type TrustBoundary,
} from "@de-otio/repo-aegis-core";

export type HookDecision =
  | HookScanDecision
  | HookScanWithWarningDecision
  | HookRefuseDecision;

/** Run a regular scan against `workingTree`'s rules. */
export interface HookScanDecision {
  action: "scan";
  workingTree: string | null;
  repo: RepoConfig;
}

/**
 * Run a scan but include a structured warning in the result. Used when
 * the destination tree has no classification (no class, no engagements,
 * no remote) — we can't make a positive trust-boundary decision, so we
 * still scan against `_always` and tell the user "you might want to
 * classify this repo."
 */
export interface HookScanWithWarningDecision {
  action: "scan-with-warning";
  workingTree: string | null;
  repo: RepoConfig;
  warning: HookWarning;
}

/**
 * Refuse the operation entirely. The file is already on disk
 * (PostToolUse), so the hook signals the agent via a non-zero exit and
 * a structured error code. The agent's recovery is to surface the
 * issue to the user and propose reverting the file.
 */
export interface HookRefuseDecision {
  action: "refuse";
  code: "CROSS_ORG_WRITE";
  srcOrgs: string[];
  destOrgs: string[];
  destTree: string;
}

export interface HookWarning {
  code: "DEST_UNCLASSIFIED";
  destTree: string;
  /** True when the destination has a remote we could parse but no
   *  explicit class / engagement assignment. Hook surfaces this as an
   *  actionable hint ("run `repo-aegis classify` in <destTree>"). */
  hasRemote: boolean;
}

/**
 * Decide what the hook should do.
 *
 * Decision order:
 *   1. If `filePath` resolves to no working tree at all: scan against a
 *      synthetic `private-strict / no engagements` config — only the
 *      registry's `_always` patterns apply. (Bare `/tmp` writes etc.)
 *   2. If destination tree === source tree: scan, no policy. The
 *      common case.
 *   3. Compute `destBoundary`. Empty boundary => `DEST_UNCLASSIFIED`
 *      warning, scan anyway.
 *   4. Compute `srcBoundary`. If they overlap (same engagement
 *      `githubOrgs`, both in `personalOrgs`, or shared remote): scan.
 *   5. Otherwise: refuse with `CROSS_ORG_WRITE`.
 */
export function decideHookAction(opts: {
  filePath: string;
  launcherCwd: string;
  registry: Registry;
}): HookDecision {
  const { filePath, launcherCwd, registry } = opts;

  const destTree = findEnclosingWorkingTree(filePath);
  if (destTree === null) {
    // File is outside any git working tree (e.g. /tmp/foo). Scan with
    // `_always`-only deny set. Synthesise a non-git RepoConfig so the
    // existing `computeDenySet` machinery applies.
    return {
      action: "scan",
      workingTree: null,
      repo: {
        cwd: filePath,
        isGitRepo: false,
        class: "private-strict",
        classExplicit: false,
        engagements: [],
      },
    };
  }

  const srcTree = findEnclosingWorkingTree(launcherCwd) ?? launcherCwd;
  const destRepo = readRepoConfig(destTree);

  // Same-tree write: trivially in scope. No need to compute boundaries.
  if (destTree === srcTree) {
    return { action: "scan", workingTree: destTree, repo: destRepo };
  }

  const destBoundary = computeTrustBoundary(destTree, registry);

  if (destBoundary.orgs.size === 0) {
    return {
      action: "scan-with-warning",
      workingTree: destTree,
      repo: destRepo,
      warning: {
        code: "DEST_UNCLASSIFIED",
        destTree,
        hasRemote: destBoundary.fromRemoteFallback,
      },
    };
  }

  const srcBoundary = computeTrustBoundary(srcTree, registry);
  if (trustBoundariesOverlap(srcBoundary, destBoundary)) {
    return { action: "scan", workingTree: destTree, repo: destRepo };
  }

  return {
    action: "refuse",
    code: "CROSS_ORG_WRITE",
    srcOrgs: [...srcBoundary.orgs].sort(),
    destOrgs: [...destBoundary.orgs].sort(),
    destTree,
  };
}

/** Re-exported so consumers get the type without depending on core. */
export type { TrustBoundary };
