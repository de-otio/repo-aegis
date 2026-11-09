// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// Codex CLI: PreToolUse, command in `tool_input.command`. Current docs name
// the shell tool `Bash` (matcher `Bash`; unified exec also matches as Bash);
// older builds sent `shell`. Both are in SHELL_TOOL_NAMES. No "ask": Codex
// marks a hook that answers `ask` as failed and runs the tool, so `ask`
// must reach Codex as a deny.
import { oversizedByToolName, parsePreToolUse, renderPreToolUse } from "./pre-tool-use.js";
import type { HostAdapter } from "./types.js";

export const codexAdapter: HostAdapter = {
  name: "codex",
  hasAsk: false,
  parse: parsePreToolUse,
  oversized: oversizedByToolName,
  render: v => renderPreToolUse(v, false),
};
