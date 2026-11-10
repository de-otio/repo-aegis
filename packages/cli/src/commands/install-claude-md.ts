// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
import {
  existsSync,
  mkdirSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  leakContextFlagPath,
  appendAuditRecord,
  approvalsPath,
  decisionLogStatePath,
  pausePath,
  PROMPT_APPROVALS_DIR,
  denySetCachePath,
  destinationCachePath,
  markersDir,
  registryPath,
  repoAegisHome,
  statePath,
  isManagedHookCommand,
  isPinnedHookCommand,
  pinnedHookCommand,
  pinProblem,
  testSeamsEnabled,
  type EnforcementPin,
} from "@de-otio/repo-aegis-core";
import { emitJson, emitText, emitError, type OutputOptions } from "../format.js";
import { readIfExists } from "../fs-utils.js";
import { currentEnforcementPin } from "../enforcement-pin.js";
import { applyManagedInstall, chooseTarget, planManagedInstall, uninstallManaged, type ManagedSeams } from "./install-claude-md-managed.js";
import { managedShadowChecks } from "./managed-shadow-checks.js";
import { heartbeatCheck } from "./managed-heartbeat-check.js";
import { dropInHookCommands } from "./managed-dropin.js";
import { readManagedLedger } from "./managed-ledger.js";
import { isHumanTerminal } from "../require-terminal.js";
import type { DoctorCheck } from "./doctor-checks.js";
import {
  BASH_HOOK_ARGS,
  BASH_HOOK_MATCHER,
  CHECK_WRITE_HOOK_ARGS,
  EGRESS_RECEIPT_HOOK_ARGS,
  PROMPT_SUBMIT_HOOK_ARGS,
  PROMPT_SUBMIT_HOOK_MATCHER,
  FIRST_TOUCH_HOOK_ARGS,
  FIRST_TOUCH_HOOK_MATCHER,
  GUARD_EGRESS_HOOK_ARGS,
  HOOK_ARGS,
  HOOK_MATCHER,
} from "./claude-hook-specs.js";

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
agent approving its own publish. When a public destination or an
irreversible verb is refused for want of a person, ask the human to mint
an approval — \`repo-aegis approve <org>/<repo>\` from their terminal
(it refuses without a TTY, so you cannot) — then re-issue the same
command. After a command that published, read the \`PUBLISHED → …\`
receipt in the tool result and stop if the destination named there is
not the one you intended.

Run \`gh\` directly, never through a script or interpreter that runs it
for you (\`dot gh\`, below, is the one wrapper the guard reads): it cannot
judge any other shape and refuses it, reads included. If every tool
call is refused because the pinned enforcement binary is missing, stop
and ask the human to run \`repo-aegis install claude-md\` from their
terminal; do not edit \`settings.json\` or disable hooks.

- Writes through \`dot gh\` carry \`--as bot\` as the first option (\`dot gh --as bot pr create --repo <owner>/<repo> …\`); a write without it is refused (\`DOT_GH_WRITE_NEEDS_BOT\`).
${CLAUDE_MD_END}
`;

/**
 * The `command` written into settings.json for each hook, for `pin`
 * (doc/plan-pin-enforcement-binary.md D7). Not `repo-aegis hook …`: that name is
 * resolved on the agent's PATH, whose first entry on a real machine can be a
 * directory the agent can write, so a file named `repo-aegis` there would replace
 * the hook that judges every agent command. A pinned command runs the node and CLI
 * `install claude-md` ran under, by absolute path, and exits 2 (a blocking hook
 * error) if either is gone, where a missing command exits 127 (non-blocking: the
 * hook is silently skipped).
 */
function hookCommands(pin: EnforcementPin) {
  return {
    scanAfterWrite: pinnedHookCommand(pin, HOOK_ARGS),
    checkWrite: pinnedHookCommand(pin, CHECK_WRITE_HOOK_ARGS),
    firstTouch: pinnedHookCommand(pin, FIRST_TOUCH_HOOK_ARGS),
    scanBash: pinnedHookCommand(pin, BASH_HOOK_ARGS),
    guardEgress: pinnedHookCommand(pin, GUARD_EGRESS_HOOK_ARGS),
    egressReceipt: pinnedHookCommand(pin, EGRESS_RECEIPT_HOOK_ARGS),
    // Fails open: exit 2 on UserPromptSubmit would swallow the person's own message.
    promptSubmit: pinnedHookCommand(pin, PROMPT_SUBMIT_HOOK_ARGS, { failOpen: true }),
  };
}

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
  /** Test seam: the pin whose CLI package directory and Node executable are denied. Not reachable from the CLI. */
  pin?: EnforcementPin;
  /**
   * D8.6: write the hooks and deny rules to the user's `settings.json`, as D7 did,
   * instead of the root-owned managed drop-in. For containers and devcontainers
   * (no `sudo`) and unsupported platforms; doctor then warns
   * `ENFORCEMENT_IN_USER_SETTINGS`, because that file must stay per machine.
   */
  userSettings?: boolean;
  /** Test seam: platform, uid, file system root, the privileged runner and the terminal. Honoured only under the Node test runner. */
  managed?: ManagedSeams;
}

export interface SettingsJson {
  hooks?: Record<string, HookMatcherEntry[]>;
  permissions?: { deny?: unknown; [k: string]: unknown };
  [k: string]: unknown;
}

export interface HookMatcherEntry {
  matcher?: string;
  hooks?: HookCommand[];
}

export interface HookCommand {
  type?: string;
  command?: string;
}

export function defaultClaudeHome(): string {
  return join(homedir(), ".claude");
}

/** settings.json parsed, or null when it is absent or does not parse. For `doctor`, which never throws. */
export function readSettingsFile(path: string): SettingsJson | null {
  try {
    return existsSync(path) ? readSettings(path) : null;
  } catch {
    return null;
  }
}

function readSettings(path: string): SettingsJson {
  return parseSettings(readIfExists(path), path);
}

/** Parse settings.json text; null (absent) and blank both mean `{}`. */
function parseSettings(raw: string | null, path: string): SettingsJson {
  if (raw === null || raw.trim() === "") return {};
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
  return mergePostToolUseHook(settings, HOOK_MATCHER, hookCommand, "scan-after-write");
}

/**
 * Put `hookCommand` in `hooks`, in place of any other repo-aegis command for the
 * same hook (`kind`): an older by-name `repo-aegis hook …` entry, or one pinned to
 * an earlier node or CLI path. The first such entry is replaced where it stands and
 * the rest dropped, so a re-install neither duplicates nor leaves a by-name command
 * behind. Commands that are not recognisably repo-aegis's are never touched.
 */
function placeHookCommand(hooks: HookCommand[], hookCommand: string, kind: HookKind): MergeResult {
  const isOld = (h: HookCommand): boolean =>
    h.type === "command" && typeof h.command === "string" && h.command !== hookCommand && isRepoAegisHookCommand(h.command, kind);
  const exact = hooks.some(h => h.type === "command" && h.command === hookCommand);
  const firstOld = hooks.findIndex(isOld);
  if (firstOld === -1) {
    if (exact) return { added: false, alreadyPresent: true };
    hooks.push({ type: "command", command: hookCommand });
    return { added: true, alreadyPresent: false };
  }
  // Mutates `hooks` (a parsed settings.json array we own): replace, then drop the other old ones.
  if (!exact) hooks[firstOld] = { type: "command", command: hookCommand };
  for (let i = hooks.length - 1; i >= 0; i--) {
    if (isOld(hooks[i]!)) hooks.splice(i, 1);
  }
  return { added: true, alreadyPresent: false };
}

/**
 * Generalised hook merger keyed on (event, matcher, command).
 * Idempotent. Used for the PostToolUse Write/Edit/MultiEdit hook,
 * the PostToolUse Bash hook, and the v0.3.0 PreToolUse Write/Edit/
 * MultiEdit hook.
 */
function mergeHookOnEvent(
  settings: SettingsJson,
  event: "PreToolUse" | "PostToolUse" | "UserPromptSubmit",
  matcher: string,
  hookCommand: string,
  kind: HookKind,
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

  return placeHookCommand(entry.hooks, hookCommand, kind);
}

function mergePostToolUseHook(
  settings: SettingsJson,
  matcher: string,
  hookCommand: string,
  kind: HookKind,
): MergeResult {
  return mergeHookOnEvent(settings, "PostToolUse", matcher, hookCommand, kind);
}

function mergePromptSubmitHook(settings: SettingsJson, hookCommand: string): MergeResult {
  return mergeHookOnEvent(settings, "UserPromptSubmit", PROMPT_SUBMIT_HOOK_MATCHER, hookCommand, "prompt-submit");
}

function mergePreToolUseHook(
  settings: SettingsJson,
  matcher: string,
  hookCommand: string,
  kind: HookKind,
): MergeResult {
  return mergeHookOnEvent(settings, "PreToolUse", matcher, hookCommand, kind);
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

  return placeHookCommand(entry.hooks, hookCommand, "first-touch");
}

// ---------------------------------------------------------------------------
// Registry write protection (doc/plan-unregistered-owner-egress.md §8.2, R1)
//
// The registry file is on disk, and the agent's own file tools can change it
// without any TTY: appending one line to `engagements.yaml` registers an owner
// and undoes rule h. `install claude-md` therefore adds Claude Code
// `permissions.deny` entries, and `install claude-md --uninstall` removes
// exactly the ones it added.
//
// Only `Edit(...)` rules are written. Claude Code matches path rules for
// `Edit` and `Read` only: a `Write(path)` rule is accepted but never matched,
// and an Edit rule already covers every built-in editing tool. Claude Code also
// merges Edit deny rules into the sandbox's write-deny list, so they stop a
// sandboxed Bash write (`sed -i`, `>`) too; verify that on your machine with a
// sandboxed `touch` of a protected file (the install output says which).
//
// What is denied is deliberately narrow, because the sandbox enforces it on
// the agent's own Bash too: the files whose tampering bypasses the guard, and
// nothing the tools write at run time. Denied: the registry file and its `.age`
// ciphertext, the approvals store, `prompt-approvals/**` (a yes at the agent prompt, recorded by the hook), `hooks/**` (the git hook scripts), `bin/**`
// (the `gh` shim) and `markers/**` (the rendered deny set the write scan
// reads: editing it silently drops markers). NOT denied, on purpose: `state/`
// (audit log, lock, caches) and the rest of the home. Denying the whole
// directory broke audit appends, the state lock, cache writes, and an agent
// running `install hooks` or `install shim`. Denying `markers/**` means an
// agent-run `render` is refused inside the sandbox; a person runs it.
//
// The code the enforcement pin points at is denied too (doc/plan-pin-enforcement-
// binary.md D4): the hooks and the shim run the pinned Node executable and CLI
// by absolute path, so an agent that could overwrite them would own enforcement
// just as surely as one that could edit a hook. Denied: the pinned CLI's
// package directory and the pinned Node executable (a file rule). A package
// directory that is a git work tree (a development checkout) is not denied, for
// the reason `riskyDirReason` gives; the plan says so in a warning.
// ---------------------------------------------------------------------------

/** What `install claude-md` denies for the current registry location. */
export interface RegistryDenyPlan {
  /** The `permissions.deny` entries, in order. */
  rules: string[];
  /** A path under each rule, for checking that a settings.json rule covers it. */
  sampleTargets: string[];
  /** The path to `touch` from a sandboxed shell to verify the rule reaches the sandbox. */
  verifyPath: string;
  /** Things the operator should know: a relocated registry or home. */
  warnings: string[];
}

function canonicalDir(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/**
 * Why a directory is too broad or too shared to protect as a directory, or
 * null. The registry was moved there, and denying writes to the directory
 * would lock the user's own home or a repository's work tree.
 */
function riskyDirReason(dir: string): string | null {
  const c = canonicalDir(dir);
  if (c === "/") return "is the filesystem root";
  const homes = new Set<string>([canonicalDir(homedir())]);
  try {
    homes.add(canonicalDir(userInfo().homedir));
  } catch {
    /* no passwd entry */
  }
  if (homes.has(c)) return "is your home directory";
  for (let d = c; d !== dirname(d); d = dirname(d)) {
    if (existsSync(join(d, ".git"))) return "is inside a git work tree";
  }
  return null;
}

/**
 * The directory of the package that holds `cli`: the nearest directory above it
 * with a package.json, or `<package>/dist/index.js`'s grandparent when there is none.
 */
function pinnedPackageDir(cli: string): string {
  for (let d = dirname(cli), i = 0; i < 6; i++) {
    if (existsSync(join(d, "package.json"))) return d;
    const up = dirname(d);
    if (up === d) break;
    d = up;
  }
  return dirname(dirname(cli));
}

/** The deny rules for the registry, approvals, hooks, shim, markers, trusted state files and the pinned code at their current locations. */
export function registryDenyPlan(pin: EnforcementPin = currentEnforcementPin()): RegistryDenyPlan {
  const home = repoAegisHome();
  const registry = registryPath(home);
  // Files an enforcement path trusts. state/deny-set.cache.json is one of them:
  // it is keyed by a fingerprint an agent can compute, and a forged entry with
  // empty patterns switches the scanner off. Its write is best-effort, so a
  // denied write only costs a recompute. The ledger is trusted by uninstall.
  const files = [
    registry,
    `${registry}.age`,
    approvalsPath(home),
    // The emergency pause (P1-E): a file an agent that could write would switch repo-aegis off for itself.
    pausePath(home),
    // The decision log's on/off switch (P1-I): an agent that could write `{"enabled": false}` would remove the data its
    // own next refusal needs. `log --off` is person-only; this keeps the file out of the agent's write tools.
    decisionLogStatePath(home),
    // The log FILE has no Edit rule on purpose: a deny rule reaches the agent's sandboxed shell, where the hooks and the shim
    // run too, so they would log to the sandbox's own $TMPDIR, which the person's `repo-aegis log` does not read. Agent
    // tools are stopped by `check-write` and the shell-write rule instead (state-file-guard.ts, human-commands.ts).
    // Rules e-g read a cached entry's class and visibility to decide whether a
    // destination is public-facing: a forged "private" entry for a public repo
    // would skip rule g's person check. Every writer treats a failed write as a
    // cache miss (recordWorkingTree), so denying it costs nothing.
    destinationCachePath(home),
    denySetCachePath(home),
    join(statePath(home), DENY_LEDGER_FILE),
  ];
  const warnings: string[] = [];

  // hooks/, bin/ and markers/ are narrow subdirectories of the home, so they are
  // denied wherever the home is (even `$HOME` or a work tree): the risky-directory
  // test is for BROADER denies only. A markers directory moved OUT of the home is
  // a path of the operator's choosing and may itself be broad, so that one is tested.
  // prompt-approvals/ is where the agent hook records a person's yes at the host's prompt for the layers below it
  // to read: a record an agent wrote itself would be an approval it minted for itself.
  const dirs = [join(home, "hooks"), join(home, "bin"), join(home, PROMPT_APPROVALS_DIR)];
  const markers = markersDir(home);
  if (markers === home || markers.startsWith(home + "/")) {
    dirs.push(markers);
  } else {
    const markersRisk = riskyDirReason(markers);
    if (markersRisk !== null) warnings.push(`the markers directory (${markers}) ${markersRisk}: not denied`);
    else dirs.push(markers);
  }
  const regDir = dirname(registry);
  const regRisk = riskyDirReason(regDir);
  if (regRisk !== null && regDir !== home) {
    warnings.push(`the registry's directory (${regDir}) ${regRisk}: denying only the registry file itself, not its directory`);
  }

  // The code the pin points at (D4): the Node executable as a file rule, the CLI's
  // package directory as a directory rule unless it is too broad or shared to deny.
  const pinFiles = [pin.node];
  const pinDirs: string[] = [];
  const pkgDir = pinnedPackageDir(pin.cli);
  const pkgRisk = riskyDirReason(pkgDir);
  if (pkgRisk !== null) {
    warnings.push(
      `the pinned CLI's package directory (${pkgDir}) ${pkgRisk}: not denied, so an agent can edit the code the hooks and shim run`,
    );
  } else {
    pinDirs.push(pkgDir);
  }

  return {
    rules: [
      ...files.map(f => `Edit(/${f})`),
      ...dirs.map(d => `Edit(/${d}/**)`),
      ...pinFiles.map(f => `Edit(/${f})`),
      ...pinDirs.map(d => `Edit(/${d}/**)`),
    ],
    sampleTargets: [...files, ...dirs.map(d => join(d, "x")), ...pinFiles, ...pinDirs.map(d => join(d, "x"))],
    verifyPath: registry,
    warnings,
  };
}

/** The rules `registryDenyPlan` would add, as a list. */
export function registryDenyRules(pin?: EnforcementPin): string[] {
  return registryDenyPlan(pin).rules;
}

/**
 * The pair an earlier build wrote (never released): an Edit AND a Write rule
 * over the whole registry directory. They are removed on upgrade and on
 * uninstall only when BOTH are present, because one alone is indistinguishable
 * from a rule the user wrote themselves, and a user rule is never removed. The
 * whole-directory rule broke audit appends and caches, and a `Write(path)` rule
 * is never matched.
 */
function legacyDenyPair(list: readonly unknown[]): string[] {
  const dir = dirname(registryPath());
  const pair = [`Edit(/${dir}/**)`, `Write(/${dir}/**)`];
  return pair.every(r => list.includes(r)) ? pair : [];
}

/** Basenames/globs of the paths this install protects, for recognising its own rules. */
const OUR_RULE_SHAPE =
  /^Edit\(\/(\/.+)\/(?:engagements\.yaml(?:\.age)?|egress-approvals\.json|pause\.json|destinations\.json|state\/decision-log\.json|state\/deny-set\.cache\.json|state\/claude-md-deny-rules\.json|(?:hooks|bin|markers|prompt-approvals)\/\*\*)\)$/;

/** Shape of the rules `registryDenyPlan` writes for a pin: `<...>/@de-otio/repo-aegis/**`, or a file named `node`. */
const OUR_PIN_RULE_SHAPE = /^Edit\(\/\/(?:.+\/@de-otio\/repo-aegis\/\*\*|.+\/node)\)$/;

/**
 * Whether `rule` is one this install could have written: exactly a rule of the
 * current plan, or the shape of one (`Edit(//…)` over one of the protected
 * basenames) under the current repo-aegis home. The ledger lives in a directory
 * an agent can write, so uninstall removes a ledger entry only if it also has
 * our shape: a forged ledger cannot make uninstall delete the user's own rules.
 */
function isOurRuleShape(rule: string, plan: RegistryDenyPlan): boolean {
  if (plan.rules.includes(rule)) return true;
  // The pinned-code rules of a PREVIOUS pin (a Node or repo-aegis upgrade moves it): a package
  // directory named for this package, or a `node` file. Not under the repo-aegis home, so the
  // home test below does not apply.
  if (OUR_PIN_RULE_SHAPE.test(rule)) return true;
  const m = OUR_RULE_SHAPE.exec(rule);
  if (m === null) return false;
  const abs = "/" + m[1]!.replace(/^\/+/, "");
  const home = repoAegisHome();
  return abs === home || abs.startsWith(home + "/");
}

// The ledger: which deny rules THIS install added to which settings.json, so
// uninstall removes exactly those and never a rule the user already had. Lives
// under state/ (writable by design).
const DENY_LEDGER_FILE = "claude-md-deny-rules.json";

interface DenyLedger {
  version: 1;
  settings: Record<string, string[]>;
}

function ledgerPath(): string {
  return join(statePath(), DENY_LEDGER_FILE);
}

function readDenyLedger(): DenyLedger {
  const empty: DenyLedger = { version: 1, settings: {} };
  try {
    const raw = readIfExists(ledgerPath());
    if (raw === null) return empty;
    const parsed = JSON.parse(raw) as Partial<DenyLedger>;
    if (typeof parsed.settings !== "object" || parsed.settings === null) return empty;
    const settings: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(parsed.settings)) {
      if (Array.isArray(v)) settings[k] = v.filter((r): r is string => typeof r === "string");
    }
    return { version: 1, settings };
  } catch {
    return empty;
  }
}

/** Record (or, with an empty list, forget) the rules added to `settingsPath`. Throws on a write failure. */
function writeDenyLedger(settingsPath: string, rules: readonly string[]): void {
  const ledger = readDenyLedger();
  if (rules.length > 0) ledger.settings[settingsPath] = [...rules];
  else delete ledger.settings[settingsPath];
  if (Object.keys(ledger.settings).length === 0) {
    try {
      unlinkSync(ledgerPath());
    } catch {
      /* already absent */
    }
    return;
  }
  mkdirSync(statePath(), { recursive: true });
  writeFileSync(ledgerPath(), JSON.stringify(ledger, null, 2) + "\n");
}

interface DenyInstall {
  plan: RegistryDenyPlan;
  added: string[];
  alreadyPresent: string[];
  /** Whole-directory rules from an earlier build, removed during this install. */
  legacyRemoved: string[];
  /** What the ledger should hold for this settings.json afterwards. */
  recorded: string[];
  ledgerChanged: boolean;
}

function denyList(settings: SettingsJson): unknown[] {
  return Array.isArray(settings.permissions?.deny) ? (settings.permissions!.deny as unknown[]) : [];
}

function setDenyList(settings: SettingsJson, list: unknown[]): void {
  if (list.length > 0) {
    if (!settings.permissions || typeof settings.permissions !== "object") settings.permissions = {};
    settings.permissions.deny = list;
    return;
  }
  if (settings.permissions) {
    delete settings.permissions.deny;
    if (Object.keys(settings.permissions).length === 0) delete settings.permissions;
  }
}

/**
 * Add the plan's rules to the in-memory `settings` and compute the ledger. A
 * rule that is already in settings.json was the user's (or an earlier run's,
 * which the ledger remembers): it is reported as present and never newly
 * recorded, so uninstall cannot remove what the user had.
 */
function installDenyRules(settings: SettingsJson, settingsPath: string, pin?: EnforcementPin): DenyInstall {
  const plan = registryDenyPlan(pin);
  const prev = readDenyLedger().settings[settingsPath];
  let list = denyList(settings);

  // First run of this build over an older one: its broad pair goes (both rules
  // present, or neither is touched: one alone could be the user's own).
  const legacyRemoved: string[] = [];
  if (prev === undefined) {
    const legacy = legacyDenyPair(list);
    legacyRemoved.push(...legacy);
    if (legacy.length > 0) list = list.filter(r => !(typeof r === "string" && legacy.includes(r)));
  }

  const added: string[] = [];
  const alreadyPresent: string[] = [];
  for (const rule of plan.rules) {
    if (list.includes(rule)) alreadyPresent.push(rule);
    else {
      added.push(rule);
      list = [...list, rule];
    }
  }
  if (added.length > 0 || legacyRemoved.length > 0) setDenyList(settings, list);

  const recorded = [...(prev ?? []).filter(r => list.includes(r)), ...added];
  const unique = [...new Set(recorded)];
  const ledgerChanged = JSON.stringify(unique) !== JSON.stringify(prev ?? []);
  return { plan, added, alreadyPresent, legacyRemoved, recorded: unique, ledgerChanged };
}

/**
 * Remove from `settings` the rules the ledger says this install added (or, when
 * the ledger has no entry for this settings.json, the older build's forms).
 * Returns the removed count and whether a ledger entry existed.
 */
function stripDenyRules(
  settings: SettingsJson,
  settingsPath: string,
  pin?: EnforcementPin,
): { removed: number; hadRecord: boolean } {
  const record = readDenyLedger().settings[settingsPath];
  const list = denyList(settings);
  // A ledger entry that is not shaped like one of ours is ignored: the ledger is
  // agent-writable, and it must not be a way to delete the user's own rules.
  const plan = registryDenyPlan(pin);
  const rules = record !== undefined ? record.filter(r => isOurRuleShape(r, plan)) : legacyDenyPair(list);
  const kept = list.filter(r => !(typeof r === "string" && rules.includes(r)));
  const removed = list.length - kept.length;
  if (removed > 0) setDenyList(settings, kept);
  return { removed, hadRecord: record !== undefined };
}

/** The lines `install claude-md` prints about verifying and scoping the rules. */
function denyAdviceLines(plan: RegistryDenyPlan): string[] {
  return [
    ...plan.warnings.map(w => `warning: ${w}`),
    "Claude Code merges Edit deny rules into the sandbox's write-deny list (see its sandboxing docs), so they also stop sandboxed Bash writes.",
    `verify in a sandboxed Bash session: touch ${plan.verifyPath}   (it should fail with a permission error)`,
    "state/ (audit log, lock, caches) is deliberately not denied.",
  ];
}

/** Append the managed block to CLAUDE.md unless it is there (idempotent via the marker comment). */
function ensureClaudeMdSnippet(claudeMdPath: string): { appended: boolean; alreadyPresent: boolean } {
  const existingClaudeMd = readIfExists(claudeMdPath) ?? "";
  if (existingClaudeMd.includes(CLAUDE_MD_BEGIN)) return { appended: false, alreadyPresent: true };
  const needsLeadingNewline = existingClaudeMd.length > 0 && !existingClaudeMd.endsWith("\n");
  const prefix = existingClaudeMd.length === 0 ? "" : needsLeadingNewline ? "\n\n" : "\n";
  // Append mode creates a missing file; `prefix` is "" in that case.
  appendFileSync(claudeMdPath, prefix + CLAUDE_MD_BLOCK);
  return { appended: true, alreadyPresent: false };
}

export function installClaudeMd(opts: InstallClaudeMdOptions): void {
  const claudeHome = opts.claudeHome ?? defaultClaudeHome();
  const claudeMdPath = join(claudeHome, "CLAUDE.md");
  const settingsPath = join(claudeHome, "settings.json");

  if (opts.uninstall) {
    uninstallClaudeMd({ claudeHome, claudeMdPath, settingsPath, opts });
    return;
  }

  // The hook commands run THIS install's node and CLI by absolute path. Refuse before
  // anything is written when the pin cannot be quoted into a shell command.
  const pin = opts.pin ?? currentEnforcementPin();
  const pinIssue = pinProblem(pin);
  if (pinIssue !== null) {
    emitError(
      {
        code: "PIN_PATH_UNSUPPORTED",
        error: `cannot pin the enforcement binary: ${pinIssue}`,
        details: "install repo-aegis, and the Node it runs on, at a path without newline characters, then re-run `repo-aegis install claude-md`",
      },
      opts,
    );
  }
  const cmd = hookCommands(pin);

  // D8: the hooks and deny rules go in the root-owned managed drop-in, unless the
  // person asked for the user file (D8.6) or there is no managed location here.
  const target = chooseTarget(opts);
  if (target.kind === "managed") {
    installManagedMode({ claudeHome, claudeMdPath, opts, pin, target });
    return;
  }

  if (opts.dryRun) {
    dryRunInstallClaudeMd({ claudeHome, claudeMdPath, settingsPath, opts, pin, cmd, note: target.note });
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
  const { appended: claudeMdAppended, alreadyPresent: claudeMdAlreadyPresent } = ensureClaudeMdSnippet(claudeMdPath);

  // 2. Merge into settings.json. Each `command` runs the pinned node and CLI by
  // absolute path (see `hookCommands`) — moving claudeHome does not break the
  // hook, there is no separate shell script to keep in sync, and nothing on the
  // agent's PATH can stand in for the CLI.
  let settings: SettingsJson;
  try {
    settings = readSettings(settingsPath);
  } catch (err) {
    emitError(
      { code: "SETTINGS_PARSE_ERROR", error: (err as Error).message },
      opts,
    );
  }
  const merge = mergeHook(settings!, cmd.scanAfterWrite);
  const checkWriteMerge = mergePreToolUseHook(settings!, HOOK_MATCHER, cmd.checkWrite, "check-write");
  const bashMerge = mergePostToolUseHook(settings!, BASH_HOOK_MATCHER, cmd.scanBash, "scan-bash-output");
  const guardEgressMerge = mergePreToolUseHook(settings!, BASH_HOOK_MATCHER, cmd.guardEgress, "guard-egress");
  const egressReceiptMerge = mergePostToolUseHook(settings!, BASH_HOOK_MATCHER, cmd.egressReceipt, "egress-receipt");
  const promptSubmitMerge = mergePromptSubmitHook(settings!, cmd.promptSubmit);
  const firstTouchMerge: MergeResult | null = opts.firstTouch
    ? mergeFirstTouchHook(settings!, cmd.firstTouch)
    : null;
  const denyInstall = installDenyRules(settings!, settingsPath, pin);

  // The ledger first: if it cannot be written, uninstall could not tell our
  // rules from the user's, so no rule is added at all.
  if (denyInstall.ledgerChanged) {
    try {
      writeDenyLedger(settingsPath, denyInstall.recorded);
    } catch (err) {
      emitError(
        { code: "FS_ERROR", error: `failed to record the deny rules under ${statePath()}: ${(err as Error).message}` },
        opts,
      );
    }
  }

  // Write if any hook or deny rule was added (or an older build's rule removed).
  if (
    denyInstall.added.length > 0 ||
    denyInstall.legacyRemoved.length > 0 ||
    merge.added ||
    checkWriteMerge.added ||
    bashMerge.added ||
    guardEgressMerge.added ||
    egressReceiptMerge.added ||
    promptSubmitMerge.added ||
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
        promptSubmitHookAdded: promptSubmitMerge.added,
        promptSubmitHookAlreadyPresent: promptSubmitMerge.alreadyPresent,
        ...(firstTouchMerge && {
          firstTouchAdded: firstTouchMerge.added,
          firstTouchAlreadyPresent: firstTouchMerge.alreadyPresent,
        }),
        registryDenyRulesAdded: denyInstall.added.length,
        registryDenyRulesAlreadyPresent: denyInstall.alreadyPresent.length,
        registryDenyRulesLegacyRemoved: denyInstall.legacyRemoved.length,
      },
    });
  } catch {
    /* audit log must not break user-facing ops */
  }

  if (opts.silent) return;

  if (opts.json) {
    emitJson({
      action: "install-claude-md",
      mode: "user-settings",
      ...(target.note !== null && { note: target.note }),
      claudeHome,
      claudeMd: { path: claudeMdPath, appended: claudeMdAppended, alreadyPresent: claudeMdAlreadyPresent },
      hookCommand: cmd.scanAfterWrite,
      settings: { path: settingsPath, added: merge.added, alreadyPresent: merge.alreadyPresent },
      checkWriteHook: {
        hookCommand: cmd.checkWrite,
        added: checkWriteMerge.added,
        alreadyPresent: checkWriteMerge.alreadyPresent,
      },
      bashHook: {
        hookCommand: cmd.scanBash,
        added: bashMerge.added,
        alreadyPresent: bashMerge.alreadyPresent,
      },
      guardEgressHook: {
        hookCommand: cmd.guardEgress,
        added: guardEgressMerge.added,
        alreadyPresent: guardEgressMerge.alreadyPresent,
      },
      egressReceiptHook: {
        hookCommand: cmd.egressReceipt,
        added: egressReceiptMerge.added,
        alreadyPresent: egressReceiptMerge.alreadyPresent,
      },
      promptSubmitHook: {
        hookCommand: cmd.promptSubmit,
        added: promptSubmitMerge.added,
        alreadyPresent: promptSubmitMerge.alreadyPresent,
      },
      ...(firstTouchMerge && {
        firstTouch: {
          hookCommand: cmd.firstTouch,
          added: firstTouchMerge.added,
          alreadyPresent: firstTouchMerge.alreadyPresent,
        },
      }),
      registryDeny: {
        rules: denyInstall.plan.rules,
        added: denyInstall.added,
        alreadyPresent: denyInstall.alreadyPresent,
        legacyRemoved: denyInstall.legacyRemoved,
        warnings: denyInstall.plan.warnings,
        verifyWith: `touch ${denyInstall.plan.verifyPath}`,
      },
      strictModeOn,
    });
    return;
  }

  if (target.note !== null) emitText(`note: ${target.note}`);
  if (claudeMdAppended) emitText(`appended snippet to ${claudeMdPath}`);
  else emitText(`snippet already present in ${claudeMdPath}`);
  if (checkWriteMerge.added) emitText(`registered PreToolUse(Write|Edit|MultiEdit) hook in ${settingsPath}`);
  else emitText(`PreToolUse(Write|Edit|MultiEdit) hook already registered in ${settingsPath}`);
  emitText(`  command: ${cmd.checkWrite}`);
  if (merge.added) emitText(`registered PostToolUse(Write|Edit|MultiEdit) hook in ${settingsPath}`);
  else emitText(`PostToolUse(Write|Edit|MultiEdit) hook already registered in ${settingsPath}`);
  emitText(`  command: ${cmd.scanAfterWrite}`);
  if (guardEgressMerge.added) emitText(`registered PreToolUse(Bash) hook in ${settingsPath}`);
  else emitText(`PreToolUse(Bash) hook already registered in ${settingsPath}`);
  emitText(`  command: ${cmd.guardEgress}`);
  if (bashMerge.added) emitText(`registered PostToolUse(Bash) hook in ${settingsPath}`);
  else emitText(`PostToolUse(Bash) hook already registered in ${settingsPath}`);
  emitText(`  command: ${cmd.scanBash}`);
  if (egressReceiptMerge.added) emitText(`registered PostToolUse(Bash) hook in ${settingsPath}`);
  else emitText(`PostToolUse(Bash) hook already registered in ${settingsPath}`);
  emitText(`  command: ${cmd.egressReceipt}`);
  if (promptSubmitMerge.added) emitText(`registered UserPromptSubmit hook in ${settingsPath}`);
  else emitText(`UserPromptSubmit hook already registered in ${settingsPath}`);
  emitText(`  command: ${cmd.promptSubmit}`);
  if (firstTouchMerge) {
    if (firstTouchMerge.added) {
      emitText(`registered SessionStart hook in ${settingsPath}`);
    } else {
      emitText(`SessionStart hook already registered in ${settingsPath}`);
    }
    emitText(`  command: ${cmd.firstTouch}`);
  }
  emitText(
    denyInstall.added.length > 0
      ? `registered ${denyInstall.added.length} permissions.deny rule(s) protecting the registry, approvals, hooks and shim in ${settingsPath}`
      : `permissions.deny rules for the registry already registered in ${settingsPath}`,
  );
  if (denyInstall.legacyRemoved.length > 0) {
    emitText(`removed ${denyInstall.legacyRemoved.length} broader deny rule(s) written by an earlier build`);
  }
  for (const rule of denyInstall.plan.rules) emitText(`  rule: ${rule}`);
  for (const line of denyAdviceLines(denyInstall.plan)) emitText(`  ${line}`);
  if (!strictModeOn) {
    emitText("");
    emitText("note: leak-context strict mode is OFF.");
    emitText("  enable for sensitive sessions: repo-aegis context on");
  }
}

/**
 * JSON text for `value` laid out like `original`: its indent (tab or the first
 * indented line's spaces), compact if it was one line, and its trailing newline or
 * the lack of one. Used where a file is rewritten after removing OUR entries only,
 * so everything else in it keeps its bytes when it was written by a JSON formatter.
 */
function stringifyLike(original: string, value: unknown): string {
  const body = original.trimEnd();
  const trailing = original.slice(body.length);
  if (!body.includes("\n")) return JSON.stringify(value) + trailing;
  const m = /^([ \t]+)\S/m.exec(body);
  const indent: string | number = m === null ? 2 : m[1]!.startsWith("\t") ? "\t" : m[1]!.length;
  return JSON.stringify(value, null, indent) + (trailing === "" ? "" : "\n");
}

interface Migration {
  hooksRemoved: number;
  rulesRemoved: number;
}

/**
 * D8.5: remove from the user's `settings.json` the hooks and deny rules that an
 * earlier install (D7) put there. The hooks are recognised by shape, the deny
 * rules by the ledger and the shape of our own rules, so what the person wrote
 * stays. A missing or unparseable file is left alone.
 */
function migrateUserSettings(settingsPath: string, pin: EnforcementPin, mode: "apply" | "plan" = "apply"): Migration {
  const none: Migration = { hooksRemoved: 0, rulesRemoved: 0 };
  let raw: string | null;
  let settings: SettingsJson;
  try {
    raw = readIfExists(settingsPath);
    if (raw === null) return none;
    settings = parseSettings(raw, settingsPath);
  } catch {
    return none;
  }
  const hooks = stripHookEntries(settings);
  const rules = stripDenyRules(settings, settingsPath, pin);
  // "plan" counts what "apply" would remove; it only edits the parsed copy in memory.
  if (mode === "plan") return { hooksRemoved: hooks.removed, rulesRemoved: rules.removed };
  if (hooks.removed > 0 || rules.removed > 0) {
    try {
      writeFileSync(settingsPath, stringifyLike(raw, settings));
    } catch (err) {
      emitError({ code: "FS_ERROR", error: `failed to write ${settingsPath}: ${(err as Error).message}` }, {});
    }
  }
  if (rules.hadRecord) {
    try {
      writeDenyLedger(settingsPath, []);
    } catch {
      /* a stale ledger entry only makes the next uninstall a no-op for rules that are already gone */
    }
  }
  return { hooksRemoved: hooks.removed, rulesRemoved: rules.removed };
}

interface ManagedModeContext {
  claudeHome: string;
  claudeMdPath: string;
  opts: InstallClaudeMdOptions;
  pin: EnforcementPin;
  target: Extract<ReturnType<typeof chooseTarget>, { kind: "managed" }>;
}

/**
 * `install claude-md` into the managed-settings drop-in (D8). The drop-in goes
 * first and the CLAUDE.md snippet after it: the drop-in is the step that can be
 * refused or declined, and a refused install should leave nothing behind.
 */
function installManagedMode(ctx: ManagedModeContext): void {
  const { claudeHome, claudeMdPath, opts, pin, target } = ctx;
  const { env, paths } = target;
  const denyPlan = registryDenyPlan(pin);
  const plan = planManagedInstall(env, paths, { pin, firstTouch: opts.firstTouch === true, denyRules: denyPlan.rules }, opts);
  const strictModeOn = existsSync(leakContextFlagPath());
  const managedInfo = {
    path: paths.file,
    uid: env.uid,
    platform: env.platform,
    digest: plan.digest,
    bytes: plan.bytes,
  };

  if (opts.dryRun) {
    const existing = readIfExists(claudeMdPath) ?? "";
    const alreadyPresent = existing.includes(CLAUDE_MD_BEGIN);
    if (opts.silent) return;
    if (opts.json) {
      emitJson({
        action: "install-claude-md",
        dryRun: true,
        mode: "managed",
        claudeHome,
        claudeMd: { path: claudeMdPath, wouldAppend: !alreadyPresent, alreadyPresent },
        managed: { ...managedInfo, unchanged: plan.unchanged, contents: plan.text },
        registryDeny: {
          rules: denyPlan.rules,
          warnings: denyPlan.warnings,
          verifyWith: `touch ${denyPlan.verifyPath}`,
        },
        strictModeOn,
      });
      return;
    }
    emitText("# repo-aegis install claude-md (dry run — nothing written)");
    emitText("");
    emitText(`# Managed drop-in (written as root, for uid ${env.uid}): ${paths.file}`);
    emitText(`#   ${plan.bytes} bytes, sha256 ${plan.digest}${plan.unchanged ? "  (already installed, unchanged)" : ""}`);
    emitText(`# CLAUDE.md snippet: ${alreadyPresent ? "already present" : `would be appended to ${claudeMdPath}`}`);
    emitText("# permissions.deny rules protecting the registry, approvals, hooks, shim and pinned code:");
    for (const rule of denyPlan.rules) emitText(`#   ${rule}`);
    for (const line of denyAdviceLines(denyPlan)) emitText(`# ${line}`);
    emitText("");
    emitText(plan.text.trimEnd());
    if (!strictModeOn) {
      emitText("");
      emitText("# note: leak-context strict mode is OFF.");
      emitText("#   enable for sensitive sessions: repo-aegis context on");
    }
    return;
  }

  // The drop-in first: the step a person can refuse.
  const applied = applyManagedInstall(env, paths, plan, opts.managed?.terminal ?? {}, opts);

  // D8.5: the drop-in is in place and read back. Only now, and only if no other
  // managed source shadows it, do repo-aegis's own earlier entries leave the user file.
  // The user file is also the fallback a person re-adds when the drop-in is shadowed, so
  // the migration waits for (a) no shadowing source, (b) a heartbeat that does not fail
  // (MANAGED_HOOKS_NOT_FIRING; skipped on a first install is fine), and (c) a person at a
  // terminal whenever it would remove anything: an unchanged drop-in has no root step to
  // ask for one, and an agent must not be able to strip the fallback by re-running this.
  const settingsPath = join(claudeHome, "settings.json");
  const none: Migration = { hooksRemoved: 0, rulesRemoved: 0 };
  const heartbeat = heartbeatCheck(
    { claudeHome, ...(testSeamsEnabled() && opts.managed?.sessionBirths !== undefined && { sessionBirths: opts.managed.sessionBirths }) },
    readManagedLedger()?.installedAt ?? null,
  );
  const shadowed: DoctorCheck[] = [...managedShadowChecks(env, paths).filter(c => !c.ok), ...(heartbeat.ok ? [] : [heartbeat])];
  let migration: Migration = none;
  let needsTerminal: Migration | null = null;
  if (shadowed.length === 0) {
    const wouldRemove = migrateUserSettings(settingsPath, pin, "plan");
    if (wouldRemove.hooksRemoved + wouldRemove.rulesRemoved > 0) {
      if (isHumanTerminal(opts.managed?.terminal ?? {})) migration = migrateUserSettings(settingsPath, pin);
      else needsTerminal = wouldRemove;
    }
  }

  try {
    mkdirSync(claudeHome, { recursive: true });
  } catch (err) {
    emitError({ code: "FS_ERROR", error: `failed to create ${claudeHome}: ${(err as Error).message}` }, opts);
  }
  const snippet = ensureClaudeMdSnippet(claudeMdPath);

  try {
    appendAuditRecord({
      action: "install-claude-md",
      details: {
        claudeHome,
        mode: "managed",
        claudeMdAppended: snippet.appended,
        claudeMdAlreadyPresent: snippet.alreadyPresent,
        managedWritten: applied.wrote,
        managedDigest: plan.digest,
        registryDenyRules: denyPlan.rules.length,
        userFileHooksRemoved: migration.hooksRemoved,
        userFileDenyRulesRemoved: migration.rulesRemoved,
        userFileKeptBecauseShadowed: shadowed.map(c => c.code),
      },
    });
  } catch {
    /* audit log must not break user-facing ops */
  }

  if (opts.silent) return;

  if (opts.json) {
    emitJson({
      action: "install-claude-md",
      mode: "managed",
      claudeHome,
      claudeMd: { path: claudeMdPath, appended: snippet.appended, alreadyPresent: snippet.alreadyPresent },
      managed: { ...managedInfo, installed: true, unchanged: !applied.wrote, createdDirs: applied.created },
      migration: {
        settingsPath,
        hooksRemoved: migration.hooksRemoved,
        denyRulesRemoved: migration.rulesRemoved,
        keptBecause: shadowed.map((c: DoctorCheck) => ({ code: c.code, detail: c.detail })),
        needsTerminal: needsTerminal === null ? null : { hooksWouldRemove: needsTerminal.hooksRemoved, denyRulesWouldRemove: needsTerminal.rulesRemoved },
      },
      registryDeny: {
        rules: denyPlan.rules,
        warnings: denyPlan.warnings,
        verifyWith: `touch ${denyPlan.verifyPath}`,
      },
      strictModeOn,
    });
    return;
  }

  emitText(
    applied.wrote
      ? `installed the managed drop-in ${paths.file}`
      : `the managed drop-in ${paths.file} is already installed and unchanged`,
  );
  emitText(`  owner 0:0, mode 0644, ${plan.bytes} bytes, sha256 ${plan.digest}`);
  emitText(`  registers ${dropInHookCommands(plan.spec).length} hooks and ${denyPlan.rules.length} permissions.deny rule(s) for uid ${env.uid}`);
  emitText(snippet.appended ? `appended snippet to ${claudeMdPath}` : `snippet already present in ${claudeMdPath}`);
  if (migration.hooksRemoved > 0 || migration.rulesRemoved > 0) {
    emitText(
      `removed ${migration.hooksRemoved} hook entr${migration.hooksRemoved === 1 ? "y" : "ies"} and ${migration.rulesRemoved} permissions.deny rule(s) ` +
        `from ${settingsPath}: the drop-in carries them now, and that file no longer has to stay per machine`,
    );
  }
  if (needsTerminal !== null) {
    emitText(
      `a run from a terminal would remove ${needsTerminal.hooksRemoved} hook entr${needsTerminal.hooksRemoved === 1 ? "y" : "ies"} and ${needsTerminal.rulesRemoved} permissions.deny rule(s) ` +
        `from ${settingsPath}; it was left untouched because removing them needs a person at a terminal (run \`repo-aegis install claude-md\` from your own terminal)`,
    );
  }
  for (const c of shadowed) {
    emitText(`warning: ${c.code}: ${c.detail}`);
    emitText(`  repo-aegis's entries in ${settingsPath} were kept, because the drop-in may not apply (${c.fix ?? "see doctor"})`);
  }
  if (applied.wrote || migration.hooksRemoved > 0 || migration.rulesRemoved > 0) {
    emitText("confirm that `/status` in Claude Code shows `(drop-ins)` or `(file + drop-ins)`: the first session after this also records a heartbeat that `repo-aegis doctor` checks (MANAGED_HOOKS_NOT_FIRING)");
  }
  for (const rule of denyPlan.rules) emitText(`  rule: ${rule}`);
  for (const line of denyAdviceLines(denyPlan)) emitText(`  ${line}`);
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
  pin: EnforcementPin;
  cmd: ReturnType<typeof hookCommands>;
  /** Why the user file is the target (a D8.6 fallback), or null when the person chose it. */
  note: string | null;
}

function dryRunInstallClaudeMd(ctx: DryRunContext): void {
  const { claudeHome, claudeMdPath, settingsPath, opts, pin, cmd, note } = ctx;

  // 1. CLAUDE.md — compute would-be additions without writing.
  const existingClaudeMd = readIfExists(claudeMdPath) ?? "";

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
  const merge = mergeHook(settings, cmd.scanAfterWrite);
  const checkWriteMerge = mergePreToolUseHook(settings, HOOK_MATCHER, cmd.checkWrite, "check-write");
  const bashMerge = mergePostToolUseHook(settings, BASH_HOOK_MATCHER, cmd.scanBash, "scan-bash-output");
  const guardEgressMerge = mergePreToolUseHook(settings, BASH_HOOK_MATCHER, cmd.guardEgress, "guard-egress");
  const egressReceiptMerge = mergePostToolUseHook(settings, BASH_HOOK_MATCHER, cmd.egressReceipt, "egress-receipt");
  const promptSubmitMerge = mergePromptSubmitHook(settings, cmd.promptSubmit);
  const denyInstall = installDenyRules(settings, settingsPath, pin);
  const wouldBeSettings = JSON.stringify(settings, null, 2) + "\n";

  // 3. strict-mode flag (read-only check)
  const flagPath = leakContextFlagPath();
  const strictModeOn = existsSync(flagPath);

  if (opts.silent) return;

  if (opts.json) {
    emitJson({
      action: "install-claude-md",
      dryRun: true,
      mode: "user-settings",
      ...(note !== null && { note }),
      claudeHome,
      claudeMd: {
        path: claudeMdPath,
        wouldAppend: !claudeMdAlreadyPresent,
        alreadyPresent: claudeMdAlreadyPresent,
        addition: claudeMdAddition,
      },
      hookCommand: cmd.scanAfterWrite,
      settings: {
        path: settingsPath,
        wouldAdd: merge.added,
        alreadyPresent: merge.alreadyPresent,
        contents: wouldBeSettings,
      },
      checkWriteHook: {
        hookCommand: cmd.checkWrite,
        wouldAdd: checkWriteMerge.added,
        alreadyPresent: checkWriteMerge.alreadyPresent,
      },
      bashHook: {
        hookCommand: cmd.scanBash,
        wouldAdd: bashMerge.added,
        alreadyPresent: bashMerge.alreadyPresent,
      },
      guardEgressHook: {
        hookCommand: cmd.guardEgress,
        wouldAdd: guardEgressMerge.added,
        alreadyPresent: guardEgressMerge.alreadyPresent,
      },
      egressReceiptHook: {
        hookCommand: cmd.egressReceipt,
        wouldAdd: egressReceiptMerge.added,
        alreadyPresent: egressReceiptMerge.alreadyPresent,
      },
      promptSubmitHook: {
        hookCommand: cmd.promptSubmit,
        wouldAdd: promptSubmitMerge.added,
        alreadyPresent: promptSubmitMerge.alreadyPresent,
      },
      registryDeny: {
        rules: denyInstall.plan.rules,
        wouldAdd: denyInstall.added,
        alreadyPresent: denyInstall.alreadyPresent,
        wouldRemoveLegacy: denyInstall.legacyRemoved,
        warnings: denyInstall.plan.warnings,
        verifyWith: `touch ${denyInstall.plan.verifyPath}`,
      },
      strictModeOn,
    });
    return;
  }

  emitText("# repo-aegis install claude-md (dry run — nothing written)");
  if (note !== null) emitText(`# note: ${note}`);
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
  emitText(`#   ${cmd.checkWrite}    (PreToolUse: Write|Edit|MultiEdit)`);
  emitText(`#   ${cmd.guardEgress}    (PreToolUse: Bash)`);
  emitText(`#   ${cmd.scanAfterWrite}  (PostToolUse: Write|Edit|MultiEdit)`);
  emitText(`#   ${cmd.scanBash}  (PostToolUse: Bash)`);
  emitText(`#   ${cmd.egressReceipt}  (PostToolUse: Bash)`);
  emitText(`#   ${cmd.promptSubmit}  (UserPromptSubmit)`);
  emitText("");
  emitText("# permissions.deny rules protecting the registry, approvals, hooks and shim:");
  for (const rule of denyInstall.plan.rules) emitText(`#   ${rule}`);
  for (const line of denyAdviceLines(denyInstall.plan)) emitText(`# ${line}`);
  emitText("");
  emitText(`# Would-be settings.json at: ${settingsPath}`);
  if (
    merge.alreadyPresent &&
    checkWriteMerge.alreadyPresent &&
    bashMerge.alreadyPresent &&
    guardEgressMerge.alreadyPresent &&
    egressReceiptMerge.alreadyPresent &&
    promptSubmitMerge.alreadyPresent &&
    denyInstall.added.length === 0 &&
    denyInstall.legacyRemoved.length === 0
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
  | "egress-receipt"
  | "prompt-submit";

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
  promptSubmitRemoved: number;
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
    promptSubmitRemoved: 0,
  };
  if (!settings.hooks) return result;

  const filterEvent = (
    eventName: "PreToolUse" | "PostToolUse" | "SessionStart" | "UserPromptSubmit",
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
      else if (kind === "prompt-submit") result.promptSubmitRemoved += removed;
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
  filterEvent("UserPromptSubmit", "prompt-submit");

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

  // 0. The managed drop-in (D8.9) first: the step a person can refuse or that can
  // fail. If it does, nothing else is removed and enforcement stays where it is.
  const managedRemoval = uninstallManaged(opts);

  // 1. Strip the managed block from CLAUDE.md (if present).
  let claudeMdStripped = false;
  const body = readIfExists(claudeMdPath);
  const claudeMdAbsent = body === null;
  if (body !== null) {
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
    promptSubmitRemoved: 0,
  };
  let denyRulesRemoved = 0;
  let denyRecordFound = false;
  const settingsRaw = readIfExists(settingsPath);
  const settingsAbsent = settingsRaw === null;
  if (settingsRaw !== null) {
    let settings: SettingsJson;
    try {
      settings = parseSettings(settingsRaw, settingsPath);
    } catch (err) {
      emitError(
        { code: "SETTINGS_PARSE_ERROR", error: (err as Error).message },
        opts,
      );
    }
    settingsResult = stripHookEntries(settings!);
    const stripped = stripDenyRules(settings!, settingsPath, opts.pin);
    denyRulesRemoved = stripped.removed;
    denyRecordFound = stripped.hadRecord;
    if (settingsResult.removed > 0 || denyRulesRemoved > 0) {
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
  // The rules are gone (or were never there), so the record of adding them goes too.
  if (denyRecordFound || readDenyLedger().settings[settingsPath] !== undefined) {
    try {
      writeDenyLedger(settingsPath, []);
    } catch {
      /* a stale ledger entry only makes the next uninstall a no-op for rules that are already gone */
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
        promptSubmitHookEntriesRemoved: settingsResult.promptSubmitRemoved,
        firstTouchHookEntriesRemoved: settingsResult.firstTouchRemoved,
        registryDenyRulesRemoved: denyRulesRemoved,
        settingsAbsent,
        managedDropInRemoved: managedRemoval.removed,
        managedDirsRemoved: managedRemoval.dirsRemoved.length,
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
      managed: {
        path: managedRemoval.path,
        removed: managedRemoval.removed,
        dirsRemoved: managedRemoval.dirsRemoved,
        ledgerRemoved: managedRemoval.ledgerRemoved,
      },
      settings: {
        path: settingsPath,
        absent: settingsAbsent,
        hookEntriesRemoved: settingsResult.removed,
        scanHookEntriesRemoved: settingsResult.scanRemoved,
        checkWriteHookEntriesRemoved: settingsResult.checkWriteRemoved,
        bashHookEntriesRemoved: settingsResult.bashScanRemoved,
        guardEgressHookEntriesRemoved: settingsResult.guardEgressRemoved,
        egressReceiptHookEntriesRemoved: settingsResult.egressReceiptRemoved,
        promptSubmitHookEntriesRemoved: settingsResult.promptSubmitRemoved,
        firstTouchHookEntriesRemoved: settingsResult.firstTouchRemoved,
        registryDenyRulesRemoved: denyRulesRemoved,
      },
    });
    return;
  }

  if (managedRemoval.removed) {
    emitText(`removed the managed drop-in ${managedRemoval.path}`);
    for (const d of managedRemoval.dirsRemoved) emitText(`removed the empty directory ${d}, which repo-aegis created`);
  } else if (managedRemoval.path !== null) {
    emitText(`no managed drop-in at ${managedRemoval.path}`);
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
        ` SessionStart: ${settingsResult.firstTouchRemoved},` +
        ` UserPromptSubmit: ${settingsResult.promptSubmitRemoved})`,
    );
  }
  if (!settingsAbsent) {
    emitText(
      denyRulesRemoved > 0
        ? `removed ${denyRulesRemoved} registry permissions.deny rule(s) from ${settingsPath}` +
            " (a sandbox.filesystem.denyWrite entry you added yourself is left in place)"
        : `no registry permissions.deny rules in ${settingsPath}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Egress guard (doc/design/egress-guard.md §4, §7)
// ---------------------------------------------------------------------------

/** The prefix a registered by-name guard command must start with, whatever `--agent` follows it. */
const GUARD_EGRESS_COMMAND_PREFIX = "repo-aegis hook guard-egress";

/** True for a registered guard command: the managed drop-in's form, the pinned user-settings form, or the older by-name form. */
function isGuardEgressCommand(command: string): boolean {
  const c = command.trim();
  return c.startsWith(GUARD_EGRESS_COMMAND_PREFIX) || isPinnedHookCommand(c, "guard-egress") || isManagedHookCommand(c, "guard-egress");
}

/**
 * The repo-aegis hooks (`guard-egress`, `scan-after-write`, …) that Claude Code's
 * `settings.json` under `claudeHome` still runs as `repo-aegis hook <name> …` by
 * name, which a `repo-aegis` first on the agent's PATH can replace
 * (doc/plan-pin-enforcement-binary.md D7). Empty when there is no settings.json,
 * it does not parse (`GUARD_HOOK_UNREGISTERED` reports that), or every command
 * is pinned or someone else's.
 */
export function unpinnedClaudeHooks(claudeHome?: string): string[] {
  const settingsPath = join(claudeHome ?? defaultClaudeHome(), "settings.json");
  let settings: SettingsJson;
  try {
    if (!existsSync(settingsPath)) return [];
    settings = readSettings(settingsPath);
  } catch {
    return [];
  }
  const names = new Set<string>();
  for (const entries of Object.values(settings.hooks ?? {})) {
    for (const entry of entries ?? []) {
      for (const h of entry.hooks ?? []) {
        const m = typeof h.command === "string" ? /^repo-aegis hook ([a-z-]+)/.exec(h.command.trim()) : null;
        if (m !== null) names.add(m[1]!);
      }
    }
  }
  return [...names].sort();
}

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
export function checkGuardHook(claudeHome?: string, managed: SettingsJson | null = null): import("./doctor-checks.js").DoctorCheck[] {
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
  const hasGuard = (s: SettingsJson): boolean =>
    (s.hooks?.["PreToolUse"] ?? []).some(
      entry =>
        entry.matcher === BASH_HOOK_MATCHER &&
        (entry.hooks ?? []).some(h => typeof h.command === "string" && isGuardEgressCommand(h.command)),
    );

  // The managed drop-in (D8) counts: it is where the guard lives once `install claude-md` has run.
  if (managed !== null && hasGuard(managed)) {
    return [
      {
        code: "GUARD_HOOK_UNREGISTERED",
        ok: true,
        detail: `\`${GUARD_EGRESS_COMMAND_PREFIX}\` is registered as a PreToolUse(Bash) hook in the managed drop-in`,
      },
    ];
  }

  let settings: SettingsJson;
  try {
    if (!existsSync(settingsPath)) {
      return unregistered(
        `no settings.json at ${settingsPath} and no managed drop-in, so the PreToolUse(Bash) egress guard is not registered`,
      );
    }
    settings = readSettings(settingsPath);
  } catch {
    return unregistered(
      `settings.json at ${settingsPath} could not be parsed, so the PreToolUse(Bash) egress guard cannot be confirmed`,
    );
  }

  if (!hasGuard(settings)) {
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

// ---------------------------------------------------------------------------
// Registry write protection: the doctor side (R1)
// ---------------------------------------------------------------------------

/**
 * Whether one `permissions.deny` entry denies `Edit` for `target`. A bare
 * `Edit` denies the tool outright. A pattern counts when it is an absolute path
 * (`//…`) or a home path (`~/…`) and either names the target exactly, or ends
 * in `/**` (or `/*`) over a directory containing it; a project-relative pattern
 * cannot be judged from here and does not count. Only `Edit` is consulted:
 * Claude Code matches path rules for `Edit` and `Read` only. Pure and total:
 * anything unrecognised is "no".
 */
export function denyRuleCoversPath(rule: unknown, target: string, home: string = homedir()): boolean {
  if (typeof rule !== "string") return false;
  const trimmed = rule.trim();
  if (trimmed === "Edit") return true;
  const m = /^Edit\((.*)\)$/.exec(trimmed);
  if (m === null) return false;
  const pattern = m[1]!.trim();
  let abs: string;
  if (pattern.startsWith("//")) abs = pattern.slice(1);
  else if (pattern.startsWith("~/")) abs = join(home, pattern.slice(2));
  else return false;
  if (abs.endsWith("/**")) {
    const base = abs.slice(0, -3).replace(/\/+$/, "");
    return base === "" || target === base || target.startsWith(`${base}/`);
  }
  if (abs.endsWith("/*")) {
    const base = abs.slice(0, -2).replace(/\/+$/, "");
    return base === "" || dirname(target) === base;
  }
  return abs === target;
}

/**
 * `doctor` check: `REGISTRY_AGENT_WRITABLE` (warn) when the Claude Code
 * `settings.json` under `claudeHome` has no `permissions.deny` `Edit` rule for
 * one of the paths `install claude-md` protects: the registry file and its
 * `.age`, the approvals store, `hooks/` and `bin/` (R1). Without them the agent
 * can edit `engagements.yaml` directly, with no terminal, and register any
 * owner.
 *
 * A warning and not a failure: this reads settings.json, it cannot prove what
 * the running sandbox enforces. Best-effort like {@link checkGuardHook}: a
 * missing or unparseable settings.json is reported, never thrown.
 */
export function checkRegistryAgentWritable(
  claudeHome?: string,
  plan: RegistryDenyPlan = registryDenyPlan(),
  managed: SettingsJson | null = null,
): import("./doctor-checks.js").DoctorCheck {
  const home = claudeHome ?? defaultClaudeHome();
  const settingsPath = join(home, "settings.json");
  const fix =
    "repo-aegis install claude-md   (adds permissions.deny Edit rules for the registry file, its .age, the approvals store, hooks/, bin/, and the pinned CLI and node); " +
    `Claude Code applies Edit rules to the sandbox too: verify with a sandboxed \`touch ${plan.verifyPath}\``;
  const warn = (detail: string): import("./doctor-checks.js").DoctorCheck => ({
    code: "REGISTRY_AGENT_WRITABLE",
    ok: false,
    severity: "warn",
    detail,
    fix,
  });

  let settings: SettingsJson;
  try {
    settings = readSettings(settingsPath);
  } catch {
    // An unparseable user file does not hide the managed drop-in's rules.
    if (managed === null) {
      return warn(
        `settings.json at ${settingsPath} could not be parsed, so a deny rule for the registry files cannot be confirmed`,
      );
    }
    settings = {};
  }

  // Claude Code merges permissions.deny across scopes, so the drop-in's rules count with the user file's.
  const deny = [...denyList(settings), ...(managed === null ? [] : denyList(managed))];
  const uncovered = plan.sampleTargets.filter(t => !deny.some(rule => denyRuleCoversPath(rule, t)));
  if (uncovered.length > 0) {
    return warn(
      `Claude Code settings have no permissions.deny Edit rule covering ${uncovered.length} of the ${plan.sampleTargets.length} ` +
        "protected path(s) (registry, approvals, hooks, shim, pinned CLI and node), so an agent can edit them directly, with no terminal, " +
        "and register any owner",
    );
  }
  return {
    code: "REGISTRY_AGENT_WRITABLE",
    ok: true,
    detail: `settings.json at ${settingsPath} denies Edit on the registry, approvals, hooks, shim and pinned-code paths`,
  };
}
