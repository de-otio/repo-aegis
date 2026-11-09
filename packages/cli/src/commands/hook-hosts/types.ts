// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// The host-adapter contract for `repo-aegis hook guard-egress` (plan T1a,
// doc/plan-landscape-recommendations.md §5 "T1a adapter contract").
//
// An agent host (Claude Code, Codex, Gemini, Cursor, …) runs the hook with
// its own stdin JSON and reads its own answer shape back. Everything between
// those two edges is host-independent and lives in hook-guard-egress.ts: the
// shape rules, the identity rules, the registry, the approvals, the audit.
// An adapter is the two edges and nothing else:
//
//   stdin text ──parse──▶ ParsedHookInput ──(policy)──▶ HookVerdict ──render──▶ { stdout, exitCode }
//
// Adapters are pure: no I/O, no environment, no clock. That is what lets a
// fixture table pin each one down completely.
//
// What an adapter must never do (both invariants of the hook):
//
//   1. Decision-only. `render` emits a decision and a reason, never a
//      rewritten command, even where the host offers a field for one
//      (`updatedInput`, `updated_input`, `modifiedArgs`, `overwrite`, …).
//   2. Cheap and silent. `parse` does no I/O and `render({ action: "allow" })`
//      prints the least the host accepts as "no objection" — nothing at all
//      where the host allows that.

/**
 * What the host sent, reduced to what the policy needs.
 *
 * - `command`: a shell command the host is about to run. `cwd` is where it
 *   will run, if the payload says (never the hook's own `process.cwd()`).
 *   `permissionMode` and `sessionId` are the host's root `permission_mode` and `session_id`, filled ONLY by the
 *   Claude-Code-family parser (`parsePreToolUse`) and only when plain strings of at most 64 characters: they
 *   are what lets the hook decide whether a "yes" at the host's prompt is a person's (prompt approvals).
 * - `skip`: a well-formed payload that is not this hook's business — a tool
 *   that is not a shell, or no command field. The policy does not run.
 * - `malformed`: the payload is not something this adapter understands (not
 *   JSON, not an object). The hook fails OPEN on it, like on its own defects:
 *   a guard that walls off every command because a host changed its format is
 *   worse than one that misses a command. `reason` is for an audit record;
 *   it must not contain payload text.
 */
export type ParsedHookInput =
  | { kind: "command"; command: string; cwd?: string; permissionMode?: string; sessionId?: string }
  | { kind: "skip" }
  | { kind: "malformed"; reason: string };

/**
 * The hook's decision, host-independent.
 *
 * - `allow` without a reason: the common case; nothing to say.
 * - `allow` with a reason: a human approval stood in for a person; the reason
 *   names it, on the channel the host shows decision reasons on.
 * - `allow` with a `notice`: nothing is wrong with the command, but the person should know something about the
 *   guard (the registry is encrypted, so rule h is off; the pin is gone and the PATH fallback ran). Rendered only
 *   by an adapter whose host shows a `systemMessage` on exit 0 (Claude Code); the others drop it, silently.
 * - `ask`: a person should confirm. The core only produces it for an adapter
 *   with `hasAsk: true`; an adapter without one must still render it as a
 *   deny (never as an allow) should one reach it.
 * - `deny`: refuse; `reason` is the full refusal text.
 * - `error`: the guard itself failed. Rendered as the host's fail-OPEN answer
 *   (the guard's own defect must not block the agent), which differs per host:
 *   a host that fails closed on a non-zero exit needs exit 0 here.
 */
export type HookVerdict =
  | { action: "allow"; reason?: string; notice?: string }
  | { action: "ask"; reason: string }
  | { action: "deny"; reason: string }
  | { action: "error" };

/**
 * What the process prints and exits with. stderr is NOT here: the structured
 * refusal (`{ code, error, details }`) and internal-error text are written by
 * the core, identically for every host. A host that ignores stderr reads the
 * reason from `stdout` instead, so `render` must put it there for `deny`.
 */
export interface HostOutput {
  stdout: string;
  exitCode: number;
}

export interface HostAdapter {
  /** The `--agent` value that selects this adapter. */
  readonly name: string;
  /**
   * Whether the host can put a decision to a person and wait. Passed to the
   * policy as `capabilities.ask`; `false` makes every `ask` a `deny`.
   */
  readonly hasAsk: boolean;
  /** Parse the full stdin text. Pure; never throws. */
  parse(stdin: string): ParsedHookInput;
  /**
   * The input passed the 1 MiB cap and was cut at it, so it cannot be parsed.
   * Given the prefix that was read, `"proceed"` only when that prefix already
   * proves the payload is for a tool that is not a shell; otherwise
   * `"refuse"`. Pure; never throws.
   */
  oversized(prefix: string): "proceed" | "refuse";
  /** Render a decision in the host's answer shape. Pure; never throws. */
  render(verdict: HookVerdict): HostOutput;
}
