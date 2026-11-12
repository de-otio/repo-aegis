// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// Change A (doc/plan-engagement-repo-consistency.md): the class of an unclassified repository, worked out
// from its push targets. Placeholders: `org-a` / `org-b` are engagements' orgs, `mine` a personal org.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scrubGitEnv } from "./_test-git-env.js";
import { classifyOwner, type OwnerRegistry } from "./owner-class.js";
import type { RemoteTarget } from "./remote-url.js";
import { inferClass, readEffectiveRepoConfig, type InferClassInput } from "./repo-inference.js";
import { readRepoConfig } from "./repo.js";

const eng = (id: string, githubOrgs: string[]) => ({ id, name: id, started: "2026-01-01", markers: [], githubOrgs });
const REGISTRY = {
  engagements: [eng("eng-a", ["org-a", "org-a-labs"]), eng("eng-b", ["org-b"]), eng("eng-c", ["shared"]), eng("eng-d", ["shared"])],
  personalOrgs: ["mine"],
} as unknown as OwnerRegistry;

const gh = (org: string, repo = "r"): RemoteTarget => ({ kind: "github", org, repo });
const NON_GITHUB: RemoteTarget = { kind: "non-github" };
const UNRESOLVED: RemoteTarget = { kind: "unresolved", why: "an alias nothing could resolve" };

function input(over: Partial<InferClassInput> & { targets: readonly RemoteTarget[] }): InferClassInput {
  return { raw: { classExplicit: false, engagements: [] }, cachedVisibility: "unknown", registry: REGISTRY, ...over };
}

const A = { class: "customer-coupled", engagement: "eng-a" };

describe("inferClass — positive", () => {
  it("one push target in an engagement's org", () => {
    assert.deepEqual(inferClass(input({ targets: [gh("org-a")] })), A);
  });
  it("owner case does not matter", () => {
    assert.deepEqual(inferClass(input({ targets: [gh("ORG-A")] })), A);
  });
  it("several targets, all the same engagement (two orgs of it, two remotes)", () => {
    assert.deepEqual(inferClass(input({ targets: [gh("org-a", "x"), gh("org-a-labs", "y"), gh("org-a", "z")] })), A);
  });
  it("a recorded private checkout is fine", () => {
    assert.deepEqual(inferClass(input({ targets: [gh("org-a")], cachedVisibility: "private" })), A);
  });
  it("a configured engagement equal to the inferred one is kept, not doubled", () => {
    assert.deepEqual(inferClass(input({ targets: [gh("org-a")], raw: { classExplicit: false, engagements: ["eng-a"] } })), A);
  });
});

describe("inferClass — every veto leaves the raw class standing (null)", () => {
  const VETOES: Array<[string, InferClassInput]> = [
    ["an explicit class", input({ targets: [gh("org-a")], raw: { classExplicit: true, engagements: [] } })],
    ["no push target", input({ targets: [] })],
    ["a personal org", input({ targets: [gh("mine")] })],
    ["an owner the registry does not know", input({ targets: [gh("stranger")] })],
    ["an owner in two engagements", input({ targets: [gh("shared")] })],
    ["two different engagements", input({ targets: [gh("org-a"), gh("org-b")] })],
    ["an engagement and an unknown owner", input({ targets: [gh("org-a"), gh("stranger")] })],
    ["an engagement and a personal owner", input({ targets: [gh("org-a"), gh("mine")] })],
    ["an engagement and a non-GitHub mirror", input({ targets: [gh("org-a"), NON_GITHUB] })],
    ["an engagement and an unresolved alias", input({ targets: [gh("org-a"), UNRESOLVED] })],
    ["a non-GitHub target alone", input({ targets: [NON_GITHUB] })],
    ["a recorded-public checkout (a customer's open-source repo)", input({ targets: [gh("org-a")], cachedVisibility: "public" })],
    ["a different engagement already configured", input({ targets: [gh("org-a")], raw: { classExplicit: false, engagements: ["eng-b"] } })],
    ["a configured engagement list that adds to the inferred one", input({ targets: [gh("org-a")], raw: { classExplicit: false, engagements: ["eng-a", "eng-b"] } })],
  ];
  for (const [why, i] of VETOES) {
    it(why, () => {
      assert.equal(inferClass(i), null);
    });
  }
});

// Exhaustive, not sampled: every list of up to three targets drawn from a small universe covering each kind. A
// hand-rolled enumeration instead of a property-testing dependency: the input space is small enough to check all of.
describe("inferClass — metamorphic properties, exhaustive over a small universe", () => {
  const UNIVERSE: RemoteTarget[] = [gh("org-a", "x"), gh("ORG-A-LABS", "y"), gh("org-b"), gh("mine"), gh("shared"), gh("stranger"), NON_GITHUB, UNRESOLVED];

  function lists(max: number): RemoteTarget[][] {
    const out: RemoteTarget[][] = [[]];
    let layer: RemoteTarget[][] = [[]];
    for (let n = 0; n < max; n++) {
      layer = layer.flatMap(l => UNIVERSE.map(t => [...l, t]));
      out.push(...layer);
    }
    return out;
  }
  const ALL = lists(3);

  it("the universe is big enough to mean something", () => {
    assert.equal(ALL.length, 1 + 8 + 64 + 512);
  });

  it("once a non-empty list is vetoed, adding any further target never un-vetoes it", () => {
    let checked = 0;
    for (const l of ALL.filter(x => x.length > 0)) {
      if (inferClass(input({ targets: l })) !== null) continue;
      for (const extra of UNIVERSE) {
        assert.equal(inferClass(input({ targets: [...l, extra] })), null, JSON.stringify([...l, extra]));
        checked++;
      }
    }
    assert.ok(checked > 1000);
  });

  it("adding a non-GitHub or unresolved target to a non-empty list always gives null", () => {
    for (const l of ALL.filter(x => x.length > 0)) {
      const vetoes: RemoteTarget[] = [NON_GITHUB, UNRESOLVED];
      for (const veto of vetoes) assert.equal(inferClass(input({ targets: [...l, veto] })), null);
    }
  });

  it("target order never changes the result", () => {
    for (const l of ALL) {
      const forward = inferClass(input({ targets: l }));
      const backward = inferClass(input({ targets: [...l].reverse() }));
      assert.deepEqual(backward, forward, JSON.stringify(l));
    }
  });

  it("a non-null result means every target is a GitHub repo whose owner classifies as exactly that engagement", () => {
    let inferred = 0;
    for (const l of ALL) {
      const r = inferClass(input({ targets: l }));
      if (r === null) continue;
      inferred++;
      assert.ok(l.length > 0);
      for (const t of l) {
        assert.equal(t.kind, "github");
        if (t.kind === "github") assert.deepEqual(classifyOwner(t.org, REGISTRY), { kind: "engagement", id: r.engagement });
      }
    }
    assert.ok(inferred > 0);
  });

  it("a recorded-public checkout, an explicit class and a configured engagement that is not the inferred one veto every list", () => {
    for (const l of ALL) {
      assert.equal(inferClass(input({ targets: l, cachedVisibility: "public" })), null);
      assert.equal(inferClass(input({ targets: l, raw: { classExplicit: true, engagements: [] } })), null);
      assert.equal(inferClass(input({ targets: l, raw: { classExplicit: false, engagements: ["eng-x"] } })), null);
    }
  });
});

describe("readEffectiveRepoConfig — against real git config", () => {
  let restoreGitEnv: () => void;
  let root: string;

  function git(cwd: string, ...args: string[]): void {
    execFileSync("git", args, { cwd, stdio: "ignore" });
  }

  function repo(name: string, remotes: Record<string, string>, config: Record<string, string> = {}): string {
    const dir = join(root, name);
    mkdirSync(dir);
    git(dir, "init", "-q");
    for (const [r, url] of Object.entries(remotes)) git(dir, "remote", "add", r, url);
    for (const [k, v] of Object.entries(config)) git(dir, "config", k, v);
    return dir;
  }

  before(() => {
    restoreGitEnv = scrubGitEnv();
    root = mkdtempSync(join(tmpdir(), "repo-inference-"));
  });
  after(() => {
    restoreGitEnv();
    rmSync(root, { recursive: true, force: true });
  });

  it("an unclassified repo whose origin is an engagement's org is customer-coupled for that engagement, and says it was inferred", () => {
    const dir = repo("plain", { origin: "https://github.com/org-a/lib.git" });
    const eff = readEffectiveRepoConfig(dir, REGISTRY);
    assert.equal(eff.class, "customer-coupled");
    assert.deepEqual(eff.engagements, ["eng-a"]);
    assert.equal(eff.classExplicit, false);
    assert.equal(eff.classInferred, true);
  });

  it("the raw reader is unchanged: git config still holds nothing, so allow/deny/classify see what git holds", () => {
    const dir = repo("raw", { origin: "https://github.com/org-a/lib.git" });
    const raw = readRepoConfig(dir);
    assert.equal(raw.class, "private-strict");
    assert.deepEqual(raw.engagements, []);
    assert.equal((readEffectiveRepoConfig(dir, REGISTRY) as { classInferred?: boolean }).classInferred, true);
    // Reading never writes: nothing was added to git config.
    assert.equal(readRepoConfig(dir).classExplicit, false);
  });

  it("an explicit class always wins", () => {
    const dir = repo("explicit", { origin: "https://github.com/org-a/lib.git" }, { "repo-aegis.class": "private-strict" });
    const eff = readEffectiveRepoConfig(dir, REGISTRY);
    assert.equal(eff.class, "private-strict");
    assert.equal(eff.classInferred, undefined);
  });

  it("a second remote in another customer's org vetoes", () => {
    const dir = repo("two-customers", { origin: "https://github.com/org-a/lib.git", other: "https://github.com/org-b/lib.git" });
    assert.equal(readEffectiveRepoConfig(dir, REGISTRY).class, "private-strict");
  });

  it("a second remote on another host vetoes", () => {
    const dir = repo("mirror", { origin: "https://github.com/org-a/lib.git", mirror: "https://gitlab.com/org-a/lib.git" });
    assert.equal(readEffectiveRepoConfig(dir, REGISTRY).class, "private-strict");
  });

  it("a pushurl to an unmapped owner vetoes (the push goes there, whatever the fetch URL says)", () => {
    const dir = repo("pushurl", { origin: "https://github.com/org-a/lib.git" }, { "remote.origin.pushurl": "https://github.com/stranger/lib.git" });
    assert.equal(readEffectiveRepoConfig(dir, REGISTRY).class, "private-strict");
  });

  it("a recorded-public checkout is not inferred", () => {
    const dir = repo("public", { origin: "https://github.com/org-a/lib.git" }, { "repo-aegis.visibility": "public" });
    assert.equal(readEffectiveRepoConfig(dir, REGISTRY).class, "private-strict");
  });

  it("a configured engagement that differs is kept, not replaced", () => {
    const dir = repo("configured", { origin: "https://github.com/org-a/lib.git" }, { "repo-aegis.engagement": "eng-b" });
    const eff = readEffectiveRepoConfig(dir, REGISTRY);
    assert.equal(eff.class, "private-strict");
    assert.deepEqual(eff.engagements, ["eng-b"]);
  });

  it("no remote, a personal owner, and no registry all leave the raw config", () => {
    assert.equal(readEffectiveRepoConfig(repo("no-remote", {}), REGISTRY).class, "private-strict");
    assert.equal(readEffectiveRepoConfig(repo("personal", { origin: "https://github.com/mine/lib.git" }), REGISTRY).class, "private-strict");
    const dir = repo("no-registry", { origin: "https://github.com/org-a/lib.git" });
    assert.equal(readEffectiveRepoConfig(dir, null).class, "private-strict");
    assert.equal(readEffectiveRepoConfig(dir, undefined).class, "private-strict");
  });

  it("a directory that is not a git repo is returned raw", () => {
    const dir = join(root, "not-git");
    mkdirSync(dir);
    writeFileSync(join(dir, "x"), "");
    assert.equal(readEffectiveRepoConfig(dir, REGISTRY).isGitRepo, false);
  });
});
