// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
import { z } from "zod";
import {
  computeDenySet,
  isActive,
  loadRegistry,
  readRepoConfig,
  RegistryNotFoundError,
  type EngagementJson,
  type RepoJson,
} from "@de-otio/repo-aegis-core";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { jsonResult } from "./_util.js";

const inputSchema = {
  cwd: z
    .string()
    .optional()
    .describe(
      "Working directory to inspect (defaults to the server process's cwd). Use the repo root for accurate class detection.",
    ),
};

/**
 * `repo_aegis_status` — equivalent to `repo-aegis status --json`.
 *
 * Returns the repo's class, allowed engagements, deny-set summary, and
 * any warnings. This is the first tool an agent should call when
 * landing in a new repo: every other gate (`check`, `audit`) depends on
 * this configuration.
 */
export function registerStatusTool(server: McpServer): void {
  server.registerTool(
    "repo_aegis_status",
    {
      description:
        "Show the repo's class, allowed engagements, and deny-set summary. " +
        "Equivalent to `repo-aegis status --json`. Call this first when " +
        "landing in a new repo — every other tool (check, audit) depends on " +
        "this configuration.",
      inputSchema,
    },
    async ({ cwd }) => {
      const repo = readRepoConfig(cwd ?? process.cwd());

      let registryEngagements: { id: string; name: string; active: boolean }[] = [];
      let alwaysBlockCount = 0;
      try {
        const reg = loadRegistry();
        registryEngagements = reg.engagements.map(e => ({
          id: e.id,
          name: e.name,
          active: isActive(e),
        }));
        alwaysBlockCount = reg.alwaysBlock.length;
      } catch (err) {
        if (!(err instanceof RegistryNotFoundError)) throw err;
      }

      const denySet = computeDenySet(repo);
      const allowed: EngagementJson[] = repo.engagements.map(id => {
        const meta = registryEngagements.find(e => e.id === id);
        return { id, name: meta?.name ?? id, active: meta?.active ?? false };
      });

      const repoJson: RepoJson = {
        cwd: repo.cwd,
        isGitRepo: repo.isGitRepo,
        class: repo.class,
        classExplicit: repo.classExplicit,
        engagements: repo.engagements,
      };

      return jsonResult({
        repo: repoJson,
        allowedEngagements: allowed,
        denySet: {
          files: denySet.files.map(f => f.stem),
          patternCount: denySet.patterns.length,
        },
        alwaysBlock: { patternCount: alwaysBlockCount },
        warnings: denySet.warnings,
      });
    },
  );
}
