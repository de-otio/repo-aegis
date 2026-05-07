// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cliBuilt, runCli } from "../_subprocess-utils.js";

let tmp: string;

before(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "repo-aegis-hook-check-test-")));
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

function writeRegistry(aegisHome: string, yaml: string): void {
  writeFileSync(join(aegisHome, "engagements.yaml"), yaml);
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

describe("hook check-write", { skip: !SUBPROCESS_TESTS_AVAILABLE }, () => {
  it("exits 0 silently when stdin is empty", () => {
    const env = setupAegisHome("ck-empty-stdin");
    const r = runCli(env.aegisHome, env.cwd, ["hook", "check-write"], {
      input: "",
    });
    assert.equal(r.code, 0);
    assert.equal(r.stdout, "");
  });

  it("exits 0 silently when JSON has no tool_input.file_path", () => {
    const env = setupAegisHome("ck-no-path");
    const r = runCli(env.aegisHome, env.cwd, ["hook", "check-write"], {
      input: '{"tool_name":"Bash"}',
    });
    assert.equal(r.code, 0);
    assert.equal(r.stdout, "");
  });

  it("exits 0 silently on unparseable JSON", () => {
    const env = setupAegisHome("ck-bad-json");
    const r = runCli(env.aegisHome, env.cwd, ["hook", "check-write"], {
      input: "this is not json {{{",
    });
    assert.equal(r.code, 0);
    assert.equal(r.stdout, "");
  });

  it("falls back to tool_input.path for older payload shapes", () => {
    const env = setupAegisHome("ck-legacy-shape");
    const r = runCli(env.aegisHome, env.cwd, ["hook", "check-write"], {
      input: JSON.stringify({ tool_input: { path: join(tmp, "loose.txt") } }),
    });
    // No registry, no engagements, no boundary → exit 0.
    assert.equal(r.code, 0);
  });
});

describe("hook check-write: cross-tree policy", { skip: !SUBPROCESS_TESTS_AVAILABLE }, () => {
  it("exits 0 when src and dest share an engagement org", () => {
    const env = setupAegisHome("ck-same-org");
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
    const src = makeGitRepo(tmp, "ck-src-A", {
      remote: "git@github.com:alpha-org/src.git",
      class: "customer-coupled",
      engagements: ["alpha"],
    });
    const dest = makeGitRepo(tmp, "ck-dest-A", {
      remote: "git@github.com:alpha-org/dest.git",
      class: "customer-coupled",
      engagements: ["alpha"],
    });
    const file = join(dest, "f.ts");
    // Note: file does NOT exist on disk. PreToolUse fires before the
    // tool runs, so the path is announced but not yet written.
    const r = runCli(env.aegisHome, src, ["hook", "check-write"], {
      input: JSON.stringify({ tool_input: { file_path: file } }),
    });
    assert.equal(r.code, 0);
    assert.equal(existsSync(file), false, "PreToolUse must not create the file");
  });

  it("refuses with CROSS_ORG_WRITE when src and dest have disjoint orgs", () => {
    const env = setupAegisHome("ck-cross-org");
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
    const src = makeGitRepo(tmp, "ck-src-B", {
      remote: "git@github.com:alpha-org/src.git",
      class: "customer-coupled",
      engagements: ["alpha"],
    });
    const dest = makeGitRepo(tmp, "ck-dest-B", {
      remote: "git@github.com:beta-org/dest.git",
      class: "customer-coupled",
      engagements: ["beta"],
    });
    const file = join(dest, "f.ts");
    // Critical regression assertion: the file does NOT exist before
    // the hook runs. The whole point of moving this check to
    // PreToolUse is that the refusal happens *before* the tool's
    // effect lands. The pre-v0.3.0 PostToolUse-based refusal could
    // only see paths that were already on disk; here we prove
    // PreToolUse refuses without that prerequisite.
    assert.equal(existsSync(file), false, "fixture: file should not exist yet");
    const r = runCli(env.aegisHome, src, ["hook", "check-write"], {
      input: JSON.stringify({ tool_input: { file_path: file } }),
    });
    assert.equal(r.code, 2);
    const json = r.json as {
      code: string;
      details: { srcOrgs: string[]; destOrgs: string[]; destTree: string };
    };
    assert.equal(json.code, "CROSS_ORG_WRITE");
    assert.deepEqual(json.details.srcOrgs, ["alpha-org"]);
    assert.deepEqual(json.details.destOrgs, ["beta-org"]);
    // After the hook runs, the file still does not exist. The hook
    // itself does not write; Claude Code's contract is that exit 2
    // on PreToolUse blocks the tool from running. The hook's only
    // job is to be honest about whether the write should be allowed.
    assert.equal(
      existsSync(file),
      false,
      "regression: hook must not create the file as a side effect",
    );
  });

  it("exits 0 when src and dest are the same tree", () => {
    const env = setupAegisHome("ck-same-tree");
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
    const repo = makeGitRepo(tmp, "ck-same-tree-repo", {
      remote: "git@github.com:alpha-org/x.git",
      class: "customer-coupled",
      engagements: ["alpha"],
    });
    const file = join(repo, "f.ts");
    const r = runCli(env.aegisHome, repo, ["hook", "check-write"], {
      input: JSON.stringify({ tool_input: { file_path: file } }),
    });
    assert.equal(r.code, 0);
  });

  it("exits 0 when dest is unclassified (PreToolUse does not refuse on missing classification)", () => {
    const env = setupAegisHome("ck-unclassified");
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
    const src = makeGitRepo(tmp, "ck-src-U", {
      remote: "git@github.com:alpha-org/src.git",
      class: "customer-coupled",
      engagements: ["alpha"],
    });
    const dest = makeGitRepo(tmp, "ck-dest-U");
    const file = join(dest, "f.ts");
    const r = runCli(env.aegisHome, src, ["hook", "check-write"], {
      input: JSON.stringify({ tool_input: { file_path: file } }),
    });
    // PreToolUse only refuses on disjoint trust boundaries.
    // DEST_UNCLASSIFIED warnings are PostToolUse-only (they need to
    // travel with the deny-set scan result, which check-write doesn't
    // run).
    assert.equal(r.code, 0);
  });

  it("exits 0 when the file is outside any git working tree", () => {
    const env = setupAegisHome("ck-no-tree");
    writeRegistry(
      env.aegisHome,
      `schemaVersion: 2
engagements: []
`,
    );
    const src = makeGitRepo(tmp, "ck-src-NT", {
      remote: "git@github.com:alpha-org/src.git",
      class: "public-eligible",
    });
    const file = join(tmp, "ck-loose-scratch.txt");
    const r = runCli(env.aegisHome, src, ["hook", "check-write"], {
      input: JSON.stringify({ tool_input: { file_path: file } }),
    });
    // Bare /tmp writes (no git tree) are not cross-org by definition;
    // there's nothing to refuse against.
    assert.equal(r.code, 0);
  });
});
