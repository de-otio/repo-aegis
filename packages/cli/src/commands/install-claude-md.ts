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

Publishing commands — \`git push\`, \`gh pr|issue|release|repo|api\`,
\`npm publish\` — also pass through a PreToolUse egress guard that judges
*where* the bytes are going, not just what they are. A denial is
decision-only: the command is never rewritten for you. Re-issue it
explicitly — \`git push <remote> <branch>\`, \`git -C <abs-path>\`,
\`gh --repo <org>/<repo>\`, and payload files (\`--body-file\`) written to
the session scratchpad and passed by absolute path. Never work around a
denial, and never set \`REPO_AEGIS_EGRESS_HUMAN\`: it is the human's
declaration that a person is present, and an agent setting it is the
agent approving its own publish. After a command that published, read the
\`PUBLISHED → …\` receipt in the tool result and stop if the destination
named there is not the one you intended.
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
 * PreToolUse hook command for cross-org write refusal. Same matcher
 * as `HOOK_COMMAND` (Write|Edit|MultiEdit) but a different event
 * (PreToolUse), so a non-zero exit blocks the tool *before* it runs.
 * Added in v0.3.0 to make the cross-org-write refusal genuine
 * prevention rather than post-write detection.
 */
const CHECK_WRITE_HOOK_COMMAND = "repo-aegis hook check-write";

/**
 * SessionStart hook command — Phase 1 onboarding. Calls
 * `firstTouchClassify` and emits the result as JSON. Same naming
 * stability rule as `HOOK_COMMAND` above.
 */
const FIRST_TOUCH_HOOK_COMMAND = "repo-aegis hook first-touch";

const FIRST_TOUCH_HOOK_MATCHER = "*";

/**
 * PostToolUse hook command for Bash output scanning. Invoked with a
 * `Bash` matcher entry, distinct from the file-write matcher. Same
 * naming-stability rule as the other hook commands.
 */
const BASH_HOOK_COMMAND = "repo-aegis hook scan-bash-output";

const BASH_HOOK_MATCHER = "Bash";

/**
 * PreToolUse(Bash) egress guard — doc/design/egress-guard.md §4. Judges
 * the *destination* of a publishing command before the shell runs it, which
 * is the axis every content-based control in this tool is blind to. The
 * `--agent claude` flag is explicit rather than defaulted so the registered
 * command reads the same as the Codex / Gemini snippets in
 * doc/agent-install.md, where the flag is what selects the `ask` degradation.
 *
 * Same naming-stability rule as the other hook commands: changing this
 * string does not auto-update anyone's settings.json.
 */
const GUARD_EGRESS_HOOK_COMMAND = "repo-aegis hook guard-egress --agent claude";

/**
 * PostToolUse(Bash) receipt — doc/design/egress-guard.md §5. Shares the
 * `Bash` matcher entry with `scan-bash-output`; both hooks run on the same
 * tool result and neither replaces the other.
 */
const EGRESS_RECEIPT_HOOK_COMMAND = "repo-aegis hook egress-receipt";

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
  return mergePostToolUseHook(settings, HOOK_MATCHER, hookCommand);
}

/**
 * Generalised hook merger keyed on (event, matcher, command).
 * Idempotent. Used for the PostToolUse Write/Edit/MultiEdit hook,
 * the PostToolUse Bash hook, and the v0.3.0 PreToolUse Write/Edit/
 * MultiEdit hook.
 */
function mergeHookOnEvent(
  settings: SettingsJson,
  event: "PreToolUse" | "PostToolUse",
  matcher: string,
  hookCommand: string,
): MergeResult {
  if (!settings.hooks) settings.hooks = {};
  if (!settings.hooks[event]) settings.hooks[event] = [];

  const entries = settings.hooks[event]!;

  let entry = entries.find(e => e.matcher === matcher);
  if (!entry) {
    entry = { matcher, hooks: [] };
    entries.push(entry);
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

function mergePostToolUseHook(
  settings: SettingsJson,
  matcher: string,
  hookCommand: string,
): MergeResult {
  return mergeHookOnEvent(settings, "PostToolUse", matcher, hookCommand);
}

function mergePreToolUseHook(
  settings: SettingsJson,
  matcher: string,
  hookCommand: string,
): MergeResult {
  return mergeHookOnEvent(settings, "PreToolUse", matcher, hookCommand);
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
  const checkWriteMerge = mergePreToolUseHook(settings!, HOOK_MATCHER, CHECK_WRITE_HOOK_COMMAND);
  const bashMerge = mergePostToolUseHook(settings!, BASH_HOOK_MATCHER, BASH_HOOK_COMMAND);
  const guardEgressMerge = mergePreToolUseHook(settings!, BASH_HOOK_MATCHER, GUARD_EGRESS_HOOK_COMMAND);
  const egressReceiptMerge = mergePostToolUseHook(settings!, BASH_HOOK_MATCHER, EGRESS_RECEIPT_HOOK_COMMAND);
  const firstTouchMerge: MergeResult | null = opts.firstTouch
    ? mergeFirstTouchHook(settings!, FIRST_TOUCH_HOOK_COMMAND)
    : null;

  // Write if any hook was added.
  if (
    merge.added ||
    checkWriteMerge.added ||
    bashMerge.added ||
    guardEgressMerge.added ||
    egressReceiptMerge.added ||
    (firstTouchMerge && firstTouchMerge.added)
  ) {
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
        checkWriteHookAdded: checkWriteMerge.added,
        checkWriteHookAlreadyPresent: checkWriteMerge.alreadyPresent,
        bashHookAdded: bashMerge.added,
        bashHookAlreadyPresent: bashMerge.alreadyPresent,
        guardEgressHookAdded: guardEgressMerge.added,
        guardEgressHookAlreadyPresent: guardEgressMerge.alreadyPresent,
        egressReceiptHookAdded: egressReceiptMerge.added,
        egressReceiptHookAlreadyPresent: egressReceiptMerge.alreadyPresent,
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
      checkWriteHook: {
        hookCommand: CHECK_WRITE_HOOK_COMMAND,
        added: checkWriteMerge.added,
        alreadyPresent: checkWriteMerge.alreadyPresent,
      },
      bashHook: {
        hookCommand: BASH_HOOK_COMMAND,
        added: bashMerge.added,
        alreadyPresent: bashMerge.alreadyPresent,
      },
      guardEgressHook: {
        hookCommand: GUARD_EGRESS_HOOK_COMMAND,
        added: guardEgressMerge.added,
        alreadyPresent: guardEgressMerge.alreadyPresent,
      },
      egressReceiptHook: {
        hookCommand: EGRESS_RECEIPT_HOOK_COMMAND,
        added: egressReceiptMerge.added,
        alreadyPresent: egressReceiptMerge.alreadyPresent,
      },
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
  if (checkWriteMerge.added) emitText(`registered PreToolUse(Write|Edit|MultiEdit) hook in ${settingsPath}`);
  else emitText(`PreToolUse(Write|Edit|MultiEdit) hook already registered in ${settingsPath}`);
  emitText(`  command: ${CHECK_WRITE_HOOK_COMMAND}`);
  if (merge.added) emitText(`registered PostToolUse(Write|Edit|MultiEdit) hook in ${settingsPath}`);
  else emitText(`PostToolUse(Write|Edit|MultiEdit) hook already registered in ${settingsPath}`);
  emitText(`  command: ${HOOK_COMMAND}`);
  if (guardEgressMerge.added) emitText(`registered PreToolUse(Bash) hook in ${settingsPath}`);
  else emitText(`PreToolUse(Bash) hook already registered in ${settingsPath}`);
  emitText(`  command: ${GUARD_EGRESS_HOOK_COMMAND}`);
  if (bashMerge.added) emitText(`registered PostToolUse(Bash) hook in ${settingsPath}`);
  else emitText(`PostToolUse(Bash) hook already registered in ${settingsPath}`);
  emitText(`  command: ${BASH_HOOK_COMMAND}`);
  if (egressReceiptMerge.added) emitText(`registered PostToolUse(Bash) hook in ${settingsPath}`);
  else emitText(`PostToolUse(Bash) hook already registered in ${settingsPath}`);
  emitText(`  command: ${EGRESS_RECEIPT_HOOK_COMMAND}`);
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
  const checkWriteMerge = mergePreToolUseHook(settings, HOOK_MATCHER, CHECK_WRITE_HOOK_COMMAND);
  const bashMerge = mergePostToolUseHook(settings, BASH_HOOK_MATCHER, BASH_HOOK_COMMAND);
  const guardEgressMerge = mergePreToolUseHook(settings, BASH_HOOK_MATCHER, GUARD_EGRESS_HOOK_COMMAND);
  const egressReceiptMerge = mergePostToolUseHook(settings, BASH_HOOK_MATCHER, EGRESS_RECEIPT_HOOK_COMMAND);
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
      checkWriteHook: {
        hookCommand: CHECK_WRITE_HOOK_COMMAND,
        wouldAdd: checkWriteMerge.added,
        alreadyPresent: checkWriteMerge.alreadyPresent,
      },
      bashHook: {
        hookCommand: BASH_HOOK_COMMAND,
        wouldAdd: bashMerge.added,
        alreadyPresent: bashMerge.alreadyPresent,
      },
      guardEgressHook: {
        hookCommand: GUARD_EGRESS_HOOK_COMMAND,
        wouldAdd: guardEgressMerge.added,
        alreadyPresent: guardEgressMerge.alreadyPresent,
      },
      egressReceiptHook: {
        hookCommand: EGRESS_RECEIPT_HOOK_COMMAND,
        wouldAdd: egressReceiptMerge.added,
        alreadyPresent: egressReceiptMerge.alreadyPresent,
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
  emitText(`# Hook commands (to be registered in settings.json):`);
  emitText(`#   ${CHECK_WRITE_HOOK_COMMAND}    (PreToolUse: Write|Edit|MultiEdit)`);
  emitText(`#   ${GUARD_EGRESS_HOOK_COMMAND}    (PreToolUse: Bash)`);
  emitText(`#   ${HOOK_COMMAND}  (PostToolUse: Write|Edit|MultiEdit)`);
  emitText(`#   ${BASH_HOOK_COMMAND}  (PostToolUse: Bash)`);
  emitText(`#   ${EGRESS_RECEIPT_HOOK_COMMAND}  (PostToolUse: Bash)`);
  emitText("");
  emitText(`# Would-be settings.json at: ${settingsPath}`);
  if (
    merge.alreadyPresent &&
    checkWriteMerge.alreadyPresent &&
    bashMerge.alreadyPresent &&
    guardEgressMerge.alreadyPresent &&
    egressReceiptMerge.alreadyPresent
  ) {
    emitText("# (Pre/PostToolUse hooks already registered; settings.json unchanged)");
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
type HookKind =
  | "scan-after-write"
  | "first-touch"
  | "scan-bash-output"
  | "check-write"
  | "guard-egress"
  | "egress-receipt";

function isRepoAegisHookCommand(command: string, kind: HookKind): boolean {
  return command.includes("repo-aegis") && command.includes(kind);
}

interface SettingsCleanupResult {
  removed: number;
  scanRemoved: number;
  firstTouchRemoved: number;
  bashScanRemoved: number;
  checkWriteRemoved: number;
  guardEgressRemoved: number;
  egressReceiptRemoved: number;
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
  const result: SettingsCleanupResult = {
    removed: 0,
    scanRemoved: 0,
    firstTouchRemoved: 0,
    bashScanRemoved: 0,
    checkWriteRemoved: 0,
    guardEgressRemoved: 0,
    egressReceiptRemoved: 0,
  };
  if (!settings.hooks) return result;

  const filterEvent = (
    eventName: "PreToolUse" | "PostToolUse" | "SessionStart",
    kind: HookKind,
  ) => {
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
      else if (kind === "first-touch") result.firstTouchRemoved += removed;
      else if (kind === "scan-bash-output") result.bashScanRemoved += removed;
      else if (kind === "check-write") result.checkWriteRemoved += removed;
      else if (kind === "guard-egress") result.guardEgressRemoved += removed;
      else if (kind === "egress-receipt") result.egressReceiptRemoved += removed;
    }
    // Collapse any matcher entry whose hooks array is now empty.
    settings.hooks![eventName] = entries.filter(e => e.hooks && e.hooks.length > 0);
    if (settings.hooks![eventName]!.length === 0) {
      delete settings.hooks![eventName];
    }
  };

  filterEvent("PreToolUse", "check-write");
  filterEvent("PreToolUse", "guard-egress");
  filterEvent("PostToolUse", "scan-after-write");
  filterEvent("PostToolUse", "scan-bash-output");
  filterEvent("PostToolUse", "egress-receipt");
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
  let settingsResult: SettingsCleanupResult = {
    removed: 0,
    scanRemoved: 0,
    firstTouchRemoved: 0,
    bashScanRemoved: 0,
    checkWriteRemoved: 0,
    guardEgressRemoved: 0,
    egressReceiptRemoved: 0,
  };
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
        checkWriteHookEntriesRemoved: settingsResult.checkWriteRemoved,
        bashHookEntriesRemoved: settingsResult.bashScanRemoved,
        guardEgressHookEntriesRemoved: settingsResult.guardEgressRemoved,
        egressReceiptHookEntriesRemoved: settingsResult.egressReceiptRemoved,
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
        checkWriteHookEntriesRemoved: settingsResult.checkWriteRemoved,
        bashHookEntriesRemoved: settingsResult.bashScanRemoved,
        guardEgressHookEntriesRemoved: settingsResult.guardEgressRemoved,
        egressReceiptHookEntriesRemoved: settingsResult.egressReceiptRemoved,
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
        ` (PreToolUse: ${settingsResult.checkWriteRemoved + settingsResult.guardEgressRemoved},` +
        ` PostToolUse: ${
          settingsResult.scanRemoved + settingsResult.bashScanRemoved + settingsResult.egressReceiptRemoved
        },` +
        ` SessionStart: ${settingsResult.firstTouchRemoved})`,
    );
  }
}

// ---------------------------------------------------------------------------
// Egress guard (doc/design/egress-guard.md §4, §7)
// ---------------------------------------------------------------------------

/** The prefix a registered guard command must start with, whatever `--agent` follows it. */
const GUARD_EGRESS_COMMAND_PREFIX = "repo-aegis hook guard-egress";

/**
 * `doctor` check: `GUARD_HOOK_UNREGISTERED` when the Claude Code
 * `settings.json` under `claudeHome` has no `PreToolUse` entry with matcher
 * `Bash` whose command starts with `repo-aegis hook guard-egress`.
 *
 * This exists because the guard is invisible when it is absent. Every other
 * failure mode of the egress design announces itself — a denial is loud, a
 * receipt is loud — but an unregistered hook looks exactly like a session
 * where nothing needed guarding. That is the "hooks installed but not
 * running" failure in a new costume (doc/design/egress-guard.md §7).
 *
 * Best-effort by construction: a missing or unparseable settings.json is
 * reported as unregistered with the reason, never thrown. `doctor` must
 * survive a machine whose Claude Code config does not exist.
 */
export function checkGuardHook(claudeHome?: string): import("./doctor-checks.js").DoctorCheck[] {
  const home = claudeHome ?? defaultClaudeHome();
  const settingsPath = join(home, "settings.json");
  const unregistered = (detail: string): import("./doctor-checks.js").DoctorCheck[] => [
    {
      code: "GUARD_HOOK_UNREGISTERED",
      ok: false,
      detail,
      fix: "repo-aegis install claude-md",
    },
  ];

  let settings: SettingsJson;
  try {
    if (!existsSync(settingsPath)) {
      return unregistered(
        `no settings.json at ${settingsPath}, so the PreToolUse(Bash) egress guard is not registered`,
      );
    }
    settings = readSettings(settingsPath);
  } catch {
    return unregistered(
      `settings.json at ${settingsPath} could not be parsed, so the PreToolUse(Bash) egress guard cannot be confirmed`,
    );
  }

  const entries = settings.hooks?.["PreToolUse"] ?? [];
  const registered = entries.some(
    entry =>
      entry.matcher === BASH_HOOK_MATCHER &&
      (entry.hooks ?? []).some(
        h => typeof h.command === "string" && h.command.trim().startsWith(GUARD_EGRESS_COMMAND_PREFIX),
      ),
  );

  if (!registered) {
    return unregistered(
      `settings.json at ${settingsPath} has no PreToolUse(Bash) entry running \`${GUARD_EGRESS_COMMAND_PREFIX}\`, ` +
        `so publishing commands are not destination-checked before they run`,
    );
  }

  return [
    {
      code: "GUARD_HOOK_UNREGISTERED",
      ok: true,
      detail: `\`${GUARD_EGRESS_COMMAND_PREFIX}\` is registered as a PreToolUse(Bash) hook in ${settingsPath}`,
    },
  ];
}
