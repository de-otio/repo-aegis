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
}

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
  const hits: ScanHit[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const m = line.match(re);
    if (m && m[0]) {
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

function looksBinary(buf: Buffer): boolean {
  // Heuristic: any NUL byte in the first 8KB is a strong binary signal.
  const sample = buf.subarray(0, Math.min(buf.length, 8192));
  for (let i = 0; i < sample.length; i++) {
    if (sample[i] === 0) return true;
  }
  return false;
}
