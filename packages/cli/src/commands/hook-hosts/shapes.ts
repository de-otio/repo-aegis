// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// The payload shapes the hosts use, side by side, so an adapter can tell
// "this payload has no command" (not this hook's business) from "this payload
// is in a shape this adapter does not read" (almost always a hook registered
// with the wrong `--agent` or event). The second is a plausible
// MISCONFIGURATION, and the hook fails open on it, so it must not be silent:
// an adapter returns `malformed` for it and the core prints one fixed line
// (hook-guard-egress.ts).
//
// Pure: no I/O, no environment, no clock.
import type { ParsedHookInput } from "./types.js";

/** Where a host puts the pending shell text. */
export type ShapeName =
  | "tool_input" // Claude Code, Codex, Gemini, Copilot PascalCase, Cursor preToolUse: tool_input.command
  | "root" //       Cursor beforeShellExecution (and the family's fallback): root `command`
  | "toolArgs" //   Copilot camelCase: toolArgs, a JSON-encoded string, .command
  | "toolCall"; //  Antigravity: toolCall.args.CommandLine (run_command) / .Input (send_command_input)

export const ALL_SHAPES: readonly ShapeName[] = ["tool_input", "root", "toolArgs", "toolCall"];

/**
 * Every tool name any known host uses for "run a shell command" or "type into a
 * running shell". Lower-case. Used where no single host's list applies: the
 * unknown-`--agent` fallback and the cross-shape check.
 */
export const ANY_SHELL_TOOL_NAMES: ReadonlySet<string> = new Set([
  "bash",
  "shell",
  "run_shell_command",
  "powershell",
  "write_bash",
  "write_powershell",
  "run_command",
  "send_command_input",
]);

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

/** A command-bearing field, classified. */
export type Field = { kind: "found"; command: string } | { kind: "empty" } | { kind: "wrong" } | { kind: "absent" };

/** Classify a command-bearing field. An argv array is flattened with {@link flattenCommand}. */
export function classify(value: unknown): Field {
  if (value === undefined) return { kind: "absent" };
  if (typeof value === "string") return value.length > 0 ? { kind: "found", command: value } : { kind: "empty" };
  if (Array.isArray(value)) {
    const c = flattenCommand(value);
    return c !== undefined ? { kind: "found", command: c } : { kind: "empty" };
  }
  return { kind: "wrong" };
}

export function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** An object, or a JSON string holding one; undefined otherwise. */
export function decodeObject(value: unknown): Record<string, unknown> | undefined {
  let v = value;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return undefined;
    }
  }
  return isObject(v) ? v : undefined;
}

/** The stdin text as a JSON object, or the `malformed` result every adapter returns for anything else. */
export function parseRootObject(stdin: string): { root: Record<string, unknown> } | { malformed: ParsedHookInput } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdin);
  } catch {
    return { malformed: { kind: "malformed", reason: "stdin is not JSON" } };
  }
  // An array was once read as an object with no fields (→ silent exit 0).
  if (!isObject(parsed)) return { malformed: { kind: "malformed", reason: "stdin is not a JSON object" } };
  return { root: parsed };
}

/** The tool a payload names, in whichever host's key: `tool_name`, `toolName`, `toolCall.name`. */
export function toolNameOf(root: Record<string, unknown>): string | undefined {
  const call = root["toolCall"];
  for (const v of [root["tool_name"], root["toolName"], isObject(call) ? call["name"] : undefined]) {
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

/**
 * The command-bearing field of one shape. `key` is `command` unless the tool
 * is an interactive-input tool (`input` for Copilot's `write_bash`, `Input`
 * for Antigravity's `send_command_input`), whose typed text is judged as the
 * command. A container that is not an object (or a JSON string of one) reads
 * as absent: only Copilot, which owns two such containers, calls that an error.
 */
export function readShape(root: Record<string, unknown>, shape: ShapeName, key = "command"): Field {
  switch (shape) {
    case "root":
      return classify(root["command"]);
    case "tool_input": {
      const o = decodeObject(root["tool_input"]);
      return o === undefined ? { kind: "absent" } : classify(o[key]);
    }
    case "toolArgs": {
      const o = decodeObject(root["toolArgs"]);
      return o === undefined ? { kind: "absent" } : classify(o[key]);
    }
    case "toolCall": {
      const call = root["toolCall"];
      if (!isObject(call) || !isObject(call["args"])) return { kind: "absent" };
      const interactive = typeof call["name"] === "string" && call["name"].toLowerCase() === "send_command_input";
      return classify(call["args"][interactive ? "Input" : "CommandLine"]);
    }
  }
}

/**
 * Whether the payload carries a non-empty command in a shape OTHER than
 * `own`, for a tool that is not named as a non-shell tool. That is the
 * signature of a hook registered under the wrong `--agent` (or, for Cursor,
 * the wrong event): the payload is a real command this adapter cannot read.
 */
export function commandInForeignShape(root: Record<string, unknown>, own: readonly ShapeName[]): boolean {
  const name = toolNameOf(root);
  if (name !== undefined && !ANY_SHELL_TOOL_NAMES.has(name.toLowerCase())) return false;
  for (const shape of ALL_SHAPES) {
    if (own.includes(shape)) continue;
    if (readShape(root, shape).kind === "found") return true;
  }
  return false;
}

/** The root `cwd`, when the payload states one (never the hook's own `process.cwd()`). */
export function rootCwd(root: Record<string, unknown>): string | undefined {
  const cwd = root["cwd"];
  return typeof cwd === "string" && cwd.length > 0 ? cwd : undefined;
}

/** The cwd a payload states, in any host's place: root `cwd`, else Antigravity's `Cwd` arg. For the unknown-agent fallback. */
export function cwdOf(root: Record<string, unknown>): string | undefined {
  const cwd = rootCwd(root);
  if (cwd !== undefined) return cwd;
  const call = root["toolCall"];
  if (isObject(call) && isObject(call["args"])) {
    const c = call["args"]["Cwd"];
    if (typeof c === "string" && c.length > 0) return c;
  }
  return undefined;
}

/** `{ kind: "command", command, cwd? }` with `cwd` left out when absent (`deepEqual`-friendly). */
export function commandResult(command: string, cwd: string | undefined): ParsedHookInput {
  return cwd !== undefined ? { kind: "command", command, cwd } : { kind: "command", command };
}

/**
 * Past the 1 MiB cap the payload cannot be parsed: refuse unless the prefix
 * already names a tool that is not a shell, in any host's spelling. For the
 * unknown-`--agent` fallback.
 */
export function oversizedAnyShape(prefix: string): "proceed" | "refuse" {
  const head = prefix.slice(0, 4096);
  const names = [
    /"(?:toolName|tool_name)"\s*:\s*"([^"\\]{1,64})"/.exec(head)?.[1],
    /"toolCall"\s*:\s*\{\s*"name"\s*:\s*"([^"\\]{1,64})"/.exec(head)?.[1],
  ].filter((n): n is string => n !== undefined);
  return names.length > 0 && names.every(n => !ANY_SHELL_TOOL_NAMES.has(n.toLowerCase())) ? "proceed" : "refuse";
}

/** The fixed reasons (no payload text, ever): what the core prints and audits. */
export const REASON_NO_COMMAND_FIELD = "a shell tool is named but the payload has no command field where this --agent reads one";
export const REASON_FOREIGN_SHAPE = "the payload carries a command in another host's shape";

/**
 * The shared tail of every adapter's parse, once its own shapes found no
 * command: an empty command field is nothing to judge (`skip`); a command in
 * another host's shape, or a named shell tool with no command field at all,
 * is a misconfiguration (`malformed`); anything else is not this hook's
 * business (`skip`).
 */
export function noOwnCommand(
  root: Record<string, unknown>,
  own: readonly ShapeName[],
  fields: readonly Field[],
  namesShellTool: boolean,
): ParsedHookInput {
  if (fields.some(f => f.kind === "empty")) return { kind: "skip" };
  if (commandInForeignShape(root, own)) return { kind: "malformed", reason: REASON_FOREIGN_SHAPE };
  if (namesShellTool) return { kind: "malformed", reason: REASON_NO_COMMAND_FIELD };
  return { kind: "skip" };
}
