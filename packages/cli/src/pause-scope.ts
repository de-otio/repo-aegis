// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// The one question every entry point asks about the emergency pause (core/pause.ts): "is there a pause in force
// that covers THIS?". Each entry point's change is a small early branch around one of these two functions.
//
//   - `pauseCoveringWorkingRepo(cwd)`: for the entry points that act on a working copy (pre-commit, the write
//     hooks). A machine-wide pause covers it; a repository-scoped one covers it when the working repo's `origin`
//     is that repository (case-insensitively).
//   - `pauseCoveringDestinations(dests)`: for the entry points that act on a destination (pre-push, the egress
//     guard, the `gh` shim, the credential helper). Core's `pauseCovers` decides; an unresolved destination is out
//     of a scoped pause's reach.
//
// Both return null on ANY doubt (no pause, an invalid file, an unreadable origin, a throw): not knowing is never a
// reason to switch a check off.
import {
  getRemoteUrl,
  parseRemoteUrlResolved,
  pauseCovers,
  readActivePause,
  resolveDestinationOffline,
  type EgressIntent,
  type PauseDestination,
  type PauseReadOptions,
  type PauseState,
} from "@de-otio/repo-aegis-core";

/** The pause in force for a command that reaches `dests`, or null. */
export function pauseCoveringDestinations(dests: readonly PauseDestination[], opts: PauseReadOptions = {}): PauseState | null {
  try {
    const pause = readActivePause(opts);
    return pause !== null && pauseCovers(pause, dests) ? pause : null;
  } catch {
    return null;
  }
}

/** The pause in force for a working copy at `cwd`, or null. */
export function pauseCoveringWorkingRepo(cwd: string, opts: PauseReadOptions = {}): PauseState | null {
  try {
    const pause = readActivePause(opts);
    if (pause === null) return null;
    if (pause.repo === undefined) return pause;
    const url = getRemoteUrl(cwd);
    const origin = url === null ? null : parseRemoteUrlResolved(url);
    return pauseCovers(pause, [origin]) ? pause : null;
  } catch {
    return null;
  }
}

/**
 * The pause in force for a command line whose parsed egress intents are `intents` (the egress guard and the `gh`
 * shim). Each intent's destination is resolved offline, as the policy resolves it; an unresolved or ambiguous one
 * is out of a scoped pause's reach. A machine-wide pause needs no resolution at all.
 */
export function pauseCoveringIntents(intents: readonly EgressIntent[], cwd: string, opts: PauseReadOptions = {}): PauseState | null {
  try {
    const pause = readActivePause(opts);
    if (pause === null) return null;
    if (pause.repo === undefined) return pause;
    const dests: PauseDestination[] = intents.flatMap(intent => {
      const d = resolveDestinationOffline(intent, cwd);
      if (d === null || d.unresolved !== undefined || d.candidates !== undefined) return [null];
      return [d, ...(d.alsoTargets ?? [])].map(t => ({ org: t.org, repo: t.repo }));
    });
    return pauseCovers(pause, dests) ? pause : null;
  } catch {
    return null;
  }
}
