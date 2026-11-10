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
import { readFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { appendAuditRecord, inspectHookScripts, pinProblem, repoAegisHome, type EnforcementPin } from "@de-otio/repo-aegis-core";
import { emitJson, emitText, type OutputOptions } from "../format.js";
import { currentEnforcementPin } from "../enforcement-pin.js";
import { isHumanTerminal, type ConfirmOptions } from "../require-terminal.js";
import { recordVersion } from "../version-notice.js";
import { gitCredentialHelperStale, type GitCredentialCheckOptions } from "./doctor-git-credential-checks.js";
import { managedDropinStaleCheck } from "./doctor-managed-checks.js";
import { installClaudeMd } from "./install-claude-md.js";
import { installGitCredential } from "./install-git-credential.js";
import { writeHookScripts } from "./install-hooks.js";
import { checkShim, installShim, shimBinDir, shimPathFor } from "./install-shim.js";
import { managedPaths } from "./managed-dropin.js";
import { resolveManagedEnv, type ManagedEnv } from "./managed-privileged.js";
import { parseTaaadPinFromScript } from "./shim-script.js";
import { resolveTaaadPin } from "./taaad-pin.js";

export interface UpgradeOptions extends OutputOptions {
  /** Report what would be done; change nothing. */
  dryRun?: boolean;
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
  /** Test seam: the PATH the `gh` shim's taaad is looked up on. Default: `process.env.PATH`. */
  path?: string;
  /** Test seam: the file system view and privileged runner of the managed drop-in. Honoured only under the Node test runner. */
  managedEnv?: Partial<ManagedEnv>;
  /** Test seam: the terminal verdict inputs for the two person-only steps. Honoured only under the Node test runner. */
  terminal?: ConfirmOptions;
  /** Test seam: git's credential configuration, for the helper check. */
  credential?: GitCredentialCheckOptions;
}

export type StepName = "hooks" | "shim" | "claude-md" | "git-credential";

export type StepStatus =
  /** Nothing stale: no action. */
  | "current"
  /** Not installed here: not this command's job to install it. */
  | "not-installed"
  | "upgraded"
  | "would-upgrade"
  | "failed"
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
  next: "repo-aegis doctor";
}

type Found = { state: "current" | "not-installed" | "stale"; detail: string };

/** An installer that exits the process is a failed step, not the end of the command. */
class ExitSignal extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}

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
    if (status === "run-yourself" && command !== undefined) runYourself.push({ step, command });
  };
  /** Not stale: report it in the JSON, say nothing in the text. */
  const quiet = (step: StepName, found: Found): void => add(step, found.state === "not-installed" ? "not-installed" : "current", found.detail);

  // 1. hooks
  {
    const found = findHooks(home, pin);
    if (found.state !== "stale") quiet("hooks", found);
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
    const found = findShim(home, deps.path);
    if (found.state !== "stale") quiet("shim", found);
    else if (dryRun) add("shim", "would-upgrade", `would rewrite ${shimPathFor()}`);
    else {
      // Keep the taaad pin the earlier install made when this PATH does not reach taaad: `install shim` run
      // from a shell without it would otherwise drop the pin and, with it, every App identity.
      let old = null as ReturnType<typeof parseTaaadPinFromScript>;
      try {
        old = parseTaaadPinFromScript(readFileSync(shimPathFor(), "utf8"));
      } catch {
        /* unreadable: the installer reports it */
      }
      const taaad = resolveTaaadPin(deps.path ?? process.env["PATH"], shimBinDir()) ?? old;
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
      const outcome = attempt(() =>
        installClaudeMd({
          silent: true,
          json: false,
          ...(opts.claudeHome !== undefined && { claudeHome: opts.claudeHome }),
          ...(deps.pin !== undefined && { pin: deps.pin }),
          managed: { env: deps.managedEnv ?? {}, ...(deps.terminal !== undefined && { terminal: deps.terminal }) },
        }),
      );
      if (outcome.ok) add("claude-md", "upgraded", "rewrote the managed drop-in");
      else add("claude-md", "failed", outcome.reason);
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

  const acted = steps.some(s => s.status === "upgraded" || s.status === "would-upgrade" || s.status === "failed");
  return {
    action: "upgrade",
    dryRun,
    version: deps.version ?? null,
    steps,
    runYourself,
    nothingToUpgrade: !acted && runYourself.length === 0,
    failed: steps.some(s => s.status === "failed"),
    next: "repo-aegis doctor",
  };
}

const TEXT_VERB: Readonly<Record<StepStatus, string>> = {
  current: "",
  "not-installed": "",
  upgraded: "done",
  "would-upgrade": "would",
  failed: "FAILED",
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
    // Once upgrade has run, the once-per-version notice has nothing left to say, unless an installer failed.
    if (!report.failed && deps.version !== undefined) recordVersion(home, deps.version);
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
  if (report.failed) process.exit(1);
  return report;
}

function anyStep(report: UpgradeReport, ...statuses: StepStatus[]): boolean {
  return report.steps.some(s => statuses.includes(s.status));
}
