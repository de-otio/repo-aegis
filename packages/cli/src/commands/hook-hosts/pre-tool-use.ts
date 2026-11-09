// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// The shared edges of the Claude-Code-style PreToolUse family: Claude Code,
// Codex and Gemini CLI all put the pending command in `tool_input.command`
// and read a `hookSpecificOutput.permissionDecision` answer (Codex and Gemini
// also honour exit 2 + stderr, which the core writes). The per-host modules
// differ only in name and `hasAsk`.
import {
  ALL_SHAPES,
  ANY_SHELL_TOOL_NAMES,
  commandResult,
  cwdOf,
  flattenCommand,
  noOwnCommand,
  parseRootObject,
  readShape,
  rootCwd,
  toolNameOf,
  type Field,
  type ShapeName,
} from "./shapes.js";
import type { HookVerdict, HostOutput, ParsedHookInput } from "./types.js";

export { flattenCommand };

// PreToolUse exit-code contract, shared by all three frameworks:
//   0              → proceed (with the JSON decision, if any, on stdout),
//   2              → BLOCK the tool; stderr is fed back to the model,
//   other non-zero → non-blocking error; the tool still runs (fail open).
export const EXIT_BLOCK = 2;
export const EXIT_INTERNAL_ERROR = 1;

/**
 * Tool names that carry a shell command. Compared case-insensitively so a
 * harness that spells its tool `bash` rather than `Bash` still matches. A
 * payload with NO `tool_name` is inspected anyway: some harnesses omit it,
 * and the parse is harmless on a non-command payload (it yields no intents).
 */
export const SHELL_TOOL_NAMES: ReadonlySet<string> = new Set(["bash", "shell", "run_shell_command"]);

/**
 * Tolerant field extraction across the three harness shapes, in the spirit
 * of `hook-scan-bash-output.ts`: the pending command from
 * `tool_input.command` (all three) or a root-level `command`, and the
 * session cwd from the root `cwd`.
 *
 * `cwd` matters for the same reason it does in `hook-check-write.ts`: it is
 * where the command WILL run, whereas `process.cwd()` is wherever the agent
 * happened to spawn this hook. Reading the spawn cwd was the cause of the
 * spurious `CROSS_ORG_WRITE` blocks (doc/bugs/repo-aegis-check-write-flake.md).
 */
export function parsePreToolUse(stdin: string): ParsedHookInput {
  const r = parseRootObject(stdin);
  if ("malformed" in r) return r.malformed;
  const root = r.root;

  const toolName = root["tool_name"];
  const named = typeof toolName === "string" && toolName.length > 0;
  if (named && !SHELL_TOOL_NAMES.has(toolName.toLowerCase())) return { kind: "skip" };

  // `tool_input.command` first, then a root `command`. A command in another
  // host's shape (Copilot `toolArgs`, Antigravity `toolCall`), or a named
  // shell tool with no command at all, is `malformed`: the hook is probably
  // registered with the wrong `--agent`, and that must not be silent.
  const own: readonly ShapeName[] = ["tool_input", "root"];
  const fields: Field[] = [];
  for (const shape of own) {
    const f = readShape(root, shape);
    if (f.kind === "found") return withHostFields(commandResult(f.command, rootCwd(root)), root);
    fields.push(f);
  }
  return noOwnCommand(root, own, fields, named);
}

/** A root string field of at most 64 characters (what a permission mode or session id is), else undefined. */
function shortRootString(root: Record<string, unknown>, key: string): string | undefined {
  const v = root[key];
  return typeof v === "string" && v.length <= 64 ? v : undefined;
}

/**
 * Add the root `permission_mode` and `session_id` to a `command` result, when present as short strings. Only the
 * PreToolUse parser calls this: the allowlist that reads them is Claude's vocabulary, and no other host's adapter
 * may inherit it by accident.
 */
function withHostFields(result: ParsedHookInput, root: Record<string, unknown>): ParsedHookInput {
  if (result.kind !== "command") return result;
  const permissionMode = shortRootString(root, "permission_mode");
  const sessionId = shortRootString(root, "session_id");
  return {
    ...result,
    ...(permissionMode !== undefined && { permissionMode }),
    ...(sessionId !== undefined && { sessionId }),
  };
}

/**
 * The fallback for an unknown `--agent` name: try every known shape in turn
 * (PreToolUse `tool_input.command`, root `command`, Copilot `toolArgs`,
 * Antigravity `toolCall.args.CommandLine`), so a typo or an unlisted host that
 * sends a known shape is still judged. Rendering stays the no-ask PreToolUse
 * family (exit 2 blocks).
 */
export function parseAnyShape(stdin: string): ParsedHookInput {
  const r = parseRootObject(stdin);
  if ("malformed" in r) return r.malformed;
  const root = r.root;

  const toolName = toolNameOf(root);
  if (toolName !== undefined && !ANY_SHELL_TOOL_NAMES.has(toolName.toLowerCase())) return { kind: "skip" };

  const fields: Field[] = [];
  for (const shape of ALL_SHAPES) {
    const f = readShape(root, shape);
    if (f.kind === "found") return commandResult(f.command, cwdOf(root));
    fields.push(f);
  }
  return noOwnCommand(root, ALL_SHAPES, fields, toolName !== undefined);
}

/**
 * A payload past the cap cannot be parsed, and treating "unparseable" as "no command" let a command padded
 * past 1 MiB through every hook-only rule (R6, the human-only and detached-session refusals, the shape rules).
 * So it is refused, unless what was read already names a tool that is not a shell (a harness that sends every
 * tool to this hook). `tool_name` comes first in every harness's payload, well inside the cap.
 */
export function oversizedByToolName(prefix: string): "proceed" | "refuse" {
  const m = /"tool_name"\s*:\s*"([^"\\]{1,64})"/.exec(prefix.slice(0, 4096));
  if (m !== null && !SHELL_TOOL_NAMES.has(m[1]!.toLowerCase())) return "proceed";
  return "refuse";
}

function decisionJson(permissionDecision: "allow" | "ask" | "deny", reason: string): string {
  // The frameworks' own JSON channel. `permissionDecision` is the entire
  // vocabulary this hook uses: there is deliberately no `updatedInput`.
  return (
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision,
        permissionDecisionReason: reason,
      },
    }) + "\n"
  );
}

/**
 * Render for the PreToolUse family. Gemini's own event is `BeforeTool`, but
 * the hook has always answered every host with `hookEventName: "PreToolUse"`
 * and relied on exit 2 + stderr to block; T1a changes no byte of that.
 */
export function renderPreToolUse(verdict: HookVerdict, hasAsk: boolean): HostOutput {
  switch (verdict.action) {
    case "allow":
      return verdict.reason === undefined
        ? { stdout: "", exitCode: 0 }
        : { stdout: decisionJson("allow", verdict.reason), exitCode: 0 };
    case "ask":
      // The policy never asks a host without an ask; if one does, refuse. Never allow.
      return hasAsk
        ? { stdout: decisionJson("ask", verdict.reason), exitCode: 0 }
        : { stdout: decisionJson("deny", verdict.reason), exitCode: EXIT_BLOCK };
    case "deny":
      return { stdout: decisionJson("deny", verdict.reason), exitCode: EXIT_BLOCK };
    case "error":
      return { stdout: "", exitCode: EXIT_INTERNAL_ERROR };
  }
}
