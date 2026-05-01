import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureOutput, withEnv } from "../_test-utils.js";
import { audit } from "./audit.js";

let tmp: string;

before(() => {
  tmp = mkdtempSync(join(tmpdir(), "repo-aegis-audit-test-"));
});

after(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function setupHome(name: string, fileSpec: Record<string, string[]>): string {
  const home = join(tmp, name + "-home");
  const markersDir = join(home, "markers");
  mkdirSync(markersDir, { recursive: true });
  mkdirSync(join(home, "state"), { recursive: true });
  for (const [stem, patterns] of Object.entries(fileSpec)) {
    writeFileSync(join(markersDir, `${stem}.txt`), patterns.join("\n") + "\n");
  }
  return home;
}

interface RepoOpts {
  class?: string;
  engagements?: string[];
  remote?: string;
}

function makeRepo(name: string, opts: RepoOpts = {}): string {
  const dir = join(tmp, name);
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  if (opts.class) {
    execFileSync("git", ["config", "repo-aegis.class", opts.class], { cwd: dir });
  }
  for (const e of opts.engagements ?? []) {
    execFileSync("git", ["config", "--add", "repo-aegis.engagement", e], { cwd: dir });
  }
  if (opts.remote) {
    execFileSync("git", ["remote", "add", "origin", opts.remote], { cwd: dir });
  }
  return dir;
}

function commit(repo: string, files: Record<string, string>, message: string): void {
  for (const [path, content] of Object.entries(files)) {
    writeFileSync(join(repo, path), content);
    execFileSync("git", ["add", path], { cwd: repo });
  }
  execFileSync("git", ["commit", "-q", "-m", message], { cwd: repo });
}

describe("audit — marker-scan", () => {
  it("passes when no tracked files contain markers", () => {
    const home = setupHome("marker-clean", { _always: ["zzznever-appears-zzz"] });
    const repo = makeRepo("marker-clean-repo", { class: "private-strict" });
    commit(repo, { "README.md": "hello" }, "init");
    const result = withEnv("REPO_AEGIS_HOME", home, () =>
      captureOutput(() => audit({ cwd: repo, json: true })),
    );
    assert.equal(result.exitCode, undefined, "should not exit when clean");
    const j = JSON.parse(result.stdout) as {
      checks: { name: string; ok: boolean }[];
    };
    const m = j.checks.find(c => c.name === "marker-scan");
    assert.equal(m!.ok, true);
  });

  it("fails (exit 1) when a marker is found in a tracked file", () => {
    const home = setupHome("marker-hit", { _always: ["leaked-string"] });
    const repo = makeRepo("marker-hit-repo", { class: "private-strict" });
    commit(repo, { "config.txt": "this contains leaked-string in plain text" }, "init");
    const result = withEnv("REPO_AEGIS_HOME", home, () =>
      captureOutput(() => audit({ cwd: repo, json: true })),
    );
    assert.equal(result.exitCode, 1);
    const j = JSON.parse(result.stdout) as {
      checks: { name: string; ok: boolean; findings: { message: string }[] }[];
    };
    const m = j.checks.find(c => c.name === "marker-scan");
    assert.equal(m!.ok, false);
    assert.ok(m!.findings.some(f => f.message.includes("config.txt")));
  });

  it("can be disabled with --no-marker-scan", () => {
    const home = setupHome("marker-skip", { _always: ["leaked-string"] });
    const repo = makeRepo("marker-skip-repo", { class: "private-strict" });
    commit(repo, { "config.txt": "leaked-string" }, "init");
    const result = withEnv("REPO_AEGIS_HOME", home, () =>
      captureOutput(() => audit({ cwd: repo, json: true, markerScan: false })),
    );
    const j = JSON.parse(result.stdout) as {
      checks: { name: string }[];
    };
    assert.ok(!j.checks.some(c => c.name === "marker-scan"));
  });
});

describe("audit — lockfile", () => {
  it("skips when no package-lock.json exists", () => {
    const home = setupHome("lockfile-none", {});
    const repo = makeRepo("lockfile-none-repo", { class: "private-strict" });
    commit(repo, { "README.md": "x" }, "init");
    const result = withEnv("REPO_AEGIS_HOME", home, () =>
      captureOutput(() => audit({ cwd: repo, json: true })),
    );
    const j = JSON.parse(result.stdout) as {
      checks: { name: string; skipped?: boolean }[];
    };
    const c = j.checks.find(c => c.name === "lockfile");
    assert.equal(c!.skipped, true);
  });

  it("passes when only public registries are referenced", () => {
    const home = setupHome("lockfile-public", {});
    const repo = makeRepo("lockfile-public-repo", { class: "private-strict" });
    const lock = {
      packages: {
        "node_modules/foo": {
          resolved: "https://registry.npmjs.org/foo/-/foo-1.0.0.tgz",
        },
      },
    };
    commit(repo, { "package-lock.json": JSON.stringify(lock) }, "init");
    const result = withEnv("REPO_AEGIS_HOME", home, () =>
      captureOutput(() => audit({ cwd: repo, json: true })),
    );
    const j = JSON.parse(result.stdout) as {
      checks: { name: string; ok: boolean }[];
    };
    const c = j.checks.find(c => c.name === "lockfile");
    assert.equal(c!.ok, true);
  });

  it("fails when a non-public registry URL is found", () => {
    const home = setupHome("lockfile-private", {});
    const repo = makeRepo("lockfile-private-repo", { class: "private-strict" });
    const lock = {
      packages: {
        "node_modules/foo": {
          resolved: "https://npm.private-registry.example.com/foo/-/foo-1.0.0.tgz",
        },
      },
    };
    commit(repo, { "package-lock.json": JSON.stringify(lock) }, "init");
    const result = withEnv("REPO_AEGIS_HOME", home, () =>
      captureOutput(() => audit({ cwd: repo, json: true })),
    );
    assert.equal(result.exitCode, 1);
    const j = JSON.parse(result.stdout) as {
      checks: { name: string; ok: boolean; findings: { message: string }[] }[];
    };
    const c = j.checks.find(c => c.name === "lockfile");
    assert.equal(c!.ok, false);
    assert.ok(c!.findings.some(f => f.message.includes("npm.private-registry.example.com")));
  });
});

describe("audit — fixtures", () => {
  it("finds marker hits in __fixtures__ directory", () => {
    const home = setupHome("fixtures-hit", { _always: ["fixture-leak"] });
    const repo = makeRepo("fixtures-hit-repo", { class: "private-strict" });
    mkdirSync(join(repo, "__fixtures__"), { recursive: true });
    writeFileSync(join(repo, "__fixtures__", "data.txt"), "fixture-leak embedded here");
    const result = withEnv("REPO_AEGIS_HOME", home, () =>
      captureOutput(() => audit({ cwd: repo, json: true })),
    );
    assert.equal(result.exitCode, 1);
    const j = JSON.parse(result.stdout) as {
      checks: { name: string; ok: boolean; findings: { message: string }[] }[];
    };
    const c = j.checks.find(c => c.name === "fixtures");
    assert.equal(c!.ok, false);
    assert.ok(c!.findings.some(f => f.message.includes("data.txt")));
  });

  it("skips when no fixture dirs are found", () => {
    const home = setupHome("fixtures-none", { _always: ["whatever"] });
    const repo = makeRepo("fixtures-none-repo", { class: "private-strict" });
    commit(repo, { "README.md": "x" }, "init");
    const result = withEnv("REPO_AEGIS_HOME", home, () =>
      captureOutput(() => audit({ cwd: repo, json: true })),
    );
    const j = JSON.parse(result.stdout) as {
      checks: { name: string; skipped?: boolean }[];
    };
    const c = j.checks.find(c => c.name === "fixtures");
    assert.equal(c!.skipped, true);
  });
});

describe("audit — remote consistency", () => {
  it("flags scratch repo with origin remote set", () => {
    const home = setupHome("remote-scratch", {});
    const repo = makeRepo("remote-scratch-repo", {
      class: "scratch",
      remote: "git@github.com:test/repo.git",
    });
    const result = withEnv("REPO_AEGIS_HOME", home, () =>
      captureOutput(() => audit({ cwd: repo, json: true })),
    );
    assert.equal(result.exitCode, 1);
    const j = JSON.parse(result.stdout) as {
      checks: { name: string; ok: boolean; findings: { message: string }[] }[];
    };
    const c = j.checks.find(c => c.name === "remote");
    assert.equal(c!.ok, false);
  });

  it("flags customer-coupled repo without engagement id in remote", () => {
    const home = setupHome("remote-mismatch", {});
    const repo = makeRepo("remote-mismatch-repo", {
      class: "customer-coupled",
      engagements: ["customer-a"],
      remote: "git@github.com:other-org/other-repo.git",
    });
    const result = withEnv("REPO_AEGIS_HOME", home, () =>
      captureOutput(() => audit({ cwd: repo, json: true })),
    );
    assert.equal(result.exitCode, 1);
    const j = JSON.parse(result.stdout) as {
      checks: { name: string; ok: boolean }[];
    };
    const c = j.checks.find(c => c.name === "remote");
    assert.equal(c!.ok, false);
  });

  it("passes customer-coupled when engagement id is in remote", () => {
    const home = setupHome("remote-match", {});
    const repo = makeRepo("remote-match-repo", {
      class: "customer-coupled",
      engagements: ["customer-a"],
      remote: "git@github.com:de-otio/customer-a-tooling.git",
    });
    const result = withEnv("REPO_AEGIS_HOME", home, () =>
      captureOutput(() => audit({ cwd: repo, json: true })),
    );
    const j = JSON.parse(result.stdout) as {
      checks: { name: string; ok: boolean }[];
    };
    const c = j.checks.find(c => c.name === "remote");
    assert.equal(c!.ok, true);
  });
});

describe("audit — composite", () => {
  it("exits 0 when all enabled checks pass", () => {
    const home = setupHome("all-clean", { _always: ["zzz-never-appears-zzz"] });
    const repo = makeRepo("all-clean-repo", {
      class: "private-strict",
      remote: "git@github.com:test/repo.git",
    });
    commit(repo, { "README.md": "nothing-suspicious" }, "init");
    const result = withEnv("REPO_AEGIS_HOME", home, () =>
      captureOutput(() => audit({ cwd: repo, json: true })),
    );
    assert.equal(result.exitCode, undefined);
    const j = JSON.parse(result.stdout) as {
      summary: { run: number; failed: number; totalFindings: number };
    };
    assert.equal(j.summary.failed, 0);
    assert.equal(j.summary.totalFindings, 0);
  });

  it("text output reports each check's status", () => {
    const home = setupHome("text-clean", {});
    const repo = makeRepo("text-clean-repo", { class: "private-strict" });
    commit(repo, { "README.md": "x" }, "init");
    const result = withEnv("REPO_AEGIS_HOME", home, () =>
      captureOutput(() => audit({ cwd: repo })),
    );
    assert.ok(result.stdout.includes("audit:"));
    assert.ok(result.stdout.includes("marker-scan"));
    assert.ok(result.stdout.includes("lockfile"));
  });
});
