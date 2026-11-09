// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// legacy-managed-remover: remove in 0.17
//
// 0.13 and earlier could write the Claude Code hooks into a root-owned managed-settings drop-in
// (`50-repo-aegis-<uid>.json`). That feature is gone. A machine that has the file still runs its hooks, so
// `doctor`, `install claude-md --uninstall` and `uninstall` find it and print the command that removes it.
// This module only DETECTS and PRINTS: removing the file needs root, and repo-aegis never runs `sudo`.
import { lstatSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { shellQuote, statePath, testSeamsEnabled } from "@de-otio/repo-aegis-core";
import { readIfExists } from "../fs-utils.js";
import type { DoctorCheck } from "./doctor-checks.js";

/**
 * Test seams, honoured only under the Node test runner. Under it, nothing is detected unless `systemDir` is given:
 * a developer machine that has a real legacy drop-in must not change what the suite sees.
 */
export interface LegacySeams {
  uid?: number;
  /** Stands in for `/Library/Application Support/ClaudeCode` or `/etc/claude-code`. */
  systemDir?: string;
}

export interface LegacyDropIn {
  /** The drop-in files that exist: this uid's, and the uid-less name an earlier build wrote. */
  files: string[];
  /** Directories repo-aegis created for it (from the old ledger), removable with `rmdir` once empty. */
  createdDirs: string[];
  /** The commands to run, one per line, in order. */
  commands: string[];
}

const LEDGER_FILE = "claude-md-managed.json";
const HEARTBEAT_FILE = "managed-hooks-seen";

/** Claude Code's managed-settings directory on `platform`, or null where it has none. */
export function legacySystemDir(platform: NodeJS.Platform): string | null {
  return platform === "darwin" ? "/Library/Application Support/ClaudeCode" : platform === "linux" ? "/etc/claude-code" : null;
}

function present(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/** Which of the two directories the old install created, per its ledger (booleans only; never a path from the ledger). */
function ledgerCreatedDirs(): { system: boolean; dropin: boolean } {
  try {
    const raw = readIfExists(join(statePath(), LEDGER_FILE));
    const v = raw === null ? null : (JSON.parse(raw) as { createdDirs?: { system?: unknown; dropin?: unknown } } | null);
    return { system: v?.createdDirs?.system === true, dropin: v?.createdDirs?.dropin === true };
  } catch {
    return { system: false, dropin: false };
  }
}

/**
 * The legacy drop-in on this machine, or null when there is none (or this platform never had one). The path
 * comes from the platform and uid only: the ledger is agent-writable and decides nothing but which empty
 * directories to mention.
 */
export function detectLegacyDropIn(seams: LegacySeams = {}): LegacyDropIn | null {
  const testing = testSeamsEnabled();
  const uid = (testing ? seams.uid : undefined) ?? process.getuid?.();
  const systemDir = testing ? (seams.systemDir ?? null) : legacySystemDir(process.platform);
  if (systemDir === null || uid === undefined || !Number.isInteger(uid) || uid < 0) return null;
  const dropinDir = `${systemDir}/managed-settings.d`;
  const files = [`${dropinDir}/50-repo-aegis-${uid}.json`, `${dropinDir}/50-repo-aegis.json`].filter(present);
  if (files.length === 0) return null;
  const created = ledgerCreatedDirs();
  const createdDirs = [...(created.dropin ? [dropinDir] : []), ...(created.system ? [systemDir] : [])];
  return {
    files,
    createdDirs,
    commands: [
      ...files.map(f => `sudo rm ${shellQuote(f)}`),
      ...(createdDirs.length > 0 ? [`sudo rmdir ${createdDirs.map(shellQuote).join(" ")}   # only succeeds if they are empty`] : []),
    ],
  };
}

/** The lines that tell a person what is left and how to remove it. */
export function legacyDropInLines(d: LegacyDropIn): string[] {
  return [
    `a legacy root-owned managed drop-in is still installed: ${d.files.join(", ")}`,
    "repo-aegis no longer writes or removes it (that needs root, and repo-aegis never runs sudo). To remove it, run this in your own terminal:",
    ...d.commands.map(c => `  ${c}`),
  ];
}

/**
 * `doctor` check: `MANAGED_LEGACY_PRESENT` (warn) while a legacy drop-in exists; null when there is none. A warning
 * and not a failure: its hooks still run and still protect, they are just no longer maintained.
 */
export function legacyManagedCheck(seams: LegacySeams = {}): DoctorCheck | null {
  const d = detectLegacyDropIn(seams);
  if (d === null) return null;
  return {
    code: "MANAGED_LEGACY_PRESENT",
    ok: false,
    severity: "warn",
    detail:
      `a root-owned managed drop-in from repo-aegis 0.13 or earlier is still installed (${d.files.join(", ")}); repo-aegis no longer writes, ` +
      "updates or checks it, so its hooks point at whatever node and CLI it was last pinned to",
    fix: `run \`repo-aegis install claude-md\` (writes the hooks to ~/.claude/settings.json), then remove the drop-in in your own terminal: ${d.commands.join("  ;  ")}`,
  };
}

/** The old ledger and heartbeat marker are plain files under the state directory: removable without root, once the drop-in is gone. */
export function clearLegacyState(): void {
  for (const f of [LEDGER_FILE, HEARTBEAT_FILE]) {
    try {
      unlinkSync(join(statePath(), f));
    } catch {
      /* absent, or not ours to worry about */
    }
  }
}
