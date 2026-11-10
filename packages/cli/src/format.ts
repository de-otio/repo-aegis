// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
import { isHomeOverridden, REFUSAL_GUIDE, withLogTrailer, withRefusalTrailer, type DecisionAppendResult, type RefusalGuideOverride } from "@de-otio/repo-aegis-core";

export interface OutputOptions {
  json?: boolean;
}

export function emitJson(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

export function emitText(text: string): void {
  process.stdout.write(text + "\n");
}

export interface ErrorPayload {
  code?: string;
  error: string;
  details?: unknown;
}

/**
 * The decision log's hook into every refusal this module prints (P1-I). A command that makes a logged decision (the
 * pre-commit and pre-push checks) sets it for its run; `emitError` then writes the record FIRST and ends the error text
 * with `(logged: repo-aegis log --last 1)` or `(not logged)`, so the trailer says what actually happened and no call
 * site assembles it. The hook must not throw; if it does, the refusal is printed without a trailer, unchanged.
 * Module state (one process makes one decision), set only by {@link setErrorDecisionHook}.
 */
let errorDecisionHook: ((payload: ErrorPayload) => DecisionAppendResult) | null = null;

export function setErrorDecisionHook(hook: ((payload: ErrorPayload) => DecisionAppendResult) | null): void {
  errorDecisionHook = hook;
}

/**
 * `guide` (optional) replaces the table's next step or person-only answer for THIS error only, for a call site that
 * knows more than the code does (`USAGE` after a terminal gate: the reader is a person). The code is unchanged.
 * Order: the X-10 guide trailer, then the decision record (P1-I), then `(logged: …)`, which is always last.
 */
export function emitError(value: ErrorPayload | string, opts: OutputOptions = {}, guide?: RefusalGuideOverride): never {
  const given: ErrorPayload = typeof value === "string" ? { error: value } : value;
  // X-10: a refusal code in the shared table always ends with its version, next step, person-only answer and
  // `[CODE; details: …]` token, whichever call site raised it (a no-op when the text already carries it).
  let payload: ErrorPayload =
    given.code !== undefined && Object.prototype.hasOwnProperty.call(REFUSAL_GUIDE, given.code)
      ? { ...given, error: withRefusalTrailer(given.code, given.error, guide) }
      : given;
  if (errorDecisionHook !== null) {
    try {
      payload = { ...payload, error: withLogTrailer(payload.error, errorDecisionHook(payload).written) };
    } catch {
      /* the log never changes or blocks a refusal */
    }
  }
  if (opts.json) {
    process.stderr.write(JSON.stringify(payload) + "\n");
  } else {
    process.stderr.write(`repo-aegis: ${payload.error}\n`);
    if (payload.details !== undefined) {
      const d = typeof payload.details === "string" ? payload.details : JSON.stringify(payload.details);
      process.stderr.write(`  ${d}\n`);
    }
  }
  process.exit(2);
}

/**
 * Print a stderr warning if `REPO_AEGIS_HOME` is overridden in the env.
 *
 * Suppressed when stderr is a pipe (heuristic: hook context); the
 * warning itself would be a recency-pressure signal in the agent's
 * tool result, which is what we're trying to avoid. The override
 * path is intentionally NOT echoed — it could itself contain
 * customer-derived directory names. Run `echo $REPO_AEGIS_HOME`
 * interactively to inspect.
 */
export function homeWarning(): void {
  if (!isHomeOverridden()) return;
  if (!process.stderr.isTTY) return;
  process.stderr.write(
    `repo-aegis: warning: REPO_AEGIS_HOME is overridden (run \`echo $REPO_AEGIS_HOME\` to inspect)\n`,
  );
}

/**
 * True if the user has opted into revealing literal matched markers
 * via the `--verbose` CLI flag.
 *
 * Hooks must NEVER pass `--verbose`. The flag is for interactive human
 * inspection only.
 *
 * The previous `REPO_AEGIS_REVEAL_MATCHES` env-var path was removed:
 * env vars propagate to subprocess hooks unintentionally and could
 * cause literal markers to flow into AI tool-result context — exactly
 * the recency-pressure failure mode the tool exists to prevent.
 */
export function shouldRevealMatches(opts: { verbose?: boolean }): boolean {
  return !!opts.verbose;
}
