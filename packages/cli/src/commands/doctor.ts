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
  loadRegistry,
  RegistryEncryptedError,
  RegistryNotFoundError,
  type HookState,
  type HookStateCode,
  type Registry,
} from "@de-otio/repo-aegis-core";
import { emitJson, emitText, type OutputOptions } from "../format.js";
import { findWorkingTrees, defaultScanRoots } from "../repo-walk.js";
import { currentEnforcementPin } from "../enforcement-pin.js";
import { checkLabel, isFailure, isReportable, PERSON_RUNS_THIS, type DoctorCheck } from "./doctor-checks.js";
import { checkShim } from "./install-shim.js";
import { checkGuardHook, checkRegistryAgentWritable } from "./install-claude-md.js";
import { ghOwnerChecks, registryStateChecks, type DoctorRegistryState, type GhCheckOptions } from "./doctor-owner-checks.js";
import { checkPrePushHook, checkShellStartupOverrides, checkSshGithubRedirect } from "./doctor-env-checks.js";

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
  /** Test seam: what the global `core.hooksPath` holds, for `PREPUSH_HOOK_MISSING`. */
  readGlobalHooksPath?: () => string | null;
}

export interface DoctorRepoResult {
  workingTree: string;
  code: HookStateCode;
  ok: boolean;
  effectivePath: string | null;
  shadowedRepoHooks: string[];
  /** Subset of the above that repo-aegis does not chain, i.e. genuinely never runs. */
  bypassedRepoHooks: string[];
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
    detail:
      "global push.default is unset or not `nothing`, so a bare `git push` picks a " +
      "destination for you — in the wrong checkout that publishes a branch you did not name",
    fix: "git config --global push.default nothing",
  };
}

/** Machine-level checks: once per run, independent of any repo. */
/** Checkouts recorded into the destination cache by this run (reset per `doctor()` call). */
let recordedDestinations = 0;

/** How the registry looked to this run, for the owner checks. */
interface RegistryLoad {
  state: DoctorRegistryState;
  registry: Registry | null;
  /** Unreadable because it is encrypted at rest (changes the fix). */
  encrypted: boolean;
}

/**
 * Best-effort, and the three states are different findings (decision D4): no
 * file is not a finding (rule h is skipped by design), a file that exists but
 * cannot be read IS (rule h then refuses everything), a loaded registry is
 * compared against `gh`. Anything that is not "not found" counts as unreadable,
 * the same classification the hook, the shim and pre-push use.
 */
function loadRegistryForDoctor(): RegistryLoad {
  try {
    return { state: "loaded", registry: loadRegistry(), encrypted: false };
  } catch (err) {
    if (err instanceof RegistryNotFoundError) return { state: "missing", registry: null, encrypted: false };
    return { state: "unreadable", registry: null, encrypted: err instanceof RegistryEncryptedError };
  }
}

function machineChecks(opts: DoctorOptions, reg: RegistryLoad): DoctorCheck[] {
  const checks = [checkPushDefault(), ...checkShim(), ...checkGuardHook(opts.claudeHome)];
  checks.push(...registryStateChecks(reg.state, reg.registry, reg.encrypted));
  // With no registry there is nothing to protect and nothing to compare gh against.
  if (reg.state !== "missing") checks.push(checkRegistryAgentWritable(opts.claudeHome));
  if (reg.state === "loaded" && reg.registry !== null) {
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
    detail: resolved
      ? "class is explicit and GitHub visibility is cached"
      : "no explicit class and/or no cached GitHub visibility, so every destination-aware check is inert in this repo",
    ...(resolved ? {} : { fix: "repo-aegis classify --apply && repo-aegis status  (run in that repo)" }),
  });

  if (registry !== null) {
    const known =
      (registry.personalOrgs ?? []).some(o => o.toLowerCase() === org) ||
      registry.engagements.some(e => (e.githubOrgs ?? []).some(o => o.toLowerCase() === org));
    out.push({
      code: "PERSONAL_ORG_UNREGISTERED",
      ok: known,
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
    : { state: "missing", registry: null, encrypted: false };
  const registry = regLoad.registry;
  const machine = egressChecksOn ? machineChecks(opts, regLoad) : [];

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
        fixed,
        checks,
      });
    }
  }

  // R11, after the sweep and any `--fix`: one machine-level setting, not a
  // per-repo property. `checkGuardHook` is the same answer the machine checks
  // above reported, so a missing guard hook is not double-reported.
  if (egressChecksOn) {
    const guardRegistered = checkGuardHook(opts.claudeHome).every(c => c.ok);
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
    emitText(`doctor: scanned ${scanned} repo(s) under ${roots.join(", ")}`);
    if (egressChecksOn) {
      emitText(`doctor: recorded ${recordedDestinations} checkout(s) into the destination cache`);
    }
    for (const c of machine) {
      if (!isReportable(c)) continue;
      emitText(`  ${checkLabel(c)} ${c.code} — ${c.detail}`);
      if (c.fix !== undefined) emitText(`       fix: ${c.fix}`);
    }
    const machineNotes = machine.filter(c => isReportable(c) && !isFailure(c)).length;
    if (results.length === 0 && machineFailed === 0) {
      // "all clean" is a claim; a WARN or SKIP line printed above contradicts it.
      emitText(
        machineNotes === 0
          ? "doctor: all clean"
          : `doctor: no failures (${machineNotes} warning, info or skipped finding(s) above)`,
      );
    } else {
      for (const r of results) {
        const tag = r.fixed ? " [fixed]" : showWouldFix ? " [would fix]" : "";
        emitText(`  ${repoIsFailing(r) ? "FAIL" : "WARN"} ${r.workingTree}  code=${r.code}${tag}`);
        if (r.bypassedRepoHooks.length > 0) {
          emitText(`       repo-local hooks that never run: ${r.bypassedRepoHooks.join(", ")}`);
        }
        for (const c of r.checks) {
          if (!isReportable(c)) continue;
          emitText(`       ${checkLabel(c)} ${c.code} — ${c.detail}`);
          if (c.fix !== undefined) emitText(`            fix: ${c.fix}`);
        }
      }
      emitText(
        showWouldFix
          ? `doctor: ${failed} failing, ${fixedCount} fixed (pass --fix --yes to apply)`
          : `doctor: ${failed} failing, ${fixedCount} fixed`,
      );
    }
  }

  if (failed > 0) process.exit(1);
}
