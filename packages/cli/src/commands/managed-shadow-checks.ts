// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// The two checks that say whether another managed source defeats the drop-in
// (doc/plan-pin-enforcement-binary.md D8.7): MANAGED_HOOKS_DISABLED and
// MANAGED_SOURCE_SHADOWED. Shared by `doctor` and by the install, which waits for
// both to pass before it removes repo-aegis's entries from the user's file (D8.5).
import type { DoctorCheck } from "./doctor-checks.js";
import type { ManagedPaths } from "./managed-dropin.js";
import type { ManagedEnv } from "./managed-privileged.js";

const MACOS_PROFILES_DIR = "/Library/Managed Preferences";

export function parseObject(text: string | null): Record<string, unknown> | null {
  if (text === null) return null;
  try {
    const v = JSON.parse(text) as unknown;
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * `MANAGED_HOOKS_DISABLED`: a managed file other than ours (`managed-settings.json`
 * or another drop-in) sets `disableAllHooks: true`. Settings merge across managed
 * sources, so one such file switches off every managed hook, ours included.
 */
export function hooksDisabledCheck(env: ManagedEnv, paths: ManagedPaths): DoctorCheck {
  const siblings = [`${paths.systemDir}/managed-settings.json`];
  for (const name of env.fs.readdir(paths.dropinDir) ?? []) {
    if (name.startsWith(".") || !name.endsWith(".json") || name === paths.file.slice(paths.file.lastIndexOf("/") + 1)) continue;
    siblings.push(`${paths.dropinDir}/${name}`);
  }
  const offenders = siblings.filter(f => parseObject(env.fs.read(f))?.["disableAllHooks"] === true);
  if (offenders.length === 0) {
    return { code: "MANAGED_HOOKS_DISABLED", ok: true, detail: "no other managed settings file sets disableAllHooks" };
  }
  return {
    code: "MANAGED_HOOKS_DISABLED",
    ok: false,
    detail: `${offenders.join(", ")} set(s) disableAllHooks: true, which switches off every managed hook, repo-aegis's included`,
    fix: "ask whoever manages that file to remove disableAllHooks; until then no repo-aegis hook runs in Claude Code",
  };
}

/**
 * `MANAGED_SOURCE_SHADOWED`: on macOS a `com.anthropic.claudecode` configuration
 * profile under `/Library/Managed Preferences/`. Claude Code's default
 * `first-wins` then uses that source and ignores managed files and drop-ins.
 * Server-managed settings (a Team or Enterprise sign-in) outrank files too but
 * cannot be seen from here; the heartbeat (`MANAGED_HOOKS_NOT_FIRING`) catches them.
 */
export function sourceShadowedCheck(env: ManagedEnv): DoctorCheck {
  const ok: DoctorCheck = { code: "MANAGED_SOURCE_SHADOWED", ok: true, detail: "no other managed source outranks the managed files" };
  if (env.platform !== "darwin") return ok;
  const found: string[] = [];
  for (const entry of env.fs.readdir(MACOS_PROFILES_DIR) ?? []) {
    const p = `${MACOS_PROFILES_DIR}/${entry}`;
    if (entry.startsWith("com.anthropic.claudecode")) found.push(p);
    else {
      for (const inner of env.fs.readdir(p) ?? []) if (inner.startsWith("com.anthropic.claudecode")) found.push(`${p}/${inner}`);
    }
  }
  if (found.length === 0) return ok;
  return {
    code: "MANAGED_SOURCE_SHADOWED",
    ok: false,
    detail:
      `${found.join(", ")} is a Claude Code configuration profile; by default (first-wins) Claude Code uses it and ignores ` +
      "the managed settings file and drop-ins, so the repo-aegis drop-in does not apply",
    fix: "have the profile's owner add the repo-aegis hooks to it, or set the managed-settings source precedence so files are merged; until then keep the user-settings entries",
  };
}

/** The two checks the migration (D8.5) waits for. */
export function managedShadowChecks(env: ManagedEnv, paths: ManagedPaths): DoctorCheck[] {
  return [hooksDisabledCheck(env, paths), sourceShadowedCheck(env)];
}
