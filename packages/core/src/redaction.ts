import { createHash } from "node:crypto";

export type RedactionMode = "preview" | "hash" | "position-only";

/**
 * Redact a matched marker string for safe display.
 *
 * Default mode `preview` returns `<first-3-chars>***<length-N>` for matches
 * of length >= 4, else `[redacted]`. The literal match value never appears
 * in output that flows to AI agent context (PostToolUse hook output, error
 * messages, JSON payloads), because the literal match in recent context is
 * exactly the recency-pressure failure mode the tool exists to prevent.
 *
 * `hash` mode returns the first 8 hex chars of SHA-256 + length, useful
 * when distinct hits should be distinguishable from each other but the
 * value itself remains opaque.
 *
 * `position-only` returns the constant `[redacted]`.
 */
export function redactMatch(match: string, mode: RedactionMode = "preview"): string {
  if (mode === "position-only") return "[redacted]";
  if (mode === "hash") {
    const h = createHash("sha256").update(match).digest("hex").slice(0, 8);
    return `[hash:${h}:${match.length}]`;
  }
  // preview
  if (match.length < 4) return "[redacted]";
  const head = match.slice(0, 3);
  return `${head}***${match.length}`;
}

/**
 * Pass-through; explicit "this is the literal".
 *
 * Should ONLY be called when the user has explicitly opted in via
 * `--verbose` flag or `REPO_AEGIS_REVEAL_MATCHES=1`. Hooks must never
 * pass through this function.
 */
export function revealMatch(match: string): string {
  return match;
}
