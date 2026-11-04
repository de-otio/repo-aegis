// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// `MANAGED_HOOKS_NOT_FIRING` (doc/plan-pin-enforcement-binary.md D8.12): is Claude
// Code actually loading the managed drop-in? Shared by `doctor` and by the install,
// which will not strip repo-aegis's entries from the user's settings file while this
// check fails (D8.5): the user file is then the only enforcement that works.
import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readIfExists } from "../fs-utils.js";
import type { DoctorCheck } from "./doctor-checks.js";
import { managedHeartbeatPath } from "./managed-ledger.js";

/**
 * How far before a session's first write a heartbeat may sit and still count for
 * it. SessionStart runs when the session opens; the transcript file appears with
 * the first message, which can be minutes later. Too small a margin would report
 * a healthy drop-in as not firing, and a false alarm costs more than a late catch.
 */
export const HEARTBEAT_MARGIN_MS = 10 * 60 * 1000;

/** What was found under `<claudeHome>/projects/`. */
export interface SessionScan {
  /** Creation time (ms) of each transcript whose file system reports one. */
  births: number[];
  /** How many `.jsonl` transcripts there are. */
  transcripts: number;
  /** Of those, how many have no creation time (a file system that reports 0). */
  unknownBirth: number;
}

/**
 * Read the sessions under `<claudeHome>/projects/<dir>/<id>.jsonl`: when each began
 * (the transcript's creation time). `birthOf` is a test seam for a file system that
 * has no creation time.
 */
export function scanSessions(claudeHome: string, birthOf: (path: string) => number = p => statSync(p).birthtimeMs): SessionScan {
  const scan: SessionScan = { births: [], transcripts: 0, unknownBirth: 0 };
  const projects = join(claudeHome, "projects");
  let dirs: string[];
  try {
    dirs = readdirSync(projects);
  } catch {
    return scan;
  }
  for (const d of dirs) {
    let files: string[];
    try {
      files = readdirSync(join(projects, d));
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith(".jsonl")) continue;
      try {
        const born = birthOf(join(projects, d, f));
        scan.transcripts++;
        // A filesystem without creation times reports 0: unknown, not "long ago".
        if (born > 0) scan.births.push(born);
        else scan.unknownBirth++;
      } catch {
        /* a transcript that vanished */
      }
    }
  }
  return scan;
}

/** When each Claude Code session under `<claudeHome>/projects/` began, in ms. */
export function sessionStartTimes(claudeHome: string): number[] {
  return scanSessions(claudeHome).births;
}

export interface HeartbeatContext {
  /** Default `~/.claude`; only its `projects/` is read, for the heartbeat comparison. */
  claudeHome?: string;
  /** Test seam: session start times in ms. */
  sessionBirths?: () => number[];
  /** Test seam: the whole scan, including transcripts whose creation time is unknown. */
  sessionScan?: () => SessionScan;
}

export function heartbeatCheck(ctx: HeartbeatContext, installedAt: string | null): DoctorCheck {
  const claudeHome = ctx.claudeHome ?? join(homedir(), ".claude");
  const scan: SessionScan =
    ctx.sessionScan !== undefined
      ? ctx.sessionScan()
      : ctx.sessionBirths !== undefined
        ? (() => {
            const b = ctx.sessionBirths();
            return { births: b, transcripts: b.length, unknownBirth: 0 };
          })()
        : scanSessions(claudeHome);
  const births = scan.births;
  const skip = (detail: string): DoctorCheck => ({ code: "MANAGED_HOOKS_NOT_FIRING", ok: true, skipped: true, detail });
  const installed = installedAt === null ? 0 : Date.parse(installedAt);
  const since = births.filter(b => b > (Number.isNaN(installed) ? 0 : installed));
  if (scan.transcripts === 0) return skip("no Claude Code session was found under the projects directory, so the heartbeat cannot be compared yet");
  if (births.length === 0) {
    return skip(
      `the file system reports no creation time for the ${scan.unknownBirth} Claude Code session file(s) under the projects directory, so the heartbeat cannot be compared against when a session started`,
    );
  }
  if (since.length === 0) return skip("no Claude Code session has started since the drop-in was installed, so the heartbeat cannot be compared yet");
  const newest = Math.max(...since);
  let heartbeat: number | null = null;
  try {
    const raw = readIfExists(managedHeartbeatPath());
    const t = raw === null ? NaN : Date.parse(raw.trim());
    heartbeat = Number.isNaN(t) ? null : t;
  } catch {
    heartbeat = null;
  }
  if (heartbeat !== null && newest <= heartbeat + HEARTBEAT_MARGIN_MS) {
    return { code: "MANAGED_HOOKS_NOT_FIRING", ok: true, detail: "Claude Code ran the drop-in's SessionStart heartbeat for the newest session" };
  }
  return {
    code: "MANAGED_HOOKS_NOT_FIRING",
    ok: false,
    detail:
      `a Claude Code session started at ${new Date(newest).toISOString()}, ` +
      (heartbeat === null ? "but the drop-in's SessionStart heartbeat has never been recorded" : `after the last heartbeat (${new Date(heartbeat).toISOString()})`) +
      ": Claude Code is not loading the managed drop-in. A server-managed policy (signing in to a Team or Enterprise organisation) or an MDM key makes it ignore every file drop-in, and nothing local shows that",
    fix:
      "in Claude Code run /status: it should list the managed source as (drop-ins) or (file + drop-ins). If not, have the owner of the server-managed or MDM policy add the repo-aegis hooks there, " +
      "or put them back in the user settings with `repo-aegis install claude-md --user-settings`",
  };
}
