// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// `repo-aegis doctor` — fleet-wide hook-liveness sweep.
//
// Background: repo-aegis hooks are installed per repo (`install hooks`
// writes `core.hooksPath`, global or local). Coverage is therefore
// opt-in at install time, and a stale *repo-local* `core.hooksPath`
// silently beats a correct global one — git consults exactly one hooks
// directory, so the override wins with no error, no warning, nothing.
// A single-repo session cannot see this: everything about that one repo
// looks fine or looks broken, and there's no signal that its neighbours
// disagree. The condition that actually caught this in the wild was
// four sibling repos printing a scan line in the same minute and a
// fifth staying silent — a fleet-wide comparison, not a per-repo one.
// `doctor` is that comparison made deliberate: walk every repo under a
// set of roots, resolve each one's effective hook state (via H1's
// `resolveHookState`), and report the repos that disagree with the
// fleet's expected state — instead of relying on luck to notice.
//
// This is also the answer to "wire hook-liveness checking into CI":
// GitHub-hosted runners never have repo-aegis hooks installed (there's
// nothing to check), so a per-repo GHA workflow step would fail on
// every run and get muted. The right surface is a developer-machine
// sweep, run on demand or on a schedule — this command.

import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { resolve } from "node:path";
import { appendAuditRecord, resolveHookState, type HookState, type HookStateCode } from "@de-otio/repo-aegis-core";
import { emitJson, emitText, type OutputOptions } from "../format.js";
import { findWorkingTrees, defaultScanRoots } from "../repo-walk.js";

interface DoctorOptions extends OutputOptions {
  scanRoot?: string[];
  /** Report (dry-run) or apply a fix for repo-local `core.hooksPath`
   * overrides. Dry-run unless paired with `yes`. */
  fix?: boolean;
  /** Bypass the dry-run default; only meaningful with `fix`. */
  yes?: boolean;
}

export interface DoctorRepoResult {
  workingTree: string;
  code: HookStateCode;
  ok: boolean;
  effectivePath: string | null;
  shadowedRepoHooks: string[];
  /** True only when this run actually unset a local override (requires
   * `--fix --yes`, never set during a dry run). */
  fixed: boolean;
}

function git(cwd: string, args: string[]): { ok: boolean; stdout: string } {
  try {
    const stdout = execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return { ok: true, stdout };
  } catch {
    return { ok: false, stdout: "" };
  }
}

/** The repo-LOCAL scope's `core.hooksPath` value only, ignoring global/
 * system/worktree scopes — `resolveHookState`'s `effectivePath` is the
 * *winning* scope's value, which is exactly what `--fix` must not act
 * on blindly (unsetting a correct global value would be destructive). */
function readLocalHooksPath(cwd: string): string | null {
  const res = git(cwd, ["config", "--local", "--get", "core.hooksPath"]);
  return res.ok && res.stdout !== "" ? res.stdout : null;
}

/** Absolute path of the repo's own (local-scope) git config file, i.e.
 * `<git-common-dir>/config`. Used only for the forensic mtime capture
 * below — never mutated directly. */
function localConfigPath(cwd: string): string | null {
  const res = git(cwd, ["rev-parse", "--git-path", "config"]);
  if (!res.ok || res.stdout === "") return null;
  return resolve(cwd, res.stdout);
}

function configMtimeIso(cwd: string): string | null {
  const path = localConfigPath(cwd);
  if (path === null) return null;
  try {
    return statSync(path).mtime.toISOString();
  } catch {
    return null;
  }
}

function unsetLocalHooksPath(cwd: string): boolean {
  try {
    execFileSync("git", ["config", "--local", "--unset", "core.hooksPath"], {
      cwd,
      stdio: ["ignore", "ignore", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

function isFailing(state: HookState): boolean {
  return !state.ok || state.shadowedRepoHooks.length > 0;
}

/** True when a repo-local `core.hooksPath` is set and differs from the
 * expected repo-aegis path — the only condition `--fix` acts on. A
 * local value that already equals `expectedPath` is left alone: there
 * is nothing to unset, and unsetting it would just fall through to
 * whatever global/system value exists (possibly nothing), which is not
 * an improvement. */
function fixEligible(cwd: string, state: HookState): { eligible: boolean; localValue: string | null } {
  const localValue = readLocalHooksPath(cwd);
  if (localValue === null) return { eligible: false, localValue: null };
  const eligible = resolve(cwd, localValue) !== state.expectedPath;
  return { eligible, localValue };
}

export function doctor(opts: DoctorOptions): void {
  const fixRequested = !!opts.fix;
  const applyFix = fixRequested && !!opts.yes;
  // Mirrors the `uninstall sweep-repos` convention: `--fix` alone is a
  // dry run that reports what would change; `--fix --yes` mutates.
  // `dryRun` in the reported shape means "no mutation happened this
  // run" — true both when `--fix` was never passed and when it was
  // passed without `--yes`. `showWouldFix` narrows that to the case
  // worth telling the user about: `--fix` was requested but not
  // applied yet.
  const dryRun = !applyFix;
  const showWouldFix = fixRequested && !applyFix;

  const roots = opts.scanRoot && opts.scanRoot.length > 0 ? opts.scanRoot : defaultScanRoots();

  const results: DoctorRepoResult[] = [];
  let scanned = 0;
  let fixedCount = 0;

  for (const root of roots) {
    for (const wt of findWorkingTrees(root)) {
      scanned++;
      let state = resolveHookState(wt);
      if (!state.isGitRepo) continue; // walker found a `.git` entry that git itself doesn't recognise (corrupt/bare edge case) — nothing to evaluate.

      if (!isFailing(state)) continue; // healthy: contributes to `scanned` only, never listed — see module header.

      let fixed = false;
      if (fixRequested) {
        const { eligible, localValue } = fixEligible(wt, state);
        if (eligible && applyFix && localValue !== null) {
          // FORENSICS BEFORE MUTATING. The incident that motivated this
          // command lost the only timestamp that would have dated the
          // regression, because the repair rewrote `.git/config` before
          // anyone recorded its mtime — record the prior value and the
          // config file's mtime here, in that order, before the unset
          // below touches the file. Best-effort: the audit log must
          // never block the actual repair.
          try {
            appendAuditRecord({
              action: "doctor-fix",
              cwd: wt,
              repo: wt,
              details: {
                previousLocalHooksPath: localValue,
                configMtimeBeforeFix: configMtimeIso(wt),
              },
            });
          } catch {
            /* audit log must not break the fix */
          }
          fixed = unsetLocalHooksPath(wt);
          if (fixed) {
            fixedCount++;
            // Re-resolve: unsetting the local override can restore a
            // correct global fallback (or reveal there isn't one), and
            // it can also change which scripts count as shadowed. The
            // reported code/effectivePath must reflect the post-fix
            // state, not the stale pre-fix snapshot.
            state = resolveHookState(wt);
          }
        }
      }

      results.push({
        workingTree: wt,
        code: state.code,
        ok: state.ok,
        effectivePath: state.effectivePath,
        shadowedRepoHooks: state.shadowedRepoHooks,
        fixed,
      });
    }
  }

  const failed = results.filter(r => !r.ok || r.shadowedRepoHooks.length > 0).length;

  if (opts.json) {
    emitJson({
      action: "doctor",
      dryRun,
      roots,
      results,
      summary: { scanned, failed, fixed: fixedCount },
    });
  } else {
    emitText(`doctor: scanned ${scanned} repo(s) under ${roots.join(", ")}`);
    if (results.length === 0) {
      emitText("doctor: all clean");
    } else {
      for (const r of results) {
        const tag = r.fixed ? " [fixed]" : showWouldFix ? " [would fix]" : "";
        emitText(`  FAIL ${r.workingTree}  code=${r.code}${tag}`);
        if (r.shadowedRepoHooks.length > 0) {
          emitText(`       shadowed .git/hooks scripts: ${r.shadowedRepoHooks.join(", ")}`);
        }
      }
      emitText(
        showWouldFix
          ? `doctor: ${failed} failing, ${fixedCount} fixed (pass --fix --yes to apply)`
          : `doctor: ${failed} failing, ${fixedCount} fixed`,
      );
    }
  }

  if (failed > 0) process.exit(1);
}
