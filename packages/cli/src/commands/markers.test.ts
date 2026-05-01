import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureOutput, withEnv } from "../_test-utils.js";
import { markersList, markersTest } from "./markers.js";

let tmp: string;

before(() => {
  tmp = mkdtempSync(join(tmpdir(), "repo-aegis-markers-test-"));
});

after(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function setupHome(name: string, fileSpec: Record<string, string[]>): string {
  const home = join(tmp, name);
  const markersDir = join(home, "markers");
  const stateDir = join(home, "state");
  mkdirSync(markersDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  for (const [stem, patterns] of Object.entries(fileSpec)) {
    writeFileSync(join(markersDir, `${stem}.txt`), patterns.join("\n") + "\n");
  }
  return home;
}

function makeRepo(name: string, opts: { class?: string; engagements?: string[] } = {}): string {
  const dir = join(tmp, name);
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: dir });
  if (opts.class) {
    execFileSync("git", ["config", "repo-aegis.class", opts.class], { cwd: dir });
  }
  for (const eid of opts.engagements ?? []) {
    execFileSync("git", ["config", "--add", "repo-aegis.engagement", eid], { cwd: dir });
  }
  return dir;
}

describe("markers list — empty markers dir", () => {
  it("prints a 'no marker files' message", () => {
    const home = setupHome("empty", {});
    const result = withEnv("REPO_AEGIS_HOME", home, () =>
      captureOutput(() => markersList({})),
    );
    assert.ok(result.stdout.includes("no marker files"));
  });
});

describe("markers list — populated", () => {
  let home: string;

  before(() => {
    home = setupHome("populated", {
      _always: ["always-block-pattern"],
      "customer-a": ["alpha-marker", "beta-marker"],
    });
  });

  it("redacts patterns by default", () => {
    const result = withEnv("REPO_AEGIS_HOME", home, () =>
      captureOutput(() => markersList({})),
    );
    assert.ok(!result.stdout.includes("alpha-marker"));
    assert.ok(!result.stdout.includes("beta-marker"));
    assert.ok(!result.stdout.includes("always-block-pattern"));
    assert.ok(result.stdout.includes("customer-a"));
    assert.ok(result.stdout.includes("_always"));
    assert.ok(result.stdout.includes("(always-block)"));
  });

  it("reveals literals with --verbose", () => {
    const result = withEnv("REPO_AEGIS_HOME", home, () =>
      captureOutput(() => markersList({ verbose: true })),
    );
    assert.ok(result.stdout.includes("alpha-marker"));
    assert.ok(result.stdout.includes("beta-marker"));
  });

  it("emits structured JSON without literals by default", () => {
    const result = withEnv("REPO_AEGIS_HOME", home, () =>
      captureOutput(() => markersList({ json: true })),
    );
    const j = JSON.parse(result.stdout) as {
      action: string;
      files: { stem: string; patternCount: number; patterns: { index: number; preview?: string; pattern?: string }[] }[];
      verbose: boolean;
    };
    assert.equal(j.action, "markers-list");
    assert.equal(j.verbose, false);
    const customerA = j.files.find(f => f.stem === "customer-a")!;
    assert.equal(customerA.patternCount, 2);
    assert.ok(customerA.patterns[0]!.preview);
    assert.equal(customerA.patterns[0]!.pattern, undefined);
  });

  it("emits literal patterns in JSON with verbose=true", () => {
    const result = withEnv("REPO_AEGIS_HOME", home, () =>
      captureOutput(() => markersList({ json: true, verbose: true })),
    );
    const j = JSON.parse(result.stdout) as {
      verbose: boolean;
      files: { stem: string; patterns: { pattern?: string }[] }[];
    };
    assert.equal(j.verbose, true);
    const customerA = j.files.find(f => f.stem === "customer-a")!;
    assert.equal(customerA.patterns[0]!.pattern, "alpha-marker");
  });
});

describe("markers test — no deny set", () => {
  it("reports no deny set when markers dir is empty", () => {
    const home = setupHome("empty-test", {});
    const repo = makeRepo("empty-test-repo", { class: "private-strict" });
    const result = withEnv("REPO_AEGIS_HOME", home, () =>
      captureOutput(() => markersTest("anything", { cwd: repo })),
    );
    assert.ok(result.stdout.includes("no deny set"));
  });
});

describe("markers test — match", () => {
  let home: string;

  before(() => {
    home = setupHome("test-match", {
      _always: ["org-secret"],
      "customer-a": ["alpha-thing"],
      "customer-b": ["bravo-thing"],
    });
  });

  it("reports the matching pattern, redacted by default", () => {
    const repo = makeRepo("test-match-repo", { class: "private-strict" });
    const result = withEnv("REPO_AEGIS_HOME", home, () =>
      captureOutput(() => markersTest("alpha-thing-leaked", { cwd: repo })),
    );
    assert.ok(result.stdout.includes("customer-a[0]"));
    assert.ok(!result.stdout.includes("alpha-thing"));
  });

  it("respects customer-coupled scoping (own engagement excluded)", () => {
    const repo = makeRepo("test-scoping-repo", {
      class: "customer-coupled",
      engagements: ["customer-a"],
    });
    const result = withEnv("REPO_AEGIS_HOME", home, () =>
      captureOutput(() => markersTest("alpha-thing-leaked", { json: true, cwd: repo })),
    );
    const j = JSON.parse(result.stdout) as { hits: { fileStem: string }[] };
    assert.equal(j.hits.length, 0, "alpha-thing should not match in its own customer-a repo");
  });

  it("still flags other engagements in customer-coupled mode", () => {
    const repo = makeRepo("test-scoping-cross-repo", {
      class: "customer-coupled",
      engagements: ["customer-a"],
    });
    const result = withEnv("REPO_AEGIS_HOME", home, () =>
      captureOutput(() => markersTest("bravo-thing-leaked", { json: true, cwd: repo })),
    );
    const j = JSON.parse(result.stdout) as { hits: { fileStem: string }[] };
    assert.equal(j.hits.length, 1);
    assert.equal(j.hits[0]!.fileStem, "customer-b");
  });

  it("emits redacted match in JSON by default", () => {
    const repo = makeRepo("test-match-json-repo", { class: "private-strict" });
    const result = withEnv("REPO_AEGIS_HOME", home, () =>
      captureOutput(() => markersTest("org-secret-leaked", { json: true, cwd: repo })),
    );
    const j = JSON.parse(result.stdout) as {
      hits: { preview?: string; pattern?: string }[];
    };
    assert.equal(j.hits[0]!.pattern, undefined);
    assert.ok(j.hits[0]!.preview);
  });
});
