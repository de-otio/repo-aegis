import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, statSync, realpathSync } from "node:fs";
import { isAbsolute, relative } from "node:path";
import type { DenySet } from "./deny-set.js";
import type { RepoConfig } from "./repo.js";
import { redactMatch, revealMatch, type RedactionMode } from "./redaction.js";
import { OutsideWorkingTreeError } from "./exceptions.js";

const DEFAULT_MAX_FILE_BYTES = 1024 * 1024; // 1 MiB

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
 * Scan the staged diff in a git repo. Pre-commit hook entry point.
 */
export function scanStagedDiff(
  repo: RepoConfig,
  denySet: DenySet,
  opts: ScanOptions = {},
): { hits: ScanHit[]; skipped: SkippedFile[] } {
  if (!repo.isGitRepo) return { hits: [], skipped: [] };
  if (!denySet.combinedRegex) return { hits: [], skipped: [] };

  const diff = execFileSync(
    "git",
    ["diff", "--cached", "--diff-filter=ACM", "-U0", "--no-color"],
    { cwd: repo.cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  // Take only added lines; skip diff headers and removed lines.
  const addedLines = diff
    .split("\n")
    .filter(l => l.startsWith("+") && !l.startsWith("+++"))
    .map(l => l.slice(1))
    .join("\n");
  return { hits: scanText(addedLines, denySet, undefined, opts), skipped: [] };
}

/**
 * Scan the diff over an arbitrary git range (e.g. `main..HEAD`,
 * `<remote-sha>..<local-sha>`). Pre-push hook entry point.
 *
 * Only `+`-line content is scanned. The caller is responsible for
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

  const diff = execFileSync(
    "git",
    ["diff", range, "--diff-filter=ACM", "-U0", "--no-color"],
    { cwd: repo.cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  const addedLines = diff
    .split("\n")
    .filter(l => l.startsWith("+") && !l.startsWith("+++"))
    .map(l => l.slice(1))
    .join("\n");
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
