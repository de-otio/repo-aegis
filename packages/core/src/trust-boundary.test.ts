// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  computeTrustBoundary,
  trustBoundariesOverlap,
} from "./trust-boundary.js";
import type { Registry, Engagement } from "./registry.js";

let tmp: string;

before(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "repo-aegis-tb-")));
});

after(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function makeRepo(
  name: string,
  opts: { remote?: string; class?: string; engagements?: string[] } = {},
): string {
  const dir = join(tmp, name);
  mkdirSync(dir);
  execFileSync("git", ["init", "-q", "--initial-branch=main", dir], { stdio: "ignore" });
  if (opts.remote) {
    execFileSync("git", ["-C", dir, "config", "remote.origin.url", opts.remote], {
      stdio: "ignore",
    });
  }
  if (opts.class) {
    execFileSync("git", ["-C", dir, "config", "repo-aegis.class", opts.class], {
      stdio: "ignore",
    });
  }
  for (const eng of opts.engagements ?? []) {
    execFileSync("git", ["-C", dir, "config", "--add", "repo-aegis.engagement", eng], {
      stdio: "ignore",
    });
  }
  return dir;
}

function makeRegistry(
  engagements: Engagement[],
  personalOrgs: string[] = [],
): Registry {
  return {
    engagements,
    alwaysBlock: [],
    personalOrgs,
    schemaVersion: 2,
  };
}

const E_ALPHA: Engagement = {
  id: "alpha",
  name: "Alpha",
  markers: [],
  githubOrgs: ["alpha-org", "alpha-mirror"],
};
const E_BETA: Engagement = {
  id: "beta",
  name: "Beta",
  markers: [],
  githubOrgs: ["beta-org"],
};

describe("computeTrustBoundary", () => {
  it("derives orgs from a single allow'd engagement", () => {
    const repo = makeRepo("ct-cust", {
      remote: "git@github.com:alpha-org/foo.git",
      class: "customer-coupled",
      engagements: ["alpha"],
    });
    const reg = makeRegistry([E_ALPHA, E_BETA]);
    const tb = computeTrustBoundary(repo, reg);
    assert.deepEqual([...tb.orgs].sort(), ["alpha-mirror", "alpha-org"]);
    assert.equal(tb.fromRemoteFallback, false);
    assert.equal(tb.class, "customer-coupled");
  });

  it("union'd orgs across multiple allow'd engagements", () => {
    const repo = makeRepo("ct-multi", {
      remote: "git@github.com:alpha-org/x.git",
      class: "customer-coupled",
      engagements: ["alpha", "beta"],
    });
    const reg = makeRegistry([E_ALPHA, E_BETA]);
    const tb = computeTrustBoundary(repo, reg);
    assert.deepEqual([...tb.orgs].sort(), ["alpha-mirror", "alpha-org", "beta-org"]);
  });

  it("public-eligible picks up personalOrgs", () => {
    const repo = makeRepo("ct-pub", {
      remote: "git@github.com:de-otio/foo.git",
      class: "public-eligible",
    });
    const reg = makeRegistry([E_ALPHA], ["de-otio", "personal2"]);
    const tb = computeTrustBoundary(repo, reg);
    assert.deepEqual([...tb.orgs].sort(), ["de-otio", "personal2"]);
    assert.equal(tb.fromRemoteFallback, false);
  });

  it("falls back to the remote when classification is empty", () => {
    const repo = makeRepo("ct-fallback", {
      remote: "git@github.com:de-otio/foo.git",
      // No class, no engagements: defaults to private-strict.
    });
    const reg = makeRegistry([E_ALPHA]);
    const tb = computeTrustBoundary(repo, reg);
    assert.deepEqual([...tb.orgs], ["de-otio"]);
    assert.equal(tb.fromRemoteFallback, true);
    assert.equal(tb.class, "private-strict");
    assert.equal(tb.classExplicit, false);
  });

  it("returns an empty set when there's no remote and no classification", () => {
    const repo = makeRepo("ct-bare");
    const reg = makeRegistry([E_ALPHA]);
    const tb = computeTrustBoundary(repo, reg);
    assert.equal(tb.orgs.size, 0);
    assert.equal(tb.fromRemoteFallback, false);
  });

  it("classification beats remote (forks)", () => {
    // Repo's remote is the customer org but it's allow'd into the
    // personal world (e.g. an internal mirror of an upstream).
    const repo = makeRepo("ct-fork", {
      remote: "git@github.com:alpha-org/x.git",
      class: "public-eligible",
    });
    const reg = makeRegistry([E_ALPHA], ["de-otio"]);
    const tb = computeTrustBoundary(repo, reg);
    assert.deepEqual([...tb.orgs], ["de-otio"]);
    assert.equal(tb.fromRemoteFallback, false);
  });
});

describe("trustBoundariesOverlap", () => {
  const reg = makeRegistry([E_ALPHA, E_BETA], ["de-otio"]);

  it("returns true when both repos sit in the same engagement orgs", () => {
    const a = makeRepo("ov-a", { class: "customer-coupled", engagements: ["alpha"] });
    const b = makeRepo("ov-b", { class: "customer-coupled", engagements: ["alpha"] });
    assert.ok(trustBoundariesOverlap(computeTrustBoundary(a, reg), computeTrustBoundary(b, reg)));
  });

  it("returns true when repos share at least one githubOrg via different engagements", () => {
    // Engagement γ shares one org with α
    const E_GAMMA: Engagement = {
      id: "gamma",
      name: "Gamma",
      markers: [],
      githubOrgs: ["alpha-mirror", "gamma-org"],
    };
    const reg2 = makeRegistry([E_ALPHA, E_GAMMA]);
    const a = makeRepo("ov-shared-a", { class: "customer-coupled", engagements: ["alpha"] });
    const b = makeRepo("ov-shared-b", { class: "customer-coupled", engagements: ["gamma"] });
    assert.ok(trustBoundariesOverlap(computeTrustBoundary(a, reg2), computeTrustBoundary(b, reg2)));
  });

  it("returns false when engagements have disjoint orgs", () => {
    const a = makeRepo("ov-x", { class: "customer-coupled", engagements: ["alpha"] });
    const b = makeRepo("ov-y", { class: "customer-coupled", engagements: ["beta"] });
    assert.ok(!trustBoundariesOverlap(computeTrustBoundary(a, reg), computeTrustBoundary(b, reg)));
  });

  it("returns false when one side is personal and the other customer-coupled", () => {
    const a = makeRepo("ov-pers", {
      remote: "git@github.com:de-otio/x.git",
      class: "public-eligible",
    });
    const b = makeRepo("ov-cust", {
      class: "customer-coupled",
      engagements: ["alpha"],
    });
    assert.ok(!trustBoundariesOverlap(computeTrustBoundary(a, reg), computeTrustBoundary(b, reg)));
  });

  it("returns false when both sides have empty boundaries", () => {
    const a = makeRepo("ov-empty-a");
    const b = makeRepo("ov-empty-b");
    assert.ok(!trustBoundariesOverlap(computeTrustBoundary(a, reg), computeTrustBoundary(b, reg)));
  });

  it("matches via remote fallback when neither repo is classified but they share an org", () => {
    const a = makeRepo("ov-r-a", { remote: "git@github.com:de-otio/x.git" });
    const b = makeRepo("ov-r-b", { remote: "git@github.com:de-otio/y.git" });
    assert.ok(trustBoundariesOverlap(computeTrustBoundary(a, reg), computeTrustBoundary(b, reg)));
  });
});
