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
