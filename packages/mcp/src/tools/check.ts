// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
import { z } from "zod";
import {
  computeDenySet,
  CustomerCoupledNoEngagementError,
  readRepoConfig,
  scanFile,
  scanStagedDiff,
  type HistoryHit,
  type RepoJson,
  type ScanHit,
  type ScanOptions,
  type SkippedFile,
} from "@de-otio/repo-aegis-core";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errorResult, jsonResult } from "./_util.js";

/**
 * Hard-coded redaction policy: literal markers MUST NOT cross the MCP
 * boundary. The `--verbose` / `revealMatches` path is for a human at a
 * terminal only. Setting this explicitly (rather than relying on the
 * core default) keeps the policy auditable from this file alone.
 */
const SCAN_OPTS: ScanOptions = { revealMatches: false };

interface CheckResultShape {
  mode: "staged" | "path";
  hits: ScanHit[];
  historyHits: HistoryHit[];
  skipped: SkippedFile[];
  repo: RepoJson;
  denySet: { files: string[]; patternCount: number };
  advisory: boolean;
  warnings: string[];
}

function repoJson(repo: ReturnType<typeof readRepoConfig>): RepoJson {
  return {
    cwd: repo.cwd,
    isGitRepo: repo.isGitRepo,
    class: repo.class,
    classExplicit: repo.classExplicit,
    engagements: repo.engagements,
  };
}

const checkPathInput = {
  path: z
    .string()
    .describe(
      "Path to scan. Resolved (symlinks followed) and rejected if it escapes the repo working tree.",
    ),
  cwd: z
    .string()
    .optional()
    .describe("Working directory for repo class/engagement lookup (defaults to server cwd)."),
};

const checkStagedInput = {
  cwd: z
    .string()
    .optional()
    .describe("Working directory inside the git repo whose staged diff to scan."),
};

export function registerCheckTools(server: McpServer): void {
  server.registerTool(
    "repo_aegis_check_path",
    {
      description:
        "Scan a single file against this repo's scoped deny set. " +
        "Equivalent to `repo-aegis check --path <file> --json`. Returns hits " +
        "with line/column and engagement attribution; literal matches are " +
        "redacted (matchPreview), and the agent must NEVER paste them back to " +
        "the user verbatim — refer to the leak abstractly.",
      inputSchema: checkPathInput,
    },
    async ({ path, cwd }) => {
      const repo = readRepoConfig(cwd ?? process.cwd());
      if (repo.isGitRepo && repo.class === "customer-coupled" && repo.engagements.length === 0) {
        const err = new CustomerCoupledNoEngagementError();
        return errorResult({ code: err.code, error: err.message });
      }
      const denySet = computeDenySet(repo);
      if (denySet.combinedRegex === "") {
        return jsonResult({
          mode: "path",
          hits: [],
          historyHits: [],
          skipped: [],
          repo: repoJson(repo),
          denySet: { files: denySet.files.map(f => f.stem), patternCount: 0 },
          advisory: repo.class === "scratch",
          warnings: denySet.warnings,
          status: "no-deny-set",
        });
      }
      let hits: ScanHit[] = [];
      let skipped: SkippedFile[] = [];
      try {
        const r = scanFile(path, denySet, SCAN_OPTS, repo.isGitRepo ? repo.cwd : undefined);
        hits = r.hits;
        skipped = r.skipped;
      } catch (err) {
        return errorResult({ error: (err as Error).message });
      }
      const result: CheckResultShape = {
        mode: "path",
        hits,
        historyHits: [],
        skipped,
        repo: repoJson(repo),
        denySet: { files: denySet.files.map(f => f.stem), patternCount: denySet.patterns.length },
        advisory: repo.class === "scratch",
        warnings: denySet.warnings,
      };
      return jsonResult(result);
    },
  );

  server.registerTool(
    "repo_aegis_check_staged",
    {
      description:
        "Scan the staged diff (added lines only) against this repo's scoped " +
        "deny set. Equivalent to `repo-aegis check --staged --json`. Use this " +
        "as a pre-commit gate. Returns the same shape as check_path; redaction " +
        "applies.",
      inputSchema: checkStagedInput,
    },
    async ({ cwd }) => {
      const repo = readRepoConfig(cwd ?? process.cwd());
      if (!repo.isGitRepo) {
        return errorResult({
          code: "NOT_GIT_REPO",
          error: "not a git repo; --staged requires a git repo",
        });
      }
      if (repo.class === "customer-coupled" && repo.engagements.length === 0) {
        const err = new CustomerCoupledNoEngagementError();
        return errorResult({ code: err.code, error: err.message });
      }
      const denySet = computeDenySet(repo);
      if (denySet.combinedRegex === "") {
        return jsonResult({
          mode: "staged",
          hits: [],
          historyHits: [],
          skipped: [],
          repo: repoJson(repo),
          denySet: { files: denySet.files.map(f => f.stem), patternCount: 0 },
          advisory: repo.class === "scratch",
          warnings: denySet.warnings,
          status: "no-deny-set",
        });
      }
      const r = scanStagedDiff(repo, denySet, SCAN_OPTS);
      const result: CheckResultShape = {
        mode: "staged",
        hits: r.hits,
        historyHits: [],
        skipped: r.skipped,
        repo: repoJson(repo),
        denySet: { files: denySet.files.map(f => f.stem), patternCount: denySet.patterns.length },
        advisory: repo.class === "scratch",
        warnings: denySet.warnings,
      };
      return jsonResult(result);
    },
  );
}
