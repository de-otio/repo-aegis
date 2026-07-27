// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
import { mkdirSync, writeFileSync, chmodSync, existsSync, unlinkSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  repoAegisHome,
  appendAuditRecord,
  PRE_COMMIT_SCRIPT,
  PRE_PUSH_SCRIPT,
} from "@de-otio/repo-aegis-core";
import { emitJson, emitText, emitError, type OutputOptions } from "../format.js";

// Hook script text (PRE_COMMIT_SCRIPT / PRE_PUSH_SCRIPT) lives in
// core/src/hook-scripts.ts, which is now the SINGLE source of truth —
// this file only writes those strings to disk and points
// core.hooksPath at them. Moved out of here so `hooks-state.ts` can
// compute a digest of "the script that should be on disk" without the
// core package depending on the cli package.

type HooksScope = "global" | "local";

interface InstallHooksOptions extends OutputOptions {
  force?: boolean;
  cwd?: string;
  /**
   * When true, do the work but suppress all stdout/stderr emission
   * (no emitJson / emitText). emitError still fires on hard failure
   * (which calls process.exit). Used by `init` to call this command
   * inline without polluting init's own output stream.
   */
  silent?: boolean;
  /**
   * When true, reverse the install: unset core.hooksPath in BOTH the
   * global and local scope (idempotent per scope; "not set" is
   * silently ignored) and remove the pre-commit / pre-push files under
   * <repoAegisHome>/hooks if they exist. The hooks directory itself is
   * left in place because other tooling may store files there.
   */
  uninstall?: boolean;
  /**
   * Write core.hooksPath in the repo-LOCAL git config instead of
   * global. Global is the default (since the v0.7 default flip) so
   * coverage doesn't depend on remembering to run `install hooks` in
   * every repo; --local is the explicit, single-repo opt-out for
   * anyone who wants the old per-repo behaviour back.
   */
  local?: boolean;
  /**
   * Accepted for explicitness/symmetry with --local in scripts. Global
   * is already the default when neither flag is passed, so this is a
   * no-op — but "repo-aegis install hooks --global" being a valid,
   * readable thing to type is worth the option slot.
   */
  global?: boolean;
  /**
   * Clear a repo-local core.hooksPath that would otherwise shadow the
   * global value this command is about to write, in one step. Only
   * meaningful when writing global (the default); a no-op with
   * --local. See the HOOKS_PATH_LOCAL_SHADOW guard below for the
   * footgun this exists to resolve.
   */
  unsetLocal?: boolean;
  /**
   * Throw on hard failure instead of calling emitError (which exits the
   * process). `init` needs this: since the v0.7 default flip the config
   * write targets the GLOBAL scope, which can legitimately be
   * unwritable (a read-only or redirected GIT_CONFIG_GLOBAL, a locked
   *-down CI image). Exiting 2 there would abort an `init` that had
   * already scaffolded the home dir, reporting total failure for a
   * partial one. With this set, `init` catches the failure, reports
   * hooks as not-installed with the reason, and completes — and the
   * resulting gap is no longer invisible, because `status`, `audit`,
   * and `doctor` now check hook liveness directly.
   */
  throwOnError?: boolean;
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

/** Reads `core.hooksPath` from exactly one scope (never the merged
 * effective value) — the same distinction `hooks-state.ts` draws
 * between `effectivePath` (merged) and a scope-specific read. Writing
 * a scope must only ever conflict-check against THAT scope's own
 * prior value, not whatever another scope happens to hold. */
function gitConfigGetScoped(cwd: string, scope: HooksScope, key: string): string | null {
  const res = git(cwd, ["config", `--${scope}`, "--get", key]);
  return res.ok && res.stdout !== "" ? res.stdout : null;
}

function gitConfigSetScoped(cwd: string, scope: HooksScope, key: string, value: string): void {
  execFileSync("git", ["config", `--${scope}`, key, value], {
    cwd,
    stdio: ["ignore", "ignore", "ignore"],
  });
}

/** True when a value was actually cleared. `git config --unset` exits
 * 5 when the key was never set in this scope; that is swallowed here
 * so callers stay idempotent and can distinguish "cleared" from
 * "nothing to clear" via the caller's own prior-value read instead. */
function gitConfigUnsetScoped(cwd: string, scope: HooksScope, key: string): boolean {
  try {
    execFileSync("git", ["config", `--${scope}`, "--unset", key], {
      cwd,
      stdio: ["ignore", "ignore", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

/** Absolute path of the repo-LOCAL git config file (`<git-common-dir>/
 * config`), used only for the forensic mtime capture below — never
 * mutated directly. Mirrors the equivalent helper in `doctor.ts`. */
function localConfigPath(cwd: string): string | null {
  const res = git(cwd, ["rev-parse", "--git-path", "config"]);
  if (!res.ok || res.stdout === "") return null;
  return resolve(cwd, res.stdout);
}

/** Parses a `file:<path>\t...` line from `git config --show-origin`. */
function parseShowOriginPath(line: string): string | null {
  if (!line.startsWith("file:")) return null;
  const tab = line.indexOf("\t");
  const path = tab === -1 ? line.slice(5) : line.slice(5, tab);
  return path === "" ? null : path;
}

/**
 * Best-effort absolute path of the GLOBAL git config file. There is no
 * `--git-path` equivalent for the global scope, so this asks git
 * directly (`--show-origin`) when there is at least one entry to
 * report an origin for, and otherwise falls back to the same
 * resolution git itself would use — honoring GIT_CONFIG_GLOBAL (which
 * is exactly how tests redirect this safely, see hooks-state.test.ts)
 * before falling back to the conventional `~/.gitconfig`.
 */
function globalConfigPath(cwd: string): string | null {
  const withKey = git(cwd, ["config", "--global", "--show-origin", "--get", "core.hooksPath"]);
  if (withKey.ok && withKey.stdout !== "") {
    const p = parseShowOriginPath(withKey.stdout);
    if (p) return p;
  }
  const list = git(cwd, ["config", "--global", "--show-origin", "--list"]);
  if (list.ok && list.stdout !== "") {
    const firstLine = list.stdout.split("\n")[0] ?? "";
    const p = parseShowOriginPath(firstLine);
    if (p) return p;
  }
  const override = process.env["GIT_CONFIG_GLOBAL"];
  if (override) return override;
  return join(homedir(), ".gitconfig");
}

function configPathForScope(cwd: string, scope: HooksScope): string | null {
  return scope === "local" ? localConfigPath(cwd) : globalConfigPath(cwd);
}

function configMtimeIso(path: string | null): string | null {
  if (path === null) return null;
  try {
    return statSync(path).mtime.toISOString();
  } catch {
    return null;
  }
}

interface UninstallHooksContext {
  cwd: string;
  hooksDir: string;
  preCommitPath: string;
  prePushPath: string;
  opts: InstallHooksOptions;
}

function uninstallHooks(ctx: UninstallHooksContext): void {
  const { cwd, hooksDir, preCommitPath, prePushPath, opts } = ctx;

  // Forensics BEFORE mutating anything (task rationale: the
  // investigation that motivated this lane lost the only evidence that
  // would have dated the regression, because the repair rewrote
  // .git/config before anyone recorded its mtime — repair overwrites
  // forensics). Capture both scopes' prior values and config-file
  // mtimes up front.
  const previousGlobal = gitConfigGetScoped(cwd, "global", "core.hooksPath");
  const previousLocal = gitConfigGetScoped(cwd, "local", "core.hooksPath");
  const globalConfigMtime = configMtimeIso(configPathForScope(cwd, "global"));
  const localConfigMtime = configMtimeIso(configPathForScope(cwd, "local"));

  // Uninstall symmetry: a bare `git config --unset core.hooksPath`
  // clears whichever scope git finds first and silently leaves the
  // OTHER scope's value in place — exactly the silent-shadowing bug
  // this lane exists to fix, just encountered at uninstall time
  // instead of install time. Unset both scopes and report each
  // independently rather than relying on git's single-scope --unset.
  const globalUnset =
    previousGlobal !== null && gitConfigUnsetScoped(cwd, "global", "core.hooksPath");
  const localUnset =
    previousLocal !== null && gitConfigUnsetScoped(cwd, "local", "core.hooksPath");

  const removed: string[] = [];
  for (const p of [preCommitPath, prePushPath]) {
    if (existsSync(p)) {
      try {
        unlinkSync(p);
        removed.push(p);
      } catch (err) {
        emitError(
          {
            code: "FS_ERROR",
            error: `failed to remove ${p}: ${(err as Error).message}`,
          },
          opts,
        );
      }
    }
  }

  try {
    appendAuditRecord({
      action: "install-hooks-uninstall",
      cwd,
      repo: cwd,
      details: {
        hooksDir,
        removed,
        global: { unset: globalUnset, previousCoreHooksPath: previousGlobal, configMtime: globalConfigMtime },
        local: { unset: localUnset, previousCoreHooksPath: previousLocal, configMtime: localConfigMtime },
      },
    });
  } catch {
    /* audit log must not break user-facing ops */
  }

  if (opts.silent) return;

  if (opts.json) {
    emitJson({
      action: "uninstall-hooks",
      hooksDir,
      removed,
      global: { unset: globalUnset, previousCoreHooksPath: previousGlobal },
      local: { unset: localUnset, previousCoreHooksPath: previousLocal },
    });
    return;
  }

  if (globalUnset) {
    emitText(`unset global core.hooksPath (was: ${previousGlobal})`);
  } else if (previousGlobal !== null) {
    emitText(`failed to unset global core.hooksPath (was: ${previousGlobal})`);
  } else {
    emitText("global core.hooksPath was not set (nothing to unset)");
  }
  if (localUnset) {
    emitText(`unset local core.hooksPath (was: ${previousLocal})`);
  } else if (previousLocal !== null) {
    emitText(`failed to unset local core.hooksPath (was: ${previousLocal})`);
  } else {
    emitText("local core.hooksPath was not set (nothing to unset)");
  }
  if (removed.length > 0) {
    for (const p of removed) emitText(`removed ${p}`);
  } else {
    emitText(`no hook scripts to remove under ${hooksDir}`);
  }
}

export function installHooks(opts: InstallHooksOptions): void {
  const cwd = opts.cwd ?? process.cwd();

  const inside = git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (!inside.ok || inside.stdout !== "true") {
    emitError({ code: "NOT_GIT_REPO", error: "not inside a git repository" }, opts);
  }

  const hooksDir = join(repoAegisHome(), "hooks");
  const preCommitPath = join(hooksDir, "pre-commit");
  const prePushPath = join(hooksDir, "pre-push");

  if (opts.uninstall) {
    uninstallHooks({ cwd, hooksDir, preCommitPath, prePushPath, opts });
    return;
  }

  const scope: HooksScope = opts.local ? "local" : "global";

  // --unset-local: clear a shadowing repo-local override before the
  // conflict checks below run, so a value cleared here no longer
  // counts as a conflict. Only fires for a global install — clearing
  // local ahead of a LOCAL write would just be clearing the thing
  // we're about to overwrite anyway, and the shadow it exists to
  // resolve only applies when writing global.
  let unsetLocalPreviousValue: string | null = null;
  let unsetLocalPerformed = false;
  if (scope === "global" && opts.unsetLocal) {
    unsetLocalPreviousValue = gitConfigGetScoped(cwd, "local", "core.hooksPath");
    if (unsetLocalPreviousValue !== null) {
      unsetLocalPerformed = gitConfigUnsetScoped(cwd, "local", "core.hooksPath");
    }
  }

  // Same-scope conflict: does the scope we're about to write already
  // hold a DIFFERENT value? (Scoped read, not the merged effective
  // value — see gitConfigGetScoped's doc comment.)
  const previousValue = gitConfigGetScoped(cwd, scope, "core.hooksPath");
  const sameScopeConflict = previousValue !== null && previousValue !== hooksDir;

  // The footgun this lane exists to fix: writing GLOBAL while a
  // DIFFERING repo-local value still exists would leave that local
  // value silently shadowing the global one forever — git consults
  // exactly one hooks directory. Re-read AFTER --unset-local above so
  // a value cleared there no longer counts as a conflict.
  let shadowingLocalValue: string | null = null;
  if (scope === "global") {
    const localValue = gitConfigGetScoped(cwd, "local", "core.hooksPath");
    if (localValue !== null && localValue !== hooksDir) {
      shadowingLocalValue = localValue;
    }
  }

  if ((sameScopeConflict || shadowingLocalValue !== null) && !opts.force) {
    if (shadowingLocalValue !== null) {
      emitError(
        {
          code: "HOOKS_PATH_LOCAL_SHADOW",
          error: "a repo-local core.hooksPath would shadow the global value being installed",
          details:
            `local:  ${shadowingLocalValue}\n` +
            `  global target: ${hooksDir}\n` +
            `  git consults exactly one hooks directory, so this repo-local value would ` +
            `silently keep the global hooks from ever running in this repo.\n` +
            `  --force will proceed anyway and leave the local value in place (still shadowing); ` +
            `--unset-local will OVERWRITE (destroy) the local value "${shadowingLocalValue}" instead ` +
            `— save it first if it's still needed.`,
        },
        opts,
      );
    } else {
      emitError(
        {
          code: "HOOKS_PATH_CONFLICT",
          error: `core.hooksPath (${scope}) is already set to a different path`,
          details:
            `current: ${previousValue}\n` +
            `  target:  ${hooksDir}\n` +
            `  --force will OVERWRITE (destroy) the prior value "${previousValue}"; ` +
            `if that path is still needed, save it before re-running with --force.`,
        },
        opts,
      );
    }
  }

  // Forensics BEFORE mutating (same rationale as the uninstall path
  // above): capture the config file's mtime now, before the write
  // below changes it.
  const configPath = configPathForScope(cwd, scope);
  const configMtimeBefore = configMtimeIso(configPath);

  try {
    mkdirSync(hooksDir, { recursive: true, mode: 0o700 });
    try {
      chmodSync(hooksDir, 0o700);
    } catch {
      /* platform-restricted */
    }

    writeFileSync(preCommitPath, PRE_COMMIT_SCRIPT, { mode: 0o755 });
    chmodSync(preCommitPath, 0o755);

    writeFileSync(prePushPath, PRE_PUSH_SCRIPT, { mode: 0o755 });
    chmodSync(prePushPath, 0o755);
  } catch (err) {
    emitError(
      { code: "FS_ERROR", error: `failed to write hook scripts: ${(err as Error).message}` },
      opts,
    );
  }

  try {
    gitConfigSetScoped(cwd, scope, "core.hooksPath", hooksDir);
  } catch (err) {
    const message = `failed to set core.hooksPath (${scope}): ${(err as Error).message}`;
    if (opts.throwOnError) throw new Error(message);
    emitError({ code: "GIT_CONFIG_ERROR", error: message }, opts);
  }

  // Audit (best-effort). Emit AFTER the git config is set so the
  // record reflects persisted state; previousCoreHooksPath + configMtime
  // above were captured BEFORE the mutation, which is the whole point
  // (see the forensics comment on the uninstall path).
  try {
    appendAuditRecord({
      action: "install-hooks",
      cwd,
      repo: cwd,
      details: {
        scope,
        hooksDir,
        overwritten: sameScopeConflict,
        previousCoreHooksPath: previousValue,
        configMtime: configMtimeBefore,
        ...(shadowingLocalValue !== null && { shadowingLocalValue }),
        ...(unsetLocalPerformed && { unsetLocalPrevious: unsetLocalPreviousValue }),
      },
    });
  } catch {
    /* audit log must not break user-facing ops */
  }

  if (opts.silent) return;

  if (opts.json) {
    emitJson({
      action: "install-hooks",
      hooksDir,
      installed: ["pre-commit", "pre-push"],
      coreHooksPath: hooksDir,
      scope,
      previousCoreHooksPath: previousValue,
      overwritten: sameScopeConflict,
      shadowingLocalValue,
      unsetLocal: unsetLocalPerformed
        ? { performed: true, previous: unsetLocalPreviousValue }
        : { performed: false, previous: null },
    });
    return;
  }

  emitText(`installed hooks at ${hooksDir}`);
  emitText(`set ${scope} core.hooksPath = ${hooksDir}`);
  if (sameScopeConflict) {
    emitText(`  (previous ${scope} value: ${previousValue} — overwritten with --force)`);
  }
  if (unsetLocalPerformed) {
    emitText(`  cleared shadowing local core.hooksPath (was: ${unsetLocalPreviousValue})`);
  } else if (shadowingLocalValue !== null) {
    emitText(
      `  warning: a repo-local core.hooksPath (${shadowingLocalValue}) still shadows the ` +
        `global value just set — re-run with --unset-local to fix, or ` +
        `'git config --unset core.hooksPath' in this repo.`,
    );
  }
}
