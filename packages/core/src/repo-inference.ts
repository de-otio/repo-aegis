// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// The class of a repository nobody has classified yet, worked out from where it pushes
// (doc/plan-engagement-repo-consistency.md, change A).
//
// First-touch classification runs once, at session start, on the starting directory. A
// repository created or cloned later in the session is never classified, so it defaulted to
// `private-strict`, which blocks every engagement's markers, including the engagement's own
// name in the engagement's own repository. The egress guard classified the same repository
// from the registry, so two layers gave two answers.
//
// This module does NOT write anything. The inference is computed on every read, so a changed
// remote changes the answer and no hook ever has a side effect on git config. `readRepoConfig`
// stays the raw reader of what git config and `.repo-aegis.yml` hold: `allow`, `deny`,
// `classify` and the config mutators keep using it, so `RepoJson.engagements` still means
// "what git config holds". Only callers that DECIDE a class use `readEffectiveRepoConfig`.
//
// Inference gives up (the raw `private-strict` stands) whenever the facts are not one clear
// engagement; every veto below names an accident it prevents.
import { execFileSync } from "node:child_process";
import { readCachedVisibility, type RepoVisibility } from "./egress.js";
import { classifyOwner, type OwnerRegistry } from "./owner-class.js";
import { resolvePushUrls } from "./push-urls.js";
import { resolveRemoteUrl, type RemoteTarget } from "./remote-url.js";
import { readRepoConfig, type RepoConfig } from "./repo.js";

export interface InferredClass {
  class: "customer-coupled";
  /** The one engagement every push target belongs to. */
  engagement: string;
}

export interface InferClassInput {
  raw: Pick<RepoConfig, "classExplicit" | "engagements">;
  /** Every push URL of every remote, resolved. */
  targets: readonly RemoteTarget[];
  /** This checkout's recorded visibility. */
  cachedVisibility: RepoVisibility;
  registry: OwnerRegistry;
}

/**
 * Pure. Null means: no inference, the raw class stands. Non-null only when ALL of:
 *
 * 1. the class is not explicit (git config or `.repo-aegis.yml` always wins);
 * 2. there is at least one push target and every one is a resolved GitHub repository (a GitLab
 *    mirror or an ssh alias nothing can resolve could be a different customer's);
 * 3. every owner classifies as the same single engagement (a personal owner, an unknown one,
 *    or one in two engagements is not "this customer's repo");
 * 4. the checkout is not recorded public (a customer's open-source repo is not the place for
 *    that customer's internal names);
 * 5. no different engagement is already configured (a declaration is never silently replaced).
 */
export function inferClass(input: InferClassInput): InferredClass | null {
  const { raw, targets, cachedVisibility, registry } = input;
  if (raw.classExplicit) return null;
  if (cachedVisibility === "public") return null;
  if (targets.length === 0) return null;
  let engagement: string | null = null;
  for (const t of targets) {
    if (t.kind !== "github") return null;
    const c = classifyOwner(t.org, registry);
    if (c.kind !== "engagement") return null;
    if (engagement !== null && engagement !== c.id) return null;
    engagement = c.id;
  }
  if (engagement === null) return null;
  if (raw.engagements.length > 0 && !(raw.engagements.length === 1 && raw.engagements[0] === engagement)) return null;
  return { class: "customer-coupled", engagement };
}

/** What a decider sees: the raw config, with the inferred class when there is one. */
export type EffectiveRepoConfig = RepoConfig & {
  /** True when `class` and `engagements` come from the push targets, not from anything declared. */
  classInferred?: true;
};

function gitLines(cwd: string, args: string[]): string[] | null {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .split("\n")
      .map(l => l.trim())
      .filter(l => l !== "");
  } catch {
    return null;
  }
}

/**
 * Every push URL of every remote of the checkout at `cwd`, resolved. A remote whose push URL
 * cannot be read is an `unresolved` target, so it vetoes inference instead of being skipped.
 */
export function readPushTargets(cwd: string): RemoteTarget[] {
  const remotes = gitLines(cwd, ["remote"]);
  if (remotes === null) return [];
  const targets: RemoteTarget[] = [];
  for (const remote of remotes) {
    const urls = resolvePushUrls(cwd, remote);
    if (urls === null || urls.length === 0) {
      targets.push({ kind: "unresolved", why: "the remote's push URL could not be read" });
      continue;
    }
    for (const url of urls) targets.push(resolveRemoteUrl(url));
  }
  return targets;
}

/**
 * `readRepoConfig` plus the inference. The registry comes from the caller (no default load: this
 * function does no registry I/O of its own). The remotes are read only when the class is not
 * explicit, so a classified repository costs no extra git calls.
 */
export function readEffectiveRepoConfig(cwd: string, registry: OwnerRegistry | null | undefined): EffectiveRepoConfig {
  const raw = readRepoConfig(cwd);
  if (raw.classExplicit || !raw.isGitRepo || registry === null || registry === undefined) return raw;
  const inferred = inferClass({
    raw,
    targets: readPushTargets(cwd),
    cachedVisibility: readCachedVisibility(cwd),
    registry,
  });
  if (inferred === null) return raw;
  return { ...raw, class: inferred.class, engagements: [inferred.engagement], classInferred: true };
}
