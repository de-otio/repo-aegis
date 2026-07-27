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
import { ALWAYS_FILE_STEM, type DenySet } from "./deny-set.js";
import type { RepoConfig } from "./repo.js";
import { compileGlobs, matchesCompiled } from "./globs.js";
import { isKnownNonSecret } from "./known-non-secrets.js";
import { patternId } from "./waivers.js";
import { redactMatch, revealMatch, type RedactionMode } from "./redaction.js";
import { GitCommandError, OutsideWorkingTreeError } from "./exceptions.js";

const DEFAULT_MAX_FILE_BYTES = 1024 * 1024; // 1 MiB

// Per-read chunk size when streaming `git diff` output through a temp
// file. 64 KiB keeps allocations small without making syscalls dominate
// throughput. Lines are reassembled across chunk boundaries.
const DIFF_STREAM_CHUNK_BYTES = 64 * 1024;

/**
 * Which change kinds the diff scanners look at.
 *
 * `R` (rename) is load-bearing and was missing: git detects renames by
 * default, so with `ACM` a `git mv` plus an appended marker in the same
 * change produced *no* diff entry at all and the scanners reported
 * clean — a live bypass triggered by the most ordinary refactor shape
 * there is.
 *
 * Rename *detection* stays on (rather than `--no-renames`): the rename
 * entry then carries only the lines that actually changed, instead of
 * re-presenting an untouched moved file as a wholesale addition.
 *
 * `D` stays excluded — a deletion adds no content that could leak. `C`
 * (copy) is only ever emitted when copy detection is explicitly asked
 * for; without it a copied file arrives as `A` and is scanned in full.
 */
const DIFF_FILTER = "--diff-filter=ACMR";

export interface ScanHit {
  path?: string;
  line: number;
  column: number;
  matchPreview: string;
  /**
   * Post-image blob sha of the file the hit was found in, when the hit
   * came from a diff scan. Full-length (40 hex for sha1 repos, 64 for
   * sha256) because the diff is requested with `--full-index`.
   *
   * Why a blob and not just a path: a blob sha identifies exact content,
   * so a decision recorded against it ("this hit is reviewed-benign")
   * cannot silently carry over to a later edit of the same path. Unset
   * for file/text scans and for diff stanzas with no `index` line.
   */
  blob?: string;
  /**
   * The marker file stem (engagement id, or `_always`) the matched pattern
   * was loaded from. Filled in by scanText when the deny set carries
   * `patternSources`. Optional for backward compatibility with deny sets
   * that don't supply attribution (synthetic test fixtures, older callers).
   */
  engagement?: string;
  /**
   * Stable identifier of the deny-set pattern that produced this hit —
   * `<stem>/<first 12 hex of sha256(pattern)>`, see `waivers.ts`.
   *
   * Populated wherever attribution is (same condition as `engagement`): the
   * deny set must carry `patternSources`. Paired with {@link ScanHit.blob} it
   * is the key a reviewed-benign waiver is recorded against, so a waiver
   * covers exactly one pattern against exactly one blob's content.
   *
   * The digest, not the pattern text, because a waiver file is committed to a
   * possibly-public repo and an engagement marker's plaintext must not be.
   */
  patternId?: string;
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
  /**
   * Disable the path-scoped `_always` exemption for this scan: every file is
   * matched against the full `combinedRegex` regardless of
   * {@link DenySet.exemptPaths}.
   *
   * The one caller that wants this is `audit`, whose whole job is to see what
   * the day-to-day gate lets through — it runs the full pattern set and
   * reports exempt-path `_always` hits as *informational* findings, so an
   * exemption is visible somewhere instead of invisible everywhere. Do not set
   * it on `check` or on a hook; that would re-introduce the false positives B
   * exists to remove.
   */
  ignorePathExemptions?: boolean;
  /**
   * Working-tree root used to turn an absolute scanned path into the
   * repo-relative POSIX path {@link DenySet.exemptPaths} globs are written
   * against. {@link scanFile} sets it from its own `workingTree` argument.
   *
   * Absent, an absolute path cannot be relativised and is therefore never
   * exempt — fail closed. Diff scanners need no working tree: git already
   * hands them repo-relative paths.
   */
  workingTree?: string;
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

/** Which deny-set pattern produced a match, and where it came from. */
interface MatchAttribution {
  /** Marker file stem: an engagement id, `_always`, or `_private_infra`. */
  stem: string;
  /** The pattern text itself, needed to derive {@link ScanHit.patternId}. */
  pattern: string;
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
function attributeMatch(matched: string, denySet: DenySet): MatchAttribution | undefined {
  const sources = denySet.patternSources;
  if (!sources || sources.length !== denySet.patterns.length) return undefined;
  for (let i = 0; i < denySet.patterns.length; i++) {
    const p = denySet.patterns[i]!;
    try {
      if (new RegExp(p, "i").test(matched)) {
        return { stem: sources[i]!, pattern: p };
      }
    } catch {
      /* malformed pattern slipped past validation; skip */
    }
  }
  return undefined;
}

/**
 * Per-scan state shared by every line: the two compiled deny-set regexes,
 * the compiled exempt-path globs, and the running known-non-secret
 * suppression count.
 *
 * Built once per scan rather than per line. Both regexes carry the `g` flag
 * so {@link firstReportableMatch} can resume a search mid-line; `lastIndex`
 * is reset on every use, so their statefulness never leaks between lines.
 */
interface ScanMatcher {
  denySet: DenySet;
  /** Full union — every pattern. Null when the deny set is empty. */
  combined: RegExp | null;
  /**
   * Non-`_always` union, used inside an exempt path. Null when there is
   * nothing to match there (or when exemptions are off, in which case it is
   * never consulted).
   */
  strict: RegExp | null;
  /** Compiled {@link DenySet.exemptPaths}; empty disables exemption entirely. */
  exempt: readonly RegExp[];
  /** Realpath of the working tree, for relativising absolute paths. */
  workingTree?: string;
  respectAllow: boolean;
  opts: ScanOptions;
  /** Count of matches dropped by {@link isKnownNonSecret} (plan item E). */
  suppressed: number;
}

function makeMatcher(denySet: DenySet, opts: ScanOptions): ScanMatcher {
  // Exemptions engage only when the deny set actually carries the class
  // split. A DenySet without `strictRegex` (a hand-built fixture, a literal
  // from an older caller) cannot tell the two classes apart, so exempting
  // anything would be guessing — fall through to `combinedRegex` everywhere.
  const split = typeof denySet.strictRegex === "string";
  const globs = denySet.exemptPaths ?? [];
  const exemptionsOn = !opts.ignorePathExemptions && split && globs.length > 0;
  const wt = opts.workingTree;
  return {
    denySet,
    combined: denySet.combinedRegex ? new RegExp(denySet.combinedRegex, "gi") : null,
    strict: exemptionsOn && denySet.strictRegex ? new RegExp(denySet.strictRegex, "gi") : null,
    // compileGlobs throws GlobTooBroadError on a `**`-style entry. That is a
    // config error and must not be swallowed here: an exemption covering the
    // whole repo would silently disable the `_always` class everywhere.
    exempt: exemptionsOn ? compileGlobs(globs) : [],
    ...(wt !== undefined && { workingTree: wt }),
    respectAllow: opts.respectAllowComments !== false,
    opts,
    suppressed: 0,
  };
}

/**
 * Turn a scanned path into the repo-relative POSIX form the exempt-path
 * globs are written against, or undefined when that cannot be done.
 *
 * Undefined is the fail-closed answer: the caller then uses the full
 * `combinedRegex`, so an unrelativisable path is never exempt.
 */
function relativiseForGlobs(
  path: string | undefined,
  workingTree: string | undefined,
): string | undefined {
  if (path === undefined) return undefined;
  if (!isAbsolute(path)) {
    // Diff-parser paths arrive repo-relative and POSIX already; normalise
    // Windows separators and a leading `./` for the glob matcher's contract.
    const norm = path.replace(/\\/g, "/");
    return norm.startsWith("./") ? norm.slice(2) : norm;
  }
  if (workingTree === undefined) return undefined;
  const rel = relative(workingTree, path);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return undefined;
  return rel.replace(/\\/g, "/");
}

/**
 * Pick the regex to match a given path with: the strict (non-`_always`)
 * union inside an exempt path, the full union everywhere else.
 *
 * Chosen BEFORE matching, deliberately. Matching with the combined regex and
 * filtering the result afterwards would drop a co-located engagement hit
 * whenever an `_always` shape happened to appear earlier on the same line —
 * the scanner reports one hit per line, so the filtered `_always` match would
 * simply mask it. See the comment on {@link DenySet.strictRegex}.
 */
function regexForPath(m: ScanMatcher, path: string | undefined): RegExp | null {
  if (m.exempt.length === 0) return m.combined;
  const rel = relativiseForGlobs(path, m.workingTree);
  if (rel === undefined) return m.combined;
  return matchesCompiled(rel, m.exempt) ? m.strict : m.combined;
}

/**
 * First match on `content` that is worth reporting, skipping matches that
 * {@link isKnownNonSecret} recognises as a documented example or placeholder
 * (plan item E) and counting each skip.
 *
 * That suppression is scoped to the `_always` class and nothing else: a
 * customer marker or a `_private_infra` host that happens to end in
 * "EXAMPLE" is still a leak. When the deny set carries no attribution we
 * cannot establish the stem, so nothing is suppressed — fail closed.
 *
 * Why the loop rather than "test once, drop if suppressed": dropping would
 * hide a real hit sitting later on the same line (a placeholder key and a
 * genuine marker on one line is exactly the shape a `.env.example` diff
 * produces). Restarting the search one character past a suppressed match
 * finds it. The loop body only runs more than once when something was
 * actually suppressed, so the common path is a single `exec`.
 */
function firstReportableMatch(
  content: string,
  re: RegExp,
  m: ScanMatcher,
): { matched: string; index: number; attribution?: MatchAttribution } | null {
  let from = 0;
  while (from <= content.length) {
    re.lastIndex = from;
    const mm = re.exec(content);
    // An empty match would not advance `from` reliably and cannot be a real
    // marker; treat it as "nothing here" rather than risk spinning.
    if (!mm || !mm[0]) return null;
    const attribution = attributeMatch(mm[0], m.denySet);
    if (attribution?.stem === ALWAYS_FILE_STEM && isKnownNonSecret(mm[0], content)) {
      m.suppressed += 1;
      from = mm.index + 1;
      continue;
    }
    return { matched: mm[0], index: mm.index, ...(attribution && { attribution }) };
  }
  return null;
}

/** Assemble the reportable fields shared by every hit-producing scanner. */
function hitFrom(
  found: { matched: string; index: number; attribution?: MatchAttribution },
  m: ScanMatcher,
): Pick<ScanHit, "column" | "matchPreview" | "engagement" | "patternId"> {
  const attr = found.attribution;
  return {
    column: found.index + 1,
    matchPreview: formatMatch(found.matched, m.opts),
    ...(attr && { engagement: attr.stem, patternId: patternId(attr.stem, attr.pattern) }),
  };
}

/**
 * A scan's hits plus its observability counters. Returned by the
 * `*Detailed` variants; the plain variants return just the hits so every
 * existing caller keeps compiling.
 */
export interface TextScanResult {
  hits: ScanHit[];
  /**
   * How many `_always` matches were dropped as documented examples or
   * placeholders (see `known-non-secrets.ts`).
   *
   * Reported rather than kept internal because a silent suppression is
   * indistinguishable from a missing rule: an operator who expects a hit and
   * sees none must be able to tell "the scanner decided this is the AWS docs
   * example key" from "the pattern never matched".
   */
  suppressedKnownNonSecrets: number;
}

/**
 * Scan an arbitrary text body. The most general primitive; called by
 * the more specific scanners after they've extracted text from their
 * input (staged diff, file contents, commit range diff).
 *
 * `path`, when given, selects the deny-set class: inside a
 * {@link DenySet.exemptPaths} glob only the non-`_always` patterns apply.
 * An absolute path needs `opts.workingTree` to be relativised; without one
 * it is never exempt.
 */
export function scanTextDetailed(
  text: string,
  denySet: DenySet,
  path?: string,
  opts: ScanOptions = {},
): TextScanResult {
  if (!denySet.combinedRegex) return { hits: [], suppressedKnownNonSecrets: 0 };
  const m = makeMatcher(denySet, opts);
  const re = regexForPath(m, path);
  if (re === null) return { hits: [], suppressedKnownNonSecrets: 0 };
  const hits: ScanHit[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const found = firstReportableMatch(line, re, m);
    if (found === null) continue;
    if (m.respectAllow && ALLOW_COMMENT.test(line)) continue;
    hits.push({
      ...(path !== undefined && { path }),
      line: i + 1,
      ...hitFrom(found, m),
    });
  }
  return { hits, suppressedKnownNonSecrets: m.suppressed };
}

/** {@link scanTextDetailed} without the counters. */
export function scanText(
  text: string,
  denySet: DenySet,
  path?: string,
  opts: ScanOptions = {},
): ScanHit[] {
  return scanTextDetailed(text, denySet, path, opts).hits;
}

/**
 * Hits, skipped files, and counters. Additive over the previous
 * `{ hits, skipped }` shape, so existing destructuring callers are unaffected.
 */
export interface ScanResult extends TextScanResult {
  skipped: SkippedFile[];
}

/**
 * Scan a single file from disk. Canonicalises the path via realpath to
 * defeat symlink-tricks. Rejects paths outside the repo working tree
 * (or current cwd if not in a git repo).
 *
 * When `workingTree` is supplied it doubles as the anchor for path-scoped
 * exemptions: the file's realpath is made relative to the tree's realpath
 * before being matched against {@link DenySet.exemptPaths}. Without it an
 * absolute path cannot be relativised, so nothing is exempt.
 */
export function scanFile(
  path: string,
  denySet: DenySet,
  opts: ScanOptions = {},
  workingTree?: string,
): ScanResult {
  const skipped: SkippedFile[] = [];
  const empty = (): ScanResult => ({ hits: [], skipped, suppressedKnownNonSecrets: 0 });
  if (!existsSync(path)) {
    skipped.push({ path, reason: "unreadable" });
    return empty();
  }
  let real: string;
  try {
    real = realpathSync(path);
  } catch {
    skipped.push({ path, reason: "unreadable" });
    return empty();
  }
  let scanOpts = opts;
  if (workingTree) {
    const wtReal = realpathSync(workingTree);
    const rel = relative(wtReal, real);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      throw new OutsideWorkingTreeError(real, wtReal);
    }
    // Thread the *resolved* tree root through, so the exemption matcher
    // compares realpath against realpath (the containment check above already
    // paid for the resolution) and an explicit caller-supplied workingTree in
    // `opts` never silently overrides the argument form.
    scanOpts = { ...opts, workingTree: wtReal };
  }
  const stat = statSync(real);
  const max = opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  if (stat.size > max) {
    skipped.push({ path: real, reason: "too-large", bytes: stat.size });
    return empty();
  }
  let buf: Buffer;
  try {
    buf = readFileSync(real);
  } catch {
    skipped.push({ path: real, reason: "unreadable" });
    return empty();
  }
  if (looksBinary(buf)) {
    skipped.push({ path: real, reason: "binary", bytes: stat.size });
    return empty();
  }
  const text = buf.toString("utf8");
  const scanned = scanTextDetailed(text, denySet, real, scanOpts);
  return {
    hits: scanned.hits,
    skipped,
    suppressedKnownNonSecrets: scanned.suppressedKnownNonSecrets,
  };
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
 *   - Rename/copy stanzas (`similarity index`, `rename from`, `rename to`,
 *     `copy from`, `copy to`) — extended headers that likewise precede
 *     any `@@`, so they never read as content
 *
 * Hit line numbers are 1-indexed across the synthetic stream of added
 * lines (matching the prior behaviour where `extractAdditions` joined
 * additions with `\n` and `scanText` numbered them by split-index).
 * That numbering is documented, caller-visible behaviour: it is a
 * position within the diff, not a line number in the post-image file.
 * Attaching a path/blob to each hit (below) is the added precision;
 * the numbering deliberately did not change with it.
 */
function streamScanDiff(
  cwd: string,
  args: readonly string[],
  denySet: DenySet,
  opts: ScanOptions,
): TextScanResult {
  if (!denySet.combinedRegex) return { hits: [], suppressedKnownNonSecrets: 0 };

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
    // The two invariants the parser depends on are pinned here rather
    // than at each call site, so a future caller cannot forget them:
    //   `-c core.quotePath=false` — non-ASCII paths arrive as literal
    //     UTF-8 instead of `"\303\244..."` octal escapes, so the `path`
    //     we attach to a hit is the real path. `-c` is a git-*global*
    //     option and must precede the subcommand.
    //   `--full-index` — the `index <old>..<new>` line carries the full
    //     object name, so `ScanHit.blob` is a complete sha rather than
    //     an abbreviation that could later become ambiguous.
    const r = spawnSync(
      "git",
      ["-c", "core.quotePath=false", "diff", "--full-index", ...args],
      {
        cwd,
        // stderr is discarded rather than captured: the only use for it
        // would be to embed in an error message, and git's diff stderr
        // can quote paths (and, for some failures, content). See
        // GitCommandError's contract.
        stdio: ["ignore", outFd, "ignore"],
      },
    );
    closeSync(outFd);
    outFd = null;
    if (r.error) throw new GitCommandError("diff", null);
    if (r.status !== 0) throw new GitCommandError("diff", r.status ?? null);
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
 * Parser state carried across the lines of a unified diff.
 *
 * This is mutated in place rather than rebuilt per line: the loop runs
 * once per line of a diff that can be gigabytes, and allocating a fresh
 * state object per line was measurable overhead for no safety gain (the
 * object never escapes `scanDiffLines`).
 */
interface DiffScanState {
  /** True between a `@@` header and the next file-level header. */
  inChunk: boolean;
  /** 1-indexed counter of added-content lines emitted so far. */
  virtualLine: number;
  /** Post-image path of the current file stanza, if known. */
  path?: string;
  /** Post-image blob sha from the current stanza's `index` line. */
  newBlob?: string;
  /** True when the current stanza's post-image is `/dev/null`. */
  deleted: boolean;
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
): TextScanResult {
  const ctx = makeDiffScanContext(denySet, opts);
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
      for (const line of parts) processDiffLine(line, ctx);
    }
    if (carry.length > 0) processDiffLine(carry, ctx);
  } finally {
    closeSync(fd);
  }
  return { hits: ctx.hits, suppressedKnownNonSecrets: ctx.m.suppressed };
}

/**
 * Scan an in-memory unified diff. Same parser as {@link scanDiffFile},
 * fed from a string instead of a file descriptor.
 *
 * Exists so callers that already hold diff text (and the
 * behaviour-comparison harness, which must feed the old and new parsing
 * rules byte-identical input) don't have to round-trip through a temp
 * file. Prefer the streaming path for diffs of unknown size — this one
 * holds the whole diff in memory by construction.
 */
export function scanDiffTextDetailed(
  diff: string,
  denySet: DenySet,
  opts: ScanOptions = {},
): TextScanResult {
  if (!denySet.combinedRegex) return { hits: [], suppressedKnownNonSecrets: 0 };
  const ctx = makeDiffScanContext(denySet, opts);
  // Splitting on "\n" reproduces the streaming reader exactly: a
  // trailing newline yields a final empty element, which processes as
  // a no-op line, and a diff with no trailing newline yields the last
  // partial line just as the `carry` branch does.
  for (const line of diff.split("\n")) processDiffLine(line, ctx);
  return { hits: ctx.hits, suppressedKnownNonSecrets: ctx.m.suppressed };
}

/** {@link scanDiffTextDetailed} without the counters. */
export function scanDiffText(
  diff: string,
  denySet: DenySet,
  opts: ScanOptions = {},
): ScanHit[] {
  return scanDiffTextDetailed(diff, denySet, opts).hits;
}

interface DiffScanContext {
  st: DiffScanState;
  m: ScanMatcher;
  hits: ScanHit[];
}

function makeDiffScanContext(denySet: DenySet, opts: ScanOptions): DiffScanContext {
  return {
    st: { inChunk: false, virtualLine: 0, deleted: false },
    m: makeMatcher(denySet, opts),
    hits: [],
  };
}

/**
 * Examine a single diff line, updating parser state and appending a hit
 * when the line is added content that matches the deny set.
 *
 * Header handling, in the order the lines actually appear in a stanza:
 *
 *   `diff --git a/<pre> b/<post>`  starts a new file stanza — resets
 *       chunk state, blob, and the deletion flag, and seeds `path` from
 *       the `b/` side as a *fallback* (that parse is ambiguous for paths
 *       containing " b/", which is why `+++` below overrides it).
 *   extended headers (`old mode`, `new file mode`, `similarity index`,
 *       `rename from`/`rename to`, `copy from`/`copy to`, …) — these all
 *       precede the first `@@`, so `inChunk` is false and they fall
 *       through the content branch untouched. Rename stanzas only became
 *       reachable once the diff filter started including `R` entries.
 *   `index <old>..<new> <mode>`  supplies the post-image blob sha.
 *   `--- a/<pre>` / `+++ b/<post>`  the authoritative path pair. A
 *       `+++ /dev/null` post-image means the file was deleted, so any
 *       following lines describe removed content only.
 *   `@@ … @@`  enters chunk state.
 *
 * Inside a chunk, only `+`-prefixed lines are added content; the leading
 * `+` is stripped. Combined diffs (merge commits, `--cc`) use `@@@` and
 * two-column prefixes, which this same rule handles: a line touching the
 * post-image starts with `+` in at least one column.
 */
function processDiffLine(line: string, ctx: DiffScanContext): void {
  const st = ctx.st;
  // File-level headers reset chunk state; they are never content.
  if (line.startsWith("diff --git ")) {
    st.inChunk = false;
    st.deleted = false;
    st.newBlob = undefined;
    st.path = postImagePathFromDiffGit(line);
    return;
  }
  if (line.startsWith("+++ ")) {
    const target = line.slice(4);
    if (target === "/dev/null") {
      st.deleted = true;
      st.path = undefined;
    } else {
      st.deleted = false;
      st.path = stripDiffPathPrefix(target);
    }
    return;
  }
  if (line.startsWith("--- ")) return;
  if (line.startsWith("index ")) {
    st.newBlob = postImageBlobFromIndex(line);
    return;
  }
  if (line.startsWith("@@")) {
    st.inChunk = true;
    return;
  }
  // The "no newline at end of file" marker is content-adjacent but
  // never an added line.
  if (line.startsWith("\\ No newline")) return;
  if (!st.inChunk) return;
  // Inside a chunk: only `+`-prefixed lines (excluding `+++`, already
  // filtered above) are added content. Strip the leading `+` to match
  // the prior `extractAdditions` behaviour.
  if (!line.startsWith("+")) return;
  const content = line.slice(1);
  st.virtualLine += 1;
  // A stanza whose post-image is /dev/null has no added content by
  // construction; the guard is belt-and-braces so a malformed diff
  // can't attribute a hit to a file that no longer exists.
  if (st.deleted) return;
  // Path-scoped class selection. `st.path` is the post-image path from the
  // `+++ b/<path>` header, already repo-relative — exactly the form the
  // exempt-path globs are written against, so no working tree is needed.
  // A stanza with no path yet (a malformed or truncated diff) selects the
  // full pattern set: unknown path means never exempt.
  const re = regexForPath(ctx.m, st.path);
  if (re === null) return;
  const found = firstReportableMatch(content, re, ctx.m);
  if (found === null) return;
  if (ctx.m.respectAllow && ALLOW_COMMENT.test(content)) return;
  ctx.hits.push({
    ...(st.path !== undefined && { path: st.path }),
    line: st.virtualLine,
    ...(st.newBlob !== undefined && { blob: st.newBlob }),
    ...hitFrom(found, ctx.m),
  });
}

/**
 * Best-effort post-image path from a `diff --git a/<pre> b/<post>` line.
 *
 * The format is genuinely ambiguous when a path contains " b/", and git
 * quotes the whole pair when either side needs escaping. This is only a
 * seed: every stanza that can produce a hit also carries a `+++ b/<post>`
 * line, which overwrites it with the unambiguous value. Returning
 * undefined on anything unexpected is therefore safe — better an absent
 * path than a wrong one.
 */
function postImagePathFromDiffGit(line: string): string | undefined {
  const rest = line.slice("diff --git ".length);
  const sep = rest.lastIndexOf(" b/");
  if (sep < 0) return undefined;
  return stripDiffPathPrefix(rest.slice(sep + 1));
}

/**
 * Strip git's `b/` (or `a/`) destination prefix and unquote if needed.
 *
 * `core.quotePath=false` (set on the diff invocation) stops git escaping
 * non-ASCII bytes, but it still C-quotes paths containing a quote,
 * backslash, or control character — so the unquote step is not dead code.
 */
function stripDiffPathPrefix(raw: string): string | undefined {
  const value = raw.startsWith('"') ? unquoteCPath(raw) : raw;
  if (value === undefined) return undefined;
  if (value === "/dev/null") return undefined;
  if (value.startsWith("a/") || value.startsWith("b/")) return value.slice(2);
  return value;
}

/** Decode a git C-quoted path (`"a/we\"ird\tname"`). */
function unquoteCPath(raw: string): string | undefined {
  if (!raw.endsWith('"') || raw.length < 2) return undefined;
  const body = raw.slice(1, -1);
  const bytes: number[] = [];
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch !== "\\") {
      // Non-escaped chars are ASCII or already-decoded UTF-8 text; push
      // their UTF-8 bytes so octal escapes and literals can be mixed.
      for (const b of Buffer.from(ch, "utf8")) bytes.push(b);
      continue;
    }
    const next = body[i + 1];
    if (next === undefined) return undefined;
    i++;
    switch (next) {
      case "n": bytes.push(0x0a); break;
      case "t": bytes.push(0x09); break;
      case "r": bytes.push(0x0d); break;
      case '"': bytes.push(0x22); break;
      case "\\": bytes.push(0x5c); break;
      default: {
        // Octal escape \NNN (how git encodes raw bytes).
        const oct = body.slice(i, i + 3);
        if (!/^[0-7]{3}$/.test(oct)) return undefined;
        bytes.push(parseInt(oct, 8));
        i += 2;
      }
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

/**
 * Post-image blob sha from an `index <old>..<new>[ <mode>]` line.
 *
 * Requires a full-length object name — `--full-index` guarantees one, and
 * rejecting anything shorter means a caller that somehow bypasses that
 * flag gets no blob rather than an abbreviation that could later become
 * ambiguous. 40 hex = sha1, 64 = sha256.
 */
function postImageBlobFromIndex(line: string): string | undefined {
  const rest = line.slice("index ".length);
  const dots = rest.indexOf("..");
  if (dots < 0) return undefined;
  const after = rest.slice(dots + 2);
  const sp = after.indexOf(" ");
  const sha = sp >= 0 ? after.slice(0, sp) : after;
  return /^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(sha) ? sha : undefined;
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
): ScanResult {
  const nothing: ScanResult = { hits: [], skipped: [], suppressedKnownNonSecrets: 0 };
  if (!repo.isGitRepo) return nothing;
  if (!denySet.combinedRegex) return nothing;
  const r = streamScanDiff(
    repo.cwd,
    ["--cached", DIFF_FILTER, "-U0", "--no-color"],
    denySet,
    opts,
  );
  return { hits: r.hits, skipped: [], suppressedKnownNonSecrets: r.suppressedKnownNonSecrets };
}

/**
 * Scan the diff over an arbitrary git range (e.g. `main..HEAD`,
 * `<remote-sha>..<local-sha>`). Pre-push hook entry point.
 *
 * Only added-line content is scanned. The caller is responsible for
 * passing a syntactically valid range; if `git diff` exits non-zero a
 * {@link GitCommandError} propagates — an invalid range must never read
 * as "clean". Streams the diff (see scanStagedDiff).
 */
export function scanRange(
  repo: RepoConfig,
  denySet: DenySet,
  range: string,
  opts: ScanOptions = {},
): ScanResult {
  const nothing: ScanResult = { hits: [], skipped: [], suppressedKnownNonSecrets: 0 };
  if (!repo.isGitRepo) return nothing;
  if (!denySet.combinedRegex) return nothing;
  const r = streamScanDiff(
    repo.cwd,
    [range, DIFF_FILTER, "-U0", "--no-color"],
    denySet,
    opts,
  );
  return { hits: r.hits, skipped: [], suppressedKnownNonSecrets: r.suppressedKnownNonSecrets };
}

/**
 * git's empty tree object.
 *
 * `git diff <empty-tree>..<ref>` presents every line of every file at
 * `<ref>` as an addition, which is how the pre-push hook used to scan a
 * brand-new ref: no remote sha to diff against, so diff against nothing.
 * That is still the right answer when nothing is genuinely shared with
 * the remote (see {@link resolveNewRefBase}), so the constant lives here
 * — one definition, shared by core and the generated hook script.
 *
 * This is the sha1 value. sha256 repositories have a different empty
 * tree, and `git diff` there rejects this object; the scan then throws
 * {@link GitCommandError} (CLI exit 2). Over-loud, but never a false
 * "clean" — the only failure direction this tool may take.
 */
export const EMPTY_TREE_SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/** Env var forcing {@link resolveNewRefBase} to report `full-history`. */
const FULL_SCAN_ENV = "REPO_AEGIS_NEW_REF_FULL_SCAN";

/**
 * How much of a new ref has to be scanned. See {@link resolveNewRefBase}
 * for which situation produces which mode; the strings are part of the
 * CLI's JSON contract (`rangeMode`) and must stay stable.
 */
export type NewRefMode =
  | "nothing-new"
  | "incremental"
  | "incremental-widened"
  | "full-history";

export interface NewRefTarget {
  /**
   * The ref being pushed — `refs/tags/v1.2.0`, `refs/heads/feature`, a
   * bare sha. Passed to git as its own argv entry (never interpolated
   * into a shell command), so odd-but-legal refnames are harmless.
   */
  ref: string;
  /** Remote name, selecting the `refs/remotes/<remote>/*` namespace. */
  remote: string;
}

export interface NewRefBase {
  mode: NewRefMode;
  /**
   * Left-hand side of the diff range to scan. Absent — and only absent
   * — for `nothing-new`, where there is no diff to run at all.
   */
  base?: string;
}

/**
 * True when the operator has asked for the old unconditional
 * full-history scan of new refs.
 *
 * The documented value is `1`. Anything non-empty other than `0` /
 * `false` / `no` also engages: an escape hatch that silently does
 * nothing because the operator wrote `true` is worse than one that
 * over-scans.
 */
function newRefFullScanForced(): boolean {
  const raw = process.env[FULL_SCAN_ENV];
  if (raw === undefined) return false;
  const v = raw.trim().toLowerCase();
  return v !== "" && v !== "0" && v !== "false" && v !== "no";
}

/**
 * Run git and capture stdout without ever throwing on a non-zero exit.
 *
 * stderr is discarded rather than captured: it can quote refnames and,
 * for some failures, content — and it would only ever be used to build
 * an error message. See {@link GitCommandError}'s contract.
 */
function runGitCapture(
  cwd: string,
  args: readonly string[],
): { ok: boolean; status: number | null; stdout: string } {
  const r = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    // A rev-list of a large new history is ~41 bytes per commit; this
    // ceiling covers millions of commits. Overflow sets `r.error`,
    // which reads as a failure below rather than as truncated output.
    maxBuffer: 256 * 1024 * 1024,
  });
  const status = typeof r.status === "number" ? r.status : null;
  if (r.error) return { ok: false, status, stdout: "" };
  return { ok: r.status === 0, status, stdout: r.stdout ?? "" };
}

/**
 * Work out how much of a *new* ref (one the remote does not have yet)
 * actually needs scanning, as a diff **base**.
 *
 * The incident this exists for: the pre-push hook has no remote sha for
 * a new ref, so it diffed `<empty-tree>..<local-sha>` — the entire
 * reachable history. Pushing a release tag that points at an
 * already-pushed `main` commit therefore re-scanned everything and
 * blocked on a benign historical match, even though the tag exposes
 * nothing new. Operators learn `--no-verify`, and then the hook
 * protects nothing.
 *
 * The mapping, from `git rev-list --boundary <ref> --not
 * --remotes=<remote>` (boundary commits come back `-`-prefixed):
 *
 * | rev-list result | mode | caller scans |
 * |---|---|---|
 * | no commits at all | `nothing-new` | nothing (the release-tag case) |
 * | commits, one boundary | `incremental` | `<boundary>..<ref>` |
 * | commits, several boundaries | `incremental-widened` | `merge-base --octopus <b…>`..`<ref>` |
 * | commits, no boundary | `full-history` | `<empty-tree>..<ref>` |
 *
 * "No boundary" covers both a disjoint/root history and a repo with no
 * `refs/remotes/<remote>/*` at all (fresh clone, detached CI checkout,
 * a non-standard fetch refspec): nothing is known to be shared, so
 * nothing may be skipped. Those repos keep exactly today's behaviour.
 *
 * **Why a base, and not `git log -p <ref> --not --remotes=<remote>`.**
 * That is the obvious implementation and it is wrong: `git log -p`
 * emits *no diff for a merge commit*, so content introduced by the
 * merge itself — an evil merge, a conflict resolution that pastes a
 * marker in — would go completely unscanned. The alternatives are no
 * better: `--diff-merges=first-parent` re-introduces the very false
 * positives this function removes, and `--cc` combined diffs use
 * `@@@`/`++` framing that {@link processDiffLine} does not parse.
 * Computing a base and running one ordinary tree diff avoids all three:
 * a tree diff compares end states, so a merge cannot hide content in
 * it. `scan.test.ts` pins this with an evil-merge regression test.
 *
 * **Widening is deliberate over-scan.** With several boundaries the
 * octopus merge-base is an ancestor of all of them, so the range is a
 * strict superset of the new commits. Over-scan risks a false positive;
 * under-scan risks a leak. Only one of those is acceptable.
 *
 * **Staleness asymmetry (read this before "fixing" it).** `--remotes=`
 * reads *remote-tracking* refs, and a hook deliberately does not
 * refresh them — a pre-push hook must not make a network call. So:
 * tracking refs that are **behind** the real remote cause over-scanning
 * (safe: more content is examined than strictly necessary), while
 * tracking refs that are **ahead** — possible after a server-side
 * force-push or a branch deletion that this clone has already fetched —
 * could cause under-scanning. `REPO_AEGIS_NEW_REF_FULL_SCAN=1` forces
 * `full-history` and is the escape hatch for that case. Server-side
 * push protection remains the only non-advisory control.
 *
 * Throws {@link GitCommandError} if any git invocation fails. A failed
 * resolution must never degrade to "clean" — nor, quietly, to a
 * narrower range than the truth.
 */
export function resolveNewRefBase(repo: RepoConfig, target: NewRefTarget): NewRefBase {
  if (newRefFullScanForced()) return { mode: "full-history", base: EMPTY_TREE_SHA };

  // `--remotes=<remote>` is a shell-glob pattern over refs/remotes; with
  // no glob metacharacter git implies a trailing `/*`, so this reads
  // exactly `refs/remotes/<remote>/*`. Remote names cannot contain `*`,
  // `?` or `[` (git's own refname rules reject them), so the pattern
  // cannot be widened by a hostile remote name. The trailing `--` keeps
  // a refname from ever being re-read as a pathspec.
  const rl = runGitCapture(repo.cwd, [
    "rev-list",
    "--boundary",
    target.ref,
    "--not",
    `--remotes=${target.remote}`,
    "--",
  ]);
  if (!rl.ok) throw new GitCommandError("rev-list", rl.status);

  const boundaries: string[] = [];
  let newCommits = 0;
  for (const raw of rl.stdout.split("\n")) {
    const line = raw.trim();
    if (line === "") continue;
    // `--boundary` prefixes the excluded commits adjacent to the
    // included set with `-`; everything else is a commit in <ref> that
    // no remote-tracking ref reaches.
    if (line.startsWith("-")) boundaries.push(line.slice(1));
    else newCommits++;
  }

  if (newCommits === 0) return { mode: "nothing-new" };
  if (boundaries.length === 0) return { mode: "full-history", base: EMPTY_TREE_SHA };
  if (boundaries.length === 1) return { mode: "incremental", base: boundaries[0]! };

  const mb = runGitCapture(repo.cwd, ["merge-base", "--octopus", ...boundaries]);
  if (mb.ok) {
    const widened = (mb.stdout.split("\n")[0] ?? "").trim();
    if (widened !== "") return { mode: "incremental-widened", base: widened };
    // Exit 0 with no output is not a documented outcome; widen all the
    // way rather than guess at a base.
    return { mode: "full-history", base: EMPTY_TREE_SHA };
  }
  // `git merge-base` exits 1 (no output) when the commits share no
  // ancestor at all — histories were grafted or one side is a root.
  // Nothing is shared, so nothing may be skipped.
  if (mb.status === 1) return { mode: "full-history", base: EMPTY_TREE_SHA };
  throw new GitCommandError("merge-base", mb.status);
}

export interface NewRefScanResult extends ScanResult {
  /** Which resolution {@link resolveNewRefBase} produced. */
  mode: NewRefMode;
  /** The diff base actually scanned from; absent for `nothing-new`. */
  base?: string;
}

/**
 * Scan a ref the remote does not have yet: resolve the diff base (see
 * {@link resolveNewRefBase}) and hand the resulting range to the same
 * {@link scanRange} machinery `--range` uses. No new diff parsing, and
 * therefore no new way for the parser to be wrong.
 *
 * `resolved` lets a caller that already needed the base (the CLI, which
 * feeds the same range to its lockfile/.npmrc egress sweep) avoid a
 * second `rev-list`. Omit it and the base is resolved here.
 *
 * Throws {@link GitCommandError} on any git failure, including when
 * `repo` is not a git repo — resolution runs git unconditionally, so a
 * non-repo fails closed rather than reporting an empty result.
 */
export function scanNewRef(
  repo: RepoConfig,
  denySet: DenySet,
  target: NewRefTarget,
  opts: ScanOptions = {},
  resolved?: NewRefBase,
): NewRefScanResult {
  const r = resolved ?? resolveNewRefBase(repo, target);
  if (r.base === undefined) {
    return { hits: [], skipped: [], suppressedKnownNonSecrets: 0, mode: r.mode };
  }
  // `<base>..<ref>` is safe to build by concatenation: git refnames
  // cannot contain `..`, so the range can have only the one separator.
  const scanned = scanRange(repo, denySet, `${r.base}..${target.ref}`, opts);
  return { ...scanned, mode: r.mode, base: r.base };
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
 *
 * Throws {@link GitCommandError} if the underlying `git log` fails; it
 * does not return an empty result on error.
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
  } catch (err) {
    // Fail closed. This used to be `catch { return []; }`, which turned
    // a bad revspec, an unreadable object store, or a missing git binary
    // into a confident "clean" — the one answer a leak scanner must
    // never give when it did not actually look. The error carries the
    // subcommand and exit status only; git's stderr is deliberately
    // discarded (stdio above) so no diff content can ride out with it.
    const status = (err as { status?: unknown }).status;
    throw new GitCommandError("log", typeof status === "number" ? status : null);
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
