// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// `repo-aegis doctor` — fleet-wide hook-liveness sweep.
//
// Background: repo-aegis hooks are installed per repo (`install hooks`
// writes `core.hooksPath`, global or local). Coverage is therefore
// opt-in at install time, and a stale *repo-local* `core.hooksPath`
// silently beats a correct global one — git consults exactly one hooks
// directory, so the override wins with no error, no warning, nothing.
// A single-repo session cannot see this: everything about that one repo
// looks fine or looks broken, and there's no signal that its neighbours
// disagree. The condition that actually caught this in the wild was
// four sibling repos printing a scan line in the same minute and a
// fifth staying silent — a fleet-wide comparison, not a per-repo one.
// `doctor` is that comparison made deliberate: walk every repo under a
// set of roots, resolve each one's effective hook state (via H1's
// `resolveHookState`), and report the repos that disagree with the
// fleet's expected state — instead of relying on luck to notice.
//
// This is also the answer to "wire hook-liveness checking into CI":
// GitHub-hosted runners never have repo-aegis hooks installed (there's
// nothing to check), so a per-repo GHA workflow step would fail on
// every run and get muted. The right surface is a developer-machine
// sweep, run on demand or on a schedule — this command.

import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { resolve } from "node:path";
import {
  appendAuditRecord,
  resolveHookState,
  getRemoteOrg,
  readRepoConfig,
  readCachedVisibility,
  recordWorkingTree,
  loadRegistryState,
  readActivePause,
  pauseNotice,
  isDecisionLogEnabled,
  fallbackHoldsNewer,
  decisionLogWritable,
  repoAegisHome,
  type HookState,
  type HookStateCode,
  type Registry,
  type RegistryLoad,
} from "@de-otio/repo-aegis-core";
import { emitJson, emitText, type OutputOptions } from "../format.js";
import { findWorkingTrees, defaultScanRoots } from "../repo-walk.js";
import { currentEnforcementPin } from "../enforcement-pin.js";
import { checkLabel, isFailure, isReportable, PERSON_RUNS_THIS, type DoctorCheck } from "./doctor-checks.js";
import { collapseFindings, failingSummary, fixFirstLines, renderLines, type Finding } from "./doctor-report.js";
import { checkShim } from "./install-shim.js";
import { checkGuardHook, checkRegistryAgentWritable } from "./install-claude-md.js";
import { gitCredentialOrderChecks } from "./doctor-git-credential-checks.js";
import { agentRemoteSshCheck, ghOwnerChecks, ownerIdentityChecks, registryStateChecks, taaadChecks, type GhCheckOptions } from "./doctor-owner-checks.js";
import { checkLocalHooksPathDuplicate, checkPrePushHook, checkShellStartupOverrides, checkSshGithubRedirect } from "./doctor-env-checks.js";
import { enforcementPinChecks } from "./doctor-pin-checks.js";
import { managedDropinChecks, readDropInSettings, userSettingsEnforcementCheck } from "./doctor-managed-checks.js";
import { resolveManagedEnv, type ManagedEnv } from "./managed-privileged.js";

interface DoctorOptions extends OutputOptions {
  scanRoot?: string[];
  /** Report (dry-run) or apply a fix for repo-local `core.hooksPath`
   * overrides. Dry-run unless paired with `yes`. */
  fix?: boolean;
  /** Bypass the dry-run default; only meaningful with `fix`. */
  yes?: boolean;
  /**
   * Run the egress-guard checks (doc/design/egress-guard.md §7). Commander's
   * `--no-egress-checks` negation delivers `false` here and the flag's absence
   * delivers `undefined`, so the default is ON: every destination-aware
   * control in the design is inert on an unclassified repo, and a check that
   * has to be switched on is one nobody switches on.
   */
  egressChecks?: boolean;
  /** Where Claude Code's `settings.json` lives, for `GUARD_HOOK_UNREGISTERED` (default `~/.claude`). */
  claudeHome?: string;
  /** Home directory whose shell startup files `SHELL_STARTUP_OVERRIDES` reads (default `$HOME`). */
  homeDir?: string;
  /** Directory holding the ssh `config` for `SSH_GITHUB_REDIRECT` (default: the passwd home's `.ssh`). */
  sshDir?: string;
  /** Test seam for the gh-backed checks (binary policy, confirmation). Not reachable from the CLI. */
  ghOptions?: GhCheckOptions;
  /**
   * Print every finding and its fix. Without it, per-repository findings of one code collapse into one line
   * with a count, and the fixes appear once, in the closing "Fix these first" list (FAILs only).
   * `--json` is always complete either way.
   */
  verbose?: boolean;
  /** Test seam: what the global `core.hooksPath` holds, for `PREPUSH_HOOK_MISSING`. */
  readGlobalHooksPath?: () => string | null;
  /** Test seam for the managed drop-in checks: platform, uid, file system view, the privileged runner. Honoured only under the Node test runner. */
  managed?: Partial<ManagedEnv>;
}

export interface DoctorRepoResult {
  workingTree: string;
  code: HookStateCode;
  ok: boolean;
  effectivePath: string | null;
  shadowedRepoHooks: string[];
  /** Subset of the above that repo-aegis does not chain, i.e. genuinely never runs. */
  bypassedRepoHooks: string[];
  /** One-line remediation for `code`; empty when the hook state is fine. */
  fix: string;
  /** True only when this run actually unset a local override (requires
   * `--fix --yes`, never set during a dry run). */
  fixed: boolean;
  /** Egress-guard checks for this repo; `[]` under `--no-egress-checks`. */
  checks: DoctorCheck[];
}

function git(cwd: string, args: string[]): { ok: boolean; stdout: string } {
  try {
    const stdout = execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return { ok: true, stdout };
  } catch {
    return { ok: false, stdout: "" };
  }
}

/** The repo-LOCAL scope's `core.hooksPath` value only, ignoring global/
 * system/worktree scopes — `resolveHookState`'s `effectivePath` is the
 * *winning* scope's value, which is exactly what `--fix` must not act
 * on blindly (unsetting a correct global value would be destructive). */
function readLocalHooksPath(cwd: string): string | null {
  const res = git(cwd, ["config", "--local", "--get", "core.hooksPath"]);
  return res.ok && res.stdout !== "" ? res.stdout : null;
}

/** Absolute path of the repo's own (local-scope) git config file, i.e.
 * `<git-common-dir>/config`. Used only for the forensic mtime capture
 * below — never mutated directly. */
function localConfigPath(cwd: string): string | null {
  const res = git(cwd, ["rev-parse", "--git-path", "config"]);
  if (!res.ok || res.stdout === "") return null;
  return resolve(cwd, res.stdout);
}

function configMtimeIso(cwd: string): string | null {
  const path = localConfigPath(cwd);
  if (path === null) return null;
  try {
    return statSync(path).mtime.toISOString();
  } catch {
    return null;
  }
}

function unsetLocalHooksPath(cwd: string): boolean {
  try {
    execFileSync("git", ["config", "--local", "--unset", "core.hooksPath"], {
      cwd,
      stdio: ["ignore", "ignore", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

function isFailing(state: HookState): boolean {
  // Report on genuinely-bypassed hooks only. A displaced `pre-commit` /
  // `pre-push` is chained by the generated scripts and still runs, so
  // failing on it flags a healthy repo forever — the "guard that fires
  // when it shouldn't" failure mode this tool exists to remove.
  return !state.ok || state.bypassedRepoHooks.length > 0;
}

/** True when a repo-local `core.hooksPath` is set and differs from the
 * expected repo-aegis path — the only condition `--fix` acts on. A
 * local value that already equals `expectedPath` is left alone: there
 * is nothing to unset, and unsetting it would just fall through to
 * whatever global/system value exists (possibly nothing), which is not
 * an improvement. */
function fixEligible(cwd: string, state: HookState): { eligible: boolean; localValue: string | null } {
  const localValue = readLocalHooksPath(cwd);
  if (localValue === null) return { eligible: false, localValue: null };
  const eligible = resolve(cwd, localValue) !== state.expectedPath;
  return { eligible, localValue };
}

// ---------------------------------------------------------------------------
// Egress-guard checks (doc/design/egress-guard.md §7)
//
// Every destination-aware control in that design reads a repo's class and its
// cached visibility. On the machine that had the two incidents, the public
// repository involved had NEITHER — so a destination-aware control would have
// been silent there. These checks are how "the guard is installed but inert"
// becomes findable, exactly as the hook-liveness sweep above does for hooks.
// ---------------------------------------------------------------------------

/**
 * `push.default` from the GLOBAL scope only.
 *
 * Deliberately not the effective value: a repo-local `push.default = nothing`
 * protects one repo, and this check is about the machine. `nothing` makes a
 * bare `git push` an error in every shell for every agent and every human —
 * the single cheapest line in the whole design, and the one that needs no
 * repo-aegis involvement at all.
 */
function checkPushDefault(): DoctorCheck {
  const res = git(process.cwd(), ["config", "--global", "--get", "push.default"]);
  const value = res.ok ? res.stdout.trim() : "";
  if (value === "nothing") {
    return {
      code: "PUSH_DEFAULT_IMPLICIT",
      ok: true,
      detail: "global push.default is `nothing`, so a bare `git push` is an error",
    };
  }
  return {
    code: "PUSH_DEFAULT_IMPLICIT",
    ok: false,
    // WARN: a recommended personal git setting. Nothing is refused and no guard is inert without it.
    severity: "warn",
    detail:
      "global push.default is unset or not `nothing`, so a bare `git push` picks a " +
      "destination for you — in the wrong checkout that publishes a branch you did not name",
    fix: "git config --global push.default nothing",
  };
}

/** Machine-level checks: once per run, independent of any repo. */
/** Checkouts recorded into the destination cache by this run (reset per `doctor()` call). */
let recordedDestinations = 0;

/**
 * Best-effort, and the five states are different findings (decision D4): no
 * file is not a finding (rule h is skipped by design), an encrypted registry is
 * a warning (repo-aegis runs as if there were none), a file that exists but
 * cannot be read (unparseable, or a newer schema) IS a failure (rule h then
 * asks or refuses everything), and a loaded registry is compared against `gh`.
 * The classification is the one the hook, the shim and pre-push use.
 */
const loadRegistryForDoctor = (): RegistryLoad => loadRegistryState();

/**
 * `PAUSE_ACTIVE` (a warning): a person paused repo-aegis, so protection is off on purpose until the expiry. Reported
 * whatever `--no-egress-checks` says, because it changes what every other line means. A warning, not a failure: it
 * is the person's own choice and ends by itself, so it must not turn a green job red. The scope is not named.
 */
export function pauseChecks(): DoctorCheck[] {
  const pause = readActivePause();
  if (pause === null) return [];
  return [
    {
      code: "PAUSE_ACTIVE",
      ok: false,
      severity: "warn",
      detail:
        `repo-aegis is paused for ${pause.repo === undefined ? "everything on this machine" : "one repository"} until ` +
        `${pause.expiresAt}: its hooks, egress guard, gh shim and git credential helper are standing aside (${pauseNotice(pause)})`,
      fix: "repo-aegis resume",
    },
  ];
}

/**
 * The decision log's three findings (P1-I), reported whatever `--no-egress-checks` says: they say whether the next
 * refusal will be explained. `DECISION_LOG_OFF` (info): a person switched it off. `DECISION_LOG_FALLBACK` (info): the
 * `$TMPDIR` fallback holds records newer than the primary's last (the home was not writable from some process, a sandbox
 * usually). `DECISION_LOG_UNWRITABLE` (warn): neither the home nor the fallback can be written, so refusals end
 * `(not logged)`.
 */
export function decisionLogChecks(home: string = repoAegisHome()): DoctorCheck[] {
  const out: DoctorCheck[] = [];
  if (!isDecisionLogEnabled(home)) {
    out.push({
      code: "DECISION_LOG_OFF",
      ok: false,
      severity: "info",
      detail: "the decision log is switched off, so a refusal cannot be explained from it (`repo-aegis log` shows only older records)",
      fix: "repo-aegis log --on",
    });
    return out;
  }
  if (fallbackHoldsNewer(home)) {
    out.push({
      code: "DECISION_LOG_FALLBACK",
      ok: false,
      severity: "info",
      detail:
        "some process could not write the decision log in the repo-aegis home (a sandbox that only writes the working directory and $TMPDIR does this) and wrote to a fallback under $TMPDIR instead; `repo-aegis log` reads both",
      fix: "no action needed; to keep the log in one place make the home writable for that process, or let the sandbox allow the repo-aegis home",
    });
  }
  if (decisionLogWritable(home) === "none") {
    out.push({
      code: "DECISION_LOG_UNWRITABLE",
      ok: false,
      severity: "warn",
      detail: "neither the repo-aegis home nor the $TMPDIR fallback can be written from here, so refusals end `(not logged)` and nothing can be debugged afterwards",
      fix: "make <home>/state writable for this user (check its owner and mode), then run repo-aegis doctor again",
    });
  }
  return out;
}

function machineChecks(opts: DoctorOptions, reg: RegistryLoad): DoctorCheck[] {
  // The managed drop-in (D8) is where the Claude Code hooks and deny rules live once
  // `install claude-md` has run; the guard and deny checks read it with the user file.
  const managedEnv = resolveManagedEnv(opts.managed);
  const dropin = readDropInSettings(managedEnv);
  const checks = [
    checkPushDefault(),
    ...checkShim(),
    ...enforcementPinChecks(process.env, undefined, opts.claudeHome),
    ...checkGuardHook(opts.claudeHome, dropin),
    ...managedDropinChecks({ env: managedEnv, ...(opts.claudeHome !== undefined && { claudeHome: opts.claudeHome }) }),
  ];
  const inUserFile = userSettingsEnforcementCheck(opts.claudeHome);
  if (inUserFile !== null) checks.push(inUserFile);
  checks.push(...registryStateChecks(reg));
  // With no registry there is nothing to protect and nothing to compare gh against.
  if (reg.state !== "missing") checks.push(checkRegistryAgentWritable(opts.claudeHome, undefined, dropin));
  if (reg.state === "loaded") {
    checks.push(...ownerIdentityChecks(reg.registry));
    checks.push(...taaadChecks(reg.registry));
    checks.push(...gitCredentialOrderChecks(reg.registry));
    checks.push(...ghOwnerChecks(reg.registry, process.env, opts.ghOptions));
  }
  checks.push(checkShellStartupOverrides(opts.homeDir), checkSshGithubRedirect(opts.sshDir));
  return checks;
}

/**
 * Per-repo checks, for working trees that have a GitHub remote. A repo with
 * no GitHub remote has no destination to be wrong about, so it is skipped
 * outright rather than reported as unresolved.
 */
function repoEgressChecks(wt: string, registry: Registry | null): DoctorCheck[] {
  const org = getRemoteOrg(wt);
  if (org === null) return [];

  const out: DoctorCheck[] = [];

  // The sweep is the bulk writer of the machine-wide destination cache: it
  // visits every checkout and reads exactly the two values the cache holds.
  // Best-effort; the count is reported in the summary.
  if (recordWorkingTree(wt) !== null) recordedDestinations++;

  const cfg = readRepoConfig(wt);
  const visibility = readCachedVisibility(wt);
  const resolved = cfg.classExplicit && visibility !== "unknown";
  out.push({
    code: "CLASS_VISIBILITY_UNRESOLVED",
    ok: resolved,
    // WARN (P3-C): a clone you have not classified yet (a third party's repo, say) is not a broken guard.
    ...(resolved ? {} : { severity: "warn" as const }),
    detail: resolved
      ? "class is explicit and GitHub visibility is cached"
      : "no explicit class and/or no cached GitHub visibility, so every destination-aware check is inert in this repo",
    ...(resolved ? {} : { fix: "repo-aegis classify --apply && repo-aegis status  (run in that repo)" }),
  });

  if (registry !== null) {
    // U3: an owner whose agent identity is a GitHub App needs an HTTPS push URL (person-run fix).
    const sshOrigin = agentRemoteSshCheck(wt, org, registry);
    if (sshOrigin !== null) out.push(sshOrigin);
  }

  // U1: a local core.hooksPath equal to the global one is removable.
  const duplicateHooksPath = checkLocalHooksPathDuplicate(wt);
  if (duplicateHooksPath !== null) out.push(duplicateHooksPath);

  if (registry !== null) {
    const known =
      (registry.personalOrgs ?? []).some(o => o.toLowerCase() === org) ||
      registry.engagements.some(e => (e.githubOrgs ?? []).some(o => o.toLowerCase() === org));
    out.push({
      code: "PERSONAL_ORG_UNREGISTERED",
      ok: known,
      // WARN (P3-C): a repo under an org you have not registered is the person's choice to leave alone.
      ...(known ? {} : { severity: "warn" as const }),
      // The org name is deliberately NOT in `detail`: an unregistered org can
      // be a customer's, and `detail` is the line most likely to be copied out
      // of a terminal into a ticket or a chat. `fix` carries it because the
      // operator has to type it, and `doctor` runs on their own machine.
      detail: known
        ? "the remote org is registered (an engagement's githubOrgs, or personalOrgs)"
        : "the remote org is in no engagement's githubOrgs and not in personalOrgs, so `classify` cannot attribute this repo (it stays at the private-strict default with no visibility cached)",
      ...(known
        ? {}
        : {
            fix:
              `repo-aegis engagements add --personal-org ${org}   (or --github-org ${org} on the engagement that owns it; ` +
              `${PERSON_RUNS_THIS})`,
          }),
    });
  }

  return out;
}

/** What `doctor` prints, as findings: machine-level checks, then each repository's hook state and checks. */
export function reportFindings(
  machine: readonly DoctorCheck[],
  results: readonly DoctorRepoResult[],
  opts: { showWouldFix: boolean },
): Finding[] {
  const out: Finding[] = [];
  for (const c of machine) {
    if (!isReportable(c)) continue;
    const label = checkLabel(c);
    out.push({
      label,
      code: c.code,
      line: `${c.code} — ${c.detail}`,
      ...(c.fix !== undefined && { fix: c.fix }),
      ...(label === "SKIP" && {
        skip: {
          key: `${c.account ?? ""}\u0000${c.skipReason ?? c.detail}`,
          ...(c.account !== undefined && { subject: `gh account ${c.account}` }),
          reason: c.skipReason ?? c.detail.replace(/^skipped: /, ""),
        },
      }),
    });
  }
  for (const r of results) {
    // A repository whose hooks are live is listed only for its other findings, which carry the path themselves.
    const hookFailing = !r.ok || r.bypassedRepoHooks.length > 0;
    if (hookFailing || r.fixed) {
      const tag = r.fixed ? " [fixed]" : opts.showWouldFix ? " [would fix]" : "";
      out.push({
        label: hookFailing ? "FAIL" : "WARN",
        code: r.code,
        line: `${r.workingTree}  code=${r.code}${tag}`,
        notes: r.bypassedRepoHooks.length > 0 ? [`repo-local hooks that never run: ${r.bypassedRepoHooks.join(", ")}`] : [],
        fix: r.fix !== "" ? r.fix : "repo-aegis doctor --fix --yes",
        repo: r.workingTree,
        suffix: tag,
      });
    }
    for (const c of r.checks) {
      if (!isReportable(c)) continue;
      out.push({
        label: checkLabel(c),
        code: c.code,
        line: `${c.code} — ${c.detail}  [${r.workingTree}]`,
        ...(c.fix !== undefined && { fix: c.fix }),
        repo: r.workingTree,
      });
    }
  }
  return out;
}

export function doctor(opts: DoctorOptions): void {
  const fixRequested = !!opts.fix;
  const applyFix = fixRequested && !!opts.yes;
  // Mirrors the `uninstall sweep-repos` convention: `--fix` alone is a
  // dry run that reports what would change; `--fix --yes` mutates.
  // `dryRun` in the reported shape means "no mutation happened this
  // run" — true both when `--fix` was never passed and when it was
  // passed without `--yes`. `showWouldFix` narrows that to the case
  // worth telling the user about: `--fix` was requested but not
  // applied yet.
  const dryRun = !applyFix;
  const showWouldFix = fixRequested && !applyFix;

  const roots = opts.scanRoot && opts.scanRoot.length > 0 ? opts.scanRoot : defaultScanRoots();

  // Commander's negation gives `false`; absence gives `undefined` -> ON.
  const egressChecksOn = opts.egressChecks !== false;
  // Loaded once for the whole sweep, best-effort: a registry that cannot be
  // read means `PERSONAL_ORG_UNREGISTERED` is simply not answerable. That is
  // still reported, once, as `REGISTRY_UNREADABLE` (a failure, decision D4),
  // but never as a per-repo failure doctor cannot substantiate.
  const regLoad: RegistryLoad = egressChecksOn
    ? loadRegistryForDoctor()
    : { state: "missing" };
  const registry = regLoad.state === "loaded" ? regLoad.registry : null;
  const machine = [...pauseChecks(), ...decisionLogChecks(), ...(egressChecksOn ? machineChecks(opts, regLoad) : [])];

  const results: DoctorRepoResult[] = [];
  let scanned = 0;
  let fixedCount = 0;
  recordedDestinations = 0;

  for (const root of roots) {
    for (const wt of findWorkingTrees(root)) {
      scanned++;
      let state = resolveHookState(wt, currentEnforcementPin());
      if (!state.isGitRepo) continue; // walker found a `.git` entry that git itself doesn't recognise (corrupt/bare edge case) — nothing to evaluate.

      const checks = egressChecksOn ? repoEgressChecks(wt, registry) : [];
      const hookFailing = isFailing(state);
      // Healthy on BOTH axes: contributes to `scanned` only, never listed —
      // see module header. A repo whose hooks are live but whose class is
      // unresolved is now listed, because the egress controls are inert there.
      if (!hookFailing && !checks.some(isReportable)) continue;

      let fixed = false;
      // `--fix` is about `core.hooksPath` and nothing else; a repo listed only
      // for a failing egress check has nothing for it to act on.
      if (fixRequested && hookFailing) {
        const { eligible, localValue } = fixEligible(wt, state);
        if (eligible && applyFix && localValue !== null) {
          // FORENSICS BEFORE MUTATING. The incident that motivated this
          // command lost the only timestamp that would have dated the
          // regression, because the repair rewrote `.git/config` before
          // anyone recorded its mtime — record the prior value and the
          // config file's mtime here, in that order, before the unset
          // below touches the file. Best-effort: the audit log must
          // never block the actual repair.
          try {
            appendAuditRecord({
              action: "doctor-fix",
              cwd: wt,
              repo: wt,
              details: {
                previousLocalHooksPath: localValue,
                configMtimeBeforeFix: configMtimeIso(wt),
              },
            });
          } catch {
            /* audit log must not break the fix */
          }
          fixed = unsetLocalHooksPath(wt);
          if (fixed) {
            fixedCount++;
            // Re-resolve: unsetting the local override can restore a
            // correct global fallback (or reveal there isn't one), and
            // it can also change which scripts count as shadowed. The
            // reported code/effectivePath must reflect the post-fix
            // state, not the stale pre-fix snapshot.
            state = resolveHookState(wt, currentEnforcementPin());
          }
        }
      }

      results.push({
        workingTree: wt,
        code: state.code,
        ok: state.ok,
        effectivePath: state.effectivePath,
        shadowedRepoHooks: state.shadowedRepoHooks,
        bypassedRepoHooks: state.bypassedRepoHooks,
        fix: state.fix,
        fixed,
        checks,
      });
    }
  }

  // R11, after the sweep and any `--fix`: one machine-level setting, not a
  // per-repo property. `checkGuardHook` is the same answer the machine checks
  // above reported, so a missing guard hook is not double-reported.
  if (egressChecksOn) {
    const guardRegistered = checkGuardHook(opts.claudeHome, readDropInSettings(resolveManagedEnv(opts.managed))).every(c => c.ok);
    const prePush = checkPrePushHook(guardRegistered, opts.readGlobalHooksPath);
    if (prePush !== null) machine.push(prePush);
  }

  // Only `fail`-severity findings count. A warning or an info line is reported
  // and never changes the exit code, so it cannot turn a green CI job red.
  const machineFailed = machine.filter(isFailure).length;
  const repoIsFailing = (r: DoctorRepoResult): boolean =>
    !r.ok || r.bypassedRepoHooks.length > 0 || r.checks.some(isFailure);
  const repoFailed = results.filter(repoIsFailing).length;
  const failed = repoFailed + machineFailed;

  if (opts.json) {
    emitJson({
      action: "doctor",
      dryRun,
      roots,
      machine,
      results,
      summary: { scanned, failed, fixed: fixedCount, destinationsRecorded: recordedDestinations },
    });
  } else {
    const verbose = opts.verbose === true;
    emitText(
      `doctor: scanned ${scanned} repo(s) under ${roots.join(", ")}` +
        (egressChecksOn ? `; recorded ${recordedDestinations} checkout(s) into the destination cache` : ""),
    );
    const findings = reportFindings(machine, results, { showWouldFix });
    const lines = collapseFindings(findings, verbose);
    for (const text of renderLines(lines, verbose)) emitText(text);
    const machineNotes = machine.filter(c => isReportable(c) && !isFailure(c)).length;
    const fixFirst = fixFirstLines(lines);
    // The list's heading rides on the summary line, so a short run stays short.
    const tail = fixFirst.length > 0 ? `. ${fixFirst[0]}` : "";
    if (results.length === 0 && machineFailed === 0) {
      // "all clean" is a claim; a WARN or SKIP line printed above contradicts it.
      emitText(
        machineNotes === 0
          ? "doctor: all clean"
          : `doctor: no failures (${machineNotes} warning, info or skipped finding(s) above)`,
      );
    } else {
      emitText(
        showWouldFix
          ? `doctor: ${failingSummary(findings, lines)}, ${fixedCount} fixed (pass --fix --yes to apply)${tail}`
          : `doctor: ${failingSummary(findings, lines)}, ${fixedCount} fixed${tail}`,
      );
    }
    for (const text of fixFirst.slice(1)) emitText(text);
  }

  if (failed > 0) process.exit(1);
}
