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
 * Extract the path of the file the agent is *about to* write/edit
 * from the Claude Code PreToolUse JSON payload. Same shape as
 * PostToolUse: `tool_input.file_path` for Write/Edit/MultiEdit; older
 * shapes use `tool_input.path`.
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

function emitJsonAndExit(value: unknown, exitCode: number): never {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
  process.exit(exitCode);
}

/**
 * `repo-aegis hook check-write` — the Claude Code PreToolUse hook
 * entry point for `Write|Edit|MultiEdit`. Runs the path-policy check
 * *before* the tool executes; a non-zero exit blocks the write.
 *
 * Decision is delegated to `decideHookAction`, which inspects only the
 * file path (resolved working tree, trust boundary, registry org
 * membership). The `refuse` decision exits 2 with a structured
 * `CROSS_ORG_WRITE` payload and the tool never runs. Any other
 * decision exits 0 — content scanning is the PostToolUse hook's job.
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
 *   - 2 on `CROSS_ORG_WRITE` or hard registry errors.
 *
 * The hook NEVER reveals literal markers — but `check-write` doesn't
 * scan content at all, so this is structural rather than enforced.
 */
export async function hookCheckWrite(): Promise<void> {
  const stdinText = await readStdin();
  const filePath = extractFilePath(stdinText);

  if (!filePath) process.exit(0);

  let registry: Registry;
  try {
    registry = loadRegistry();
  } catch (err) {
    if (err instanceof RegistryNotFoundError) {
      registry = { engagements: [], alwaysBlock: [], personalOrgs: [], schemaVersion: 2 };
    } else if (err instanceof RegistryEncryptedError) {
      emitJsonAndExit({ code: err.code, error: err.message }, 2);
    } else {
      emitJsonAndExit(
        { code: "REGISTRY_ERROR", error: (err as Error).message },
        2,
      );
    }
  }

  const decision: HookDecision = decideHookAction({
    filePath,
    launcherCwd: process.cwd(),
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
    2,
  );
}
