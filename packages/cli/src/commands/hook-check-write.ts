// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
import { basename } from "node:path";
import {
  loadRegistry,
  RegistryEncryptedError,
  RegistryNotFoundError,
  OVERRIDE_FILENAME,
  type Registry,
} from "@de-otio/repo-aegis-core";
import { decideHookAction, type HookDecision } from "./hook-policy.js";
import {
  parseHookWriteFields,
  readHookStdin,
  WRITE_HOOK_INPUT_MAX_BYTES,
  WRITE_HOOK_INPUT_TOO_LARGE_REASON,
} from "./hook-input.js";

// The payload's two fields the policy needs (hook-input.ts, parseHookWriteFields):
//   - `filePath`: the path the agent is *about to* write/edit
//     (`tool_input.file_path`; older shapes use `tool_input.path`).
//   - `cwd`: the session's working directory, sent by Claude Code as a
//     top-level field. This is the launcher boundary the policy compares
//     against — NOT `process.cwd()`, which is whatever directory Claude
//     Code happened to spawn this hook process in (often an unrelated
//     tree: `/tmp`, `$HOME`, a sibling repo). Reading the spawn cwd was
//     the cause of the spurious `CROSS_ORG_WRITE` blocks documented in
//     doc/bugs/repo-aegis-check-write-flake.md (Bug B).
// A payload past 1 MiB is read from its start (#156); one whose path is not there is refused, not allowed.

// Claude Code PreToolUse exit-code contract:
//   0              → allow (normal permission flow),
//   2              → BLOCK the tool; stderr is fed to the model as the
//                    reason it was blocked,
//   other non-zero → non-blocking error; the tool still runs (fail open),
//                    stderr is surfaced to the user as a warning.
const EXIT_BLOCK = 2;

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
 *   - 2 (`EXIT_BLOCK`) on `CROSS_ORG_WRITE` or `WAIVER_FILE_WRITE_REFUSED`
 *     — blocks the tool,
 *   - 2 on an unreadable registry (`REGISTRY_ERROR`, or the encrypted-at-rest
 *     error): the check cannot run, and exit 1 would FAIL OPEN (Claude Code
 *     treats it as non-blocking). The message is fixed text, because the
 *     parse error names orgs and engagement ids. A missing registry is not an
 *     error: there is nothing to protect yet.
 *   - 1 (`EXIT_INTERNAL_ERROR`) is kept for faults outside the registry.
 *
 * The hook NEVER reveals literal markers — but `check-write` doesn't
 * scan content at all, so this is structural rather than enforced.
 *
 * CONTROL 1 of "D. Reviewed-benign waivers"
 * (doc/plan-tag-push-and-hook-liveness.md): `.repo-aegis.yml` carries
 * waivers and repo classification, and is committed/agent-writable like
 * any other file in the tree. Without this refusal, an agent blocked by
 * a `check` finding could simply write four lines of YAML and retry —
 * reconstructing `git push --no-verify` with extra steps, which is
 * exactly the escape hatch waivers exist to replace. The refusal runs
 * unconditionally (ahead of, and independent of, the registry-backed
 * cross-org logic below) — even a same-org agent must not mint its own
 * waiver. `repo-aegis waive` remains available, but only as a
 * human-run, TTY-gated command (packages/cli/src/commands/waive.ts,
 * CONTROL 2) — this hook is what keeps that gate from being bypassable
 * by an agent writing the file directly.
 */
export async function hookCheckWrite(): Promise<void> {
  const input = await readHookStdin(WRITE_HOOK_INPUT_MAX_BYTES);
  const { filePath, cwd } = parseHookWriteFields(input.text);

  if (!filePath) {
    if (input.truncated) {
      emitJsonAndExit({ code: "HOOK_INPUT_TOO_LARGE", error: WRITE_HOOK_INPUT_TOO_LARGE_REASON }, EXIT_BLOCK);
    }
    process.exit(0);
  }

  if (basename(filePath) === OVERRIDE_FILENAME) {
    emitJsonAndExit(
      {
        code: "WAIVER_FILE_WRITE_REFUSED",
        error:
          `agent write to ${OVERRIDE_FILENAME} refused: this file controls waivers and ` +
          `repo classification. A coding agent must never mint or edit a waiver for its ` +
          `own blocked findings — that reconstructs \`git push --no-verify\` with extra ` +
          `steps (see "D. Reviewed-benign waivers" in doc/plan-tag-push-and-hook-liveness.md). ` +
          `Surface the finding to the human operator instead. \`repo-aegis waive\` exists ` +
          `for exactly this case, but it is a human-run, TTY-gated command: it refuses to ` +
          `run non-interactively unless a human has explicitly set ` +
          `REPO_AEGIS_WAIVE_NONINTERACTIVE=1.`,
        details: { filePath },
      },
      EXIT_BLOCK,
    );
  }

  let registry: Registry;
  try {
    registry = loadRegistry();
  } catch (err) {
    if (err instanceof RegistryNotFoundError) {
      registry = { engagements: [], alwaysBlock: [], personalOrgs: [], schemaVersion: 2 };
    } else if (err instanceof RegistryEncryptedError) {
      emitJsonAndExit({ code: err.code, error: err.message }, EXIT_BLOCK);
    } else {
      // Block, never exit 1: Claude Code treats exit 1 as non-blocking, so an unreadable registry (a schemaVersion
      // this build cannot read, a typo) would switch the cross-org write check off. The message is fixed text:
      // the parse error names orgs and engagement ids, which must not reach an agent's transcript.
      emitJsonAndExit(
        {
          code: "REGISTRY_ERROR",
          error:
            "the registry cannot be read, so the cross-org write check cannot run and the write is refused. " +
            "Run `repo-aegis status` (or `repo-aegis doctor`) in a terminal to see why.",
        },
        EXIT_BLOCK,
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
