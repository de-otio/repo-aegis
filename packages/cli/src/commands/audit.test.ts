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
import { captureOutputAsync, withEnvAsync } from "../_test-utils.js";
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
  it("passes when no tracked files contain markers", async () => {
    const home = setupHome("marker-clean", { _always: ["zzznever-appears-zzz"] });
    const repo = makeRepo("marker-clean-repo", { class: "private-strict" });
    commit(repo, { "README.md": "hello" }, "init");
    const result = await withEnvAsync("REPO_AEGIS_HOME", home, () =>
      captureOutputAsync(() => audit({ cwd: repo, json: true })),
    );
    assert.equal(result.exitCode, undefined, "should not exit when clean");
    const j = JSON.parse(result.stdout) as {
      checks: { name: string; ok: boolean }[];
    };
    const m = j.checks.find(c => c.name === "marker-scan");
    assert.equal(m!.ok, true);
  });

  it("fails (exit 1) when a marker is found in a tracked file", async () => {
    const home = setupHome("marker-hit", { _always: ["leaked-string"] });
    const repo = makeRepo("marker-hit-repo", { class: "private-strict" });
    commit(repo, { "config.txt": "this contains leaked-string in plain text" }, "init");
    const result = await withEnvAsync("REPO_AEGIS_HOME", home, () =>
      captureOutputAsync(() => audit({ cwd: repo, json: true })),
    );
    assert.equal(result.exitCode, 1);
    const j = JSON.parse(result.stdout) as {
      checks: { name: string; ok: boolean; findings: { message: string }[] }[];
    };
    const m = j.checks.find(c => c.name === "marker-scan");
    assert.equal(m!.ok, false);
    assert.ok(m!.findings.some(f => f.message.includes("config.txt")));
  });

  it("can be disabled with --no-marker-scan", async () => {
    const home = setupHome("marker-skip", { _always: ["leaked-string"] });
    const repo = makeRepo("marker-skip-repo", { class: "private-strict" });
    commit(repo, { "config.txt": "leaked-string" }, "init");
    const result = await withEnvAsync("REPO_AEGIS_HOME", home, () =>
      captureOutputAsync(() => audit({ cwd: repo, json: true, markerScan: false })),
    );
    const j = JSON.parse(result.stdout) as {
      checks: { name: string }[];
    };
    assert.ok(!j.checks.some(c => c.name === "marker-scan"));
  });
});

describe("audit — lockfile", () => {
  it("skips when no package-lock.json exists", async () => {
    const home = setupHome("lockfile-none", {});
    const repo = makeRepo("lockfile-none-repo", { class: "private-strict" });
    commit(repo, { "README.md": "x" }, "init");
    const result = await withEnvAsync("REPO_AEGIS_HOME", home, () =>
      captureOutputAsync(() => audit({ cwd: repo, json: true })),
    );
    const j = JSON.parse(result.stdout) as {
      checks: { name: string; skipped?: boolean }[];
    };
    const c = j.checks.find(c => c.name === "lockfile");
    assert.equal(c!.skipped, true);
  });

  it("passes when only public registries are referenced", async () => {
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
    const result = await withEnvAsync("REPO_AEGIS_HOME", home, () =>
      captureOutputAsync(() => audit({ cwd: repo, json: true })),
    );
    const j = JSON.parse(result.stdout) as {
      checks: { name: string; ok: boolean }[];
    };
    const c = j.checks.find(c => c.name === "lockfile");
    assert.equal(c!.ok, true);
  });

  it("fails when a non-public registry URL is found", async () => {
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
    const result = await withEnvAsync("REPO_AEGIS_HOME", home, () =>
      captureOutputAsync(() => audit({ cwd: repo, json: true })),
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
  it("finds marker hits in __fixtures__ directory", async () => {
    const home = setupHome("fixtures-hit", { _always: ["fixture-leak"] });
    const repo = makeRepo("fixtures-hit-repo", { class: "private-strict" });
    mkdirSync(join(repo, "__fixtures__"), { recursive: true });
    writeFileSync(join(repo, "__fixtures__", "data.txt"), "fixture-leak embedded here");
    const result = await withEnvAsync("REPO_AEGIS_HOME", home, () =>
      captureOutputAsync(() => audit({ cwd: repo, json: true })),
    );
    assert.equal(result.exitCode, 1);
    const j = JSON.parse(result.stdout) as {
      checks: { name: string; ok: boolean; findings: { message: string }[] }[];
    };
    const c = j.checks.find(c => c.name === "fixtures");
    assert.equal(c!.ok, false);
    assert.ok(c!.findings.some(f => f.message.includes("data.txt")));
  });

  it("skips when no fixture dirs are found", async () => {
    const home = setupHome("fixtures-none", { _always: ["whatever"] });
    const repo = makeRepo("fixtures-none-repo", { class: "private-strict" });
    commit(repo, { "README.md": "x" }, "init");
    const result = await withEnvAsync("REPO_AEGIS_HOME", home, () =>
      captureOutputAsync(() => audit({ cwd: repo, json: true })),
    );
    const j = JSON.parse(result.stdout) as {
      checks: { name: string; skipped?: boolean }[];
    };
    const c = j.checks.find(c => c.name === "fixtures");
    assert.equal(c!.skipped, true);
  });
});

describe("audit — remote consistency", () => {
  it("flags scratch repo with origin remote set", async () => {
    const home = setupHome("remote-scratch", {});
    const repo = makeRepo("remote-scratch-repo", {
      class: "scratch",
      remote: "git@github.com:test/repo.git",
    });
    const result = await withEnvAsync("REPO_AEGIS_HOME", home, () =>
      captureOutputAsync(() => audit({ cwd: repo, json: true })),
    );
    assert.equal(result.exitCode, 1);
    const j = JSON.parse(result.stdout) as {
      checks: { name: string; ok: boolean; findings: { message: string }[] }[];
    };
    const c = j.checks.find(c => c.name === "remote");
    assert.equal(c!.ok, false);
  });

  it("flags customer-coupled repo without engagement id in remote", async () => {
    const home = setupHome("remote-mismatch", {});
    const repo = makeRepo("remote-mismatch-repo", {
      class: "customer-coupled",
      engagements: ["customer-a"],
      remote: "git@github.com:other-org/other-repo.git",
    });
    const result = await withEnvAsync("REPO_AEGIS_HOME", home, () =>
      captureOutputAsync(() => audit({ cwd: repo, json: true })),
    );
    assert.equal(result.exitCode, 1);
    const j = JSON.parse(result.stdout) as {
      checks: { name: string; ok: boolean }[];
    };
    const c = j.checks.find(c => c.name === "remote");
    assert.equal(c!.ok, false);
  });

  it("passes customer-coupled when engagement id is in remote", async () => {
    const home = setupHome("remote-match", {});
    const repo = makeRepo("remote-match-repo", {
      class: "customer-coupled",
      engagements: ["customer-a"],
      remote: "git@github.com:de-otio/customer-a-tooling.git",
    });
    const result = await withEnvAsync("REPO_AEGIS_HOME", home, () =>
      captureOutputAsync(() => audit({ cwd: repo, json: true })),
    );
    const j = JSON.parse(result.stdout) as {
      checks: { name: string; ok: boolean }[];
    };
    const c = j.checks.find(c => c.name === "remote");
    assert.equal(c!.ok, true);
  });
});

describe("audit — published", () => {
  it("scans an extracted tarball for marker hits", async () => {
    const home = setupHome("pub-tarball", { _always: ["leaked-secret-token"] });
    const repo = makeRepo("pub-tarball-repo", { class: "private-strict" });

    // Build a tiny tarball with a leaking file inside.
    const stage = mkdtempSync(join(tmp, "stage-"));
    mkdirSync(join(stage, "package"), { recursive: true });
    writeFileSync(join(stage, "package", "config.json"), `{"key":"leaked-secret-token"}`);
    writeFileSync(join(stage, "package", "README"), "hello world");
    const tgz = join(tmp, "pkg.tgz");
    execFileSync("tar", ["-czf", tgz, "-C", stage, "package"]);

    const result = await withEnvAsync("REPO_AEGIS_HOME", home, () =>
      captureOutputAsync(() => audit({ cwd: repo, json: true, published: tgz })),
    );
    assert.equal(result.exitCode, 1);
    const j = JSON.parse(result.stdout) as {
      checks: { name: string; ok: boolean; findings: { message: string }[] }[];
    };
    const c = j.checks.find(c => c.name === "published");
    assert.ok(c);
    assert.equal(c!.ok, false);
    assert.ok(c!.findings.some(f => f.message.includes("config.json")));
  });

  it("reports tarball-not-found cleanly", async () => {
    const home = setupHome("pub-missing", {});
    const repo = makeRepo("pub-missing-repo", { class: "private-strict" });
    const result = await withEnvAsync("REPO_AEGIS_HOME", home, () =>
      captureOutputAsync(() =>
        audit({ cwd: repo, json: true, published: join(tmp, "does-not-exist.tgz") }),
      ),
    );
    assert.equal(result.exitCode, 1);
    const j = JSON.parse(result.stdout) as {
      checks: { name: string; findings: { message: string }[] }[];
    };
    const c = j.checks.find(c => c.name === "published");
    assert.ok(c!.findings.some(f => f.message.includes("not found")));
  });

  it("refuses a tarball that contains a path-traversal entry (zip-slip)", async () => {
    const home = setupHome("pub-zipslip", { _always: ["zzz-never"] });
    const repo = makeRepo("pub-zipslip-repo", { class: "private-strict" });

    // Build a tarball whose member names traverse upward. We stage the
    // `escape.txt` file at the staging-root level so `tar -C stage`
    // followed by member `../escape.txt` resolves to a real file (the
    // member name as recorded in the archive still includes `..`).
    // GNU tar strips leading `..` on extract; BSD tar (macOS default)
    // does not. Either way our post-extraction realpath check should
    // catch the escape — or, when tar refuses extraction outright, the
    // audit emits a `tar extract failed` finding. Both are acceptable.
    const stageRoot = mkdtempSync(join(tmp, "zipslip-stageroot-"));
    const stage = join(stageRoot, "stage");
    mkdirSync(join(stage, "package"), { recursive: true });
    writeFileSync(join(stage, "package", "ok.txt"), "benign");
    writeFileSync(join(stageRoot, "escape.txt"), "I should never be extracted outside the tmp root");
    const tgz = join(tmp, "zipslip.tgz");
    execFileSync(
      "tar",
      ["-czf", tgz, "-C", stage, "package/ok.txt", "../escape.txt"],
    );

    const result = await withEnvAsync("REPO_AEGIS_HOME", home, () =>
      captureOutputAsync(() => audit({ cwd: repo, json: true, published: tgz })),
    );
    // When tar refuses (`Cannot ../escape.txt: Path is unsafe`) extraction
    // fails and we emit a `tar extract failed` finding; when tar accepts
    // and writes the file, our post-extract check catches it. Either path
    // is acceptable — the invariant is that the audit refuses the archive.
    assert.equal(result.exitCode, 1);
    const j = JSON.parse(result.stdout) as {
      checks: { name: string; ok: boolean; findings: { message: string; detail?: unknown }[] }[];
    };
    const c = j.checks.find(c => c.name === "published");
    assert.ok(c, "published check should be present");
    assert.equal(c!.ok, false);
    const refused = c!.findings.some(f => {
      const d = f.detail as { code?: string } | undefined;
      return (
        d?.code === "PUBLISHED_ARCHIVE_ESCAPE" ||
        f.message.includes("tar extract failed") ||
        f.message.includes("escapes the extraction root")
      );
    });
    assert.ok(refused, `expected refusal finding, got: ${JSON.stringify(c!.findings)}`);
  });
});

describe("audit — org", () => {
  it("reports missing token cleanly when --org is set without GH_TOKEN", async () => {
    const home = setupHome("org-no-token", { _always: ["acme-something"] });
    // Set up registry for loadRegistry()
    writeFileSync(
      join(home, "engagements.yaml"),
      `always_block: ["acme-something"]\nengagements: []\n`,
    );
    const repo = makeRepo("org-no-token-repo", { class: "private-strict" });
    const env = { ...process.env };
    delete env["GH_TOKEN"];
    const prev = process.env["GH_TOKEN"];
    delete process.env["GH_TOKEN"];
    try {
      const result = await withEnvAsync("REPO_AEGIS_HOME", home, () =>
        captureOutputAsync(() => audit({ cwd: repo, json: true, org: "fake-org" })),
      );
      const j = JSON.parse(result.stdout) as {
        checks: { name: string; findings: { message: string }[] }[];
      };
      const c = j.checks.find(c => c.name === "org-scan");
      assert.ok(c);
      assert.ok(c!.findings.some(f => f.message.includes("env var is not set")));
    } finally {
      if (prev !== undefined) process.env["GH_TOKEN"] = prev;
    }
  });
});

describe("audit — composite", () => {
  it("exits 0 when all enabled checks pass", async () => {
    const home = setupHome("all-clean", { _always: ["zzz-never-appears-zzz"] });
    const repo = makeRepo("all-clean-repo", {
      class: "private-strict",
      remote: "git@github.com:test/repo.git",
    });
    commit(repo, { "README.md": "nothing-suspicious" }, "init");
    const result = await withEnvAsync("REPO_AEGIS_HOME", home, () =>
      captureOutputAsync(() => audit({ cwd: repo, json: true })),
    );
    assert.equal(result.exitCode, undefined);
    const j = JSON.parse(result.stdout) as {
      summary: { run: number; failed: number; totalFindings: number };
    };
    assert.equal(j.summary.failed, 0);
    assert.equal(j.summary.totalFindings, 0);
  });

  it("text output reports each check's status", async () => {
    const home = setupHome("text-clean", {});
    const repo = makeRepo("text-clean-repo", { class: "private-strict" });
    commit(repo, { "README.md": "x" }, "init");
    const result = await withEnvAsync("REPO_AEGIS_HOME", home, () =>
      captureOutputAsync(() => audit({ cwd: repo })),
    );
    assert.ok(result.stdout.includes("audit:"));
    assert.ok(result.stdout.includes("marker-scan"));
    assert.ok(result.stdout.includes("lockfile"));
  });
});
