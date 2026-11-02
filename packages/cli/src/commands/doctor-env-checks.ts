// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// `doctor`'s checks for residual risks R8, R9 and R11
// (doc/plan-unregistered-owner-egress.md §8.2): places where the guard judges
// one environment while `gh` or `git` runs in another.
//
//   SHELL_STARTUP_OVERRIDES (warn)  R8/R9: GH_REPO, GIT_SSH_COMMAND, SRT_* or
//                                   REPO_AEGIS_* exported from a shell startup file.
//   SSH_GITHUB_REDIRECT (info)      R9: `Host github.com` in ~/.ssh/config sets
//                                   HostName to something else.
//   PREPUSH_HOOK_MISSING (warn)     R11: a repo with a GitHub remote has no
//                                   repo-aegis pre-push hook.
//
// Both file scanners are pure text readers. They never execute or `source` a
// file, and `SHELL_STARTUP_OVERRIDES` keeps only the variable NAME and the file
// name: the value of a startup-file assignment can be a token or a path, and
// doctor output can land in an agent transcript.
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { defaultSshDir, lookupSshHost, type HookState } from "@de-otio/repo-aegis-core";
import type { DoctorCheck } from "./doctor-checks.js";

// ---------------------------------------------------------------------------
// SHELL_STARTUP_OVERRIDES (R8, R9)
// ---------------------------------------------------------------------------

/**
 * Startup files that a plain `zsh -c` / `bash -c` / login shell reads. The
 * list is deliberately the one the plan names: these are the files an agent
 * with file-write access can edit, and `~/.zshenv` is read by EVERY zsh.
 */
export const SHELL_STARTUP_FILES = [".zshenv", ".zshrc", ".bashrc", ".bash_profile", ".profile"] as const;

/** Variables that steer where `gh` / `git` write, or how repo-aegis judges it. */
function isWatchedVariable(name: string): boolean {
  return (
    name === "GH_REPO" ||
    name === "GIT_SSH_COMMAND" ||
    name === "GIT_SSH" ||
    name === "GIT_SSH_VARIANT" ||
    name.startsWith("SRT_") ||
    name.startsWith("REPO_AEGIS_")
  );
}

/** Files bigger than this are not shell startup files; do not read them. */
const MAX_STARTUP_BYTES = 1024 * 1024;

const NAME = "[A-Za-z_][A-Za-z0-9_]*";

/**
 * Names of watched variables a startup file sets for every child process.
 * Values are never captured.
 *
 *   `export NAME=...`, `export A=1 NAME=2`, `export NAME`
 *   `declare -x NAME=...`, `typeset -x NAME=...` (also `-gx`, `-xg`)
 *   `NAME=value` alone on a line (assigned; exported if the shell is
 *   `set -a` or the name was exported earlier, which text alone cannot tell,
 *   so it is reported)
 *
 * A prefix assignment on a command (`GH_REPO=x gh pr list`) is NOT reported:
 * it applies to that command only.
 */
export function watchedVariablesIn(text: string): string[] {
  const found = new Set<string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;

    const exp = new RegExp(`^(?:export|declare\\s+-[A-Za-z]*x[A-Za-z]*|typeset\\s+-[A-Za-z]*x[A-Za-z]*)\\s+(.*)$`).exec(line);
    if (exp !== null) {
      for (const tok of exp[1]!.split(/\s+/)) {
        const m = new RegExp(`^(${NAME})(?:=|$)`).exec(tok);
        if (m !== null && isWatchedVariable(m[1]!)) found.add(m[1]!);
      }
      continue;
    }

    // A bare assignment with nothing after the value (so it is not a command prefix).
    const bare = new RegExp(`^(${NAME})=(?:"[^"]*"|'[^']*'|\\S*)\\s*(?:#.*)?$`).exec(line);
    if (bare !== null && isWatchedVariable(bare[1]!)) found.add(bare[1]!);
  }
  return [...found].sort();
}

function readStartupFile(path: string): string | null {
  try {
    const st = statSync(path);
    if (!st.isFile() || st.size > MAX_STARTUP_BYTES) return null;
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** One `SHELL_STARTUP_OVERRIDES` check for the startup files under `home`. */
export function checkShellStartupOverrides(home: string = homedir()): DoctorCheck {
  const hits: Array<{ file: string; names: string[] }> = [];
  for (const file of SHELL_STARTUP_FILES) {
    const text = readStartupFile(join(home, file));
    if (text === null) continue;
    const names = watchedVariablesIn(text);
    if (names.length > 0) hits.push({ file, names });
  }
  if (hits.length === 0) {
    return {
      code: "SHELL_STARTUP_OVERRIDES",
      ok: true,
      detail: "no shell startup file exports GH_REPO, GIT_SSH_COMMAND, SRT_* or REPO_AEGIS_*",
    };
  }
  const where = hits.map(h => `~/${h.file} sets ${h.names.join(", ")}`).join("; ");
  return {
    code: "SHELL_STARTUP_OVERRIDES",
    ok: false,
    severity: "warn",
    detail:
      `${where}. These apply to every shell the agent starts, but the agent hook judges a command ` +
      `without them, so a gh or git write can go somewhere the hook did not check (only the gh shim sees the real environment)`,
    fix:
      "remove these exports from the startup files (or scope them to one command), then open a new shell; " +
      "doctor never prints their values",
  };
}

// ---------------------------------------------------------------------------
// SSH_GITHUB_REDIRECT (R9)
// ---------------------------------------------------------------------------

/** The hosts an ssh push to GitHub legitimately lands on. */
const GITHUB_SSH_HOSTS: ReadonlySet<string> = new Set(["github.com", "ssh.github.com"]);

/**
 * `SSH_GITHUB_REDIRECT` (info): `~/.ssh/config` applies a `HostName` to the
 * literal host `github.com` that is not GitHub. Pushes to `git@github.com:`
 * then leave for another server while the guard reads them as GitHub pushes,
 * which is outside its model (R9). Uses the same pure reader as push
 * resolution (never `ssh -G`, which would evaluate `Match exec`).
 */
export function checkSshGithubRedirect(sshDir: string = defaultSshDir()): DoctorCheck {
  const lookup = lookupSshHost("github.com", { sshDir });
  if (lookup.kind === "hostname" && !GITHUB_SSH_HOSTS.has(lookup.hostName)) {
    return {
      code: "SSH_GITHUB_REDIRECT",
      ok: false,
      severity: "info",
      detail:
        "~/.ssh/config has a `Host github.com` block that sets HostName to another host, so `git@github.com:` pushes " +
        "leave for a server the egress guard does not model (it judges them as GitHub pushes)",
      fix: "if this is not intended, remove the HostName line from that block; if it is (a proxy or mirror), no action",
    };
  }
  return {
    code: "SSH_GITHUB_REDIRECT",
    ok: true,
    detail: "~/.ssh/config does not redirect the literal host github.com",
  };
}

// ---------------------------------------------------------------------------
// PREPUSH_HOOK_MISSING (R11)
// ---------------------------------------------------------------------------

/**
 * `PREPUSH_HOOK_MISSING` (warn) for one repo that has a GitHub remote.
 *
 * Pre-push is the only layer that sees the real environment ssh and git will
 * run with. On a hook-only install the agent hook cannot, so a redirect done
 * in a startup file is invisible to it and caught only at pre-push (R11). A
 * repo with no pre-push hook is therefore the weakest place to rely on a
 * hook-only install.
 *
 * "Installed" means what `status` and HOOKS_SCRIPT_STALE use: git's effective
 * hooks directory is repo-aegis's own, and `pre-push` is present and
 * executable there. A stale script is still installed (that is
 * HOOKS_SCRIPT_STALE's finding, not this one). A pre-push in some other
 * `core.hooksPath` is not repo-aegis's, so it does not count.
 */
export function checkPrePushHook(state: HookState): DoctorCheck {
  const script = state.scripts["pre-push"];
  const installed =
    state.effectivePath !== null && state.effectivePath === state.expectedPath && script.present && script.executable;
  if (installed) {
    return { code: "PREPUSH_HOOK_MISSING", ok: true, detail: "the repo-aegis pre-push hook is installed for this repo" };
  }
  return {
    code: "PREPUSH_HOOK_MISSING",
    ok: false,
    severity: "warn",
    detail:
      "this repo has a GitHub remote but no repo-aegis pre-push hook is active, so a push is not re-checked against the " +
      "environment git will really run with (the agent hook alone cannot see it)",
    fix: "repo-aegis install hooks",
  };
}
