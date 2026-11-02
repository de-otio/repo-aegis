// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// The repository a `gh` write with no explicit target lands on
// (doc/plan-unregistered-owner-egress.md §3.3 item 3, as superseded after the PR 2c
// review, which read gh 2.102's source: context/context.go, factory/default.go,
// cmd/root.go).
//
// Without a TTY gh does not prompt, fail or ask the API: its pick is deterministic, so the
// guard judges THAT pick instead of a candidate set.
//
//   1. Remotes come from `git remote -v`, so after `insteadOf`; each remote's repository is
//      read from its FETCH URL (its push URL when the fetch URL names no repository), with the
//      host normalised and ssh aliases translated. Remotes on other hosts are filtered out, as
//      gh filters to the authenticated hosts.
//   2. They are sorted by name: `upstream`, `github`, `origin`, then the rest. gh's sort is not
//      stable, so a top position shared by remotes naming different repositories is unresolved.
//   3. `SmartBaseRepo` groups (pr, issue, repo, release, api, label, run, workflow, ruleset,
//      cache, org, discussion, browse, agent-task): the first remote in that order with a
//      `gh-resolved` wins: `base` is that remote, anything else is parsed as a repository (an
//      invalid value is unresolved). Without one: the first remote.
//   4. Plain `BaseRepo` groups (secret, variable, …): `gh-resolved` is ignored; the first remote.
//   5. A remote whose URL is not cleanly GitHub is never dropped: when gh could pick it, the
//      result is unresolved.
//
// Reads local git state only; never the network.
import { execFileSync } from "node:child_process";
import { parseRepoRef } from "./egress-intent.js";
import { detectSshOverride } from "./push-urls.js";
import { resolveRemoteUrl } from "./remote-url.js";

export type GhBaseRepo =
  | { kind: "repo"; org: string; repo: string }
  /** Nothing to judge: not a repository, or no remote on a GitHub host. */
  | { kind: "none" }
  | { kind: "unresolved"; reason: "gh-resolved" | "opaque-remote" };

function gitOut(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      timeout: 2000,
      maxBuffer: 256 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

interface RemoteUrls {
  fetch?: string;
  push?: string;
}

/** `git remote -v`: name → its fetch and push URL, after `insteadOf` / `pushInsteadOf`. */
function readRemotes(cwd: string): Map<string, RemoteUrls> | null {
  const out = gitOut(cwd, ["remote", "-v"]);
  if (out === null) return null;
  const remotes = new Map<string, RemoteUrls>();
  for (const line of out.split("\n")) {
    const m = /^([^\t]+)\t(.*) \((fetch|push)\)$/.exec(line);
    if (m === null) continue;
    const urls = remotes.get(m[1]!) ?? {};
    if (m[3] === "fetch") urls.fetch = m[2]!;
    else urls.push = m[2]!;
    remotes.set(m[1]!, urls);
  }
  return remotes;
}

/** `remote.<name>.gh-resolved` values per remote name. */
function readResolved(cwd: string): Map<string, string[]> {
  const out = gitOut(cwd, ["config", "-z", "--get-regexp", "^remote\\..*\\.gh-resolved$"]);
  const table = new Map<string, string[]>();
  if (out === null) return table;
  for (const entry of out.split("\0")) {
    if (entry === "") continue;
    const nl = entry.indexOf("\n");
    const key = nl === -1 ? entry : entry.slice(0, nl);
    const value = nl === -1 ? "" : entry.slice(nl + 1);
    const m = /^remote\.(.+)\.gh-resolved$/.exec(key);
    if (m !== null) table.set(m[1]!, [...(table.get(m[1]!) ?? []), value]);
  }
  return table;
}

/** gh's `remoteNameSortScore`: upstream 3, github 2, origin 1, anything else 0 (case-insensitive). */
function nameScore(name: string): number {
  switch (name.toLowerCase()) {
    case "upstream":
      return 3;
    case "github":
      return 2;
    case "origin":
      return 1;
    default:
      return 0;
  }
}

type Target = { kind: "github"; org: string; repo: string } | { kind: "unresolved" };

interface Entry {
  name: string;
  score: number;
  target: Target;
  resolved: string[];
}

/** The gh remote list: GitHub remotes and the ones that might be, sorted as gh sorts them. */
function ghRemoteEntries(cwd: string, remotes: Map<string, RemoteUrls>): Entry[] {
  const resolved = readResolved(cwd);
  const sshOverride = detectSshOverride(cwd);
  const entries: Entry[] = [];
  for (const [name, urls] of remotes) {
    // gh reads the repository from the fetch URL, and from the push URL only when the fetch URL gives none.
    let target: Target | null = null;
    for (const url of [urls.fetch, urls.push]) {
      if (url === undefined) continue;
      const t = resolveRemoteUrl(url, undefined, { sshOverride, unknownDotlessUnresolved: true });
      if (t.kind === "github") {
        target = { kind: "github", org: t.org, repo: t.repo };
        break;
      }
      if (t.kind === "unresolved") {
        target = { kind: "unresolved" };
        break;
      }
      // non-github: another host (filtered out by gh), or no repository: try the next URL
    }
    if (target === null) continue;
    entries.push({ name, score: nameScore(name), target, resolved: resolved.get(name) ?? [] });
  }
  // Stable by score; names break ties here only to be deterministic: gh's order among equals is not.
  return entries.sort((a, b) => b.score - a.score || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

const OPAQUE: GhBaseRepo = { kind: "unresolved", reason: "opaque-remote" };

/** The repository an entry's `gh-resolved` values select; all values must agree. */
function resolvedPick(e: Entry): GhBaseRepo {
  let pick: { org: string; repo: string } | null = null;
  for (const v of e.resolved) {
    let repo: { org: string; repo: string } | null;
    if (v === "base") {
      if (e.target.kind !== "github") return OPAQUE;
      repo = { org: e.target.org, repo: e.target.repo };
    } else {
      repo = parseRepoRef(v);
      if (repo === null) return { kind: "unresolved", reason: "gh-resolved" };
    }
    if (pick !== null && (pick.org !== repo.org || pick.repo !== repo.repo)) {
      return { kind: "unresolved", reason: "gh-resolved" };
    }
    pick = repo;
  }
  return pick === null ? { kind: "unresolved", reason: "gh-resolved" } : { kind: "repo", ...pick };
}

/** The first position: every entry with the top score must name the same GitHub repository. */
function topPick(entries: readonly Entry[]): GhBaseRepo {
  const top = entries[0];
  if (top === undefined) return { kind: "none" };
  let pick: { org: string; repo: string } | null = null;
  for (const e of entries) {
    if (e.score !== top.score) break;
    if (e.target.kind !== "github") return OPAQUE; // a remote that might be GitHub could be the pick
    if (pick !== null && (pick.org !== e.target.org || pick.repo !== e.target.repo)) return OPAQUE; // unstable tie
    pick = { org: e.target.org, repo: e.target.repo };
  }
  return pick === null ? OPAQUE : { kind: "repo", ...pick };
}

/**
 * The base repository gh picks for a write with no explicit target, run from `cwd`.
 * `plain`: the command group uses gh's plain `BaseRepo` (ignores `gh-resolved`).
 */
export function ghBaseRepo(cwd: string, plain: boolean): GhBaseRepo {
  const remotes = readRemotes(cwd);
  if (remotes === null || remotes.size === 0) return { kind: "none" };
  const entries = ghRemoteEntries(cwd, remotes);
  if (entries.length === 0) return { kind: "none" };
  if (plain) return topPick(entries);

  // SmartBaseRepo: the first remote, in gh's order, that carries a `gh-resolved` wins.
  const first = entries.find(e => e.resolved.length > 0);
  if (first === undefined) return topPick(entries);
  if (first.target.kind === "unresolved") return OPAQUE; // it may be a GitHub remote with this setting
  // Entries sharing the winner's score are ordered unstably: those that carry a setting must agree.
  let result: GhBaseRepo | null = null;
  for (const e of entries) {
    if (e.score !== first.score || e.resolved.length === 0) continue;
    if (e.target.kind === "unresolved") return OPAQUE;
    const r = resolvedPick(e);
    if (r.kind !== "repo") return r;
    if (result !== null && result.kind === "repo" && (result.org !== r.org || result.repo !== r.repo)) return OPAQUE;
    result = r;
  }
  return result ?? OPAQUE;
}
