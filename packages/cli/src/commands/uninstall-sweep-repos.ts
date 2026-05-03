// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// `repo-aegis uninstall sweep-repos` — walk a list of root directories,
// find every git repo or worktree underneath, and unset the per-repo
// `repo-aegis.*` git config keys. Used standalone or as a substep of
// the top-level `repo-aegis uninstall --purge-repos`.
//
// Defaults to dry-run: prints what *would* change. Pass `--no-dry-run`
// (or `--yes`) to actually mutate config. The conservative default
// matches the broader uninstall design — destructive actions need
// explicit confirmation.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { appendAuditRecord } from "@de-otio/repo-aegis-core";
import { emitJson, emitText, type OutputOptions } from "../format.js";

/**
 * Default roots scanned when the user passes no `--scan-root`. Only
 * directories that exist are walked; missing entries are silent.
 *
 * Keep this list short and conservative. Aggressive defaults (e.g.
 * scanning the entire home directory) risk traversing into places the
 * user doesn't expect — backup mounts, vendored deps under
 * `node_modules`, etc. Users with repos elsewhere pass `--scan-root`.
 */
function defaultScanRoots(): string[] {
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
const SKIP_DIRS = new Set([
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

const REPO_AEGIS_CONFIG_KEYS = ["repo-aegis.class", "repo-aegis.engagement"];

export interface SweepReposResult {
  workingTree: string;
  unset: string[];
  values: Record<string, string[]>;
}

interface SweepReposOptions extends OutputOptions {
  /** Dry-run by default. Pass `false` (or `yes: true`) to actually unset. */
  dryRun?: boolean;
  /** Bypass the dry-run default. */
  yes?: boolean;
  /** Roots to walk. Defaults to {@link defaultScanRoots}. */
  scanRoot?: string[];
  /**
   * Suppress stdout/stderr emission. emitError still fires on hard
   * failure. Used by the top-level `repo-aegis uninstall`.
   */
  silent?: boolean;
}

/**
 * Find every git working tree (regular repo or linked worktree) under
 * `root`. A working tree is any directory containing a `.git` entry
 * (file or directory). Skips traversal once a working tree is found
 * (we don't recurse into a repo looking for nested repos — that would
 * needlessly include vendored submodules and `git worktree add`'d
 * trees that share the parent's config anyway).
 */
function* findWorkingTrees(root: string, depthBudget = 6): Generator<string> {
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

/** Return current values for each repo-aegis.* key, or empty if unset. */
function readRepoAegisConfig(workingTree: string): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const key of REPO_AEGIS_CONFIG_KEYS) {
    try {
      const out = execFileSync("git", ["-C", workingTree, "config", "--get-all", key], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (out.length > 0) {
        result[key] = out.split("\n").filter(Boolean);
      }
    } catch {
      // Key not set: git config exits non-zero. Skip.
    }
  }
  return result;
}

function unsetAll(workingTree: string, key: string): boolean {
  try {
    execFileSync("git", ["-C", workingTree, "config", "--unset-all", key], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

export function uninstallSweepRepos(opts: SweepReposOptions): void {
  const dryRun = opts.dryRun !== false && !opts.yes;
  const roots = opts.scanRoot && opts.scanRoot.length > 0 ? opts.scanRoot : defaultScanRoots();

  const results: SweepReposResult[] = [];
  for (const root of roots) {
    for (const wt of findWorkingTrees(root)) {
      const values = readRepoAegisConfig(wt);
      const keysPresent = Object.keys(values);
      if (keysPresent.length === 0) continue;
      const unset: string[] = [];
      if (!dryRun) {
        for (const k of keysPresent) {
          if (unsetAll(wt, k)) unset.push(k);
        }
      }
      results.push({ workingTree: wt, unset, values });
    }
  }

  // Audit (best-effort).
  try {
    appendAuditRecord({
      action: "uninstall-sweep-repos",
      details: {
        dryRun,
        roots,
        affected: results.length,
      },
    });
  } catch {
    /* audit log must not break user-facing ops */
  }

  if (opts.silent) return;
  if (opts.json) {
    emitJson({
      action: "uninstall-sweep-repos",
      dryRun,
      roots,
      results,
    });
    return;
  }
  if (results.length === 0) {
    emitText(`no repo-aegis.* config found under: ${roots.join(", ")}`);
    return;
  }
  emitText(
    dryRun
      ? `dry-run: ${results.length} repo(s) would be cleared (pass --yes to apply)`
      : `cleared repo-aegis.* config from ${results.length} repo(s)`,
  );
  for (const r of results) {
    const keys = Object.keys(r.values).join(", ");
    emitText(`  ${r.workingTree}  [${keys}]`);
  }
}
