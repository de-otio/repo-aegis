// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// GitHub Copilot CLI (plan T1c, doc/plan-landscape-recommendations.md §5.1).
// Doc-derived, not yet seen from a live session (plan task H1):
//
//   - Event `preToolUse` (camelCase), matcher `bash` (`powershell` on Windows).
//     The payload is `{ sessionId, timestamp, cwd, toolName, toolArgs }` and
//     `toolArgs` is a JSON-ENCODED STRING: the command is `.command` of that
//     string once decoded again. Before this adapter existed the hook read
//     only `tool_input.command` and a root `command`, found neither, and
//     silently allowed `git push` from Copilot.
//   - Event `PreToolUse` (PascalCase) gets the VS Code-compatible snake_case
//     payload instead: `tool_name`, `tool_input.command`, where `tool_input`
//     may itself be a JSON string ("parsed from JSON string when possible").
//     Both shapes are accepted.
//   - Answer: `{"permissionDecision": "deny", "permissionDecisionReason": …}`
//     (the reason is required) or exit 2. Empty stdout with exit 0 is the
//     host's normal permission flow, so a plain allow prints nothing.
//   - Copilot FAILS CLOSED on a non-zero exit other than 2 ("hook errored"),
//     so the guard's own internal-error exit 1 would block every command.
//     `error` therefore renders as an allow: exit 0, empty stdout. This
//     adapter never exits 1.
//   - `ask` exists in the interactive CLI; the cloud agent and autopilot mode
//     treat it as a deny. That is the safe direction (a deny where nobody can
//     answer), so `hasAsk` is true: an `ask` never reaches an allow on either.
//   - `modifiedArgs` (a rewrite field) is never emitted: decision-only.
import { EXIT_BLOCK, flattenCommand, SHELL_TOOL_NAMES } from "./pre-tool-use.js";
import type { HookVerdict, HostAdapter, HostOutput, ParsedHookInput } from "./types.js";

/** Copilot's shell tools: the family's names plus `powershell` (its Windows shell tool). */
const COPILOT_SHELL_TOOLS: ReadonlySet<string> = new Set([...SHELL_TOOL_NAMES, "powershell"]);

/** A field that must be a JSON object, given as the object or as a JSON string of one. */
function asObject(value: unknown): Record<string, unknown> | "wrong-type" {
  let v = value;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return "wrong-type";
    }
  }
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : "wrong-type";
}

function parseCopilot(stdin: string): ParsedHookInput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdin);
  } catch {
    return { kind: "malformed", reason: "stdin is not JSON" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { kind: "malformed", reason: "stdin is not a JSON object" };
  const root = parsed as Record<string, unknown>;

  // camelCase `toolName` (preToolUse) or snake_case `tool_name` (PreToolUse).
  const toolName = typeof root["toolName"] === "string" ? root["toolName"] : root["tool_name"];
  if (typeof toolName === "string" && toolName.length > 0 && !COPILOT_SHELL_TOOLS.has(toolName.toLowerCase())) {
    return { kind: "skip" };
  }

  // The argument container, by shape: `toolArgs` (string) or `tool_input`
  // (object or string). Whichever is present must decode to an object; a
  // field of the wrong type is `malformed`, never silently "no command".
  let command: string | undefined;
  for (const key of ["toolArgs", "tool_input"] as const) {
    if (!(key in root)) continue;
    const args = asObject(root[key]);
    if (args === "wrong-type") return { kind: "malformed", reason: `${key} is not a JSON object or a JSON-encoded object` };
    command = flattenCommand(args["command"]);
    if (command !== undefined) break;
  }
  if (command === undefined) command = flattenCommand(root["command"]);
  if (command === undefined) return { kind: "skip" };

  const cwd = root["cwd"];
  return typeof cwd === "string" && cwd.length > 0 ? { kind: "command", command, cwd } : { kind: "command", command };
}

/**
 * Past the 1 MiB cap the payload cannot be parsed: refuse unless the prefix
 * already names a tool that is not a shell. `toolName` / `tool_name` sit
 * within the first few hundred bytes of the payload.
 */
function oversizedCopilot(prefix: string): "proceed" | "refuse" {
  const m = /"(?:toolName|tool_name)"\s*:\s*"([^"\\]{1,64})"/.exec(prefix.slice(0, 4096));
  if (m !== null && !COPILOT_SHELL_TOOLS.has(m[1]!.toLowerCase())) return "proceed";
  return "refuse";
}

function decisionJson(permissionDecision: "allow" | "ask" | "deny", reason: string): string {
  return JSON.stringify({ permissionDecision, permissionDecisionReason: reason }) + "\n";
}

function renderCopilot(verdict: HookVerdict): HostOutput {
  switch (verdict.action) {
    case "allow":
      return verdict.reason === undefined
        ? { stdout: "", exitCode: 0 }
        : { stdout: decisionJson("allow", verdict.reason), exitCode: 0 };
    case "ask":
      return { stdout: decisionJson("ask", verdict.reason), exitCode: 0 };
    case "deny":
      return { stdout: decisionJson("deny", verdict.reason), exitCode: EXIT_BLOCK };
    case "error":
      // Fail OPEN in Copilot's terms: it fails CLOSED on any non-zero exit but 2.
      return { stdout: "", exitCode: 0 };
  }
}

export const copilotAdapter: HostAdapter = {
  name: "copilot",
  hasAsk: true,
  parse: parseCopilot,
  oversized: oversizedCopilot,
  render: renderCopilot,
};
