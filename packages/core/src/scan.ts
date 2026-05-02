// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
import { execFileSync, spawnSync } from "node:child_process";
import {
  closeSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  existsSync,
  statSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import type { DenySet } from "./deny-set.js";
import type { RepoConfig } from "./repo.js";
import { redactMatch, revealMatch, type RedactionMode } from "./redaction.js";
import { OutsideWorkingTreeError } from "./exceptions.js";

const DEFAULT_MAX_FILE_BYTES = 1024 * 1024; // 1 MiB

// Per-read chunk size when streaming `git diff` output through a temp
// file. 64 KiB keeps allocations small without making syscalls dominate
// throughput. Lines are reassembled across chunk boundaries.
const DIFF_STREAM_CHUNK_BYTES = 64 * 1024;

export interface ScanHit {
  path?: string;
  line: number;
  column: number;
  matchPreview: string;
  /**
   * The marker file stem (engagement id, or `_always`) the matched pattern
   * was loaded from. Filled in by scanText when the deny set carries
   * `patternSources`. Optional for backward compatibility with deny sets
   * that don't supply attribution (synthetic test fixtures, older callers).
   */
  engagement?: string;
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
 * Find which deny-set pattern produced a given match, returning the
 * engagement attribution from `patternSources`. Falls back to undefined
 * when the deny set doesn't carry attribution (older fixtures).
 *
 * Iterates patterns in declaration order — first match wins. For typical
 * marker counts (tens to low hundreds) this is microseconds; the
 * resulting per-line cost is dominated by the combined-regex test that
 * already happened.
 */
function attributeMatch(matched: string, denySet: DenySet): string | undefined {
  const sources = denySet.patternSources;
  if (!sources || sources.length !== denySet.patterns.length) return undefined;
  for (let i = 0; i < denySet.patterns.length; i++) {
    const p = denySet.patterns[i]!;
    try {
      if (new RegExp(p, "i").test(matched)) {
        return sources[i];
      }
    } catch {
      /* malformed pattern slipped past validation; skip */
    }
  }
  return undefined;
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
      const engagement = attributeMatch(m[0], denySet);
      hits.push({
        ...(path !== undefined && { path }),
        line: i + 1,
        column: (m.index ?? 0) + 1,
        matchPreview: formatMatch(m[0], opts),
        ...(engagement !== undefined && { engagement }),
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
 * Stream `git diff <args>` and scan its added-line content. Works by
 * spawning `git diff` with stdout redirected directly to a temp file
 * (so the parent process never needs a giant in-memory buffer), then
 * walking the file in fixed-size chunks, splitting into lines, and
 * applying the deny-set regex per added line.
 *
 * Unified-diff parsing is hand-rolled here (replacing the previous
 * `parse-diff`-based `extractAdditions`) so we can stream rather than
 * load the entire diff. The rules implemented mirror parse-diff's
 * handling of:
 *   - `diff --git`, `--- a/<x>`, `+++ b/<x>` headers (skipped, not content)
 *   - `@@ ... @@` chunk headers (toggle "in-chunk" state)
 *   - `+`-prefixed lines inside a chunk (added content; strip leading `+`)
 *   - `-` and ` ` lines (removed/context; ignored)
 *   - `\ No newline at end of file` markers (ignored)
 *   - Binary-diff stanzas (no `@@`, so we never enter chunk state)
 *
 * Hit line numbers are 1-indexed across the synthetic stream of added
 * lines (matching the prior behaviour where `extractAdditions` joined
 * additions with `\n` and `scanText` numbered them by split-index).
 */
function streamScanDiff(
  cwd: string,
  args: readonly string[],
  denySet: DenySet,
  opts: ScanOptions,
): ScanHit[] {
  if (!denySet.combinedRegex) return [];

  // Spawn git diff with stdout going straight to a temp file. Using a
  // file descriptor (vs. a pipe captured into a Buffer) means even a
  // multi-GB diff doesn't allocate a single proportionally-sized
  // buffer in our address space; the kernel writes the bytes to disk
  // and we read them back in fixed-size chunks below.
  const tmp = mkdtempSync(join(tmpdir(), "repo-aegis-diff-"));
  const diffPath = join(tmp, "diff.patch");
  let outFd: number | null = null;
  try {
    outFd = openSync(diffPath, "w");
    const r = spawnSync("git", ["diff", ...args], {
      cwd,
      stdio: ["ignore", outFd, "pipe"],
    });
    closeSync(outFd);
    outFd = null;
    if (r.error) throw r.error;
    if (r.status !== 0) {
      const stderr =
        r.stderr instanceof Buffer
          ? r.stderr.toString("utf8")
          : typeof r.stderr === "string"
            ? r.stderr
            : "";
      throw new Error(`git diff exited ${r.status ?? "?"}: ${stderr.trim()}`);
    }
    return scanDiffFile(diffPath, denySet, opts);
  } finally {
    if (outFd !== null) {
      try {
        closeSync(outFd);
      } catch {
        /* best-effort */
      }
    }
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
}

/**
 * Walk a unified-diff file chunk-by-chunk, applying the deny-set regex
 * per added line. The streaming counterpart to the prior
 * extractAdditions + scanText pair. Memory usage is bounded by the
 * read-chunk size (~64 KiB) plus any partial-line carry-over.
 */
function scanDiffFile(
  path: string,
  denySet: DenySet,
  opts: ScanOptions,
): ScanHit[] {
  const re = new RegExp(denySet.combinedRegex, "i");
  const respectAllow = opts.respectAllowComments !== false;
  const hits: ScanHit[] = [];
  let inChunk = false;
  let virtualLine = 0; // 1-indexed counter of added-content lines emitted

  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(DIFF_STREAM_CHUNK_BYTES);
    let carry = ""; // partial line spanning the previous chunk boundary
    while (true) {
      const n = readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      const text = carry + buf.subarray(0, n).toString("utf8");
      // Split on \n; the last element is either a complete line (if
      // the chunk ended on a newline) or a partial line carried into
      // the next iteration.
      const parts = text.split("\n");
      carry = parts.pop() ?? "";
      for (const line of parts) {
        ({ inChunk, virtualLine } = processDiffLine(
          line,
          inChunk,
          virtualLine,
          re,
          denySet,
          respectAllow,
          opts,
          hits,
        ));
      }
    }
    if (carry.length > 0) {
      processDiffLine(carry, inChunk, virtualLine, re, denySet, respectAllow, opts, hits);
    }
  } finally {
    closeSync(fd);
  }
  return hits;
}

/**
 * Examine a single diff line. Updates `inChunk` state on `@@` headers,
 * and when the line is an added-content line, runs the regex and
 * appends a hit (with a virtual line number based on the count of
 * added lines seen so far). Returns the new (inChunk, virtualLine)
 * state for the caller.
 */
function processDiffLine(
  line: string,
  inChunk: boolean,
  virtualLine: number,
  re: RegExp,
  denySet: DenySet,
  respectAllow: boolean,
  opts: ScanOptions,
  hits: ScanHit[],
): { inChunk: boolean; virtualLine: number } {
  // File-level headers reset chunk state; they are never content.
  if (line.startsWith("diff --git ")) return { inChunk: false, virtualLine };
  if (line.startsWith("--- ") || line.startsWith("+++ ")) return { inChunk, virtualLine };
  if (line.startsWith("@@")) return { inChunk: true, virtualLine };
  // The "no newline at end of file" marker is content-adjacent but
  // never an added line.
  if (line.startsWith("\\ No newline")) return { inChunk, virtualLine };
  if (!inChunk) return { inChunk, virtualLine };
  // Inside a chunk: only `+`-prefixed lines (excluding `+++`, already
  // filtered above) are added content. Strip the leading `+` to match
  // the prior `extractAdditions` behaviour.
  if (!line.startsWith("+")) return { inChunk, virtualLine };
  const content = line.slice(1);
  const next = virtualLine + 1;
  const m = content.match(re);
  if (!m || !m[0]) return { inChunk, virtualLine: next };
  if (respectAllow && ALLOW_COMMENT.test(content)) {
    return { inChunk, virtualLine: next };
  }
  const engagement = attributeMatch(m[0], denySet);
  hits.push({
    line: next,
    column: (m.index ?? 0) + 1,
    matchPreview: formatMatch(m[0], opts),
    ...(engagement !== undefined && { engagement }),
  });
  return { inChunk, virtualLine: next };
}

/**
 * Scan the staged diff in a git repo. Pre-commit hook entry point.
 * Streams the diff through a temp file rather than buffering it whole
 * — multi-GB pushes that previously OOM'd are now bounded by disk
 * temp space and a small read buffer.
 */
export function scanStagedDiff(
  repo: RepoConfig,
  denySet: DenySet,
  opts: ScanOptions = {},
): { hits: ScanHit[]; skipped: SkippedFile[] } {
  if (!repo.isGitRepo) return { hits: [], skipped: [] };
  if (!denySet.combinedRegex) return { hits: [], skipped: [] };
  const hits = streamScanDiff(
    repo.cwd,
    ["--cached", "--diff-filter=ACM", "-U0", "--no-color"],
    denySet,
    opts,
  );
  return { hits, skipped: [] };
}

/**
 * Scan the diff over an arbitrary git range (e.g. `main..HEAD`,
 * `<remote-sha>..<local-sha>`). Pre-push hook entry point.
 *
 * Only added-line content is scanned. The caller is responsible for
 * passing a syntactically valid range; if `git diff` exits non-zero,
 * the throw propagates. Streams the diff (see scanStagedDiff).
 */
export function scanRange(
  repo: RepoConfig,
  denySet: DenySet,
  range: string,
  opts: ScanOptions = {},
): { hits: ScanHit[]; skipped: SkippedFile[] } {
  if (!repo.isGitRepo) return { hits: [], skipped: [] };
  if (!denySet.combinedRegex) return { hits: [], skipped: [] };
  const hits = streamScanDiff(
    repo.cwd,
    [range, "--diff-filter=ACM", "-U0", "--no-color"],
    denySet,
    opts,
  );
  return { hits, skipped: [] };
}

export interface HistoryHit {
  pattern: string;
  commitSha: string;
  commitSummary: string;
}

export interface ScanHistoryOptions extends ScanOptions {
  /** Lower bound revspec; only commits reachable from the bound forward
   * are scanned. e.g. "main", "v1.0.0", "HEAD~100". When omitted, scans
   * the full history (the design's default). */
  since?: string;
}

/**
 * Scan the full git history with a single `git log -G <combined> -p`
 * invocation, then attribute matches per-pattern by walking each
 * commit's diff text. Returns one HistoryHit per (pattern, commit)
 * match. Pass `--since` to bound the lower edge.
 *
 * Cost scales as O(history-size + patterns × hits). Patterns are
 * combined via `|` into a single regex passed to `git log -G`, so we
 * pay one git invocation regardless of pattern count. Per-pattern
 * attribution happens in-process by re-testing each diff line against
 * the individual patterns — cheap because git already filtered to
 * commits where at least one pattern matched.
 *
 * The pattern field is redacted by default (preview mode) — same
 * policy as scan hits. Pass `revealMatches: true` to opt into
 * literals (NEVER from a hook).
 */
export function scanHistory(
  repo: RepoConfig,
  denySet: DenySet,
  opts: ScanHistoryOptions = {},
): HistoryHit[] {
  if (!repo.isGitRepo) return [];
  if (denySet.patterns.length === 0) return [];

  // Combine all patterns into a single -G regex. This matches any
  // commit whose diff (added or removed line content) contains at
  // least one pattern; we attribute the specific pattern(s) below.
  const combined = denySet.patterns.join("|");
  // `--format=__COMMIT__:%H %s` gives us a stable, parseable boundary
  // that can't be confused with diff content (the diff body uses
  // `diff --git`, `@@`, `+`, `-`, ` ` line prefixes). The summary
  // can contain anything but is bounded by the next `__COMMIT__:`.
  const commitMarker = "__COMMIT__:";
  const args = [
    "log",
    "-G",
    combined,
    "-p",
    "--no-color",
    `--format=${commitMarker}%H %s`,
  ];
  if (opts.since) {
    args.push(`${opts.since}..`);
  }
  let stdout = "";
  try {
    stdout = execFileSync("git", args, {
      cwd: repo.cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 256 * 1024 * 1024,
    });
  } catch {
    return [];
  }

  // Pre-compile per-pattern regexes once for attribution.
  const perPatternRegexes: (RegExp | null)[] = denySet.patterns.map(p => {
    try {
      return new RegExp(p, "i");
    } catch {
      return null;
    }
  });

  const hits: HistoryHit[] = [];
  // Walk the output. Each commit's section starts with the marker
  // line, followed by `diff --git` blocks. `git log -G` filters
  // commits whose diff content matched the regex; `-p` includes the
  // unified-diff body so we can attribute per pattern.
  const lines = stdout.split("\n");
  let curSha = "";
  let curSummary = "";
  // Tracks which (pattern-index, commit) pairs we've already emitted,
  // since multiple lines in one commit can hit the same pattern.
  const emitted = new Set<string>();
  for (const line of lines) {
    if (line.startsWith(commitMarker)) {
      const rest = line.slice(commitMarker.length);
      const sp = rest.indexOf(" ");
      curSha = sp >= 0 ? rest.slice(0, sp) : rest;
      curSummary = sp >= 0 ? rest.slice(sp + 1) : "";
      continue;
    }
    if (!curSha) continue;
    // -G matches both added and removed line content; attribute
    // either kind. `+++` / `---` are headers, not content.
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.length === 0) continue;
    const c0 = line.charCodeAt(0);
    // 43 = '+', 45 = '-'
    if (c0 !== 43 && c0 !== 45) continue;
    const content = line.slice(1);
    for (let i = 0; i < denySet.patterns.length; i++) {
      const re = perPatternRegexes[i];
      if (!re) continue;
      if (!re.test(content)) continue;
      const key = `${i}:${curSha}`;
      if (emitted.has(key)) continue;
      emitted.add(key);
      hits.push({
        pattern: formatMatch(denySet.patterns[i]!, opts),
        commitSha: curSha,
        commitSummary: curSummary,
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
