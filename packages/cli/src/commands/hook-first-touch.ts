// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// `repo-aegis hook first-touch` — Claude Code SessionStart entry point.
//
// Calls `firstTouchClassify` from the core library and emits the result
// as JSON on stdout. The SessionStart hook command line in
// `~/.claude/settings.json` is just `repo-aegis hook first-touch`,
// PATH-resolved at hook time. The agent reads the JSON output from the
// session-start context and reacts per the documented status shapes.
//
// Identical behaviour to the MCP `aegis_classify_first_touch` tool;
// both share the same core implementation. Output JSON is verbatim the
// `FirstTouchResult` shape — no envelope.

import { firstTouchClassify } from "@de-otio/repo-aegis-core";
import { emitJson, emitText, type OutputOptions } from "../format.js";

export interface HookFirstTouchOptions extends OutputOptions {
  cwd?: string;
}

export function hookFirstTouch(opts: HookFirstTouchOptions): void {
  const result = firstTouchClassify({
    ...(opts.cwd !== undefined && { cwd: opts.cwd }),
  });

  // Default output is JSON — Claude Code SessionStart consumes
  // structured data and shows it to the agent. The text path is
  // available behind --no-json for human inspection at the terminal.
  if (opts.json !== false) {
    emitJson(result);
    return;
  }

  // Human-readable form. Mirrors the JSON content but in lines.
  emitText(`first-touch: ${result.status}`);
  switch (result.status) {
    case "applied":
      emitText(`  class: ${result.class}`);
      if (result.engagement) emitText(`  engagement: ${result.engagement}`);
      if (result.markerWarning) {
        emitText(
          `  warning: engagement "${result.markerWarning.engagementId}" has 0 markers`,
        );
      }
      break;
    case "already-classified":
      emitText(`  class: ${result.class}`);
      break;
    case "needs-confirmation":
      emitText(`  remote: ${result.remote}`);
      emitText(`  redactedOrg: ${result.redactedOrg}`);
      break;
    case "skipped":
      emitText(`  reason: ${result.reason}`);
      break;
  }
}
