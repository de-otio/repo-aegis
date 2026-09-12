// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { captureOutput, fakeGh, withEnv } from "../_test-utils.js";
import { cliBuilt, runCli } from "../_subprocess-utils.js";
import { buildGhCommand, egressReadback, parsePrRef, shellQuote } from "./egress-check.js";
import { approvalsPath, mintApproval, revokeApprovals } from "@de-otio/repo-aegis-core";

// FIXTURE LOCATION, deliberately not the temp dir: rule d refuses a payload
// path under `/var/folders/**` (macOS's per-user temp, which is exactly what
// `os.tmpdir()` returns there) or `/tmp/claude-*`. A body file staged in the
// temp dir would therefore be denied on a developer's Mac and allowed on a
// Linux runner — the test would assert the opposite things on the two
// platforms. A directory under $HOME is mode-independent everywhere.
let root: string;
/** The repo-aegis home; nothing here is path-rule-sensitive, so temp is fine. */
let home: string;

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: ["ignore", "ignore", "ignore"] });
}

/** A git repo with a GitHub origin and an optional explicit class. */
function makeRepo(name: string, origin: string, cls?: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["remote", "add", "origin", origin]);
  if (cls !== undefined) git(dir, ["config", "repo-aegis.class", cls]);
  return dir;
}

let publicRepo: string;
let privateRepo: string;
let bodyFile: string;

before(() => {
  root = mkdtempSync(join(homedir(), ".repo-aegis-egress-check-test-"));
  home = mkdtempSync(join(tmpdir(), "repo-aegis-egress-check-home-"));
  publicRepo = makeRepo("svc", "git@github.com:acme/svc.git", "public-eligible");
  privateRepo = makeRepo("internal", "git@github.com:acme/internal.git");
  bodyFile = join(root, "pr-body.md");
  writeFileSync(bodyFile, "A perfectly ordinary pull-request body.\n");
});

after(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe("shellQuote", () => {
  const cases = [
    "plain",
    "with space",
    "it's",
    "$TMPDIR/pr-body.md",
    '"double"',
    "back\\slash",
    "a`b",
    "new\nline",
    "'",
    "''",
  ];

  for (const arg of cases) {
    it(`round-trips ${JSON.stringify(arg)} through a real shell`, () => {
      // The oracle is the shell itself: the quoting is only correct if bash
      // hands the byte-for-byte original back. A hand-written expectation
      // would just re-assert the implementation.
      const out = execFileSync("bash", ["-c", `printf '%s' ${shellQuote(arg)}`], {
        encoding: "utf8",
      });
      assert.equal(out, arg);
    });
  }

  it("builds a gh command line from argv", () => {
    assert.equal(
      buildGhCommand(["pr", "create", "--title", "a b"]),
      "gh 'pr' 'create' '--title' 'a b'",
    );
    assert.equal(buildGhCommand([]), "gh");
  });
});

describe("parsePrRef", () => {
  it("accepts a bare number", () => {
    assert.deepEqual(parsePrRef("42"), { number: "42" });
  });

  it("accepts a PR URL and takes the org/repo from it", () => {
    assert.deepEqual(parsePrRef("https://github.com/acme/svc/pull/7"), {
      number: "7",
      org: "acme",
      repo: "svc",
    });
  });

  it("finds the URL inside chatty gh output", () => {
    const stdout =
      "Warning: 3 uncommitted changes\nCreating pull request for feat into main\n" +
      "https://github.com/acme/svc/pull/1234\n";
    assert.equal(parsePrRef(stdout)?.number, "1234");
  });

  it("returns null when there is nothing to parse", () => {
    assert.equal(parsePrRef(undefined), null);
    assert.equal(parsePrRef("something went wrong"), null);
  });
});

describe("egress-check (subprocess)", { skip: cliBuilt() ? false : "CLI not built" }, () => {
  it("denies a relative body path", () => {
    const r = runCli(home, publicRepo, [
      "egress-check",
      "--cwd",
      publicRepo,
      "--",
      "pr",
      "create",
      "--title",
      "t",
      "--body-file",
      "pr-body.md",
    ]);
    assert.equal(r.code, 2);
    const payload = JSON.parse(r.stderr.trim()) as { code: string; details: { verb: string } };
    assert.equal(payload.code, "PAYLOAD_MODE_DEPENDENT_PATH");
    assert.equal(payload.details.verb, "gh pr create");
  });

  it("denies a $TMPDIR body path — the 2026-09-07 incident shape", () => {
    const r = runCli(home, publicRepo, [
      "egress-check",
      "--cwd",
      publicRepo,
      "--",
      "pr",
      "create",
      "--title",
      "t",
      "--body-file",
      "$TMPDIR/pr-body.md",
      "--repo",
      "acme/svc",
    ]);
    assert.equal(r.code, 2);
    const payload = JSON.parse(r.stderr.trim()) as { code: string; error: string };
    assert.equal(payload.code, "PAYLOAD_MODE_DEPENDENT_PATH");
    // The reason carries the basename, never the mode-dependent path itself.
    assert.ok(!payload.error.includes("$TMPDIR/pr-body.md"));
  });

  it("allows `--body-file -` (stdin is not a path)", () => {
    const r = runCli(home, privateRepo, [
      "egress-check",
      "--cwd",
      privateRepo,
      "--",
      "pr",
      "create",
      "--title",
      "t",
      "--body-file",
      "-",
    ]);
    assert.equal(r.code, 0);
    const payload = JSON.parse(r.stdout) as { action: string; readback?: unknown };
    assert.equal(payload.action, "allow");
    assert.equal(payload.readback, undefined);
  });

  it("denies a public destination when no human is present", () => {
    const r = runCli(home, publicRepo, [
      "egress-check",
      "--cwd",
      publicRepo,
      "--",
      "pr",
      "create",
      "--title",
      "t",
      "--body-file",
      bodyFile,
    ]);
    assert.equal(r.code, 2);
    const payload = JSON.parse(r.stderr.trim()) as {
      code: string;
      details: { destination?: { org: string; repo: string; class: string } };
    };
    assert.equal(payload.code, "PUBLIC_EGRESS_NEEDS_HUMAN");
    assert.equal(payload.details.destination?.org, "acme");
    assert.equal(payload.details.destination?.repo, "svc");
    assert.equal(payload.details.destination?.class, "public-eligible");
  });

  it("allows the same publish with REPO_AEGIS_EGRESS_HUMAN=1, and asks for a read-back", () => {
    const r = withEnv("REPO_AEGIS_EGRESS_HUMAN", "1", () =>
      runCli(home, publicRepo, [
        "egress-check",
        "--cwd",
        publicRepo,
        "--",
        "pr",
        "create",
        "--title",
        "t",
        "--body-file",
        bodyFile,
      ]),
    );
    assert.equal(r.code, 0);
    const payload = JSON.parse(r.stdout) as {
      action: string;
      destination?: { org: string; repo: string };
      readback?: { bodyFile: string; verb: string };
      receipt?: string;
      failedReceipt?: string;
    };
    assert.equal(payload.action, "allow");
    assert.equal(payload.destination?.org, "acme");
    assert.deepEqual(payload.readback, { bodyFile, verb: "gh-pr-create" });
    // Both receipt lines travel in the verdict; the shim prints one AFTER gh
    // returns. Nothing has published at this point, so nothing says so here.
    assert.equal(payload.receipt, "PUBLISHED → acme/svc (UNKNOWN, class public-eligible): gh pr create");
    assert.equal(payload.failedReceipt, "EGRESS FAILED → acme/svc (UNKNOWN, class public-eligible): gh pr create");
    assert.ok(!r.stderr.includes("PUBLISHED"), r.stderr);
  });

  it("allows a public publish on a live human approval and names it in the verdict", () => {
    const home2 = join(root, "approved-home");
    mkdirSync(join(home2, "markers"), { recursive: true });
    writeFileSync(join(home2, "markers", "_always.txt"), "");
    const a = mintApproval({ target: { org: "acme", repo: "svc" }, path: approvalsPath(home2) });
    const r = runCli(home2, publicRepo, ["egress-check", "--cwd", publicRepo, "--", "pr", "create", "--title", "t", "--body", "b"]);
    assert.equal(r.code, 0, r.stderr);
    const payload = JSON.parse(r.stdout) as { action: string; approval?: { id: string } };
    assert.equal(payload.action, "allow");
    assert.equal(payload.approval?.id, a.id);
    // The same command without one is a deny on this path (a shell has no ask).
    revokeApprovals("all", approvalsPath(home2));
    const r2 = runCli(home2, publicRepo, ["egress-check", "--cwd", publicRepo, "--", "pr", "create", "--title", "t", "--body", "b"]);
    assert.equal(r2.code, 2);
    assert.match(r2.stderr, /repo-aegis approve acme\/svc/);
  });

  it("allows a read with no read-back and no receipt", () => {
    const r = runCli(home, publicRepo, ["egress-check", "--cwd", publicRepo, "--", "pr", "view", "1"]);
    assert.equal(r.code, 0);
    assert.deepEqual(JSON.parse(r.stdout), { action: "allow" }); // no receipt: nothing to print
    assert.equal(r.stderr.trim(), "");
  });

  it("never prints payload content", () => {
    const secretish = join(root, "leaky-body.md");
    writeFileSync(secretish, "CONTENTS-THAT-MUST-NOT-BE-ECHOED\n");
    const r = runCli(home, publicRepo, [
      "egress-check",
      "--cwd",
      publicRepo,
      "--",
      "pr",
      "create",
      "--title",
      "t",
      "--body-file",
      secretish,
    ]);
    assert.ok(!`${r.stdout}${r.stderr}`.includes("CONTENTS-THAT-MUST-NOT-BE-ECHOED"));
  });
});

describe("egress-readback", () => {
  const SEEDED = "The body that was actually published.\n";

  /** A `gh` stub that answers `pr view … --json body --jq .body` from a file. */
  function ghStub(name: string, seedFile: string): string {
    const dir = fakeGh(
      join(root, `gh-${name}`),
      `if [ "$1" = "pr" ] && [ "$2" = "view" ]; then cat ${JSON.stringify(seedFile)}; exit 0; fi\n` +
        `echo "unexpected gh invocation: $*" >&2\nexit 1`,
    );
    return join(dir, "gh");
  }

  it("exit 0 with the byte count when the published body matches the file", () => {
    const file = join(root, "readback-match.md");
    writeFileSync(file, SEEDED);
    const seed = join(root, "readback-match-seed.txt");
    // gh strips the trailing newline; the comparison must too.
    writeFileSync(seed, SEEDED.trimEnd());

    const out = captureOutput(() =>
      egressReadback({
        cwd: publicRepo,
        bodyFile: file,
        pr: "https://github.com/acme/svc/pull/7",
        gh: ghStub("match", seed),
      }),
    );
    assert.equal(out.exitCode, undefined);
    assert.deepEqual(JSON.parse(out.stdout), {
      ok: true,
      bytes: Buffer.byteLength(SEEDED.trimEnd()),
    });
  });

  it("exit 1 with byte counts, and no content, when the bodies differ", () => {
    const file = join(root, "readback-mismatch.md");
    writeFileSync(file, "THE-FILE-WE-MEANT-TO-PUBLISH\n");
    const seed = join(root, "readback-mismatch-seed.txt");
    writeFileSync(seed, "THE-WRONG-DOCUMENT-FROM-ANOTHER-SESSION");

    const out = captureOutput(() =>
      egressReadback({
        cwd: publicRepo,
        bodyFile: file,
        pr: "https://github.com/acme/svc/pull/7",
        gh: ghStub("mismatch", seed),
      }),
    );
    assert.equal(out.exitCode, 1);
    const payload = JSON.parse(out.stderr.trim()) as {
      code: string;
      details: { publishedBytes: number; fileBytes: number; pr: number; repo: string };
    };
    assert.equal(payload.code, "PUBLISHED_BODY_MISMATCH");
    assert.deepEqual(payload.details, {
      publishedBytes: "THE-WRONG-DOCUMENT-FROM-ANOTHER-SESSION".length,
      fileBytes: "THE-FILE-WE-MEANT-TO-PUBLISH".length,
      pr: 7,
      repo: "acme/svc",
    });
    const all = `${out.stdout}${out.stderr}`;
    assert.ok(!all.includes("THE-WRONG-DOCUMENT-FROM-ANOTHER-SESSION"));
    assert.ok(!all.includes("THE-FILE-WE-MEANT-TO-PUBLISH"));
  });

  it("treats CRLF and one trailing newline as equal", () => {
    const file = join(root, "readback-crlf.md");
    writeFileSync(file, "line one\r\nline two\r\n");
    const seed = join(root, "readback-crlf-seed.txt");
    writeFileSync(seed, "line one\nline two");

    const out = captureOutput(() =>
      egressReadback({
        cwd: publicRepo,
        bodyFile: file,
        pr: "42",
        repo: "acme/svc",
        gh: ghStub("crlf", seed),
      }),
    );
    assert.equal(out.exitCode, undefined);
    assert.equal((JSON.parse(out.stdout) as { ok: boolean }).ok, true);
  });

  it("falls back to the cwd's origin when --repo is absent and the ref is a bare number", () => {
    const file = join(root, "readback-origin.md");
    writeFileSync(file, "same\n");
    const seed = join(root, "readback-origin-seed.txt");
    writeFileSync(seed, "same");
    const stub = join(root, "gh-origin-probe", "gh");
    // The stub echoes its --repo argument into the seed comparison by
    // printing the body only when the repo it was given is the right one.
    fakeGh(
      join(root, "gh-origin-probe"),
      `if [ "$5" = "acme/svc" ]; then cat ${JSON.stringify(seed)}; exit 0; fi\nexit 1`,
    );

    const out = captureOutput(() =>
      egressReadback({ cwd: publicRepo, bodyFile: file, pr: "9", gh: stub }),
    );
    assert.equal(out.exitCode, undefined);
    assert.equal((JSON.parse(out.stdout) as { ok: boolean }).ok, true);
  });

  it("exit 0 READBACK_UNAVAILABLE when gh fails", () => {
    const file = join(root, "readback-ghfail.md");
    writeFileSync(file, "whatever\n");
    const stub = join(fakeGh(join(root, "gh-fail"), 'echo "acme/svc: not found" >&2; exit 1'), "gh");

    const out = captureOutput(() =>
      egressReadback({ cwd: publicRepo, bodyFile: file, pr: "3", repo: "acme/svc", gh: stub }),
    );
    assert.equal(out.exitCode, 0);
    const payload = JSON.parse(out.stderr.trim()) as { code: string; reason: string };
    assert.equal(payload.code, "READBACK_UNAVAILABLE");
    // gh's own stderr is never forwarded: it names the destination.
    assert.ok(!out.stderr.includes("not found"));
  });

  it("exit 0 READBACK_UNAVAILABLE when no PR can be identified", () => {
    const file = join(root, "readback-nopr.md");
    writeFileSync(file, "whatever\n");
    const out = captureOutput(() =>
      egressReadback({ cwd: publicRepo, bodyFile: file, pr: "gh: command failed", gh: "gh" }),
    );
    assert.equal(out.exitCode, 0);
    assert.equal((JSON.parse(out.stderr.trim()) as { code: string }).code, "READBACK_UNAVAILABLE");
  });

  it("exit 0 READBACK_UNAVAILABLE when the body file cannot be read", () => {
    const out = captureOutput(() =>
      egressReadback({ cwd: publicRepo, bodyFile: join(root, "no-such-body.md"), pr: "3", gh: "gh" }),
    );
    assert.equal(out.exitCode, 0);
    assert.equal((JSON.parse(out.stderr.trim()) as { code: string }).code, "READBACK_UNAVAILABLE");
  });

  it("honours --timeout-ms instead of hanging the shim", () => {
    const file = join(root, "readback-timeout.md");
    writeFileSync(file, "whatever\n");
    const stub = join(fakeGh(join(root, "gh-slow"), "sleep 5; echo late"), "gh");

    const started = Date.now();
    const out = captureOutput(() =>
      egressReadback({
        cwd: publicRepo,
        bodyFile: file,
        pr: "3",
        repo: "acme/svc",
        gh: stub,
        timeoutMs: 250,
      }),
    );
    const elapsed = Date.now() - started;
    assert.equal(out.exitCode, 0);
    assert.equal((JSON.parse(out.stderr.trim()) as { code: string }).code, "READBACK_UNAVAILABLE");
    assert.ok(elapsed < 4000, `read-back should have timed out quickly, took ${elapsed}ms`);
  });
});
