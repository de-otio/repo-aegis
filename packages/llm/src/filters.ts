// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// Pure filter functions used by the marker-suggestion pipeline.
//
// All three filters are stateless and do not mutate their inputs.
// Each returns a new array containing only the tokens that passed the filter.

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// TokenT — the shared token shape used across the suggestion pipeline.
// Exported here so consumers (tests, synthesis.ts, token-extraction.ts, etc.)
// can import it without depending on a not-yet-merged module.
// ---------------------------------------------------------------------------

export interface TokenT {
  /** The exact string observed in the repo content. */
  token: string;
  /** Semantic category assigned by the extraction model. */
  kind: string;
  /** Model confidence in the range [0, 1]. Optional. */
  confidence?: number;
  /** Path within the ProseBundle, if attributable. */
  sourceFile?: string;
}

// ---------------------------------------------------------------------------
// Dictionary filter
// ---------------------------------------------------------------------------

/**
 * Loads the bundled 10k English wordlist as a Set of lowercase strings.
 *
 * The wordlist file is co-located with the compiled JS; paths are resolved
 * relative to the current module file regardless of whether the caller is
 * running from `src/` or `dist/`.
 */
export function loadDefaultWordlist(): Set<string> {
  // Works in both ESM (import.meta.url available) and CJS (fallback).
  let baseDir: string;
  try {
    // ESM path
    baseDir = dirname(fileURLToPath(import.meta.url));
  } catch {
    // CJS fallback — should not occur given package type=module, but be safe.
    const _req = createRequire(import.meta.url);
    baseDir = dirname(_req.resolve("./filters.js"));
  }

  // The wordlist lives in src/ alongside filters.ts.  After compilation the
  // dist/ directory contains filters.js, but the src/ directory is a sibling
  // of dist/ inside packages/llm/.  We navigate up one level from wherever
  // the current file lives and then into src/.
  //
  // When running from the compiled output (dist/filters.js):
  //   baseDir = .../packages/llm/dist
  //   listPath = .../packages/llm/src/wordlist-en-10k.txt
  //
  // When running the source directly (unlikely but harmless):
  //   baseDir = .../packages/llm/src
  //   listPath = .../packages/llm/src/wordlist-en-10k.txt  (same dir)
  let listPath: string;
  if (baseDir.endsWith("dist")) {
    listPath = join(baseDir, "..", "src", "wordlist-en-10k.txt");
  } else {
    // Already in src (or some other layout) — look in same dir.
    listPath = join(baseDir, "wordlist-en-10k.txt");
  }

  const raw = readFileSync(listPath, "utf8");
  return parseWordlist(raw);
}

/**
 * Parses a wordlist file and returns a Set of lowercase words.
 * Lines starting with `#` are treated as comments and skipped.
 * Blank lines are skipped.
 */
export function parseWordlist(raw: string): Set<string> {
  const words = new Set<string>();
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    words.add(trimmed.toLowerCase());
  }
  return words;
}

/**
 * Removes tokens whose lowercase form exactly matches a dictionary entry.
 *
 * @param tokens - Input token array (not mutated).
 * @param wordlist - Set of lowercase dictionary words.  If omitted, the
 *                   bundled default wordlist is loaded once and cached.
 * @returns A new array with dictionary-matched tokens removed.
 */
export function filterDictionary(
  tokens: readonly TokenT[],
  wordlist?: Set<string>,
): TokenT[] {
  const dict = wordlist ?? _defaultWordlist();
  return tokens.filter((t) => !dict.has(t.token.toLowerCase()));
}

// Lazy-loaded cache for the default wordlist — loaded once per process.
let _cachedDefaultWordlist: Set<string> | undefined;
function _defaultWordlist(): Set<string> {
  if (_cachedDefaultWordlist === undefined) {
    _cachedDefaultWordlist = loadDefaultWordlist();
  }
  return _cachedDefaultWordlist;
}

// ---------------------------------------------------------------------------
// Existing-pattern dedup filter
// ---------------------------------------------------------------------------

/**
 * Removes candidates whose synthesised regex string exactly matches any
 * string in the `existingPatterns` array (literal string equality).
 *
 * The test fixture passes synthesised regex strings directly — this filter
 * does not attempt any regex matching, only exact string comparison.
 *
 * @param tokens - Input token array (not mutated).
 * @param existingPatterns - Array of regex strings already in the engagement.
 * @returns A new array with already-present patterns removed.
 */
export function filterExistingPatterns(
  tokens: readonly TokenT[],
  existingPatterns: readonly string[],
): TokenT[] {
  const patternSet = new Set(existingPatterns);
  return tokens.filter((t) => !patternSet.has(t.token));
}

// ---------------------------------------------------------------------------
// Dependency-name filter
// ---------------------------------------------------------------------------

/**
 * Removes candidates whose `token` exactly matches a top-level dependency
 * name extracted from the repo's manifest files.
 *
 * Supported manifests (best-effort; gracefully missing):
 *   - package.json  → dependencies + devDependencies
 *   - Cargo.toml    → [dependencies] + [dev-dependencies]
 *   - go.mod        → require directives (module path, last path segment)
 *   - pyproject.toml → [tool.poetry.dependencies] + [project.dependencies]
 *
 * @param tokens - Input token array (not mutated).
 * @param repoRoot - Absolute path to the root of the repo.
 * @returns A new array with dependency-named tokens removed.
 */
export function filterDependencyNames(
  tokens: readonly TokenT[],
  repoRoot: string,
): TokenT[] {
  const depNames = collectDependencyNames(repoRoot);
  return tokens.filter((t) => !depNames.has(t.token));
}

/**
 * Collects all dependency names from manifest files in `repoRoot`.
 * Returns an empty set when no manifests are found.
 */
export function collectDependencyNames(repoRoot: string): Set<string> {
  const names = new Set<string>();

  for (const name of parsePackageJson(repoRoot)) names.add(name);
  for (const name of parseCargoToml(repoRoot)) names.add(name);
  for (const name of parseGoMod(repoRoot)) names.add(name);
  for (const name of parsePyprojectToml(repoRoot)) names.add(name);

  return names;
}

// ---------------------------------------------------------------------------
// Manifest parsers — each returns an iterable of dependency name strings.
// ---------------------------------------------------------------------------

function readManifest(repoRoot: string, filename: string): string | null {
  try {
    return readFileSync(join(repoRoot, filename), "utf8");
  } catch {
    return null;
  }
}

/**
 * Parses `package.json` and yields keys from `dependencies` and
 * `devDependencies`.
 */
export function* parsePackageJson(repoRoot: string): Iterable<string> {
  const raw = readManifest(repoRoot, "package.json");
  if (raw === null) return;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return;
  }

  if (typeof parsed !== "object" || parsed === null) return;
  const pkg = parsed as Record<string, unknown>;

  for (const field of ["dependencies", "devDependencies"] as const) {
    const section = pkg[field];
    if (typeof section === "object" && section !== null) {
      for (const name of Object.keys(section as object)) {
        // Strip npm scope prefix (@org/name → name) for simpler matching.
        // Keep the full name too so both forms are checked.
        yield name;
        const slash = name.lastIndexOf("/");
        if (slash !== -1) yield name.slice(slash + 1);
      }
    }
  }
}

/**
 * Parses `Cargo.toml` (minimal TOML subset) and yields keys from
 * `[dependencies]` and `[dev-dependencies]` sections.
 *
 * This is a best-effort line-oriented parser — it does not handle multi-line
 * values or workspace inheritance.  It is intentionally simple to avoid
 * pulling in a TOML library.
 */
export function* parseCargoToml(repoRoot: string): Iterable<string> {
  const raw = readManifest(repoRoot, "Cargo.toml");
  if (raw === null) return;

  let inDeps = false;
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) {
      continue;
    }
    // Section header
    if (trimmed.startsWith("[")) {
      const header = trimmed.replace(/\s/g, "").toLowerCase();
      inDeps =
        header === "[dependencies]" ||
        header === "[dev-dependencies]" ||
        header === "[build-dependencies]";
      continue;
    }
    if (!inDeps) continue;
    // Key = value or Key = { ... }
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    if (key.length > 0 && /^[a-zA-Z0-9_-]+$/.test(key)) {
      yield key;
    }
  }
}

/**
 * Parses `go.mod` and yields dependency module names.
 *
 * Both the full module path and its last path segment are yielded so the
 * filter works for `require github.com/org/module` — the token "module"
 * would match the last segment.
 */
export function* parseGoMod(repoRoot: string): Iterable<string> {
  const raw = readManifest(repoRoot, "go.mod");
  if (raw === null) return;

  // require directives can appear as:
  //   require foo/bar v1.2.3           (single-line form)
  //   require (                        (block form)
  //       foo/bar v1.2.3
  //   )
  // The single-line form starts with the keyword "require"; the block-form
  // lines are indented with the module path and version directly.
  // require directives can appear as:
  //   require foo/bar v1.2.3           (single-line form, starts with "require")
  //   require (                        (block form, indented module paths)
  //       foo/bar v1.2.3
  //   )
  // A single combined regex handles both: optionally match "require " at the
  // start, then capture the module path, then expect a version "vX".
  const requireRe = /^\s*(?:require\s+)?([a-zA-Z0-9][a-zA-Z0-9./_-]*)\s+v\S/;

  for (const line of raw.split("\n")) {
    const m = requireRe.exec(line);
    if (m === null) continue;
    const modPath = m[1]!;
    // Skip the "require" keyword itself if somehow captured (shouldn't happen
    // with the regex above, but be defensive).
    if (modPath === "require") continue;
    yield modPath;
    const slash = modPath.lastIndexOf("/");
    if (slash !== -1) yield modPath.slice(slash + 1);
  }
}

/**
 * Parses `pyproject.toml` and yields dependency names from
 * `[tool.poetry.dependencies]` and `[project.dependencies]` (PEP 517/518).
 *
 * Same best-effort line-oriented approach as `parseCargoToml`.
 */
export function* parsePyprojectToml(repoRoot: string): Iterable<string> {
  const raw = readManifest(repoRoot, "pyproject.toml");
  if (raw === null) return;

  let inDeps = false;
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) {
      continue;
    }
    // Section header
    if (trimmed.startsWith("[")) {
      const header = trimmed.replace(/\s/g, "").toLowerCase();
      inDeps =
        header === "[tool.poetry.dependencies]" ||
        header === "[tool.poetry.dev-dependencies]" ||
        header === "[project.dependencies]" ||
        // PEP 735 / modern pyproject styles
        header === "[dependency-groups.dev]" ||
        header === "[project.optional-dependencies.dev]";
      continue;
    }
    // Handle PEP 517/518 [project] dependencies as array entries:
    //   dependencies = [
    //       "requests>=2.0",
    //   ]
    // Lines starting with '"' or "'" inside a deps section.
    if (inDeps && (trimmed.startsWith('"') || trimmed.startsWith("'"))) {
      // Extract the package name up to any version specifier.
      const nameMatch = /^["']([A-Za-z0-9._-]+)/.exec(trimmed);
      if (nameMatch !== null) {
        yield nameMatch[1]!;
        // Normalise PEP 503 (replace hyphens/dots with underscores and vice versa)
        yield nameMatch[1]!.replace(/[-_.]+/g, "-");
        yield nameMatch[1]!.replace(/[-_.]+/g, "_");
      }
      continue;
    }
    if (!inDeps) continue;
    // Key = value (poetry style: requests = ">=2.0")
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    if (key.length > 0 && /^[A-Za-z0-9._-]+$/.test(key) && key !== "python") {
      yield key;
      // Normalise hyphens/dots/underscores for matching.
      yield key.replace(/[-_.]+/g, "-");
      yield key.replace(/[-_.]+/g, "_");
    }
  }
}
