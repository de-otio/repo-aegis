// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// Cursor: `beforeShellExecution` (plan T1b, §5.1). Doc-derived, not yet seen
// from a real host (fixture provenance `doc-derived`; plan task H1).
//
//   stdin   root `command` (the full command string) and `cwd`.
//   stdout  `{"permission": "allow" | "deny" | "ask", "user_message", "agent_message"}`.
//
// Facts this adapter is built on:
//
//   - Empty stdout is not documented as "proceed", and a permission hook's
//     invalid or schema-mismatching output BLOCKS the action. So `allow` is
//     the explicit `{"permission":"allow"}`, never empty (the contract's
//     "least the host accepts").
//   - `deny` is answered on stdout with exit 0, the documented path. The
//     JSON carries the reason twice: `user_message` (shown to the person) and
//     `agent_message` (fed to the model).
//   - Cursor has `ask`, enforced on `beforeShellExecution` ONLY. On
//     `preToolUse` it is accepted but not enforced, i.e. it would run the
//     tool. So this adapter judges the `beforeShellExecution` payload only
//     (a `preToolUse` payload has `tool_input.command` and no root `command`):
//     register the hook on `beforeShellExecution`. A `preToolUse` payload that
//     carries a shell command is answered `malformed` (fail open, with the
//     core's one "not judged" line), so the wrong registration is visible.
//   - A crash, a timeout and a non-zero exit other than 2 fail OPEN (unless
//     the hook entry sets `failClosed: true`), so `error` is exit 1 with
//     nothing on stdout: the guard's own defect must not block the agent.
//     (Invalid output is the one thing that fails closed, which is why exit 0
//     with empty stdout would be wrong for `error` and is not what is used.)
import { oversizedByToolName } from "./pre-tool-use.js";
import { commandInForeignShape, commandResult, parseRootObject, REASON_FOREIGN_SHAPE, rootCwd } from "./shapes.js";
import type { HookVerdict, HostAdapter, HostOutput, ParsedHookInput } from "./types.js";

const BEFORE_SHELL_EXECUTION = "beforeShellExecution";

function parseCursor(stdin: string): ParsedHookInput {
  const r = parseRootObject(stdin);
  if ("malformed" in r) return r.malformed;
  const root = r.root;

  // Another event is not this hook's business, UNLESS it carries a shell
  // command in the shape of another event or host (a `preToolUse` payload:
  // `tool_input.command`). Cursor enforces `ask` on `beforeShellExecution`
  // only, so judging `preToolUse` would turn an `ask` into a run; instead the
  // hook says, once per call, that it did not judge it: the registration is
  // on the wrong event. A non-shell tool, or an event with no command, stays
  // a silent skip.
  const event = root["hook_event_name"];
  if (typeof event === "string" && event !== BEFORE_SHELL_EXECUTION) {
    return commandInForeignShape(root, ["root"]) ? { kind: "malformed", reason: REASON_FOREIGN_SHAPE } : { kind: "skip" };
  }

  const command = root["command"];
  if (command === undefined) {
    if (event === BEFORE_SHELL_EXECUTION) return { kind: "malformed", reason: "beforeShellExecution payload has no command" };
    return commandInForeignShape(root, ["root"]) ? { kind: "malformed", reason: REASON_FOREIGN_SHAPE } : { kind: "skip" };
  }
  if (typeof command !== "string") return { kind: "malformed", reason: "command is not a string" };
  if (command.length === 0) return { kind: "skip" };

  return commandResult(command, rootCwd(root));
}

function permissionJson(permission: "allow" | "ask" | "deny", reason?: string): string {
  // `permission` plus the two message fields is the whole vocabulary: there is
  // deliberately no `updated_input`.
  const body = reason === undefined ? { permission } : { permission, user_message: reason, agent_message: reason };
  return JSON.stringify(body) + "\n";
}

function renderCursor(verdict: HookVerdict): HostOutput {
  switch (verdict.action) {
    case "allow":
      return { stdout: permissionJson("allow", verdict.reason), exitCode: 0 };
    case "ask":
      return { stdout: permissionJson("ask", verdict.reason), exitCode: 0 };
    case "deny":
      return { stdout: permissionJson("deny", verdict.reason), exitCode: 0 };
    case "error":
      return { stdout: "", exitCode: 1 };
  }
}

export const cursorAdapter: HostAdapter = {
  name: "cursor",
  hasAsk: true,
  parse: parseCursor,
  // A `beforeShellExecution` payload names no tool, so a cut one is refused;
  // a `preToolUse` payload cut after `tool_name` still proves a non-shell tool.
  oversized: oversizedByToolName,
  render: renderCursor,
};
