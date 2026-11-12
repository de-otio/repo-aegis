// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, closeSync, fstatSync, mkdtempSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  destinationCachePath,
  destinationKey,
  describeWorkingTree,
  lookupDestination,
  isFreshCheck,
  readDestinationCache,
  recordWorkingTree,
  resolveCachedDestination,
} from "./destination-cache.js";

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: ["ignore", "ignore", "ignore"] });
}

describe("destination cache", () => {
  let root: string;
  let home: string;
  let cache: string;
  let pub: string;
  let bare: string;
  let noRemote: string;

  before(() => {
    root = mkdtempSync(join(tmpdir(), "destination-cache-"));
    home = join(root, "home");
    cache = destinationCachePath(home);
    pub = join(root, "pub");
    bare = join(root, "bare");
    noRemote = join(root, "no-remote");
    for (const d of [pub, bare, noRemote]) {
      mkdirSync(d);
      git(d, ["init", "-q"]);
    }
    git(pub, ["remote", "add", "origin", "git@github.com:Acme/Svc.git"]);
    git(pub, ["config", "repo-aegis.class", "public-eligible"]);
    git(pub, ["config", "repo-aegis.visibility", "public"]);
    git(bare, ["remote", "add", "origin", "https://github.com/acme/undeclared.git"]);
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("the path is <home>/destinations.json; keys are lower-cased org/repo", () => {
    assert.equal(cache, join(home, "destinations.json"));
    assert.equal(destinationKey("Acme", "Svc"), "acme/svc");
  });

  it("a missing cache reads as empty; a lookup misses", () => {
    assert.deepEqual(readDestinationCache(cache), { version: 1, repos: {} });
    assert.equal(lookupDestination("acme", "svc", cache), null);
  });

  it("describeWorkingTree reads origin, class and cached visibility; null without a GitHub origin", () => {
    assert.deepEqual(describeWorkingTree(pub), {
      key: "acme/svc",
      entry: { class: "public-eligible", classExplicit: true, visibility: "public", workingTree: pub },
    });
    assert.equal(describeWorkingTree(noRemote), null);
  });

  it("recordWorkingTree creates the file (0600, atomically) and the entry is found by any casing", () => {
    const now = () => new Date("2026-09-12T16:00:00.000Z");
    assert.equal(recordWorkingTree(pub, cache, now), "acme/svc");
    // Mode and content through ONE descriptor: a stat-by-path followed by a
    // read-by-path is the check-then-use shape CodeQL flags (js/file-system-race).
    const fd = openSync(cache, "r");
    try {
      assert.equal(fstatSync(fd).mode & 0o777, 0o600);
      assert.equal(readFileSync(fd, "utf8").includes('"acme/svc"'), true);
    } finally {
      closeSync(fd);
    }
    assert.deepEqual(lookupDestination("ACME", "SVC", cache), {
      class: "public-eligible",
      classExplicit: true,
      visibility: "public",
      workingTree: pub,
      checkedAt: "2026-09-12T16:00:00.000Z",
    });
  });

  it("a write that fails (a denied target, or a read-only directory) returns null, never throws, and leaves no temp file", () => {
    // The sandbox-style refusal: `install claude-md` denies agent writes to this file.
    // (1) The target cannot be replaced: a non-empty directory sits there, so the rename fails
    //     AFTER the temp file was written.
    const deniedHome = join(root, "denied-home");
    const deniedCache = destinationCachePath(deniedHome);
    mkdirSync(join(deniedCache, "keep"), { recursive: true });
    assert.equal(recordWorkingTree(pub, deniedCache), null);
    assert.deepEqual(readdirSync(deniedHome).filter(f => f.endsWith(".tmp")), [], "a failed rename must not litter");

    // (2) The directory itself is read-only (EACCES on creating the temp file).
    if (typeof process.getuid === "function" && process.getuid() !== 0) {
      const roHome = join(root, "ro-home");
      mkdirSync(roHome, { recursive: true });
      chmodSync(roHome, 0o500);
      try {
        assert.equal(recordWorkingTree(pub, destinationCachePath(roHome)), null);
      } finally {
        chmodSync(roHome, 0o700);
      }
    }
  });

  it("recording a second checkout keeps the first", () => {
    assert.equal(recordWorkingTree(bare, cache), "acme/undeclared");
    assert.notEqual(lookupDestination("acme", "svc", cache), null);
    assert.notEqual(lookupDestination("acme", "undeclared", cache), null);
  });

  it("a tree with no GitHub origin is not recorded and returns null", () => {
    assert.equal(recordWorkingTree(noRemote, cache), null);
  });

  it("resolveCachedDestination prefers the live config over the snapshot", () => {
    git(pub, ["config", "repo-aegis.visibility", "private"]);
    const r = resolveCachedDestination("acme", "svc", cache);
    assert.equal(r?.live, true);
    assert.equal(r?.visibility, "private"); // the snapshot still says public
    assert.equal(lookupDestination("acme", "svc", cache)?.visibility, "public");
    git(pub, ["config", "repo-aegis.visibility", "public"]);
  });

  it("resolveCachedDestination falls back to the snapshot when the tree is gone", () => {
    const gone = join(root, "gone");
    mkdirSync(gone);
    git(gone, ["init", "-q"]);
    git(gone, ["remote", "add", "origin", "git@github.com:acme/gone.git"]);
    git(gone, ["config", "repo-aegis.class", "private-strict"]);
    git(gone, ["config", "repo-aegis.visibility", "private"]);
    assert.equal(recordWorkingTree(gone, cache), "acme/gone");
    rmSync(gone, { recursive: true, force: true });
    const r = resolveCachedDestination("acme", "gone", cache);
    assert.equal(r?.live, false);
    assert.equal(r?.class, "private-strict");
    assert.equal(r?.visibility, "private");
  });

  it("an entry that declares nothing is not knowledge → null", () => {
    assert.notEqual(lookupDestination("acme", "undeclared", cache), null);
    assert.equal(resolveCachedDestination("acme", "undeclared", cache), null);
  });

  it("a malformed file reads as empty; malformed entries are dropped individually", () => {
    const bad = join(root, "bad.json");
    writeFileSync(bad, "{not json");
    assert.deepEqual(readDestinationCache(bad), { version: 1, repos: {} });
    writeFileSync(
      bad,
      JSON.stringify({
        version: 1,
        repos: {
          "acme/ok": { class: "private-strict", classExplicit: true, visibility: "private", workingTree: "/x", checkedAt: "t" },
          "acme/bad-class": { class: "nope", classExplicit: true, visibility: "private", workingTree: "/x", checkedAt: "t" },
          "acme/bad-vis": { class: "private-strict", classExplicit: true, visibility: "hidden", workingTree: "/x", checkedAt: "t" },
          "acme/no-tree": { class: "private-strict", classExplicit: true, visibility: "private", checkedAt: "t" },
        },
      }),
    );
    assert.deepEqual(Object.keys(readDestinationCache(bad).repos), ["acme/ok"]);
    // A pointer to a vanished tree still answers from its snapshot.
    assert.equal(resolveCachedDestination("acme", "ok", bad)?.live, false);
  });

  it("a write failure is silent", () => {
    assert.equal(recordWorkingTree(pub, join(noRemote, ".git", "HEAD", "impossible.json")), null);
  });
});

describe("destination cache — a pointer is only knowledge while the tree is still that repository", () => {
  let root: string;
  let cache: string;

  before(() => {
    root = mkdtempSync(join(tmpdir(), "destination-cache-origin-"));
    cache = destinationCachePath(join(root, "home"));
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function checkout(name: string, origin: string): string {
    const dir = join(root, name);
    mkdirSync(dir);
    git(dir, ["init", "-q"]);
    git(dir, ["remote", "add", "origin", origin]);
    git(dir, ["config", "repo-aegis.class", "private-strict"]);
    git(dir, ["config", "repo-aegis.visibility", "private"]);
    return dir;
  }

  it("a tree whose origin still matches resolves live", () => {
    const dir = checkout("same", "git@github.com:acme/same.git");
    recordWorkingTree(dir, cache);
    assert.equal(resolveCachedDestination("acme", "same", cache)?.live, true);
  });

  it("a tree re-pointed at another repository resolves to nothing, not to the other repo's visibility", () => {
    const dir = checkout("moved", "git@github.com:acme/template.git");
    recordWorkingTree(dir, cache);
    git(dir, ["remote", "set-url", "origin", "git@github.com:acme/private-project.git"]);
    assert.equal(resolveCachedDestination("acme", "template", cache), null);
  });

  it("a tree that lost its origin resolves to nothing", () => {
    const dir = checkout("headless", "git@github.com:acme/headless.git");
    recordWorkingTree(dir, cache);
    git(dir, ["remote", "remove", "origin"]);
    assert.equal(resolveCachedDestination("acme", "headless", cache), null);
  });

  it("isFreshCheck: recent and slightly-future stamps are fresh; old, far-future and unparseable are not", () => {
    const now = () => new Date("2026-11-12T12:00:00.000Z");
    const at = (iso: string) => ({ checkedAt: iso });
    assert.equal(isFreshCheck(at("2026-11-12T11:00:00.000Z"), now), true);
    assert.equal(isFreshCheck(at("2026-11-05T12:00:01.000Z"), now), true); // just under 7 days
    assert.equal(isFreshCheck(at("2026-11-05T11:59:59.000Z"), now), false); // just over
    assert.equal(isFreshCheck(at("2026-11-12T12:03:00.000Z"), now), true); // small skew
    assert.equal(isFreshCheck(at("2026-11-13T12:00:00.000Z"), now), false); // a day ahead
    assert.equal(isFreshCheck(at("not a date"), now), false);
  });
});
