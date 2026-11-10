// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// `doctor`'s checks for the managed-settings drop-in
// (doc/plan-pin-enforcement-binary.md D8.7, D8.11, D8.12). Pure readers over an
// injected file system view: nothing is executed except, in one check, the
// injected `sudo -n -k true` probe.
import { homedir } from "node:os";
import { join } from "node:path";
import {
  isManagedHookCommand,
  isPinnedHookCommand,
  shellUnquote,
  type EnforcementPin,
} from "@de-otio/repo-aegis-core";
import { currentEnforcementPin } from "../enforcement-pin.js";
import type { DoctorCheck } from "./doctor-checks.js";
import { unusable } from "./doctor-pin-checks.js";
import { readSettingsFile, registryDenyPlan, type SettingsJson } from "./install-claude-md.js";
import { managedPaths, renderDropIn } from "./managed-dropin.js";
import { managedShadowChecks, parseObject } from "./managed-shadow-checks.js";
import { readManagedLedger } from "./managed-ledger.js";
import { heartbeatCheck, HEARTBEAT_MARGIN_MS, sessionStartTimes, type HeartbeatContext } from "./managed-heartbeat-check.js";
import { privilegedTools, rootFileProblem, sudoEnvironment, verifyDirectoryChain, verifyPrivilegedTools, type ManagedEnv } from "./managed-privileged.js";

// ---------------------------------------------------------------------------
// The drop-in itself
// ---------------------------------------------------------------------------

/** The drop-in for this uid, parsed, or null when absent or not a JSON object. */
export function readDropInSettings(env: ManagedEnv): SettingsJson | null {
  const paths = managedPaths(env.platform, env.uid);
  return paths === null ? null : (parseObject(env.fs.read(paths.file)) as SettingsJson | null);
}

const OTHER_OR_GROUP_WRITE = 0o022;
const octal = (mode: number): string => (mode & 0o7777).toString(8).padStart(4, "0");

// Re-exported: these lived here before the install needed the heartbeat check too.
export { HEARTBEAT_MARGIN_MS, sessionStartTimes };

export interface ManagedDoctorContext extends HeartbeatContext {
  env: ManagedEnv;
  /** The pin THIS install would write; test seam. */
  pin?: EnforcementPin;
}

/** The (node, cli) pairs the hook commands of a drop-in text are pinned to. */
function pinsIn(text: string): EnforcementPin[] {
  return pinsInSettings(parseObject(text) as SettingsJson | null);
}

/** The (node, cli) pairs the hook commands of a parsed settings object (drop-in or `settings.json`) are pinned to. */
export function pinsInSettings(settings: SettingsJson | null): EnforcementPin[] {
  const out: EnforcementPin[] = [];
  const re = /; then exec ('(?:[^']|'\\'')*') ('(?:[^']|'\\'')*') hook /;
  for (const entries of Object.values(settings?.hooks ?? {})) {
    for (const entry of entries ?? []) {
      for (const h of entry.hooks ?? []) {
        const m = typeof h.command === "string" ? re.exec(h.command) : null;
        if (m === null) continue;
        const node = shellUnquote(m[1]!);
        const cli = shellUnquote(m[2]!);
        if (node !== null && cli !== null && !out.some(p => p.node === node && p.cli === cli)) out.push({ node, cli });
      }
    }
  }
  return out;
}

const removeLine = (file: string): string => `sudo rm '${file.replace(/'/g, `'\\''`)}'`;

/**
 * Every drop-in check of D8.7, D8.11 and D8.12, plus `SUDO_NOPASSWD`. Empty when
 * this platform has no managed location, or when there is neither a drop-in nor a
 * ledger entry: a machine without the drop-in is reported by the older checks
 * (GUARD_HOOK_UNREGISTERED, ENFORCEMENT_UNPINNED), not by a dozen passing lines.
 */
export function managedDropinChecks(ctx: ManagedDoctorContext): DoctorCheck[] {
  const { env } = ctx;
  const paths = managedPaths(env.platform, env.uid);
  if (paths === null) return [];
  const fileStat = env.fs.lstat(paths.file);
  const ledger = readManagedLedger();
  if (fileStat === null && ledger === null) return [];

  const pin = ctx.pin ?? currentEnforcementPin();
  const current = fileStat === null ? null : env.fs.read(paths.file);
  const checks: DoctorCheck[] = [];
  const installFix = "repo-aegis install claude-md";

  // MANAGED_DROPIN_STALE
  {
    let detail: string | null = null;
    if (current !== null) {
      try {
        const expected = renderDropIn({
          pin,
          uid: String(env.uid),
          file: paths.file,
          firstTouch: current.includes(" hook first-touch"),
          denyRules: registryDenyPlan(pin).rules,
        });
        if (expected !== current) detail = `${paths.file} differs from what \`repo-aegis install claude-md\` would write now (a moved or upgraded Node or repo-aegis, a new release, or an edit)`;
      } catch (err) {
        detail = `could not render the drop-in for comparison: ${(err as Error).message}`;
      }
    }
    checks.push(
      detail === null
        ? { code: "MANAGED_DROPIN_STALE", ok: true, detail: current === null ? "no drop-in file to compare" : "the drop-in is what would be written now" }
        : // WARN: the drop-in still applies; it is out of date relative to what would be written now.
          { code: "MANAGED_DROPIN_STALE", ok: false, severity: "warn", detail, fix: installFix },
    );
  }

  // MANAGED_DROPIN_NOT_ROOT_OWNED
  {
    const problems: string[] = [];
    if (fileStat !== null) {
      if (fileStat.isSymlink) problems.push(`${paths.file} is a symlink`);
      else if (fileStat.uid !== 0) problems.push(`${paths.file} is owned by uid ${fileStat.uid}, not root`);
      else if ((fileStat.mode & OTHER_OR_GROUP_WRITE) !== 0) problems.push(`${paths.file} is writable by group or others (mode ${octal(fileStat.mode)})`);
      const chain = verifyDirectoryChain(env, paths);
      if (chain !== null) problems.push(chain);
    }
    checks.push(
      problems.length === 0
        ? { code: "MANAGED_DROPIN_NOT_ROOT_OWNED", ok: true, detail: "the drop-in and every directory above it are root-owned and not writable by group or others" }
        : {
            code: "MANAGED_DROPIN_NOT_ROOT_OWNED",
            ok: false,
            // WARN: the drop-in applies and nothing is refused; the weakness is who can edit it
            // (the same standing as SUDO_NOPASSWD and ENFORCEMENT_IN_USER_SETTINGS).
            severity: "warn",
            detail: `${problems.join("; ")}: a user who can write there can change what enforces`,
            fix: `${removeLine(paths.file)}, fix the ownership or mode, then ${installFix}`,
          },
    );
  }

  // MANAGED_DROPIN_UNREADABLE
  {
    const problems: string[] = [];
    if (fileStat !== null && !fileStat.isSymlink && (fileStat.mode & 0o7777) !== 0o644) problems.push(`${paths.file} has mode ${octal(fileStat.mode)}, expected 0644`);
    for (const dir of [paths.dropinDir, paths.systemDir]) {
      const st = env.fs.lstat(dir);
      if (st !== null && !st.isSymlink && (st.mode & 0o7777) !== 0o755) problems.push(`${dir} has mode ${octal(st.mode)}, expected 0755`);
    }
    checks.push(
      problems.length === 0
        ? { code: "MANAGED_DROPIN_UNREADABLE", ok: true, detail: "the drop-in is 0644 and its directories 0755" }
        : {
            code: "MANAGED_DROPIN_UNREADABLE",
            ok: false,
            detail: `${problems.join("; ")}: Claude Code starts without a managed source it cannot read, so no repo-aegis hook runs`,
            fix: installFix,
          },
    );
  }

  // MANAGED_DROPIN_ORPHANED (D8.11)
  {
    const reasons: string[] = [];
    let pinGone = false;
    if (current !== null) {
      if (ledger === null) reasons.push("the ledger has no entry for it");
      const gone = new Set<string>();
      for (const p of pinsIn(current)) {
        if (unusable(p.node, "exec")) gone.add(p.node);
        if (unusable(p.cli, "read")) gone.add(p.cli);
      }
      pinGone = gone.size > 0;
      if (pinGone) reasons.push(`its pin points at missing files (${[...gone].join(", ")}), so every hook blocks (exit 2)`);
    }
    checks.push(
      reasons.length === 0
        ? { code: "MANAGED_DROPIN_ORPHANED", ok: true, detail: "the drop-in has a ledger entry and its pin exists" }
        : {
            code: "MANAGED_DROPIN_ORPHANED",
            ok: false,
            // FAIL only when a hook is refused today (the pin points at missing files); a missing ledger entry is bookkeeping.
            ...(pinGone ? {} : { severity: "warn" as const }),
            detail: `${paths.file} exists, but ${reasons.join(" and ")}`,
            fix: `${installFix}   (re-pins and records it)   or remove it: ${removeLine(paths.file)}`,
          },
    );
  }

  // MANAGED_DROPIN_LEDGER_STALE (D8.11)
  checks.push(
    ledger !== null && fileStat === null
      ? {
          code: "MANAGED_DROPIN_LEDGER_STALE",
          ok: false,
          // WARN: bookkeeping only. A drop-in that is really gone is GUARD_HOOK_UNREGISTERED's FAIL.
          severity: "warn",
          detail: `the ledger records a drop-in at ${paths.file}, but there is no such file (removed by hand?)`,
          fix: "repo-aegis install claude-md --uninstall   (clears the record), or `repo-aegis install claude-md` to write it again",
        }
      : { code: "MANAGED_DROPIN_LEDGER_STALE", ok: true, detail: "the ledger and the drop-in agree" },
  );

  // MANAGED_HOOKS_DISABLED, MANAGED_SOURCE_SHADOWED (D8.7)
  checks.push(...managedShadowChecks(env, paths));

  // MANAGED_HOOKS_NOT_FIRING (D8.12)
  checks.push(heartbeatCheck(ctx, ledger?.installedAt ?? null));

  // SUDO_NOPASSWD (D8.7, P7)
  checks.push(sudoNopasswdCheck(env, fileStat !== null));
  return checks;
}

function sudoNopasswdCheck(env: ManagedEnv, installed: boolean): DoctorCheck {
  const ok = (detail: string, skipped = false): DoctorCheck => ({ code: "SUDO_NOPASSWD", ok: true, ...(skipped && { skipped: true }), detail });
  if (!installed) return ok("no drop-in installed, so nothing to protect with a sudo password", true);
  const sudoProblem = verifyPrivilegedTools(env).find(p => p.tool === "sudo");
  if (sudoProblem !== undefined) return ok(`sudo was not probed: ${sudoProblem.path}: ${sudoProblem.reason}`, true);
  // The probe runs this file as root: it gets the same P1 test as every other tool.
  const trueProblem = rootFileProblem(env, "/usr/bin/true");
  if (trueProblem !== null) {
    return ok(
      trueProblem.missing ? "sudo was not probed: /usr/bin/true is missing" : `sudo was not probed: /usr/bin/true: ${trueProblem.reason}`,
      true,
    );
  }
  const r = env.spawn(privilegedTools(env.platform).sudo, ["-n", "-k", "/usr/bin/true"], {
    env: sudoEnvironment(env.processEnv),
    shell: false,
    // sudo's "a password is required" is the passing outcome; shown, it reads as an error.
    quiet: true,
  });
  if (r.status !== 0) return ok("sudo asks for a password");
  return {
    code: "SUDO_NOPASSWD",
    ok: false,
    severity: "warn",
    detail:
      "sudo runs commands without a password here (NOPASSWD, as on CI runners and many dev boxes), so an agent with a fake terminal can remove or rewrite the drop-in end to end: " +
      "the managed drop-in is no stronger than the user settings file on this machine",
    fix: "require a password for sudo (remove NOPASSWD for this account in sudoers) if agents run here; otherwise accept that the guarantee is the user file's",
  };
}

// ---------------------------------------------------------------------------
// The user's settings file (D8.6)
// ---------------------------------------------------------------------------

/**
 * `ENFORCEMENT_IN_USER_SETTINGS` (warn): repo-aegis's hooks are in the user's
 * settings.json, pinned (D7) or by name. That file then holds machine-specific
 * paths and must stay per machine; the drop-in does not have that constraint.
 * Null when there are none.
 */
export function userSettingsEnforcementCheck(claudeHome?: string): DoctorCheck | null {
  const settings = readSettingsFile(join(claudeHome ?? join(homedir(), ".claude"), "settings.json"));
  if (settings === null) return null;
  const names = new Set<string>();
  for (const entries of Object.values(settings.hooks ?? {})) {
    for (const entry of entries ?? []) {
      for (const h of entry.hooks ?? []) {
        const command = typeof h.command === "string" ? h.command.trim() : "";
        const byName = /^repo-aegis hook ([a-z-]+)/.exec(command);
        if (byName !== null) {
          names.add(byName[1]!);
          continue;
        }
        const m = / hook ([a-z-]+)/.exec(command);
        if (m !== null && (isPinnedHookCommand(command, m[1]!) || isManagedHookCommand(command, m[1]!))) names.add(m[1]!);
      }
    }
  }
  if (names.size === 0) return null;
  return {
    code: "ENFORCEMENT_IN_USER_SETTINGS",
    ok: false,
    severity: "warn",
    detail:
      `repo-aegis's Claude Code hook(s) ${[...names].sort().join(", ")} are in the user settings file, which holds machine-specific absolute paths: ` +
      "it must stay per machine (not synced or symlinked from a shared repository), and the agent's own user can edit it",
    fix: "repo-aegis install claude-md   (moves them into the root-owned managed drop-in; use --user-settings only where there is no sudo, such as a container)",
  };
}
