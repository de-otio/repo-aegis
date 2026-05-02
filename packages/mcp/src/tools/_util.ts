import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/**
 * Wrap a JSON-shaped value as the canonical MCP tool result.
 *
 * Every repo-aegis MCP tool returns the same JSON shape that the CLI
 * emits with `--json`, so the agent-guide quick-reference table applies
 * unchanged. We expose it via two channels:
 *   1. `content[0].text` — pretty-printed JSON, the legacy-compatible
 *      surface every MCP client can read.
 *   2. `structuredContent` — the parsed object, for clients that prefer
 *      the typed shape over re-parsing the text.
 */
export function jsonResult(value: unknown): CallToolResult {
  const text = JSON.stringify(value, null, 2);
  return {
    content: [{ type: "text", text }],
    structuredContent: value as Record<string, unknown>,
  };
}

/**
 * Wrap a thrown Error as an MCP tool error result. Tools should let
 * unexpected errors propagate (the SDK will translate them), but for
 * known/expected failure modes (e.g. registry-not-found, not-a-git-repo)
 * we'd rather return a structured error than a generic JSON-RPC error
 * so the agent can read `code` and act on it.
 */
export function errorResult(payload: { code?: string; error: string; details?: unknown }): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload as Record<string, unknown>,
    isError: true,
  };
}
