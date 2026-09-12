// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// `check --remote-url` — the destination half of the pre-push hook
// (doc/design/egress-guard.md §2).
//
// Placeholder orgs only (`acme`, `customer-a-org`, `example`). This repository
// is public; the whole point of the tool is that real names do not land in one.
import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureOutput, withEnv, lastJsonLine } from "../_test-utils.js";
import { check } from "./check.js";

let tmp: string;
let originalCwd: string;

before(() => {
  tmp = mkdtempSync(join(tmpdir(), "repo-aegis-check-egress-"));
  originalCwd = process.cwd();
});

after(() => {
  process.chdir(originalCwd);
  rmSync(tmp, { recursive: true, force: true });
});

afterEach(() => {
  process.chdir(originalCwd);
});

function setupHome(name: string): string {
  const home = join(tmp, name + "-home");
  const markersDir = join(home, "markers");
  mkdirSync(markersDir, { recursive: true });
  mkdirSync(join(home, "state"), { recursive: true });
  writeFileSync(join(markersDir, "_always.txt"), "leak-token\n");
  return home;
}

const REGISTRY = `\
always_block: []
personalOrgs:
  - acme
engagements:
  - id: customer-a
    name: Customer A
    githubOrgs:
      - customer-a-org
    markers:
      - customer-a-marker
`;

function setupRegistry(name: string): string {
  const path = join(tmp, name + "-registry.yaml");
  writeFileSync(path, REGISTRY);
  return path;
}

interface RepoOpts {
  class?: string;
  visibility?: string;
  originUrl?: string;
}

/** A two-commit repo with clean content, so `--range HEAD~1..HEAD` scans
 * something real and reaches the "clean" exit-0 path. */
function makeRepo(name: string, opts: RepoOpts = {}): string {
  const dir = join(tmp, name);
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  if (opts.class) execFileSync("git", ["config", "repo-aegis.class", opts.class], { cwd: dir });
  if (opts.visibility) {
    execFileSync("git", ["config", "repo-aegis.visibility", opts.visibility], { cwd: dir });
  }
  execFileSync("git", ["config", "remote.origin.url", opts.originUrl ?? "git@github.com:acme/x.git"], {
    cwd: dir,
  });
  writeFileSync(join(dir, "a.txt"), "first\n");
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "first"], { cwd: dir });
  writeFileSync(join(dir, "b.txt"), "second\n");
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "second"], { cwd: dir });
  return dir;
}

/**
 * Pin stderr's TTY-ness for the duration of `fn`.
 *
 * `isHumanPresent` tests `process.stderr.isTTY`, and whether the test runner's
 * stderr happens to be a terminal depends on how the developer invoked it —
 * exactly the environment dependence CONTRIBUTING forbids. Pinning it makes
 * both sides of the gate assertable.
 */
function withStderrTty<T>(isTty: boolean, fn: () => T): T {
  const desc = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");
  Object.defineProperty(process.stderr, "isTTY", {
    value: isTty,
    configurable: true,
    writable: true,
  });
  try {
    return fn();
  } finally {
    if (desc) Object.defineProperty(process.stderr, "isTTY", desc);
    else delete (process.stderr as { isTTY?: boolean }).isTTY;
  }
}

interface Ctx {
  home: string;
  registry: string;
}

function setup(name: string): Ctx {
  return { home: setupHome(name), registry: setupRegistry(name) };
}

/** Run `check` with the fixture's home + registry and no TTY on stderr. */
function run(
  ctx: Ctx,
  opts: Parameters<typeof check>[0],
  env: { human?: string; tty?: boolean } = {},
): ReturnType<typeof captureOutput> {
  return withEnv("REPO_AEGIS_HOME", ctx.home, () =>
    withEnv("REPO_AEGIS_REGISTRY", ctx.registry, () =>
      withEnv("REPO_AEGIS_EGRESS_HUMAN", env.human, () =>
        withStderrTty(env.tty ?? false, () => captureOutput(() => check(opts))),
      ),
    ),
  );
}

describe("check --remote-url — CROSS_ORG_PUSH", () => {
  it("refuses a push whose destination org is outside the repo's trust boundary", () => {
    const ctx = setup("cross-org");
    const repo = makeRepo("cross-org-repo", { class: "private-strict", visibility: "private" });

    const result = run(ctx, {
      cwd: repo,
      range: "HEAD~1..HEAD",
      remoteUrl: "git@github.com:customer-a-org/svc.git",
      json: true,
    });

    assert.equal(result.exitCode, 2);
    const j = lastJsonLine<{ code: string; error: string; details: { destination: string; boundaryOrgs: string[] } }>(
      result.stderr,
    );
    assert.equal(j.code, "CROSS_ORG_PUSH");
    assert.match(j.error, /customer-a-org\/svc/);
    assert.match(j.error, /acme/);
    assert.equal(j.details.destination, "customer-a-org/svc");
    assert.deepEqual(j.details.boundaryOrgs, ["acme"]);
  });

  it("names the ref being pushed in the refusal", () => {
    const ctx = setup("cross-org-ref");
    const repo = makeRepo("cross-org-ref-repo", { class: "private-strict", visibility: "private" });

    const result = run(ctx, {
      cwd: repo,
      range: "HEAD~1..HEAD",
      remoteUrl: "git@github.com:customer-a-org/svc.git",
      json: true,
    });

    const j = lastJsonLine<{ details: { ref: string } }>(result.stderr);
    assert.equal(j.details.ref, "HEAD~1..HEAD");
  });

  it("still refuses when there is no registry at all (empty registry, remote-origin fallback)", () => {
    const ctx = setup("cross-org-no-registry");
    const repo = makeRepo("cross-org-no-registry-repo", {
      class: "private-strict",
      visibility: "private",
    });

    const result = withEnv("REPO_AEGIS_HOME", ctx.home, () =>
      withEnv("REPO_AEGIS_REGISTRY", join(tmp, "no-such-registry.yaml"), () =>
        withEnv("REPO_AEGIS_EGRESS_HUMAN", undefined, () =>
          withStderrTty(false, () =>
            captureOutput(() =>
              check({
                cwd: repo,
                range: "HEAD~1..HEAD",
                remoteUrl: "git@github.com:customer-a-org/svc.git",
                json: true,
              }),
            ),
          ),
        ),
      ),
    );

    assert.equal(result.exitCode, 2);
    assert.equal(lastJsonLine<{ code: string }>(result.stderr).code, "CROSS_ORG_PUSH");
  });

  it("allows a push to an org inside the boundary", () => {
    const ctx = setup("same-org");
    const repo = makeRepo("same-org-repo", { class: "private-strict", visibility: "private" });

    const result = run(ctx, {
      cwd: repo,
      range: "HEAD~1..HEAD",
      remoteUrl: "git@github.com:acme/x.git",
      json: true,
    });

    assert.equal(result.exitCode, undefined);
  });
});

describe("check --remote-url — PUBLIC_PUSH_NEEDS_HUMAN", () => {
  it("refuses a public-facing destination with no human present", () => {
    const ctx = setup("public-no-human");
    const repo = makeRepo("public-no-human-repo", {
      class: "public-eligible",
      visibility: "public",
    });

    const result = run(ctx, {
      cwd: repo,
      pushRef: "refs/heads/main",
      remoteUrl: "git@github.com:acme/x.git",
      json: true,
    });

    assert.equal(result.exitCode, 2);
    const j = lastJsonLine<{ code: string; error: string }>(result.stderr);
    assert.equal(j.code, "PUBLIC_PUSH_NEEDS_HUMAN");
    assert.match(j.error, /acme\/x/);
    assert.match(j.error, /public/);
    assert.match(j.error, /public-eligible/);
    assert.match(j.error, /refs\/heads\/main/);
    assert.match(j.error, /REPO_AEGIS_EGRESS_HUMAN=1/);
    assert.match(j.error, /an agent never sets it/);
  });

  it("fires on class `public-eligible` even when visibility was never cached", () => {
    const ctx = setup("public-eligible-uncached");
    const repo = makeRepo("public-eligible-uncached-repo", { class: "public-eligible" });

    const result = run(ctx, {
      cwd: repo,
      range: "HEAD~1..HEAD",
      remoteUrl: "git@github.com:acme/x.git",
      json: true,
    });

    assert.equal(result.exitCode, 2);
    assert.equal(lastJsonLine<{ code: string }>(result.stderr).code, "PUBLIC_PUSH_NEEDS_HUMAN");
  });

  it("allows it when a human sets REPO_AEGIS_EGRESS_HUMAN=1, and prints the receipt", () => {
    const ctx = setup("public-with-human");
    const repo = makeRepo("public-with-human-repo", {
      class: "public-eligible",
      visibility: "public",
    });

    const result = run(
      ctx,
      { cwd: repo, range: "HEAD~1..HEAD", remoteUrl: "git@github.com:acme/x.git" },
      { human: "1" },
    );

    assert.equal(result.exitCode, undefined);
    assert.match(result.stderr, /repo-aegis: pushing HEAD~1\.\.HEAD → acme\/x \(public\)/);
  });

  it("allows it when stderr is a TTY (a human is watching), with the env var unset", () => {
    const ctx = setup("public-with-tty");
    const repo = makeRepo("public-with-tty-repo", {
      class: "public-eligible",
      visibility: "public",
    });

    const result = run(
      ctx,
      { cwd: repo, range: "HEAD~1..HEAD", remoteUrl: "git@github.com:acme/x.git" },
      { tty: true },
    );

    assert.equal(result.exitCode, undefined);
    assert.match(result.stderr, /repo-aegis: pushing/);
  });
});

describe("check --remote-url — receipt and fail-open", () => {
  it("a private destination inside the boundary exits 0 and prints the receipt", () => {
    const ctx = setup("private-receipt");
    const repo = makeRepo("private-receipt-repo", {
      class: "private-strict",
      visibility: "private",
    });

    const result = run(ctx, {
      cwd: repo,
      pushRef: "refs/heads/main",
      remoteUrl: "git@github.com:acme/x.git",
    });

    assert.equal(result.exitCode, undefined);
    assert.match(result.stderr, /repo-aegis: pushing refs\/heads\/main → acme\/x \(private\)/);
  });

  it("an unparseable remote URL runs no destination checks and prints no receipt", () => {
    const ctx = setup("unparseable");
    // Foreign org in the URL: were the checks to run at all, this would be a
    // CROSS_ORG_PUSH. A non-GitHub host must fail open instead.
    const repo = makeRepo("unparseable-repo", { class: "private-strict", visibility: "private" });

    const result = run(ctx, {
      cwd: repo,
      range: "HEAD~1..HEAD",
      remoteUrl: "git@gitlab.example.com:customer-a-org/svc.git",
      json: true,
    });

    assert.equal(result.exitCode, undefined);
    assert.doesNotMatch(result.stderr, /pushing/);
    const parsed = JSON.parse(result.stdout) as { destination?: unknown };
    assert.equal(parsed.destination, undefined);
  });

  it("a local filesystem remote also fails open", () => {
    const ctx = setup("local-remote");
    const repo = makeRepo("local-remote-repo", { class: "private-strict", visibility: "private" });

    const result = run(ctx, {
      cwd: repo,
      range: "HEAD~1..HEAD",
      remoteUrl: "/srv/git/mirror.git",
      json: true,
    });

    assert.equal(result.exitCode, undefined);
    assert.doesNotMatch(result.stderr, /pushing/);
  });

  it("omitting --remote-url leaves the output envelope unchanged", () => {
    const ctx = setup("no-remote-url");
    const repo = makeRepo("no-remote-url-repo", { class: "private-strict", visibility: "private" });

    const result = run(ctx, { cwd: repo, range: "HEAD~1..HEAD", json: true });

    assert.equal(result.exitCode, undefined);
    const parsed = JSON.parse(result.stdout) as { destination?: unknown };
    assert.equal(parsed.destination, undefined);
    assert.doesNotMatch(result.stderr, /pushing/);
  });
});

describe("check --remote-url — --json destination", () => {
  it("carries org, repo, visibility, class and publicFacing", () => {
    const ctx = setup("json-destination");
    const repo = makeRepo("json-destination-repo", {
      class: "private-strict",
      visibility: "private",
    });

    const result = run(ctx, {
      cwd: repo,
      range: "HEAD~1..HEAD",
      remoteUrl: "https://github.com/acme/x.git",
      json: true,
    });

    assert.equal(result.exitCode, undefined);
    const parsed = JSON.parse(result.stdout) as {
      destination: {
        org: string;
        repo: string;
        visibility: string;
        class: string;
        publicFacing: boolean;
      };
    };
    assert.deepEqual(parsed.destination, {
      org: "acme",
      repo: "x",
      visibility: "private",
      class: "private-strict",
      publicFacing: false,
    });
  });

  it("reports publicFacing: true for a public destination (with a human present)", () => {
    const ctx = setup("json-destination-public");
    const repo = makeRepo("json-destination-public-repo", {
      class: "public-eligible",
      visibility: "public",
    });

    const result = run(
      ctx,
      {
        cwd: repo,
        range: "HEAD~1..HEAD",
        remoteUrl: "git@github.com:acme/x.git",
        json: true,
      },
      { human: "1" },
    );

    const parsed = JSON.parse(result.stdout) as {
      destination: { publicFacing: boolean; visibility: string };
    };
    assert.equal(parsed.destination.publicFacing, true);
    assert.equal(parsed.destination.visibility, "public");
  });
});
