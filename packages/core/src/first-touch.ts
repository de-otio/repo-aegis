// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// Phase 1 onboarding: just-in-time classification of a repo from its
// git remote against the engagement registry. Used by:
//   - the MCP `aegis_classify_first_touch` tool (agent-facing entry).
//   - the CLI `repo-aegis hook first-touch` subcommand (Claude Code
//     SessionStart hook entry).
//
// Pure-ish: reads git config / remote URL via execFileSync, reads the
// registry, mutates only the *per-repo* `git config` (setClass /
// addEngagement) on the `applied` path. Never mutates the registry —
// that's a follow-up requiring user confirmation, per the agent guide.

import { execFileSync } from "node:child_process";
import { loadRegistry, type Engagement, type Registry } from "./registry.js";
import { RegistryNotFoundError } from "./exceptions.js";
import { parseRemoteUrl } from "./remote-url.js";
import { readRepoConfig, setClass, addEngagement } from "./repo.js";

export type FirstTouchSkipReason =
  | "non-git"
  | "no-remote"
  | "non-github-host"
  | "registry-not-found";

export interface FirstTouchAlreadyClassified {
  status: "already-classified";
  class: string;
  engagements: string[];
}
export interface FirstTouchApplied {
  status: "applied";
  class: string;
  engagement: string | null;
  /**
   * [SEC H-5] follow-up: when the applied path attaches an engagement
   * with zero markers, surface a warning the agent can show the user.
   * Closes the window where a freshly registered org has no marker yet.
   */
  markerWarning: { engagementId: string; count: 0 } | null;
}
export interface FirstTouchNeedsConfirmation {
  status: "needs-confirmation";
  remote: string;
  org: string;
  /**
   * [SEC H-5] redacted form the agent should use in any context-bearing
   * summary. Equal to `org` when the org is too short to redact (< 4 chars).
   */
  redactedOrg: string;
  suggestion:
    | { newEngagement: { idHint: string } }
    | { addToExisting: { engagementId: string } }
    | { addAsPersonal: true };
}
export interface FirstTouchSkipped {
  status: "skipped";
  reason: FirstTouchSkipReason;
}

export type FirstTouchResult =
  | FirstTouchAlreadyClassified
  | FirstTouchApplied
  | FirstTouchNeedsConfirmation
  | FirstTouchSkipped;

/**
 * [SEC H-5] Redact an org name to `xx***y` form (first 2 + ellipsis +
 * last 1). For orgs shorter than 4 characters, returns the org as-is —
 * redaction would be pointless and conspicuous.
 */
export function redactOrg(org: string): string {
  if (org.length < 4) return org;
  return `${org.slice(0, 2)}***${org.slice(-1)}`;
}

function readRemote(cwd: string): string | null {
  try {
    const out = execFileSync("git", ["remote", "get-url", "origin"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

function tryRegistryMatch(
  parsedOrg: string,
):
  | { class: "public-eligible"; engagement: null }
  | { class: "customer-coupled"; engagement: Engagement }
  | null
  | "registry-not-found" {
  let reg: Registry;
  try {
    reg = loadRegistry();
  } catch (err) {
    if (err instanceof RegistryNotFoundError) return "registry-not-found";
    return null;
  }
  const personalOrgs = reg.personalOrgs ?? [];
  if (personalOrgs.includes(parsedOrg)) {
    return { class: "public-eligible", engagement: null };
  }
  for (const eng of reg.engagements) {
    if ((eng.githubOrgs ?? []).includes(parsedOrg)) {
      return { class: "customer-coupled", engagement: eng };
    }
  }
  return null;
}

export interface FirstTouchOptions {
  cwd?: string;
}

export function firstTouchClassify(opts: FirstTouchOptions = {}): FirstTouchResult {
  const cwd = opts.cwd ?? process.cwd();
  const repo = readRepoConfig(cwd);

  if (!repo.isGitRepo) {
    return { status: "skipped", reason: "non-git" };
  }
  if (repo.classExplicit) {
    return {
      status: "already-classified",
      class: repo.class,
      engagements: repo.engagements,
    };
  }
  const remote = readRemote(cwd);
  if (remote === null) {
    return { status: "skipped", reason: "no-remote" };
  }
  const parsed = parseRemoteUrl(remote);
  if (parsed === null) {
    return { status: "skipped", reason: "non-github-host" };
  }
  const match = tryRegistryMatch(parsed.org);
  if (match === "registry-not-found") {
    return { status: "skipped", reason: "registry-not-found" };
  }
  if (match === null) {
    return {
      status: "needs-confirmation",
      remote,
      org: parsed.org,
      redactedOrg: redactOrg(parsed.org),
      suggestion: { newEngagement: { idHint: parsed.org } },
    };
  }

  setClass(match.class, cwd);
  if (match.class === "customer-coupled") {
    addEngagement(match.engagement.id, cwd);
  }

  let markerWarning: FirstTouchApplied["markerWarning"] = null;
  if (match.class === "customer-coupled" && match.engagement.markers.length === 0) {
    markerWarning = { engagementId: match.engagement.id, count: 0 };
  }
  return {
    status: "applied",
    class: match.class,
    engagement: match.class === "customer-coupled" ? match.engagement.id : null,
    markerWarning,
  };
}
