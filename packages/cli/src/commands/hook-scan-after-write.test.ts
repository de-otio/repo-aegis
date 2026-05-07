// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cliBuilt, runCli } from "../_subprocess-utils.js";

let tmp: string;

before(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "repo-aegis-hook-scan-test-")));
});

after(() => {
  rmSync(tmp, { recursive: true, force: true });
});

interface Env {
  aegisHome: string;
  cwd: string;
}

function setupAegisHome(name: string): Env {
  const aegisHome = join(tmp, `${name}-aegis`);
  mkdirSync(join(aegisHome, "markers"), { recursive: true });
  mkdirSync(join(aegisHome, "state"), { recursive: true });
  return { aegisHome, cwd: tmp };
}

function writeRegistry(
  aegisHome: string,
  yaml: string,
): void {
  writeFileSync(join(aegisHome, "engagements.yaml"), yaml);
}

function writeMarker(aegisHome: string, stem: string, body: string): void {
  writeFileSync(join(aegisHome, "markers", `${stem}.txt`), body);
}

function makeGitRepo(
  parent: string,
  name: string,
  opts: { remote?: string; class?: string; engagements?: string[] } = {},
): string {
  const dir = join(parent, name);
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

const SUBPROCESS_TESTS_AVAILABLE = cliBuilt();

describe("hook scan-after-write", { skip: !SUBPROCESS_TESTS_AVAILABLE }, () => {
  it("exits 0 silently when stdin is empty", () => {
    const env = setupAegisHome("empty-stdin");
    const r = runCli(env.aegisHome, env.cwd, ["hook", "scan-after-write"], {
      input: "",
    });
    assert.equal(r.code, 0);
    assert.equal(r.stdout, "");
  });

  it("exits 0 silently when JSON has no tool_input.file_path", () => {
    const env = setupAegisHome("no-path");
    const r = runCli(env.aegisHome, env.cwd, ["hook", "scan-after-write"], {
      input: '{"tool_name":"Bash"}',
    });
    assert.equal(r.code, 0);
    assert.equal(r.stdout, "");
  });

  it("exits 0 silently when the file_path does not exist", () => {
    const env = setupAegisHome("missing-file");
    const r = runCli(env.aegisHome, env.cwd, ["hook", "scan-after-write"], {
      input: JSON.stringify({ tool_input: { file_path: "/nonexistent/abc/xyz" } }),
    });
    assert.equal(r.code, 0);
    assert.equal(r.stdout, "");
  });

  it("exits 0 silently on unparseable JSON", () => {
    const env = setupAegisHome("bad-json");
    const r = runCli(env.aegisHome, env.cwd, ["hook", "scan-after-write"], {
      input: "this is not json {{{",
    });
    assert.equal(r.code, 0);
    assert.equal(r.stdout, "");
  });

  it("falls back to tool_input.path for older payload shapes", () => {
    const env = setupAegisHome("legacy-shape");
    const probe = join(tmp, "legacy-probe.txt");
    writeFileSync(probe, "innocuous");
    const r = runCli(env.aegisHome, env.cwd, ["hook", "scan-after-write"], {
      input: JSON.stringify({ tool_input: { path: probe } }),
    });
    const json = r.json as { status: string };
    assert.equal(json.status, "no-deny-set");
  });

  it("emits clean JSON when a real file_path is supplied with no deny set", () => {
    const env = setupAegisHome("clean");
    const probe = join(tmp, "clean-probe.txt");
    writeFileSync(probe, "nothing of interest");
    const r = runCli(env.aegisHome, env.cwd, ["hook", "scan-after-write"], {
      input: JSON.stringify({ tool_input: { file_path: probe } }),
    });
    const json = r.json as { status: string };
    assert.equal(json.status, "no-deny-set");
  });
});

describe("hook scan-after-write: path-aware (cross-tree)", { skip: !SUBPROCESS_TESTS_AVAILABLE }, () => {
  it("scans dest's deny-set when src and dest share an engagement org", () => {
    const env = setupAegisHome("xtree-same-org");
    writeRegistry(
      env.aegisHome,
      `schemaVersion: 2
engagements:
  - id: alpha
    name: Alpha
    githubOrgs: [alpha-org]
    markers: []
always_block:
  - "globally-banned-token"
`,
    );
    writeMarker(env.aegisHome, "_always", "globally-banned-token\n");
    const src = makeGitRepo(tmp, "xtree-src-A", {
      remote: "git@github.com:alpha-org/src.git",
      class: "customer-coupled",
      engagements: ["alpha"],
    });
    const dest = makeGitRepo(tmp, "xtree-dest-A", {
      remote: "git@github.com:alpha-org/dest.git",
      class: "customer-coupled",
      engagements: ["alpha"],
    });
    const file = join(dest, "leak.ts");
    writeFileSync(file, "let x = 'globally-banned-token';\n");
    const r = runCli(env.aegisHome, src, ["hook", "scan-after-write"], {
      input: JSON.stringify({ tool_input: { file_path: file } }),
    });
    // Dest's deny-set caught the _always-banned token — exit 1.
    assert.equal(r.code, 1);
    const json = r.json as { hits: Array<{ engagement: string }> };
    assert.equal(json.hits.length, 1);
    assert.equal(json.hits[0]!.engagement, "_always");
  });

  it("emits CROSS_ORG_WRITE (defence-in-depth) when src and dest have disjoint orgs", () => {
    // As of v0.3.0, genuine prevention of cross-org writes is handled
    // by the PreToolUse `hook check-write`. This PostToolUse path is
    // retained as defence-in-depth for installs that predate v0.3.0
    // and have not re-run `install claude-md` to pick up the
    // PreToolUse registration. The runtime contract (exit 2 +
    // CROSS_ORG_WRITE payload + srcOrgs/destOrgs detail) is preserved
    // so existing agents handle this case unchanged.
    //
    // The test fixture pre-creates the file (writeFileSync below) to
    // exercise the PostToolUse code path exactly as it would run in
    // the real world: the file is already on disk by the time the
    // hook fires. The corresponding hook-check-write test asserts
    // the inverse — that the PreToolUse hook can refuse without the
    // file existing.
    const env = setupAegisHome("xtree-cross-org");
    writeRegistry(
      env.aegisHome,
      `schemaVersion: 2
engagements:
  - id: alpha
    name: Alpha
    githubOrgs: [alpha-org]
    markers: []
  - id: beta
    name: Beta
    githubOrgs: [beta-org]
    markers: []
`,
    );
    const src = makeGitRepo(tmp, "xtree-src-B", {
      remote: "git@github.com:alpha-org/src.git",
      class: "customer-coupled",
      engagements: ["alpha"],
    });
    const dest = makeGitRepo(tmp, "xtree-dest-B", {
      remote: "git@github.com:beta-org/dest.git",
      class: "customer-coupled",
      engagements: ["beta"],
    });
    const file = join(dest, "f.ts");
    writeFileSync(file, "x");
    const r = runCli(env.aegisHome, src, ["hook", "scan-after-write"], {
      input: JSON.stringify({ tool_input: { file_path: file } }),
    });
    assert.equal(r.code, 2);
    const json = r.json as {
      code: string;
      details: { srcOrgs: string[]; destOrgs: string[] };
    };
    assert.equal(json.code, "CROSS_ORG_WRITE");
    assert.deepEqual(json.details.srcOrgs, ["alpha-org"]);
    assert.deepEqual(json.details.destOrgs, ["beta-org"]);
  });

  it("emits DEST_UNCLASSIFIED warning when dest has no classification", () => {
    const env = setupAegisHome("xtree-unclassified");
    writeRegistry(
      env.aegisHome,
      `schemaVersion: 2
engagements:
  - id: alpha
    name: Alpha
    githubOrgs: [alpha-org]
    markers: []
`,
    );
    const src = makeGitRepo(tmp, "xtree-src-U", {
      remote: "git@github.com:alpha-org/src.git",
      class: "customer-coupled",
      engagements: ["alpha"],
    });
    const dest = makeGitRepo(tmp, "xtree-dest-U");
    const file = join(dest, "f.ts");
    writeFileSync(file, "x");
    const r = runCli(env.aegisHome, src, ["hook", "scan-after-write"], {
      input: JSON.stringify({ tool_input: { file_path: file } }),
    });
    // Scan still ran (no leak in deny set), so exit 0.
    assert.equal(r.code, 0);
    const json = r.json as { warnings: Array<{ code?: string; destTree?: string }> };
    const warningCodes = json.warnings
      .filter((w): w is { code: string; destTree?: string } => typeof w === "object" && w !== null && "code" in w)
      .map(w => w.code);
    assert.ok(warningCodes.includes("DEST_UNCLASSIFIED"));
  });

  it("scans against _always when the destination is outside any git tree", () => {
    const env = setupAegisHome("xtree-no-tree");
    writeRegistry(
      env.aegisHome,
      `schemaVersion: 2
engagements: []
always_block:
  - "_always_marker_"
`,
    );
    writeMarker(env.aegisHome, "_always", "_always_marker_\n");
    const src = makeGitRepo(tmp, "xtree-src-T", {
      remote: "git@github.com:alpha-org/src.git",
      class: "public-eligible",
    });
    const file = join(tmp, "loose-scratch.txt");
    writeFileSync(file, "_always_marker_ leaked\n");
    const r = runCli(env.aegisHome, src, ["hook", "scan-after-write"], {
      input: JSON.stringify({ tool_input: { file_path: file } }),
    });
    assert.equal(r.code, 1);
    const json = r.json as { hits: unknown[] };
    assert.equal(json.hits.length, 1);
  });
});
