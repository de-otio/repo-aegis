// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// `repo-aegis upgrade`: one command after upgrading the package.
//
// Nearly every release changes something repo-aegis generated onto the machine (the git hook scripts, the `gh`
// shim, the Claude Code drop-in, the credential helper's pin). Until each is re-run, `doctor` reports a
// `*_STALE` finding and the new behaviour does not apply. This command finds the stale ones the way `doctor`
// does (the same check functions, no second opinion) and re-runs the matching installer, in a fixed order:
//
//   hooks        HOOKS_SCRIPT_STALE      rewrites <home>/hooks/pre-commit and pre-push (no git config touched)
//   shim         SHIM_STALE              `install shim`
//   claude-md    MANAGED_DROPIN_STALE    `install claude-md` (a root write: sudo password, typed y)
//   git-credential  a repo-aegis helper from another install   `install git-credential` (person-only gate)
//
// It only re-runs installers an agent may already run. The two that need a person (the managed drop-in's sudo
// write and the credential helper's terminal gate) keep their own gates: with no person at a terminal they are
// listed under "run yourself:" with the exact command, not run and not failed. So `upgrade` is not in
// core/human-commands.ts: nothing it does for an agent is a decision only a person may make.
//
// It never installs something that was not installed (a missing shim stays missing), and `--dry-run` changes
// nothing, not even the "last version seen" record the once-per-version notice reads.
//
// It never pins the hooks or the shim to a copy that will not last, and never rolls them back. They run a pinned CLI
// by absolute path; `upgrade` run from a worktree build, an `npx` copy or a project node_modules would re-pin every
// hook there, and removing that copy later refuses every commit and push until a person runs `install hooks`. So each
// step reads its pin back from the scripts (`pinVerdict`) and refuses when the running CLI is ephemeral (unless
// `--force`) or older than the pinned version. Anything else is re-pinned, including a pin to another working install
// that is not newer: after `nvm install` or `brew upgrade node` the old global is still on disk.
import { existsSync, readFileSync } from "node:fs";
import { delimiter, dirname, join, sep } from "node:path";
import { appendAuditRecord, inspectHookScripts, isPinnedHookCommand, parsePinFromScript, PIN_VERSION_PATTERN, pinProblem, repoAegisHome, shellUnquote, type EnforcementPin } from "@de-otio/repo-aegis-core";
import { emitJson, emitText, type OutputOptions } from "../format.js";
import { currentEnforcementPin } from "../enforcement-pin.js";
import { isHumanTerminal, readLine, type ConfirmOptions } from "../require-terminal.js";
import { recordVersion } from "../version-notice.js";
import { gitCredentialHelperStale, type GitCredentialCheckOptions } from "./doctor-git-credential-checks.js";
import { canonical, unusable, versionIsOlder } from "./doctor-pin-checks.js";
import { managedDropinStaleCheck } from "./doctor-managed-checks.js";
import { defaultClaudeHome, installClaudeMd, readSettingsFile } from "./install-claude-md.js";
import { installGitCredential } from "./install-git-credential.js";
import { writeHookScripts } from "./install-hooks.js";
import { checkShim, installShim, shimBinDir, shimPathFor } from "./install-shim.js";
import { managedPaths } from "./managed-dropin.js";
import { resolveManagedEnv, type ManagedEnv } from "./managed-privileged.js";
import { parseTaaadPinFromScript, SHIM_HEADER_LINE } from "./shim-script.js";
import { resolveTaaadPin } from "./taaad-pin.js";

export interface UpgradeOptions extends OutputOptions {
  /** Report what would be done; change nothing. */
  dryRun?: boolean;
  /** Pin the hooks and the shim to this install even when it looks temporary (a git checkout, an npx cache, a project node_modules). */
  force?: boolean;
  /** Where Claude Code's `CLAUDE.md` lives (default `~/.claude`), passed on to `install claude-md`. */
  claudeHome?: string;
}

/** What the command needs from outside; the CLI passes only `version`. The rest are test seams. */
export interface UpgradeDeps {
  /** The running version, recorded as seen when the upgrade completes. */
  version?: string;
  /** The home to inspect and record in. Default: the repo-aegis home. */
  home?: string;
  /** Test seam: the enforcement pin the hooks and the drop-in are compared with. Default: this install's. */
  pin?: EnforcementPin;
  /** Test seam: whether the running CLI counts as temporary. Default: {@link isEphemeralCli} on this install's CLI. */
  ephemeral?: boolean;
  /** Test seam: the PATH the `gh` shim's taaad is looked up on. Default: `process.env.PATH`. */
  path?: string;
  /** Test seam: the file system view and privileged runner of the managed drop-in. Honoured only under the Node test runner. */
  managedEnv?: Partial<ManagedEnv>;
  /** Test seam: the terminal verdict inputs for the two person-only steps. Honoured only under the Node test runner. */
  terminal?: ConfirmOptions;
  /** Test seam: git's credential configuration, for the helper check. */
  credential?: GitCredentialCheckOptions;
}

export type StepName = "hooks" | "shim" | "claude-md" | "user-settings" | "git-credential";

export type StepStatus =
  /** Nothing stale: no action. */
  | "current"
  /** Not installed here: not this command's job to install it. */
  | "not-installed"
  | "upgraded"
  | "would-upgrade"
  | "failed"
  /** Stale, but this install must not re-pin it: the pin belongs to another install, or to a newer one. Nothing was changed. */
  | "refused"
  /** A person at the terminal answered no at the installer's prompt. Nothing was written; the command to retry is listed. */
  | "declined"
  /** Stale, and only a person can run the installer. */
  | "run-yourself";

export interface StepReport {
  step: StepName;
  status: StepStatus;
  detail: string;
  /** For `run-yourself`: the exact command. */
  command?: string;
}

export interface UpgradeReport {
  action: "upgrade";
  dryRun: boolean;
  version: string | null;
  steps: StepReport[];
  runYourself: Array<{ step: StepName; command: string }>;
  /** True when no installer was (or would be) run and nothing is waiting on a person. */
  nothingToUpgrade: boolean;
  failed: boolean;
  /** True when a stale step was left alone because re-pinning it from this install would be the wrong move. Exit 1. */
  refused: boolean;
  next: "repo-aegis doctor";
}

type Found = { state: "current" | "not-installed" | "stale"; detail: string };

/** An installer that exits the process is a failed step, not the end of the command. */
class ExitSignal extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}

/**
 * Run an installer, turning its failure into a value. The installers report errors through `emitError`, which
 * calls `process.exit(2)`, and `silent` only mutes their success output: so `process.exit` is trapped here for the
 * duration of the call and turned into a throw. This is the fragile part. It works only while every installer
 * either throws or exits through `process.exit` on the same synchronous stack; an installer that exits from a
 * callback or after an `await` would still end the process. All four steps are synchronous today. The proper fix is
 * for the installers to throw in silent mode (as `installClaudeMd`'s removal path already does); until then, a new
 * step must be checked against this.
 */
function attempt(run: () => void): { ok: true } | { ok: false; reason: string } {
  const realExit = process.exit;
  process.exit = ((code?: number) => {
    throw new ExitSignal(code ?? 0);
  }) as typeof process.exit;
  try {
    run();
    return { ok: true };
  } catch (err) {
    if (err instanceof ExitSignal) return err.code === 0 ? { ok: true } : { ok: false, reason: `the installer exited ${err.code} (its message is above)` };
    return { ok: false, reason: (err as Error).message };
  } finally {
    process.exit = realExit;
  }
}

// ---------------------------------------------------------------------------
// Detection: the doctor checks, asked without doctor's repo sweep
// ---------------------------------------------------------------------------

function findHooks(home: string, pin: EnforcementPin): Found {
  const dir = join(home, "hooks");
  const scripts = inspectHookScripts(dir, pin);
  const names = Object.keys(scripts) as Array<keyof typeof scripts>;
  if (!names.some(n => scripts[n].present)) return { state: "not-installed", detail: `no hook scripts in ${dir}` };
  // `resolveHookState`'s three script findings (missing, not executable, stale) are all cured by rewriting the files.
  const bad = names.filter(n => !scripts[n].present || !scripts[n].executable || !scripts[n].current);
  return bad.length === 0
    ? { state: "current", detail: "the hook scripts are what this release writes" }
    : { state: "stale", detail: `${bad.join(" and ")} in ${dir} differ from what this release writes (HOOKS_SCRIPT_STALE)` };
}

function findShim(home: string, path: string | undefined): Found {
  // `checkShim` only judges the file's age when the shim is first on PATH; where PATH puts something else first
  // is the person's business (SHIM_NOT_FIRST), not a reason to leave the file stale. So ask it with the shim's
  // directory first.
  const env = { ...process.env, REPO_AEGIS_HOME: home, PATH: [join(home, "bin"), path ?? process.env["PATH"] ?? ""].join(delimiter) };
  // A `gh` at <home>/bin that is not ours is the person's: `install shim` refuses to overwrite it, so trying
  // would fail on every run, forever.
  try {
    const text = readFileSync(join(home, "bin", "gh"), "utf8");
    if (!text.includes(SHIM_HEADER_LINE)) return { state: "not-installed", detail: `${join(home, "bin", "gh")} is not a repo-aegis shim: left alone` };
  } catch {
    /* absent or unreadable: checkShim says which */
  }
  const found = checkShim(env)[0];
  if (found === undefined) return { state: "current", detail: "no shim finding" };
  if (found.code === "SHIM_MISSING" && !found.ok) return { state: "not-installed", detail: "no `gh` shim is installed" };
  if (found.code === "SHIM_STALE") return { state: "stale", detail: `the \`gh\` shim at ${join(home, "bin", "gh")} was written by an earlier release (SHIM_STALE)` };
  return { state: "current", detail: "the shim is what this release writes" };
}

function findDropIn(env: ManagedEnv, pin: EnforcementPin): Found {
  const paths = env.uid === 0 ? null : managedPaths(env.platform, env.uid);
  if (paths === null) return { state: "not-installed", detail: "this account has no managed drop-in location" };
  const current = env.fs.read(paths.file);
  if (current === null) return { state: "not-installed", detail: "no managed drop-in is installed" };
  const check = managedDropinStaleCheck(env, current, pin);
  return check.ok
    ? { state: "current", detail: "the managed drop-in is what this release writes" }
    : { state: "stale", detail: `the managed drop-in at ${paths.file} differs from what this release writes (MANAGED_DROPIN_STALE)` };
}

// ---------------------------------------------------------------------------
// Whose pin is it? (never pin to a copy that will not last; never roll back)
// ---------------------------------------------------------------------------

function pinOf(path: string): EnforcementPin | null {
  try {
    return parsePinFromScript(readFileSync(path, "utf8"));
  } catch {
    return null; // absent or unreadable: no pin to protect
  }
}

/** The pins rendered into the two hook scripts under `home`, as they are on disk. Unpinned or absent scripts add none. */
function hookPins(home: string): EnforcementPin[] {
  return [pinOf(join(home, "hooks", "pre-commit")), pinOf(join(home, "hooks", "pre-push"))].filter((p): p is EnforcementPin => p !== null);
}

/** The pin rendered into the `gh` shim under `home`, if any. */
function shimPins(home: string): EnforcementPin[] {
  const pin = pinOf(join(home, "bin", "gh"));
  return pin === null ? [] : [pin];
}

/** The pins of repo-aegis's own pinned hook commands in Claude Code's user `settings.json`. */
function userSettingsPins(claudeHome: string): EnforcementPin[] {
  const settings = readSettingsFile(join(claudeHome, "settings.json"));
  if (settings === null) return [];
  const out: EnforcementPin[] = [];
  for (const entries of Object.values(settings.hooks ?? {})) {
    for (const entry of entries ?? []) {
      for (const h of entry.hooks ?? []) {
        const command = typeof h.command === "string" ? h.command.trim() : "";
        const m = / hook ([a-z-]+)/.exec(command);
        if (m === null || !isPinnedHookCommand(command, m[1]!)) continue;
        // `if [ -f '<node>' ] && [ -x '<node>' ] && [ -f '<cli>' ] && ...` then `__ra_version='<v>'` (see `pinnedHookCommand`).
        const paths = /^if \[ -f ('(?:[^']|'\\'')*') \] && \[ -x '(?:[^']|'\\'')*' \] && \[ -f ('(?:[^']|'\\'')*') \]/.exec(command);
        if (paths === null) continue;
        const node = shellUnquote(paths[1]!);
        const cli = shellUnquote(paths[2]!);
        if (node === null || cli === null) continue;
        const v = /__ra_version=('(?:[^']|'\\'')*')/.exec(command);
        const version = v === null ? null : shellUnquote(v[1]!);
        out.push(version !== null && PIN_VERSION_PATTERN.test(version) ? { node, cli, version } : { node, cli });
      }
    }
  }
  return out;
}

/** True when `existing` holds a pin that is not `pin` (another node, another CLI, or another version). */
function anyPinDiffers(existing: readonly EnforcementPin[], pin: EnforcementPin): boolean {
  return existing.some(p => p.node !== pin.node || canonical(p.cli) !== canonical(pin.cli) || (p.version ?? "") !== (pin.version ?? ""));
}

/**
 * Is `cli` (a realpath) a copy that will not last: a git checkout (a `.git` file or directory in an ancestor, as in a
 * worktree build), an `npx` cache (`/_npx/`), or a project `node_modules` that is not npm's global one? Pinning the
 * hooks there works until the copy is removed, and then every commit and push is refused.
 *
 * The npm global prefix is derived without spawning `npm prefix -g`: the Node executable's own prefix (`<prefix>/bin/node`,
 * so `<prefix>/lib/node_modules` on Unix and `<prefix>/node_modules` on Windows), the same under `npm_config_prefix`,
 * and any path with a `lib/node_modules` segment, which is where Unix installs global packages even when
 * `process.execPath` resolves into a Homebrew `Cellar` directory. A global install under a prefix that none of these
 * names is judged by its `.git` ancestors and `node_modules` like any other, and `--force` overrides the verdict.
 */
export function isEphemeralCli(cli: string, opts: { execPath?: string; env?: NodeJS.ProcessEnv } = {}): boolean {
  const path = cli.split(sep).join("/");
  if (path.includes("/_npx/")) return true;
  const execPath = opts.execPath ?? process.execPath;
  const env = opts.env ?? process.env;
  const prefixes = [dirname(dirname(execPath)), env["npm_config_prefix"], env["NPM_CONFIG_PREFIX"]].filter((p): p is string => typeof p === "string" && p !== "");
  const globalRoots = prefixes.flatMap(p => [join(p, "lib", "node_modules"), join(p, "node_modules")]);
  const isGlobal = path.includes("/lib/node_modules/") || globalRoots.some(root => cli === root || cli.startsWith(root + sep));
  if (isGlobal) return false;
  if (path.includes("/node_modules/")) return true;
  for (let dir = dirname(cli); ; dir = dirname(dir)) {
    if (existsSync(join(dir, ".git"))) return true;
    if (dirname(dir) === dir) return false;
  }
}

export type PinVerdict = { ok: true } | { ok: false; detail: string };

export interface PinVerdictInput {
  /** The pins the step's scripts carry now (empty for a by-name script). */
  existing: readonly EnforcementPin[];
  running: EnforcementPin;
  /** Is the running CLI a copy that will not last ({@link isEphemeralCli})? */
  ephemeral: boolean;
  /** `--force`: pin to an ephemeral CLI anyway. It does not override a version rollback. */
  force: boolean;
  /** What is being pinned, for the message ("the git hooks"). */
  what: string;
  /** The one command that switches this step on purpose from the running install. */
  installer: string;
}

/**
 * May `what` be pinned to the running install? Two honest mistakes are refused, each with its own fix:
 *
 *  1. Rolling back: an existing pin that still works names a version NEWER than the running one (an old devDependency
 *     run by npx, a stale global). The fix is to run the newer install's `upgrade`, or `installer` from this one to
 *     roll back on purpose.
 *  2. Pinning to a copy that will not last (`ephemeral`: a worktree build, an npx cache, a project `node_modules`):
 *     it works until that copy is removed, then every commit and push is refused. Refused whether the old pin works
 *     or is gone, unless the scripts already point at this very CLI. The fix is to run `upgrade` from the global
 *     install, or pass `--force`.
 *
 * Anything else is re-pinned, including a pin to another install that still works but is not newer: after `nvm
 * install` or `brew upgrade node` the previous global is still on disk, and refusing there would leave the person
 * with no way to finish the upgrade from the install they just made.
 */
export function pinVerdict(i: PinVerdictInput): PinVerdict {
  const runningCli = canonical(i.running.cli);
  const runningVersion = i.running.version;
  for (const p of i.existing) {
    if (unusable(p.node, "exec") || unusable(p.cli, "read")) continue; // gone: nothing to roll back from
    if (p.version !== undefined && runningVersion !== undefined && versionIsOlder(runningVersion, p.version)) {
      return {
        ok: false,
        detail:
          `the pin in ${i.what} is ${p.cli} (version ${p.version}), which is newer than this install (${runningVersion}): ` +
          `run the newer install's upgrade, or \`${i.installer}\` from this one to roll back on purpose (UPGRADE_REFUSED)`,
      };
    }
  }
  const alreadyHere = i.existing.length > 0 && i.existing.every(p => canonical(p.cli) === runningCli);
  if (i.ephemeral && !i.force && !alreadyHere) {
    return {
      ok: false,
      detail:
        `this install (${i.running.cli}) looks temporary (a git checkout, an npx cache or a project node_modules), so pinning ${i.what} to it ` +
        "would refuse every commit and push once it is removed: run upgrade from the global install (`npm i -g @de-otio/repo-aegis`, then `repo-aegis upgrade`), or pass --force (UPGRADE_REFUSED)",
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

/** Find the stale installs and, unless `dryRun`, re-run their installers. Never exits; returns what happened. */
export function runUpgrade(opts: UpgradeOptions, deps: UpgradeDeps = {}): UpgradeReport {
  const dryRun = opts.dryRun === true;
  const home = deps.home ?? repoAegisHome();
  const pin = deps.pin ?? currentEnforcementPin();
  const managedEnv = resolveManagedEnv(deps.managedEnv);
  const steps: StepReport[] = [];
  const runYourself: UpgradeReport["runYourself"] = [];

  // Asked at most once, and only when a person-only installer is actually stale.
  let personAtTerminal: boolean | null = null;
  const person = (): boolean => (personAtTerminal ??= isHumanTerminal(deps.terminal ?? {}));

  const add = (step: StepName, status: StepStatus, detail: string, command?: string): void => {
    steps.push({ step, status, detail, ...(command !== undefined && { command }) });
    if ((status === "run-yourself" || status === "declined") && command !== undefined) runYourself.push({ step, command });
  };
  // Each step is judged on its own pins and names its own installer. The running CLI's version is the pin's, or the
  // one the command line was started with.
  const running: EnforcementPin = pin.version !== undefined || deps.version === undefined ? pin : { ...pin, version: deps.version };
  let ephemeral: boolean | null = null; // asked at most once, and only when a step is stale
  const isEphemeral = (): boolean => deps.ephemeral ?? (ephemeral ??= isEphemeralCli(pin.cli));
  const judge = (existing: readonly EnforcementPin[], what: string, installer: string): PinVerdict =>
    pinVerdict({ existing, running, ephemeral: isEphemeral(), force: opts.force === true, what, installer });
  /** Not stale: report it in the JSON, say nothing in the text. */
  const quiet = (step: StepName, found: Found): void => add(step, found.state === "not-installed" ? "not-installed" : "current", found.detail);

  // 1. hooks
  {
    let hooksVerdict: PinVerdict;
    const found = findHooks(home, pin);
    if (found.state !== "stale") quiet("hooks", found);
    else if (!(hooksVerdict = judge(hookPins(home), "the git hooks", "repo-aegis install hooks")).ok) add("hooks", "refused", hooksVerdict.detail);
    else if (dryRun) add("hooks", "would-upgrade", "would rewrite pre-commit and pre-push");
    else {
      const problem = pinProblem(pin);
      const outcome =
        problem !== null
          ? ({ ok: false, reason: `cannot pin the enforcement binary: ${problem}` } as const)
          : attempt(() => writeHookScripts(join(home, "hooks"), pin));
      if (outcome.ok) add("hooks", "upgraded", `rewrote pre-commit and pre-push in ${join(home, "hooks")}`);
      else add("hooks", "failed", outcome.reason);
    }
  }

  // 2. shim
  {
    let shimVerdict: PinVerdict;
    const found = findShim(home, deps.path);
    if (found.state !== "stale") quiet("shim", found);
    else if (!(shimVerdict = judge(shimPins(home), "the gh shim", "repo-aegis install shim")).ok) add("shim", "refused", shimVerdict.detail);
    else if (dryRun) add("shim", "would-upgrade", `would rewrite ${shimPathFor()}`);
    else {
      // Keep the taaad the earlier install pinned while its launcher still exists: a different `taaad` that merely
      // comes first on this PATH (a venv an agent can write to) must not silently replace the vetted one. When
      // the old launcher is gone, or none was pinned, take the one on PATH; and `install shim` run from a shell
      // without any would drop the pin and, with it, every App identity, so the old pin is the last resort.
      let old = null as ReturnType<typeof parseTaaadPinFromScript>;
      try {
        old = parseTaaadPinFromScript(readFileSync(shimPathFor(), "utf8"));
      } catch {
        /* unreadable: the installer reports it */
      }
      const taaad = old !== null && existsSync(old.launcher) ? old : (resolveTaaadPin(deps.path ?? process.env["PATH"], shimBinDir()) ?? old);
      const outcome = attempt(() => void installShim(undefined, { silent: true, json: false, taaad }));
      if (outcome.ok) add("shim", "upgraded", `rewrote ${shimPathFor()}`);
      else add("shim", "failed", outcome.reason);
    }
  }

  // 3. claude-md: a root write behind a sudo password, so a person's terminal or nothing
  {
    const found = findDropIn(managedEnv, pin);
    const command = `repo-aegis install claude-md${opts.claudeHome !== undefined ? ` --claude-home ${opts.claudeHome}` : ""}`;
    if (found.state !== "stale") quiet("claude-md", found);
    else if (!person()) add("claude-md", "run-yourself", "writing the managed drop-in needs a person at a terminal (sudo asks for a password)", command);
    else if (dryRun) add("claude-md", "would-upgrade", "would rewrite the managed drop-in (asks for your sudo password)");
    else {
      // Remember what the person typed, so an `n` at the password prompt reads as a decision, not a failure.
      let typed: string | null = null;
      const read = deps.terminal?.readAnswer ?? readLine;
      const outcome = attempt(() =>
        installClaudeMd({
          silent: true,
          json: false,
          ...(opts.claudeHome !== undefined && { claudeHome: opts.claudeHome }),
          ...(deps.pin !== undefined && { pin: deps.pin }),
          managed: { env: deps.managedEnv ?? {}, terminal: { ...deps.terminal, readAnswer: () => (typed = read()) } },
        }),
      );
      const answer = typed as string | null; // assigned inside the callback, which the compiler's flow analysis cannot see
      if (outcome.ok) add("claude-md", "upgraded", "rewrote the managed drop-in");
      else if (answer !== null && !/^y(es)?$/i.test(answer.trim())) add("claude-md", "declined", "you answered no: nothing was written", command);
      else add("claude-md", "failed", outcome.reason);
    }
  }

  // 3b. user-settings: the hooks `init` and `install claude-md --user-settings` put into Claude Code's own
  // settings.json carry the pin too, and go stale when Node or the install moves. Listed, never run: whether the
  // hooks live there rather than in the managed drop-in is the person's call. Judged like the other pinned steps:
  // when this install is older than the pin, or will not last, the line says so instead of offering the command.
  {
    const claudeHome = opts.claudeHome ?? defaultClaudeHome();
    const settingsFile = join(claudeHome, "settings.json");
    const installer = `repo-aegis install claude-md --user-settings${opts.claudeHome !== undefined ? ` --claude-home ${opts.claudeHome}` : ""}`;
    const existing = userSettingsPins(claudeHome);
    if (!anyPinDiffers(existing, pin)) {
      add("user-settings", "current", "no repo-aegis hook in Claude Code's settings.json is pinned to another Node or install");
    } else {
      const verdict = judge(existing, `the repo-aegis hooks in ${settingsFile}`, installer);
      if (!verdict.ok) add("user-settings", "refused", verdict.detail);
      else add("user-settings", "run-yourself", `the repo-aegis hooks in ${settingsFile} are pinned to another install or Node (doctor: ENFORCEMENT_PIN_MISSING once that is gone)`, installer);
    }
  }

  // 4. git-credential: its own gate refuses anything but a person at a terminal
  {
    const stale = gitCredentialHelperStale(deps.credential);
    const command = "repo-aegis install git-credential";
    if (!stale) quiet("git-credential", { state: "current", detail: "no outdated credential helper" });
    else if (!person()) add("git-credential", "run-yourself", "the credential helper decides which GitHub account an agent's push uses, so only a person at a terminal installs it", command);
    else if (dryRun) add("git-credential", "would-upgrade", "would re-pin the git credential helper");
    else {
      const outcome = attempt(
        () =>
          void installGitCredential({
            ...(deps.terminal ?? {}),
            silent: true,
            json: false,
            ...(deps.credential?.cwd !== undefined && { cwd: deps.credential.cwd }),
          }),
      );
      if (outcome.ok) add("git-credential", "upgraded", "re-pinned the git credential helper");
      else add("git-credential", "failed", outcome.reason);
    }
  }

  const acted = steps.some(s => s.status === "upgraded" || s.status === "would-upgrade" || s.status === "failed" || s.status === "refused");
  return {
    action: "upgrade",
    dryRun,
    version: deps.version ?? null,
    steps,
    runYourself,
    nothingToUpgrade: !acted && runYourself.length === 0,
    failed: steps.some(s => s.status === "failed"),
    refused: steps.some(s => s.status === "refused"),
    next: "repo-aegis doctor",
  };
}

const TEXT_VERB: Readonly<Record<StepStatus, string>> = {
  current: "",
  "not-installed": "",
  upgraded: "done",
  "would-upgrade": "would",
  failed: "FAILED",
  refused: "REFUSED",
  declined: "declined",
  "run-yourself": "needs you",
};

/** `repo-aegis upgrade`: run it, say what happened, record the version, exit 1 when an installer failed. */
export function upgrade(opts: UpgradeOptions, deps: UpgradeDeps = {}): UpgradeReport {
  const report = runUpgrade(opts, deps);
  const home = deps.home ?? repoAegisHome();

  if (!report.dryRun) {
    if (anyStep(report, "upgraded", "failed")) {
      try {
        appendAuditRecord({ action: "upgrade", details: { steps: report.steps.filter(s => s.status !== "current" && s.status !== "not-installed").map(s => ({ step: s.step, status: s.status })) } });
      } catch {
        /* audit log must not break user-facing ops */
      }
    }
    // Once upgrade has run, the once-per-version notice has nothing left to say, unless an installer failed or a step was
    // refused (the run did not finish, so the version stays "not done").
    if (!report.failed && !report.refused && deps.version !== undefined) recordVersion(home, deps.version);
  }

  if (opts.json === true) {
    emitJson(report);
  } else {
    if (report.dryRun) emitText("upgrade (dry run: nothing was changed)");
    for (const s of report.steps) {
      const verb = TEXT_VERB[s.status];
      if (verb !== "") emitText(`upgrade: ${s.step.padEnd(14)} ${verb.padEnd(9)} ${s.detail}`);
    }
    if (report.nothingToUpgrade) emitText("nothing to upgrade");
    if (report.runYourself.length > 0) {
      emitText("run yourself:");
      for (const r of report.runYourself) emitText(`  ${r.command}`);
    }
    emitText(`next: ${report.next}`);
  }
  if (report.failed || report.refused) process.exit(1);
  return report;
}

function anyStep(report: UpgradeReport, ...statuses: StepStatus[]): boolean {
  return report.steps.some(s => statuses.includes(s.status));
}
