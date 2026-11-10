// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// The emergency pause: a person-only, time-boxed off switch (complexity-review P1-E).
//
// Honest mistake it covers: "repo-aegis is wrong right now and I have to ship". A false positive under a deadline
// should cost one command, and that command must come back on its own, so a pause ALWAYS expires: the default is
// one hour, the cap is eight, and there is no "until further notice".
//
// THE PERSON-ONLY GATE IS THE WHOLE DESIGN. This file is a global off switch, so who may write it matters more
// than anything it does. The writers are `repo-aegis pause` (a terminal gate, `PAUSE_NEEDS_TTY`, like `approve`)
// and nothing else. An agent runs as the same OS user as the person, so file ownership and mode cannot keep it
// off the file; the agent-side locks are these four:
//   - the egress guard refuses an agent Bash command that runs `repo-aegis pause` (core/human-commands.ts),
//     paused or not, and a text rule there refuses a command that writes a word ending in `pause.json` under a
//     `repo-aegis` path (a redirect, `cp`, `mv`, `tee`, `install`, `ln`, an interpreter's `open(`);
//   - `Edit(<home>/pause.json)` is in the deny rules `install claude-md` writes, so the agent's own write tools
//     and its sandboxed shell cannot touch the file;
//   - `check-write` refuses a write to it that gets past those, wherever the path is spelled: any letter case,
//     through a symlinked directory or a symlinked file (cli/state-file-guard.ts);
//   - this reader requires the file's stored name to be exactly `pause.json` (a case-insensitive file system
//     would otherwise open `Pause.json` as `pause.json`).
// The reader's other checks (a plain file, owned by this user, not group- or world-writable, not dated in the
// future, not longer than the cap, parses) defend against OTHER users and against a stale or hand-edited file,
// not against the agent: a planted file buys nothing it could not get from an approval, and fails closed.
// `resume` is allowed for an agent: it only turns protection back on (see cli/commands/pause.ts).
//
// What a reader does with an active pause is each entry point's business; this file is the one place that decides
// whether there is one, so that fifteen call sites cannot disagree. A reader never deletes (the lower layers may
// be sandboxed read-only) and never throws.
import { lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { basename, dirname, join } from "node:path";
import { repoAegisHome } from "./paths.js";
import { safeDestination } from "./refusal.js";

export const PAUSE_FILE = "pause.json";
export const DEFAULT_PAUSE_MS = 60 * 60 * 1000;
/** The cap. A pause is for a deadline, not a standing off switch. */
export const MAX_PAUSE_MS = 8 * 60 * 60 * 1000;

export function pausePath(home: string = repoAegisHome()): string {
  return join(home, PAUSE_FILE);
}

export interface PauseState {
  version: 1;
  /** ISO timestamps. */
  createdAt: string;
  expiresAt: string;
  /** The OS user that wrote it, for the audit trail. */
  by: string;
  /** `owner/repo`, lower-cased, when the pause is scoped to one repository; absent means everything on this machine. */
  repo?: string;
  /** How long the person's reason was. The text itself is never stored. */
  reasonLength: number;
}

/** What {@link readPause} found. Only `active` is a pause. */
export type PauseRead =
  | { kind: "none" }
  /** A file is there but fails a check (owner, mode, type, size, date, shape): counts as no pause. */
  | { kind: "invalid" }
  /** A well-formed file whose time has passed. */
  | { kind: "expired"; state: PauseState }
  | { kind: "active"; state: PauseState };

export interface PauseReadOptions {
  /** The state file. Default: `<REPO_AEGIS_HOME>/pause.json`. */
  path?: string;
  /** The clock. Default: now. */
  now?: Date;
  /** The uid that must own the file. Default: this process's. Exists so a test can show a wrong owner is refused. */
  expectedUid?: number;
}

/** ISO-8601 date-time with a zone, as `Date.prototype.toISOString` emits it. */
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
/** How far ahead of the reader's clock a record's `createdAt` may be: a file from the future is not honoured. */
const CREATED_SKEW_MS = 5000;
const PAUSE_FILE_MAX_BYTES = 4096;
const MAX_REASON_LENGTH = 100_000;

function validState(v: unknown, now: Date): PauseState | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const a = v as Record<string, unknown>;
  if (a["version"] !== 1) return null;
  const { createdAt, expiresAt, by, repo, reasonLength } = a;
  if (typeof createdAt !== "string" || !ISO_TIMESTAMP.test(createdAt)) return null;
  if (typeof expiresAt !== "string" || !ISO_TIMESTAMP.test(expiresAt)) return null;
  const created = Date.parse(createdAt);
  const expires = Date.parse(expiresAt);
  if (!Number.isFinite(created) || !Number.isFinite(expires)) return null;
  // Dated ahead of this clock: a hand-made file meant to outlive the cap.
  if (created > now.getTime() + CREATED_SKEW_MS) return null;
  if (expires <= created) return null;
  // A hand-edited long-lived file is dropped, not honoured. One second of slack for rounding.
  if (expires - created > MAX_PAUSE_MS + 1000) return null;
  if (typeof by !== "string") return null;
  if (repo !== undefined) {
    if (typeof repo !== "string") return null;
    const parts = repo.split("/");
    if (parts.length !== 2) return null;
    const safe = safeDestination(parts[0]!, parts[1]!);
    // As stored: lower-case, a plausible GitHub name, never a wildcard.
    if (safe === null || safe.repo === "*" || `${safe.org}/${safe.repo}` !== repo) return null;
  }
  if (reasonLength !== undefined && (!Number.isInteger(reasonLength) || (reasonLength as number) < 0 || (reasonLength as number) > MAX_REASON_LENGTH)) {
    return null;
  }
  return {
    version: 1,
    createdAt,
    expiresAt,
    by,
    ...(typeof repo === "string" && { repo }),
    reasonLength: typeof reasonLength === "number" ? reasonLength : 0,
  };
}

/**
 * Read and validate the pause file. The one reader every entry point calls. Never throws, never deletes. Anything
 * that is not a well-formed pause owned by this user is `none` or `invalid`, both of which mean "no pause".
 */
export function readPause(opts: PauseReadOptions = {}): PauseRead {
  try {
    const path = opts.path ?? pausePath();
    const now = opts.now ?? new Date();
    let st;
    try {
      st = lstatSync(path);
    } catch {
      return { kind: "none" };
    }
    // lstat, not stat: a symlink to somewhere else is not the file a person wrote.
    if (!st.isFile() || st.size > PAUSE_FILE_MAX_BYTES) return { kind: "invalid" };
    // The name as stored, not as looked up: on a case-insensitive file system `Pause.json` answers to `pause.json`.
    if (!readdirSync(dirname(path)).includes(basename(path))) return { kind: "invalid" };
    if (process.platform !== "win32") {
      const uid = opts.expectedUid ?? process.getuid?.();
      if (uid !== undefined && st.uid !== uid) return { kind: "invalid" };
      // Group- or world-writable: someone other than the owner could have written it.
      if ((st.mode & 0o022) !== 0) return { kind: "invalid" };
    }
    const state = validState(JSON.parse(readFileSync(path, "utf8")) as unknown, now);
    if (state === null) return { kind: "invalid" };
    return Date.parse(state.expiresAt) > now.getTime() ? { kind: "active", state } : { kind: "expired", state };
  } catch {
    return { kind: "invalid" };
  }
}

/** The pause in force right now, or null. A pause that has expired, or fails any check, is null. */
export function readActivePause(opts: PauseReadOptions = {}): PauseState | null {
  const r = readPause(opts);
  return r.kind === "active" ? r.state : null;
}

/** `{org, repo}` pairs a command reaches, or null where a command has no (resolvable) destination. */
export type PauseDestination = { org: string; repo: string } | null | undefined;

/**
 * Whether `state` covers a command that reaches `destinations`. A machine-wide pause covers everything, including
 * a command with no destination. A repository-scoped one covers a command only when EVERY destination is named
 * and is that repository (case-insensitively): an unresolved destination, or an unsafe name, or no destination at
 * all, is out of scope, so a scoped pause never widens by guesswork.
 */
export function pauseCovers(state: PauseState, destinations: readonly PauseDestination[]): boolean {
  if (state.repo === undefined) return true;
  if (destinations.length === 0) return false;
  return destinations.every(d => {
    if (d === null || d === undefined) return false;
    const safe = safeDestination(d.org, d.repo);
    return safe !== null && safe.repo !== "*" && `${safe.org}/${safe.repo}` === state.repo;
  });
}

const pad = (n: number): string => String(n).padStart(2, "0");

/**
 * The one fixed notice line every entry point prints while a pause applies. Local time, HH:MM. A machine-wide pause
 * keeps the cross-org checks on (a push or a write across a trust boundary is a different mistake from a false
 * positive), and says so; a pause scoped to one repository lifts them for that repository.
 */
export function pauseNotice(state: PauseState): string {
  const at = new Date(state.expiresAt);
  const until = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
  return state.repo === undefined
    ? `repo-aegis: paused until ${until}, cross-org checks stay on (resume: repo-aegis resume)`
    : `repo-aegis: paused until ${until} (resume: repo-aegis resume)`;
}

function safeUser(): string {
  try {
    return userInfo().username;
  } catch {
    return "unknown";
  }
}

export interface MintPauseOptions {
  /** How long. The caller has already refused more than {@link MAX_PAUSE_MS}; this clamps again, so no caller can exceed it. */
  durationMs?: number;
  /** `owner/repo`, already validated and lower-cased by the caller (see {@link parsePauseRepo}). */
  repo?: string;
  reasonLength?: number;
  path?: string;
  now?: Date;
  by?: string;
}

/**
 * `owner/repo` → the lower-cased form the file stores, or null when it is not a plausible GitHub name or is a
 * wildcard. A pause is for one repository or for everything: `<owner>/*` and `*` are not scopes.
 */
export function parsePauseRepo(text: string): string | null {
  const parts = text.trim().replace(/\.git$/, "").split("/");
  if (parts.length !== 2) return null;
  const safe = safeDestination(parts[0]!, parts[1]!);
  if (safe === null || safe.repo === "*") return null;
  return `${safe.org}/${safe.repo}`;
}

/**
 * Write the pause, replacing any earlier one (a person may shorten or extend their own). Atomic, mode 0600.
 * Throws on an unwritable home: a person at a terminal must hear that the pause did not take effect.
 */
export function mintPause(opts: MintPauseOptions = {}): PauseState {
  const now = opts.now ?? new Date();
  const ms = Math.min(opts.durationMs ?? DEFAULT_PAUSE_MS, MAX_PAUSE_MS);
  const path = opts.path ?? pausePath();
  const state: PauseState = {
    version: 1,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ms).toISOString(),
    by: opts.by ?? safeUser(),
    ...(opts.repo !== undefined && { repo: opts.repo }),
    reasonLength: opts.reasonLength ?? 0,
  };
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, path);
  return state;
}

/** Remove the pause file. True when one was there. Never throws. */
export function clearPause(path: string = pausePath()): boolean {
  try {
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}
