import { isHomeOverridden, repoAegisHome } from "@de-otio/repo-aegis-core";

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
 * Suppressed when stdin is a pipe (heuristic: hook context); the warning
 * itself would be a recency-pressure signal in the agent's tool result,
 * which is what we're trying to avoid. The user must run interactively
 * to see the warning.
 */
export function homeWarning(): void {
  if (!isHomeOverridden()) return;
  if (!process.stderr.isTTY) return;
  process.stderr.write(
    `repo-aegis: warning: REPO_AEGIS_HOME is overridden to ${repoAegisHome()}\n`,
  );
}

/**
 * True if the user has opted into revealing literal matched markers, via
 * the `--verbose` CLI flag or `REPO_AEGIS_REVEAL_MATCHES` env var.
 *
 * Hooks must NEVER pass `--verbose`. The flag is for human inspection
 * only.
 */
export function shouldRevealMatches(opts: { verbose?: boolean }): boolean {
  if (opts.verbose) return true;
  return process.env["REPO_AEGIS_REVEAL_MATCHES"] === "1";
}
