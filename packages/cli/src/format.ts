// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
import { isHomeOverridden } from "@de-otio/repo-aegis-core";

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

export function emitError(value: ErrorPayload | string, opts: OutputOptions = {}): never {
  const payload: ErrorPayload = typeof value === "string" ? { error: value } : value;
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
