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
import { appendAuditRecord } from "@de-otio/repo-aegis-core";
import { emitJson, emitText, type OutputOptions } from "../format.js";
import { findWorkingTrees, defaultScanRoots } from "../repo-walk.js";

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
