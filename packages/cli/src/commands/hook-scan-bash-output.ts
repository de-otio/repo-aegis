// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// `repo-aegis hook scan-bash-output` — Claude Code PostToolUse hook
// that scans Bash tool stdout/stderr for secret-shaped strings (PEM
// headers, JWTs, GitHub tokens, hex-encoded PEMs from macOS keychain
// retrieval). Companion to `hook scan-after-write` (which scans the
// path of files agents write); this one scans the *content* the agent
// just observed via Bash.
//
// PostToolUse fires *after* the tool completes, so the leak has
// already reached the agent context by the time the hook runs. The
// hook therefore acts as a detector + alert, not a true preventer:
// it surfaces the leak so the agent can stop the runaway path,
// surface the incident to the user, and trigger rotation. The hook
// itself never echoes any matched bytes — only the kind and offset
// of the match.
//
// Exit semantics:
//   - 0 if no Bash output / clean,
//   - 1 (EXIT_HIT) on a secret-shaped match.
//
// Universal markers: pattern set lives in `core/src/secret-markers.ts`
// and is not configurable. Engagement-scoped customer markers continue
// to flow through the existing file-write hook.
import {
  scanForSecrets,
  summariseHits,
  EXIT_HIT,
  type SecretMarkerHit,
} from "@de-otio/repo-aegis-core";

interface HookOptions {
  /** When true, exit 0 even on a hit. The structured payload is still
   * emitted so logs / audit have a record. Off by default. */
  advisory?: boolean;
}

/**
 * Read all of stdin to a string. Bash output can be larger than file
 * writes, so we permit a higher cap (8 MiB) before truncating. The
 * hook is silent on truncation — partial scanning of a large output
 * is still better than no scan, and noisy stderr would surface to the
 * agent as an out-of-band error.
 */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  const MAX = 8 * 1024 * 1024;
  for await (const chunk of process.stdin) {
    const b = typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer);
    total += b.length;
    if (total > MAX) break;
    chunks.push(b);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Extract Bash stdout + stderr from the Claude Code PostToolUse JSON.
 * Tool result shapes vary across Claude Code versions; we look in
 * order at the most likely fields and concatenate whatever is present.
 *
 * Returns undefined when the payload is malformed or empty (treated
 * as a no-op by the caller).
 */
function extractBashOutput(json: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const root = parsed as Record<string, unknown>;

  const toolName = root["tool_name"];
  if (typeof toolName === "string" && toolName !== "Bash") return undefined;

  const tr = root["tool_response"];
  const parts: string[] = [];
  if (tr && typeof tr === "object") {
    const trObj = tr as Record<string, unknown>;
    for (const k of ["stdout", "stderr", "output", "content"]) {
      const v = trObj[k];
      if (typeof v === "string" && v.length > 0) parts.push(v);
    }
    // Some agent harnesses wrap the response in a `result` field that
    // is itself a string (e.g. an unstructured tool transcript). Cover
    // the case so we don't silently miss leaks in those layouts.
    const result = trObj["result"];
    if (typeof result === "string" && result.length > 0) parts.push(result);
  }
  // Older shapes used `tool_result_text` at the root.
  const trText = root["tool_result_text"];
  if (typeof trText === "string" && trText.length > 0) parts.push(trText);

  if (parts.length === 0) return undefined;
  return parts.join("\n");
}

function emitJsonAndExit(value: unknown, exitCode: number): never {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
  process.exit(exitCode);
}

/**
 * `repo-aegis hook scan-bash-output` — Claude Code PostToolUse hook
 * for Bash. Reads tool-result JSON from stdin, scans the Bash output
 * for secret-shaped patterns, exits with EXIT_HIT on a match. The
 * payload describes what was caught (kind + offset, never bytes) so
 * the agent can react: surface the leak, propose rotation, suggest
 * the runbook's debugging guidance.
 *
 * The hook NEVER reveals matched substrings.
 */
export async function hookScanBashOutput(opts: HookOptions = {}): Promise<void> {
  const stdinText = await readStdin();
  const output = extractBashOutput(stdinText);
  if (!output) process.exit(0);

  let hits: SecretMarkerHit[];
  try {
    hits = scanForSecrets(output);
  } catch {
    // A pathological input that broke the regex engine is itself a
    // signal worth investigating, but we must not crash the hook
    // (that would surface as a tool-result error). Treat as clean.
    process.exit(0);
  }
  if (hits.length === 0) process.exit(0);

  const summary = summariseHits(hits);
  emitJsonAndExit(
    {
      code: "SECRET_LEAK",
      error:
        "secret-shaped content detected in Bash tool output — " +
        "the value has already reached the conversation context. " +
        "Treat the credential as compromised: rotate it, then audit " +
        "the path that produced this output for safer alternatives.",
      details: {
        kinds: summary.kinds,
        count: summary.count,
        // Offsets help the agent point the developer at the locations
        // without echoing bytes back. We cap to the first 16 hits to
        // keep the payload small if a single output is full of
        // matches (e.g. an `env` dump with multiple tokens).
        offsets: hits.slice(0, 16).map(h => ({ kind: h.kind, offset: h.offset, length: h.length })),
      },
      remediation: [
        "rotate the affected credential immediately (do not wait for the session to end)",
        "review the runbook's Step 9 / 'Debugging the token mint' guidance for safe alternatives",
        "if the leak was in `security ... -w | head` or similar, see treat-agent-as-a-dev v0.4 Operating Rule 1",
      ],
    },
    opts.advisory ? 0 : EXIT_HIT,
  );
}
