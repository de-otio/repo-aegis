// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureOutput, withEnv } from "../_test-utils.js";
import { uninstallSweepRepos } from "./uninstall-sweep-repos.js";

let tmp: string;

before(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "repo-aegis-sweep-test-")));
});

after(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function makeRepo(
  parent: string,
  name: string,
  opts: { class?: string; engagements?: string[] } = {},
): string {
  const dir = join(parent, name);
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q", "--initial-branch=main", dir], { stdio: "ignore" });
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

function configValue(dir: string, key: string): string {
  try {
    return execFileSync("git", ["-C", dir, "config", "--get", key], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

describe("uninstall sweep-repos", () => {
  it("dry-run lists repos with repo-aegis.* keys but does not unset them", () => {
    const root = mkdtempSync(join(tmp, "dry-"));
    const repo = makeRepo(root, "alpha", {
      class: "customer-coupled",
      engagements: ["alpha"],
    });
    const aegisHome = mkdtempSync(join(tmp, "dry-aegis-"));
    mkdirSync(join(aegisHome, "state"), { recursive: true });

    const r = withEnv("REPO_AEGIS_HOME", aegisHome, () =>
      captureOutput(() =>
        uninstallSweepRepos({ scanRoot: [root], json: true }),
      ),
    );
    const j = JSON.parse(r.stdout) as {
      dryRun: boolean;
      results: Array<{ workingTree: string; unset: string[]; values: Record<string, string[]> }>;
    };
    assert.equal(j.dryRun, true);
    assert.equal(j.results.length, 1);
    assert.equal(j.results[0]!.workingTree, repo);
    assert.equal(j.results[0]!.unset.length, 0);
    // Config should still be set after a dry run.
    assert.equal(configValue(repo, "repo-aegis.class"), "customer-coupled");
  });

  it("--yes (no dry-run) actually unsets the keys", () => {
    const root = mkdtempSync(join(tmp, "live-"));
    const repo = makeRepo(root, "alpha", {
      class: "customer-coupled",
      engagements: ["alpha", "beta"],
    });
    const aegisHome = mkdtempSync(join(tmp, "live-aegis-"));
    mkdirSync(join(aegisHome, "state"), { recursive: true });

    withEnv("REPO_AEGIS_HOME", aegisHome, () =>
      captureOutput(() =>
        uninstallSweepRepos({ scanRoot: [root], yes: true, json: true }),
      ),
    );
    assert.equal(configValue(repo, "repo-aegis.class"), "");
    assert.equal(configValue(repo, "repo-aegis.engagement"), "");
  });

  it("finds repos at multiple depths", () => {
    const root = mkdtempSync(join(tmp, "deep-"));
    makeRepo(root, "lvl1", { class: "scratch" });
    makeRepo(join(root, "subdir"), "lvl2", { class: "private-strict", engagements: ["foo"] });
    mkdirSync(join(root, "subdir", "deeper"), { recursive: true });
    makeRepo(join(root, "subdir", "deeper"), "lvl3", { class: "public-eligible" });
    const aegisHome = mkdtempSync(join(tmp, "deep-aegis-"));
    mkdirSync(join(aegisHome, "state"), { recursive: true });

    const r = withEnv("REPO_AEGIS_HOME", aegisHome, () =>
      captureOutput(() =>
        uninstallSweepRepos({ scanRoot: [root], json: true }),
      ),
    );
    const j = JSON.parse(r.stdout) as {
      results: Array<{ workingTree: string }>;
    };
    assert.equal(j.results.length, 3);
  });

  it("ignores repos with no repo-aegis.* keys", () => {
    const root = mkdtempSync(join(tmp, "clean-"));
    makeRepo(root, "alpha");
    makeRepo(root, "beta");
    const aegisHome = mkdtempSync(join(tmp, "clean-aegis-"));
    mkdirSync(join(aegisHome, "state"), { recursive: true });

    const r = withEnv("REPO_AEGIS_HOME", aegisHome, () =>
      captureOutput(() =>
        uninstallSweepRepos({ scanRoot: [root], json: true }),
      ),
    );
    const j = JSON.parse(r.stdout) as { results: unknown[] };
    assert.deepEqual(j.results, []);
  });

  it("skips node_modules and other vendor/cache dirs", () => {
    const root = mkdtempSync(join(tmp, "skip-"));
    const nested = join(root, "node_modules", "some-pkg");
    mkdirSync(nested, { recursive: true });
    makeRepo(nested, "vendored", { class: "scratch" });
    const aegisHome = mkdtempSync(join(tmp, "skip-aegis-"));
    mkdirSync(join(aegisHome, "state"), { recursive: true });

    const r = withEnv("REPO_AEGIS_HOME", aegisHome, () =>
      captureOutput(() =>
        uninstallSweepRepos({ scanRoot: [root], json: true }),
      ),
    );
    const j = JSON.parse(r.stdout) as { results: unknown[] };
    assert.deepEqual(j.results, []);
  });

  it("is idempotent — second sweep is a no-op", () => {
    const root = mkdtempSync(join(tmp, "idem-"));
    makeRepo(root, "alpha", { class: "scratch", engagements: ["x"] });
    const aegisHome = mkdtempSync(join(tmp, "idem-aegis-"));
    mkdirSync(join(aegisHome, "state"), { recursive: true });

    withEnv("REPO_AEGIS_HOME", aegisHome, () =>
      captureOutput(() => uninstallSweepRepos({ scanRoot: [root], yes: true })),
    );
    const r = withEnv("REPO_AEGIS_HOME", aegisHome, () =>
      captureOutput(() =>
        uninstallSweepRepos({ scanRoot: [root], yes: true, json: true }),
      ),
    );
    const j = JSON.parse(r.stdout) as { results: unknown[] };
    assert.deepEqual(j.results, []);
  });

  it("reports empty result when scan-root does not exist", () => {
    const aegisHome = mkdtempSync(join(tmp, "absent-aegis-"));
    mkdirSync(join(aegisHome, "state"), { recursive: true });
    const r = withEnv("REPO_AEGIS_HOME", aegisHome, () =>
      captureOutput(() =>
        uninstallSweepRepos({ scanRoot: ["/no/such/dir"], json: true }),
      ),
    );
    const j = JSON.parse(r.stdout) as { results: unknown[] };
    assert.deepEqual(j.results, []);
  });
});
