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

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** Semver precedence of two prerelease strings (`rc.2` against `rc.10`): numeric identifiers by value and below alphanumeric ones, a shorter list below a longer one it prefixes. */
function comparePrerelease(a: string, b: string): number {
  const x = a.split(".");
  const y = b.split(".");
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const p = x[i];
    const q = y[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn) {
      const d = Number(p) - Number(q);
      if (d !== 0) return d < 0 ? -1 : 1;
    } else if (pn !== qn) {
      return pn ? -1 : 1;
    } else if (p !== q) {
      return p < q ? -1 : 1;
    }
  }
  return 0;
}

/**
 * Is `running` a newer release than `seen`? Ordered like semver: `MAJOR.MINOR.PATCH` numerically, and a prerelease
 * below its release (`0.14.0-rc.1` < `0.14.0`), prereleases among themselves numerically (`rc.2` < `rc.10`). A
 * version that is not semver at all (a dev tree) cannot be ordered, so any difference counts as news: a missed
 * notice costs more than a spare one. Build metadata (`+build`) is ignored.
 */
export function isNewer(running: string, seen: string): boolean {
  const a = SEMVER.exec(running);
  const b = SEMVER.exec(seen);
  if (a === null || b === null) return running !== seen;
  for (let i = 1; i <= 3; i++) {
    const d = Number(a[i]) - Number(b[i]);
    if (d !== 0) return d > 0;
  }
  const pa = a[4];
  const pb = b[4];
  if (pa === undefined && pb === undefined) return false;
  if (pa === undefined) return true; // a release is newer than its own prerelease
  if (pb === undefined) return false;
  return comparePrerelease(pa, pb) > 0;
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
