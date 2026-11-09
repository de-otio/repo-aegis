// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  legacyDenySetCachePath,
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
 * Reserved stem for the operator's own-identity marker file — the mirror of
 * {@link PRIVATE_INFRA_FILE_STEM}, class-gated in the opposite direction: it
 * joins the deny set only when the repo (or, for the egress guard, the
 * destination) is `customer-coupled`.
 *
 * Engagement markers keep a customer's strings out of our repos. These keep
 * our strings — our org and package names, our internal codenames, an agent
 * session link — out of a customer's. Everywhere else they are not merely
 * harmless but load-bearing: our own org name appears in every remote URL of
 * every repo we own, so blocking it outside a customer repo would fire
 * constantly in exactly the places it belongs.
 */
export const SELF_IDENTITY_FILE_STEM = "_self_identity";

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
   * JSON-serialisable.
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
    // Trim only for the duplicate check;
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

// The deny set is computed fresh on every call. There used to be an on-disk
// cache keyed by a marker-file mtime+size fingerprint; it could serve a stale
// set after an edit that kept both, and a forged entry could switch the scanner
// off. Computing is a directory read plus the marker files, so it was not worth
// the failure modes. The old cache file is removed once per process.
let legacyCacheSwept = false;

/**
 * Best-effort, silent: delete the pre-0.14 `state/deny-set.cache.json`.
 * Returns whether a file was removed. Exported for the test; callers use
 * {@link computeDenySet}, which sweeps once per process.
 *
 * @internal
 */
export function removeLegacyDenySetCache(home?: string): boolean {
  try {
    const path = legacyDenySetCachePath(home);
    if (!existsSync(path)) return false;
    rmSync(path, { force: true });
    return true;
  } catch {
    /* a cache we cannot delete is harmless: nothing reads it any more */
    return false;
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
 * - `customer-coupled`: union of `_always.txt` + `_self_identity.txt` + every
 *   per-engagement file whose stem is NOT in this repo's `engagements` list.
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

  if (!legacyCacheSwept) {
    legacyCacheSwept = true;
    removeLegacyDenySetCache();
  }
  const publicFacing = opts.publicFacing ?? isPublicFacing(repo);
  // The `_self_identity` gate. Deliberately NOT a `DenySetOptions` field: the
  // condition is the repo's class and nothing else, and `readRepoConfig` /
  // the egress guard's destination resolution already produce that class. An
  // override option would be a second, silent way to switch the stem on — the
  // kind of knob that ends up set in a hook script and never reviewed.
  const selfIdentityActive = repo.class === "customer-coupled";
  // Resolved first so a too-broad glob fails loudly even when the markers
  // directory is missing.
  const exemptPaths = resolveExemptPaths(repo, opts);

  if (!existsSync(dir)) {
    return {
      files: [],
      patterns: [],
      patternSources: [],
      combinedRegex: "",
      strictRegex: "",
      exemptibleRegex: "",
      exemptPaths,
      warnings,
    };
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
      // Our own identity is a leak only in a customer's repo. Checked before
      // the scoping branch below, which would otherwise wave this system stem
      // through as "not one of this repo's own engagements".
      if (stem === SELF_IDENTITY_FILE_STEM) return selfIdentityActive;
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
    // The reserved stems are system names, not engagement identifiers — they
    // must never be auto-blocked as literals.
    if (
      f.stem === ALWAYS_FILE_STEM ||
      f.stem === PRIVATE_INFRA_FILE_STEM ||
      f.stem === SELF_IDENTITY_FILE_STEM
    ) {
      continue;
    }
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
  // `_private_infra` and `_self_identity` join `strictRegex` alongside the
  // engagement markers, because a private registry host or internal domain in
  // a test fixture of a public repo is still a leak — the fixture directory is
  // not a safe home for it the way it is for a throwaway keypair — and our own
  // project name in a fixture we hand to a customer is still our name in their
  // repository. Both stems have already survived their class gate by the time
  // they reach here; the path-exemption question is separate and the answer is
  // no for every non-`_always` stem.
  const strictPatterns: string[] = [];
  const exemptiblePatterns: string[] = [];
  for (let i = 0; i < patterns.length; i++) {
    const p = patterns[i]!;
    if (patternSources[i] === ALWAYS_FILE_STEM) exemptiblePatterns.push(p);
    else strictPatterns.push(p);
  }

  return {
    files,
    patterns,
    patternSources,
    combinedRegex: patterns.join("|"),
    strictRegex: strictPatterns.join("|"),
    exemptibleRegex: exemptiblePatterns.join("|"),
    exemptPaths,
    warnings,
  };
}
