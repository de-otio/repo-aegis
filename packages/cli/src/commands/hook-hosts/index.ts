// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// `--agent <name>` → host adapter. To add a host: write `<name>.ts`
// exporting a `HostAdapter` (contract in ./types.ts and plan §5 "T1a adapter
// contract"), add it to ADAPTERS, add its fixtures to
// `__fixtures__/hosts/index.json`.
import { antigravityAdapter } from "./antigravity.js";
import { claudeAdapter } from "./claude.js";
import { codexAdapter } from "./codex.js";
import { copilotAdapter } from "./copilot.js";
import { cursorAdapter } from "./cursor.js";
import { geminiAdapter } from "./gemini.js";
import { parseAnyShape, renderPreToolUse } from "./pre-tool-use.js";
import { oversizedAnyShape } from "./shapes.js";
import type { HostAdapter } from "./types.js";

export type { HookVerdict, HostAdapter, HostOutput, ParsedHookInput } from "./types.js";

export const ADAPTERS: ReadonlyMap<string, HostAdapter> = new Map(
  [claudeAdapter, codexAdapter, copilotAdapter, geminiAdapter, cursorAdapter, antigravityAdapter].map(a => [a.name, a] as const),
);

/**
 * The adapter for `--agent <name>`; `claude` when no name is given. The name
 * is matched case-insensitively (`--agent Antigravity` is a plausible way to
 * write the flag, and silently getting the fallback for it would be a quiet
 * misconfiguration).
 *
 * An unrecognised name gets the PreToolUse-family RENDERING without an ask:
 * the hook has always treated an unknown host as one that cannot ask, so
 * `ask` degrades to `deny` there and never to `allow`. It is not an error,
 * because a typo in a host's hook config must not turn into exit 1 on every
 * command (fail open) — and must not silently become `claude` either (which
 * asks). Its PARSE tries every known shape in turn ({@link parseAnyShape}),
 * so a host that sends a known payload under an unlisted name is still judged.
 */
export function adapterFor(name: string | undefined): HostAdapter {
  const n = name ?? "claude";
  return (
    ADAPTERS.get(n.toLowerCase()) ?? {
      name: n,
      hasAsk: false,
      parse: parseAnyShape,
      oversized: oversizedAnyShape,
      render: v => renderPreToolUse(v, false),
    }
  );
}
