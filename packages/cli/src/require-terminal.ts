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
// SEAM (issue #151, PR 2b): the TTY test is a speed bump, not proof of a
// person. A pty wrapper (`script`, `tmux new -d`, ...) gives a child a
// terminal. The planned hardening (walk the process ancestry and refuse when
// an agent host is an ancestor) belongs in `isHumanTerminal()` below, so every
// caller picks it up at once. Do not add a second check at a call site.
import { readSync } from "node:fs";
import { emitError, type OutputOptions } from "./format.js";

export interface RequireTerminalOptions extends OutputOptions {
  /** Test seam: defaults to `process.stderr.isTTY`. */
  stderrIsTTY?: boolean;
}

/** True when this process is attached to a person's terminal. The one place to harden. */
export function isHumanTerminal(opts: { stderrIsTTY?: boolean } = {}): boolean {
  return opts.stderrIsTTY ?? !!process.stderr.isTTY;
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
  if (isHumanTerminal(opts)) return;
  emitError({ code, error: message }, opts);
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
