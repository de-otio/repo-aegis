// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// Claude Code: PreToolUse, matcher `Bash`, command in `tool_input.command`.
// The only host with an "ask" the hook relies on.
import { oversizedByToolName, parsePreToolUse, renderPreToolUse } from "./pre-tool-use.js";
import type { HostAdapter } from "./types.js";

export const claudeAdapter: HostAdapter = {
  name: "claude",
  hasAsk: true,
  parse: parsePreToolUse,
  oversized: oversizedByToolName,
  render: v => renderPreToolUse(v, true),
};
