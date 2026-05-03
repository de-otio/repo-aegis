// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
import { z } from "zod";
import { firstTouchClassify } from "@de-otio/repo-aegis-core";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { jsonResult } from "./_util.js";

// Re-export for tests that import from this module path.
export {
  firstTouchClassify,
  redactOrg,
} from "@de-otio/repo-aegis-core";
export type {
  FirstTouchResult,
  FirstTouchOptions,
  FirstTouchSkipReason,
} from "@de-otio/repo-aegis-core";

const inputSchema = {
  cwd: z
    .string()
    .optional()
    .describe(
      "Working directory to inspect (defaults to the server process's cwd). Should be the agent's session cwd.",
    ),
};

/**
 * `aegis_classify_first_touch` — agent-facing entry point for Phase 1
 * of the zero-config onboarding flow. Called once per session at
 * SessionStart. Returns one of four statuses; the agent reacts:
 *
 *   - `already-classified`: nothing to do; proceed.
 *   - `applied`: per-repo config was just set; proceed. If
 *     `markerWarning` is non-null, prompt the user to populate
 *     markers via `suggest-markers`.
 *   - `needs-confirmation`: surface `redactedOrg` to the user with a
 *     confirmation prompt. On user-confirm, call
 *     `repo_aegis_engagements_add` (with the full `org` from the
 *     response) to register the engagement, then call this tool
 *     again to apply the classification.
 *   - `skipped`: nothing applicable; proceed.
 *
 * Important: this tool **does not mutate the registry**. The
 * `applied` path mutates per-repo `git config` only. Registry edits
 * always require explicit user confirmation via a follow-up
 * `repo_aegis_engagements_add` call.
 */
export function registerFirstTouchTool(server: McpServer): void {
  server.registerTool(
    "aegis_classify_first_touch",
    {
      description:
        "Classify the current repo on first touch (Phase 1 onboarding). " +
        "Returns one of: already-classified, applied, needs-confirmation, " +
        "skipped. Never mutates the registry — only per-repo git config. " +
        "On `needs-confirmation`, the agent must use `redactedOrg` in any " +
        "context-bearing summary; the full `org` is for the user's " +
        "confirmation prompt only.",
      inputSchema,
    },
    async ({ cwd }) => {
      const result = firstTouchClassify({ ...(cwd !== undefined && { cwd }) });
      return jsonResult(result);
    },
  );
}
