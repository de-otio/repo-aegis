// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// The managed drop-in's ledger (doc/plan-pin-enforcement-binary.md D8.9):
// `state/claude-md-managed.json`. It records the digest of what was written and
// WHICH of the two directories repo-aegis created, so uninstall removes an empty
// directory only if it made it. It lives in `state/`, which an agent can write, so
// uninstall never takes a PATH from it: the drop-in path is derived from the
// platform and uid, and the ledger holds booleans, not paths.
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { statePath } from "@de-otio/repo-aegis-core";
import { readIfExists } from "../fs-utils.js";

export const MANAGED_LEDGER_FILE = "claude-md-managed.json";
export const MANAGED_HEARTBEAT_FILE = "managed-hooks-seen";

export interface ManagedLedger {
  version: 1;
  uid: string;
  /** For people reading it; never used to decide what to delete. */
  file: string;
  /** Digest of the text written to the drop-in. */
  digest: string;
  /** When the install ran (ISO 8601). `doctor` compares session starts against it. */
  installedAt: string;
  /** Directories repo-aegis created (and so may remove, when empty, on uninstall). */
  createdDirs: { system: boolean; dropin: boolean };
  /** An earlier build's uid-less file name is also ours: remove it on uninstall. */
  legacyFile: boolean;
}

export function managedLedgerPath(): string {
  return join(statePath(), MANAGED_LEDGER_FILE);
}

export function managedHeartbeatPath(): string {
  return join(statePath(), MANAGED_HEARTBEAT_FILE);
}

/** The ledger, or null when absent or not shaped like one. */
export function readManagedLedger(): ManagedLedger | null {
  let raw: string | null;
  try {
    raw = readIfExists(managedLedgerPath());
  } catch {
    return null;
  }
  if (raw === null) return null;
  try {
    const v = JSON.parse(raw) as Partial<ManagedLedger> | null;
    if (v === null || typeof v !== "object") return null;
    if (v.version !== 1 || typeof v.uid !== "string" || !/^[0-9]+$/.test(v.uid)) return null;
    if (typeof v.digest !== "string" || typeof v.installedAt !== "string") return null;
    const dirs = v.createdDirs;
    if (dirs === undefined || typeof dirs !== "object" || dirs === null) return null;
    return {
      version: 1,
      uid: v.uid,
      file: typeof v.file === "string" ? v.file : "",
      digest: v.digest,
      installedAt: v.installedAt,
      createdDirs: { system: dirs.system === true, dropin: dirs.dropin === true },
      legacyFile: v.legacyFile === true,
    };
  } catch {
    return null;
  }
}

/** Throws on a write failure: the ledger is written BEFORE the privileged write, and a failure stops the install. */
export function writeManagedLedger(ledger: ManagedLedger): void {
  mkdirSync(statePath(), { recursive: true });
  writeFileSync(managedLedgerPath(), JSON.stringify(ledger, null, 2) + "\n");
}

/** Remove the ledger; true if it existed. Called only after a verified removal. */
export function removeManagedLedger(): boolean {
  try {
    unlinkSync(managedLedgerPath());
    return true;
  } catch {
    return false;
  }
}
