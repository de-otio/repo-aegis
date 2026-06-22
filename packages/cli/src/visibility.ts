// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// GitHub repo-visibility probe + cache. The egress-hygiene gate
// (`isPublicFacing` in core) and the audit visibility-reconciliation check
// read a cached `repo-aegis.visibility` git-config value so they stay offline
// and fast (no per-commit API call). This module is the WRITE side: a
// best-effort `gh` probe whose result is cached for those readers.
import { execFileSync } from "node:child_process";
import { readCachedVisibility, type RepoVisibility } from "@de-otio/repo-aegis-core";

/** Injectable command runner (for tests); returns stdout, or null on failure. */
export type CommandRunner = (cmd: string, args: string[], cwd: string) => string | null;

const defaultRun: CommandRunner = (cmd, args, cwd) => {
  try {
    return execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
};

/**
 * Probe GitHub for this repo's visibility via the `gh` CLI. Returns "unknown"
 * when `gh` is absent, unauthenticated, the repo has no GitHub remote, or the
 * value is unrecognised — callers must treat "unknown" as "don't change state".
 * `INTERNAL` (GitHub Enterprise) maps to "private" — not publicly reachable.
 */
export function probeGithubVisibility(cwd: string, run: CommandRunner = defaultRun): RepoVisibility {
  const out = run("gh", ["repo", "view", "--json", "visibility", "--jq", ".visibility"], cwd);
  if (out === null) return "unknown";
  const v = out.trim().toLowerCase();
  if (v === "public") return "public";
  if (v === "private" || v === "internal") return "private";
  return "unknown";
}

/** Persist a known visibility into git config (`repo-aegis.visibility`). No-op for "unknown". */
export function cacheVisibility(
  cwd: string,
  vis: RepoVisibility,
  run: CommandRunner = defaultRun,
): void {
  if (vis === "unknown") return;
  run("git", ["config", "repo-aegis.visibility", vis], cwd);
}

/**
 * Resolve this repo's visibility: probe live and refresh the cache when the
 * probe succeeds; otherwise fall back to the last cached value. Best-effort —
 * never throws.
 */
export function resolveVisibility(cwd: string, run: CommandRunner = defaultRun): RepoVisibility {
  const probed = probeGithubVisibility(cwd, run);
  if (probed !== "unknown") {
    cacheVisibility(cwd, probed, run);
    return probed;
  }
  return readCachedVisibility(cwd);
}
