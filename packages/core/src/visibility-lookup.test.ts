// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// Issue #114: the shared "unknown is public" rule and the one-shot visibility
// refresh. No test here reaches the network: every lookup is a stub, and the
// one test of the real `gh` lookup uses an input it rejects before spawning.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { treatAsPublicDestination, isPublicFacing } from "./egress.js";
import {
  effectiveVisibilityLookup,
  lookupVisibilityViaGh,
  refreshUnknownVisibility,
  VISIBILITY_LOOKUP_ENV,
  type VisibilityLookup,
} from "./visibility-lookup.js";
import { lookupDestination } from "./destination-cache.js";

describe("treatAsPublicDestination — the one rule", () => {
  const cases: Array<[Parameters<typeof treatAsPublicDestination>[0], Parameters<typeof treatAsPublicDestination>[1], boolean]> = [
    ["private-strict", "private", false],
    ["private-strict", "public", true],
    ["private-strict", "unknown", true],
    ["customer-coupled", "private", false],
    ["customer-coupled", "unknown", true],
    ["scratch", "unknown", true],
    ["public-eligible", "private", true],
    ["public-eligible", "unknown", true],
  ];
  for (const [cls, vis, want] of cases) {
    it(`${cls} × ${vis} → ${want ? "public" : "not public"}`, () => {
      assert.equal(treatAsPublicDestination(cls, vis), want);
    });
  }

  it("is deliberately not isPublicFacing: the content check still reads unknown as private", () => {
    const repo = { class: "private-strict" as const, cwd: "/nonexistent" };
    assert.equal(isPublicFacing(repo, { visibility: "unknown" }), false);
    assert.equal(treatAsPublicDestination("private-strict", "unknown"), true);
  });
});

describe("effectiveVisibilityLookup", () => {
  const stub: VisibilityLookup = () => "private";
  it("an injected lookup wins, even with the env kill switch set", () => {
    assert.equal(effectiveVisibilityLookup(stub, { [VISIBILITY_LOOKUP_ENV]: "0" }), stub);
  });
  it("the env kill switch disables the default", () => {
    assert.equal(effectiveVisibilityLookup(undefined, { [VISIBILITY_LOOKUP_ENV]: "0" }), null);
  });
  it("otherwise the gh lookup", () => {
    assert.equal(effectiveVisibilityLookup(undefined, {}), lookupVisibilityViaGh);
  });
});

describe("lookupVisibilityViaGh", () => {
  it("rejects an org/repo that is not a plain GitHub name without spawning anything", () => {
    assert.equal(lookupVisibilityViaGh("acme", "../etc"), null);
    assert.equal(lookupVisibilityViaGh("acme", ".."), null);
    assert.equal(lookupVisibilityViaGh("-R", "x"), null); // never an option to gh
    assert.equal(lookupVisibilityViaGh("a b", "x"), null);
    assert.equal(lookupVisibilityViaGh("acme", "*"), null);
  });
});

describe("refreshUnknownVisibility", () => {
  let root: string;
  let priorHome: string | undefined;

  function git(cwd: string, args: string[]): string {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  }

  function makeRepo(name: string): string {
    const dir = join(root, name);
    mkdirSync(dir);
    git(dir, ["init", "-q"]);
    git(dir, ["remote", "add", "origin", `git@github.com:example/${name}.git`]);
    return dir;
  }

  before(() => {
    root = mkdtempSync(join(tmpdir(), "visibility-lookup-"));
    priorHome = process.env["REPO_AEGIS_HOME"];
    process.env["REPO_AEGIS_HOME"] = join(root, "home");
  });

  after(() => {
    if (priorHome === undefined) delete process.env["REPO_AEGIS_HOME"];
    else process.env["REPO_AEGIS_HOME"] = priorHome;
    rmSync(root, { recursive: true, force: true });
  });

  it("no lookup → unknown", () => {
    assert.equal(refreshUnknownVisibility({ org: "example", repo: "x" }, null), "unknown");
  });

  it("an org-level target (`*`) is never looked up", () => {
    let calls = 0;
    const v = refreshUnknownVisibility({ org: "example", repo: "*" }, () => {
      calls++;
      return "private";
    });
    assert.equal(v, "unknown");
    assert.equal(calls, 0);
  });

  it("a lookup that cannot answer, or throws, leaves it unknown", () => {
    assert.equal(refreshUnknownVisibility({ org: "example", repo: "x" }, () => null), "unknown");
    assert.equal(
      refreshUnknownVisibility({ org: "example", repo: "x" }, () => {
        throw new Error("timeout");
      }),
      "unknown",
    );
  });

  it("an answer with no checkout is returned and not written anywhere", () => {
    assert.equal(refreshUnknownVisibility({ org: "example", repo: "nowhere" }, () => "public"), "public");
    assert.equal(lookupDestination("example", "nowhere"), null);
  });

  it("an answer with a checkout is cached into its git config and the destination cache", () => {
    const dir = makeRepo("held");
    const v = refreshUnknownVisibility({ org: "example", repo: "held", workingTree: dir }, () => "private");
    assert.equal(v, "private");
    assert.equal(git(dir, ["config", "--get", "repo-aegis.visibility"]).trim(), "private");
    assert.equal(lookupDestination("example", "held")?.visibility, "private");
  });

  it("a checkout that cannot be written to still gets the answer for this call", () => {
    const v = refreshUnknownVisibility(
      { org: "example", repo: "gone", workingTree: join(root, "does-not-exist") },
      () => "private",
    );
    assert.equal(v, "private");
  });
});
