// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// Machine-wide destination cache: `<org>/<repo>` → the checkout that holds
// its class and cached visibility (doc/design/egress-guard.md §1, "Destination
// resolution").
//
// Class (`repo-aegis.class`) and visibility (`repo-aegis.visibility`) live
// in each repository's own git config. That is the right home for a
// declaration about a repository — but it means the egress policy can only
// read them when the command runs *inside* that repository. `gh pr create
// --repo o/r` or `gh api -X PUT repos/o/r/…` from any other directory names
// its destination in full and yet resolves to "class unknown, visibility
// unknown", and an unknown destination fails open. Found live on
// 2026-09-12: a merge into a public repository, judged from a private
// checkout, went through unasked.
//
// This file closes that gap without moving the source of truth. It is a
// pointer table: for each `org/repo` this machine has a checkout of, where
// that checkout is, plus a snapshot of what its config said when last seen.
// The resolver follows the pointer and reads the live config when the tree
// still exists, and falls back to the snapshot when it does not. It is
// written by everything that already visits a repository and reads its
// class — `classify --apply`, `status`, `doctor`, and the egress guard
// itself on every command it judges from inside a repository — so it fills
// in as the machine is used and needs no separate maintenance.
//
// Every read and write is best-effort: a cache that cannot be read yields
// "not cached", never an error, and a cache that cannot be written is
// silently not written. A guardrail must never block on its own bookkeeping.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readCachedVisibility, type RepoVisibility } from "./egress.js";
import { repoAegisHome } from "./paths.js";
import { parseRemoteUrl } from "./remote-url.js";
import { readRepoConfig, REPO_CLASSES, type RepoClass } from "./repo.js";
import { getRemoteUrl } from "./working-tree.js";

export interface DestinationCacheEntry {
  /** The class the checkout declared when last seen (`private-strict` when it declared none). */
  class: RepoClass;
  /** True when `class` came from an explicit declaration, not the default. */
  classExplicit: boolean;
  /** The checkout's cached GitHub visibility when last seen. */
  visibility: RepoVisibility;
  /** Absolute path of the checkout this entry was read from. */
  workingTree: string;
  /** ISO timestamp of the last write. */
  checkedAt: string;
}

export interface DestinationCache {
  version: 1;
  /** Keyed by lower-cased `<org>/<repo>`. */
  repos: Record<string, DestinationCacheEntry>;
}

export const DESTINATION_CACHE_FILE = "destinations.json";

/** `<REPO_AEGIS_HOME>/destinations.json`. */
export function destinationCachePath(home: string = repoAegisHome()): string {
  return join(home, DESTINATION_CACHE_FILE);
}

export function destinationKey(org: string, repo: string): string {
  return `${org.toLowerCase()}/${repo.toLowerCase()}`;
}

const VISIBILITIES: ReadonlySet<string> = new Set(["public", "private", "unknown"]);

function isEntry(v: unknown): v is DestinationCacheEntry {
  if (!v || typeof v !== "object") return false;
  const e = v as Record<string, unknown>;
  return (
    typeof e["class"] === "string" &&
    (REPO_CLASSES as readonly string[]).includes(e["class"]) &&
    typeof e["classExplicit"] === "boolean" &&
    typeof e["visibility"] === "string" &&
    VISIBILITIES.has(e["visibility"]) &&
    typeof e["workingTree"] === "string" &&
    typeof e["checkedAt"] === "string"
  );
}

/**
 * Read the cache. Never throws: a missing, unreadable or malformed file is
 * an empty cache, and malformed entries are dropped individually so one bad
 * line cannot blind the resolver to the rest.
 */
export function readDestinationCache(path: string = destinationCachePath()): DestinationCache {
  const empty: DestinationCache = { version: 1, repos: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return empty;
  }
  if (!parsed || typeof parsed !== "object") return empty;
  const repos = (parsed as { repos?: unknown }).repos;
  if (!repos || typeof repos !== "object") return empty;
  const out: DestinationCache = { version: 1, repos: {} };
  for (const [key, entry] of Object.entries(repos as Record<string, unknown>)) {
    if (isEntry(entry)) out.repos[key.toLowerCase()] = entry;
  }
  return out;
}

/** The cached entry for `org/repo`, or null when this machine has none. */
export function lookupDestination(
  org: string,
  repo: string,
  path: string = destinationCachePath(),
): DestinationCacheEntry | null {
  return readDestinationCache(path).repos[destinationKey(org, repo)] ?? null;
}

/**
 * What a checkout says about itself right now, or null when it has no
 * GitHub origin (nothing to key on). The read the resolver performs when it
 * follows a pointer, and the read the writers snapshot.
 */
export function describeWorkingTree(
  workingTree: string,
): { key: string; entry: Omit<DestinationCacheEntry, "checkedAt"> } | null {
  const url = getRemoteUrl(workingTree);
  const parsed = url === null ? null : parseRemoteUrl(url);
  if (parsed === null) return null;
  const cfg = readRepoConfig(workingTree);
  return {
    key: destinationKey(parsed.org, parsed.repo),
    entry: {
      class: cfg.class,
      classExplicit: cfg.classExplicit,
      visibility: readCachedVisibility(workingTree),
      workingTree,
    },
  };
}

/**
 * Record a checkout in the cache (read-modify-write, atomic rename, 0600).
 * Returns the key written, or null when the tree has no GitHub origin or the
 * write failed. Best-effort by contract — callers do not check the result
 * except to report a count.
 */
export function recordWorkingTree(
  workingTree: string,
  path: string = destinationCachePath(),
  now: () => Date = () => new Date(),
): string | null {
  try {
    const described = describeWorkingTree(workingTree);
    if (described === null) return null;
    const cache = readDestinationCache(path);
    cache.repos[described.key] = { ...described.entry, checkedAt: now().toISOString() };
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(cache, null, 2) + "\n", { mode: 0o600 });
    renameSync(tmp, path);
    return described.key;
  } catch {
    return null;
  }
}

/** True when the entry's checkout is still on disk. */
export function entryTreeExists(entry: DestinationCacheEntry): boolean {
  try {
    return existsSync(entry.workingTree);
  } catch {
    return false;
  }
}

/**
 * What this machine knows about `org/repo` from elsewhere: the cached entry,
 * refreshed from the checkout's live config when the checkout still exists
 * (`live: true`), the snapshot otherwise. Null when nothing is cached, and
 * null when the entry carries no declaration at all (default class, unknown
 * visibility) — a pointer to a tree that says nothing is not knowledge.
 */
export function resolveCachedDestination(
  org: string,
  repo: string,
  path: string = destinationCachePath(),
): (DestinationCacheEntry & { live: boolean }) | null {
  const cached = lookupDestination(org, repo, path);
  if (cached === null) return null;
  let entry: DestinationCacheEntry & { live: boolean } = { ...cached, live: false };
  if (entryTreeExists(cached)) {
    try {
      const cfg = readRepoConfig(cached.workingTree);
      entry = {
        ...cached,
        class: cfg.class,
        classExplicit: cfg.classExplicit,
        visibility: readCachedVisibility(cached.workingTree),
        live: true,
      };
    } catch {
      /* keep the snapshot */
    }
  }
  if (!entry.classExplicit && entry.visibility === "unknown") return null;
  return entry;
}
