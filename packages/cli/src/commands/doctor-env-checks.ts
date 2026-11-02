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
//   PREPUSH_HOOK_MISSING (warn)     R11: the guard hook is registered but the global
//                                   core.hooksPath is not the repo-aegis hooks directory.
//
// Both file scanners are pure text readers. They never execute or `source` a
// file, and `SHELL_STARTUP_OVERRIDES` keeps only the variable NAME and the file
// name: the value of a startup-file assignment can be a token or a path, and
// doctor output can land in an agent transcript.
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { defaultSshDir, lookupSshHost, repoAegisHome } from "@de-otio/repo-aegis-core";
import type { DoctorCheck } from "./doctor-checks.js";

// ---------------------------------------------------------------------------
// SHELL_STARTUP_OVERRIDES (R8, R9)
// ---------------------------------------------------------------------------

/**
 * Startup files that a plain `zsh -c` / `bash -c` / login shell reads. The
 * list is deliberately the one the plan names: these are the files an agent
 * with file-write access can edit, and `~/.zshenv` is read by EVERY zsh.
 */
export const SHELL_STARTUP_FILES = [
  ".zshenv",
  ".zshrc",
  ".zprofile",
  ".zlogin",
  ".bashrc",
  ".bash_profile",
  ".bash_login",
  ".profile",
] as const;

/** Variables that steer where `gh` / `git` write, or how repo-aegis judges it. */
function isWatchedVariable(name: string): boolean {
  return (
    name === "GH_REPO" ||
    name === "GH_HOST" ||
    name === "GH_CONFIG_DIR" ||
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
      detail: "no shell startup file exports GH_REPO, GH_HOST, GH_CONFIG_DIR, GIT_SSH_COMMAND, SRT_* or REPO_AEGIS_*",
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
  const hostRedirect = lookup.kind === "hostname" && !GITHUB_SSH_HOSTS.has(lookup.hostName);
  const proxied = (lookup.kind === "hostname" || lookup.kind === "none") && lookup.proxied === true;
  if (hostRedirect || proxied) {
    return {
      code: "SSH_GITHUB_REDIRECT",
      ok: false,
      severity: "info",
      detail: hostRedirect
        ? "~/.ssh/config has a `Host github.com` block that sets HostName to another host, so `git@github.com:` pushes " +
          "leave for a server the egress guard does not model (it judges them as GitHub pushes)"
        : "~/.ssh/config applies a ProxyCommand or ProxyJump (or canonicalisation) to `github.com`, so `git@github.com:` " +
          "pushes can leave through a program or host the egress guard does not model",
      fix: "if this is not intended, remove the HostName / ProxyCommand / ProxyJump line from that block; if it is (a proxy or mirror), no action",
    };
  }
  return {
    code: "SSH_GITHUB_REDIRECT",
    ok: true,
    detail: "~/.ssh/config does not redirect or proxy the literal host github.com",
  };
}

// ---------------------------------------------------------------------------
// PREPUSH_HOOK_MISSING (R11)
// ---------------------------------------------------------------------------

/** Global `core.hooksPath` with `~` expanded by git itself; null when unset. */
function readGlobalHooksPath(): string | null {
  try {
    const out = execFileSync("git", ["config", "--global", "--type=path", "--get", "core.hooksPath"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out === "" ? null : out;
  } catch {
    return null;
  }
}

/**
 * `PREPUSH_HOOK_MISSING` (warn), machine level: the egress guard hook is
 * registered, but the GLOBAL `core.hooksPath` is unset or is not the repo-aegis
 * hooks directory, so a repo that does not set it locally has no repo-aegis
 * `pre-push` hook (R11).
 *
 * Pre-push is the only layer that sees the environment git and ssh will really
 * run with. A hook-only install cannot see a redirect done in a startup file
 * (R8, R9), so it is caught at pre-push or not at all. Machine level on
 * purpose: it is one setting, not a per-repo property to sweep for, and a
 * per-repo condition duplicated the hook-liveness sweep's own findings.
 *
 * Silent when the guard hook is not registered (GUARD_HOOK_UNREGISTERED already
 * says so, and there is no hook-only install to be weak). `readGlobal` is a
 * seam so a case can say what the global config holds.
 */
export function checkPrePushHook(
  guardHookRegistered: boolean,
  readGlobal: () => string | null = readGlobalHooksPath,
): DoctorCheck | null {
  if (!guardHookRegistered) return null;
  const expected = resolve(join(repoAegisHome(), "hooks"));
  const actual = readGlobal();
  if (actual !== null && resolve(actual) === expected) {
    return { code: "PREPUSH_HOOK_MISSING", ok: true, detail: "the global core.hooksPath is the repo-aegis hooks directory" };
  }
  return {
    code: "PREPUSH_HOOK_MISSING",
    ok: false,
    severity: "warn",
    detail:
      "the egress guard hook is registered, but the global core.hooksPath " +
      (actual === null ? "is unset" : "is not the repo-aegis hooks directory") +
      ", so a repo that does not set it locally has no pre-push hook, the only layer that sees the environment git will really run with",
    fix: "repo-aegis install hooks",
  };
}
