// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// "Already public" support for "C. Already public → warn, not block" in
// doc/plan-tag-push-and-hook-liveness.md. A historical finding whose
// commit is already reachable from a remote-tracking ref is not a new
// leak introduced by *this* push — it is content the remote already has,
// caught only because the fallback full-history scan (or `check
// --history`) looked at the whole tree instead of an incremental range.
// `check.ts` downgrades a hit like that to a warning instead of a block.
//
// The set is computed ONCE per run via a single `git rev-list
// --remotes=<remote>`, not as a `merge-base --is-ancestor <sha>` spawn
// per finding — a repo with hundreds of historical hits would otherwise
// pay hundreds of process spawns to answer a question one `rev-list`
// answers in a single call.

import { execFileSync } from "node:child_process";

/**
 * Every commit sha reachable from `refs/remotes/<remote>/*`.
 *
 * Fails CLOSED: any failure (no such remote, not a git repo, git not on
 * PATH, a huge history that somehow errors) returns an EMPTY set rather
 * than throwing or treating everything as public. An empty set makes
 * every subsequent `set.has(commitSha)` check false, so a failure here
 * can only ever make the caller block *more* often, never less — the
 * same fail-closed direction every other git-backed check in this
 * codebase takes on error.
 *
 * `repo.isGitRepo` is checked explicitly (rather than letting `git`
 * itself fail) so a non-repo caller gets the same empty-set answer
 * without spawning a process at all.
 */
export function remoteReachableCommits(
  repo: { cwd: string; isGitRepo: boolean },
  remote: string,
): Set<string> {
  if (!repo.isGitRepo) return new Set();
  try {
    const out = execFileSync("git", ["rev-list", `--remotes=${remote}`], {
      cwd: repo.cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const shas = new Set<string>();
    for (const line of out.split("\n")) {
      const sha = line.trim();
      if (sha !== "") shas.add(sha);
    }
    return shas;
  } catch {
    return new Set();
  }
}
