// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// Working-tree resolution for the path-aware PostToolUse hook.
//
// Given an arbitrary file path the agent just wrote, find the git
// working tree it lives in (regular repo, worktree, or submodule), so
// the hook can apply *that* repo's classification + deny set rather
// than the launcher's cwd.
//
// Pure-ish: stat/realpath the path's ancestors; for org resolution,
// shells out to `git config --file <wt>/.git/config` (or the worktree's
// resolved gitdir/config). Total — never throws.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseRemoteUrl } from "./remote-url.js";

const MAX_ANCESTOR_HOPS = 64;

/**
 * Walk up from `startPath` until a directory containing `.git` (file or
 * dir) is found. Returns the working tree root (the directory holding
 * the `.git` entry), or `null` if none found within
 * {@link MAX_ANCESTOR_HOPS} hops.
 *
 * Both git-worktree files (`.git` is a file containing `gitdir: ...`)
 * and submodule `.git` files are recognised — the working tree is the
 * directory containing the file in either case. The actual gitdir is
 * resolved separately via {@link resolveGitDir}.
 *
 * `startPath` is realpath'd first to defeat symlink-tricks: a symlink
 * inside repo A pointing to a file in repo B resolves to repo B, and
 * the hook applies repo B's rules — not repo A's.
 */
export function findEnclosingWorkingTree(startPath: string): string | null {
  let real: string;
  try {
    // Resolve as much of the path as exists. If the file itself doesn't
    // exist (rare in PostToolUse — the write just happened — but
    // possible if the file was concurrently removed), walk up to the
    // first existing ancestor and realpath that.
    real = realpathExisting(startPath);
  } catch {
    return null;
  }

  let cur = statSync(real).isDirectory() ? real : dirname(real);
  for (let i = 0; i < MAX_ANCESTOR_HOPS; i++) {
    const dotGit = join(cur, ".git");
    if (existsSync(dotGit)) return cur;
    const parent = dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
  return null;
}

function realpathExisting(p: string): string {
  let cur = resolve(p);
  // Walk up until we find a path that exists (or hit /).
  for (let i = 0; i < MAX_ANCESTOR_HOPS; i++) {
    if (existsSync(cur)) return realpathSync(cur);
    const parent = dirname(cur);
    if (parent === cur) throw new Error("path has no existing ancestor");
    cur = parent;
  }
  throw new Error("path has no existing ancestor within hop budget");
}

/**
 * Given a working-tree root (from {@link findEnclosingWorkingTree}),
 * return the absolute path of the actual git directory.
 *
 * - Regular repo: `<wt>/.git` is a directory; return that.
 * - Worktree / submodule: `<wt>/.git` is a file with `gitdir: <path>`;
 *   resolve `<path>` relative to `<wt>` and return the absolute form.
 * - Anything else (`.git` missing, malformed `gitdir:` line): `null`.
 *
 * Used to find the right `config` file to read remotes from.
 */
export function resolveGitDir(workingTree: string): string | null {
  const dotGit = join(workingTree, ".git");
  if (!existsSync(dotGit)) return null;
  const st = statSync(dotGit);
  if (st.isDirectory()) return dotGit;
  if (!st.isFile()) return null;

  let body: string;
  try {
    body = readFileSync(dotGit, "utf8");
  } catch {
    return null;
  }
  // Format: `gitdir: <path>\n`. The path may be relative to the .git
  // file's directory.
  const m = /^gitdir:\s*(.+?)\s*$/m.exec(body);
  if (!m || !m[1]) return null;
  const target = m[1];
  return resolve(workingTree, target);
}

/**
 * Read `remote.origin.url` from the working tree's git config and
 * return the GitHub org (lowercased), or `null` if no remote, the
 * remote isn't GitHub, or anything fails.
 *
 * Total: never throws. Used by the hook to decide whether a
 * cross-tree write stays inside one trust boundary.
 */
export function getRemoteOrg(workingTree: string): string | null {
  const gitDir = resolveGitDir(workingTree);
  if (gitDir === null) return null;
  const configPath = join(gitDir, "config");
  if (!existsSync(configPath)) return null;
  let url: string;
  try {
    url = execFileSync(
      "git",
      ["config", "--file", configPath, "--get", "remote.origin.url"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
  } catch {
    return null;
  }
  if (url.length === 0) return null;
  const parsed = parseRemoteUrl(url);
  return parsed?.org ?? null;
}
