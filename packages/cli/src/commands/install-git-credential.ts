// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// `repo-aegis install git-credential [--uninstall]` (doc/plan-owner-identity.md §5.6, §12.1 A6).
//
// Puts the repo-aegis credential helper in the user's GLOBAL git config as the FIRST helper git runs for
// https://github.com, and sets `credential.https://github.com.useHttpPath=true` so the helper sees
// `<owner>/<repo>`. "First" is checked, not assumed: a reset entry (`helper =`) wipes the entries before it, a
// system-scope helper runs before every global one, and `gh auth setup-git` appends. So:
//
//   - the helper is inserted AFTER the last global reset entry of `credential.https://github.com.helper`
//     (or before its first entry, or appended when there is none);
//   - the result is simulated first, and the install REFUSES, changing nothing, when another helper would
//     still answer first (a system-scope one, or a global generic one with no reset between);
//   - afterwards the real configuration is read back, and a wrong order is rolled back.
//
// `--uninstall` removes exactly what was added, recorded in a ledger under `<home>/state/`: the helper line
// (by exact value) and, when this install set it, `useHttpPath`. Nothing else in the config is touched.
//
// Both directions need a person at a terminal: removing the helper hands an agent's pushes to the person's own
// credential, so an agent must not be able to do it.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  appendAuditRecord,
  pinProblem,
  refusalTrailer,
  repoAegisHome,
  shellQuote,
  statePath,
  type EnforcementPin,
} from "@de-otio/repo-aegis-core";
import { currentEnforcementPin } from "../enforcement-pin.js";
import { emitError, emitJson, emitText, type OutputOptions } from "../format.js";
import {
  gitBinary,
  scopeLabel,
  helperOrder,
  HELPER_KEY,
  readCredentialConfig,
  USE_HTTP_PATH_KEY,
  withHelperInstalled,
} from "../git-credential-config.js";
import { requireTerminal, isHumanTerminal, type HumanTerminalOptions, type RequireTerminalOptions } from "../require-terminal.js";

export const GIT_CREDENTIAL_NEEDS_TTY = "GIT_CREDENTIAL_NEEDS_TTY";
export const GIT_CREDENTIAL_ORDER_REFUSED = "GIT_CREDENTIAL_ORDER_REFUSED";

/** A refusal with a stable code. */
export class GitCredentialInstallError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "GitCredentialInstallError";
  }
}

export interface InstallGitCredentialOptions extends OutputOptions, RequireTerminalOptions {
  uninstall?: boolean;
  /** Do the work, emit nothing. `uninstall` composes this command that way (and never exits the process). */
  silent?: boolean;
  /** The directory the local-scope config is read from. Default: the cwd. */
  cwd?: string;
  /** Test seam: the pin to render into the helper command. Not reachable from the CLI. */
  pin?: EnforcementPin;
  /** Test seam: the pinned home. Default: the repo-aegis home. */
  home?: string;
}

export interface GitCredentialInstallResult {
  action: "install-git-credential" | "uninstall-git-credential";
  changed: boolean;
  helper: string | null;
  reason?: string;
}

/** The helper as git is configured with it. `!` makes git run it through a shell, so every word is quoted. */
export function helperCommand(pin: EnforcementPin, home: string): string {
  return `!${shellQuote(pin.node)} ${shellQuote(pin.cli)} git-credential --home ${shellQuote(home)}`;
}

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

interface Ledger {
  version: 1;
  key: string;
  /** The helper line this install wrote (exact value). */
  value: string;
  /** False when the exact line was already in the config (the person's own), so uninstall leaves it. */
  helperAdded: boolean;
  /** `credential.https://github.com.useHttpPath`: whether this install set it, and what it was before. */
  useHttpPath: { set: boolean; previous: string | null };
}

export function ledgerPath(home: string): string {
  return join(statePath(home), "git-credential-install.json");
}

function readLedger(home: string): Ledger | null {
  try {
    const json = JSON.parse(readFileSync(ledgerPath(home), "utf8")) as Partial<Ledger>;
    if (json.version !== 1 || json.key !== HELPER_KEY || typeof json.value !== "string") return null;
    const u = json.useHttpPath;
    return {
      version: 1,
      key: HELPER_KEY,
      value: json.value,
      helperAdded: json.helperAdded === true,
      useHttpPath: { set: u?.set === true, previous: typeof u?.previous === "string" ? u.previous : null },
    };
  } catch {
    return null;
  }
}

function writeLedger(home: string, ledger: Ledger): void {
  const file = ledgerPath(home);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600 });
}

// ---------------------------------------------------------------------------
// git config --global
// ---------------------------------------------------------------------------

function git(args: readonly string[], cwd: string): { status: number; stdout: string } {
  try {
    const stdout = execFileSync(gitBinary(process.env), [...args], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return { status: 0, stdout };
  } catch (err) {
    const e = err as { status?: number | null };
    return { status: typeof e.status === "number" ? e.status : 128, stdout: "" };
  }
}

function must(args: readonly string[], cwd: string, what: string): string {
  const r = git(args, cwd);
  if (r.status !== 0) throw new GitCredentialInstallError("GIT_CONFIG_WRITE_FAILED", `could not ${what} (git exited ${r.status})`);
  return r.stdout;
}

const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const exact = (s: string): string => `^${escapeRegex(s)}$`;

function globalHelpers(cwd: string): string[] {
  const r = git(["config", "--global", "--get-all", HELPER_KEY], cwd);
  if (r.status === 1) return [];
  if (r.status !== 0) throw new GitCredentialInstallError("GIT_CONFIG_READ_FAILED", "could not read the global git config");
  return r.stdout.replace(/\n$/, "").split("\n");
}

function globalConfigFile(cwd: string): string {
  const r = git(["config", "--global", "--show-origin", "--get-all", HELPER_KEY], cwd);
  const first = r.stdout.split("\n")[0] ?? "";
  const m = /^file:(.*?)\t/.exec(first);
  if (m === null) throw new GitCredentialInstallError("GIT_CONFIG_READ_FAILED", "could not locate the global git config file");
  return m[1]!;
}

function userHelp(): string {
  return (
    "Either remove that helper from its config file (a system-scope helper needs an administrator), or add an " +
    `empty reset entry so git forgets the helpers before it for github.com: git config --global --add ${HELPER_KEY} ""   ` +
    "(add back, after the repo-aegis helper, any helper you still want), then run `repo-aegis install git-credential` again."
  );
}

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

function insertHelper(ours: string, existing: readonly string[], cwd: string): void {
  if (existing.length === 0) {
    must(["config", "--global", "--add", HELPER_KEY, ours], cwd, "add the helper to the global git config");
    return;
  }
  let lastReset = -1;
  existing.forEach((v, i) => {
    if (v === "") lastReset = i;
  });
  const tail = existing.slice(lastReset + 1);
  if (tail.length === 0) {
    must(["config", "--global", "--add", HELPER_KEY, ours], cwd, "add the helper to the global git config");
    return;
  }
  const all = [...tail, ours];
  if (new Set(all).size !== all.length || all.some(v => v.includes("\n"))) {
    throw new GitCredentialInstallError(
      GIT_CREDENTIAL_ORDER_REFUSED,
      `the global git config lists the same ${HELPER_KEY} helper more than once, so the helper cannot be inserted in front of it unambiguously. Remove the duplicate and run \`repo-aegis install git-credential\` again.`,
    );
  }
  // git cannot insert at a position, so shift: the first helper after the reset becomes ours, each later line takes
  // its predecessor's value, and the last value is appended. Other lines are not touched. A backup guards the steps.
  const file = globalConfigFile(cwd);
  const backup = readFileSync(file);
  try {
    must(["config", "--global", "--replace-all", HELPER_KEY, ours, exact(tail[0]!)], cwd, "insert the helper");
    for (let i = 1; i < tail.length; i++) {
      must(["config", "--global", "--replace-all", HELPER_KEY, tail[i - 1]!, exact(tail[i]!)], cwd, "insert the helper");
    }
    must(["config", "--global", "--add", HELPER_KEY, tail[tail.length - 1]!], cwd, "insert the helper");
  } catch (err) {
    writeFileSync(file, backup);
    throw err;
  }
}

function removeHelperLine(value: string, cwd: string): boolean {
  const r = git(["config", "--global", "--unset-all", HELPER_KEY, exact(value)], cwd);
  return r.status === 0;
}

function gate(opts: InstallGitCredentialOptions, verb: string): void {
  if (opts.silent === true) {
    const human: HumanTerminalOptions = opts;
    if (!isHumanTerminal(human)) {
      throw new GitCredentialInstallError(GIT_CREDENTIAL_NEEDS_TTY, `${verb} needs a person at a terminal`);
    }
    return;
  }
  requireTerminal(
    GIT_CREDENTIAL_NEEDS_TTY,
    `${verb}: refused. The credential helper decides which GitHub account an agent's pushes use, so only a person at a terminal can install or remove it. ` +
      `No approval covers this. A person runs \`repo-aegis install git-credential${opts.uninstall === true ? " --uninstall" : ""}\` from a terminal. ` +
      `Agents: do not retry or reroute; ask your human to run it. ${refusalTrailer(GIT_CREDENTIAL_NEEDS_TTY)}`,
    opts,
  );
}

export function doInstall(opts: InstallGitCredentialOptions): GitCredentialInstallResult {
  const cwd = opts.cwd ?? process.cwd();
  const home = resolve(opts.home ?? repoAegisHome());
  const pin = opts.pin ?? currentEnforcementPin();
  const problem = pinProblem(pin);
  if (problem !== null) throw new GitCredentialInstallError("PIN_UNUSABLE", problem);
  const ours = helperCommand(pin, home);

  const first = readCredentialConfig(cwd);
  if (first === null) throw new GitCredentialInstallError("GIT_CONFIG_READ_FAILED", "could not read the git config");

  const previous = readLedger(home);
  let changed = false;
  // A pin or home that moved: drop the old line first, then insert the new one in the right place.
  if (previous !== null && previous.helperAdded && previous.value !== ours && removeHelperLine(previous.value, cwd)) changed = true;
  // Our line is there but something answers before it (`gh auth setup-git` appends and reorders): take it out and put it back.
  let present = globalHelpers(cwd).includes(ours);
  if (present && helperOrder(readCredentialConfig(cwd) ?? first, ours).kind !== "first") {
    removeHelperLine(ours, cwd);
    present = false;
    changed = true;
  }

  let inserted = false;
  if (!present) {
    const base = readCredentialConfig(cwd) ?? first;
    // Simulate before touching anything: refuse when another helper would still answer first.
    const verdict = helperOrder(withHelperInstalled(base, ours), ours);
    if (verdict.kind === "behind") {
      throw new GitCredentialInstallError(
        GIT_CREDENTIAL_ORDER_REFUSED,
        `another credential helper for github.com would still answer before repo-aegis's: one in ${scopeLabel(verdict.precededBy.scope)} scope (${verdict.precededBy.value}). ${changed ? "" : "Nothing was changed. "}${userHelp()}`,
      );
    }
    insertHelper(ours, globalHelpers(cwd), cwd);
    inserted = true;
    changed = true;
  }
  const helperAdded = inserted || (previous !== null && previous.value === ours && previous.helperAdded);

  // Read it back: the real order, not the simulated one.
  const after = readCredentialConfig(cwd);
  const final = after === null ? null : helperOrder(after, ours);
  if (final === null || final.kind !== "first") {
    if (inserted) removeHelperLine(ours, cwd);
    throw new GitCredentialInstallError(
      GIT_CREDENTIAL_ORDER_REFUSED,
      `the repo-aegis helper is not the first credential helper for github.com after the install${final !== null && final.kind === "behind" ? ` (${scopeLabel(final.precededBy.scope)} scope answers first)` : ""}${inserted ? "; the change was rolled back" : ""}. ${userHelp()}`,
    );
  }

  // useHttpPath
  const raw = git(["config", "--global", "--get", USE_HTTP_PATH_KEY], cwd);
  const prevPath = raw.status === 0 ? raw.stdout.replace(/\n$/, "") : null;
  const asBool = git(["config", "--global", "--type=bool", "--get", USE_HTTP_PATH_KEY], cwd);
  let useHttpPath = previous?.useHttpPath ?? { set: false, previous: null };
  if (!(asBool.status === 0 && asBool.stdout.trim() === "true")) {
    must(["config", "--global", USE_HTTP_PATH_KEY, "true"], cwd, "set credential.useHttpPath");
    useHttpPath = { set: true, previous: prevPath };
    changed = true;
  }

  writeLedger(home, { version: 1, key: HELPER_KEY, value: ours, helperAdded, useHttpPath });
  return { action: "install-git-credential", changed, helper: ours };
}

export function doUninstall(opts: InstallGitCredentialOptions): GitCredentialInstallResult {
  const cwd = opts.cwd ?? process.cwd();
  const home = resolve(opts.home ?? repoAegisHome());
  const ledger = readLedger(home);
  if (ledger === null) {
    return { action: "uninstall-git-credential", changed: false, helper: null, reason: "no install ledger: nothing this command added is recorded" };
  }
  let changed = false;
  if (ledger.helperAdded && removeHelperLine(ledger.value, cwd)) changed = true;
  if (ledger.useHttpPath.set) {
    const now = git(["config", "--global", "--type=bool", "--get", USE_HTTP_PATH_KEY], cwd);
    if (now.status === 0 && now.stdout.trim() === "true") {
      if (ledger.useHttpPath.previous === null) git(["config", "--global", "--unset-all", USE_HTTP_PATH_KEY], cwd);
      else git(["config", "--global", USE_HTTP_PATH_KEY, ledger.useHttpPath.previous], cwd);
      changed = true;
    }
  }
  rmSync(ledgerPath(home), { force: true });
  return { action: "uninstall-git-credential", changed, helper: ledger.value };
}

/** The command. Exits through `emitError` on a refusal, unless `silent` (then it throws). */
export function installGitCredential(opts: InstallGitCredentialOptions): GitCredentialInstallResult {
  const verb = opts.uninstall === true ? "install git-credential --uninstall" : "install git-credential";
  gate(opts, verb);
  let result: GitCredentialInstallResult;
  try {
    result = opts.uninstall === true ? doUninstall(opts) : doInstall(opts);
  } catch (err) {
    if (opts.silent === true) throw err;
    if (err instanceof GitCredentialInstallError) emitError({ code: err.code, error: err.message }, opts);
    throw err;
  }
  try {
    appendAuditRecord({ action: result.action, details: { changed: result.changed } });
  } catch {
    /* audit log must not break user-facing ops */
  }
  if (opts.silent === true) return result;
  if (opts.json === true) {
    emitJson(result);
    return result;
  }
  if (result.action === "install-git-credential") {
    emitText(result.changed ? "installed the repo-aegis git credential helper (first for https://github.com) and set credential.useHttpPath." : "the repo-aegis git credential helper was already installed and first.");
    emitText("An agent's HTTPS push to an owner with an agent identity now gets a token narrowed to that repository.");
  } else {
    emitText(result.changed ? "removed what `install git-credential` added." : `nothing to remove${result.reason !== undefined ? `: ${result.reason}` : ""}.`);
  }
  return result;
}

/** For `repo-aegis uninstall`: true when a ledger says there is something to remove. */
export function gitCredentialInstalled(home: string = repoAegisHome()): boolean {
  return existsSync(ledgerPath(resolve(home)));
}
