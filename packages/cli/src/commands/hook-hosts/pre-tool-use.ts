// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// The shared edges of the Claude-Code-style PreToolUse family: Claude Code,
// Codex and Gemini CLI all put the pending command in `tool_input.command`
// and read a `hookSpecificOutput.permissionDecision` answer (Codex and Gemini
// also honour exit 2 + stderr, which the core writes). The per-host modules
// differ only in name and `hasAsk`.
import type { HookVerdict, HostOutput, ParsedHookInput } from "./types.js";

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
 * Flatten an argv-style command (`["bash", "-lc", "git push"]`) to the
 * shell text it would run. Harnesses that exec directly rather than through
 * a shell send this shape; the script after `-c` / `-lc` is the part the
 * policy must see.
 */
export function flattenCommand(value: unknown): string | undefined {
  if (typeof value === "string") return value.length > 0 ? value : undefined;
  if (!Array.isArray(value)) return undefined;
  const parts = value.filter((v): v is string => typeof v === "string");
  if (parts.length === 0) return undefined;
  const dashC = parts.findIndex(p => /^-[a-z]*c$/.test(p));
  if (dashC !== -1 && dashC + 1 < parts.length) return parts[dashC + 1];
  return parts.join(" ");
}

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
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdin);
  } catch {
    return { kind: "malformed", reason: "stdin is not JSON" };
  }
  // An array was once read as an object with no fields (→ silent exit 0);
  // `malformed` renders the same, so this is a naming fix, not a behaviour change.
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { kind: "malformed", reason: "stdin is not a JSON object" };
  const root = parsed as Record<string, unknown>;

  const toolName = root["tool_name"];
  if (typeof toolName === "string" && toolName.length > 0 && !SHELL_TOOL_NAMES.has(toolName.toLowerCase())) {
    return { kind: "skip" };
  }

  let command: string | undefined;
  const ti = root["tool_input"];
  if (ti && typeof ti === "object") command = flattenCommand((ti as Record<string, unknown>)["command"]);
  if (command === undefined) command = flattenCommand(root["command"]);
  if (command === undefined) return { kind: "skip" };

  const cwd = root["cwd"];
  return typeof cwd === "string" && cwd.length > 0 ? { kind: "command", command, cwd } : { kind: "command", command };
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
