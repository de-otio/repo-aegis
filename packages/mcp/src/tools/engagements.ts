// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
import { z } from "zod";
import {
  isActive,
  loadRegistry,
  RegistryNotFoundError,
} from "@de-otio/repo-aegis-core";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errorResult, jsonResult } from "./_util.js";

const listInput = {
  includeEnded: z
    .boolean()
    .optional()
    .describe(
      "If true, include engagements past the 12-month retention window (equivalent to `--all`). Default: false.",
    ),
};

const showInput = {
  id: z.string().min(1).describe("Engagement id (exact, not fuzzy)."),
};

export function registerEngagementsTools(server: McpServer): void {
  server.registerTool(
    "repo_aegis_engagements_list",
    {
      description:
        "List engagements in the registry. Equivalent to " +
        "`repo-aegis engagements list --json`. Returns id, name, started, " +
        "ended, active, markerCount per engagement (markers themselves are " +
        "NOT exposed). Use `includeEnded` to see retained ended engagements.",
      inputSchema: listInput,
    },
    async ({ includeEnded }) => {
      let reg;
      try {
        reg = loadRegistry();
      } catch (err) {
        if (err instanceof RegistryNotFoundError) {
          return errorResult({
            code: "REGISTRY_NOT_FOUND",
            error: "engagement registry not found; run `repo-aegis init` first",
            details: err.path,
          });
        }
        return errorResult({ error: (err as Error).message });
      }
      const filtered = includeEnded ? reg.engagements : reg.engagements.filter(isActive);
      return jsonResult({
        engagements: filtered.map(e => ({
          id: e.id,
          name: e.name,
          started: e.started ?? null,
          ended: e.ended ?? null,
          active: isActive(e),
          markerCount: e.markers.length,
        })),
        alwaysBlock: { patternCount: reg.alwaysBlock.length },
      });
    },
  );

  server.registerTool(
    "repo_aegis_engagements_show",
    {
      description:
        "Show one engagement's metadata (no markers). Equivalent to " +
        "`repo-aegis engagements show <id> --json`. Returns id, name, started, " +
        "ended, active, markerCount, notes.",
      inputSchema: showInput,
    },
    async ({ id }) => {
      let reg;
      try {
        reg = loadRegistry();
      } catch (err) {
        if (err instanceof RegistryNotFoundError) {
          return errorResult({
            code: "REGISTRY_NOT_FOUND",
            error: "engagement registry not found; run `repo-aegis init` first",
            details: err.path,
          });
        }
        return errorResult({ error: (err as Error).message });
      }
      const e = reg.engagements.find(x => x.id === id);
      if (!e) {
        return errorResult({
          code: "ENGAGEMENT_NOT_FOUND",
          error: `engagement "${id}" not found`,
        });
      }
      return jsonResult({
        action: "engagements-show",
        id: e.id,
        name: e.name,
        started: e.started ?? null,
        ended: e.ended ?? null,
        active: isActive(e),
        markerCount: e.markers.length,
        notes: e.notes ?? null,
      });
    },
  );
}
