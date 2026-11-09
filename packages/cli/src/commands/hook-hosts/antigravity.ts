// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// Antigravity CLI (`agy`): PreToolUse, matcher `run_command` (plan §5.1).
// UNVERIFIED: built from the vendor docs (antigravity.google/docs/hooks)
// alone, never run against a real host (fixture provenance `doc-derived`;
// plan task H1). Treat every choice below as a guess to confirm.
//
//   stdin   `toolCall.name` (`run_command`) and `toolCall.args.CommandLine`.
//           No root `cwd`; the working directory is a `Cwd` arg whose key was
//           not legible in the docs page (a guess), so it is read from there
//           and, when absent, the policy falls back to the hook's own cwd.
//   stdout  `{"decision": "allow" | "deny" | "ask", "reason"}`.
//
// The docs give no exit-code or failure behaviour, and do not say whether
// empty stdout means proceed. The conservative rendering for such a host:
//
//   - `allow` is the explicit `{"decision":"allow"}` (`decision` is required).
//   - Every answer exits 0, including `deny` and `error`. Exit 0 plus a JSON
//     decision is the one documented path; a non-zero exit (2 in sibling
//     hosts means "block", other codes "warn") has no documented meaning
//     here, and `error` as non-zero could block every command if this host
//     fails closed. So `deny` blocks by the JSON alone and `error` is the
//     plain allow.
//   - No `ask`: the vocabulary exists (`ask`, `force_ask`) but is unverified,
//     and an unsupported answer might run the tool. `ask` renders as `deny`.
//
// `--agent gemini` does not work with Antigravity (different config path,
// event name, payload and answer shape); this is its own adapter.
import type { HookVerdict, HostAdapter, HostOutput, ParsedHookInput } from "./types.js";

/** The shell tool's name in `toolCall.name`. */
const SHELL_TOOL = "run_command";

function parseAntigravity(stdin: string): ParsedHookInput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdin);
  } catch {
    return { kind: "malformed", reason: "stdin is not JSON" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { kind: "malformed", reason: "stdin is not a JSON object" };
  const call = (parsed as Record<string, unknown>)["toolCall"];
  if (call === undefined) return { kind: "skip" };
  if (!call || typeof call !== "object" || Array.isArray(call)) return { kind: "malformed", reason: "toolCall is not an object" };
  const toolCall = call as Record<string, unknown>;

  const name = toolCall["name"];
  if (typeof name === "string" && name.length > 0 && name.toLowerCase() !== SHELL_TOOL) return { kind: "skip" };

  const args = toolCall["args"];
  if (args === undefined) return { kind: "skip" };
  if (!args || typeof args !== "object" || Array.isArray(args)) return { kind: "malformed", reason: "toolCall.args is not an object" };
  const a = args as Record<string, unknown>;

  const command = a["CommandLine"];
  if (command === undefined) return { kind: "skip" };
  if (typeof command !== "string") return { kind: "malformed", reason: "CommandLine is not a string" };
  if (command.length === 0) return { kind: "skip" };

  const cwd = a["Cwd"];
  return typeof cwd === "string" && cwd.length > 0 ? { kind: "command", command, cwd } : { kind: "command", command };
}

/**
 * `toolCall.name` sits after the payload's own metadata, which can be long
 * (`lastUserInput`). Proceed only if the name is read, inside the first 4 KiB,
 * and is not the shell tool; otherwise refuse.
 */
function oversizedAntigravity(prefix: string): "proceed" | "refuse" {
  const m = /"toolCall"\s*:\s*\{\s*"name"\s*:\s*"([^"\\]{1,64})"/.exec(prefix.slice(0, 4096));
  if (m !== null && m[1]!.toLowerCase() !== SHELL_TOOL) return "proceed";
  return "refuse";
}

function decisionJson(decision: "allow" | "deny", reason?: string): string {
  // `decision` and `reason` are the whole vocabulary: no `overwrite`.
  return JSON.stringify(reason === undefined ? { decision } : { decision, reason }) + "\n";
}

function renderAntigravity(verdict: HookVerdict): HostOutput {
  switch (verdict.action) {
    case "allow":
      return { stdout: decisionJson("allow", verdict.reason), exitCode: 0 };
    case "ask": // no verified `ask`: never allow
    case "deny":
      return { stdout: decisionJson("deny", verdict.reason), exitCode: 0 };
    case "error":
      return { stdout: decisionJson("allow"), exitCode: 0 };
  }
}

export const antigravityAdapter: HostAdapter = {
  name: "antigravity",
  hasAsk: false,
  parse: parseAntigravity,
  oversized: oversizedAntigravity,
  render: renderAntigravity,
};
