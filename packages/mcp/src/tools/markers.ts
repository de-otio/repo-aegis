// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  ALWAYS_FILE_STEM,
  computeDenySet,
  markersDir as defaultMarkersDir,
  readRepoConfig,
  redactMatch,
} from "@de-otio/repo-aegis-core";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errorResult, jsonResult } from "./_util.js";

interface MarkersFile {
  stem: string;
  path: string;
  patterns: string[];
}

function readMarkerFiles(dir: string): MarkersFile[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(f => f.endsWith(".txt"))
    .sort()
    .map(f => {
      const path = join(dir, f);
      const lines = readFileSync(path, "utf8").split("\n");
      const patterns: string[] = [];
      for (const raw of lines) {
        const trimmed = raw.trim();
        if (trimmed.length === 0 || trimmed.startsWith(";")) continue;
        patterns.push(trimmed);
      }
      return { stem: f.replace(/\.txt$/, ""), path, patterns };
    });
}

const testInput = {
  input: z
    .string()
    .min(1)
    .describe("The string to probe against this repo's scoped deny set."),
  cwd: z
    .string()
    .optional()
    .describe("Working directory for repo class/engagement lookup (defaults to server cwd)."),
};

export function registerMarkersTools(server: McpServer): void {
  server.registerTool(
    "repo_aegis_markers_test",
    {
      description:
        "Probe whether a string would trip this repo's scoped deny set. " +
        "Equivalent to `repo-aegis markers test <string> --json`. Returns " +
        "the matching pattern's engagement attribution and index, but " +
        "ALWAYS redacts the literal pattern (no `--verbose` path here). " +
        "Use this when the agent suspects a string might be a marker but " +
        "wants to confirm before mentioning it to the user.",
      inputSchema: testInput,
    },
    async ({ input, cwd }) => {
      const repo = readRepoConfig(cwd ?? process.cwd());
      const denySet = computeDenySet(repo);
      const inputPreview = redactMatch(input);

      if (denySet.combinedRegex === "") {
        return jsonResult({
          action: "markers-test",
          input: inputPreview,
          hits: [],
          repo: { class: repo.class, engagements: repo.engagements },
          warnings: denySet.warnings,
        });
      }

      const hits: { fileStem: string; index: number; preview: string }[] = [];
      for (const f of denySet.files) {
        const lines = readFileSync(f.path, "utf8").split("\n");
        const patterns: string[] = [];
        for (const raw of lines) {
          const trimmed = raw.trim();
          if (trimmed.length === 0 || trimmed.startsWith(";")) continue;
          patterns.push(trimmed);
        }
        for (let i = 0; i < patterns.length; i++) {
          const p = patterns[i]!;
          let re: RegExp;
          try {
            re = new RegExp(p, "i");
          } catch {
            continue;
          }
          if (re.test(input)) {
            hits.push({ fileStem: f.stem, index: i, preview: redactMatch(p) });
          }
        }
      }

      return jsonResult({
        action: "markers-test",
        input: inputPreview,
        hits,
        repo: { class: repo.class, engagements: repo.engagements },
        warnings: denySet.warnings,
      });
    },
  );

  // The orchestrator may also want a redacted listing of every active
  // marker file. We expose the same shape as `repo-aegis markers list
  // --json` (no --verbose path) so an agent can reason about which
  // engagements have markers loaded without ever seeing literal patterns.
  server.registerTool(
    "repo_aegis_markers_list",
    {
      description:
        "List active marker files (engagement-id + pattern count + per-pattern " +
        "previews). Equivalent to `repo-aegis markers list --json`. Patterns " +
        "are ALWAYS redacted; the `--verbose` literal-reveal path is " +
        "deliberately not exposed over MCP.",
      inputSchema: {},
    },
    async () => {
      const dir = defaultMarkersDir();
      const files = readMarkerFiles(dir);
      return jsonResult({
        action: "markers-list",
        markersDir: dir,
        files: files.map(f => ({
          stem: f.stem,
          path: f.path,
          isAlwaysBlock: f.stem === ALWAYS_FILE_STEM,
          patternCount: f.patterns.length,
          patterns: f.patterns.map((p, i) => ({ index: i, preview: redactMatch(p) })),
        })),
        verbose: false,
      });
    },
  );

  // Silence unused-import warnings for `errorResult` (kept for future
  // structured-error returns from this module).
  void errorResult;
}
