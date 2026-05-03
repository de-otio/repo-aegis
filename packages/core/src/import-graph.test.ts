// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// Hot-path determinism guard.
//
// The deterministic gate (PostToolUse hook, pre-commit, pre-push, render)
// must remain offline and free of LLM dependencies. This test walks the
// static import graph from the gate-path entry points and fails if any
// resolved file lives under `packages/llm/`. It also greps the same set
// of files for string literals matching `@de-otio/repo-aegis-llm` or
// `packages/llm`, catching dynamic `import()` / `require(varName)` /
// templated specifiers that the static walker would otherwise miss.
//
// Tests run from the repo root (process.cwd() at `npm test` time). The
// walk operates on the *compiled* .js sources in each package's `dist/`,
// not the .ts sources, because that's what actually loads at runtime —
// any tsc-time conditional or stripped code disappears here naturally.

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

// ---- configuration --------------------------------------------------------

/**
 * Entry points whose import closure must not touch
 * `@de-otio/repo-aegis-llm` (or its on-disk path `packages/llm/`).
 *
 * Express as relative paths from the repo root; the walker resolves them
 * to compiled `.js` and then walks `import` / `require` references.
 */
const GATE_PATH_ENTRY_POINTS: string[] = [
  "packages/core/dist/scan.js",
  "packages/core/dist/render.js",
  "packages/core/dist/deny-set.js",
  "packages/cli/dist/commands/check.js",
  "packages/cli/dist/commands/hook-scan-after-write.js",
  "packages/cli/dist/commands/render.js",
];

const FORBIDDEN_PACKAGE_PATTERNS: RegExp[] = [
  /(?:^|[\\/])packages[\\/]llm[\\/]/,
  /(?:^|[\\/])@de-otio[\\/]repo-aegis-llm[\\/]/,
];

// String literals that must not appear in any source file reachable
// from the gate path (catches dynamic imports the static walker misses).
const FORBIDDEN_STRING_LITERALS: string[] = [
  "@de-otio/repo-aegis-llm",
  "packages/llm",
  "repo-aegis-llm",
];

// ---- repo-root resolution -------------------------------------------------

/** Locate the monorepo root by walking up from cwd until package.json's
 *  `repo-aegis-monorepo` name marker is found. */
function findRepoRoot(): string {
  let cur = process.cwd();
  for (let i = 0; i < 16; i++) {
    const pkg = join(cur, "package.json");
    if (existsSync(pkg)) {
      try {
        const json = JSON.parse(readFileSync(pkg, "utf8")) as { name?: string };
        if (json.name === "repo-aegis-monorepo") return cur;
      } catch {
        // ignore parse errors at intermediate package.json files
      }
    }
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  throw new Error(`could not locate repo-aegis monorepo root from cwd=${process.cwd()}`);
}

// ---- import extraction ----------------------------------------------------

// Match `import ... from "X"`, `import "X"`, `import("X")`, `require("X")`.
// Strict on the quote style: only matches single or double quotes (no
// template literals — those are caught by the string-literal grep step
// instead, intentionally, since they suggest dynamic resolution).
const IMPORT_RE =
  /(?:^|[^\w$])(?:import\s+(?:[\w*${},\s]+\s+from\s+)?|import\s*\(\s*|require\s*\(\s*)["']([^"']+)["']/g;

function extractStaticImportSpecifiers(source: string): string[] {
  const results: string[] = [];
  IMPORT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = IMPORT_RE.exec(source)) !== null) {
    const spec = m[1];
    if (spec !== undefined) results.push(spec);
  }
  return results;
}

// ---- specifier resolution -------------------------------------------------

/**
 * Resolve an ES module specifier to an absolute file path on disk, or
 * `null` if the specifier is external (a node_modules dependency we
 * don't follow). Workspace links under `node_modules/@de-otio/...` are
 * followed via `realpathSync`.
 */
function resolveSpecifier(
  specifier: string,
  fromFile: string,
  repoRoot: string,
): string | null {
  // Node built-ins (`node:fs`, etc) — skip.
  if (specifier.startsWith("node:")) return null;

  // Relative — resolve against the importing file.
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    const candidate = resolve(dirname(fromFile), specifier);
    return resolveFileWithExtensions(candidate);
  }

  // Workspace package via node_modules symlink.
  if (specifier.startsWith("@de-otio/")) {
    const linkPath = join(repoRoot, "node_modules", specifier);
    if (!existsSync(linkPath)) return null;
    const real = realpathSync(linkPath);
    // Resolve to the package's main (typically dist/index.js).
    const pkgJson = join(real, "package.json");
    if (!existsSync(pkgJson)) return null;
    const json = JSON.parse(readFileSync(pkgJson, "utf8")) as { main?: string };
    const main = json.main ?? "dist/index.js";
    const mainPath = join(real, main);
    return resolveFileWithExtensions(mainPath);
  }

  // External package — skip.
  return null;
}

function resolveFileWithExtensions(candidate: string): string | null {
  if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  for (const ext of [".js", ".cjs", ".mjs"]) {
    const withExt = candidate + ext;
    if (existsSync(withExt) && statSync(withExt).isFile()) return withExt;
  }
  // index.js inside a directory
  if (existsSync(candidate) && statSync(candidate).isDirectory()) {
    const indexJs = join(candidate, "index.js");
    if (existsSync(indexJs)) return indexJs;
  }
  return null;
}

// ---- graph walk -----------------------------------------------------------

function walkImportGraph(entryPoints: string[], repoRoot: string): Set<string> {
  const visited = new Set<string>();
  const stack: string[] = entryPoints.map(p => resolve(repoRoot, p));

  while (stack.length > 0) {
    const file = stack.pop();
    if (file === undefined || visited.has(file)) continue;
    if (!existsSync(file)) {
      // Entry point not built — surface in test failure.
      throw new Error(`gate-path entry point not built: ${file}`);
    }
    visited.add(file);

    let source: string;
    try {
      source = readFileSync(file, "utf8");
    } catch {
      continue;
    }

    const specs = extractStaticImportSpecifiers(source);
    for (const spec of specs) {
      const resolved = resolveSpecifier(spec, file, repoRoot);
      if (resolved !== null && !visited.has(resolved)) {
        stack.push(resolved);
      }
    }
  }

  return visited;
}

// ---- the test ------------------------------------------------------------

describe("hot-path determinism guard", () => {
  let repoRoot: string;
  let reachable: Set<string>;

  before(() => {
    repoRoot = findRepoRoot();
    reachable = walkImportGraph(GATE_PATH_ENTRY_POINTS, repoRoot);
  });

  it("walks at least one entry point successfully", () => {
    // Sanity — if this fails, the walker is broken (or no .js was built).
    assert.ok(reachable.size > 0, "expected at least one reachable file");
  });

  it("no gate-path file resolves under packages/llm/", () => {
    const offenders = [...reachable].filter(p =>
      FORBIDDEN_PACKAGE_PATTERNS.some(re => re.test(relative(repoRoot, p))),
    );
    assert.equal(
      offenders.length,
      0,
      `gate path imports forbidden package(s):\n` +
        offenders.map(o => `  ${relative(repoRoot, o)}`).join("\n"),
    );
  });

  // [SEC M-1] Catch dynamic imports / `require(variable)` / templated
  // specifiers that the static walker would miss. Greps every reachable
  // file's source for the forbidden literals.
  it("[SEC M-1] no reachable file contains a literal LLM-package reference", () => {
    const offenders: Array<{ file: string; literal: string }> = [];
    for (const file of reachable) {
      let source: string;
      try {
        source = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      for (const literal of FORBIDDEN_STRING_LITERALS) {
        if (source.includes(literal)) {
          offenders.push({ file: relative(repoRoot, file), literal });
        }
      }
    }
    assert.equal(
      offenders.length,
      0,
      `gate-path file(s) contain forbidden string literal(s):\n` +
        offenders.map(o => `  ${o.file}  (literal: "${o.literal}")`).join("\n"),
    );
  });
});
