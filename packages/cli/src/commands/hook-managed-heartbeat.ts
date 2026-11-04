// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// `repo-aegis hook managed-heartbeat` — the SessionStart hook of the managed
// drop-in (doc/plan-pin-enforcement-binary.md D8.12). Claude Code silently ignores
// every file drop-in when a server-managed policy or an MDM profile is present,
// so a drop-in that is installed correctly can still enforce nothing. Each
// session start that DOES load the drop-in records a timestamp here, and `doctor`
// (MANAGED_HOOKS_NOT_FIRING) compares it against the sessions it can see.
//
// Best-effort and always exit 0: a heartbeat is evidence, never a gate. (A
// SessionStart exit 2 is a notice and not a block either, P9.) The file lives in
// `state/`, which an agent can write, so it is evidence of a session start, not
// proof; a forged heartbeat only hides a problem the agent could not create.
import { mkdirSync, readSync, writeFileSync } from "node:fs";
import { statePath } from "@de-otio/repo-aegis-core";
import { managedHeartbeatPath } from "./managed-ledger.js";

/** Write `now` (ISO 8601) to `state/managed-hooks-seen`. Never throws. */
export function recordManagedHeartbeat(now: Date = new Date()): void {
  try {
    mkdirSync(statePath(), { recursive: true });
    writeFileSync(managedHeartbeatPath(), now.toISOString() + "\n");
  } catch {
    /* evidence only */
  }
}

/** Record the heartbeat, then drain stdin (the SessionStart payload) so Claude Code's write never meets a closed pipe. */
export function hookManagedHeartbeat(): void {
  recordManagedHeartbeat();
  try {
    const buf = Buffer.alloc(4096);
    // The payload is small; stop at EOF or after a bounded number of reads.
    for (let i = 0; i < 64 && readSync(0, buf, 0, buf.length, null) > 0; i++) {
      /* discard */
    }
  } catch {
    /* no stdin, or a closed one */
  }
}
