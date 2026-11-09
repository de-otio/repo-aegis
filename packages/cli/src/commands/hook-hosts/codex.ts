// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// Codex CLI: PreToolUse, command in `tool_input.command`. Current docs name
// the shell tool `Bash` (matcher `Bash`; unified exec also matches as Bash);
// older builds sent `shell`. Both are in SHELL_TOOL_NAMES. No "ask": Codex
// marks a hook that answers `ask` as failed and runs the tool, so `ask`
// must reach Codex as a deny.
//
// Known limit: Codex's `write_stdin` (text typed into a running exec session;
// its field name is not in the hook docs this adapter was built from) is
// skipped like any other non-shell tool, so a command typed into an open
// session is not judged. Copilot and Antigravity input tools are judged.
import { oversizedByToolName, parsePreToolUse, renderPreToolUse } from "./pre-tool-use.js";
import type { HostAdapter } from "./types.js";

export const codexAdapter: HostAdapter = {
  name: "codex",
  hasAsk: false,
  parse: parsePreToolUse,
  oversized: oversizedByToolName,
  render: v => renderPreToolUse(v, false),
};
