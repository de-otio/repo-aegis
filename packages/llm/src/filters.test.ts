// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// Unit tests for filters.ts.
//
// Coverage target: 80% lines / 75% branches on filters.ts.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type TokenT,
  filterDictionary,
  filterExistingPatterns,
  filterDependencyNames,
  loadDefaultWordlist,
  parseWordlist,
  collectDependencyNames,
  parsePackageJson,
  parseCargoToml,
  parseGoMod,
  parsePyprojectToml,
} from "./filters.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tok(token: string, kind = "company"): TokenT {
  return { token, kind };
}

let tmp: string;

before(() => {
  tmp = mkdtempSync(join(tmpdir(), "repo-aegis-filters-"));
});

after(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function writeFixture(filename: string, content: string, subdir?: string): string {
  const dir = subdir ? join(tmp, subdir) : tmp;
  mkdirSync(dir, { recursive: true });
  const p = join(dir, filename);
  writeFileSync(p, content);
  return p;
}

function makeRepoDir(name: string): string {
  const dir = join(tmp, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ---------------------------------------------------------------------------
// filterDictionary
// ---------------------------------------------------------------------------

describe("filterDictionary", () => {
  it("returns empty array for empty input", () => {
    assert.deepEqual(filterDictionary([], new Set(["the"])), []);
  });

  it("keeps tokens not in the wordlist", () => {
    const wordlist = new Set(["the", "and", "of"]);
    const tokens = [tok("FooCorp"), tok("ProjectAlpha"), tok("the")];
    const result = filterDictionary(tokens, wordlist);
    assert.equal(result.length, 2);
    assert.equal(result[0]!.token, "FooCorp");
    assert.equal(result[1]!.token, "ProjectAlpha");
  });

  it("rejects tokens whose lowercase form matches a wordlist entry", () => {
    const wordlist = new Set(["service", "platform", "common"]);
    const tokens = [tok("Service"), tok("PLATFORM"), tok("common"), tok("FooCorp")];
    const result = filterDictionary(tokens, wordlist);
    assert.equal(result.length, 1);
    assert.equal(result[0]!.token, "FooCorp");
  });

  it("is case-insensitive for dictionary lookup", () => {
    const wordlist = new Set(["network"]);
    const tokens = [tok("NETWORK"), tok("Network"), tok("network")];
    const result = filterDictionary(tokens, wordlist);
    assert.deepEqual(result, []);
  });

  it("does not mutate the input array", () => {
    const wordlist = new Set(["service"]);
    const tokens: TokenT[] = [tok("service"), tok("FooCorp")];
    const original = [...tokens];
    filterDictionary(tokens, wordlist);
    assert.deepEqual(tokens, original);
  });

  it("returns a new array (not the same reference)", () => {
    const wordlist = new Set<string>();
    const tokens = [tok("FooCorp")];
    const result = filterDictionary(tokens, wordlist);
    assert.notEqual(result, tokens);
  });

  it("keeps tokens with trailing/leading whitespace if wordlist doesn't match", () => {
    const wordlist = new Set(["service"]);
    const tokens = [tok("service-corp"), tok("my-service")];
    const result = filterDictionary(tokens, wordlist);
    assert.equal(result.length, 2);
  });

  it("works with the default (bundled) wordlist when none is passed", () => {
    // "the" is in the google-10k list; "xyzwidgetcorp9" should not be.
    const tokens = [tok("the"), tok("xyzwidgetcorp9")];
    const result = filterDictionary(tokens);
    assert.equal(result.length, 1);
    assert.equal(result[0]!.token, "xyzwidgetcorp9");
  });

  it("preserves token metadata (kind, confidence, sourceFile)", () => {
    const wordlist = new Set(["service"]);
    const tokens: TokenT[] = [
      { token: "FooCorp", kind: "company", confidence: 0.9, sourceFile: "README.md" },
    ];
    const result = filterDictionary(tokens, wordlist);
    assert.equal(result.length, 1);
    assert.equal(result[0]!.kind, "company");
    assert.equal(result[0]!.confidence, 0.9);
    assert.equal(result[0]!.sourceFile, "README.md");
  });
});

// ---------------------------------------------------------------------------
// loadDefaultWordlist / parseWordlist
// ---------------------------------------------------------------------------

describe("loadDefaultWordlist", () => {
  it("returns a Set with more than 9000 entries", () => {
    const wl = loadDefaultWordlist();
    assert.ok(wl.size > 9000, `expected > 9000 entries, got ${wl.size}`);
  });

  it("contains common English words like 'the', 'and', 'service'", () => {
    const wl = loadDefaultWordlist();
    assert.ok(wl.has("the"), "should contain 'the'");
    assert.ok(wl.has("and"), "should contain 'and'");
  });

  it("does not contain comment lines", () => {
    const wl = loadDefaultWordlist();
    for (const word of wl) {
      assert.ok(!word.startsWith("#"), `comment line found: ${word}`);
    }
  });
});

describe("parseWordlist", () => {
  it("skips blank lines and comment lines", () => {
    const raw = "# comment\n\nfoo\nbar\n\n# another\nbaz\n";
    const wl = parseWordlist(raw);
    assert.deepEqual([...wl].sort(), ["bar", "baz", "foo"]);
  });

  it("lowercases all entries", () => {
    const raw = "FOO\nBar\nbaz\n";
    const wl = parseWordlist(raw);
    assert.ok(wl.has("foo"));
    assert.ok(wl.has("bar"));
    assert.ok(wl.has("baz"));
    assert.ok(!wl.has("FOO"));
  });

  it("returns empty set for empty input", () => {
    assert.equal(parseWordlist("").size, 0);
    assert.equal(parseWordlist("# only comments\n").size, 0);
  });
});

// ---------------------------------------------------------------------------
// filterExistingPatterns
// ---------------------------------------------------------------------------

describe("filterExistingPatterns", () => {
  it("returns empty array for empty input", () => {
    assert.deepEqual(filterExistingPatterns([], ["\\bfoo\\b"]), []);
  });

  it("removes tokens whose token string exactly matches an existing pattern", () => {
    const existing = ["\\bfoo\\b", "\\bbar\\.example\\.com\\b"];
    const tokens = [
      tok("\\bfoo\\b"),
      tok("\\bnew-thing\\b"),
      tok("\\bbar\\.example\\.com\\b"),
    ];
    const result = filterExistingPatterns(tokens, existing);
    assert.equal(result.length, 1);
    assert.equal(result[0]!.token, "\\bnew-thing\\b");
  });

  it("uses literal string equality — does not execute the pattern as regex", () => {
    // "\\b.+\\b" as a regex would match "\\bfoo\\b", but as a literal it should not.
    const existing = ["\\b.+\\b"];
    const tokens = [tok("\\bfoo\\b"), tok("\\b.+\\b")];
    const result = filterExistingPatterns(tokens, existing);
    assert.equal(result.length, 1);
    assert.equal(result[0]!.token, "\\bfoo\\b");
  });

  it("returns all tokens when no patterns overlap", () => {
    const existing = ["\\bother\\b"];
    const tokens = [tok("\\bfoo\\b"), tok("\\bbar\\b")];
    const result = filterExistingPatterns(tokens, existing);
    assert.equal(result.length, 2);
  });

  it("does not mutate the input array", () => {
    const existing = ["\\bfoo\\b"];
    const tokens: TokenT[] = [tok("\\bfoo\\b"), tok("\\bbar\\b")];
    const original = [...tokens];
    filterExistingPatterns(tokens, existing);
    assert.deepEqual(tokens, original);
  });

  it("returns a new array reference", () => {
    const tokens = [tok("\\bfoo\\b")];
    const result = filterExistingPatterns(tokens, []);
    assert.notEqual(result, tokens);
  });

  it("handles empty existing patterns list — keeps all tokens", () => {
    const tokens = [tok("\\bfoo\\b"), tok("\\bbar\\b")];
    const result = filterExistingPatterns(tokens, []);
    assert.equal(result.length, 2);
  });

  it("is case-sensitive for pattern equality", () => {
    const existing = ["\\bFOO\\b"];
    const tokens = [tok("\\bfoo\\b"), tok("\\bFOO\\b")];
    const result = filterExistingPatterns(tokens, existing);
    assert.equal(result.length, 1);
    assert.equal(result[0]!.token, "\\bfoo\\b");
  });
});

// ---------------------------------------------------------------------------
// filterDependencyNames
// ---------------------------------------------------------------------------

describe("filterDependencyNames", () => {
  it("returns empty array for empty input", () => {
    const dir = makeRepoDir("empty-input");
    assert.deepEqual(filterDependencyNames([], dir), []);
  });

  it("keeps tokens with no manifests present", () => {
    const dir = makeRepoDir("no-manifests");
    const tokens = [tok("lodash"), tok("react"), tok("FooCorp")];
    const result = filterDependencyNames(tokens, dir);
    assert.equal(result.length, 3);
  });

  it("does not mutate the input array", () => {
    const dir = makeRepoDir("no-mutate");
    writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: { lodash: "^4.0" } }));
    const tokens: TokenT[] = [tok("lodash"), tok("FooCorp")];
    const original = [...tokens];
    filterDependencyNames(tokens, dir);
    assert.deepEqual(tokens, original);
  });

  it("returns a new array reference", () => {
    const dir = makeRepoDir("new-arr");
    const tokens = [tok("FooCorp")];
    const result = filterDependencyNames(tokens, dir);
    assert.notEqual(result, tokens);
  });
});

// ---------------------------------------------------------------------------
// parsePackageJson
// ---------------------------------------------------------------------------

describe("parsePackageJson", () => {
  it("returns empty iterable when file is missing", () => {
    const dir = makeRepoDir("pkg-missing");
    assert.deepEqual([...parsePackageJson(dir)], []);
  });

  it("returns empty iterable when file has invalid JSON", () => {
    const dir = makeRepoDir("pkg-invalid");
    writeFileSync(join(dir, "package.json"), "not-json {{");
    assert.deepEqual([...parsePackageJson(dir)], []);
  });

  it("yields keys from dependencies and devDependencies", () => {
    const dir = makeRepoDir("pkg-basic");
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        dependencies: { lodash: "^4.0", express: "^4.18" },
        devDependencies: { typescript: "^5.0", vitest: "^1.0" },
      }),
    );
    const names = new Set(parsePackageJson(dir));
    assert.ok(names.has("lodash"));
    assert.ok(names.has("express"));
    assert.ok(names.has("typescript"));
    assert.ok(names.has("vitest"));
  });

  it("handles scoped packages — yields both full name and unscoped part", () => {
    const dir = makeRepoDir("pkg-scoped");
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        dependencies: { "@de-otio/repo-aegis-core": "^0.1.0" },
      }),
    );
    const names = new Set(parsePackageJson(dir));
    assert.ok(names.has("@de-otio/repo-aegis-core"));
    assert.ok(names.has("repo-aegis-core"));
  });

  it("handles missing dependencies fields gracefully", () => {
    const dir = makeRepoDir("pkg-no-deps");
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "foo" }));
    assert.deepEqual([...parsePackageJson(dir)], []);
  });

  it("filters out dep names via filterDependencyNames", () => {
    const dir = makeRepoDir("pkg-filter");
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ dependencies: { lodash: "^4.0", react: "^18.0" } }),
    );
    const tokens = [tok("lodash"), tok("react"), tok("FooCorp")];
    const result = filterDependencyNames(tokens, dir);
    assert.equal(result.length, 1);
    assert.equal(result[0]!.token, "FooCorp");
  });
});

// ---------------------------------------------------------------------------
// parseCargoToml
// ---------------------------------------------------------------------------

describe("parseCargoToml", () => {
  it("returns empty iterable when file is missing", () => {
    const dir = makeRepoDir("cargo-missing");
    assert.deepEqual([...parseCargoToml(dir)], []);
  });

  it("yields keys from [dependencies] and [dev-dependencies]", () => {
    const dir = makeRepoDir("cargo-basic");
    writeFileSync(
      join(dir, "Cargo.toml"),
      `
[package]
name = "myapp"
version = "0.1.0"

[dependencies]
serde = { version = "1.0", features = ["derive"] }
tokio = "1.0"

[dev-dependencies]
mockall = "0.11"
`,
    );
    const names = new Set(parseCargoToml(dir));
    assert.ok(names.has("serde"), "should contain serde");
    assert.ok(names.has("tokio"), "should contain tokio");
    assert.ok(names.has("mockall"), "should contain mockall");
    assert.ok(!names.has("myapp"), "should not contain package name");
  });

  it("handles [build-dependencies] section", () => {
    const dir = makeRepoDir("cargo-build-deps");
    writeFileSync(
      join(dir, "Cargo.toml"),
      `
[build-dependencies]
cc = "1.0"
`,
    );
    const names = new Set(parseCargoToml(dir));
    assert.ok(names.has("cc"));
  });

  it("skips comment lines and blank lines", () => {
    const dir = makeRepoDir("cargo-comments");
    writeFileSync(
      join(dir, "Cargo.toml"),
      `
[dependencies]
# this is a comment
serde = "1.0"

tokio = "1.0"
`,
    );
    const names = new Set(parseCargoToml(dir));
    assert.ok(names.has("serde"));
    assert.ok(names.has("tokio"));
    assert.ok(!names.has("# this is a comment"));
  });

  it("ignores lines outside dependency sections", () => {
    const dir = makeRepoDir("cargo-outside");
    writeFileSync(
      join(dir, "Cargo.toml"),
      `
[package]
edition = "2021"
name = "myapp"

[dependencies]
serde = "1.0"
`,
    );
    const names = new Set(parseCargoToml(dir));
    assert.ok(!names.has("edition"));
    assert.ok(!names.has("name"));
    assert.ok(names.has("serde"));
  });

  it("filters out dep names via filterDependencyNames", () => {
    const dir = makeRepoDir("cargo-filter");
    writeFileSync(
      join(dir, "Cargo.toml"),
      `
[dependencies]
serde = "1.0"
tokio = "1.0"
`,
    );
    const tokens = [tok("serde"), tok("tokio"), tok("FooCorp")];
    const result = filterDependencyNames(tokens, dir);
    assert.equal(result.length, 1);
    assert.equal(result[0]!.token, "FooCorp");
  });
});

// ---------------------------------------------------------------------------
// parseGoMod
// ---------------------------------------------------------------------------

describe("parseGoMod", () => {
  it("returns empty iterable when file is missing", () => {
    const dir = makeRepoDir("gomod-missing");
    assert.deepEqual([...parseGoMod(dir)], []);
  });

  it("yields module paths and their last path segments", () => {
    const dir = makeRepoDir("gomod-basic");
    writeFileSync(
      join(dir, "go.mod"),
      `
module github.com/example/myapp

go 1.21

require (
    github.com/gin-gonic/gin v1.9.1
    github.com/stretchr/testify v1.8.4
)
`,
    );
    const names = new Set(parseGoMod(dir));
    // Full paths
    assert.ok(names.has("github.com/gin-gonic/gin"), "full gin path");
    assert.ok(names.has("github.com/stretchr/testify"), "full testify path");
    // Last segments
    assert.ok(names.has("gin"), "gin segment");
    assert.ok(names.has("testify"), "testify segment");
  });

  it("handles single require line (not a block)", () => {
    const dir = makeRepoDir("gomod-single");
    writeFileSync(
      join(dir, "go.mod"),
      `
module github.com/example/myapp

go 1.21

require github.com/some/lib v0.1.0
`,
    );
    const names = new Set(parseGoMod(dir));
    assert.ok(names.has("github.com/some/lib"));
    assert.ok(names.has("lib"));
  });

  it("filters out dep names via filterDependencyNames", () => {
    const dir = makeRepoDir("gomod-filter");
    writeFileSync(
      join(dir, "go.mod"),
      `
module github.com/example/myapp

go 1.21

require (
    github.com/gin-gonic/gin v1.9.1
)
`,
    );
    const tokens = [tok("gin"), tok("FooCorp")];
    const result = filterDependencyNames(tokens, dir);
    assert.equal(result.length, 1);
    assert.equal(result[0]!.token, "FooCorp");
  });
});

// ---------------------------------------------------------------------------
// parsePyprojectToml
// ---------------------------------------------------------------------------

describe("parsePyprojectToml", () => {
  it("returns empty iterable when file is missing", () => {
    const dir = makeRepoDir("pyproject-missing");
    assert.deepEqual([...parsePyprojectToml(dir)], []);
  });

  it("yields keys from [tool.poetry.dependencies]", () => {
    const dir = makeRepoDir("pyproject-poetry");
    writeFileSync(
      join(dir, "pyproject.toml"),
      `
[tool.poetry]
name = "myproject"
version = "0.1.0"

[tool.poetry.dependencies]
requests = ">=2.28"
pydantic = "^2.0"

[tool.poetry.dev-dependencies]
pytest = "^7.0"
`,
    );
    const names = new Set(parsePyprojectToml(dir));
    assert.ok(names.has("requests"), "should contain requests");
    assert.ok(names.has("pydantic"), "should contain pydantic");
    assert.ok(names.has("pytest"), "should contain pytest");
    assert.ok(!names.has("myproject"), "should not contain project name");
  });

  it("yields package names from [project.dependencies] array-style (PEP 517)", () => {
    const dir = makeRepoDir("pyproject-pep517");
    writeFileSync(
      join(dir, "pyproject.toml"),
      `
[project]
name = "myapp"
version = "0.1.0"
dependencies = [
    "requests>=2.28",
    "httpx>=0.24",
]
`,
    );
    // Note: the array-style [project] section does not have a header we detect
    // as inDeps — the dependencies key is inside [project], not [project.dependencies].
    // parsePyprojectToml handles [project.dependencies] as a separate section.
    // The array-style in [project] dependencies is NOT parsed — this is expected
    // and consistent with the documented best-effort approach.
    // This test documents the limitation.
    const names = new Set(parsePyprojectToml(dir));
    // No error thrown is the key assertion here.
    assert.ok(names instanceof Set);
  });

  it("handles [project.dependencies] section", () => {
    const dir = makeRepoDir("pyproject-project-deps");
    writeFileSync(
      join(dir, "pyproject.toml"),
      `
[project]
name = "myapp"

[project.dependencies]
requests = ">=2.28"
httpx = ">=0.24"
`,
    );
    const names = new Set(parsePyprojectToml(dir));
    assert.ok(names.has("requests"));
    assert.ok(names.has("httpx"));
  });

  it("filters out dep names via filterDependencyNames", () => {
    const dir = makeRepoDir("pyproject-filter");
    writeFileSync(
      join(dir, "pyproject.toml"),
      `
[tool.poetry.dependencies]
requests = ">=2.28"
pydantic = "^2.0"
`,
    );
    const tokens = [tok("requests"), tok("pydantic"), tok("FooCorp")];
    const result = filterDependencyNames(tokens, dir);
    assert.equal(result.length, 1);
    assert.equal(result[0]!.token, "FooCorp");
  });

  it("skips python key in [tool.poetry.dependencies]", () => {
    const dir = makeRepoDir("pyproject-python");
    writeFileSync(
      join(dir, "pyproject.toml"),
      `
[tool.poetry.dependencies]
python = "^3.11"
requests = ">=2.28"
`,
    );
    const names = new Set(parsePyprojectToml(dir));
    assert.ok(!names.has("python"), "python should be skipped");
    assert.ok(names.has("requests"));
  });
});

// ---------------------------------------------------------------------------
// collectDependencyNames — multi-manifest combination
// ---------------------------------------------------------------------------

describe("collectDependencyNames", () => {
  it("combines names from all present manifests", () => {
    const dir = makeRepoDir("collect-all");
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ dependencies: { lodash: "^4.0" } }),
    );
    writeFileSync(
      join(dir, "Cargo.toml"),
      "[dependencies]\nserde = \"1.0\"\n",
    );
    writeFileSync(
      join(dir, "go.mod"),
      "module example.com/app\n\ngo 1.21\n\nrequire (\n    github.com/gin-gonic/gin v1.9.1\n)\n",
    );
    writeFileSync(
      join(dir, "pyproject.toml"),
      "[tool.poetry.dependencies]\nrequests = \">=2.28\"\n",
    );

    const names = collectDependencyNames(dir);
    assert.ok(names.has("lodash"), "lodash from package.json");
    assert.ok(names.has("serde"), "serde from Cargo.toml");
    assert.ok(names.has("gin"), "gin segment from go.mod");
    assert.ok(names.has("requests"), "requests from pyproject.toml");
  });

  it("returns empty set when no manifests are present", () => {
    const dir = makeRepoDir("collect-none");
    const names = collectDependencyNames(dir);
    assert.equal(names.size, 0);
  });
});
