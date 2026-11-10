// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// `repo-aegis pause [--for <duration>] [--repo <owner>/<repo>] [--reason <text>]`, `pause --list` and `resume`:
// the person-only, time-boxed emergency pause (complexity-review P1-E; core `pause.ts` has the design notes and the
// one reader every entry point calls).
//
// WHO MAY DO WHAT, because this is a global off switch:
//   - `pause` (create or extend) needs a person's terminal, exactly like `approve`: a TTY on stderr and no agent
//     host or pty wrapper above this process (`PAUSE_NEEDS_TTY`). `REPO_AEGIS_EGRESS_HUMAN` is NOT honoured, for
//     the reason `approve` gives. It is also on the human-only list in core/human-commands.ts, so the egress guard
//     refuses an agent whose command text runs it, paused or not. `pause --list` is covered by the same text rule
//     (its output can name a repository, which can be a customer's).
//   - `resume` has no terminal gate and the egress guard lets an agent run it. It can only turn protection back on,
//     and what it prints names no scope. An agent that resumes a pause its person set costs that person a refusal,
//     never a leak, and they can pause again.
//
// A pause always expires (default 1h, cap 8h: `PAUSE_TOO_LONG`). Nothing deletes an expired file when it is only
// READ (a hook may be sandboxed read-only); the commands here do, and record the `resume` the audit trail owes.
import {
  appendAuditRecord,
  clearPause,
  DEFAULT_PAUSE_MS,
  MAX_PAUSE_MS,
  mintPause,
  parsePauseRepo,
  parseTtl,
  pauseNotice,
  pausePath,
  readPause,
  type PauseState,
} from "@de-otio/repo-aegis-core";
import { USAGE_AFTER_TERMINAL_GATE } from "@de-otio/repo-aegis-core";
import { emitJson, emitText, emitError, type OutputOptions } from "../format.js";
import { requireTerminal, type RequireTerminalOptions } from "../require-terminal.js";

export interface PauseOptions extends OutputOptions, RequireTerminalOptions {
  for?: string;
  repo?: string;
  reason?: string;
  list?: boolean;
  /** Test seam: the pause file. */
  path?: string;
  /** Test seam: the clock. */
  now?: () => Date;
}

export interface ResumeOptions extends OutputOptions {
  /** Test seam: the pause file. */
  path?: string;
  /** Test seam: the clock. */
  now?: () => Date;
}

function auditBestEffort(action: "pause" | "resume", details: Record<string, unknown>): void {
  try {
    appendAuditRecord({ action, cwd: process.cwd(), details });
  } catch {
    /* audit must not break the operation */
  }
}

const scopeOf = (s: PauseState): string => s.repo ?? "all";

/**
 * An expired pause file is retired by a command a person (or an agent's `resume`) runs: the `resume` record the audit
 * trail owes for an expiry is written here, once, and the file goes. Never called from an entry point that only reads.
 */
function retireExpired(path: string, state: PauseState): void {
  auditBestEffort("resume", { cause: "expired", scope: scopeOf(state), expiredAt: state.expiresAt });
  clearPause(path);
}

function describe(s: PauseState): string {
  return `${s.repo === undefined ? "everything on this machine" : s.repo} until ${s.expiresAt} (set ${s.createdAt} by ${s.by})`;
}

export function pause(opts: PauseOptions): void {
  const path = opts.path ?? pausePath();
  const now = (opts.now ?? (() => new Date()))();

  if (opts.list) {
    const r = readPause({ path, now });
    if (r.kind === "expired") retireExpired(path, r.state);
    if (opts.json) {
      emitJson({ action: "pause", active: r.kind === "active" ? r.state : null, ...(r.kind === "invalid" && { ignored: "pause.json fails its checks" }) });
    } else if (r.kind === "active") {
      emitText(`repo-aegis pause: paused for ${describe(r.state)}; resume: repo-aegis resume`);
    } else if (r.kind === "invalid") {
      emitText("repo-aegis pause: no active pause (a pause.json is there but fails its owner, mode, date or shape checks, so it is ignored)");
    } else {
      emitText("repo-aegis pause: no active pause");
    }
    return;
  }

  // ---- create ---------------------------------------------------------------
  // The gate first, before any validation that could act as an oracle and before any write.
  requireTerminal(
    "PAUSE_NEEDS_TTY",
    "a pause can only be set from a terminal: this shell has no TTY on stderr. " +
      "(REPO_AEGIS_EGRESS_HUMAN is not honoured here — an agent must never switch repo-aegis off for itself.)",
    opts,
  );

  let durationMs = DEFAULT_PAUSE_MS;
  if (opts.for !== undefined) {
    const t = parseTtl(opts.for);
    if (t === null) emitError({ code: "USAGE", error: `--for must be like 30m, 2h, 90s (got ${JSON.stringify(opts.for)})` }, opts, USAGE_AFTER_TERMINAL_GATE);
    if (t > MAX_PAUSE_MS) {
      emitError(
        {
          code: "PAUSE_TOO_LONG",
          error:
            "--for may not exceed 8h: a pause is for a deadline, and there is no 'until further notice'. " +
            "Pause again when it ends if you still need it.",
        },
        opts,
      );
    }
    durationMs = t;
  }
  let repo: string | undefined;
  if (opts.repo !== undefined) {
    const parsed = parsePauseRepo(opts.repo);
    if (parsed === null) {
      emitError({ code: "USAGE", error: `--repo must be <owner>/<repo> (got ${JSON.stringify(opts.repo)}); there is no wildcard scope` }, opts, USAGE_AFTER_TERMINAL_GATE);
    }
    repo = parsed;
  }
  const reasonLength = opts.reason === undefined ? 0 : opts.reason.length;

  // An earlier pause that ran out has its `resume` record owed before this one replaces the file.
  const before = readPause({ path, now });
  if (before.kind === "expired") auditBestEffort("resume", { cause: "expired", scope: scopeOf(before.state), expiredAt: before.state.expiresAt });

  const state = mintPause({ durationMs, ...(repo !== undefined && { repo }), reasonLength, path, now });
  // The reason's text is never stored or logged: its length is the whole record, so a customer name typed into it
  // cannot reach the audit log.
  auditBestEffort("pause", {
    scope: scopeOf(state),
    expiresAt: state.expiresAt,
    reasonLength,
    ...(before.kind === "active" && { replaced: true }),
  });

  if (opts.json) {
    emitJson({ action: "pause", pause: state });
    return;
  }
  emitText(`repo-aegis pause: paused for ${describe(state)}`);
  emitText(`  ${pauseNotice(state)}`);
  emitText(
    "  while paused, the hooks, the egress guard, the gh shim and the git credential helper stand aside for " +
      (state.repo === undefined ? "everything except the cross-org checks, which stay on" : "that repository, cross-org checks included") +
      "; marker scans after a write still report, as advice. approve, pause, identity changes and uninstall stay person-only.",
  );
}

export function resume(opts: ResumeOptions): void {
  const path = opts.path ?? pausePath();
  const now = (opts.now ?? (() => new Date()))();
  const r = readPause({ path, now });

  // What it prints names no scope: an agent may run this, and a scope can be a customer's repository.
  if (r.kind === "none") {
    if (opts.json) emitJson({ action: "resume", resumed: false });
    else emitText("repo-aegis resume: no pause is active");
    return;
  }
  const removed = clearPause(path);
  if (!removed) {
    emitError(
      {
        code: "PAUSE_NOT_REMOVED",
        error: "the pause file could not be removed (permissions); a person removes it from their own terminal with `repo-aegis resume`",
      },
      opts,
    );
  }
  if (r.kind === "active") auditBestEffort("resume", { cause: "resume", scope: scopeOf(r.state) });
  else if (r.kind === "expired") auditBestEffort("resume", { cause: "expired", scope: scopeOf(r.state), expiredAt: r.state.expiresAt });
  // `invalid` was never a pause: nothing to record, and it is gone.
  if (opts.json) {
    emitJson({ action: "resume", resumed: r.kind === "active" });
  } else {
    emitText(
      r.kind === "active"
        ? "repo-aegis resume: the pause is over; repo-aegis is protecting again"
        : r.kind === "expired"
          ? "repo-aegis resume: the pause had already expired; its file is removed"
          : "repo-aegis resume: removed a pause file that failed its checks (it was being ignored; no pause was active)",
    );
  }
}
