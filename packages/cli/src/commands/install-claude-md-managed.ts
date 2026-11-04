// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// `install claude-md` for the managed-settings drop-in
// (doc/plan-pin-enforcement-binary.md D8.3, D8.6, P3 to P7): choosing the target,
// planning and validating the file, and the person-in-the-loop write.
//
// The order is fixed because each step protects the next: choose the target
// (fall back to the user file where there is no managed location), render and
// validate in-process (P5), refuse on an unsafe `sudo` or directory (P1, P4),
// require a terminal and a typed `y` after showing the person the path, size,
// digest and diff, write the ledger, and only then ask root to write. The
// password prompt of `sudo` is the control; the terminal check is a convenience.
import { emitError, type OutputOptions } from "../format.js";
import { confirmOnTerminal, requireTerminal, type ConfirmOptions } from "../require-terminal.js";
import {
  digestOf,
  lineDiff,
  managedPaths,
  renderDropIn,
  validateDropIn,
  type DropInSpec,
  type ManagedPaths,
} from "./managed-dropin.js";
import {
  fileProblem,
  resolveManagedEnv,
  sudoRmLine,
  verifyDirectoryChain,
  verifyPrivilegedTools,
  writeDropIn,
  type CreatedDirs,
  type ManagedEnv,
} from "./managed-privileged.js";
import { readManagedLedger, removeManagedLedger, writeManagedLedger, type ManagedLedger } from "./managed-ledger.js";
import type { EnforcementPin } from "@de-otio/repo-aegis-core";

/** Test seams for the managed path; honoured only under the Node test runner. */
export interface ManagedSeams {
  env?: Partial<ManagedEnv>;
  terminal?: ConfirmOptions;
}

export type ManagedTarget =
  | { kind: "managed"; env: ManagedEnv; paths: ManagedPaths }
  | { kind: "user"; note: string | null };

/**
 * Where enforcement goes. `--user-settings` is the person's choice (D8.6). Where
 * there is no managed location (an unsupported platform), the account is root
 * (containers, devcontainers: there is no `sudo` step to take), or `/usr/bin/id`
 * is missing so the uid guard cannot be written (NixOS, Guix), the user file is
 * used and the note says why.
 */
export function chooseTarget(opts: { userSettings?: boolean; managed?: ManagedSeams }): ManagedTarget {
  if (opts.userSettings) return { kind: "user", note: null };
  const env = resolveManagedEnv(opts.managed?.env);
  if (env.uid === 0) {
    return { kind: "user", note: "running as root: there is no root step to take, so the Claude Code hooks go in the user settings file" };
  }
  const paths = managedPaths(env.platform, env.uid);
  if (paths === null) {
    return { kind: "user", note: `this platform (${env.platform}) has no Claude Code managed-settings location, so the hooks go in the user settings file` };
  }
  const id = verifyPrivilegedTools(env).find(p => p.tool === "id");
  if (id?.missing === true) {
    return { kind: "user", note: `${id.path} is missing, so the uid guard cannot be written; the hooks go in the user settings file` };
  }
  return { kind: "managed", env, paths };
}

/** Everything decided before any prompt: the file, its digest and what it changes. */
export interface ManagedPlan {
  spec: DropInSpec;
  text: string;
  digest: string;
  bytes: number;
  /** The file as it is now, or null when there is none. */
  current: string | null;
  /** The current file is exactly this text, with the right owner and mode: nothing to do. */
  unchanged: boolean;
  diff: string[];
}

/** True when the drop-in on disk already registers the SessionStart `first-touch` hook. */
function hasFirstTouch(text: string | null): boolean {
  return text !== null && text.includes(" hook first-touch");
}

/**
 * Render and validate the drop-in (P5). Refuses (exit 2, `DROPIN_INVALID`) rather
 * than returning an invalid text: whatever it returns is safe to hand to root.
 */
export function planManagedInstall(
  env: ManagedEnv,
  paths: ManagedPaths,
  input: { pin: EnforcementPin; firstTouch: boolean; denyRules: readonly string[] },
  out: OutputOptions,
): ManagedPlan {
  const current = env.fs.read(paths.file);
  const spec: DropInSpec = {
    pin: input.pin,
    uid: String(env.uid),
    file: paths.file,
    firstTouch: input.firstTouch || hasFirstTouch(current),
    denyRules: input.denyRules,
  };
  let text: string;
  try {
    text = renderDropIn(spec);
  } catch (err) {
    return emitError({ code: "DROPIN_INVALID", error: `cannot render the managed drop-in: ${(err as Error).message}` }, out);
  }
  const problem = validateDropIn(text, spec);
  if (problem !== null) {
    return emitError(
      {
        code: "DROPIN_INVALID",
        error: `the managed drop-in failed validation, so nothing was written as root: ${problem}`,
        details: "a path with a newline in it cannot be put in a managed rule; use `repo-aegis install claude-md --user-settings` or fix the path",
      },
      out,
    );
  }
  const digest = digestOf(text);
  const unchanged = current === text && fileProblem(env, paths.file, digest) === null;
  return { spec, text, digest, bytes: Buffer.byteLength(text), current, unchanged, diff: lineDiff(current ?? "", text) };
}

const USER_SETTINGS_WAY_OUT =
  "to put the hooks in your own settings file instead, run `repo-aegis install claude-md --user-settings` (doctor then warns ENFORCEMENT_IN_USER_SETTINGS)";

/** What the person is shown before `sudo` asks for a password. */
function summaryFor(plan: ManagedPlan, paths: ManagedPaths, uid: number): string {
  const lines = [
    `repo-aegis will write a Claude Code managed-settings drop-in as root, for uid ${uid}:`,
    `  file:   ${paths.file}`,
    `  size:   ${plan.bytes} bytes`,
    `  sha256 ${plan.digest}`,
    plan.current === null ? "  this is a new file; its content is:" : "  changes against the current file:",
    ...(plan.current === null ? lineDiff("", plan.text) : plan.diff).map(l => `    ${l}`),
    "sudo will ask for your password next. Only a person at this terminal should continue.",
  ];
  return lines.join("\n");
}

export interface ManagedApplied {
  /** The directories this run created. */
  created: CreatedDirs;
  /** False when the file was already exactly right and nothing ran as root. */
  wrote: boolean;
}

/**
 * Put `plan.text` in place (or do nothing, when it is already there). Every
 * refusal happens before `sudo`: an unsafe tool or directory (P1, P4), no
 * terminal, no `y`. The ledger is written before the privileged write; a failure
 * that leaves no file and no new directory restores the previous ledger. Exits 1
 * when a root step fails (P3) or the read-back differs (P6).
 */
export function applyManagedInstall(
  env: ManagedEnv,
  paths: ManagedPaths,
  plan: ManagedPlan,
  terminal: ConfirmOptions,
  out: OutputOptions,
): ManagedApplied {
  if (plan.unchanged) return { created: { system: false, dropin: false }, wrote: false };

  requireTerminal(
    "MANAGED_NEEDS_TTY",
    "the managed drop-in is written as root, and that needs a person at a terminal: this shell has no TTY on stderr. " +
      "Run `repo-aegis install claude-md` from your own terminal. (An agent must not do this: sudo asks for your password, and that prompt is the control.)",
    { ...terminal, ...out },
  );

  const toolIssue = verifyPrivilegedTools(env).filter(p => !(p.tool === "id" && p.missing));
  if (toolIssue.length > 0) {
    emitError(
      {
        code: "PRIVILEGED_TOOL_UNSAFE",
        error: `refusing to run sudo: ${toolIssue.map(p => `${p.path}: ${p.reason}`).join("; ")}`,
        details: `nothing was run as root; ${USER_SETTINGS_WAY_OUT}`,
      },
      out,
    );
  }
  const dirIssue = verifyDirectoryChain(env, paths);
  if (dirIssue !== null) {
    emitError(
      {
        code: "SYSTEM_DIR_UNSAFE",
        error: `refusing to write below ${paths.systemDir}: ${dirIssue}`,
        details: `a directory a non-root user controls would let that user redirect a root write; nothing was run as root. ${USER_SETTINGS_WAY_OUT}`,
      },
      out,
    );
  }

  if (!confirmOnTerminal(summaryFor(plan, paths, env.uid), "Write this file as root?", { ...terminal, ...out })) {
    emitError({ code: "MANAGED_NOT_CONFIRMED", error: "not confirmed: nothing was written" }, out);
  }

  // The ledger first: the digest and the directories this run is about to create.
  const prior = readManagedLedger();
  const sysAbsent = env.fs.lstat(paths.systemDir) === null;
  const dropAbsent = env.fs.lstat(paths.dropinDir) === null;
  const planned: ManagedLedger = {
    version: 1,
    uid: String(env.uid),
    file: paths.file,
    digest: plan.digest,
    installedAt: new Date().toISOString(),
    createdDirs: {
      system: (prior?.createdDirs.system ?? false) || sysAbsent,
      dropin: (prior?.createdDirs.dropin ?? false) || dropAbsent,
    },
    legacyFile: prior?.legacyFile ?? false,
  };
  try {
    writeManagedLedger(planned);
  } catch (err) {
    emitError({ code: "FS_ERROR", error: `failed to record the managed install under the state directory: ${(err as Error).message}` }, out);
  }

  const result = writeDropIn(env, paths, plan.text);
  const dirs = (c: CreatedDirs): CreatedDirs => ({
    system: (prior?.createdDirs.system ?? false) || c.system,
    dropin: (prior?.createdDirs.dropin ?? false) || c.dropin,
  });
  if (!result.ok) {
    // A failed read-back means the new file is in place: its digest stays in the
    // ledger. Any earlier failure left the file as it was, so the old record is
    // restored, with the directories this run did create; no record at all if
    // there is nothing of ours on disk.
    const placed = result.step === "read-back";
    const createdNow = dirs(result.created);
    try {
      if (placed) writeManagedLedger({ ...planned, createdDirs: createdNow });
      else if (prior === null && !createdNow.system && !createdNow.dropin) removeManagedLedger();
      else writeManagedLedger({ ...(prior ?? planned), createdDirs: createdNow });
    } catch {
      /* a stale ledger only makes doctor say so */
    }
    process.stderr.write(`repo-aegis: ${result.message}\n`);
    if (!placed) process.stderr.write(`repo-aegis: if anything was left at ${paths.file}, remove it with: ${sudoRmLine(paths.file)}\n`);
    process.exit(1);
  }

  // Record what this run really created (a directory that was there already is not ours).
  const created: CreatedDirs = result.created;
  try {
    writeManagedLedger({ ...planned, createdDirs: dirs(created) });
  } catch {
    /* the first ledger write already recorded the digest */
  }
  return { created, wrote: true };
}
