// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { captureOutputAsync, withEnvAsync } from "../_test-utils.js";
import { audit, movedNetworkAuditCommand, __testCreateFileCache } from "./audit.js";
import { installHooks } from "./install-hooks.js";

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
    // hooksCheck: false — this fixture is a bare `git init`, never
    // `install hooks`; the H2 hooks check is unrelated to what this
    // test exercises and would otherwise fail every fresh fixture,
    // exactly as it would on a CI runner (see install-ci.ts).
    const result = await withEnvAsync("REPO_AEGIS_HOME", home, () =>
      captureOutputAsync(() => audit({ cwd: repo, json: true, hooksCheck: false })),
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

describe("audit — registry-egress", () => {
  const PRIVATE = "https://npm.private-registry.example.com/foo/-/foo-1.0.0.tgz";
  const PUBLIC = "https://registry.npmjs.org/foo/-/foo-1.0.0.tgz";
  const lockWith = (url: string): string =>
    JSON.stringify({ packages: { "node_modules/foo": { resolved: url } } });

  it("SKIPS on a non-public-facing repo (private-registry URLs are intended)", async () => {
    const home = setupHome("egress-private-repo", {});
    const repo = makeRepo("egress-private-repo", { class: "private-strict" });
    commit(repo, { "package-lock.json": lockWith(PRIVATE) }, "init");
    // hooksCheck: false — unrelated to registry-egress; see comment on
    // the marker-scan "passes when clean" test above.
    const result = await withEnvAsync("REPO_AEGIS_HOME", home, () =>
      captureOutputAsync(() => audit({ cwd: repo, json: true, hooksCheck: false })),
    );
    assert.equal(result.exitCode ?? 0, 0);
    const j = JSON.parse(result.stdout) as { checks: { name: string; skipped?: boolean }[] };
    const c = j.checks.find(c => c.name === "registry-egress");
    assert.equal(c!.skipped, true);
  });

  it("passes when a public-eligible repo references only public registries", async () => {
    const home = setupHome("egress-public-ok", {});
    const repo = makeRepo("egress-public-ok-repo", { class: "public-eligible" });
    commit(repo, { "package-lock.json": lockWith(PUBLIC) }, "init");
    const result = await withEnvAsync("REPO_AEGIS_HOME", home, () =>
      captureOutputAsync(() => audit({ cwd: repo, json: true })),
    );
    const j = JSON.parse(result.stdout) as { checks: { name: string; ok: boolean; skipped?: boolean }[] };
    const c = j.checks.find(c => c.name === "registry-egress");
    assert.equal(c!.skipped ?? false, false);
    assert.equal(c!.ok, true);
  });

  it("fails when a public-eligible repo references a non-public registry (lock + .npmrc)", async () => {
    const home = setupHome("egress-public-bad", {});
    const repo = makeRepo("egress-public-bad-repo", { class: "public-eligible" });
    commit(
      repo,
      {
        "package-lock.json": lockWith(PRIVATE),
        ".npmrc": "registry=https://npm.private-registry.example.com/\n",
      },
      "init",
    );
    const result = await withEnvAsync("REPO_AEGIS_HOME", home, () =>
      captureOutputAsync(() => audit({ cwd: repo, json: true })),
    );
    assert.equal(result.exitCode, 1);
    const j = JSON.parse(result.stdout) as {
      checks: { name: string; ok: boolean; findings: { message: string }[] }[];
    };
    const c = j.checks.find(c => c.name === "registry-egress");
    assert.equal(c!.ok, false);
    assert.ok(c!.findings.some(f => f.message.includes("npm.private-registry.example.com")));
    // Both the lockfile and the .npmrc are flagged (broadened scope).
    assert.ok(c!.findings.some(f => f.message.includes("package-lock.json")));
    assert.ok(c!.findings.some(f => f.message.includes(".npmrc")));
  });

  it("enforces on a private-strict repo whose cached visibility is public (safety net)", async () => {
    const home = setupHome("egress-misclassified", {});
    const repo = makeRepo("egress-misclassified-repo", { class: "private-strict" });
    execFileSync("git", ["config", "repo-aegis.visibility", "public"], { cwd: repo });
    commit(repo, { "package-lock.json": lockWith(PRIVATE) }, "init");
    const result = await withEnvAsync("REPO_AEGIS_HOME", home, () =>
      captureOutputAsync(() => audit({ cwd: repo, json: true })),
    );
    assert.equal(result.exitCode, 1);
    const j = JSON.parse(result.stdout) as { checks: { name: string; ok: boolean }[] };
    const c = j.checks.find(c => c.name === "registry-egress");
    assert.equal(c!.ok, false);
  });
});

describe("audit — visibility reconciliation", () => {
  it("skips when GitHub visibility is not cached", async () => {
    const home = setupHome("vis-uncached", {});
    const repo = makeRepo("vis-uncached-repo", { class: "private-strict" });
    commit(repo, { "README.md": "x" }, "init");
    const result = await withEnvAsync("REPO_AEGIS_HOME", home, () =>
      captureOutputAsync(() => audit({ cwd: repo, json: true })),
    );
    const j = JSON.parse(result.stdout) as { checks: { name: string; skipped?: boolean }[] };
    assert.equal(j.checks.find(c => c.name === "visibility")!.skipped, true);
  });

  it("flags a GitHub-public repo left at the private-strict default", async () => {
    const home = setupHome("vis-mismatch", {});
    const repo = makeRepo("vis-mismatch-repo", { class: "private-strict" });
    execFileSync("git", ["config", "repo-aegis.visibility", "public"], { cwd: repo });
    commit(repo, { "README.md": "x" }, "init");
    const result = await withEnvAsync("REPO_AEGIS_HOME", home, () =>
      captureOutputAsync(() => audit({ cwd: repo, json: true })),
    );
    assert.equal(result.exitCode, 1);
    const j = JSON.parse(result.stdout) as {
      checks: { name: string; ok: boolean; findings: { message: string }[] }[];
    };
    const c = j.checks.find(c => c.name === "visibility");
    assert.equal(c!.ok, false);
    assert.ok(c!.findings.some(f => f.message.includes("public-eligible")));
  });
});

interface AuditJson {
  checks: {
    name: string;
    ok: boolean;
    skipped?: boolean;
    findings: { message: string; informational?: boolean }[];
  }[];
  summary: { informationalFindings?: number };
}

describe("audit — fixtures", () => {
  it("reports an `_always` hit in __fixtures__ INFORMATIONALLY (seen, not fatal)", async () => {
    // `__fixtures__` is one of the paths the deny set exempts for the
    // `_always` class, so `check` and the hooks skip it. `audit` still runs
    // the full pattern set and shows the hit — an exemption nobody can see
    // is an exemption nobody reviews — but it does not flip `ok`, so `audit`
    // and `check` agree on exit status.
    const home = setupHome("fixtures-hit", { _always: ["fixture-leak"] });
    const repo = makeRepo("fixtures-hit-repo", { class: "private-strict" });
    mkdirSync(join(repo, "__fixtures__"), { recursive: true });
    writeFileSync(join(repo, "__fixtures__", "data.txt"), "fixture-leak embedded here");
    const result = await withEnvAsync("REPO_AEGIS_HOME", home, () =>
      captureOutputAsync(() => audit({ cwd: repo, json: true, hooksCheck: false })),
    );
    assert.equal(result.exitCode, undefined, "an exempt-path _always hit must not fail audit");
    const j = JSON.parse(result.stdout) as AuditJson;
    const c = j.checks.find(c => c.name === "fixtures");
    assert.equal(c!.ok, true);
    const f = c!.findings.find(f => f.message.includes("data.txt"));
    assert.ok(f, "the hit is still reported");
    assert.equal(f!.informational, true);
    assert.equal(j.summary.informationalFindings, 1);
  });

  it("an ENGAGEMENT marker in __fixtures__ is still a hard failure", async () => {
    // The load-bearing asymmetry: a secret shape in a fixture is a throwaway
    // by construction, a customer name in a fixture is a leak either way.
    const home = setupHome("fixtures-eng", {
      _always: ["zzznever-appears-zzz"],
      "customer-z": ["zetaquadrant"],
    });
    const repo = makeRepo("fixtures-eng-repo", { class: "private-strict" });
    mkdirSync(join(repo, "__fixtures__"), { recursive: true });
    writeFileSync(join(repo, "__fixtures__", "data.txt"), "owned by zetaquadrant");
    const result = await withEnvAsync("REPO_AEGIS_HOME", home, () =>
      captureOutputAsync(() => audit({ cwd: repo, json: true, hooksCheck: false })),
    );
    assert.equal(result.exitCode, 1);
    const j = JSON.parse(result.stdout) as AuditJson;
    const c = j.checks.find(c => c.name === "fixtures");
    assert.equal(c!.ok, false);
    assert.ok(c!.findings.every(f => f.informational !== true));
  });

  it("a `_private_infra` host in a fixture of a public-facing repo is still a hard failure", async () => {
    // A private registry host in a public repo's fixture is exactly the leak
    // the private-infra class exists to stop; the fixture directory is not a
    // safe home for it the way it is for a throwaway keypair.
    const home = setupHome("fixtures-infra", {
      _always: ["zzznever-appears-zzz"],
      _private_infra: ["registry\\.internal\\.invalid"],
    });
    const repo = makeRepo("fixtures-infra-repo", { class: "public-eligible" });
    mkdirSync(join(repo, "fixtures"), { recursive: true });
    writeFileSync(
      join(repo, "fixtures", "npmrc.sample"),
      "registry=https://registry.internal.invalid/",
    );
    const result = await withEnvAsync("REPO_AEGIS_HOME", home, () =>
      captureOutputAsync(() =>
        audit({ cwd: repo, json: true, hooksCheck: false, remoteCheck: false }),
      ),
    );
    assert.equal(result.exitCode, 1);
    const j = JSON.parse(result.stdout) as AuditJson;
    const c = j.checks.find(c => c.name === "fixtures");
    assert.equal(c!.ok, false);
    assert.ok(c!.findings.every(f => f.informational !== true));
  });

  it("marker-scan applies the same demotion to a tracked *.test.* file", async () => {
    // marker-scan sweeps every tracked file, including test sources that the
    // deny set exempts for the `_always` class. Hard-failing there would make
    // `audit` contradict `check` and render the exemption useless in CI.
    const home = setupHome("markerscan-exempt", {
      _always: ["fixture-leak"],
      "customer-z": ["zetaquadrant"],
    });
    const repo = makeRepo("markerscan-exempt-repo", { class: "private-strict" });
    commit(repo, { "thing.test.ts": "const k = 'fixture-leak';\n" }, "init");
    const result = await withEnvAsync("REPO_AEGIS_HOME", home, () =>
      captureOutputAsync(() => audit({ cwd: repo, json: true, hooksCheck: false })),
    );
    assert.equal(result.exitCode, undefined);
    const j = JSON.parse(result.stdout) as AuditJson;
    const c = j.checks.find(c => c.name === "marker-scan");
    assert.equal(c!.ok, true);
    const f = c!.findings.find(f => f.message.includes("thing.test.ts"));
    assert.ok(f, "still reported");
    assert.equal(f!.informational, true);
  });

  it("marker-scan does NOT demote an engagement marker in a *.test.* file", async () => {
    const home = setupHome("markerscan-eng", {
      _always: ["zzznever-appears-zzz"],
      "customer-z": ["zetaquadrant"],
    });
    const repo = makeRepo("markerscan-eng-repo", { class: "private-strict" });
    commit(repo, { "thing.test.ts": "// owned by zetaquadrant\n" }, "init");
    const result = await withEnvAsync("REPO_AEGIS_HOME", home, () =>
      captureOutputAsync(() => audit({ cwd: repo, json: true, hooksCheck: false })),
    );
    assert.equal(result.exitCode, 1);
    const j = JSON.parse(result.stdout) as AuditJson;
    const c = j.checks.find(c => c.name === "marker-scan");
    assert.equal(c!.ok, false);
  });

  it("an `_always` hit OUTSIDE an exempt path stays a hard failure", async () => {
    const home = setupHome("fixtures-src", { _always: ["fixture-leak"] });
    const repo = makeRepo("fixtures-src-repo", { class: "private-strict" });
    commit(repo, { "prod.ts": "const k = 'fixture-leak';\n" }, "init");
    const result = await withEnvAsync("REPO_AEGIS_HOME", home, () =>
      captureOutputAsync(() => audit({ cwd: repo, json: true, hooksCheck: false })),
    );
    assert.equal(result.exitCode, 1);
    const j = JSON.parse(result.stdout) as AuditJson;
    const c = j.checks.find(c => c.name === "marker-scan");
    assert.equal(c!.ok, false);
    assert.ok(c!.findings.every(f => f.informational !== true));
  });

  it("no exemptions at all when the registry declares an empty list", async () => {
    // `alwaysBlockExemptPaths: []` means "exempt nothing" — distinct from the
    // key being absent, which selects the built-in default set.
    const home = setupHome("fixtures-noexempt", { _always: ["fixture-leak"] });
    writeFileSync(
      join(home, "engagements.yaml"),
      "schemaVersion: 2\nalwaysBlockExemptPaths: []\nengagements: []\n",
    );
    const repo = makeRepo("fixtures-noexempt-repo", { class: "private-strict" });
    mkdirSync(join(repo, "__fixtures__"), { recursive: true });
    writeFileSync(join(repo, "__fixtures__", "data.txt"), "fixture-leak embedded here");
    const result = await withEnvAsync("REPO_AEGIS_HOME", home, () =>
      captureOutputAsync(() => audit({ cwd: repo, json: true, hooksCheck: false })),
    );
    assert.equal(result.exitCode, 1);
    const j = JSON.parse(result.stdout) as AuditJson;
    const c = j.checks.find(c => c.name === "fixtures");
    assert.equal(c!.ok, false);
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

// `--ignore-allowlist-comments` on `audit`.
//
// Added because the generated `strict` CI profile passed it (and
// `--ignore-waivers`) to `audit`, which declared neither — so Commander exited
// 1 with "unknown option" and the whole strict profile had never run. The
// profile's entire purpose is showing what the day-to-day gate suppresses, so
// the flag needed implementing, not deleting.
//
// There is deliberately no `--ignore-waivers` counterpart: `audit` never
// applies waivers at all (unlike `check`), so it is already strict there and a
// flag to "turn off" something never applied would be a lie in --help.
describe("audit --ignore-allowlist-comments", () => {
  const MARKER = "zqx-allowcomment-marker";

  function repoWithSuppressedHit(name: string): { home: string; repo: string } {
    const home = setupHome(`${name}-home`, { _always: [MARKER] });
    const repo = makeRepo(name, { class: "private-strict" });
    // The marker plus an allow comment on the same line — the suppression
    // `scanText` honours by default.
    commit(repo, { "notes.txt": `token = ${MARKER}  # repo-aegis: allow — reviewed\n` }, "add");
    return { home, repo };
  }

  it("is suppressed by default: audit passes", async () => {
    const { home, repo } = repoWithSuppressedHit("allowcomment-default");
    const result = await withEnvAsync("REPO_AEGIS_HOME", home, () =>
      captureOutputAsync(() =>
        audit({ cwd: repo, json: true, remoteCheck: false, hooksCheck: false }),
      ),
    );
    assert.equal(result.exitCode, undefined, result.stdout);
    const j = JSON.parse(result.stdout) as { checks: { name: string; ok: boolean }[] };
    assert.equal(j.checks.find(c => c.name === "marker-scan")!.ok, true);
  });

  it("with the flag, the suppressed hit is reported and audit fails", async () => {
    const { home, repo } = repoWithSuppressedHit("allowcomment-strict");
    const result = await withEnvAsync("REPO_AEGIS_HOME", home, () =>
      captureOutputAsync(() =>
        audit({
          cwd: repo,
          json: true,
          remoteCheck: false,
          hooksCheck: false,
          ignoreAllowlistComments: true,
        }),
      ),
    );
    assert.equal(result.exitCode, 1, result.stdout);
    const j = JSON.parse(result.stdout) as {
      checks: { name: string; ok: boolean; findings: { message: string }[] }[];
    };
    const marker = j.checks.find(c => c.name === "marker-scan")!;
    assert.equal(marker.ok, false);
    assert.ok(
      marker.findings.some(f => f.message.includes("notes.txt")),
      `expected a notes.txt finding, got ${JSON.stringify(marker.findings)}`,
    );
    // The literal marker must not be echoed — no --verbose was passed.
    assert.ok(!result.stdout.includes(MARKER), "audit must not echo the matched marker");
  });
});

describe("audit — file-read deduplication", () => {
  it("FileCache reads each unique file at most once across repeated load() calls", () => {
    // Direct unit test of the cache primitive used by audit() to share
    // file content across marker-scan, lockfile, and fixture-check.
    const dir = mkdtempSync(join(tmp, "dedupe-cache-"));
    const f = join(dir, "shared.txt");
    writeFileSync(f, "hello world\n");
    const cache = __testCreateFileCache(dir);
    const a = cache.load(f, { mustBeUnderTree: true });
    const b = cache.load(f, { mustBeUnderTree: true });
    assert.equal(a.kind, "ok");
    assert.equal(b.kind, "ok");
    assert.equal(a.text, b.text);
    assert.equal(
      cache.readCount,
      1,
      "second load() of the same path must not re-read from disk",
    );
    // Path-aliasing via realpath: the cache should also dedupe when
    // the same realpath is reached from a symlink. (We cover this only
    // in the trivial "same string" case here; symlink coverage lives
    // in the broader scan tests.)
  });

  it("FileCache scans the same path under multiple checks reusing one buffer", () => {
    // Simulate the "tracked + in-fixture-dir + lockfile" overlap
    // scenario. Three load() calls against the same path must trigger
    // exactly one disk read; the kind/text returned must be stable
    // across calls so each check sees the same content.
    const dir = mkdtempSync(join(tmp, "dedupe-multi-"));
    const fpath = join(dir, "package-lock.json");
    writeFileSync(fpath, '{"packages":{}}\n');
    const cache = __testCreateFileCache(dir);
    const v1 = cache.load(fpath); // simulating lockfile check
    const v2 = cache.load(fpath); // simulating marker-scan
    const v3 = cache.load(fpath, { mustBeUnderTree: true }); // simulating fixture
    assert.equal(v1.kind, "ok");
    assert.equal(v2.kind, "ok");
    assert.equal(v3.kind, "ok");
    assert.equal(v1.text, v2.text);
    assert.equal(v2.text, v3.text);
    assert.equal(
      cache.readCount,
      1,
      "three checks against the same path must share one read",
    );
  });
});

// H2/H6: a repo-local core.hooksPath pointing at an empty (or foreign)
// directory silently disables scanning, and a hook that never runs
// cannot report itself — `audit` is the gate that must catch this.
//
// SAFETY: `resolveHookState` reads whichever core.hooksPath git
// resolves to, including the *global* scope — and this machine's real
// ~/.gitconfig has repo-aegis's own core.hooksPath set globally (this
// repo is itself repo-aegis-managed). Every test below runs via
// `withHooksIsolationAsync`, which redirects GIT_CONFIG_GLOBAL/SYSTEM
// to /dev/null in addition to REPO_AEGIS_HOME, so results depend only
// on this fixture's local git config — never the developer's real
// global config. Same pattern as packages/core/src/hooks-state.test.ts.
async function withHooksIsolationAsync<T>(home: string, fn: () => Promise<T> | T): Promise<T> {
  const overrides: Record<string, string> = {
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    REPO_AEGIS_HOME: home,
  };
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(overrides)) {
    prev[k] = process.env[k];
    process.env[k] = overrides[k]!;
  }
  try {
    return await fn();
  } finally {
    for (const k of Object.keys(overrides)) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
}

describe("audit — hooks (H2)", () => {
  it("healthy hooks install -> hooks check passes, exit 0", async () => {
    const home = setupHome("hooks-ok", {});
    const repo = makeRepo("hooks-ok-repo", { class: "private-strict" });
    await withHooksIsolationAsync(home, async () => {
      // `local: true` is required: the default is now a GLOBAL write, and the
      // isolation helper points GIT_CONFIG_GLOBAL at /dev/null, which git
      // cannot lock. Local scope yields the same healthy effective state.
      installHooks({ cwd: repo, silent: true, local: true });
      const result = await captureOutputAsync(() => audit({ cwd: repo, json: true }));
      assert.equal(result.exitCode, undefined);
      const j = JSON.parse(result.stdout) as { checks: { name: string; ok: boolean }[] };
      const c = j.checks.find(c => c.name === "hooks");
      assert.ok(c, "expected a hooks check in the results");
      assert.equal(c!.ok, true);
    });
  });

  it("local core.hooksPath pointing at an empty foreign dir -> hooks check fails, exit 1", async () => {
    const home = setupHome("hooks-foreign", {});
    const repo = makeRepo("hooks-foreign-repo", { class: "private-strict" });
    const foreignDir = join(tmp, "audit-hooks-foreign-empty");
    mkdirSync(foreignDir, { recursive: true });
    await withHooksIsolationAsync(home, async () => {
      execFileSync("git", ["config", "core.hooksPath", foreignDir], { cwd: repo });
      const result = await captureOutputAsync(() => audit({ cwd: repo, json: true }));
      assert.equal(result.exitCode, 1);
      const j = JSON.parse(result.stdout) as {
        checks: { name: string; ok: boolean; findings: { detail?: { code?: string } }[] }[];
      };
      const c = j.checks.find(c => c.name === "hooks");
      assert.ok(c, "expected a hooks check in the results");
      assert.equal(c!.ok, false);
      // No global core.hooksPath is visible in this isolated fixture
      // (only a repo-local override to a bare dir), so there is no
      // "correctly configured global" being shadowed —
      // HOOKS_PATH_FOREIGN, not HOOKS_PATH_LOCAL_OVERRIDE. See
      // hooks-state.ts for the distinction.
      assert.ok(c!.findings.some(f => f.detail?.code === "HOOKS_PATH_FOREIGN"));
    });
  });

  it("--no-hooks-check suppresses the hooks check entirely", async () => {
    const home = setupHome("hooks-disabled", {});
    const repo = makeRepo("hooks-disabled-repo", { class: "private-strict" });
    const foreignDir = join(tmp, "audit-hooks-disabled-empty");
    mkdirSync(foreignDir, { recursive: true });
    await withHooksIsolationAsync(home, async () => {
      execFileSync("git", ["config", "core.hooksPath", foreignDir], { cwd: repo });
      const result = await captureOutputAsync(() =>
        audit({ cwd: repo, json: true, hooksCheck: false }),
      );
      const j = JSON.parse(result.stdout) as { checks: { name: string }[] };
      assert.ok(!j.checks.some(c => c.name === "hooks"));
      // Nothing else in this fixture fails, so with hooks suppressed
      // the run is clean — confirms the flag actually removes the
      // check rather than just marking it ok.
      assert.equal(result.exitCode, undefined);
    });
  });

  it("[H6] appends an observe-hooks audit record when audit-log is enabled, independent of --no-hooks-check", async () => {
    const home = setupHome("hooks-auditlog", {});
    // Enable audit-log directly via its on-disk config shape
    // (state/audit-log.json), mirroring what `repo-aegis audit-log on`
    // writes, without depending on that command's implementation.
    writeFileSync(join(home, "state", "audit-log.json"), JSON.stringify({ enabled: true }));
    const repo = makeRepo("hooks-auditlog-repo", { class: "private-strict" });
    await withHooksIsolationAsync(home, async () => {
      // hooksCheck: false deliberately: H6's observation is independent
      // of whether the check gates the run, so this also proves the
      // record still gets written when the check itself is disabled.
      await captureOutputAsync(() => audit({ cwd: repo, json: true, hooksCheck: false }));

      const logPath = join(home, "state", "audit.log");
      const lines = readFileSync(logPath, "utf8").trim().split("\n");
      const records = lines.map(
        l => JSON.parse(l) as { action: string; details?: { code?: string; ok?: boolean } },
      );
      const rec = records.find(r => r.action === "observe-hooks");
      assert.ok(rec, "expected an observe-hooks record in the audit log");
      // Isolated fixture: core.hooksPath is unset in every visible scope.
      assert.equal(rec!.details?.code, "HOOKS_PATH_UNSET");
      assert.equal(rec!.details?.ok, false);
    });
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
    // hooksCheck: false — this fixture is a bare `git init`, so H2's
    // hooks-liveness check would fail here even though nothing this
    // test cares about is wrong; see the H2 hooks describe block below
    // for that check's own coverage.
    const result = await withEnvAsync("REPO_AEGIS_HOME", home, () =>
      captureOutputAsync(() => audit({ cwd: repo, json: true, hooksCheck: false })),
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
    assert.ok(result.stdout.includes("registry-egress"));
  });
});

// `--org` and `--published` moved to `repo-aegis-scan audit` (network work is
// off the gate path). For one release the old flags still parse and answer with
// the exact replacement command and exit 2 — a workflow that still passes them
// must fail loudly, not run a local-only audit and report green.
describe("audit — moved network flags", () => {
  it("--org exits 2 and names the exact replacement command", async () => {
    const home = setupHome("moved-org", { _always: ["zzz-never-appears-zzz"] });
    const repo = makeRepo("moved-org-repo", { class: "private-strict" });
    const result = await withEnvAsync("REPO_AEGIS_HOME", home, () =>
      captureOutputAsync(() => audit({ cwd: repo, org: "example-org" })),
    );
    assert.equal(result.exitCode, 2);
    assert.equal(result.stdout, "", "no check may run, so no result may be printed");
    assert.ok(
      result.stderr.includes("moved to `repo-aegis-scan audit --org example-org --cwd " + repo + "`"),
      result.stderr,
    );
  });

  it("carries every flag the new command understands, in the same spelling", () => {
    assert.equal(
      movedNetworkAuditCommand({
        org: "example-org",
        acceptCrossBorder: true,
        maxQueries: 30,
        token: "SEARCH_TOKEN",
        minPatterns: 2,
        redactAttribution: true,
        json: true,
      }),
      "repo-aegis-scan audit --org example-org --token SEARCH_TOKEN --max-queries 30 " +
        "--accept-cross-border --min-patterns 2 --redact-attribution --json",
    );
    assert.equal(
      movedNetworkAuditCommand({ published: "dist/pkg-1.0.0.tgz", secretScan: false, requireDenySet: true }),
      "repo-aegis-scan audit --published dist/pkg-1.0.0.tgz --no-secret-scan --require-deny-set",
    );
  });

  it("shell-quotes values that need it, so the printed command can be pasted", () => {
    assert.equal(
      movedNetworkAuditCommand({ published: "my dir/it's.tgz" }),
      "repo-aegis-scan audit --published 'my dir/it'\\''s.tgz'",
    );
  });

  it("--published exits 2 in --json mode with a machine-readable code on stderr", async () => {
    const home = setupHome("moved-pub", {});
    const repo = makeRepo("moved-pub-repo", { class: "private-strict" });
    const result = await withEnvAsync("REPO_AEGIS_HOME", home, () =>
      captureOutputAsync(() => audit({ cwd: repo, json: true, published: "pkg.tgz" })),
    );
    assert.equal(result.exitCode, 2);
    assert.equal(result.stdout, "");
    const err = JSON.parse(result.stderr) as { code: string; error: string };
    assert.equal(err.code, "AUDIT_NETWORK_MOVED");
    assert.match(err.error, /moved to `repo-aegis-scan audit --published pkg\.tgz/);
  });

  it("the local audit is untouched: no moved flag means no refusal", async () => {
    assert.equal(movedNetworkAuditCommand({}), null);
    // `--no-secret-scan` / `--token` alone were no-ops before the move and stay so.
    assert.equal(movedNetworkAuditCommand({ secretScan: false, token: "T", maxQueries: 3 }), null);
    const home = setupHome("moved-none", { _always: ["zzz-never-appears-zzz"] });
    const repo = makeRepo("moved-none-repo", { class: "private-strict" });
    commit(repo, { "README.md": "ok" }, "init");
    const result = await withEnvAsync("REPO_AEGIS_HOME", home, () =>
      captureOutputAsync(() => audit({ cwd: repo, json: true, hooksCheck: false })),
    );
    assert.equal(result.exitCode, undefined, result.stdout);
  });

  it("is wired through the real bin: `repo-aegis audit --org x` exits 2", () => {
    const bin = join(dirname(fileURLToPath(import.meta.url)), "..", "index.js");
    const home = setupHome("moved-bin", {});
    const repo = makeRepo("moved-bin-repo", { class: "private-strict" });
    const r = spawnSync(process.execPath, [bin, "audit", "--org", "example-org", "--cwd", repo], {
      encoding: "utf8",
      env: { ...process.env, REPO_AEGIS_HOME: home },
    });
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /moved to `repo-aegis-scan audit --org example-org/);
    const help = spawnSync(process.execPath, [bin, "audit", "--help"], { encoding: "utf8" });
    assert.ok(!help.stdout.includes("--org"), "moved flags are hidden from --help");
  });
});
