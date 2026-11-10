// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// The write hooks under an emergency pause (complexity-review P1-E), as subprocesses:
//   - `hook check-write` (PreToolUse) allows a cross-org write while paused, but a write to the pause file itself,
//     and to the waiver file, is refused paused or not (person-only);
//   - `hook scan-after-write` (PostToolUse) still REPORTS a marker hit while paused, as advice: exit 0, `advisory`.
//
// The pause file is written relative to the real clock with an hour of margin each way. Placeholder orgs only.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { cliBuilt, runCli } from "../_subprocess-utils.js";
import { mintPause, pausePath } from "@de-otio/repo-aegis-core";

const HOUR = 3_600_000;
const NOTICE = /repo-aegis: paused until \d\d:\d\d \(resume: repo-aegis resume\)/;
const REGISTRY = `schemaVersion: 2
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

let tmp: string;
let n = 0;
before(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "repo-aegis-hook-write-pause-")));
});
after(() => rmSync(tmp, { recursive: true, force: true }));

type PauseKind = "active" | "expired" | "none" | "future" | "world-writable";

function aegisHome(pause: PauseKind, repo?: string): string {
  const home = join(tmp, `h${n++}`);
  mkdirSync(join(home, "markers"), { recursive: true });
  mkdirSync(join(home, "state"), { recursive: true });
  writeFileSync(join(home, "engagements.yaml"), REGISTRY);
  writeFileSync(join(home, "markers", "_always.txt"), "leak-token\n");
  const path = pausePath(home);
  const now = Date.now();
  const scope = repo !== undefined ? { repo } : {};
  if (pause === "active") mintPause({ path, now: new Date(now - 60_000), durationMs: HOUR, ...scope });
  if (pause === "expired") mintPause({ path, now: new Date(now - 2 * HOUR), durationMs: HOUR, ...scope });
  if (pause === "future") mintPause({ path, now: new Date(now + HOUR), durationMs: HOUR, ...scope });
  if (pause === "world-writable") {
    mintPause({ path, now: new Date(now - 60_000), durationMs: HOUR, ...scope });
    chmodSync(path, 0o666);
  }
  return home;
}

function repo(name: string, remote: string, engagement: string): string {
  const dir = join(tmp, `${name}${n++}`);
  mkdirSync(dir);
  const git = (...a: string[]): void => void execFileSync("git", ["-C", dir, ...a], { stdio: "ignore" });
  execFileSync("git", ["init", "-q", "--initial-branch=main", dir], { stdio: "ignore" });
  git("config", "remote.origin.url", remote);
  git("config", "repo-aegis.class", "customer-coupled");
  git("config", "--add", "repo-aegis.engagement", engagement);
  return dir;
}

const SKIP = !cliBuilt();

describe("hook check-write under a pause", { skip: SKIP }, () => {
  function crossOrgWrite(home: string, src: string, dest: string): ReturnType<typeof runCli> {
    return runCli(home, src, ["hook", "check-write"], { input: JSON.stringify({ tool_input: { file_path: join(dest, "f.ts") } }) });
  }

  it("control: with no pause a cross-org write is refused", () => {
    const home = aegisHome("none");
    const src = repo("src", "git@github.com:alpha-org/src.git", "alpha");
    const dest = repo("dest", "git@github.com:beta-org/dest.git", "beta");
    const r = crossOrgWrite(home, src, dest);
    assert.equal(r.code, 2);
    assert.equal((r.json as { code: string }).code, "CROSS_ORG_WRITE");
  });

  it("an active pause allows it, with the notice as the systemMessage", () => {
    const home = aegisHome("active");
    const src = repo("src", "git@github.com:alpha-org/src.git", "alpha");
    const dest = repo("dest", "git@github.com:beta-org/dest.git", "beta");
    const r = crossOrgWrite(home, src, dest);
    assert.equal(r.code, 0, r.stderr);
    assert.match((r.json as { systemMessage: string }).systemMessage, NOTICE);
  });

  it("after expiry, with the clock past the end, the refusal is back", () => {
    const home = aegisHome("expired");
    const src = repo("src", "git@github.com:alpha-org/src.git", "alpha");
    const dest = repo("dest", "git@github.com:beta-org/dest.git", "beta");
    assert.equal(crossOrgWrite(home, src, dest).code, 2);
  });

  it("a future-dated or world-writable pause file is no pause", () => {
    for (const kind of ["future", "world-writable"] as const) {
      const home = aegisHome(kind);
      const src = repo("src", "git@github.com:alpha-org/src.git", "alpha");
      const dest = repo("dest", "git@github.com:beta-org/dest.git", "beta");
      assert.equal(crossOrgWrite(home, src, dest).code, 2, kind);
    }
  });

  it("--repo: covers the session's working repo by its origin (case-insensitively), not another", () => {
    const src = repo("src", "git@github.com:Alpha-Org/Src.git", "alpha");
    const dest = repo("dest", "git@github.com:beta-org/dest.git", "beta");
    assert.equal(crossOrgWrite(aegisHome("active", "alpha-org/src"), src, dest).code, 0);
    assert.equal(crossOrgWrite(aegisHome("active", "beta-org/dest"), src, dest).code, 2);
  });

  it("a write to the pause file is refused, paused or not, wherever the path comes from", () => {
    for (const kind of ["none", "active"] as const) {
      const home = aegisHome(kind);
      const cwd = repo("cwd", "git@github.com:alpha-org/src.git", "alpha");
      for (const file_path of [pausePath(home), `${pausePath(home)}.123.tmp`, join(dirname(home), basename(home), "x", "..", "pause.json")]) {
        const r = runCli(home, cwd, ["hook", "check-write"], { input: JSON.stringify({ tool_input: { file_path } }) });
        assert.equal(r.code, 2, `${kind}: ${file_path}`);
        assert.equal((r.json as { code: string }).code, "PAUSE_FILE_WRITE_REFUSED", file_path);
      }
      // a relative path resolved against the session cwd
      const rel = runCli(home, cwd, ["hook", "check-write"], { input: JSON.stringify({ tool_input: { file_path: "pause.json" }, cwd: home }) });
      assert.equal((rel.json as { code?: string } | undefined)?.code, "PAUSE_FILE_WRITE_REFUSED");
    }
  });

  it("another file named pause.json is an ordinary write", () => {
    const home = aegisHome("none");
    const cwd = repo("cwd", "git@github.com:alpha-org/src.git", "alpha");
    const r = runCli(home, cwd, ["hook", "check-write"], { input: JSON.stringify({ tool_input: { file_path: join(cwd, "pause.json") } }) });
    assert.equal(r.code, 0, r.stderr);
  });

  it("a write to the waiver file is refused while paused: that gate is person-only too", () => {
    const home = aegisHome("active");
    const cwd = repo("cwd", "git@github.com:alpha-org/src.git", "alpha");
    const r = runCli(home, cwd, ["hook", "check-write"], { input: JSON.stringify({ tool_input: { file_path: join(cwd, ".repo-aegis.yml") } }) });
    assert.equal(r.code, 2);
    assert.equal((r.json as { code: string }).code, "WAIVER_FILE_WRITE_REFUSED");
  });
});

describe("hook scan-after-write under a pause: detection is not paused", { skip: SKIP }, () => {
  /** A file outside any git tree holding the `_always` marker, written in the session's repo. */
  function scan(home: string, cwd: string): ReturnType<typeof runCli> {
    const file = join(tmp, `leak${n++}.txt`);
    writeFileSync(file, "the leak-token is here\n");
    return runCli(home, cwd, ["hook", "scan-after-write"], { input: JSON.stringify({ tool_input: { file_path: file }, cwd }) });
  }
  type Out = { hits: unknown[]; advisory?: boolean; systemMessage?: string };

  it("control: with no pause a marker hit exits 1", () => {
    const r = scan(aegisHome("none"), repo("cwd", "git@github.com:alpha-org/src.git", "alpha"));
    assert.equal(r.code, 1);
    assert.equal((r.json as Out).hits.length, 1);
  });

  it("an active pause: the hit is still reported, as advice (exit 0, advisory), with the notice and a count", () => {
    const r = scan(aegisHome("active"), repo("cwd", "git@github.com:alpha-org/src.git", "alpha"));
    assert.equal(r.code, 0, r.stderr);
    const j = r.json as Out;
    assert.equal(j.hits.length, 1, "the hit is still in the report");
    assert.equal(j.advisory, true);
    assert.match(j.systemMessage ?? "", NOTICE);
    assert.match(j.systemMessage ?? "", /1 marker hit\(s\) found, advisory while paused/);
    // the literal marker never travels
    assert.doesNotMatch(r.stdout + r.stderr, /leak-token/);
  });

  it("an active pause with a clean file still says it is paused", () => {
    const home = aegisHome("active");
    const cwd = repo("cwd", "git@github.com:alpha-org/src.git", "alpha");
    const file = join(tmp, `clean${n++}.txt`);
    writeFileSync(file, "nothing here\n");
    const r = runCli(home, cwd, ["hook", "scan-after-write"], { input: JSON.stringify({ tool_input: { file_path: file }, cwd }) });
    assert.equal(r.code, 0);
    assert.match((r.json as Out).systemMessage ?? "", NOTICE);
  });

  it("after expiry the hit blocks again (exit 1)", () => {
    assert.equal(scan(aegisHome("expired"), repo("cwd", "git@github.com:alpha-org/src.git", "alpha")).code, 1);
  });

  it("a future-dated or world-writable pause file is no pause", () => {
    for (const kind of ["future", "world-writable"] as const) {
      assert.equal(scan(aegisHome(kind), repo("cwd", "git@github.com:alpha-org/src.git", "alpha")).code, 1, kind);
    }
  });

  it("--repo: the working repo's origin decides (case-insensitively)", () => {
    const cwd = repo("cwd", "git@github.com:Alpha-Org/Src.git", "alpha");
    assert.equal(scan(aegisHome("active", "alpha-org/src"), cwd).code, 0);
    assert.equal(scan(aegisHome("active", "beta-org/dest"), cwd).code, 1);
  });
});
