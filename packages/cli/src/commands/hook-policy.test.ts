// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decideHookAction } from "./hook-policy.js";
import type { Registry, Engagement } from "@de-otio/repo-aegis-core";

let tmp: string;

before(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "repo-aegis-policy-")));
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

const E_ALPHA: Engagement = {
  id: "alpha",
  name: "Alpha",
  markers: [],
  githubOrgs: ["alpha-org"],
};
const E_BETA: Engagement = {
  id: "beta",
  name: "Beta",
  markers: [],
  githubOrgs: ["beta-org"],
};
function reg(extra: { engagements?: Engagement[]; personal?: string[] } = {}): Registry {
  return {
    engagements: extra.engagements ?? [E_ALPHA, E_BETA],
    alwaysBlock: [],
    personalOrgs: extra.personal ?? ["personal-org"],
    schemaVersion: 2,
  };
}

describe("decideHookAction", () => {
  it("scan: same-tree write", () => {
    const repo = makeRepo("p-same", {
      remote: "git@github.com:alpha-org/x.git",
      class: "customer-coupled",
      engagements: ["alpha"],
    });
    const file = join(repo, "src.ts");
    writeFileSync(file, "x");
    const d = decideHookAction({
      filePath: file,
      launcherCwd: repo,
      registry: reg(),
    });
    assert.equal(d.action, "scan");
    if (d.action === "scan") assert.equal(d.workingTree, repo);
  });

  it("scan: cross-tree, same engagement org", () => {
    const a = makeRepo("p-a-alpha", {
      remote: "git@github.com:alpha-org/a.git",
      class: "customer-coupled",
      engagements: ["alpha"],
    });
    const b = makeRepo("p-b-alpha", {
      remote: "git@github.com:alpha-org/b.git",
      class: "customer-coupled",
      engagements: ["alpha"],
    });
    const file = join(b, "newfile.ts");
    writeFileSync(file, "x");
    const d = decideHookAction({
      filePath: file,
      launcherCwd: a,
      registry: reg(),
    });
    assert.equal(d.action, "scan");
    if (d.action === "scan") assert.equal(d.workingTree, b);
  });

  it("scan: cross-tree, both in personalOrgs", () => {
    const a = makeRepo("p-pers-a", {
      remote: "git@github.com:personal-org/a.git",
      class: "public-eligible",
    });
    const b = makeRepo("p-pers-b", {
      remote: "git@github.com:personal-org/b.git",
      class: "public-eligible",
    });
    const file = join(b, "f.ts");
    writeFileSync(file, "x");
    const d = decideHookAction({
      filePath: file,
      launcherCwd: a,
      registry: reg({ personal: ["personal-org"] }),
    });
    assert.equal(d.action, "scan");
  });

  it("refuse: cross-org write between two distinct engagements", () => {
    const a = makeRepo("p-cross-alpha", {
      remote: "git@github.com:alpha-org/x.git",
      class: "customer-coupled",
      engagements: ["alpha"],
    });
    const b = makeRepo("p-cross-beta", {
      remote: "git@github.com:beta-org/x.git",
      class: "customer-coupled",
      engagements: ["beta"],
    });
    const file = join(b, "f.ts");
    writeFileSync(file, "x");
    const d = decideHookAction({
      filePath: file,
      launcherCwd: a,
      registry: reg(),
    });
    assert.equal(d.action, "refuse");
    if (d.action === "refuse") {
      assert.equal(d.code, "CROSS_ORG_WRITE");
      assert.deepEqual(d.srcOrgs, ["alpha-org"]);
      assert.deepEqual(d.destOrgs, ["beta-org"]);
      assert.equal(d.destTree, b);
    }
  });

  it("refuse: customer-coupled writing into personal", () => {
    const customer = makeRepo("p-leak-customer", {
      remote: "git@github.com:alpha-org/x.git",
      class: "customer-coupled",
      engagements: ["alpha"],
    });
    const personal = makeRepo("p-leak-personal", {
      remote: "git@github.com:personal-org/x.git",
      class: "public-eligible",
    });
    const file = join(personal, "f.ts");
    writeFileSync(file, "x");
    const d = decideHookAction({
      filePath: file,
      launcherCwd: customer,
      registry: reg({ personal: ["personal-org"] }),
    });
    assert.equal(d.action, "refuse");
    if (d.action === "refuse") {
      assert.deepEqual(d.srcOrgs, ["alpha-org"]);
      assert.deepEqual(d.destOrgs, ["personal-org"]);
    }
  });

  it("scan-with-warning: dest has no classification and no remote", () => {
    const src = makeRepo("p-warn-src", {
      remote: "git@github.com:alpha-org/x.git",
      class: "customer-coupled",
      engagements: ["alpha"],
    });
    const dest = makeRepo("p-warn-bare");
    const file = join(dest, "f.ts");
    writeFileSync(file, "x");
    const d = decideHookAction({
      filePath: file,
      launcherCwd: src,
      registry: reg(),
    });
    assert.equal(d.action, "scan-with-warning");
    if (d.action === "scan-with-warning") {
      assert.equal(d.warning.code, "DEST_UNCLASSIFIED");
      assert.equal(d.warning.destTree, dest);
      assert.equal(d.warning.hasRemote, false);
    }
  });

  it("scan: outside any git tree falls through to global _always", () => {
    const file = join(tmp, "loose-scratch.txt");
    writeFileSync(file, "x");
    const src = makeRepo("p-outside-src", {
      remote: "git@github.com:alpha-org/x.git",
      class: "customer-coupled",
      engagements: ["alpha"],
    });
    const d = decideHookAction({
      filePath: file,
      launcherCwd: src,
      registry: reg(),
    });
    assert.equal(d.action, "scan");
    if (d.action === "scan") {
      assert.equal(d.workingTree, null);
      assert.equal(d.repo.isGitRepo, false);
    }
  });

  it("scan: cross-tree, src personal + dest also personal (different personalOrgs entries)", () => {
    const a = makeRepo("p-multi-pers-a", {
      remote: "git@github.com:de-otio/a.git",
      class: "public-eligible",
    });
    const b = makeRepo("p-multi-pers-b", {
      remote: "git@github.com:second-personal/b.git",
      class: "public-eligible",
    });
    const file = join(b, "f.ts");
    writeFileSync(file, "x");
    const d = decideHookAction({
      filePath: file,
      launcherCwd: a,
      registry: reg({ personal: ["de-otio", "second-personal"] }),
    });
    assert.equal(d.action, "scan");
  });
});
