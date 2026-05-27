// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
import {
  loadRegistry,
  RegistryEncryptedError,
  RegistryNotFoundError,
  type Registry,
} from "@de-otio/repo-aegis-core";
import { decideHookAction, type HookDecision } from "./hook-policy.js";

/**
 * Read all of stdin to a string. The Claude Code PreToolUse hook
 * contract sends a JSON tool-call payload on stdin (no `tool_response`
 * block — the tool hasn't run yet). We cap at 1 MiB to avoid an
 * unbounded buffer.
 */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  const MAX = 1024 * 1024;
  for await (const chunk of process.stdin) {
    const b = typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer);
    total += b.length;
    if (total > MAX) break;
    chunks.push(b);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Parse the Claude Code PreToolUse JSON payload into the two fields the
 * policy needs:
 *
 *   - `filePath`: the path the agent is *about to* write/edit
 *     (`tool_input.file_path`; older shapes use `tool_input.path`).
 *   - `cwd`: the session's working directory, sent by Claude Code as a
 *     top-level field. This is the launcher boundary the policy compares
 *     against — NOT `process.cwd()`, which is whatever directory Claude
 *     Code happened to spawn this hook process in (often an unrelated
 *     tree: `/tmp`, `$HOME`, a sibling repo). Reading the spawn cwd was
 *     the cause of the spurious `CROSS_ORG_WRITE` blocks documented in
 *     doc/bugs/repo-aegis-check-write-flake.md (Bug B).
 *
 * A missing/unparseable field => `undefined` for that field.
 */
function parseHookInput(json: string): { filePath?: string; cwd?: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object") return {};
  const root = parsed as Record<string, unknown>;
  const out: { filePath?: string; cwd?: string } = {};

  const ti = root["tool_input"];
  if (ti && typeof ti === "object") {
    const tiObj = ti as Record<string, unknown>;
    for (const k of ["file_path", "path"]) {
      const v = tiObj[k];
      if (typeof v === "string" && v.length > 0) {
        out.filePath = v;
        break;
      }
    }
  }

  const cwd = root["cwd"];
  if (typeof cwd === "string" && cwd.length > 0) out.cwd = cwd;

  return out;
}

// Claude Code PreToolUse exit-code contract:
//   0              → allow (normal permission flow),
//   2              → BLOCK the tool; stderr is fed to the model as the
//                    reason it was blocked,
//   other non-zero → non-blocking error; the tool still runs (fail open),
//                    stderr is surfaced to the user as a warning.
const EXIT_BLOCK = 2;
const EXIT_INTERNAL_ERROR = 1;

function emitJsonAndExit(value: unknown, exitCode: number): never {
  // Claude Code forwards STDERR (not stdout) to the model when a
  // PreToolUse hook exits non-zero. Emitting the diagnostic on stdout —
  // as this hook originally did — meant a blocked write reached the
  // agent as the bare "No stderr output" wrapper, with no reason and no
  // redaction guidance (Bug A in the bug doc). Route non-zero exits to
  // stderr so the block is self-explaining; keep exit-0 output on stdout.
  // Mirrors hook-scan-after-write.ts.
  const stream = exitCode === 0 ? process.stdout : process.stderr;
  stream.write(JSON.stringify(value, null, 2) + "\n");
  process.exit(exitCode);
}

/**
 * `repo-aegis hook check-write` — the Claude Code PreToolUse hook
 * entry point for `Write|Edit|MultiEdit`. Runs the path-policy check
 * *before* the tool executes; a non-zero exit blocks the write.
 *
 * Decision is delegated to `decideHookAction`, which inspects only the
 * file path and the session cwd (resolved working trees, trust
 * boundaries, registry org membership). The `refuse` decision exits 2
 * with a structured `CROSS_ORG_WRITE` payload and the tool never runs.
 * Any other decision exits 0 — content scanning is the PostToolUse
 * hook's job.
 *
 * Why this is split from `scan-after-write`: prior to v0.3.0 the
 * cross-org-write refusal lived in PostToolUse, where exit-2 was
 * informational only (the file was already on disk by the time the
 * hook returned). Moving the refusal to PreToolUse — where Claude
 * Code's contract is "non-zero exit blocks the tool" — makes the
 * "refuses" claim true.
 *
 * Exit semantics:
 *   - 0 if no file_path / decision is `scan` or `scan-with-warning`,
 *   - 2 (`EXIT_BLOCK`) on `CROSS_ORG_WRITE` — blocks the tool,
 *   - 1 (`EXIT_INTERNAL_ERROR`) on a registry error we cannot recover
 *     from. This FAILS OPEN: Claude Code lets the tool proceed, so an
 *     unreadable/encrypted registry never blocks every write behind the
 *     hook's own failure. The diagnostic still reaches the user via
 *     stderr; content safety remains the PostToolUse scan's job.
 *
 * The hook NEVER reveals literal markers — but `check-write` doesn't
 * scan content at all, so this is structural rather than enforced.
 */
export async function hookCheckWrite(): Promise<void> {
  const stdinText = await readStdin();
  const { filePath, cwd } = parseHookInput(stdinText);

  if (!filePath) process.exit(0);

  let registry: Registry;
  try {
    registry = loadRegistry();
  } catch (err) {
    if (err instanceof RegistryNotFoundError) {
      registry = { engagements: [], alwaysBlock: [], personalOrgs: [], schemaVersion: 2 };
    } else if (err instanceof RegistryEncryptedError) {
      emitJsonAndExit({ code: err.code, error: err.message }, EXIT_INTERNAL_ERROR);
    } else {
      emitJsonAndExit(
        { code: "REGISTRY_ERROR", error: (err as Error).message },
        EXIT_INTERNAL_ERROR,
      );
    }
  }

  const decision: HookDecision = decideHookAction({
    filePath,
    // Launcher boundary = the session cwd from the hook payload, not
    // this process's spawn cwd. Fall back to process.cwd() only when
    // Claude Code didn't send `cwd` (older/edge payloads).
    launcherCwd: cwd ?? process.cwd(),
    registry: registry!,
  });

  if (decision.action !== "refuse") {
    process.exit(0);
  }

  emitJsonAndExit(
    {
      code: decision.code,
      error:
        `cross-org write refused: file ${filePath} lives in a working tree ` +
        `whose trust boundary (${decision.destOrgs.join(", ") || "unknown"}) ` +
        `does not overlap the launcher's (${decision.srcOrgs.join(", ") || "unknown"})`,
      details: {
        srcOrgs: decision.srcOrgs,
        destOrgs: decision.destOrgs,
        destTree: decision.destTree,
      },
    },
    EXIT_BLOCK,
  );
}
