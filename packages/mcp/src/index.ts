#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
// Bin entry for the repo-aegis MCP server. Spawns the McpServer over stdio
// and waits forever — the parent (Claude Code, Cursor, etc.) drives it via
// JSON-RPC over stdin/stdout.
//
// Keep this file tiny. The server itself is built in `server.ts` so it can
// be imported from tests without triggering stdio attach.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildServer } from "./server.js";

const server = buildServer();
const transport = new StdioServerTransport();
await server.connect(transport);
