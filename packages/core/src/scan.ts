import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, existsSync, statSync, realpathSync } from "node:fs";
import { isAbsolute, relative } from "node:path";
import parseDiff from "parse-diff";
import type { DenySet } from "./deny-set.js";
import type { RepoConfig } from "./repo.js";
import { redactMatch, revealMatch, type RedactionMode } from "./redaction.js";
import { OutsideWorkingTreeError } from "./exceptions.js";

const DEFAULT_MAX_FILE_BYTES = 1024 * 1024; // 1 MiB

// Cap for `git diff` capture in scanStagedDiff / scanRange. 256 MiB is a
// generous upper bound for "200 commits of large refactors"; larger pushes
// will be truncated (see runGitDiff). Streaming would avoid this entirely
// but is more invasive than this batch warrants.
const DIFF_MAX_BUFFER = 256 * 1024 * 1024;

export interface ScanHit {
  path?: string;
  line: number;
  column: number;
  matchPreview: string;
  // Future (v0.3): pattern, engagement attribution
}

export interface SkippedFile {
  path: string;
  reason: "binary" | "too-large" | "unreadable";
  bytes?: number;
}

export interface ScanOptions {
  revealMatches?: boolean;
  redactionMode?: RedactionMode;
  maxFileBytes?: number;
  /** When true, treat lines containing `repo-aegis: allow` as suppressed. Default: true. */
  respectAllowComments?: boolean;
}

/**
 * A line is allowed-by-comment if it contains the literal token
 * `repo-aegis: allow` (case-insensitive). Optional reason can follow,
 * e.g. `// repo-aegis: allow — synthetic test fixture`. The token is
 * intentionally explicit (not just `allow`) to avoid accidental
 * suppression by unrelated comments.
 */
export const ALLOW_COMMENT = /repo-aegis:\s*allow\b/i;

function formatMatch(literal: string, opts: ScanOptions): string {
  if (opts.revealMatches) return revealMatch(literal);
  return redactMatch(literal, opts.redactionMode ?? "preview");
}

/**
 * Scan an arbitrary text body. The most general primitive; called by
 * the more specific scanners after they've extracted text from their
 * input (staged diff, file contents, commit range diff).
 */
export function scanText(
  text: string,
  denySet: DenySet,
  path?: string,
  opts: ScanOptions = {},
): ScanHit[] {
  if (!denySet.combinedRegex) return [];
  const re = new RegExp(denySet.combinedRegex, "i");
  const respectAllow = opts.respectAllowComments !== false;
  const hits: ScanHit[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const m = line.match(re);
    if (m && m[0]) {
      if (respectAllow && ALLOW_COMMENT.test(line)) continue;
      hits.push({
        ...(path !== undefined && { path }),
        line: i + 1,
        column: (m.index ?? 0) + 1,
        matchPreview: formatMatch(m[0], opts),
      });
    }
  }
  return hits;
}

/**
 * Scan a single file from disk. Canonicalises the path via realpath to
 * defeat symlink-tricks. Rejects paths outside the repo working tree
 * (or current cwd if not in a git repo).
 */
export function scanFile(
  path: string,
  denySet: DenySet,
  opts: ScanOptions = {},
  workingTree?: string,
): { hits: ScanHit[]; skipped: SkippedFile[] } {
  const skipped: SkippedFile[] = [];
  if (!existsSync(path)) {
    skipped.push({ path, reason: "unreadable" });
    return { hits: [], skipped };
  }
  let real: string;
  try {
    real = realpathSync(path);
  } catch {
    skipped.push({ path, reason: "unreadable" });
    return { hits: [], skipped };
  }
  if (workingTree) {
    const wtReal = realpathSync(workingTree);
    const rel = relative(wtReal, real);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      throw new OutsideWorkingTreeError(real, wtReal);
    }
  }
  const stat = statSync(real);
  const max = opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  if (stat.size > max) {
    skipped.push({ path: real, reason: "too-large", bytes: stat.size });
    return { hits: [], skipped };
  }
  let buf: Buffer;
  try {
    buf = readFileSync(real);
  } catch {
    skipped.push({ path: real, reason: "unreadable" });
    return { hits: [], skipped };
  }
  if (looksBinary(buf)) {
    skipped.push({ path: real, reason: "binary", bytes: stat.size });
    return { hits: [], skipped };
  }
  const text = buf.toString("utf8");
  return { hits: scanText(text, denySet, real, opts), skipped };
}

/**
 * Run `git diff <args>` and return its stdout. Uses `spawnSync` with a
 * 256 MiB cap (vs. the previous `execFileSync` 64 MiB) so multi-commit
 * pushes are less likely to throw on overflow. If `spawnSync` reports
 * `ENOBUFS` (cap exceeded) we emit a one-line warning to stderr and
 * scan whatever stdout we did get — partial scanning is better than a
 * hard hook failure that strands the user.
 */
function runGitDiff(cwd: string, args: readonly string[]): string {
  const r = spawnSync("git", ["diff", ...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: DIFF_MAX_BUFFER,
  });
  if (r.error) {
    const err = r.error as NodeJS.ErrnoException;
    if (err.code === "ENOBUFS") {
      process.stderr.write(
        `repo-aegis: git diff output exceeded ${DIFF_MAX_BUFFER} bytes; scanning truncated output. Consider scanning a smaller range.\n`,
      );
      return typeof r.stdout === "string" ? r.stdout : "";
    }
    throw err;
  }
  if (r.status !== 0) {
    const stderr = typeof r.stderr === "string" ? r.stderr : "";
    throw new Error(`git diff exited ${r.status ?? "?"}: ${stderr.trim()}`);
  }
  return typeof r.stdout === "string" ? r.stdout : "";
}

/**
 * Extract added-line content from a unified diff. Uses `parse-diff` so
 * we correctly handle:
 *   - rename diffs (`+++ b/new-name` is a header, not content)
 *   - in-context lines whose content begins with `+`
 *   - `\ No newline at end of file` markers
 *   - binary-diff stanzas (no `add` changes emitted)
 * Returns the additions joined by `\n` so the existing line/column
 * machinery in scanText keeps working.
 */
function extractAdditions(diff: string): string {
  const files = parseDiff(diff);
  const lines: string[] = [];
  for (const file of files) {
    for (const chunk of file.chunks) {
      for (const change of chunk.changes) {
        if (change.type === "add") {
          // `change.content` includes the leading `+`; strip it to
          // match the prior behaviour and avoid double-counting.
          const content = change.content.startsWith("+")
            ? change.content.slice(1)
            : change.content;
          lines.push(content);
        }
      }
    }
  }
  return lines.join("\n");
}

/**
 * Scan the staged diff in a git repo. Pre-commit hook entry point.
 */
export function scanStagedDiff(
  repo: RepoConfig,
  denySet: DenySet,
  opts: ScanOptions = {},
): { hits: ScanHit[]; skipped: SkippedFile[] } {
  if (!repo.isGitRepo) return { hits: [], skipped: [] };
  if (!denySet.combinedRegex) return { hits: [], skipped: [] };

  const diff = runGitDiff(repo.cwd, [
    "--cached",
    "--diff-filter=ACM",
    "-U0",
    "--no-color",
  ]);
  const addedLines = extractAdditions(diff);
  return { hits: scanText(addedLines, denySet, undefined, opts), skipped: [] };
}

/**
 * Scan the diff over an arbitrary git range (e.g. `main..HEAD`,
 * `<remote-sha>..<local-sha>`). Pre-push hook entry point.
 *
 * Only added-line content is scanned. The caller is responsible for
 * passing a syntactically valid range; if `git diff` exits non-zero,
 * the throw propagates.
 */
export function scanRange(
  repo: RepoConfig,
  denySet: DenySet,
  range: string,
  opts: ScanOptions = {},
): { hits: ScanHit[]; skipped: SkippedFile[] } {
  if (!repo.isGitRepo) return { hits: [], skipped: [] };
  if (!denySet.combinedRegex) return { hits: [], skipped: [] };

  const diff = runGitDiff(repo.cwd, [
    range,
    "--diff-filter=ACM",
    "-U0",
    "--no-color",
  ]);
  const addedLines = extractAdditions(diff);
  return { hits: scanText(addedLines, denySet, undefined, opts), skipped: [] };
}

export interface HistoryHit {
  pattern: string;
  commitSha: string;
  commitSummary: string;
}

/**
 * Scan the full git history with `git log -G <pattern>` per pattern.
 * Returns one HistoryHit per (pattern, commit) match. Cost scales as
 * O(patterns × history-size); use sparingly.
 *
 * The pattern field is redacted by default (preview mode) — same
 * policy as scan hits. Pass `revealMatches: true` to opt into
 * literals (NEVER from a hook).
 */
export function scanHistory(
  repo: RepoConfig,
  denySet: DenySet,
  opts: ScanOptions = {},
): HistoryHit[] {
  if (!repo.isGitRepo) return [];
  const hits: HistoryHit[] = [];
  for (const pattern of denySet.patterns) {
    let stdout = "";
    try {
      stdout = execFileSync(
        "git",
        ["log", "-G", pattern, "--oneline", "--no-decorate"],
        {
          cwd: repo.cwd,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          maxBuffer: 64 * 1024 * 1024,
        },
      );
    } catch {
      continue;
    }
    for (const line of stdout.split("\n")) {
      if (!line.trim()) continue;
      const sp = line.indexOf(" ");
      const sha = sp >= 0 ? line.slice(0, sp) : line;
      const summary = sp >= 0 ? line.slice(sp + 1) : "";
      hits.push({
        pattern: formatMatch(pattern, opts),
        commitSha: sha,
        commitSummary: summary,
      });
    }
  }
  return hits;
}

function looksBinary(buf: Buffer): boolean {
  // Heuristic: any NUL byte in the first 8KB is a strong binary signal.
  const sample = buf.subarray(0, Math.min(buf.length, 8192));
  for (let i = 0; i < sample.length; i++) {
    if (sample[i] === 0) return true;
  }
  return false;
}
