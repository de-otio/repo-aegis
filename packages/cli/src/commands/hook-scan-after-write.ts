// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
import { existsSync } from "node:fs";
import { check } from "./check.js";

interface HookOptions {
  /** When true, do not exit non-zero on hits — return as if clean. Useful
   * for advisory-only configurations (rarely needed; default off). */
  advisory?: boolean;
}

/**
 * Read all of stdin to a string. The Claude Code PostToolUse hook contract
 * sends a JSON tool-result payload on stdin. Sizes are typically a few
 * hundred bytes; we cap at 1 MiB to avoid an unbounded buffer.
 */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  const MAX = 1024 * 1024;
  for await (const chunk of process.stdin) {
    const b = typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer);
    total += b.length;
    if (total > MAX) {
      // Hook payload is unexpectedly large; ignore the rest. Hooks must
      // be silent on non-fatal anomalies — failing here would surface
      // as an "agent saw an error" event in the tool result, which is
      // exactly the wrong place for noise.
      break;
    }
    chunks.push(b);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Extract the path of the file the agent just wrote/edited from the
 * Claude Code PostToolUse JSON payload. The agent contract puts it under
 * `tool_input.file_path` for Write/Edit/MultiEdit; some older shapes use
 * `tool_input.path`. Anything else => no path.
 */
function extractFilePath(json: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const root = parsed as Record<string, unknown>;
  const ti = root["tool_input"];
  if (!ti || typeof ti !== "object") return undefined;
  const tiObj = ti as Record<string, unknown>;
  for (const k of ["file_path", "path"]) {
    const v = tiObj[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

/**
 * `repo-aegis hook scan-after-write` — the Claude Code PostToolUse hook
 * entry point. Reads the tool-result JSON from stdin, extracts the
 * file_path the agent just wrote, and runs `check --path` on it.
 *
 * Replaces the previous bash + jq wrapper script. Settings.json can now
 * reference the bin name (`repo-aegis hook scan-after-write`) directly:
 * - PATH-resolved, so renaming `~/.claude` doesn't break the hook,
 * - no `jq` dependency,
 * - one source of truth for the protocol (this function).
 *
 * Exit semantics match `repo-aegis check`:
 *   - 0 if no file_path / file missing / clean,
 *   - 1 if a marker hit (per advisory rules),
 *   - 2 on hard error.
 *
 * The hook NEVER reveals literal markers. `--verbose` is not honoured;
 * the underlying `check` call is invoked without it.
 */
export async function hookScanAfterWrite(_opts: HookOptions = {}): Promise<void> {
  // The opts arg is reserved for future extensions (e.g. --advisory).
  // Currently unused; we still take it so the subcommand can grow flags
  // without changing the call signature.

  const stdinText = await readStdin();
  const filePath = extractFilePath(stdinText);

  // Silent exit if there's nothing to scan. This matches the previous
  // bash script: an unrecognised tool-result payload (or a tool whose
  // input we don't model) is a no-op rather than a hook error.
  if (!filePath) {
    process.exit(0);
  }
  if (!existsSync(filePath)) {
    process.exit(0);
  }

  // Hand off to the regular `check` machinery. The check function
  // process.exit()s on hits and on errors, so we don't need to translate
  // the result. JSON output flows up to the agent's tool result.
  check({ json: true, path: filePath });
}
