// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  denySetCachePath as defaultDenySetCachePath,
  markersDir as defaultMarkersDir,
} from "./paths.js";
import type { RepoConfig } from "./repo.js";

export const ALWAYS_FILE_STEM = "_always";

export interface DenySetFile {
  stem: string;
  path: string;
}

export interface DenySet {
  files: DenySetFile[];
  patterns: string[];
  /**
   * Parallel to `patterns`: `patternSources[i]` is the file stem (engagement
   * id or `_always`) that pattern i was loaded from. Used by scanText to
   * attribute each hit to its source engagement, surfaced as
   * {@link ScanHit.engagement}.
   *
   * Optional for backward compatibility with fixtures and ad-hoc DenySet
   * literals; runtime callers (computeDenySet) always populate it. When
   * absent or length-mismatched, scanText falls back to no-attribution.
   */
  patternSources?: string[];
  combinedRegex: string;
  warnings: string[];
}

export interface DenySetOptions {
  markersDir?: string;
  /**
   * Path to the cache file. Default: `<home>/state/deny-set.cache.json`.
   * Pass `null` to disable caching entirely (useful for tests).
   */
  cachePath?: string | null;
}

// Bumped to 2 when patternSources was added; v1 caches are invalidated
// (the read path's schemaVersion check returns null, falling through to
// recompute).
const DENY_SET_CACHE_VERSION = 2;

interface CacheEntry {
  schemaVersion: number;
  key: string;
  files: DenySetFile[];
  patterns: string[];
  patternSources: string[];
  combinedRegex: string;
  warnings: string[];
}

/**
 * Build a fingerprint of the inputs to computeDenySet. Two calls with the
 * same fingerprint produce the same deny set. Includes:
 *   - repo class + sorted engagements (these change the per-engagement
 *     filtering applied to the marker file set)
 *   - the marker dir's file list, mtimes, and sizes (any edit to a marker
 *     file or addition/removal invalidates the cache)
 */
function computeFingerprint(repo: RepoConfig, dir: string): string {
  const fileSummaries: string[] = [];
  if (existsSync(dir)) {
    const files = readdirSync(dir).filter(f => f.endsWith(".txt")).sort();
    for (const f of files) {
      const st = statSync(join(dir, f));
      fileSummaries.push(`${f}:${st.mtimeMs}:${st.size}`);
    }
  }
  const sortedEng = [...repo.engagements].sort().join(",");
  const input = `v${DENY_SET_CACHE_VERSION}|${repo.class}|${sortedEng}|${fileSummaries.join(";")}`;
  return createHash("sha256").update(input).digest("hex");
}

function readCache(cachePath: string): CacheEntry | null {
  if (!existsSync(cachePath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(cachePath, "utf8")) as Partial<CacheEntry>;
    if (
      parsed.schemaVersion !== DENY_SET_CACHE_VERSION ||
      typeof parsed.key !== "string" ||
      !Array.isArray(parsed.files) ||
      !Array.isArray(parsed.patterns) ||
      !Array.isArray(parsed.patternSources) ||
      parsed.patternSources.length !== parsed.patterns.length ||
      typeof parsed.combinedRegex !== "string" ||
      !Array.isArray(parsed.warnings)
    ) {
      return null;
    }
    return parsed as CacheEntry;
  } catch {
    return null;
  }
}

function writeCache(cachePath: string, entry: CacheEntry): void {
  try {
    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, JSON.stringify(entry, null, 2), { mode: 0o600 });
  } catch {
    /* cache is best-effort; failure to write is not fatal */
  }
}

/**
 * Compute the per-repo deny set. Class-aware:
 *
 * - `public-eligible` / `private-strict`: full union (every marker file).
 *   Engagement field on the repo is ignored; if set, a warning is emitted.
 * - `customer-coupled`: union of `_always.txt` + every per-engagement file
 *   whose stem is NOT in this repo's `engagements` list.
 * - `scratch`: same set as `customer-coupled`, but the caller (the CLI's
 *   `check`) treats hits as advisory and exits 0.
 */
export function computeDenySet(repo: RepoConfig, opts: DenySetOptions = {}): DenySet {
  const dir = opts.markersDir ?? defaultMarkersDir();
  const warnings: string[] = [];

  if ((repo.class === "public-eligible" || repo.class === "private-strict") &&
      repo.engagements.length > 0) {
    warnings.push(
      `repo class is ${repo.class} but ${repo.engagements.length} engagement(s) are set; ` +
        `engagement field is ignored for non-customer-coupled classes`,
    );
  }

  // Cache fast-path. Cache is keyed on (class, engagements, marker-file
  // mtimes+sizes). An exact key match returns the cached deny set without
  // re-reading any marker file. Caller can disable with cachePath: null
  // (tests) or override the path. The base warnings (repo-class engagement
  // mismatch, computed above) are always recomputed so they reflect the
  // current call rather than what the cache wrote at fingerprint time.
  const cachePath =
    opts.cachePath === null ? null : opts.cachePath ?? defaultDenySetCachePath();
  const fingerprint = computeFingerprint(repo, dir);

  if (cachePath !== null) {
    const cached = readCache(cachePath);
    if (cached !== null && cached.key === fingerprint) {
      return {
        files: cached.files,
        patterns: cached.patterns,
        patternSources: cached.patternSources,
        combinedRegex: cached.combinedRegex,
        warnings: [...warnings, ...cached.warnings.filter(w => !warnings.includes(w))],
      };
    }
  }

  if (!existsSync(dir)) {
    const empty: DenySet = { files: [], patterns: [], patternSources: [], combinedRegex: "", warnings };
    if (cachePath !== null) {
      writeCache(cachePath, {
        schemaVersion: DENY_SET_CACHE_VERSION,
        key: fingerprint,
        files: [],
        patterns: [],
        patternSources: [],
        combinedRegex: "",
        warnings: [],
      });
    }
    return empty;
  }

  const own = new Set(repo.engagements);
  const useScoping = repo.class === "customer-coupled" || repo.class === "scratch";

  const files: DenySetFile[] = readdirSync(dir)
    .filter(f => f.endsWith(".txt"))
    .map(f => ({ stem: f.replace(/\.txt$/, ""), path: join(dir, f) }))
    .filter(({ stem }) => {
      if (stem === ALWAYS_FILE_STEM) return true;
      if (!useScoping) return true;
      return !own.has(stem);
    });

  const patterns: string[] = [];
  const patternSources: string[] = [];
  for (const f of files) {
    const lines = readFileSync(f.path, "utf8").split("\n");
    for (const raw of lines) {
      const trimmed = raw.trim();
      // A line is a comment only if its first non-whitespace character is `;`.
      // Mid-line `;` is part of the pattern (e.g. `db;internal` is a literal
      // marker, not "db" with a comment).
      if (trimmed.length === 0 || trimmed.startsWith(";")) continue;
      patterns.push(trimmed);
      patternSources.push(f.stem);
    }
  }
  const result: DenySet = {
    files,
    patterns,
    patternSources,
    combinedRegex: patterns.join("|"),
    warnings,
  };

  if (cachePath !== null) {
    writeCache(cachePath, {
      schemaVersion: DENY_SET_CACHE_VERSION,
      key: fingerprint,
      files,
      patterns,
      patternSources,
      combinedRegex: result.combinedRegex,
      // Cache only the input-derived warnings; the call-time class mismatch
      // warning is recomputed above per call.
      warnings: [],
    });
  }

  return result;
}
