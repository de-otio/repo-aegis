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
  registryPath as defaultRegistryPath,
} from "./paths.js";
import type { RepoConfig } from "./repo.js";
import { isPublicFacing } from "./egress.js";
import { compileGlobs } from "./globs.js";
import { loadRegistry } from "./registry.js";

export const ALWAYS_FILE_STEM = "_always";

/**
 * Reserved stem for the private-infrastructure marker file. Unlike every other
 * marker file, this one is **class-gated**: it joins the deny set only when the
 * repo is public-facing. Private-registry hosts and internal domains are
 * legitimate — often required — in a private repo; blocking them there would
 * make the tool unusable exactly where those hosts belong.
 */
export const PRIVATE_INFRA_FILE_STEM = "_private_infra";

/**
 * Minimum engagement-identifier length for the auto-block self-marker (see
 * computeDenySet). Identifiers shorter than this are NOT auto-added as patterns,
 * because a 2–3 character literal (e.g. `qa`, `ci`, `api`) matched
 * case-insensitively as a substring would flood unrelated content with false
 * positives. Such engagements should carry explicit markers instead.
 */
export const MIN_AUTO_BLOCK_IDENTIFIER_LENGTH = 4;

/** Escape a string so it matches literally when used as a regex pattern. */
function escapeRegexLiteral(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

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
  /**
   * Union of every pattern whose source stem is NOT {@link ALWAYS_FILE_STEM}
   * — engagement markers plus `_private_infra`. This is the regex a scanner
   * uses inside an exempt path (see {@link DenySet.exemptPaths}).
   *
   * **Why a second regex and not a post-filter.** The tempting shape is "match
   * with `combinedRegex`, then drop the hit if it came from `_always` and the
   * path is exempt". That silently loses leaks: the scanner reports at most
   * one hit per line, so a line carrying BOTH an `_always` shape and a
   * customer marker would match the `_always` pattern first, get filtered, and
   * the co-located engagement hit would never be reported. Choosing the regex
   * *before* matching cannot lose a hit that way, because the exempt class is
   * never in the alternation to begin with.
   *
   * Optional for backward compatibility with hand-built DenySet literals
   * (fixtures, older callers). When absent, scanners must fall back to
   * `combinedRegex` everywhere — i.e. no exemption — because without the split
   * they cannot tell the two classes apart. Fail closed.
   */
  strictRegex?: string;
  /**
   * Union of the {@link ALWAYS_FILE_STEM} patterns only — the exemptible
   * class. `combinedRegex` is always the union of this and `strictRegex`;
   * it is kept intact because most callers want "the whole deny set".
   *
   * Exposed (rather than derived on demand) so `audit --fixture-check` and
   * other tooling can report on the exemptible class explicitly.
   */
  exemptibleRegex?: string;
  /**
   * Resolved path globs inside which {@link strictRegex} replaces
   * `combinedRegex`. Repo-relative POSIX globs; see `globs.ts` for the
   * `*`/`?`/`**` semantics. Already validated (a too-broad glob threw at
   * compute time) and already merged from registry + per-repo config.
   *
   * Stored as glob strings rather than compiled RegExps so a DenySet stays
   * JSON-serialisable — the on-disk cache round-trips it verbatim.
   *
   * Absent or empty means no path is exempt.
   */
  exemptPaths?: string[];
  warnings: string[];
}

/**
 * Built-in `_always`-exempt path globs, used when the registry declares no
 * `alwaysBlockExemptPaths` key at all. A registry that declares `[]` gets no
 * exemptions — absent and empty are deliberately different (see the schema).
 *
 * The list is the conventional homes of throwaway secret-shaped material
 * across the ecosystems this tool sees. It is intentionally *only* test and
 * fixture locations: those are the places where a keypair or token prefix is a
 * throwaway by construction. Nothing here exempts an engagement marker or a
 * `_private_infra` host — a customer name or an internal registry host in a
 * test fixture of a public repo is exactly as much of a leak as one in `src/`.
 */
export const BUILTIN_ALWAYS_BLOCK_EXEMPT_PATHS: readonly string[] = [
  "**/test/**",
  "**/tests/**",
  "**/__tests__/**",
  "**/__fixtures__/**",
  "**/fixtures/**",
  "**/testdata/**",
  "**/*.test.*",
  "**/*.spec.*",
  "**/*.fixture.*",
];

/**
 * Resolve the effective `_always`-exempt path globs for a repo:
 * machine-level registry list (or the built-in default when the key is
 * absent), plus this repo's `.repo-aegis.yml` additions.
 *
 * Resolution lives here, not in the CLI, so that every caller that already
 * holds a {@link DenySet} gets the exemptions without threading a second
 * config object through: `check`, the hooks, the MCP tools and the VS Code
 * extension all call {@link computeDenySet} and nothing else.
 *
 * **Registry read failures fall back to the built-in default rather than
 * throwing.** A missing registry is the normal state for the fixture-driven
 * tests and for a fresh machine, and every command that genuinely needs the
 * registry loads it itself and reports the error properly. What is NOT
 * swallowed is a bad *glob*: {@link compileGlobs} throws
 * {@link GlobTooBroadError} for `**` and friends, and that propagates — an
 * exemption covering the whole repo is a config error, and turning it into a
 * silent repo-wide disabling of the `_always` class is the single worst
 * failure this module could have.
 */
export function loadExemptPaths(
  repo: RepoConfig,
  opts: { registryPath?: string } = {},
): string[] {
  let fromRegistry: readonly string[] | undefined;
  try {
    fromRegistry = loadRegistry(opts.registryPath ?? defaultRegistryPath())
      .alwaysBlockExemptPaths;
  } catch {
    fromRegistry = undefined;
  }
  const base = fromRegistry ?? BUILTIN_ALWAYS_BLOCK_EXEMPT_PATHS;
  // Per-repo entries are appended, never able to remove a base entry: the
  // file is checked in, so anyone with commit access can edit it, and
  // "additive within an already-permitted class" is the most it may do.
  const merged: string[] = [];
  for (const g of [...base, ...(repo.alwaysBlockExemptPaths ?? [])]) {
    // Trim only for the duplicate check and for a stable cache fingerprint;
    // an empty or whitespace-only entry is NOT dropped, it is handed to
    // compileGlobs below so it surfaces as a config error like any other
    // unusable glob.
    const key = g.trim();
    if (merged.includes(key)) continue;
    merged.push(key);
  }
  // Validate eagerly so a too-broad glob is a loud config error at deny-set
  // computation time, not a surprise at first scan (or, worse, never).
  compileGlobs(merged);
  return merged;
}

export interface DenySetOptions {
  /**
   * Override the public-facing determination that gates `_private_infra`.
   * Default: {@link isPublicFacing} for this repo. Tests pass it explicitly to
   * avoid a `git config` read.
   */
  publicFacing?: boolean;
  markersDir?: string;
  /**
   * Path to the cache file. Default: `<home>/state/deny-set.cache.json`.
   * Pass `null` to disable caching entirely (useful for tests).
   */
  cachePath?: string | null;
  /**
   * Path to the engagement registry consulted for `alwaysBlockExemptPaths`.
   * Default: {@link defaultRegistryPath}. Tests point this at a temp file so
   * they exercise the real YAML read rather than a stubbed list.
   */
  registryPath?: string;
  /**
   * Bypass {@link loadExemptPaths} entirely and use this list verbatim
   * (still validated). For callers that have already resolved the config, and
   * for tests that want a specific list without writing a registry.
   */
  exemptPaths?: readonly string[];
}

// Bumped to 2 when patternSources was added; bumped to 3 when engagement
// identifiers became auto-blocked self-markers (the computed pattern set changed
// without any marker-file mtime change, so older caches must be invalidated —
// the read path's schemaVersion check returns null, falling through to
// recompute).
// Bumped to 4 when the class-gated `_private_infra` stem was introduced: the
// computed pattern set changed shape without any marker-file mtime change, so
// caches written by 0.5.x must be invalidated on upgrade (same reasoning as the
// 2 -> 3 bump in 0.4.1).
// Bumped to 5 when the deny set gained the strict/exemptible regex split and
// the resolved exempt-path list. Identical reasoning once more: the *computed*
// shape changed while every marker file's mtime and size stayed the same, so a
// cache written by 0.6.x would otherwise be served forever with no `strictRegex`
// and no `exemptPaths` — the new fields would read as "absent", which scanners
// interpret (correctly, and fail-closed) as "no exemptions", and the feature
// would silently do nothing on every already-warm machine.
const DENY_SET_CACHE_VERSION = 5;

interface CacheEntry {
  schemaVersion: number;
  key: string;
  files: DenySetFile[];
  patterns: string[];
  patternSources: string[];
  combinedRegex: string;
  strictRegex: string;
  exemptibleRegex: string;
  exemptPaths: string[];
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
function computeFingerprint(
  repo: RepoConfig,
  dir: string,
  publicFacing: boolean,
  exemptPaths: readonly string[],
): string {
  const fileSummaries: string[] = [];
  if (existsSync(dir)) {
    const files = readdirSync(dir).filter(f => f.endsWith(".txt")).sort();
    for (const f of files) {
      const st = statSync(join(dir, f));
      fileSummaries.push(`${f}:${st.mtimeMs}:${st.size}`);
    }
  }
  const sortedEng = [...repo.engagements].sort().join(",");
  // `publicFacing` participates because it gates whether `_private_infra.txt`
  // joins the set. It can flip without any marker-file or class change (the
  // cached GitHub visibility being refreshed by `status`), so omitting it would
  // serve a stale deny set from cache after a repo is made public.
  // The resolved exempt-path list participates because it is derived from
  // files this fingerprint does NOT stat — the registry YAML and the repo's
  // `.repo-aegis.yml`. Editing either changes what the deny set means without
  // touching a single marker file, so leaving it out would serve a stale
  // (possibly over-permissive) deny set from cache after a config change.
  // JSON-encoded rather than joined on a separator: a glob is a path pattern
  // and may legally contain whatever separator character we might pick, so a
  // naive join would let two different lists collide on one fingerprint.
  const input =
    `v${DENY_SET_CACHE_VERSION}|${repo.class}|${sortedEng}|` +
    `pf=${publicFacing ? 1 : 0}|ep=${JSON.stringify(exemptPaths)}|` +
    fileSummaries.join(";");
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
      // Validated, not defaulted: a cache entry missing the split would be
      // read as "no strict regex", which scanners treat as "no exemptions".
      // That is fail-closed, but it would also make a corrupted cache look
      // like a working one forever. Reject and recompute instead.
      typeof parsed.strictRegex !== "string" ||
      typeof parsed.exemptibleRegex !== "string" ||
      !Array.isArray(parsed.exemptPaths) ||
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
 * Exempt-path list for one {@link computeDenySet} call: the explicit
 * `opts.exemptPaths` override when given, otherwise the config-resolved list.
 * Either way the globs are validated, so an override is not a way to smuggle
 * `**` past the too-broad check.
 */
function resolveExemptPaths(repo: RepoConfig, opts: DenySetOptions): string[] {
  if (opts.exemptPaths !== undefined) {
    const explicit = [...opts.exemptPaths];
    compileGlobs(explicit);
    return explicit;
  }
  return loadExemptPaths(
    repo,
    opts.registryPath !== undefined ? { registryPath: opts.registryPath } : {},
  );
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
  const publicFacing = opts.publicFacing ?? isPublicFacing(repo);
  // Resolved BEFORE the cache lookup, because the resolved list is part of the
  // fingerprint (see computeFingerprint) — and because a too-broad glob must
  // fail loudly even on a cache hit, rather than being masked by a warm cache
  // written before the bad config existed.
  const exemptPaths = resolveExemptPaths(repo, opts);
  const fingerprint = computeFingerprint(repo, dir, publicFacing, exemptPaths);

  if (cachePath !== null) {
    const cached = readCache(cachePath);
    if (cached !== null && cached.key === fingerprint) {
      return {
        files: cached.files,
        patterns: cached.patterns,
        patternSources: cached.patternSources,
        combinedRegex: cached.combinedRegex,
        strictRegex: cached.strictRegex,
        exemptibleRegex: cached.exemptibleRegex,
        exemptPaths: cached.exemptPaths,
        warnings: [...warnings, ...cached.warnings.filter(w => !warnings.includes(w))],
      };
    }
  }

  if (!existsSync(dir)) {
    const empty: DenySet = {
      files: [],
      patterns: [],
      patternSources: [],
      combinedRegex: "",
      strictRegex: "",
      exemptibleRegex: "",
      exemptPaths,
      warnings,
    };
    if (cachePath !== null) {
      writeCache(cachePath, {
        schemaVersion: DENY_SET_CACHE_VERSION,
        key: fingerprint,
        files: [],
        patterns: [],
        patternSources: [],
        combinedRegex: "",
        strictRegex: "",
        exemptibleRegex: "",
        exemptPaths,
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
      // Private infra is blocked only where it would actually be a leak.
      if (stem === PRIVATE_INFRA_FILE_STEM) return publicFacing;
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

  // Auto-block each engagement's own identifier as an always-on self-marker.
  //
  // The patterns above come only from marker-file *contents*. An engagement
  // whose marker file is empty therefore contributes nothing — yet the
  // engagement id is itself operator-chosen and typically customer-derived. It
  // is, in fact, the string most prone to leaking: it appears in this tool's
  // own `status` output and registry, so it readily enters an author's context
  // and gets emitted by reflex. Without this, a zero-marker engagement is
  // "configured but inert" — registered, listed under `blocked:`, protecting
  // nothing.
  //
  // The id is added as an escaped, case-insensitive literal (identical matching
  // to every other marker). For customer-coupled / scratch classes the repo's
  // OWN engagement files are already excluded from `files` (the filter above),
  // so a repo may still mention its own engagement id; only OTHER engagements'
  // ids are blocked. `_always` is a system stem, not an identifier.
  for (const f of files) {
    // Both reserved stems are system names, not engagement identifiers — they
    // must never be auto-blocked as literals.
    if (f.stem === ALWAYS_FILE_STEM || f.stem === PRIVATE_INFRA_FILE_STEM) continue;
    if (f.stem.length < MIN_AUTO_BLOCK_IDENTIFIER_LENGTH) continue;
    const literal = escapeRegexLiteral(f.stem);
    if (patterns.includes(literal)) continue; // already present as an explicit marker
    patterns.push(literal);
    patternSources.push(f.stem);
  }

  // The class split. Built from the same (patterns, patternSources) arrays the
  // combined regex comes from, in the same order, so the three regexes can
  // never disagree about which pattern belongs where.
  //
  // Note which stems land on which side: ONLY `_always` is exemptible.
  // `_private_infra` joins `strictRegex` alongside the engagement markers,
  // because a private registry host or internal domain in a test fixture of a
  // public repo is still a leak — the fixture directory is not a safe home for
  // it the way it is for a throwaway keypair.
  const strictPatterns: string[] = [];
  const exemptiblePatterns: string[] = [];
  for (let i = 0; i < patterns.length; i++) {
    const p = patterns[i]!;
    if (patternSources[i] === ALWAYS_FILE_STEM) exemptiblePatterns.push(p);
    else strictPatterns.push(p);
  }

  const result: DenySet = {
    files,
    patterns,
    patternSources,
    combinedRegex: patterns.join("|"),
    strictRegex: strictPatterns.join("|"),
    exemptibleRegex: exemptiblePatterns.join("|"),
    exemptPaths,
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
      strictRegex: result.strictRegex ?? "",
      exemptibleRegex: result.exemptibleRegex ?? "",
      exemptPaths,
      // Cache only the input-derived warnings; the call-time class mismatch
      // warning is recomputed above per call.
      warnings: [],
    });
  }

  return result;
}
