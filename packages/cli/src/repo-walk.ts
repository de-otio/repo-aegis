// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// Helpers for walking a directory tree to find git working trees.
// Extracted for reuse by multiple commands (uninstall-sweep-repos, doctor, etc).

import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Default roots scanned when the user passes no `--scan-root`. Only
 * directories that exist are walked; missing entries are silent.
 *
 * Keep this list short and conservative. Aggressive defaults (e.g.
 * scanning the entire home directory) risk traversing into places the
 * user doesn't expect — backup mounts, vendored deps under
 * `node_modules`, etc. Users with repos elsewhere pass `--scan-root`.
 */
export function defaultScanRoots(): string[] {
  const home = homedir();
  return ["repos", "code", "src", "projects"].map(d => join(home, d));
}

/**
 * Directory names we never recurse into. `.git` is included so we
 * don't try to walk its internals (worktrees folders we care about
 * live under `.git/worktrees/<name>` but git already enumerates them
 * via the parent's `.git/config`; the per-worktree config is read
 * separately when we discover the worktree's `.git` link file).
 */
export const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".cache",
  ".svn",
  ".hg",
  "vendor",
  "target",
  "dist",
  "build",
  "Library",
  ".npm",
  ".cargo",
  ".rustup",
]);

/**
 * Find every git working tree (regular repo or linked worktree) under
 * `root`. A working tree is any directory containing a `.git` entry
 * (file or directory). Skips traversal once a working tree is found
 * (we don't recurse into a repo looking for nested repos — that would
 * needlessly include vendored submodules and `git worktree add`'d
 * trees that share the parent's config anyway).
 */
export function* findWorkingTrees(root: string, depthBudget = 6): Generator<string> {
  if (!existsSync(root)) return;
  let stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  while (stack.length > 0) {
    const { dir, depth } = stack.pop()!;
    if (depth > depthBudget) continue;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    if (entries.includes(".git")) {
      yield dir;
      continue;
    }
    for (const e of entries) {
      if (SKIP_DIRS.has(e) || e.startsWith(".") && e !== "." && e !== "..") {
        // Skip dotfile dirs by default — they tend to be cache/state
        // dirs (`.cache`, `.npm`, `.config`). The ones we explicitly
        // want to walk (none today) would need an opt-in.
        continue;
      }
      const sub = join(dir, e);
      let st;
      try {
        st = statSync(sub);
      } catch {
        continue;
      }
      if (!st.isDirectory()) continue;
      stack.push({ dir: sub, depth: depth + 1 });
    }
  }
}
