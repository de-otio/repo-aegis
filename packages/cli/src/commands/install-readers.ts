// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// Can every other repo-aegis on this machine READ the schema version a mutator is about to write?
//
// A build that predates schemaVersion 3 refuses a v3 registry. What that does depends on which entry
// point it is: rule h refuses every non-interactive egress, and an older pinned `hook check-write`
// FAILS OPEN (it exits 1, which Claude Code treats as non-blocking). So every path that RAISES the
// version (the first `identity add`, the first `set-identity`) checks the installs first.
//
// The question asked of each install is "can it read this version", answered without running it: the
// `MAX_SUPPORTED_REGISTRY_SCHEMA_VERSION` constant in the core package it loads. Only when that cannot
// be read is the package version compared with the running one, and an install whose version cannot be
// read either is refused (it cannot be shown to be able to read the file).
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { MAX_SUPPORTED_REGISTRY_SCHEMA_VERSION, repoAegisHome } from "@de-otio/repo-aegis-core";
import { readSettingsFile, defaultClaudeHome } from "./install-claude-md.js";
import { pinsInSettings, readDropInSettings } from "./doctor-managed-checks.js";
import { resolveManagedEnv, type ManagedEnv } from "./managed-privileged.js";
import {
  canonical,
  pinnedCliPaths,
  repoAegisOnPath,
  runningInstallVersion,
  versionIsOlder,
} from "./doctor-pin-checks.js";
import { versionOf } from "../enforcement-pin.js";

export interface InstallGuardOptions {
  /** TEST-ONLY seam: the PATH searched (default `process.env.PATH`). */
  pathEnv?: string;
  /** TEST-ONLY seam: the repo-aegis home whose hooks and shim pins are read (default: the real one). */
  home?: string;
  /** TEST-ONLY seam: the running version used by the fallback comparison. */
  runningVersion?: string;
  /** TEST-ONLY seam: the Claude Code home whose `settings.json` is read (default `~/.claude`). */
  claudeHome?: string;
  /** TEST-ONLY seam: the managed-settings environment whose drop-in is read (default: the real one). */
  managedEnv?: ManagedEnv;
}

/**
 * The CLIs the Claude Code hooks are pinned to: the managed drop-in's and `settings.json`'s commands. This is
 * the pin that runs `hook check-write`, the one that fails OPEN on a version it cannot read. Best-effort: a
 * missing or unparseable file has no pins.
 */
function claudeHookCliPaths(opts: InstallGuardOptions): string[] {
  const out: string[] = [];
  try {
    out.push(...pinsInSettings(readDropInSettings(opts.managedEnv ?? resolveManagedEnv())).map(p => p.cli));
  } catch {
    /* no drop-in, or unreadable */
  }
  try {
    out.push(...pinsInSettings(readSettingsFile(join(opts.claudeHome ?? defaultClaudeHome(), "settings.json"))).map(p => p.cli));
  } catch {
    /* no settings file, or unreadable */
  }
  return out;
}

/** The `MAX_SUPPORTED_REGISTRY_SCHEMA_VERSION` of the core package that `entry` loads, read as text; null if unreadable. */
export function maxSchemaVersionOf(entry: string): number | null {
  let dir = dirname(entry);
  for (let i = 0; i < 10; i++) {
    const candidate = join(dir, "node_modules", "@de-otio", "repo-aegis-core", "dist", "registry.js");
    if (existsSync(candidate)) {
      try {
        const m = /MAX_SUPPORTED_REGISTRY_SCHEMA_VERSION\s*=\s*(\d+)/.exec(readFileSync(candidate, "utf8"));
        return m === null ? null : Number.parseInt(m[1]!, 10);
      } catch {
        return null;
      }
    }
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

export interface UnreadingInstall {
  where: "PATH" | "pinned hook or shim" | "pinned Claude Code hook";
  path: string;
  version: string | null;
}

/** Installs (on PATH, and pinned by the installed hooks and shim) that cannot read `required`. */
export function installsUnableToRead(required: number, opts: InstallGuardOptions = {}): UnreadingInstall[] {
  const running = opts.runningVersion ?? runningInstallVersion();
  const candidates: Array<{ where: UnreadingInstall["where"]; path: string; real: string }> = [
    ...repoAegisOnPath(opts.pathEnv ?? process.env["PATH"]).map(f => ({ where: "PATH" as const, path: f.path, real: f.real })),
    ...pinnedCliPaths(opts.home ?? repoAegisHome()).map(p => ({ where: "pinned hook or shim" as const, path: p, real: canonical(p) })),
    ...claudeHookCliPaths(opts).map(p => ({ where: "pinned Claude Code hook" as const, path: p, real: canonical(p) })),
  ];
  const seen = new Set<string>();
  const bad: UnreadingInstall[] = [];
  for (const c of candidates) {
    const key = `${c.where}:${c.real}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const version = versionOf(c.real);
    const max = maxSchemaVersionOf(c.real);
    const reads =
      max !== null
        ? max >= required
        : version !== null && running !== null && !versionIsOlder(version, running) && required <= MAX_SUPPORTED_REGISTRY_SCHEMA_VERSION;
    if (!reads) bad.push({ where: c.where, path: c.path, version });
  }
  return bad;
}

/** The refusal text, shared by every mutator that raises the version. */
export function unreadableInstallsMessage(required: number, bad: readonly UnreadingInstall[]): string {
  return (
    `a repo-aegis that cannot read schemaVersion ${required} is installed: ` +
    `${bad.map(b => `${b.path} (${b.where}; version ${b.version ?? "unknown"})`).join("; ")}. ` +
    "Writing the registry as that version would leave it unreadable there: rule h would refuse every " +
    "non-interactive egress, and an older pinned `hook check-write` fails OPEN (exit 1 is non-blocking), " +
    "so the cross-org write check would stop protecting anything. Upgrade or remove it, " +
    "run `repo-aegis install hooks` and `repo-aegis install shim` so the pins follow, then retry."
  );
}
