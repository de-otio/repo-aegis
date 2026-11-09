// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// Gemini CLI: BeforeTool, matcher `run_shell_command`, command in
// `tool_input.command`. No "ask". Gemini CLI was replaced by Antigravity CLI
// in June 2026; Antigravity's payload is different (`toolCall.args.CommandLine`)
// and needs its own adapter, not this one (plan §5).
import { oversizedByToolName, parsePreToolUse, renderPreToolUse } from "./pre-tool-use.js";
import type { HostAdapter } from "./types.js";

export const geminiAdapter: HostAdapter = {
  name: "gemini",
  hasAsk: false,
  parse: parsePreToolUse,
  oversized: oversizedByToolName,
  render: v => renderPreToolUse(v, false),
};
