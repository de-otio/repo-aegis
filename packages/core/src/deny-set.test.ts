import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeDenySet, ALWAYS_FILE_STEM } from "./deny-set.js";
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
});
