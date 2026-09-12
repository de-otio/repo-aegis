// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
import { statSync } from "node:fs";
import { z } from "zod";
import {
  computeDenySet,
  CustomerCoupledNoEngagementError,
  DEFAULT_MAX_SCAN_FILES,
  readRepoConfig,
  scanFile,
  scanDirectory,
  resolveScanTarget,
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
  /** Directory scans only — see `check --path` in doc/cli-reference.md. */
  filesScanned?: number;
  skippedDirs?: string[];
}

/** True when `path` is a directory; false for anything that cannot be stat'ed. */
function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
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
      "File or directory to scan. Resolved (symlinks followed) and rejected if it escapes " +
        "the repo working tree. A directory is walked recursively: `.git` is not entered, " +
        "symlinks are not followed, and more than 10000 files is a refusal, not a partial scan.",
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
        "Scan a single file — or every file under a directory, recursively — " +
        "against this repo's scoped deny set. " +
        "Equivalent to `repo-aegis check --path <path> --json`. Returns hits " +
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
      // #97.3: a relative `path` resolves against the repo named by `cwd`, not
      // against the SERVER's cwd — which is wherever the MCP host happened to
      // start and almost never the repo the agent means.
      const target = resolveScanTarget(path, repo.cwd);
      const workingTree = repo.isGitRepo ? repo.cwd : undefined;
      // Mirrors `check --path`: a directory is walked rather than handed to
      // the file scanner, which used to read it as an unreadable file. Every
      // file still goes through `scanFile`, so there is one scanning path.
      let dirScan: { filesScanned: number; skippedDirs: string[] } | undefined;
      try {
        if (isDirectory(target)) {
          const r = scanDirectory(target, denySet, SCAN_OPTS, workingTree);
          if (r.limitExceeded) {
            return errorResult({
              code: "PATH_TOO_MANY_FILES",
              error:
                `nothing was scanned: the directory holds more than ${DEFAULT_MAX_SCAN_FILES} ` +
                `file(s), and a truncated scan would read as a clean one — scan a narrower path`,
            });
          }
          hits = r.hits;
          skipped = r.skipped;
          dirScan = { filesScanned: r.filesScanned, skippedDirs: r.skippedDirs };
        } else {
          const r = scanFile(target, denySet, SCAN_OPTS, workingTree);
          hits = r.hits;
          skipped = r.skipped;
        }
      } catch (err) {
        return errorResult({ error: (err as Error).message });
      }
      // The requested path is the whole scope of this tool, so reading
      // nothing means nothing was scanned. Returning `hits: []` would read to
      // the agent as "this is clean" — the one answer this tool must never
      // give without having looked. For a directory, files skipped for size
      // or binary content do not fail the run; the rest of the tree was read.
      const scannedNothing = dirScan !== undefined ? dirScan.filesScanned === 0 : skipped.length > 0;
      if (scannedNothing) {
        const why = [...new Set(skipped.map(s => s.reason))].join(", ");
        return errorResult({
          code: "PATH_NOT_SCANNED",
          error:
            `nothing was scanned: ${dirScan !== undefined ? "no file under the requested directory was read" : "the requested path was skipped"}` +
            `${why === "" ? "" : ` (${why})`} — this is NOT a clean result`,
        });
      }
      const result: CheckResultShape = {
        mode: "path",
        hits,
        historyHits: [],
        skipped,
        ...(dirScan !== undefined && {
          filesScanned: dirScan.filesScanned,
          skippedDirs: dirScan.skippedDirs,
        }),
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
