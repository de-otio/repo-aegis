// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerStatusTool } from "./tools/status.js";
import { registerCheckTools } from "./tools/check.js";
import { registerMarkersTools } from "./tools/markers.js";
import { registerEngagementsTools } from "./tools/engagements.js";
import { registerAuditTool } from "./tools/audit.js";

/**
 * Server identity. Bumping `version` is a coordinated change with the
 * package.json `version` field — both must move together so a connected
 * client can detect changes via `serverInfo`.
 */
const SERVER_INFO = {
  name: "repo-aegis-mcp",
  version: "0.0.1",
} as const;

/**
 * Build a new {@link McpServer} with every repo-aegis tool registered.
 *
 * Pure factory — no I/O, no transport, no side effects until the caller
 * invokes `server.connect(transport)`. Tests use this entrypoint with an
 * in-memory transport pair; the bin entry uses it with stdio.
 *
 * **Redaction policy**: every tool calls into `@de-otio/repo-aegis-core`
 * with `revealMatches: false` (the core default, but explicit in our
 * tools). MCP clients are agents, and agents must never see literal
 * matched markers — that's the whole point of redacting hits in the
 * first place.
 */
export function buildServer(): McpServer {
  const server = new McpServer(SERVER_INFO);
  registerStatusTool(server);
  registerCheckTools(server);
  registerMarkersTools(server);
  registerEngagementsTools(server);
  registerAuditTool(server);
  return server;
}
