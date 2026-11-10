// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// The once-per-version notice: after repo-aegis is upgraded, the first interactive command (or git hook run)
// says, once, on stderr, that the installed hooks, shim and Claude Code drop-in may be stale and that
// `repo-aegis upgrade` brings them up to date. The version last seen lives in `<home>/state/last-version`.
//
// This is a nudge for the honest mistake of upgrading the package and forgetting the installs it generated.
// It must never get in the way of a protocol, so it is small, takes its home and version as arguments, and
// is quiet in the places that read the program's output as data:
//   - `hook ...` (Claude Code's hook commands: JSON on stdout, and stderr is forwarded to the agent on exit 2),
//   - `git-credential` (stdout is git's credential protocol), `gh` and `egress-check` / `egress-readback`
//     (reached through the shim on every `gh` call),
//   - `explain` (read-only by contract: it creates nothing),
//   - CI runners (a fresh home on every job would print it on every run),
//   - `--json` (global or command level): a machine reads that output, usually the VS Code extension, and discards
//     stderr, so the line would be spent on nobody (see `noticeApplies`),
//   - a machine with no `<home>` at all: a person who never ran `init` has nothing generated to go stale, and the
//     notice would create the directory (default permissions) just to nag.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { statePath } from "@de-otio/repo-aegis-core";
import { compareVersions } from "./semver.js";

/** Top-level commands that never print the notice. `upgrade` and `init` record the version instead. */
const QUIET_COMMANDS: ReadonlySet<string> = new Set([
  "hook",
  "git-credential",
  "gh",
  "egress-check",
  "egress-readback",
  "upgrade",
  "init",
  "uninstall",
  // Read-only by contract ("no registry, no network, no git"; it must not create a home): a state write would break that.
  "explain",
  // Read-only like `explain` (P1-F): prints a shipped doc and nothing else.
  "docs",
  // Writes nothing outside $TMPDIR by contract (P1-G), and `upgrade` runs it: a state write would break both.
  "selftest",
]);

export function lastVersionPath(home: string): string {
  return join(statePath(home), "last-version");
}

/** The version recorded in `<home>/state/last-version`, or null when there is none (or it cannot be read). */
export function readLastVersion(home: string): string | null {
  try {
    const text = readFileSync(lastVersionPath(home), "utf8").trim();
    return text === "" ? null : text;
  } catch {
    return null;
  }
}

/**
 * Record `version` as seen, keeping the HIGHEST version seen: two installs sharing one home (a global one and a
 * worktree or `npx` copy) would otherwise overwrite each other's record and each would announce itself again on
 * every alternate run. Returns false when `<home>` does not exist (a machine that never ran `init`: nothing to
 * go stale, and this must not create it) or the state directory is not writable.
 */
export function recordVersion(home: string, version: string): boolean {
  try {
    if (!existsSync(home)) return false;
    const seen = readLastVersion(home);
    if (seen !== null && !isNewer(version, seen)) return true; // the record already holds this or something newer
    mkdirSync(statePath(home), { recursive: true });
    const path = lastVersionPath(home);
    writeFileSync(path, `${version}\n`, { mode: 0o600 });
    chmodSync(path, 0o600);
    return true;
  } catch {
    return false;
  }
}

/**
 * Is `running` a newer release than `seen`? Ordered like semver (see `compareVersions`). A version that is not semver
 * at all (a dev tree) cannot be ordered, so any difference counts as news: a missed notice costs more than a spare one.
 */
export function isNewer(running: string, seen: string): boolean {
  const c = compareVersions(running, seen);
  return c === null ? running !== seen : c > 0;
}

/** The one line the notice prints (without its newline). */
export function noticeLine(version: string): string {
  return `repo-aegis ${version} is new here: run \`repo-aegis upgrade\``;
}

export interface VersionNoticeInput {
  home: string;
  /** The running version. */
  version: string;
  /** Where the line goes: stderr in production. */
  write: (text: string) => void;
}

/**
 * Print the notice when the running version is newer than the one last seen in `home` (or none was recorded:
 * an install from before this file existed is exactly who needs it), and record the version. The record is made
 * first: when it cannot be written the notice could not stay "once", so it is not printed at all. A running
 * version that is OLDER than the recorded one (another install on the same home, a downgrade) prints nothing and
 * leaves the record at the highest version seen. Returns true when it printed.
 */
export function versionNotice(input: VersionNoticeInput): boolean {
  const seen = readLastVersion(input.home);
  if (seen === input.version) return false;
  if (seen !== null && !isNewer(input.version, seen)) return false;
  if (!recordVersion(input.home, input.version)) return false;
  input.write(`${noticeLine(input.version)}\n`);
  return true;
}

/**
 * Which command the notice is for: `path` is the command's name chain below the program (`["install", "hooks"]`).
 * False for the commands whose output is read as data, for `--json` (a machine, not a person, reads it: the VS Code
 * extension runs `status --json` and `check --json` and drops stderr), and for CI.
 */
export function noticeApplies(path: readonly string[], env: NodeJS.ProcessEnv = process.env, json = false): boolean {
  const first = path[0];
  if (first === undefined || QUIET_COMMANDS.has(first) || json) return false;
  const ci = env["CI"];
  return ci === undefined || ci === "" || ci === "0" || ci.toLowerCase() === "false";
}

/** Commands that mean "this version's installs were just made": they record the version without printing. */
export function recordsVersion(path: readonly string[]): boolean {
  return path[0] === "init";
}
