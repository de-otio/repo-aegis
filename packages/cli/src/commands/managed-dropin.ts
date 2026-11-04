// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// The Claude Code managed-settings drop-in (doc/plan-pin-enforcement-binary.md D8):
// where it lives, what it holds, and the validator that decides whether a text is
// allowed to be written there as root. Pure: no file system, no process.
//
// Claude Code merges hook entries and `permissions` lists across every settings
// scope, and a user or project file cannot remove a managed hook. Everything
// repo-aegis registers therefore goes into one root-owned file that belongs to the
// machine; the user's own `settings.json` keeps only portable preferences.
import { createHash } from "node:crypto";
import { managedHookCommand, type EnforcementPin } from "@de-otio/repo-aegis-core";
import {
  BASH_HOOK_ARGS,
  BASH_HOOK_MATCHER,
  CHECK_WRITE_HOOK_ARGS,
  EGRESS_RECEIPT_HOOK_ARGS,
  FIRST_TOUCH_HOOK_ARGS,
  FIRST_TOUCH_HOOK_MATCHER,
  GUARD_EGRESS_HOOK_ARGS,
  HOOK_ARGS,
  HOOK_MATCHER,
  MANAGED_HEARTBEAT_HOOK_ARGS,
} from "./claude-hook-specs.js";

/** The file names a drop-in for `uid` uses, and the directories above it (D8.1). */
export interface ManagedPaths {
  /** `/Library/Application Support/ClaudeCode` or `/etc/claude-code`. */
  systemDir: string;
  /** `<systemDir>/managed-settings.d`. */
  dropinDir: string;
  /** `<dropinDir>/50-repo-aegis-<uid>.json`. */
  file: string;
  /** The hidden name the content is staged under; Claude Code ignores a name that starts with a dot. */
  tmp: string;
  /** The uid-less name an earlier build may have written; removed only if the ledger names it. */
  legacyFile: string;
}

/** The base name of the file, with no directory. */
export function dropinFileName(uid: string): string {
  return `50-repo-aegis-${uid}.json`;
}

export const LEGACY_DROPIN_FILE_NAME = "50-repo-aegis.json";

/**
 * Where the drop-in for `uid` goes on `platform`, or null when there is no managed
 * location (Windows, BSD, ...) or `uid` is not made of digits. Derived from these two
 * values ONLY: never from the ledger or the environment, which an agent can write.
 */
export function managedPaths(platform: NodeJS.Platform, uid: number | string): ManagedPaths | null {
  const id = String(uid);
  if (!/^[0-9]+$/.test(id)) return null;
  const systemDir =
    platform === "darwin" ? "/Library/Application Support/ClaudeCode" : platform === "linux" ? "/etc/claude-code" : null;
  if (systemDir === null) return null;
  const dropinDir = `${systemDir}/managed-settings.d`;
  return {
    systemDir,
    dropinDir,
    file: `${dropinDir}/${dropinFileName(id)}`,
    tmp: `${dropinDir}/.${dropinFileName(id)}.tmp`,
    legacyFile: `${dropinDir}/${LEGACY_DROPIN_FILE_NAME}`,
  };
}

/** What a drop-in is rendered from. */
export interface DropInSpec {
  pin: EnforcementPin;
  /** Digits only. */
  uid: string;
  /** The drop-in's own path: the hooks print `sudo rm '<file>'` when they block. */
  file: string;
  /** Include the SessionStart `first-touch` hook. */
  firstTouch: boolean;
  /** The `permissions.deny` rules (registry, approvals, hooks, shim, markers, pinned code). */
  denyRules: readonly string[];
}

export type DropInEvent = "PreToolUse" | "PostToolUse" | "SessionStart";

export interface DropInHook {
  event: DropInEvent;
  matcher: string;
  command: string;
}

const EVENTS: readonly DropInEvent[] = ["PreToolUse", "PostToolUse", "SessionStart"];

/** Every hook the drop-in registers, in file order, with its rendered command. */
export function dropInHookCommands(spec: DropInSpec): DropInHook[] {
  const cmd = (args: string): string => managedHookCommand(spec.pin, args, { uid: spec.uid, dropinPath: spec.file });
  return [
    { event: "PreToolUse", matcher: HOOK_MATCHER, command: cmd(CHECK_WRITE_HOOK_ARGS) },
    { event: "PreToolUse", matcher: BASH_HOOK_MATCHER, command: cmd(GUARD_EGRESS_HOOK_ARGS) },
    { event: "PostToolUse", matcher: HOOK_MATCHER, command: cmd(HOOK_ARGS) },
    { event: "PostToolUse", matcher: BASH_HOOK_MATCHER, command: cmd(BASH_HOOK_ARGS) },
    { event: "PostToolUse", matcher: BASH_HOOK_MATCHER, command: cmd(EGRESS_RECEIPT_HOOK_ARGS) },
    ...(spec.firstTouch ? [{ event: "SessionStart" as const, matcher: FIRST_TOUCH_HOOK_MATCHER, command: cmd(FIRST_TOUCH_HOOK_ARGS) }] : []),
    // D8.12: proof that Claude Code loads this file at all.
    { event: "SessionStart", matcher: FIRST_TOUCH_HOOK_MATCHER, command: cmd(MANAGED_HEARTBEAT_HOOK_ARGS) },
  ];
}

interface MatcherEntry {
  matcher: string;
  hooks: Array<{ type: "command"; command: string }>;
}

/** The drop-in as a value: hooks grouped by event and matcher in registration order. Throws if the pin or uid cannot be rendered. */
export function dropInValue(spec: DropInSpec): { hooks: Record<string, MatcherEntry[]>; permissions: { deny: string[] } } {
  const hooks: Record<string, MatcherEntry[]> = {};
  for (const { event, matcher, command } of dropInHookCommands(spec)) {
    const entries = (hooks[event] ??= []);
    let entry = entries.find(e => e.matcher === matcher);
    if (entry === undefined) entries.push((entry = { matcher, hooks: [] }));
    entry.hooks.push({ type: "command", command });
  }
  return { hooks, permissions: { deny: [...spec.denyRules] } };
}

/** The text written to the drop-in: two-space JSON and a trailing newline. */
export function renderDropIn(spec: DropInSpec): string {
  return JSON.stringify(dropInValue(spec), null, 2) + "\n";
}

export function digestOf(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** An allowed deny rule: `Edit(//<absolute path>)` with no newline or NUL (D6). */
const DENY_RULE = /^Edit\(\/\/[^\n\r\0]+\)$/;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function unexpectedKey(obj: Record<string, unknown>, allowed: readonly string[]): string | null {
  const bad = Object.keys(obj).find(k => !allowed.includes(k));
  return bad === undefined ? null : bad;
}

/**
 * P5: why `text` may not be written to the drop-in, or null when it may. The root
 * write must not be a way to set arbitrary managed policy (`env`, `apiKeyHelper`,
 * `permissions.allow`, `allowManagedHooksOnly`, ...), so a text is allowed only if
 * it parses to an object whose keys are `hooks` and `permissions.deny`, every hook
 * is `{type: "command", command}` with a command that `spec` renders EXACTLY for
 * that event and matcher, and every deny rule is `Edit(//<path>)`.
 */
export function validateDropIn(text: string, spec: DropInSpec): string | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    return `the drop-in is not valid JSON (${(err as Error).message})`;
  }
  if (!isPlainObject(value)) return "the drop-in is not a JSON object";
  const topBad = unexpectedKey(value, ["hooks", "permissions"]);
  if (topBad !== null) return `the drop-in has the key "${topBad}", which is not allowed: only "hooks" and "permissions.deny" are`;

  const permissions = value["permissions"];
  if (permissions !== undefined) {
    if (!isPlainObject(permissions)) return '"permissions" is not an object';
    const permBad = unexpectedKey(permissions, ["deny"]);
    if (permBad !== null) return `"permissions.${permBad}" is not allowed: only "permissions.deny" is`;
    const deny = permissions["deny"];
    if (deny !== undefined) {
      if (!Array.isArray(deny)) return '"permissions.deny" is not an array';
      for (const rule of deny) {
        if (typeof rule !== "string" || !DENY_RULE.test(rule)) {
          return `a permissions.deny rule is not of the form Edit(//<absolute path>) with no newline: ${JSON.stringify(rule)}`;
        }
      }
    }
  }

  const hooks = value["hooks"];
  if (hooks !== undefined) {
    if (!isPlainObject(hooks)) return '"hooks" is not an object';
    const expected = new Set(dropInHookCommands(spec).map(h => `${h.event}\0${h.matcher}\0${h.command}`));
    for (const [event, entries] of Object.entries(hooks)) {
      if (!(EVENTS as readonly string[]).includes(event)) return `the hook event "${event}" is not allowed`;
      if (!Array.isArray(entries)) return `hooks.${event} is not an array`;
      for (const entry of entries) {
        if (!isPlainObject(entry) || unexpectedKey(entry, ["matcher", "hooks"]) !== null || typeof entry["matcher"] !== "string") {
          return `a hooks.${event} entry is not { matcher, hooks }`;
        }
        if (!Array.isArray(entry["hooks"])) return `a hooks.${event} entry has no hooks array`;
        for (const h of entry["hooks"]) {
          if (!isPlainObject(h) || unexpectedKey(h, ["type", "command"]) !== null || h["type"] !== "command" || typeof h["command"] !== "string") {
            return `a hooks.${event} hook is not { type: "command", command }`;
          }
          if (!expected.has(`${event}\0${entry["matcher"]}\0${h["command"]}`)) {
            return `a hooks.${event} command for matcher "${entry["matcher"]}" is not one this install renders: ${h["command"].slice(0, 80)}`;
          }
        }
      }
    }
  }
  return null;
}

/**
 * A line diff of `before` to `after`, one string per line prefixed with two
 * spaces (kept), `- ` (removed) or `+ ` (added). Empty when the texts are equal.
 */
export function lineDiff(before: string, after: string): string[] {
  if (before === after) return [];
  const split = (t: string): string[] => (t === "" ? [] : t.replace(/\n$/, "").split("\n"));
  const a = split(before);
  const b = split(after);
  // Longest common subsequence table, filled from the end.
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push(`  ${a[i]}`);
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      out.push(`- ${a[i]}`);
      i++;
    } else {
      out.push(`+ ${b[j]}`);
      j++;
    }
  }
  for (; i < a.length; i++) out.push(`- ${a[i]}`);
  for (; j < b.length; j++) out.push(`+ ${b[j]}`);
  return out;
}
