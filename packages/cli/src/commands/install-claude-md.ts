// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { leakContextFlagPath, appendAuditRecord } from "@de-otio/repo-aegis-core";
import { emitJson, emitText, emitError, type OutputOptions } from "../format.js";

const CLAUDE_MD_BEGIN = "<!-- repo-aegis: managed block — do not edit between markers -->";
const CLAUDE_MD_END = "<!-- repo-aegis: end managed block -->";

const CLAUDE_MD_BLOCK = `${CLAUDE_MD_BEGIN}
## repo-aegis (data-leak prevention)

This machine is configured with [repo-aegis](https://github.com/de-otio/repo-aegis)
for engagement-scoped data-leak prevention. A PostToolUse hook scans
files written by Write/Edit/MultiEdit against this repo's scoped deny
set. If the agent receives a tool result with a marker hit, it must:

- Not echo the literal marker back to the user.
- Not retry the write with the marker still present.
- Surface the hit to the user, propose a redaction, and wait for confirmation.

If a marker is hit, run \`repo-aegis status\` (without \`--verbose\`) to
see the repo's class, allowed engagements, and deny-set summary.
${CLAUDE_MD_END}
`;

/**
 * The `command` value written into Claude Code `settings.json` for the
 * PostToolUse hook on Write/Edit/MultiEdit. References the `repo-aegis`
 * bin by name (PATH-resolved at hook time) instead of a generated bash
 * script under `~/.claude/hooks/`. Renaming or moving `claudeHome` no
 * longer breaks the hook, and `jq` is no longer required because the
 * subcommand parses stdin JSON natively.
 *
 * Keep this string stable across releases. If you change it, document a
 * migration path: the previous absolute-path `command` won't auto-update
 * in users' settings.json. `install claude-md` is idempotent on the
 * current value but will not strip a stale older one.
 */
const HOOK_COMMAND = "repo-aegis hook scan-after-write";

/**
 * SessionStart hook command — Phase 1 onboarding. Calls
 * `firstTouchClassify` and emits the result as JSON. Same naming
 * stability rule as `HOOK_COMMAND` above.
 */
const FIRST_TOUCH_HOOK_COMMAND = "repo-aegis hook first-touch";

const FIRST_TOUCH_HOOK_MATCHER = "*";

interface InstallClaudeMdOptions extends OutputOptions {
  claudeHome?: string;
  /**
   * When true, do the work but suppress all stdout/stderr emission.
   * emitError still fires on hard failure. Used by `init`.
   */
  silent?: boolean;
  /**
   * When true, perform the merge in-memory and print the would-be
   * settings.json plus the would-be CLAUDE.md additions to stdout
   * instead of writing anything to disk. Useful for previewing the
   * effect of `install claude-md` before committing to it. Aliased
   * as --print-only on the CLI.
   */
  dryRun?: boolean;
  /**
   * Phase 1 onboarding: also register the SessionStart hook that
   * calls `repo-aegis hook first-touch`. Defaults to false on
   * standalone `install claude-md` (preserves existing-user opt-in);
   * `init` passes `firstTouch: true` so fresh installs get the JIT
   * classify wired up by default.
   */
  firstTouch?: boolean;
  /**
   * Reverse the install: strip the managed block from CLAUDE.md
   * (preserving the rest of the file) and remove every PostToolUse /
   * SessionStart hook entry whose `command` matches a repo-aegis
   * hook. Idempotent: re-running on an already-uninstalled state is
   * a no-op.
   */
  uninstall?: boolean;
}

interface SettingsJson {
  hooks?: Record<string, HookMatcherEntry[]>;
  [k: string]: unknown;
}

interface HookMatcherEntry {
  matcher?: string;
  hooks?: HookCommand[];
}

interface HookCommand {
  type?: string;
  command?: string;
}

const HOOK_MATCHER = "Write|Edit|MultiEdit";

function defaultClaudeHome(): string {
  return join(homedir(), ".claude");
}

function readSettings(path: string): SettingsJson {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, "utf8");
  if (raw.trim() === "") return {};
  try {
    return JSON.parse(raw) as SettingsJson;
  } catch (err) {
    throw new Error(`failed to parse ${path}: ${(err as Error).message}`);
  }
}

interface MergeResult {
  added: boolean;
  alreadyPresent: boolean;
}

function mergeHook(settings: SettingsJson, hookCommand: string): MergeResult {
  if (!settings.hooks) settings.hooks = {};
  if (!settings.hooks["PostToolUse"]) settings.hooks["PostToolUse"] = [];

  const post = settings.hooks["PostToolUse"]!;

  let entry = post.find(e => e.matcher === HOOK_MATCHER);
  if (!entry) {
    entry = { matcher: HOOK_MATCHER, hooks: [] };
    post.push(entry);
  }
  if (!entry.hooks) entry.hooks = [];

  const exists = entry.hooks.some(
    h => h.type === "command" && h.command === hookCommand,
  );
  if (exists) {
    return { added: false, alreadyPresent: true };
  }
  entry.hooks.push({ type: "command", command: hookCommand });
  return { added: true, alreadyPresent: false };
}

/**
 * Merge the SessionStart hook entry that calls
 * `repo-aegis hook first-touch`. Idempotent on the (matcher,
 * command) pair so `install claude-md --first-touch` re-runs are
 * safe.
 */
function mergeFirstTouchHook(
  settings: SettingsJson,
  hookCommand: string,
): MergeResult {
  if (!settings.hooks) settings.hooks = {};
  if (!settings.hooks["SessionStart"]) settings.hooks["SessionStart"] = [];

  const sess = settings.hooks["SessionStart"]!;

  let entry = sess.find(e => e.matcher === FIRST_TOUCH_HOOK_MATCHER);
  if (!entry) {
    entry = { matcher: FIRST_TOUCH_HOOK_MATCHER, hooks: [] };
    sess.push(entry);
  }
  if (!entry.hooks) entry.hooks = [];

  const exists = entry.hooks.some(
    h => h.type === "command" && h.command === hookCommand,
  );
  if (exists) {
    return { added: false, alreadyPresent: true };
  }
  entry.hooks.push({ type: "command", command: hookCommand });
  return { added: true, alreadyPresent: false };
}

export function installClaudeMd(opts: InstallClaudeMdOptions): void {
  const claudeHome = opts.claudeHome ?? defaultClaudeHome();
  const claudeMdPath = join(claudeHome, "CLAUDE.md");
  const settingsPath = join(claudeHome, "settings.json");

  if (opts.uninstall) {
    uninstallClaudeMd({ claudeHome, claudeMdPath, settingsPath, opts });
    return;
  }

  if (opts.dryRun) {
    dryRunInstallClaudeMd({ claudeHome, claudeMdPath, settingsPath, opts });
    return;
  }

  try {
    mkdirSync(claudeHome, { recursive: true });
  } catch (err) {
    emitError(
      { code: "FS_ERROR", error: `failed to create ${claudeHome}: ${(err as Error).message}` },
      opts,
    );
  }

  // 1. CLAUDE.md snippet (idempotent via marker comment)
  let claudeMdAppended = false;
  let claudeMdAlreadyPresent = false;
  let existingClaudeMd = "";
  if (existsSync(claudeMdPath)) existingClaudeMd = readFileSync(claudeMdPath, "utf8");

  if (existingClaudeMd.includes(CLAUDE_MD_BEGIN)) {
    claudeMdAlreadyPresent = true;
  } else {
    const needsLeadingNewline =
      existingClaudeMd.length > 0 && !existingClaudeMd.endsWith("\n");
    const prefix = existingClaudeMd.length === 0 ? "" : (needsLeadingNewline ? "\n\n" : "\n");
    if (existsSync(claudeMdPath)) {
      appendFileSync(claudeMdPath, prefix + CLAUDE_MD_BLOCK);
    } else {
      writeFileSync(claudeMdPath, CLAUDE_MD_BLOCK);
    }
    claudeMdAppended = true;
  }

  // 2. Merge into settings.json. The `command` references the bin name
  // (`repo-aegis hook scan-after-write`) so the hook is PATH-resolved at
  // invocation time — moving claudeHome no longer breaks the hook, and
  // there is no separate shell script to keep in sync.
  let settings: SettingsJson;
  try {
    settings = readSettings(settingsPath);
  } catch (err) {
    emitError(
      { code: "SETTINGS_PARSE_ERROR", error: (err as Error).message },
      opts,
    );
  }
  const merge = mergeHook(settings!, HOOK_COMMAND);
  const firstTouchMerge: MergeResult | null = opts.firstTouch
    ? mergeFirstTouchHook(settings!, FIRST_TOUCH_HOOK_COMMAND)
    : null;

  // Write if either hook was added (or both).
  if (merge.added || (firstTouchMerge && firstTouchMerge.added)) {
    try {
      writeFileSync(settingsPath, JSON.stringify(settings!, null, 2) + "\n");
    } catch (err) {
      emitError(
        { code: "FS_ERROR", error: `failed to write ${settingsPath}: ${(err as Error).message}` },
        opts,
      );
    }
  }

  // 3. Warn if leak-context strict mode is off
  const flagPath = leakContextFlagPath();
  const strictModeOn = existsSync(flagPath);

  // Audit (best-effort). Records what changed (added vs already-present)
  // for both the CLAUDE.md snippet and the settings.json hook entry.
  try {
    appendAuditRecord({
      action: "install-claude-md",
      details: {
        claudeHome,
        claudeMdAppended,
        claudeMdAlreadyPresent,
        settingsAdded: merge.added,
        settingsAlreadyPresent: merge.alreadyPresent,
        ...(firstTouchMerge && {
          firstTouchAdded: firstTouchMerge.added,
          firstTouchAlreadyPresent: firstTouchMerge.alreadyPresent,
        }),
      },
    });
  } catch {
    /* audit log must not break user-facing ops */
  }

  if (opts.silent) return;

  if (opts.json) {
    emitJson({
      action: "install-claude-md",
      claudeHome,
      claudeMd: { path: claudeMdPath, appended: claudeMdAppended, alreadyPresent: claudeMdAlreadyPresent },
      hookCommand: HOOK_COMMAND,
      settings: { path: settingsPath, added: merge.added, alreadyPresent: merge.alreadyPresent },
      ...(firstTouchMerge && {
        firstTouch: {
          hookCommand: FIRST_TOUCH_HOOK_COMMAND,
          added: firstTouchMerge.added,
          alreadyPresent: firstTouchMerge.alreadyPresent,
        },
      }),
      strictModeOn,
    });
    return;
  }

  if (claudeMdAppended) emitText(`appended snippet to ${claudeMdPath}`);
  else emitText(`snippet already present in ${claudeMdPath}`);
  if (merge.added) emitText(`registered PostToolUse hook in ${settingsPath}`);
  else emitText(`PostToolUse hook already registered in ${settingsPath}`);
  emitText(`  command: ${HOOK_COMMAND}`);
  if (firstTouchMerge) {
    if (firstTouchMerge.added) {
      emitText(`registered SessionStart hook in ${settingsPath}`);
    } else {
      emitText(`SessionStart hook already registered in ${settingsPath}`);
    }
    emitText(`  command: ${FIRST_TOUCH_HOOK_COMMAND}`);
  }
  if (!strictModeOn) {
    emitText("");
    emitText("note: leak-context strict mode is OFF.");
    emitText("  enable for sensitive sessions: repo-aegis context on");
  }
}

interface DryRunContext {
  claudeHome: string;
  claudeMdPath: string;
  settingsPath: string;
  opts: InstallClaudeMdOptions;
}

function dryRunInstallClaudeMd(ctx: DryRunContext): void {
  const { claudeHome, claudeMdPath, settingsPath, opts } = ctx;

  // 1. CLAUDE.md — compute would-be additions without writing.
  let existingClaudeMd = "";
  if (existsSync(claudeMdPath)) existingClaudeMd = readFileSync(claudeMdPath, "utf8");

  const claudeMdAlreadyPresent = existingClaudeMd.includes(CLAUDE_MD_BEGIN);
  let claudeMdAddition = "";
  if (!claudeMdAlreadyPresent) {
    const needsLeadingNewline =
      existingClaudeMd.length > 0 && !existingClaudeMd.endsWith("\n");
    const prefix =
      existingClaudeMd.length === 0 ? "" : (needsLeadingNewline ? "\n\n" : "\n");
    claudeMdAddition = prefix + CLAUDE_MD_BLOCK;
  }

  // 2. settings.json — compute the merged JSON in memory.
  let settings: SettingsJson;
  try {
    settings = readSettings(settingsPath);
  } catch (err) {
    emitError(
      { code: "SETTINGS_PARSE_ERROR", error: (err as Error).message },
      opts,
    );
    return;
  }
  // mergeHook mutates settings in place; that's fine here because
  // `settings` is a fresh object parsed inside this function and is
  // not persisted.
  const merge = mergeHook(settings, HOOK_COMMAND);
  const wouldBeSettings = JSON.stringify(settings, null, 2) + "\n";

  // 3. strict-mode flag (read-only check)
  const flagPath = leakContextFlagPath();
  const strictModeOn = existsSync(flagPath);

  if (opts.silent) return;

  if (opts.json) {
    emitJson({
      action: "install-claude-md",
      dryRun: true,
      claudeHome,
      claudeMd: {
        path: claudeMdPath,
        wouldAppend: !claudeMdAlreadyPresent,
        alreadyPresent: claudeMdAlreadyPresent,
        addition: claudeMdAddition,
      },
      hookCommand: HOOK_COMMAND,
      settings: {
        path: settingsPath,
        wouldAdd: merge.added,
        alreadyPresent: merge.alreadyPresent,
        contents: wouldBeSettings,
      },
      strictModeOn,
    });
    return;
  }

  emitText("# repo-aegis install claude-md (dry run — nothing written)");
  emitText("");
  emitText(`# Would-be CLAUDE.md additions to: ${claudeMdPath}`);
  if (claudeMdAlreadyPresent) {
    emitText("# (managed block already present; no addition)");
  } else if (claudeMdAddition === "") {
    emitText("# (no additions needed)");
  } else {
    emitText(claudeMdAddition);
  }
  emitText("");
  emitText(`# Hook command (to be registered in settings.json): ${HOOK_COMMAND}`);
  emitText("");
  emitText(`# Would-be settings.json at: ${settingsPath}`);
  if (merge.alreadyPresent) {
    emitText("# (PostToolUse hook already registered; settings.json unchanged)");
  }
  emitText(wouldBeSettings);
  if (!strictModeOn) {
    emitText("");
    emitText("# note: leak-context strict mode is OFF.");
    emitText("#   enable for sensitive sessions: repo-aegis context on");
  }
}

/**
 * String fragments that identify a repo-aegis hook command so we can
 * recognise both the canonical PATH-resolved form (`repo-aegis hook
 * scan-after-write`) and the legacy absolute-path-to-shell-script
 * form some users may still have. The match is intentionally
 * permissive: any command whose value contains `repo-aegis` AND
 * `scan-after-write` (or `first-touch`) is treated as ours.
 */
function isRepoAegisHookCommand(command: string, kind: "scan-after-write" | "first-touch"): boolean {
  return command.includes("repo-aegis") && command.includes(kind);
}

interface SettingsCleanupResult {
  removed: number;
  scanRemoved: number;
  firstTouchRemoved: number;
}

/**
 * Remove every repo-aegis-attributable hook entry from a parsed
 * settings.json shape. Mutates `settings` in place. Returns counts
 * for the report. Idempotent — re-running on an already-clean
 * settings is a no-op (counts all zero).
 *
 * Cleanup also collapses empty matcher entries (no hooks left) and
 * drops the `PostToolUse` / `SessionStart` keys when their arrays
 * become empty, so a "fresh" settings.json doesn't end up with
 * empty stub keys after uninstall.
 */
function stripHookEntries(settings: SettingsJson): SettingsCleanupResult {
  const result: SettingsCleanupResult = { removed: 0, scanRemoved: 0, firstTouchRemoved: 0 };
  if (!settings.hooks) return result;

  const filterEvent = (eventName: "PostToolUse" | "SessionStart", kind: "scan-after-write" | "first-touch") => {
    const entries = settings.hooks?.[eventName];
    if (!entries) return;
    for (const entry of entries) {
      if (!entry.hooks) continue;
      const before = entry.hooks.length;
      entry.hooks = entry.hooks.filter(
        h => !(h.type === "command" && typeof h.command === "string" && isRepoAegisHookCommand(h.command, kind)),
      );
      const removed = before - entry.hooks.length;
      result.removed += removed;
      if (kind === "scan-after-write") result.scanRemoved += removed;
      else result.firstTouchRemoved += removed;
    }
    // Collapse any matcher entry whose hooks array is now empty.
    settings.hooks![eventName] = entries.filter(e => e.hooks && e.hooks.length > 0);
    if (settings.hooks![eventName]!.length === 0) {
      delete settings.hooks![eventName];
    }
  };

  filterEvent("PostToolUse", "scan-after-write");
  filterEvent("SessionStart", "first-touch");

  if (Object.keys(settings.hooks).length === 0) {
    delete settings.hooks;
  }
  return result;
}

interface UninstallClaudeMdContext {
  claudeHome: string;
  claudeMdPath: string;
  settingsPath: string;
  opts: InstallClaudeMdOptions;
}

function uninstallClaudeMd(ctx: UninstallClaudeMdContext): void {
  const { claudeHome, claudeMdPath, settingsPath, opts } = ctx;

  // 1. Strip the managed block from CLAUDE.md (if present).
  let claudeMdStripped = false;
  let claudeMdAbsent = !existsSync(claudeMdPath);
  if (!claudeMdAbsent) {
    const body = readFileSync(claudeMdPath, "utf8");
    const beginIdx = body.indexOf(CLAUDE_MD_BEGIN);
    const endIdx = body.indexOf(CLAUDE_MD_END);
    if (beginIdx !== -1 && endIdx !== -1 && endIdx > beginIdx) {
      // Strip from the begin marker up to and including the end
      // marker line. Also collapse any leading blank line(s) that
      // installClaudeMd added as a separator.
      let cutStart = beginIdx;
      while (cutStart > 0 && body[cutStart - 1] === "\n") cutStart--;
      let cutEnd = endIdx + CLAUDE_MD_END.length;
      // Consume the trailing newline that sits right after the end marker.
      if (body[cutEnd] === "\n") cutEnd++;
      const next = body.slice(0, cutStart) + body.slice(cutEnd);
      writeFileSync(claudeMdPath, next);
      claudeMdStripped = true;
    }
  }

  // 2. Strip hook entries from settings.json (if present).
  let settingsResult: SettingsCleanupResult = { removed: 0, scanRemoved: 0, firstTouchRemoved: 0 };
  let settingsAbsent = !existsSync(settingsPath);
  if (!settingsAbsent) {
    let settings: SettingsJson;
    try {
      settings = readSettings(settingsPath);
    } catch (err) {
      emitError(
        { code: "SETTINGS_PARSE_ERROR", error: (err as Error).message },
        opts,
      );
    }
    settingsResult = stripHookEntries(settings!);
    if (settingsResult.removed > 0) {
      try {
        writeFileSync(settingsPath, JSON.stringify(settings!, null, 2) + "\n");
      } catch (err) {
        emitError(
          { code: "FS_ERROR", error: `failed to write ${settingsPath}: ${(err as Error).message}` },
          opts,
        );
      }
    }
  }

  // Audit (best-effort).
  try {
    appendAuditRecord({
      action: "uninstall-claude-md",
      details: {
        claudeHome,
        claudeMdStripped,
        claudeMdAbsent,
        hookEntriesRemoved: settingsResult.removed,
        scanHookEntriesRemoved: settingsResult.scanRemoved,
        firstTouchHookEntriesRemoved: settingsResult.firstTouchRemoved,
        settingsAbsent,
      },
    });
  } catch {
    /* audit log must not break user-facing ops */
  }

  if (opts.silent) return;

  if (opts.json) {
    emitJson({
      action: "uninstall-claude-md",
      claudeHome,
      claudeMd: { path: claudeMdPath, stripped: claudeMdStripped, absent: claudeMdAbsent },
      settings: {
        path: settingsPath,
        absent: settingsAbsent,
        hookEntriesRemoved: settingsResult.removed,
        scanHookEntriesRemoved: settingsResult.scanRemoved,
        firstTouchHookEntriesRemoved: settingsResult.firstTouchRemoved,
      },
    });
    return;
  }

  if (claudeMdAbsent) emitText(`${claudeMdPath} not present (nothing to strip)`);
  else if (claudeMdStripped) emitText(`stripped managed block from ${claudeMdPath}`);
  else emitText(`no managed block found in ${claudeMdPath}`);

  if (settingsAbsent) {
    emitText(`${settingsPath} not present (nothing to remove)`);
  } else if (settingsResult.removed === 0) {
    emitText(`no repo-aegis hook entries in ${settingsPath}`);
  } else {
    emitText(
      `removed ${settingsResult.removed} hook entr${settingsResult.removed === 1 ? "y" : "ies"} from ${settingsPath}` +
        ` (PostToolUse: ${settingsResult.scanRemoved}, SessionStart: ${settingsResult.firstTouchRemoved})`,
    );
  }
}
