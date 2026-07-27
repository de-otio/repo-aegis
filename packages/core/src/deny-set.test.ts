// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  computeDenySet,
  loadExemptPaths,
  BUILTIN_ALWAYS_BLOCK_EXEMPT_PATHS,
  ALWAYS_FILE_STEM,
  PRIVATE_INFRA_FILE_STEM,
  MIN_AUTO_BLOCK_IDENTIFIER_LENGTH,
} from "./deny-set.js";
import { GlobTooBroadError } from "./globs.js";
import { scanText } from "./scan.js";
import type { RepoConfig, RepoClass } from "./repo.js";

let tmp: string;
let markersDir: string;
let priorHome: string | undefined;

function setupMarkers() {
  rmSync(markersDir, { recursive: true, force: true });
  mkdirSync(markersDir, { recursive: true });
  writeFileSync(join(markersDir, `${ALWAYS_FILE_STEM}.txt`), "PROJECT-CODENAME-ALPHA\n");
  writeFileSync(join(markersDir, "customer-a.txt"), "acme-corp\nacme\\.com\n");
  writeFileSync(join(markersDir, "customer-b.txt"), "betaco\nbetaco\\.tech\n");
}

function makeRepo(cls: RepoClass, engagements: string[] = []): RepoConfig {
  return {
    cwd: "/tmp/fake",
    isGitRepo: true,
    class: cls,
    classExplicit: true,
    engagements,
  };
}

before(() => {
  tmp = mkdtempSync(join(tmpdir(), "repo-aegis-denyset-"));
  markersDir = join(tmp, "markers");
  // computeDenySet now consults the registry (for `alwaysBlockExemptPaths`)
  // and, for calls that don't pass `cachePath`, the default cache location.
  // Point REPO_AEGIS_HOME at the temp dir so neither ever reaches the
  // developer's real `~/.config/repo-aegis`.
  priorHome = process.env["REPO_AEGIS_HOME"];
  process.env["REPO_AEGIS_HOME"] = tmp;
  setupMarkers();
});

after(() => {
  if (priorHome === undefined) delete process.env["REPO_AEGIS_HOME"];
  else process.env["REPO_AEGIS_HOME"] = priorHome;
  rmSync(tmp, { recursive: true, force: true });
});

describe("computeDenySet", () => {
  it("returns empty set when markers dir does not exist", () => {
    const ds = computeDenySet(makeRepo("private-strict"), { markersDir: join(tmp, "no-such-dir") });
    assert.equal(ds.patterns.length, 0);
    assert.equal(ds.combinedRegex, "");
  });

  it("public-eligible: full union (all marker files, no scoping)", () => {
    const ds = computeDenySet(makeRepo("public-eligible"), { markersDir });
    assert.equal(ds.files.length, 3);
    assert.ok(ds.patterns.includes("acme-corp"));
    assert.ok(ds.patterns.includes("betaco"));
    assert.ok(ds.patterns.includes("PROJECT-CODENAME-ALPHA"));
  });

  it("private-strict: same as public-eligible", () => {
    const ds = computeDenySet(makeRepo("private-strict"), { markersDir });
    assert.equal(ds.files.length, 3);
  });

  it("public-eligible warns if engagement is set", () => {
    const ds = computeDenySet(
      makeRepo("public-eligible", ["customer-a"]),
      { markersDir },
    );
    assert.ok(ds.warnings.length > 0);
    // engagement is ignored: full deny set
    assert.equal(ds.files.length, 3);
    assert.ok(ds.patterns.includes("acme-corp"));
  });

  it("customer-coupled: scopes deny set, excluding own engagement", () => {
    const ds = computeDenySet(
      makeRepo("customer-coupled", ["customer-a"]),
      { markersDir },
    );
    const stems = ds.files.map(f => f.stem).sort();
    assert.deepEqual(stems, [ALWAYS_FILE_STEM, "customer-b"]);
    assert.ok(ds.patterns.includes("betaco"));
    assert.ok(ds.patterns.includes("PROJECT-CODENAME-ALPHA"));
    assert.ok(!ds.patterns.includes("acme-corp"));
  });

  it("customer-coupled: still blocks _always", () => {
    const ds = computeDenySet(
      makeRepo("customer-coupled", ["customer-a"]),
      { markersDir },
    );
    assert.ok(ds.patterns.includes("PROJECT-CODENAME-ALPHA"));
  });

  it("customer-coupled: multi-engagement excludes both own files", () => {
    const ds = computeDenySet(
      makeRepo("customer-coupled", ["customer-a", "customer-b"]),
      { markersDir },
    );
    const stems = ds.files.map(f => f.stem).sort();
    assert.deepEqual(stems, [ALWAYS_FILE_STEM]);
    assert.ok(!ds.patterns.includes("acme-corp"));
    assert.ok(!ds.patterns.includes("betaco"));
  });

  it("customer-coupled: empty engagements still computes deny set (caller enforces error)", () => {
    const ds = computeDenySet(makeRepo("customer-coupled", []), { markersDir });
    // Library doesn't enforce the error; that's the CLI's job. Library returns full set.
    assert.equal(ds.files.length, 3);
  });

  it("scratch: same scoping as customer-coupled", () => {
    const ds = computeDenySet(
      makeRepo("scratch", ["customer-a"]),
      { markersDir },
    );
    assert.equal(ds.files.length, 2);
  });

  it("strips ; comments and blank lines from marker files", () => {
    writeFileSync(
      join(markersDir, "customer-c.txt"),
      "; comment line\n\nfirst-pattern\n; another comment\nsecond-pattern\n",
    );
    const ds = computeDenySet(makeRepo("private-strict"), { markersDir });
    assert.ok(ds.patterns.includes("first-pattern"));
    assert.ok(ds.patterns.includes("second-pattern"));
    assert.ok(!ds.patterns.some(p => p.includes("comment")));
    // restore
    rmSync(join(markersDir, "customer-c.txt"));
  });

  it("writes a cache file with the expected shape on miss", () => {
    const cachePath = join(tmp, "cache-shape.json");
    const repo = makeRepo("private-strict");
    const ds = computeDenySet(repo, { markersDir, cachePath });
    assert.ok(existsSync(cachePath), "cache file written");
    const cached = JSON.parse(readFileSync(cachePath, "utf8")) as {
      schemaVersion: number;
      key: string;
      files: unknown[];
      patterns: string[];
      combinedRegex: string;
    };
    // Bumped to 5 alongside the strict/exemptible regex split; a stale 0.6.x
    // cache must be rejected or the split would be missing from every warm
    // machine and path exemptions would silently never engage.
    assert.equal(cached.schemaVersion, 5);
    assert.equal(typeof cached.key, "string");
    assert.equal(cached.key.length, 64, "fingerprint is sha256 hex");
    assert.deepEqual(cached.patterns, ds.patterns);
    assert.equal(cached.combinedRegex, ds.combinedRegex);
  });

  it("invalidates cache when a marker file changes (mtime updated)", () => {
    const cachePath = join(tmp, "cache-invalidate.json");
    const repo = makeRepo("private-strict");
    const ds1 = computeDenySet(repo, { markersDir, cachePath });

    // Change a marker file with a NEW mtime + different size.
    const acmePath = join(markersDir, "customer-a.txt");
    writeFileSync(acmePath, "completely-different-content\n");

    const ds2 = computeDenySet(repo, { markersDir, cachePath });
    assert.notDeepEqual(ds2.patterns, ds1.patterns, "cache must invalidate on marker change");
    assert.ok(ds2.patterns.includes("completely-different-content"));

    // Restore for downstream tests.
    setupMarkers();
  });

  it("cachePath: null disables caching", () => {
    const repo = makeRepo("private-strict");
    const initialFiles = readdirSync(tmp).filter(f => f.endsWith(".json")).length;
    computeDenySet(repo, { markersDir, cachePath: null });
    const after = readdirSync(tmp).filter(f => f.endsWith(".json")).length;
    assert.equal(after, initialFiles, "no cache file should be written");
  });

  it("populates patternSources parallel to patterns", () => {
    const repo = makeRepo("private-strict");
    const ds = computeDenySet(repo, { markersDir, cachePath: null });
    assert.equal(ds.patternSources?.length, ds.patterns.length, "lengths must match");
    // Spot-check: alphabetical file order is _always, customer-a, customer-b
    const alwaysIdx = ds.patterns.findIndex(p => p === "PROJECT-CODENAME-ALPHA");
    if (alwaysIdx >= 0) {
      assert.equal(ds.patternSources![alwaysIdx], "_always");
    }
    const acmeIdx = ds.patterns.findIndex(p => p === "acme-corp");
    if (acmeIdx >= 0) {
      assert.equal(ds.patternSources![acmeIdx], "customer-a");
    }
  });

  describe("auto-block engagement identifiers (self-marker)", () => {
    it("blocks each engagement's own id, not just its marker-file contents", () => {
      const ds = computeDenySet(makeRepo("private-strict"), { markersDir, cachePath: null });
      assert.ok(ds.patterns.includes("customer-a"), "engagement id is auto-blocked");
      assert.ok(ds.patterns.includes("customer-b"), "engagement id is auto-blocked");
      // The id pattern is attributed to its own engagement.
      const idx = ds.patterns.indexOf("customer-a");
      assert.equal(ds.patternSources?.[idx], "customer-a");
    });

    it("a ZERO-marker engagement still blocks its own identifier (the close-call fix)", () => {
      // An engagement registered with no markers materialises an empty (header-
      // only) marker file. Before the fix it contributed nothing — so the
      // customer-derived id leaked freely. It must now block its own id.
      writeFileSync(join(markersDir, "zero-marker-customer.txt"), "; no markers populated yet\n");
      try {
        const ds = computeDenySet(makeRepo("private-strict"), { markersDir, cachePath: null });
        assert.ok(
          ds.patterns.includes("zero-marker-customer"),
          "zero-marker engagement must still block its identifier",
        );
        // And it actually matches content (case-insensitively), end to end.
        const hits = scanText("see ~/repos/Zero-Marker-Customer/notes.md", ds);
        assert.equal(hits.length, 1, "identifier match fires case-insensitively");
        assert.equal(hits[0]?.engagement, "zero-marker-customer");
      } finally {
        rmSync(join(markersDir, "zero-marker-customer.txt"));
      }
    });

    it("does NOT auto-block the _always system stem", () => {
      const ds = computeDenySet(makeRepo("private-strict"), { markersDir, cachePath: null });
      assert.ok(!ds.patterns.includes(ALWAYS_FILE_STEM), "_always is not an identifier");
    });

    it("escapes regex-special characters in the identifier", () => {
      // A stem with regex metacharacters must be matched literally, not as a
      // pattern (e.g. `a.b+c` must not also match `axbcc`).
      writeFileSync(join(markersDir, "a.b+c.txt"), "; empty\n");
      try {
        const ds = computeDenySet(makeRepo("private-strict"), { markersDir, cachePath: null });
        assert.ok(ds.patterns.includes("a\\.b\\+c"), "special chars are escaped");
        assert.equal(scanText("literal a.b+c here", ds).length, 1, "matches the literal");
        assert.equal(scanText("regex axbcc here", ds).length, 0, "does not match as a regex");
      } finally {
        rmSync(join(markersDir, "a.b+c.txt"));
      }
    });

    it("skips identifiers shorter than the guard (false-positive safety)", () => {
      assert.ok(MIN_AUTO_BLOCK_IDENTIFIER_LENGTH >= 3);
      writeFileSync(join(markersDir, "qa.txt"), "; empty\n");
      try {
        const ds = computeDenySet(makeRepo("private-strict"), { markersDir, cachePath: null });
        assert.ok(!ds.patterns.includes("qa"), "too-short id is not auto-blocked");
      } finally {
        rmSync(join(markersDir, "qa.txt"));
      }
    });

    it("ignores a stale-schema cache so the auto-block takes effect on upgrade", () => {
      // A pre-0.4 cache has the old schemaVersion and patterns WITHOUT the
      // engagement identifiers (and the same fingerprint key, since no marker
      // file changed). computeDenySet must ignore it and recompute, or the fix
      // would be silently inert on machines with a warm cache.
      const cachePath = join(tmp, "cache-stale-schema.json");
      writeFileSync(
        cachePath,
        JSON.stringify({
          schemaVersion: 2,
          key: "stale-but-shaped-key",
          files: [],
          patterns: ["acme-corp"],
          patternSources: ["customer-a"],
          combinedRegex: "acme-corp",
          warnings: [],
        }),
      );
      const ds = computeDenySet(makeRepo("private-strict"), { markersDir, cachePath });
      assert.ok(
        ds.patterns.includes("customer-a"),
        "stale-schema cache must be ignored; identifier auto-blocked after recompute",
      );
      rmSync(cachePath, { force: true });
    });

    it("customer-coupled: blocks OTHER engagement ids but not the repo's own", () => {
      const ds = computeDenySet(makeRepo("customer-coupled", ["customer-a"]), {
        markersDir,
        cachePath: null,
      });
      assert.ok(!ds.patterns.includes("customer-a"), "own id is not blocked (file excluded)");
      assert.ok(ds.patterns.includes("customer-b"), "other engagement id is blocked");
    });
  });

  it("preserves mid-line ; characters in marker patterns", () => {
    // Regression: legitimate patterns containing `;` (e.g. `db;internal`,
    // `key;value` form codenames) used to be silently truncated at the
    // first `;`. Only lines whose first non-whitespace character is `;`
    // are comments.
    writeFileSync(
      join(markersDir, "customer-d.txt"),
      "db;internal\nkey;val;more\n  ; leading-space-comment\n",
    );
    const ds = computeDenySet(makeRepo("private-strict"), { markersDir });
    assert.ok(ds.patterns.includes("db;internal"), "mid-line ; must not truncate");
    assert.ok(ds.patterns.includes("key;val;more"), "multiple mid-line ; must survive");
    assert.ok(
      !ds.patterns.some(p => p.includes("leading-space-comment")),
      "leading-whitespace ; lines are still comments",
    );
    rmSync(join(markersDir, "customer-d.txt"));
  });
});

// ---------------------------------------------------------------------------
// `_private_infra`: the one class-gated marker file.
// ---------------------------------------------------------------------------

describe("computeDenySet — _private_infra gating", () => {
  const INFRA = "npm\\.internal\\.example\\.com";

  function withInfra(): void {
    writeFileSync(join(markersDir, `${PRIVATE_INFRA_FILE_STEM}.txt`), `${INFRA}\n`);
  }

  it("includes private-infra patterns when the repo is public-facing", () => {
    withInfra();
    const ds = computeDenySet(makeRepo("public-eligible"), {
      markersDir,
      cachePath: null,
      publicFacing: true,
    });
    assert.ok(ds.patterns.includes(INFRA), "private-infra pattern must be active");
    assert.ok(ds.files.some(f => f.stem === PRIVATE_INFRA_FILE_STEM));
  });

  it("EXCLUDES them in a non-public repo, where such hosts are legitimate", () => {
    withInfra();
    const ds = computeDenySet(makeRepo("private-strict"), {
      markersDir,
      cachePath: null,
      publicFacing: false,
    });
    assert.ok(!ds.patterns.includes(INFRA), "must not fire in a private repo");
    assert.ok(!ds.files.some(f => f.stem === PRIVATE_INFRA_FILE_STEM));
    // The rest of the deny set is unaffected by the gate.
    assert.ok(ds.patterns.includes("PROJECT-CODENAME-ALPHA"));
  });

  it("keeps the gate out of a customer-coupled repo too", () => {
    withInfra();
    const ds = computeDenySet(makeRepo("customer-coupled", ["customer-a"]), {
      markersDir,
      cachePath: null,
      publicFacing: false,
    });
    assert.ok(!ds.patterns.includes(INFRA));
  });

  it("never auto-blocks the reserved stem as a literal identifier", () => {
    withInfra();
    const ds = computeDenySet(makeRepo("public-eligible"), {
      markersDir,
      cachePath: null,
      publicFacing: true,
    });
    // `_always` is likewise excluded; neither system stem is an engagement id.
    assert.ok(!ds.patterns.includes(PRIVATE_INFRA_FILE_STEM));
    assert.ok(!ds.patterns.includes(ALWAYS_FILE_STEM));
  });

  it("does not serve a stale cached set when public-facing flips", () => {
    withInfra();
    const cachePath = join(tmp, "gate-cache.json");
    const repo = makeRepo("private-strict");
    const priv = computeDenySet(repo, { markersDir, cachePath, publicFacing: false });
    assert.ok(!priv.patterns.includes(INFRA));
    // Same repo, same marker files — only the visibility changed. Were
    // publicFacing absent from the fingerprint, this would hit the stale entry
    // and silently under-block a now-public repo.
    const pub = computeDenySet(repo, { markersDir, cachePath, publicFacing: true });
    assert.ok(pub.patterns.includes(INFRA), "cache must not mask the flip to public");
  });
});

// ---------------------------------------------------------------------------
// Path-scoped exemptions, `_always` class only (plan item B).
//
// The asymmetry under test: `_always` patterns are secret *shapes* with a
// well-known benign home (a throwaway keypair under `test/`), so they may be
// skipped there. Customer-marker literals and `_private_infra` hosts have no
// benign home — one in a test fixture is still a leak — so they never are.
// ---------------------------------------------------------------------------

describe("computeDenySet — `_always`-only path exemptions", () => {
  // Never a literal secret in this repo's own source: the tree scans itself.
  const DASHES = "-".repeat(5);
  const PEM_PATTERN = `${DASHES}BEGIN [A-Z ]+PRIVATE KEY${DASHES}`;
  const INFRA_PATTERN = "registry\\.internal\\.invalid";

  function markersWithClasses(dir: string): void {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${ALWAYS_FILE_STEM}.txt`), `${PEM_PATTERN}\n`);
    writeFileSync(join(dir, `${PRIVATE_INFRA_FILE_STEM}.txt`), `${INFRA_PATTERN}\n`);
    writeFileSync(join(dir, "customer-z.txt"), "zetaquadrant\n");
  }

  /** Minimal valid registry, optionally declaring the exempt-path key. */
  function writeRegistry(home: string, exempt?: string[]): void {
    mkdirSync(home, { recursive: true });
    const lines = ["schemaVersion: 2", "engagements: []"];
    if (exempt !== undefined) {
      // Flow style for the empty case: a bare `key:` with no items parses as
      // null, not as an empty list, and would be a schema error rather than
      // the "exempt nothing" the test means.
      if (exempt.length === 0) lines.push("alwaysBlockExemptPaths: []");
      else {
        lines.push("alwaysBlockExemptPaths:");
        for (const g of exempt) lines.push(`  - ${JSON.stringify(g)}`);
      }
    }
    writeFileSync(join(home, "engagements.yaml"), lines.join("\n") + "\n");
  }

  let classDir: string;
  let home: string;

  before(() => {
    classDir = join(tmp, "class-markers");
    markersWithClasses(classDir);
    home = join(tmp, "exempt-home");
    mkdirSync(home, { recursive: true });
  });

  it("splits the deny set by class without disturbing combinedRegex", () => {
    const ds = computeDenySet(makeRepo("public-eligible"), {
      markersDir: classDir,
      cachePath: null,
      publicFacing: true,
      exemptPaths: ["**/test/**"],
    });

    assert.ok(ds.exemptibleRegex!.includes("PRIVATE KEY"), "_always joins exemptibleRegex");
    assert.ok(
      !ds.strictRegex!.includes("PRIVATE KEY"),
      "_always must NOT be in strictRegex",
    );
    assert.ok(ds.strictRegex!.includes("zetaquadrant"), "engagement marker is strict");
    assert.ok(
      ds.strictRegex!.includes("registry"),
      "_private_infra is strict, NOT exemptible — a private host in a fixture is still a leak",
    );
    assert.ok(!ds.exemptibleRegex!.includes("registry"));

    // combinedRegex is the untouched union: other callers depend on it.
    for (const p of ds.patterns) {
      assert.ok(ds.combinedRegex.includes(p), `combinedRegex still carries ${p}`);
    }
  });

  it("uses the built-in default list when the registry declares no key", () => {
    writeRegistry(home); // no alwaysBlockExemptPaths
    const ds = computeDenySet(makeRepo("private-strict"), {
      markersDir: classDir,
      cachePath: null,
      publicFacing: false,
      registryPath: join(home, "engagements.yaml"),
    });
    assert.deepEqual(ds.exemptPaths, [...BUILTIN_ALWAYS_BLOCK_EXEMPT_PATHS]);
  });

  it("an explicit empty registry list means NO exemptions (not the default)", () => {
    writeRegistry(home, []);
    const ds = computeDenySet(makeRepo("private-strict"), {
      markersDir: classDir,
      cachePath: null,
      publicFacing: false,
      registryPath: join(home, "engagements.yaml"),
    });
    assert.deepEqual(ds.exemptPaths, [], "absent and empty must not be conflated");
  });

  it("a registry list replaces the built-in default", () => {
    writeRegistry(home, ["**/vendor-fixtures/**"]);
    const ds = computeDenySet(makeRepo("private-strict"), {
      markersDir: classDir,
      cachePath: null,
      publicFacing: false,
      registryPath: join(home, "engagements.yaml"),
    });
    assert.deepEqual(ds.exemptPaths, ["**/vendor-fixtures/**"]);
  });

  it("the per-repo list is ADDITIVE to the registry list, never subtractive", () => {
    writeRegistry(home, ["**/vendor-fixtures/**"]);
    const repo = { ...makeRepo("private-strict"), alwaysBlockExemptPaths: ["**/golden/**"] };
    const ds = computeDenySet(repo, {
      markersDir: classDir,
      cachePath: null,
      publicFacing: false,
      registryPath: join(home, "engagements.yaml"),
    });
    assert.deepEqual(ds.exemptPaths, ["**/vendor-fixtures/**", "**/golden/**"]);
  });

  it("per-repo entries are added on top of the built-in default too", () => {
    writeRegistry(home);
    const repo = { ...makeRepo("private-strict"), alwaysBlockExemptPaths: ["**/golden/**"] };
    const ds = computeDenySet(repo, {
      markersDir: classDir,
      cachePath: null,
      publicFacing: false,
      registryPath: join(home, "engagements.yaml"),
    });
    assert.deepEqual(ds.exemptPaths, [...BUILTIN_ALWAYS_BLOCK_EXEMPT_PATHS, "**/golden/**"]);
  });

  it("a duplicate per-repo entry does not appear twice", () => {
    writeRegistry(home, ["**/golden/**"]);
    const repo = { ...makeRepo("private-strict"), alwaysBlockExemptPaths: ["**/golden/**"] };
    const ds = computeDenySet(repo, {
      markersDir: classDir,
      cachePath: null,
      publicFacing: false,
      registryPath: join(home, "engagements.yaml"),
    });
    assert.deepEqual(ds.exemptPaths, ["**/golden/**"]);
  });

  it("falls back to the built-in default when there is no registry at all", () => {
    const paths = loadExemptPaths(makeRepo("private-strict"), {
      registryPath: join(tmp, "definitely-absent", "engagements.yaml"),
    });
    assert.deepEqual(paths, [...BUILTIN_ALWAYS_BLOCK_EXEMPT_PATHS]);
  });

  describe("a repo-wide glob is a config error, not a preference", () => {
    for (const bad of ["**", "**/*", "*", ""]) {
      it(`rejects ${JSON.stringify(bad)} in the registry`, () => {
        writeRegistry(home, [bad]);
        assert.throws(
          () =>
            computeDenySet(makeRepo("private-strict"), {
              markersDir: classDir,
              cachePath: null,
              publicFacing: false,
              registryPath: join(home, "engagements.yaml"),
            }),
          GlobTooBroadError,
        );
      });

      it(`rejects ${JSON.stringify(bad)} in the per-repo file`, () => {
        writeRegistry(home);
        const repo = { ...makeRepo("private-strict"), alwaysBlockExemptPaths: [bad] };
        assert.throws(
          () =>
            computeDenySet(repo, {
              markersDir: classDir,
              cachePath: null,
              publicFacing: false,
              registryPath: join(home, "engagements.yaml"),
            }),
          GlobTooBroadError,
        );
      });
    }
  });

  it("changing the exempt paths invalidates the cached deny set", () => {
    // The marker files are untouched between the two calls, so a fingerprint
    // that omitted the resolved exempt-path list would serve the first
    // (stale) entry and a registry edit would appear to do nothing.
    const cachePath = join(tmp, "exempt-cache.json");
    rmSync(cachePath, { force: true });
    const repo = makeRepo("private-strict");

    const first = computeDenySet(repo, {
      markersDir: classDir,
      cachePath,
      publicFacing: false,
      exemptPaths: ["**/test/**"],
    });
    assert.deepEqual(first.exemptPaths, ["**/test/**"]);

    const second = computeDenySet(repo, {
      markersDir: classDir,
      cachePath,
      publicFacing: false,
      exemptPaths: ["**/golden/**"],
    });
    assert.deepEqual(
      second.exemptPaths,
      ["**/golden/**"],
      "cache must not mask a change to the exempt-path list",
    );
  });

  it("a cache hit still carries the split and the exempt paths", () => {
    const cachePath = join(tmp, "exempt-cache-hit.json");
    rmSync(cachePath, { force: true });
    const repo = makeRepo("private-strict");
    const opts = {
      markersDir: classDir,
      cachePath,
      publicFacing: false,
      exemptPaths: ["**/test/**"],
    };
    const cold = computeDenySet(repo, opts);
    const warm = computeDenySet(repo, opts);
    assert.equal(warm.strictRegex, cold.strictRegex);
    assert.equal(warm.exemptibleRegex, cold.exemptibleRegex);
    assert.deepEqual(warm.exemptPaths, cold.exemptPaths);
    assert.notEqual(warm.strictRegex, undefined);
  });

  it("a v4-schema cache is rejected so the split takes effect on upgrade", () => {
    const cachePath = join(tmp, "v4-cache.json");
    writeFileSync(
      cachePath,
      JSON.stringify({
        schemaVersion: 4,
        key: "shaped-but-stale",
        files: [],
        patterns: ["zetaquadrant"],
        patternSources: ["customer-z"],
        combinedRegex: "zetaquadrant",
        warnings: [],
      }),
    );
    const ds = computeDenySet(makeRepo("private-strict"), {
      markersDir: classDir,
      cachePath,
      publicFacing: false,
      exemptPaths: ["**/test/**"],
    });
    assert.equal(typeof ds.strictRegex, "string", "recomputed, not served from v4");
    assert.deepEqual(ds.exemptPaths, ["**/test/**"]);
    rmSync(cachePath, { force: true });
  });
});
