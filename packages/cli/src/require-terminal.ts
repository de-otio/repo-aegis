// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// The human-presence gate shared by every command that only a person may run:
// `approve` (mint) and the registry owner adds (`engagements add
// --personal-org|--github-org`, `init --migrate-classify`, `upstreams add`).
//
// The test is "stderr is a TTY", full stop. `REPO_AEGIS_EGRESS_HUMAN` and
// `REPO_AEGIS_WAIVE_NONINTERACTIVE` are deliberately NOT honoured: they are
// one-invocation declarations for the egress guard, and an agent that set one
// to mint an approval or register an owner would have turned them into a
// standing grant.
//
// The TTY test is a speed bump, not proof of a person (issue #151, PR 2b): a
// pty wrapper (`script`, `unbuffer`, `expect`, `python -c 'import pty…'`,
// `ssh -tt localhost`) gives an agent's child a terminal. So `isHumanTerminal()`
// below also reads the process chain (core/process-ancestry.ts) and says no when
//   - an agent host (`claude`, `codex`, `gemini`) or a pty wrapper sits above
//     this process, or the Claude Code environment (`CLAUDECODE=1`) is set; or
//   - the chain does not reach a POSITIVE ROOT (a login session, sshd, a terminal
//     emulator, an attached tmux/screen): a pty re-parented to launchd by a
//     double fork + `setsid` ends at init through a bare interpreter; or
//   - the chain cannot be read at all.
// Every caller picks it up at once; do not add a second check at a call site.
//
// Policy for these gates, which differs from rules g/h on purpose: if the
// ancestry CANNOT be read (no `/proc`, `ps` unavailable or blocked, as inside an
// agent's sandbox) or has no positive root, the answer is "not a person".
// Minting an approval or registering an owner is the thing an agent must never
// do for itself, and a person at a normal terminal always has a readable process
// table with a login or emulator at its root. (Rules g/h make the opposite
// choice, because refusing a person's own publish is the worse failure there.)
//
// `stderrIsTTY` / `ancestry` are TEST-ONLY seams, ignored outside the Node test
// runner (core `testSeamsEnabled`): no production call can skip the check.
//
// RESIDUAL: an agent with code execution can still `osascript` / AppleScript
// `do script` a command into the user's own terminal window, or start a
// detached process outside its own tree (`launchctl submit`, `at`, cron) that
// owns a pty; `ssh -tt localhost` has an sshd root. The agent hook's text-level
// refusals (`AGENT_RAN_HUMAN_COMMAND`, `EGRESS_PTY_WRAPPER`,
// `AGENT_DETACHED_SESSION`) cover the shapes it can read; the rest needs a
// presence signal an agent cannot forge (a Keychain item with a user-presence
// ACL / Touch ID), which is tracked as a follow-up.
import { readSync } from "node:fs";
import { checkTerminal, type AncestryReader, type ExeResolver, type MultiplexerProbe } from "@de-otio/repo-aegis-core";
import { emitError, type OutputOptions } from "./format.js";

export interface HumanTerminalOptions {
  /** TEST-ONLY (ignored outside the test runner): defaults to `process.stderr.isTTY`. Injecting it without `ancestry` skips the chain, as the existing seam tests expect. */
  stderrIsTTY?: boolean;
  /** TEST-ONLY: a synthetic process chain (nearest parent first). Defaults to the real process tree. */
  ancestry?: AncestryReader;
  /** TEST-ONLY: environment for the Claude Code signal (default `{}` for a synthetic chain, else `process.env`). */
  env?: NodeJS.ProcessEnv;
  /** TEST-ONLY: tmux/screen attached-client probe. */
  probe?: MultiplexerProbe;
  /** TEST-ONLY: resolves a process's real executable path (emulator roots). */
  resolveExe?: ExeResolver;
}

export interface RequireTerminalOptions extends OutputOptions, HumanTerminalOptions {}

export type TerminalVerdict =
  | { human: true }
  | { human: false; why: "no-tty" }
  | { human: false; why: "agent-ancestor"; ancestor: string; via?: "env" }
  | { human: false; why: "no-positive-root" }
  | { human: false; why: "ancestry-undeterminable" };

/** Why this process is, or is not, behind a person's terminal. */
export function terminalVerdict(opts: HumanTerminalOptions = {}): TerminalVerdict {
  const check = checkTerminal({
    ...(opts.stderrIsTTY !== undefined && { stderrIsTTY: opts.stderrIsTTY }),
    ...(opts.ancestry !== undefined && { ancestry: opts.ancestry }),
    ...(opts.env !== undefined && { env: opts.env }),
    ...(opts.probe !== undefined && { probe: opts.probe }),
    ...(opts.resolveExe !== undefined && { resolveExe: opts.resolveExe }),
  });
  switch (check.kind) {
    case "no-tty":
      return { human: false, why: "no-tty" };
    case "skipped":
    case "clear":
      return { human: true };
    case "agent":
      return { human: false, why: "agent-ancestor", ancestor: check.ancestor, ...(check.via !== undefined && { via: check.via }) };
    case "unrooted":
      return { human: false, why: "no-positive-root" };
    case "undeterminable":
      return { human: false, why: "ancestry-undeterminable" };
  }
}

/**
 * True when this process is attached to a person's terminal: stderr is a TTY,
 * no agent host or pty wrapper is an ancestor, and the chain reaches a login
 * session, terminal emulator or attached multiplexer. The one place to harden.
 */
export function isHumanTerminal(opts: HumanTerminalOptions = {}): boolean {
  return terminalVerdict(opts).human;
}

/** The sentence added to a refusal when a terminal IS attached but is not trusted. */
function ancestryNote(v: TerminalVerdict): string {
  if (v.human || v.why === "no-tty") return "";
  if (v.why === "agent-ancestor" && v.via === "env") {
    return (
      " A terminal is attached, but the environment says this shell belongs to Claude Code (CLAUDECODE=1 or " +
      "CLAUDE_CODE_ENTRYPOINT is set). That also happens in your own terminal when a tmux server or a shell was started " +
      "from inside Claude Code: every new pane inherits it. If this is your own terminal, open a fresh terminal window " +
      "(or unset both variables in this shell) and run it there."
    );
  }
  if (v.why === "agent-ancestor") {
    return (
      ` A terminal is attached, but it runs under ${v.ancestor}, an agent host or terminal wrapper, so it is not ` +
      `treated as a person's. Run this in your own terminal window.`
    );
  }
  if (v.why === "no-positive-root") {
    return (
      " A terminal is attached, but its process chain ends at the system's init process without passing through a " +
      "login session, a terminal emulator or an attached tmux/screen, which is what a detached or double-forked " +
      "pty looks like, so it is not treated as a person's. Run this in your own terminal window."
    );
  }
  return (
    " A terminal is attached, but repo-aegis could not read the process list to confirm that no agent runs it " +
    "(a sandbox without `ps` does this). Run this in your own terminal window, outside any agent sandbox."
  );
}

/**
 * Refuse (exit 2, error `code`) unless a terminal is attached. Returns only
 * when a terminal is present, so callers put it before any validation that
 * could act as an oracle and before any write.
 */
export function requireTerminal(
  code: string,
  message: string,
  opts: RequireTerminalOptions = {},
): void {
  const verdict = terminalVerdict(opts);
  if (verdict.human) return;
  emitError({ code, error: message + ancestryNote(verdict) }, opts);
}

export interface ConfirmOptions extends RequireTerminalOptions {
  /** Test seam: defaults to `process.stdin.isTTY`. */
  stdinIsTTY?: boolean;
  /** Test seam: returns the typed answer. Defaults to a blocking read of one line from stdin. */
  readAnswer?: () => string;
}

function readLineFromStdin(): string {
  const buf = Buffer.alloc(1);
  let line = "";
  try {
    // One byte at a time so nothing past the newline is consumed.
    while (line.length < 64) {
      const n = readSync(0, buf, 0, 1, null);
      if (n === 0) break;
      const ch = buf.toString("utf8");
      if (ch === "\n") break;
      line += ch;
    }
  } catch {
    return "";
  }
  return line;
}

/**
 * Show `summary` on stderr and ask `question` [y/N], reading the answer from a
 * stdin TTY. Returns true only for an explicit "y"/"yes". When stdin is not a
 * terminal there is no one to ask, so nothing is confirmed: callers abort.
 *
 * Exists so a person approves what will be written, not a count they never
 * saw: an agent can plant the input (a classify.yml rule), and a bare TTY
 * check on the command would let the human approve something blind.
 */
export function confirmOnTerminal(summary: string, question: string, opts: ConfirmOptions = {}): boolean {
  if (!(opts.stdinIsTTY ?? !!process.stdin.isTTY)) return false;
  process.stderr.write(`${summary}\n${question} [y/N] `);
  const answer = (opts.readAnswer ?? readLineFromStdin)().trim().toLowerCase();
  process.stderr.write("\n");
  return answer === "y" || answer === "yes";
}
