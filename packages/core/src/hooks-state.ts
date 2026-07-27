// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// Detects whether repo-aegis's git hooks are actually going to run.
//
// Background (the incident this module exists to catch): git consults
// exactly one hooks directory — whatever `core.hooksPath` resolves to,
// or `<git-dir>/hooks` when unset. A repo-local `core.hooksPath` set to
// an empty (or foreign) directory silently disables every hook,
// including a correctly-configured global one, and nothing reports it:
// commits and pushes just succeed with no scanning. `resolveHookState`
// is the read side of that gap; `status`/`audit` (wired separately)
// surface it to the user.
//
// This module is pure-ish: it reads git config and the filesystem and
// returns a result, it never throws for ordinary misconfiguration (a
// missing/foreign/stale hooks setup IS the result, not an error) and it
// never calls process.exit or prints. The only throws are genuine
// programming errors (e.g. an unreachable code path).
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { repoAegisHome } from "./paths.js";
import { hookScriptDigest, type HookName } from "./hook-scripts.js";

const HOOK_NAMES: readonly HookName[] = ["pre-commit", "pre-push"];

export type HookStateOrigin = "local" | "global" | "system" | "worktree" | "unset";

export type HookStateCode =
  | "HOOKS_OK"
  | "HOOKS_PATH_UNSET"
  | "HOOKS_PATH_FOREIGN"
  | "HOOKS_PATH_LOCAL_OVERRIDE"
  | "HOOKS_SCRIPT_MISSING"
  | "HOOKS_SCRIPT_NOT_EXECUTABLE"
  | "HOOKS_SCRIPT_STALE";

export interface HookScriptState {
  present: boolean;
  executable: boolean;
  /** sha256 of the on-disk file matches {@link hookScriptDigest}. */
  current: boolean;
}

export interface HookState {
  /** False outside a git repository; every other field is a placeholder
   * and callers should skip reporting rather than read `code`. Mirrors
   * the `isGitRepo` convention in `repo.ts`'s `RepoConfig`. */
  isGitRepo: boolean;
  /** Absolute resolved directory git will actually use, or null when
   * `core.hooksPath` is unset (git's default `<git-dir>/hooks`). */
  effectivePath: string | null;
  origin: HookStateOrigin;
  /** Absolute path repo-aegis's own installer targets: `<repoAegisHome>/hooks`. */
  expectedPath: string;
  scripts: Record<HookName, HookScriptState>;
  /** Executable, non-`.sample` scripts sitting directly in this repo's
   * own `<git-common-dir>/hooks` that a non-default `core.hooksPath`
   * bypasses. Empty whenever `effectivePath` already points at that
   * same directory (nothing to shadow). */
  shadowedRepoHooks: string[];
  ok: boolean;
  code: HookStateCode;
  /** One-line remediation for `code`. Empty string when `ok`. */
  fix: string;
}

interface GitResult {
  ok: boolean;
  stdout: string;
}

function git(cwd: string, args: string[]): GitResult {
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

function notAGitRepoState(): HookState {
  const expectedPath = join(repoAegisHome(), "hooks");
  return {
    isGitRepo: false,
    effectivePath: null,
    origin: "unset",
    expectedPath,
    scripts: {
      "pre-commit": { present: false, executable: false, current: false },
      "pre-push": { present: false, executable: false, current: false },
    },
    shadowedRepoHooks: [],
    // Not a failure of anything — there is no hooks concept to evaluate
    // outside a git repo. Callers gate on `isGitRepo` before reading
    // `code`; this placeholder value keeps the return type total.
    ok: true,
    code: "HOOKS_OK",
    fix: "",
  };
}

function isExecutable(mode: number): boolean {
  return (mode & 0o111) !== 0;
}

function inspectScript(dir: string, name: HookName): HookScriptState {
  const path = join(dir, name);
  try {
    const st = statSync(path);
    if (!st.isFile()) return { present: false, executable: false, current: false };
    const executable = isExecutable(st.mode);
    const contents = readFileSync(path, "utf8");
    const digest = createHash("sha256").update(contents).digest("hex");
    const current = digest === hookScriptDigest(name);
    return { present: true, executable, current };
  } catch {
    return { present: false, executable: false, current: false };
  }
}

function listShadowedHooks(dir: string): string[] {
  if (!existsSync(dir)) return [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    if (entry.endsWith(".sample")) continue;
    const full = join(dir, entry);
    try {
      const st = statSync(full);
      if (st.isFile() && isExecutable(st.mode)) out.push(entry);
    } catch {
      /* races / permission errors: skip, not fatal to the overall result */
    }
  }
  return out.sort();
}

/**
 * Parses the tab-separated `<scope>\t<origin>\t<value>` line produced by
 * `git config --show-origin --show-scope --get <key>`. Returns null when
 * the key is unset (non-zero exit / empty output) — that IS a valid,
 * common result, not an error.
 */
function readEffectiveHooksPath(cwd: string): { scope: string; value: string } | null {
  const res = git(cwd, ["config", "--show-origin", "--show-scope", "--get", "core.hooksPath"]);
  if (!res.ok || res.stdout === "") return null;
  const tab1 = res.stdout.indexOf("\t");
  const tab2 = res.stdout.indexOf("\t", tab1 + 1);
  if (tab1 === -1 || tab2 === -1) return null;
  const scope = res.stdout.slice(0, tab1);
  const value = res.stdout.slice(tab2 + 1);
  return { scope, value };
}

function readScopedHooksPath(cwd: string, scope: "local" | "global"): string | null {
  const res = git(cwd, ["config", "--" + scope, "--get", "core.hooksPath"]);
  return res.ok && res.stdout !== "" ? res.stdout : null;
}

function mapScope(raw: string): HookStateOrigin {
  switch (raw) {
    case "local":
    case "global":
    case "system":
    case "worktree":
      return raw;
    default:
      // "command" (from `-c core.hooksPath=...`) or "unknown": neither
      // is a case install-hooks (or a human) produces by hand. Fold
      // into "worktree" is wrong and "unset" is misleading (a value IS
      // set); treat as foreign-origin "global" so the path-mismatch
      // branch below still fires rather than silently reporting OK.
      return "global";
  }
}

/**
 * Resolves whether repo-aegis's git hooks are installed, on the path
 * git will actually consult, executable, and up to date.
 *
 * Never throws for ordinary misconfiguration; a bad state IS the
 * result. Returns a clearly-marked `isGitRepo: false` result outside a
 * git repository.
 */
export function resolveHookState(cwd: string): HookState {
  const inside = git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (!inside.ok || inside.stdout !== "true") return notAGitRepoState();

  const expectedPath = join(repoAegisHome(), "hooks");

  // `--git-common-dir` (not `--git-dir`) is deliberate: in a linked
  // worktree, hooks live in the *common* dir, shared across worktrees,
  // not the per-worktree admin dir. This is git's real default hooks
  // location, independent of any core.hooksPath override — it is what
  // `shadowedRepoHooks` inspects.
  const commonDirRes = git(cwd, ["rev-parse", "--git-common-dir"]);
  const realHooksDir = resolve(cwd, join(commonDirRes.ok ? commonDirRes.stdout : ".git", "hooks"));

  const effective = readEffectiveHooksPath(cwd);

  if (effective === null) {
    // Unset: git falls back to <git-dir>/hooks, i.e. exactly
    // realHooksDir. Nothing is shadowed — that directory IS the
    // effective one. `scripts` reports on whatever happens to live
    // there today (almost always: repo-aegis was never installed).
    const scripts = buildScripts(realHooksDir);
    return {
      isGitRepo: true,
      effectivePath: null,
      origin: "unset",
      expectedPath,
      scripts,
      shadowedRepoHooks: [],
      ok: false,
      code: "HOOKS_PATH_UNSET",
      fix: "repo-aegis install hooks",
    };
  }

  // `git rev-parse --git-path hooks` resolves the *configured* value the
  // same way git itself would when it goes to run a hook (relative
  // values are relative to `cwd`), so resolving it against `cwd` gives
  // the real absolute directory regardless of which scope set it.
  const gitPathRes = git(cwd, ["rev-parse", "--git-path", "hooks"]);
  const effectivePath = resolve(cwd, gitPathRes.ok ? gitPathRes.stdout : effective.value);
  const origin = mapScope(effective.scope);

  const scripts = buildScripts(effectivePath);
  const shadowedRepoHooks = effectivePath === realHooksDir ? [] : listShadowedHooks(realHooksDir);

  if (effectivePath !== expectedPath) {
    // The path itself is wrong, independent of what's sitting in it.
    // Distinguish the specific "local override hides a correct global
    // setting" incident (origin=local, and a global value that WOULD
    // have been correct exists) from a generic foreign path, because
    // the fix differs in urgency and specificity — the former had a
    // working setup one `--unset` away, the latter never did.
    let localShadowsCorrectGlobal = false;
    if (origin === "local") {
      const globalVal = readScopedHooksPath(cwd, "global");
      localShadowsCorrectGlobal = globalVal !== null && resolve(cwd, globalVal) === expectedPath;
    }
    return {
      isGitRepo: true,
      effectivePath,
      origin,
      expectedPath,
      scripts,
      shadowedRepoHooks,
      ok: false,
      code: localShadowsCorrectGlobal ? "HOOKS_PATH_LOCAL_OVERRIDE" : "HOOKS_PATH_FOREIGN",
      fix: "git config --unset core.hooksPath",
    };
  }

  // Path is correct; now check the scripts actually installed at it.
  const missing = HOOK_NAMES.filter(n => !scripts[n].present);
  if (missing.length > 0) {
    return {
      isGitRepo: true,
      effectivePath,
      origin,
      expectedPath,
      scripts,
      shadowedRepoHooks,
      ok: false,
      code: "HOOKS_SCRIPT_MISSING",
      fix: "repo-aegis install hooks",
    };
  }

  const notExecutable = HOOK_NAMES.filter(n => !scripts[n].executable);
  if (notExecutable.length > 0) {
    return {
      isGitRepo: true,
      effectivePath,
      origin,
      expectedPath,
      scripts,
      shadowedRepoHooks,
      ok: false,
      code: "HOOKS_SCRIPT_NOT_EXECUTABLE",
      // No --force needed here: core.hooksPath already equals
      // expectedPath (we only reach this branch when it does), so
      // there's no conflicting value for --force to overwrite.
      // install-hooks always (re)writes the scripts with mode 0o755.
      fix: "repo-aegis install hooks",
    };
  }

  const stale = HOOK_NAMES.filter(n => !scripts[n].current);
  if (stale.length > 0) {
    return {
      isGitRepo: true,
      effectivePath,
      origin,
      expectedPath,
      scripts,
      shadowedRepoHooks,
      ok: false,
      code: "HOOKS_SCRIPT_STALE",
      fix: "repo-aegis install hooks",
    };
  }

  return {
    isGitRepo: true,
    effectivePath,
    origin,
    expectedPath,
    scripts,
    shadowedRepoHooks,
    ok: true,
    code: "HOOKS_OK",
    fix: "",
  };
}

function buildScripts(dir: string): Record<HookName, HookScriptState> {
  return {
    "pre-commit": inspectScript(dir, "pre-commit"),
    "pre-push": inspectScript(dir, "pre-push"),
  };
}
