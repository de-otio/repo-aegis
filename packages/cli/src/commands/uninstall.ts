// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// `repo-aegis uninstall` — top-level uninstall.
//
// Composes every available `--uninstall` step in one command:
//   - install hooks --uninstall   (per-repo git hooks)
//   - install gitignore --uninstall
//   - install claude-md --uninstall
//   - install ci --uninstall      (per-repo workflow file)
//
// And, opt-in:
//   - --purge-repos: sweep `repo-aegis.*` git config keys out of every
//     repo under one or more scan roots.
//   - --purge-home: delete `~/.config/repo-aegis/` (the registry,
//     markers, audit log, deny-set cache, leak-context flag, age
//     ciphertext, embedding profiles).
//
// Defaults to dry-run for any destructive step. `--yes` to actually
// apply.

import { existsSync, realpathSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import {
  appendAuditRecord,
  auditLogPath,
  isAuditLogEnabled,
  readRepoConfig,
  repoAegisHome,
} from "@de-otio/repo-aegis-core";
import { emitJson, emitText, emitError, type OutputOptions } from "../format.js";
import { installHooks } from "./install-hooks.js";
import { installGitignore } from "./install-gitignore.js";
import { installClaudeMd } from "./install-claude-md.js";
import { installCi } from "./install-ci.js";
import { uninstallSweepRepos } from "./uninstall-sweep-repos.js";

interface UninstallOptions extends OutputOptions {
  /** Default true: nothing destructive runs without `--yes`. */
  dryRun?: boolean;
  /** Bypass the dry-run default. */
  yes?: boolean;
  /** Sweep repo-aegis.* git config keys out of repos under these roots. */
  purgeRepos?: boolean;
  /** Delete ~/.config/repo-aegis/ (registry, audit log, etc.) */
  purgeHome?: boolean;
  /** Roots passed to sweep-repos. */
  scanRoot?: string[];
  /** Override `~/.claude` for `install claude-md --uninstall`. */
  claudeHome?: string;
  /** Override CWD for the per-repo steps. */
  cwd?: string;
  /** Suppress stdout/stderr. emitError still fires on hard failure. */
  silent?: boolean;
}

interface StepReport {
  step: string;
  ok: boolean;
  details?: unknown;
}

/**
 * Sanity-check `~/.config/repo-aegis/` before deleting it. Refuses
 * if the path realpath-resolves to anything outside the user's home
 * directory or doesn't end in something repo-aegis-shaped. The
 * realpath check defeats a symlink that points at, say, `/etc`.
 */
function isSafeToPurgeHome(home: string): { ok: true } | { ok: false; reason: string } {
  let real: string;
  try {
    real = realpathSync(home);
  } catch {
    return { ok: false, reason: `home does not exist: ${home}` };
  }
  if (real === "/" || real === homedir() || real === resolve(homedir())) {
    return { ok: false, reason: `home resolves to a protected path: ${real}` };
  }
  // Must end in `repo-aegis` (or `.repo-aegis` for a hypothetical
  // dotfile install). Anything else suggests `REPO_AEGIS_HOME`
  // points somewhere unrelated; refuse rather than risk it.
  if (!/(?:^|[\\/])\.?repo-aegis\/?$/.test(real)) {
    return {
      ok: false,
      reason:
        `home path does not end in 'repo-aegis': ${real} (set REPO_AEGIS_HOME to a clean path or delete manually)`,
    };
  }
  // Must be a directory.
  try {
    if (!statSync(real).isDirectory()) {
      return { ok: false, reason: `home is not a directory: ${real}` };
    }
  } catch {
    return { ok: false, reason: `cannot stat home: ${real}` };
  }
  return { ok: true };
}

export function uninstall(opts: UninstallOptions): void {
  const dryRun = opts.dryRun !== false && !opts.yes;
  const cwd = opts.cwd ?? process.cwd();
  const reports: StepReport[] = [];

  // 1. Always-on steps (idempotent on already-clean state).
  // For the per-repo steps (hooks, ci), guard against being called
  // outside a git repo: the user may be running `repo-aegis
  // uninstall` from `~` and we shouldn't abort the whole uninstall
  // because cwd has no `.git`. Skip silently in that case; the per-
  // repo cleanup happens through `--purge-repos` instead.
  const cwdIsGitRepo = readRepoConfig(cwd).isGitRepo;
  if (!dryRun) {
    if (cwdIsGitRepo) {
      runStepSilent("install-hooks --uninstall", reports, () => {
        installHooks({ uninstall: true, silent: true, cwd });
        return { applied: true };
      });
    } else {
      reports.push({
        step: "install-hooks --uninstall",
        ok: true,
        details: { skipped: true, reason: "cwd is not a git repo" },
      });
    }
    runStep("install-gitignore --uninstall", reports, () =>
      installGitignore({ uninstall: true, silent: true, json: false }),
    );
    runStep("install-claude-md --uninstall", reports, () =>
      installClaudeMd({
        uninstall: true,
        silent: true,
        json: false,
        ...(opts.claudeHome !== undefined && { claudeHome: opts.claudeHome }),
      }),
    );
    if (cwdIsGitRepo) {
      runStepSilent("install-ci --uninstall", reports, () => {
        installCi({ uninstall: true, silent: true, json: false, cwd });
        return { applied: true };
      });
    } else {
      reports.push({
        step: "install-ci --uninstall",
        ok: true,
        details: { skipped: true, reason: "cwd is not a git repo" },
      });
    }
  } else {
    reports.push({ step: "install-hooks --uninstall", ok: true, details: { dryRun: true } });
    reports.push({ step: "install-gitignore --uninstall", ok: true, details: { dryRun: true } });
    reports.push({ step: "install-claude-md --uninstall", ok: true, details: { dryRun: true } });
    reports.push({ step: "install-ci --uninstall", ok: true, details: { dryRun: true } });
  }

  // 2. --purge-repos
  let purgeReposReport: StepReport | null = null;
  if (opts.purgeRepos) {
    purgeReposReport = { step: "purge-repos", ok: true };
    runStep("purge-repos", reports, () =>
      uninstallSweepRepos({
        ...(opts.scanRoot !== undefined && { scanRoot: opts.scanRoot }),
        ...(dryRun ? { dryRun: true } : { yes: true }),
        silent: true,
        json: false,
      }),
    );
  }

  // 3. --purge-home
  let purgeHomeReport: {
    removed: boolean;
    path: string;
    reason?: string;
    auditLogPresent?: boolean;
    auditLogPath?: string;
  } | null = null;
  if (opts.purgeHome) {
    const home = repoAegisHome();
    if (!existsSync(home)) {
      purgeHomeReport = { removed: false, path: home, reason: "home does not exist" };
    } else {
      const safe = isSafeToPurgeHome(home);
      if (!safe.ok) {
        emitError({ code: "PURGE_HOME_REFUSED", error: safe.reason }, opts);
      }
      // The audit log is a compliance artefact. We don't *refuse* the
      // delete (`--yes` is the user's explicit confirmation), but we
      // do surface its presence in the dry-run / report output so the
      // user can choose to back it up first.
      const auditLogPresent =
        isAuditLogEnabled() && existsSync(auditLogPath());
      if (!dryRun) {
        try {
          rmSync(home, { recursive: true, force: true });
          purgeHomeReport = {
            removed: true,
            path: home,
            ...(auditLogPresent && {
              auditLogPresent: true,
              auditLogPath: auditLogPath(),
            }),
          };
        } catch (err) {
          emitError(
            { code: "FS_ERROR", error: `failed to remove ${home}: ${(err as Error).message}` },
            opts,
          );
        }
      } else {
        purgeHomeReport = {
          removed: false,
          path: home,
          reason: "dry-run",
          ...(auditLogPresent && {
            auditLogPresent: true,
            auditLogPath: auditLogPath(),
          }),
        };
      }
    }
  }

  // Audit (best-effort). Has to happen BEFORE the home is purged or
  // the audit-log path is gone.
  if (!dryRun && !opts.purgeHome) {
    try {
      appendAuditRecord({
        action: "uninstall",
        details: {
          dryRun,
          purgeRepos: !!opts.purgeRepos,
          purgeHome: !!opts.purgeHome,
          steps: reports.map(r => r.step),
        },
      });
    } catch {
      /* audit log must not break user-facing ops */
    }
  }

  if (opts.silent) return;
  if (opts.json) {
    emitJson({
      action: "uninstall",
      dryRun,
      steps: reports,
      purgeRepos: opts.purgeRepos ? purgeReposReport : null,
      purgeHome: purgeHomeReport,
    });
    return;
  }

  if (dryRun) {
    emitText("repo-aegis uninstall — dry run (pass --yes to apply):");
  } else {
    emitText("repo-aegis uninstall:");
  }
  for (const r of reports) {
    emitText(`  ${r.ok ? "✓" : "✗"} ${r.step}`);
  }
  if (purgeHomeReport) {
    if (purgeHomeReport.removed) emitText(`  ✓ purge-home: removed ${purgeHomeReport.path}`);
    else emitText(`  · purge-home: ${purgeHomeReport.path} (${purgeHomeReport.reason})`);
    if (purgeHomeReport.auditLogPresent) {
      emitText(
        `    note: audit log will be deleted with the home dir (${purgeHomeReport.auditLogPath}).`,
      );
      emitText("    Back it up first if you need a compliance record.");
    }
  }
  if (dryRun) {
    emitText("");
    emitText("Re-run with --yes to apply.");
  }
}

interface InstallReturning {
  applied?: boolean;
  skipped?: boolean;
  reason?: string;
}

function runStep(label: string, reports: StepReport[], fn: () => void | InstallReturning): void {
  try {
    const result = fn();
    reports.push({ step: label, ok: true, ...(result && { details: result }) });
  } catch (err) {
    reports.push({ step: label, ok: false, details: (err as Error).message });
  }
}

function runStepSilent(
  label: string,
  reports: StepReport[],
  fn: () => InstallReturning,
): void {
  try {
    const result = fn();
    reports.push({ step: label, ok: true, details: result });
  } catch (err) {
    reports.push({ step: label, ok: false, details: (err as Error).message });
  }
}
