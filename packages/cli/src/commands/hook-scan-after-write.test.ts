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

// Plan T1d: Cursor `afterFileEdit` puts `file_path` at the payload's root and cannot block, so the
// hook is detection only and says so. Payload shape: __fixtures__/hosts/cursor.after-file-edit.json
// (doc-derived).
describe("hook scan-after-write --agent cursor (afterFileEdit)", { skip: !SUBPROCESS_TESTS_AVAILABLE }, () => {
  function cursorPayload(file: string): string {
    return JSON.stringify({ hook_event_name: "afterFileEdit", file_path: file, edits: [{ old_string: "a", new_string: "b" }] });
  }

  function leakSetup(name: string): { env: Env; repo: string; file: string } {
    const env = setupAegisHome(name);
    writeRegistry(env.aegisHome, `schemaVersion: 2\nengagements: []\nalways_block:\n  - "_cursor_marker_"\n`);
    writeMarker(env.aegisHome, "_always", "_cursor_marker_\n");
    const repo = makeGitRepo(tmp, `${name}-repo`, { remote: "git@github.com:alpha-org/src.git", class: "public-eligible" });
    const file = join(repo, "f.txt");
    writeFileSync(file, "_cursor_marker_ leaked\n");
    return { env, repo, file };
  }

  it("scans the root file_path: a marker hit exits 1 and the message says the edit already happened and the pre-commit hook is the gate", () => {
    const { env, repo, file } = leakSetup("cursor-hit");
    const r = runCli(env.aegisHome, repo, ["hook", "scan-after-write", "--agent", "cursor"], { input: cursorPayload(file) });
    assert.equal(r.code, 1);
    const json = r.json as { hits: unknown[]; note: string };
    assert.equal(json.hits.length, 1);
    assert.match(json.note, /AFTER Cursor saved the edit/);
    assert.match(json.note, /already on disk/);
    assert.match(json.note, /pre-commit hook is the gate/);
    assert.doesNotMatch(r.stderr, /_cursor_marker_/, "the literal marker is never printed");
  });

  it("without --agent cursor the same payload is not understood (Claude shape needs tool_input.file_path): silent exit 0", () => {
    const { env, repo, file } = leakSetup("cursor-no-flag");
    const r = runCli(env.aegisHome, repo, ["hook", "scan-after-write"], { input: cursorPayload(file) });
    assert.equal(r.code, 0);
    assert.equal(r.stdout, "");
  });

  it("--agent cursor does not read tool_input.file_path (a Claude-shaped payload scans nothing)", () => {
    const { env, repo, file } = leakSetup("cursor-claude-shape");
    const r = runCli(env.aegisHome, repo, ["hook", "scan-after-write", "--agent", "cursor"], {
      input: JSON.stringify({ tool_input: { file_path: file } }),
    });
    assert.equal(r.code, 0);
    assert.equal(r.stdout, "");
  });

  it("a clean file exits 0 with no detection-only note (the note rides non-zero answers only)", () => {
    const { env, repo } = leakSetup("cursor-clean");
    const clean = join(repo, "clean.txt");
    writeFileSync(clean, "innocuous\n");
    const r = runCli(env.aegisHome, repo, ["hook", "scan-after-write", "--agent", "cursor"], { input: cursorPayload(clean) });
    assert.equal(r.code, 0);
    assert.doesNotMatch(r.stdout, /pre-commit/);
  });

  it("silent exit 0 when the file is missing or the payload is not JSON", () => {
    const env = setupAegisHome("cursor-missing");
    for (const input of [cursorPayload("/nonexistent/abc/xyz"), "not json {{{", "", "[1]"]) {
      const r = runCli(env.aegisHome, env.cwd, ["hook", "scan-after-write", "--agent", "cursor"], { input });
      assert.equal(r.code, 0, input);
      assert.equal(r.stdout, "");
    }
  });
});

describe("hook scan-after-write: the registry's state", { skip: !SUBPROCESS_TESTS_AVAILABLE }, () => {
  it("an encrypted registry is read as none: an `_always` marker written is still reported, and the code is not REGISTRY_ENCRYPTED", () => {
    const env = setupAegisHome("scan-encrypted");
    writeFileSync(join(env.aegisHome, "engagements.yaml.age"), "age-encryption.org/v1\n");
    writeMarker(env.aegisHome, "_always", "globally-banned-token\n");
    const file = join(tmp, "scan-encrypted-leak.ts");
    writeFileSync(file, "let x = 'globally-banned-token';\n");
    const r = runCli(env.aegisHome, tmp, ["hook", "scan-after-write"], {
      input: JSON.stringify({ tool_input: { file_path: file } }),
    });
    assert.equal(r.code, 1, `${r.stdout}${r.stderr}`);
    assert.doesNotMatch(`${r.stdout}${r.stderr}`, /REGISTRY_ENCRYPTED|REGISTRY_ERROR/);
    const json = r.json as { hits: Array<{ engagement: string }> };
    assert.equal(json.hits.length, 1);
    assert.equal(json.hits[0]!.engagement, "_always");
  });

  it("a registry from a newer schema (99): REGISTRY_ERROR, exit 2, the newer-schema text", () => {
    const env = setupAegisHome("scan-newer");
    writeRegistry(env.aegisHome, "schemaVersion: 99\nengagements: []\n");
    const file = join(tmp, "scan-newer-probe.txt");
    writeFileSync(file, "innocuous");
    const r = runCli(env.aegisHome, tmp, ["hook", "scan-after-write"], {
      input: JSON.stringify({ tool_input: { file_path: file } }),
    });
    assert.equal(r.code, 2, `${r.stdout}${r.stderr}`);
    const json = r.json as { code: string; error: string };
    assert.equal(json.code, "REGISTRY_ERROR");
    assert.match(json.error, /written by a newer repo-aegis than the one this hook runs/);
  });

  it("an unparseable registry: REGISTRY_ERROR, exit 2, and the loader's message (which can name orgs) is not echoed", () => {
    const env = setupAegisHome("scan-unparseable");
    writeRegistry(env.aegisHome, "schemaVersion: 2\npersonalOrgs: [secret-org-name, secret-org-name]\nengagements: []\n");
    const file = join(tmp, "scan-unparseable-probe.txt");
    writeFileSync(file, "innocuous");
    const r = runCli(env.aegisHome, tmp, ["hook", "scan-after-write"], {
      input: JSON.stringify({ tool_input: { file_path: file } }),
    });
    assert.equal(r.code, 2, `${r.stdout}${r.stderr}`);
    assert.equal((r.json as { code: string }).code, "REGISTRY_ERROR");
    assert.doesNotMatch(`${r.stdout}${r.stderr}`, /secret-org-name/);
  });
});
