// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  probeGithubVisibility,
  cacheVisibility,
  resolveVisibility,
  type CommandResult,
  type CommandRunner,
} from "./visibility.js";

interface Call {
  cmd: string;
  args: string[];
}

const ok = (stdout: string): CommandResult => ({ ok: true, stdout, stderr: "" });
const fail = (stderr: string, spawnCode?: string): CommandResult => ({
  ok: false,
  stdout: "",
  stderr,
  ...(spawnCode !== undefined && { spawnCode }),
});

/** A runner that returns a canned `gh` result and records every invocation. */
function fakeRunner(ghResult: CommandResult): { run: CommandRunner; calls: Call[] } {
  const calls: Call[] = [];
  const run: CommandRunner = (cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === "gh") return ghResult;
    return ok(""); // git config writes "succeed"
  };
  return { run, calls };
}

describe("probeGithubVisibility", () => {
  it("maps gh visibility values", () => {
    const pub = probeGithubVisibility("/x", fakeRunner(ok("PUBLIC\n")).run);
    assert.equal(pub.visibility, "public");
    assert.equal(pub.status, "resolved");
    assert.equal(pub.fix, undefined);

    assert.equal(probeGithubVisibility("/x", fakeRunner(ok("PRIVATE\n")).run).visibility, "private");
    // INTERNAL (GitHub Enterprise) is not publicly reachable.
    assert.equal(probeGithubVisibility("/x", fakeRunner(ok("INTERNAL\n")).run).visibility, "private");
  });

  it("an unrecognised value is unknown, not a silent public", () => {
    const p = probeGithubVisibility("/x", fakeRunner(ok("???")).run);
    assert.equal(p.visibility, "unknown");
    assert.equal(p.status, "unrecognised");
  });

  // -- #97.1: the three failures that used to collapse into one "unknown" ----

  it("a missing gh binary is no-gh", () => {
    const p = probeGithubVisibility("/x", fakeRunner(fail("", "ENOENT")).run);
    assert.equal(p.visibility, "unknown");
    assert.equal(p.status, "no-gh");
    assert.ok(p.fix);
  });

  it("a repo gh cannot see is unauthorized, not unknown", () => {
    for (const stderr of [
      "GraphQL: Could not resolve to a Repository with the name 'o/r'. (repository)",
      "HTTP 404: Not Found (https://api.github.com/repos/o/r)",
      "error: Bad credentials",
      "gh: To get started with GitHub CLI, please run: gh auth login",
    ]) {
      const p = probeGithubVisibility("/x", fakeRunner(fail(stderr)).run);
      assert.equal(p.status, "unauthorized", `stderr: ${stderr}`);
      assert.equal(p.visibility, "unknown");
      assert.ok(p.fix, "unauthorized must carry an actionable fix");
    }
  });

  it("no GitHub remote is no-remote, even though gh mentions `gh auth login`", () => {
    // gh's real wording for this case ends with "please use `gh auth login`",
    // which would be misread as an auth failure if the auth test ran first.
    const p = probeGithubVisibility(
      "/x",
      fakeRunner(
        fail(
          "none of the git remotes configured for this repository point to a known " +
            "GitHub host. To tell gh about a new GitHub host, please use `gh auth login`",
        ),
      ).run,
    );
    assert.equal(p.status, "no-remote");
    assert.equal(p.visibility, "unknown");
  });

  it("an unclassifiable failure is unrecognised", () => {
    const p = probeGithubVisibility("/x", fakeRunner(fail("something else entirely")).run);
    assert.equal(p.status, "unrecognised");
    assert.equal(p.visibility, "unknown");
  });

  it("never carries gh's own stderr into `detail` (it embeds the repo name)", () => {
    const p = probeGithubVisibility(
      "/x",
      fakeRunner(fail("Could not resolve to a Repository with the name 'SENTINEL-ORG/x'.")).run,
    );
    assert.doesNotMatch(p.detail, /SENTINEL-ORG/);
    assert.doesNotMatch(p.fix ?? "", /SENTINEL-ORG/);
  });
});

describe("cacheVisibility", () => {
  it("writes git config for a known visibility", () => {
    const { run, calls } = fakeRunner(fail(""));
    cacheVisibility("/x", "public", run);
    const write = calls.find(c => c.cmd === "git");
    assert.ok(write);
    assert.deepEqual(write!.args, ["config", "repo-aegis.visibility", "public"]);
  });
  it("is a no-op for unknown", () => {
    const { run, calls } = fakeRunner(fail(""));
    cacheVisibility("/x", "unknown", run);
    assert.equal(calls.length, 0);
  });
});

describe("resolveVisibility", () => {
  it("probes, caches, and returns when gh succeeds", () => {
    const { run, calls } = fakeRunner(ok("PUBLIC"));
    const r = resolveVisibility("/x", run);
    assert.equal(r.visibility, "public");
    assert.equal(r.fromCache, false);
    assert.equal(r.probe.status, "resolved");
    assert.ok(calls.some(c => c.cmd === "git" && c.args.includes("repo-aegis.visibility")));
  });

  it("falls back to the cached value when gh is unavailable", () => {
    let tmp: string | undefined;
    try {
      tmp = mkdtempSync(join(tmpdir(), "repo-aegis-vis-"));
      execFileSync("git", ["init", "-q", "-b", "main"], { cwd: tmp });
      execFileSync("git", ["config", "repo-aegis.visibility", "private"], { cwd: tmp });
      const r = resolveVisibility(tmp, fakeRunner(fail("", "ENOENT")).run);
      assert.equal(r.visibility, "private");
      assert.equal(r.fromCache, true);
      // The cache answered, but the probe's blindness is still reported —
      // a stale cache plus a blind probe is how a repo keeps a wrong class.
      assert.equal(r.probe.status, "no-gh");
    } finally {
      if (tmp) rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("does not cache a value it could not confirm", () => {
    let tmp: string | undefined;
    try {
      tmp = mkdtempSync(join(tmpdir(), "repo-aegis-vis-nocache-"));
      execFileSync("git", ["init", "-q", "-b", "main"], { cwd: tmp });
      const { run, calls } = fakeRunner(fail("HTTP 404: Not Found"));
      const r = resolveVisibility(tmp, run);
      assert.equal(r.visibility, "unknown");
      assert.equal(r.probe.status, "unauthorized");
      assert.equal(
        calls.filter(c => c.cmd === "git" && c.args.includes("repo-aegis.visibility")).length,
        0,
        "an unresolved probe must never write the visibility cache",
      );
    } finally {
      if (tmp) rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// Keep a `before`/`after` pair so the file matches the suite's lifecycle
// conventions even though most cases are pure.
describe("visibility lifecycle", () => {
  let original: string;
  before(() => {
    original = process.cwd();
  });
  after(() => {
    process.chdir(original);
  });
  it("does not change cwd", () => {
    probeGithubVisibility(process.cwd(), fakeRunner(ok("PUBLIC")).run);
    assert.equal(process.cwd(), original);
  });
});
