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
// The interactive tool `send_command_input` (arg `Input`) is judged too: text
// typed into a running command is a command. A payload with no `toolCall`
// (another host's shape under this `--agent`) is `malformed`, not `skip`, so
// the wrong registration is visible.
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
import { commandResult, isObject, parseRootObject, REASON_NO_COMMAND_FIELD } from "./shapes.js";
import type { HookVerdict, HostAdapter, HostOutput, ParsedHookInput } from "./types.js";

/** The shell tool's name in `toolCall.name`. */
const SHELL_TOOL = "run_command";
/**
 * The interactive-input tool: text typed into a running command (arg `Input`).
 * It is judged as the command: `git push` typed into an open session is a push.
 */
const INPUT_TOOL = "send_command_input";
const SHELL_TOOLS: ReadonlySet<string> = new Set([SHELL_TOOL, INPUT_TOOL]);

function parseAntigravity(stdin: string): ParsedHookInput {
  const r = parseRootObject(stdin);
  if ("malformed" in r) return r.malformed;
  const call = r.root["toolCall"];
  // Every Antigravity payload has a `toolCall`. One without it came from a
  // different host's hook (a Claude- or Gemini-shaped `tool_input`) wired to
  // `--agent antigravity`: not judged, and said so.
  if (call === undefined) return { kind: "malformed", reason: "payload has no toolCall, so it is not an Antigravity payload" };
  if (!isObject(call)) return { kind: "malformed", reason: "toolCall is not an object" };

  const name = call["name"];
  const named = typeof name === "string" && name.length > 0;
  if (named && !SHELL_TOOLS.has(name.toLowerCase())) return { kind: "skip" };
  const key = named && name.toLowerCase() === INPUT_TOOL ? "Input" : "CommandLine";

  const args = call["args"];
  if (args === undefined) return named ? { kind: "malformed", reason: REASON_NO_COMMAND_FIELD } : { kind: "skip" };
  if (!isObject(args)) return { kind: "malformed", reason: "toolCall.args is not an object" };

  const command = args[key];
  if (command === undefined) return named ? { kind: "malformed", reason: REASON_NO_COMMAND_FIELD } : { kind: "skip" };
  if (typeof command !== "string") return { kind: "malformed", reason: `${key} is not a string` };
  if (command.length === 0) return { kind: "skip" };

  const cwd = args["Cwd"];
  return commandResult(command, typeof cwd === "string" && cwd.length > 0 ? cwd : undefined);
}

/**
 * `toolCall.name` sits after the payload's own metadata, which can be long
 * (`lastUserInput`). Proceed only if the name is read, inside the first 4 KiB,
 * and is not a shell tool; otherwise refuse.
 */
function oversizedAntigravity(prefix: string): "proceed" | "refuse" {
  const m = /"toolCall"\s*:\s*\{\s*"name"\s*:\s*"([^"\\]{1,64})"/.exec(prefix.slice(0, 4096));
  if (m !== null && !SHELL_TOOLS.has(m[1]!.toLowerCase())) return "proceed";
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
