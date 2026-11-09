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
//     (the reason is required) or exit 2, for camelCase `preToolUse`; the
//     PascalCase `PreToolUse` reads `hookSpecificOutput.permissionDecision`
//     instead. The render cannot tell which event called, so ONE object
//     carries the decision in both places. Empty stdout with exit 0 is the
//     host's normal permission flow, so a plain allow prints nothing.
//   - Interactive shell input (`write_bash`, `write_powershell`, field
//     `input`) is judged as the command: typed text can be a push.
//   - Copilot FAILS CLOSED on a non-zero exit other than 2 ("hook errored"),
//     so the guard's own internal-error exit 1 would block every command.
//     `error` therefore renders as an allow: exit 0, empty stdout. This
//     adapter never exits 1.
//   - `ask` exists in the interactive CLI; the cloud agent and autopilot mode
//     treat it as a deny. That is the safe direction (a deny where nobody can
//     answer), so `hasAsk` is true: an `ask` never reaches an allow on either.
//   - `modifiedArgs` (a rewrite field) is never emitted: decision-only.
import { EXIT_BLOCK, SHELL_TOOL_NAMES } from "./pre-tool-use.js";
import { commandResult, decodeObject, noOwnCommand, parseRootObject, readShape, rootCwd, type Field, type ShapeName } from "./shapes.js";
import type { HookVerdict, HostAdapter, HostOutput, ParsedHookInput } from "./types.js";

/**
 * Copilot's interactive shell-input tools: text typed into a running shell
 * session (`input`). That text is judged as the command: `git push` typed into
 * a session that is already open is a push like any other.
 */
const COPILOT_INPUT_TOOLS: ReadonlySet<string> = new Set(["write_bash", "write_powershell"]);

/** Copilot's shell tools: the family's names, `powershell` (its Windows shell tool) and the input tools. */
const COPILOT_SHELL_TOOLS: ReadonlySet<string> = new Set([...SHELL_TOOL_NAMES, "powershell", ...COPILOT_INPUT_TOOLS]);

function parseCopilot(stdin: string): ParsedHookInput {
  const r = parseRootObject(stdin);
  if ("malformed" in r) return r.malformed;
  const root = r.root;

  // camelCase `toolName` (preToolUse) or snake_case `tool_name` (PreToolUse).
  const toolName = typeof root["toolName"] === "string" ? root["toolName"] : root["tool_name"];
  const named = typeof toolName === "string" && toolName.length > 0;
  if (named && !COPILOT_SHELL_TOOLS.has(toolName.toLowerCase())) return { kind: "skip" };
  const key = named && COPILOT_INPUT_TOOLS.has(toolName.toLowerCase()) ? "input" : "command";

  // The argument container, by shape: `toolArgs` (string) or `tool_input`
  // (object or string). Whichever is present must decode to an object; a
  // field of the wrong type is `malformed`, never silently "no command".
  const own: readonly ShapeName[] = ["toolArgs", "tool_input", "root"];
  const fields: Field[] = [];
  for (const shape of ["toolArgs", "tool_input"] as const) {
    if (!(shape in root)) continue;
    if (decodeObject(root[shape]) === undefined) return { kind: "malformed", reason: `${shape} is not a JSON object or a JSON-encoded object` };
    const f = readShape(root, shape, key);
    if (f.kind === "found") return commandResult(f.command, rootCwd(root));
    fields.push(f);
  }
  const f = readShape(root, "root");
  if (f.kind === "found") return commandResult(f.command, rootCwd(root));
  fields.push(f);
  // No command: a named shell tool with no command field, or a command in
  // another host's shape (Antigravity's `toolCall`), is `malformed`.
  return noOwnCommand(root, own, fields, named);
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
  // The two events read different places, and the render does not know which
  // one called: camelCase `preToolUse` reads the top-level `permissionDecision`,
  // PascalCase `PreToolUse` reads `hookSpecificOutput`. One object carries
  // the decision in both, so an `ask` or `deny` lands whichever event is wired.
  return (
    JSON.stringify({
      permissionDecision,
      permissionDecisionReason: reason,
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision, permissionDecisionReason: reason },
    }) + "\n"
  );
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
