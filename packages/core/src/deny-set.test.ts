// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  computeDenySet,
  ALWAYS_FILE_STEM,
  MIN_AUTO_BLOCK_IDENTIFIER_LENGTH,
} from "./deny-set.js";
import { scanText } from "./scan.js";
import type { RepoConfig, RepoClass } from "./repo.js";

let tmp: string;
let markersDir: string;

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
  setupMarkers();
});

after(() => {
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
    assert.equal(cached.schemaVersion, 2);
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
