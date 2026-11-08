// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// Issue #156: hook payloads past the stdin cap. The write hooks read the path from the payload's start, and
// refuse (check-write) or say "not scanned" (scan-after-write) when it is not there; the Bash-output hook
// scans the text it read. Each subprocess case below exited 0 unchecked before the fix.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cliBuilt, runCli } from "../_subprocess-utils.js";
import { parseHookWriteFields, scanJsonPrefix, WRITE_HOOK_INPUT_MAX_BYTES } from "./hook-input.js";

const BIG = "x".repeat(WRITE_HOOK_INPUT_MAX_BYTES + 1024);

describe("scanJsonPrefix", () => {
  it("reads top-level and nested string values by path from a cut-off text", () => {
    const full = JSON.stringify({ cwd: "/w", tool_input: { file_path: "/w/f.ts", content: "abc" } });
    const cut = full.slice(0, full.indexOf("abc") + 1);
    const m = scanJsonPrefix(cut);
    assert.equal(m.get("cwd"), "/w");
    assert.equal(m.get("tool_input.file_path"), "/w/f.ts");
    assert.equal(m.has("tool_input.content"), false, "a value cut off by the end is not reported");
  });

  it("never takes a key that only appears inside another string's content", () => {
    const decoy = JSON.stringify({ tool_input: { file_path: "/decoy" }, cwd: "/decoy" });
    const text = JSON.stringify({ tool_input: { content: decoy + BIG.slice(0, 10) } }).slice(0, 200);
    const m = scanJsonPrefix(text);
    assert.equal(m.has("tool_input.file_path"), false);
    assert.equal(m.has("cwd"), false);
  });

  it("decodes escapes in values and handles escaped quotes and backslashes", () => {
    const path = '/w/a "quoted" \\ dir/ü.ts';
    const m = scanJsonPrefix(JSON.stringify({ tool_input: { file_path: path } }));
    assert.equal(m.get("tool_input.file_path"), path);
  });

  it("skips strings inside arrays, and the first occurrence of a path wins", () => {
    const m = scanJsonPrefix('{"a":["x",{"b":"in-array"}],"a2":{"b":"one"},"cwd":"/1","cwd":"/2"}');
    assert.equal(m.has("a.b"), false);
    assert.equal(m.get("a2.b"), "one");
    assert.equal(m.get("cwd"), "/1");
  });

  it("is linear on hostile input", () => {
    const hostile = '{"a":'.repeat(100_000) + '"\\'.repeat(100_000);
    const t = process.hrtime.bigint();
    scanJsonPrefix(hostile);
    assert.ok(Number(process.hrtime.bigint() - t) / 1e6 < 1000);
  });

  it("parseHookWriteFields: a whole payload parses as JSON, a cut one through the prefix scan", () => {
    const payload = JSON.stringify({ cwd: "/w", tool_input: { file_path: "/w/f.ts", content: BIG } });
    assert.deepEqual(parseHookWriteFields(payload), { filePath: "/w/f.ts", cwd: "/w" });
    assert.deepEqual(parseHookWriteFields(payload.slice(0, WRITE_HOOK_INPUT_MAX_BYTES)), { filePath: "/w/f.ts", cwd: "/w" });
    const pathLast = JSON.stringify({ cwd: "/w", tool_input: { content: BIG, file_path: "/w/f.ts" } });
    assert.deepEqual(parseHookWriteFields(pathLast.slice(0, WRITE_HOOK_INPUT_MAX_BYTES)), { cwd: "/w" });
  });
});

const SUBPROCESS = cliBuilt();
let tmp: string;
before(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "repo-aegis-hook-input-test-")));
});
after(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function home(name: string, registry?: string, alwaysMarker?: string): string {
  const h = join(tmp, `${name}-aegis`);
  mkdirSync(join(h, "markers"), { recursive: true });
  mkdirSync(join(h, "state"), { recursive: true });
  if (registry !== undefined) writeFileSync(join(h, "engagements.yaml"), registry);
  if (alwaysMarker !== undefined) writeFileSync(join(h, "markers", "_always.txt"), `${alwaysMarker}\n`);
  return h;
}

function repo(name: string, org: string, engagement: string): string {
  const dir = join(tmp, name);
  mkdirSync(dir);
  execFileSync("git", ["init", "-q", "--initial-branch=main", dir], { stdio: "ignore" });
  execFileSync("git", ["-C", dir, "config", "remote.origin.url", `git@github.com:${org}/${name}.git`], { stdio: "ignore" });
  execFileSync("git", ["-C", dir, "config", "repo-aegis.class", "customer-coupled"], { stdio: "ignore" });
  execFileSync("git", ["-C", dir, "config", "--add", "repo-aegis.engagement", engagement], { stdio: "ignore" });
  return dir;
}

const TWO_ORGS = `schemaVersion: 2
engagements:
  - id: alpha
    name: Alpha
    githubOrgs: [alpha-org]
    markers: []
  - id: beta
    name: Beta
    githubOrgs: [beta-org]
    markers: []
`;

describe("hook check-write: payload past 1 MiB (#156)", { skip: !SUBPROCESS }, () => {
  it("a cross-org write with large content is still refused (the path is read from the start)", () => {
    const h = home("ck-big-cross", TWO_ORGS);
    const src = repo("ck-big-src", "alpha-org", "alpha");
    const dest = repo("ck-big-dest", "beta-org", "beta");
    const input = JSON.stringify({ cwd: src, tool_input: { file_path: join(dest, "f.ts"), content: BIG } });
    const r = runCli(h, src, ["hook", "check-write"], { input });
    assert.equal(r.code, 2);
    assert.equal((r.json as { code: string }).code, "CROSS_ORG_WRITE");
  });

  it("a write to the waiver file with large content is still refused", () => {
    const h = home("ck-big-waiver");
    const input = JSON.stringify({ tool_input: { file_path: join(tmp, ".repo-aegis.yml"), content: BIG } });
    const r = runCli(h, tmp, ["hook", "check-write"], { input });
    assert.equal(r.code, 2);
    assert.equal((r.json as { code: string }).code, "WAIVER_FILE_WRITE_REFUSED");
  });

  it("a large payload whose path comes after the content is refused, not allowed", () => {
    const h = home("ck-big-nopath");
    const input = JSON.stringify({ tool_input: { content: BIG, file_path: join(tmp, "f.ts") } });
    const r = runCli(h, tmp, ["hook", "check-write"], { input });
    assert.equal(r.code, 2);
    assert.equal((r.json as { code: string }).code, "HOOK_INPUT_TOO_LARGE");
  });

  it("a small payload with no path is still allowed", () => {
    const r = runCli(home("ck-small-nopath"), tmp, ["hook", "check-write"], { input: '{"tool_name":"Write"}' });
    assert.equal(r.code, 0);
  });
});

describe("hook scan-after-write: payload past 1 MiB (#156)", { skip: !SUBPROCESS }, () => {
  const REG = `schemaVersion: 2
engagements: []
always_block:
  - "_always_marker_"
`;

  it("the written file is scanned from disk even when the payload is cut", () => {
    const h = home("saw-big", REG, "_always_marker_");
    const file = join(tmp, "saw-big.txt");
    writeFileSync(file, "_always_marker_ leaked\n");
    const input = JSON.stringify({ tool_input: { file_path: file, content: BIG }, tool_response: { content: BIG } });
    const r = runCli(h, tmp, ["hook", "scan-after-write"], { input });
    assert.equal(r.code, 1);
    assert.equal((r.json as { hits: unknown[] }).hits.length, 1);
  });

  it("a cut payload with no readable path says the file was not scanned", () => {
    const h = home("saw-big-nopath", REG, "_always_marker_");
    const input = JSON.stringify({ tool_input: { content: BIG, file_path: join(tmp, "x.txt") } });
    const r = runCli(h, tmp, ["hook", "scan-after-write"], { input });
    assert.equal(r.code, 2);
    assert.equal((r.json as { code: string }).code, "HOOK_INPUT_TOO_LARGE");
    assert.match(r.stderr, /NOT been scanned/);
  });
});

describe("hook scan-bash-output: payload past 8 MiB (#156)", { skip: !SUBPROCESS }, () => {
  it("a secret early in a cut-off output is still found", () => {
    const token = "ghs_" + "A".repeat(36); // a dummy shape, not a credential
    const input = JSON.stringify({ tool_name: "Bash", tool_response: { stdout: `x ${token} y ` + "z".repeat(9 * 1024 * 1024) } });
    const r = runCli(home("bash-big"), tmp, ["hook", "scan-bash-output"], { input });
    assert.equal(r.code, 1);
    const out = JSON.parse(r.stdout) as { code: string };
    assert.equal(out.code, "SECRET_LEAK");
    assert.ok(!r.stdout.includes(token), "the hook never echoes the match");
  });
});
