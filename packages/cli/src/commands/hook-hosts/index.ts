// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// `--agent <name>` → host adapter. To add a host: write `<name>.ts`
// exporting a `HostAdapter` (contract in ./types.ts and plan §5 "T1a adapter
// contract"), add it to ADAPTERS, add its fixtures to
// `__fixtures__/hosts/index.json`.
import { claudeAdapter } from "./claude.js";
import { codexAdapter } from "./codex.js";
import { copilotAdapter } from "./copilot.js";
import { geminiAdapter } from "./gemini.js";
import { oversizedByToolName, parsePreToolUse, renderPreToolUse } from "./pre-tool-use.js";
import type { HostAdapter } from "./types.js";

export type { HookVerdict, HostAdapter, HostOutput, ParsedHookInput } from "./types.js";

export const ADAPTERS: ReadonlyMap<string, HostAdapter> = new Map(
  [claudeAdapter, codexAdapter, copilotAdapter, geminiAdapter].map(a => [a.name, a] as const),
);

/**
 * The adapter for `--agent <name>`; `claude` when no name is given.
 *
 * An unrecognised name gets the PreToolUse-family edges WITHOUT an ask: the
 * hook has always treated an unknown host as one that cannot ask, so `ask`
 * degrades to `deny` there and never to `allow`. It is not an error, because
 * a typo in a host's hook config must not turn into exit 1 on every command
 * (fail open) — and must not silently become `claude` either (which asks).
 */
export function adapterFor(name: string | undefined): HostAdapter {
  const n = name ?? "claude";
  return (
    ADAPTERS.get(n) ?? {
      name: n,
      hasAsk: false,
      parse: parsePreToolUse,
      oversized: oversizedByToolName,
      render: v => renderPreToolUse(v, false),
    }
  );
}
