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
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureOutput, withEnv, lastJsonLine, scrubGitEnv, PERSON_ANCESTRY } from "../_test-utils.js";
import { check } from "./check.js";
import {
  approvalsPath,
  auditLogPath,
  mintApproval,
  recordPromptApproval,
  setAncestryReaderForTests,
  type PromptBinding,
} from "@de-otio/repo-aegis-core";

let tmp: string;
let originalCwd: string;
let restoreGitEnv: () => void;

before(() => {
  // Hermetic git env: the pre-push layer reads GIT_SSH_COMMAND / core.sshCommand.
  restoreGitEnv = scrubGitEnv();
  tmp = mkdtempSync(join(tmpdir(), "repo-aegis-check-egress-"));
  originalCwd = process.cwd();
});

after(() => {
  process.chdir(originalCwd);
  restoreGitEnv();
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
  - example
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
 * both sides of the gate assertable. It also reads the process ancestry (an
 * agent host above this process means "not a person"), which depends on who
 * ran the suite, so that is pinned clear too.
 */
function withStderrTty<T>(isTty: boolean, fn: () => T): T {
  const desc = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");
  Object.defineProperty(process.stderr, "isTTY", {
    value: isTty,
    configurable: true,
    writable: true,
  });
  setAncestryReaderForTests(() => PERSON_ANCESTRY);
  try {
    return fn();
  } finally {
    setAncestryReaderForTests(undefined);
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
    const j = lastJsonLine<{ code: string; error: string; details: { destination: string; boundaryOrgs?: string[] } }>(
      result.stderr,
    );
    assert.equal(j.code, "CROSS_ORG_PUSH");
    assert.match(j.error, /customer-a-org\/svc/);
    assert.equal(j.details.destination, "customer-a-org/svc");
    // U7: the cause (the classification sets the boundary), the one fix line, and that no approval widens a boundary.
    assert.match(j.error, /the boundary comes from how this repository is classified, which a person set with `repo-aegis classify`/);
    assert.match(j.error, /a person runs, from a terminal: repo-aegis classify \(it re-classifies this repository/);
    assert.match(j.error, /No approval covers this: an approval cannot widen a trust boundary/);
    // The boundary's owners can be customer orgs: they are not enumerated
    // (plan §8.4 F12), in the text or in the details. Only the destination is named.
    assert.doesNotMatch(j.error, /acme/);
    assert.equal(j.details.boundaryOrgs, undefined);
    assert.doesNotMatch(result.stderr, /acme/);
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
      declaredBy: "origin",
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

describe("check --remote-url — a human approval stands in for the TTY", () => {
  it("a live approval for the destination lets the public push through, and says so", () => {
    const ctx = setup("approval-live");
    const repo = makeRepo("approval-live-repo", { class: "public-eligible", visibility: "public" });
    const a = mintApproval({ target: { org: "acme", repo: "x" }, path: approvalsPath(ctx.home) });

    const result = run(ctx, { cwd: repo, pushRef: "refs/heads/main", remoteUrl: "git@github.com:acme/x.git", json: true });

    assert.equal(result.exitCode, undefined, result.stderr);
    assert.match(result.stderr, new RegExp(`human approval ${a.id} stands in`));
    assert.match(result.stderr, /repo-aegis: pushing refs\/heads\/main → acme\/x \(public\)/);
  });

  it("a ref-scoped approval covers that ref only", () => {
    const ctx = setup("approval-ref");
    const repo = makeRepo("approval-ref-repo", { class: "public-eligible", visibility: "public" });
    execFileSync("git", ["branch", "release/v1"], { cwd: repo });
    mintApproval({ target: { org: "acme", repo: "x" }, ref: "release/v1", path: approvalsPath(ctx.home) });

    const ok = run(ctx, { cwd: repo, pushRef: "refs/heads/release/v1", remoteUrl: "git@github.com:acme/x.git", json: true });
    assert.equal(ok.exitCode, undefined, ok.stderr);
    const no = run(ctx, { cwd: repo, pushRef: "refs/heads/main", remoteUrl: "git@github.com:acme/x.git", json: true });
    assert.equal(no.exitCode, 2);
    const j = lastJsonLine<{ code: string; error: string }>(no.stderr);
    assert.equal(j.code, "PUBLIC_PUSH_NEEDS_HUMAN");
    assert.match(j.error, /repo-aegis approve acme\/x/);
  });

  // D7 (issue #151): a `*` approval covers personalOrgs owners only.
  it("a `*` approval covers a push to a personal org, and not a customer's org", () => {
    const personal = setup("approval-star-personal");
    const personalRepo = makeRepo("approval-star-personal-repo", { class: "public-eligible", visibility: "public" });
    const star = mintApproval({ target: { org: "*", repo: "*" }, path: approvalsPath(personal.home) });
    const ok = run(personal, {
      cwd: personalRepo,
      pushRef: "refs/heads/main",
      remoteUrl: "git@github.com:acme/x.git",
      json: true,
    });
    assert.equal(ok.exitCode, undefined, ok.stderr);
    assert.match(ok.stderr, new RegExp(`human approval ${star.id} stands in`));

    const customer = setup("approval-star-customer");
    const customerRepo = makeRepo("approval-star-customer-repo", {
      class: "public-eligible",
      visibility: "public",
      originUrl: "git@github.com:customer-a-org/x.git",
    });
    // Put the customer's org inside the repo's trust boundary, so CROSS_ORG_PUSH does not fire first.
    execFileSync("git", ["config", "repo-aegis.engagement", "customer-a"], { cwd: customerRepo });
    mintApproval({ target: { org: "*", repo: "*" }, path: approvalsPath(customer.home) });
    const refused = run(customer, {
      cwd: customerRepo,
      pushRef: "refs/heads/main",
      remoteUrl: "git@github.com:customer-a-org/x.git",
      json: true,
    });
    assert.equal(refused.exitCode, 2, refused.stderr);
    assert.equal(lastJsonLine<{ code: string }>(refused.stderr).code, "PUBLIC_PUSH_NEEDS_HUMAN");
    assert.doesNotMatch(refused.stderr, /stands in/);

    // The narrower approvals the refusal's remedy names do cover it.
    for (const target of [
      { org: "customer-a-org", repo: "*" },
      { org: "customer-a-org", repo: "x" },
    ]) {
      const home = setup(`approval-narrow-${target.repo === "*" ? "org" : "repo"}`);
      mintApproval({ target, path: approvalsPath(home.home) });
      const covered = run(home, {
        cwd: customerRepo,
        pushRef: "refs/heads/main",
        remoteUrl: "git@github.com:customer-a-org/x.git",
        json: true,
      });
      assert.equal(covered.exitCode, undefined, `${target.org}/${target.repo}: ${covered.stderr}`);
    }
  });
});

describe("check --remote-url — a destination that is not this repo's origin", () => {
  // The third face of the 2026-09-12 finding: the pre-push hook judged every
  // push by the PUSHING repo's class and visibility, which describe the
  // destination only when the destination is the repo's own origin.

  it("with nothing cached, a foreign URL in a personal org is treated as public and refused without a human", () => {
    const ctx = setup("foreign-uncached");
    const repo = makeRepo("foreign-uncached-repo", { class: "private-strict", visibility: "private" });

    const result = run(ctx, {
      cwd: repo,
      range: "HEAD~1..HEAD",
      remoteUrl: "git@github.com:acme/other.git",
      json: true,
    });

    assert.equal(result.exitCode, 2);
    const j = lastJsonLine<{ code: string; error: string }>(result.stderr);
    assert.equal(j.code, "PUBLIC_PUSH_NEEDS_HUMAN");
    assert.match(j.error, /acme\/other/);
  });

  it("with the destination's checkout recorded, the push is judged by THAT checkout's declaration", () => {
    const ctx = setup("foreign-cached");
    const src = makeRepo("foreign-cached-src", { class: "private-strict", visibility: "private" });
    // A private repo elsewhere on the machine; `check` from inside it records it.
    const dest = makeRepo("foreign-cached-dest", {
      class: "private-strict",
      visibility: "private",
      originUrl: "git@github.com:acme/other.git",
    });
    run(ctx, { cwd: dest, range: "HEAD~1..HEAD", remoteUrl: "git@github.com:acme/other.git", json: true });

    const result = run(ctx, {
      cwd: src,
      range: "HEAD~1..HEAD",
      remoteUrl: "git@github.com:acme/other.git",
      json: true,
    });

    assert.equal(result.exitCode, undefined);
    const parsed = JSON.parse(result.stdout) as { destination: { publicFacing: boolean; declaredBy: string } };
    assert.equal(parsed.destination.declaredBy, "cache");
    assert.equal(parsed.destination.publicFacing, false);
  });

  it("… and a PUBLIC destination checkout makes a push from a private repo need a human", () => {
    const ctx = setup("foreign-cached-public");
    const src = makeRepo("foreign-cached-public-src", { class: "private-strict", visibility: "private" });
    const dest = makeRepo("foreign-cached-public-dest", {
      class: "public-eligible",
      visibility: "public",
      originUrl: "git@github.com:acme/pub.git",
    });
    run(ctx, { cwd: dest, range: "HEAD~1..HEAD", remoteUrl: "git@github.com:acme/pub.git", json: true }, { human: "1" });

    const result = run(ctx, {
      cwd: src,
      range: "HEAD~1..HEAD",
      remoteUrl: "git@github.com:acme/pub.git",
      json: true,
    });

    assert.equal(result.exitCode, 2);
    const j = lastJsonLine<{ code: string; error: string }>(result.stderr);
    assert.equal(j.code, "PUBLIC_PUSH_NEEDS_HUMAN");
    assert.match(j.error, /acme\/pub \(public, public-eligible\)/);
  });
});

describe("check --remote-url — an UNKNOWN visibility fails closed (issue #114)", () => {
  // The pre-push hook used to read an empty `repo-aegis.visibility` cache as
  // "not public" and let the push through under an `(unknown)` receipt. The
  // `gh` shim already treated the same repository as public. Now both share
  // `treatAsPublicDestination`: only a recorded `private` passes unattended.
  //
  // Every test here injects `lookupVisibility`, so none reaches the network.

  const noAnswer = (): null => null;

  it("a repo absent from every cache, pushed from a non-interactive shell with no approval, is refused", () => {
    const ctx = setup("unknown-refused");
    const repo = makeRepo("unknown-refused-repo", {
      class: "private-strict",
      originUrl: "git@github.com:example/unlisted.git",
    });

    const result = run(ctx, {
      cwd: repo,
      pushRef: "refs/heads/main",
      remoteUrl: "git@github.com:example/unlisted.git",
      json: true,
      lookupVisibility: noAnswer,
    });

    assert.equal(result.exitCode, 2);
    const j = lastJsonLine<{ code: string; error: string; details: { visibility: string } }>(result.stderr);
    assert.equal(j.code, "PUBLIC_PUSH_NEEDS_HUMAN");
    assert.match(j.error, /example\/unlisted \(visibility uncached, treated as public, private-strict\)/);
    // The refusal says how a person proceeds.
    assert.match(j.error, /repo-aegis approve example\/unlisted/);
    assert.match(j.error, /repo-aegis status/);
    assert.equal(j.details.visibility, "unknown");
    assert.doesNotMatch(result.stderr, /repo-aegis: pushing/);
  });

  it("is refused with the live lookup disabled too — the refusal never depends on the network", () => {
    const ctx = setup("unknown-no-lookup");
    const repo = makeRepo("unknown-no-lookup-repo", {
      class: "private-strict",
      originUrl: "git@github.com:example/unlisted.git",
    });

    const result = withEnv("REPO_AEGIS_VISIBILITY_LOOKUP", "0", () =>
      run(ctx, {
        cwd: repo,
        range: "HEAD~1..HEAD",
        remoteUrl: "git@github.com:example/unlisted.git",
        json: true,
      }),
    );

    assert.equal(result.exitCode, 2);
    assert.equal(lastJsonLine<{ code: string }>(result.stderr).code, "PUBLIC_PUSH_NEEDS_HUMAN");
  });

  it("a live approval for the destination lets the unknown-visibility push through", () => {
    const ctx = setup("unknown-approved");
    const repo = makeRepo("unknown-approved-repo", {
      class: "private-strict",
      originUrl: "git@github.com:example/unlisted.git",
    });
    const a = mintApproval({ target: { org: "example", repo: "unlisted" }, path: approvalsPath(ctx.home) });

    const result = run(ctx, {
      cwd: repo,
      pushRef: "refs/heads/main",
      remoteUrl: "git@github.com:example/unlisted.git",
      json: true,
      lookupVisibility: noAnswer,
    });

    assert.equal(result.exitCode, undefined, result.stderr);
    assert.match(result.stderr, new RegExp(`human approval ${a.id} stands in`));
    assert.match(
      result.stderr,
      /repo-aegis: pushing refs\/heads\/main → example\/unlisted \(visibility uncached, treated as public\)/,
    );
    const parsed = JSON.parse(result.stdout) as { destination: { publicFacing: boolean; assumedPublic?: boolean } };
    assert.equal(parsed.destination.publicFacing, true);
    assert.equal(parsed.destination.assumedPublic, true);
  });

  it("a human at a TTY gets the public treatment (allowed, with a receipt that says so), not a silent pass", () => {
    const ctx = setup("unknown-tty");
    const repo = makeRepo("unknown-tty-repo", {
      class: "private-strict",
      originUrl: "git@github.com:example/unlisted.git",
    });

    const result = run(
      ctx,
      { cwd: repo, range: "HEAD~1..HEAD", remoteUrl: "git@github.com:example/unlisted.git", lookupVisibility: noAnswer },
      { tty: true },
    );

    assert.equal(result.exitCode, undefined, result.stderr);
    assert.match(result.stderr, /→ example\/unlisted \(visibility uncached, treated as public\)/);
  });

  it("a cached private destination is allowed and never looked up", () => {
    const ctx = setup("cached-private");
    const repo = makeRepo("cached-private-repo", {
      class: "private-strict",
      visibility: "private",
      originUrl: "git@github.com:example/unlisted.git",
    });
    let calls = 0;

    const result = run(ctx, {
      cwd: repo,
      pushRef: "refs/heads/main",
      remoteUrl: "git@github.com:example/unlisted.git",
      json: true,
      lookupVisibility: () => {
        calls++;
        return "public";
      },
    });

    assert.equal(result.exitCode, undefined, result.stderr);
    assert.equal(calls, 0);
    assert.match(result.stderr, /→ example\/unlisted \(private\)/);
  });

  it("refreshes the cache: a lookup that answers `private` lets the push through and is recorded for the next call", () => {
    const ctx = setup("refresh-private");
    const repo = makeRepo("refresh-private-repo", {
      class: "private-strict",
      originUrl: "git@github.com:example/unlisted.git",
    });
    const asked: string[] = [];
    const lookup = (org: string, name: string): "private" => {
      asked.push(`${org}/${name}`);
      return "private";
    };

    const first = run(ctx, {
      cwd: repo,
      pushRef: "refs/heads/main",
      remoteUrl: "git@github.com:example/unlisted.git",
      json: true,
      lookupVisibility: lookup,
    });
    assert.equal(first.exitCode, undefined, first.stderr);
    assert.deepEqual(asked, ["example/unlisted"]);
    assert.match(first.stderr, /→ example\/unlisted \(private\)/);
    const cached = execFileSync("git", ["config", "--get", "repo-aegis.visibility"], { cwd: repo, encoding: "utf8" });
    assert.equal(cached.trim(), "private");

    // The next call reads the cache and does not ask again.
    const second = run(ctx, {
      cwd: repo,
      pushRef: "refs/heads/main",
      remoteUrl: "git@github.com:example/unlisted.git",
      json: true,
      lookupVisibility: lookup,
    });
    assert.equal(second.exitCode, undefined, second.stderr);
    assert.deepEqual(asked, ["example/unlisted"]);
  });

  it("a lookup that answers `public` refuses the push and records `public`", () => {
    const ctx = setup("refresh-public");
    const repo = makeRepo("refresh-public-repo", {
      class: "private-strict",
      originUrl: "git@github.com:example/unlisted.git",
    });

    const result = run(ctx, {
      cwd: repo,
      pushRef: "refs/heads/main",
      remoteUrl: "git@github.com:example/unlisted.git",
      json: true,
      lookupVisibility: () => "public",
    });

    assert.equal(result.exitCode, 2);
    const j = lastJsonLine<{ code: string; error: string }>(result.stderr);
    assert.equal(j.code, "PUBLIC_PUSH_NEEDS_HUMAN");
    assert.match(j.error, /example\/unlisted \(public, private-strict\)/);
    assert.doesNotMatch(j.error, /repo-aegis status/);
    const cached = execFileSync("git", ["config", "--get", "repo-aegis.visibility"], { cwd: repo, encoding: "utf8" });
    assert.equal(cached.trim(), "public");
  });

  it("a foreign URL in no personal org is judged unknown, not by the pushing repo's own `private`", () => {
    const ctx = setup("foreign-unknown");
    const repo = makeRepo("foreign-unknown-repo", {
      class: "private-strict",
      visibility: "private",
      originUrl: "git@github.com:example/src.git",
    });
    const asked: string[] = [];

    const result = run(ctx, {
      cwd: repo,
      range: "HEAD~1..HEAD",
      remoteUrl: "git@github.com:example/elsewhere.git",
      json: true,
      lookupVisibility: (org, name) => {
        asked.push(`${org}/${name}`);
        return null;
      },
    });

    assert.deepEqual(asked, ["example/elsewhere"]);
    assert.equal(result.exitCode, 2);
    const j = lastJsonLine<{ code: string; error: string }>(result.stderr);
    assert.equal(j.code, "PUBLIC_PUSH_NEEDS_HUMAN");
    assert.match(j.error, /example\/elsewhere \(visibility uncached, treated as public/);
    // The source repo's own cache is untouched: it describes the source.
    const cached = execFileSync("git", ["config", "--get", "repo-aegis.visibility"], { cwd: repo, encoding: "utf8" });
    assert.equal(cached.trim(), "private");
  });
});

// ---------------------------------------------------------------------------
// Prompt approvals at pre-push (doc/design/egress-guard.md §4a.1)
//
// A person's yes at an agent's permission prompt is recorded by the agent hook for exactly one command. Pre-push honours
// it only for the same verb (`git-push`), the same repository, and the same REMOTE ref, which the installed script passes
// as `--remote-ref`. A record for another verb (a PR) must never let a push through (F1b), and a script that sends no
// `--remote-ref` (an older install) can never match one.
// ---------------------------------------------------------------------------
describe("check --remote-url — a prompt approval stands in for the TTY, for one exact push", () => {
  const URL = "git@github.com:acme/x.git";
  const T = new Date();

  function auditedCtx(name: string): Ctx {
    const ctx = setup(name);
    writeFileSync(join(ctx.home, "state", "audit-log.json"), JSON.stringify({ enabled: true }));
    return ctx;
  }
  const seed = (ctx: Ctx, b: PromptBinding, now: Date = T) =>
    recordPromptApproval({ binding: b, permissionMode: "default", home: ctx.home, now })!;
  const PUSH_MAIN: PromptBinding = { verb: "git-push", org: "acme", repo: "x", ref: "main" };
  const publicRepo = (name: string) => makeRepo(name, { class: "public-eligible", visibility: "public" });

  it("a matching record lets the update path through, says so, and the audit use is source prompt", () => {
    const ctx = auditedCtx("prompt-update");
    const repo = publicRepo("prompt-update-repo");
    const a = seed(ctx, PUSH_MAIN);
    const r = run(ctx, { cwd: repo, range: "HEAD~1..HEAD", remoteUrl: URL, remoteRef: "refs/heads/main", json: true });
    assert.equal(r.exitCode, undefined, r.stderr);
    assert.match(r.stderr, new RegExp(`human approval ${a.id} stands in`));
    const uses = readFileSync(auditLogPath(ctx.home), "utf8")
      .trim()
      .split("\n")
      .map(l => JSON.parse(l) as { action: string; details: Record<string, unknown> })
      .filter(l => l.action === "egress-approval-use");
    assert.equal(uses.length, 1);
    assert.equal(uses[0]!.details["source"], "prompt");
    assert.equal(uses[0]!.details["id"], a.id);
    assert.equal(uses[0]!.details["layer"], "git pre-push");
  });

  it("a push to a different remote ref, another repository, or after expiry is refused", () => {
    const ctx = auditedCtx("prompt-refused");
    const repo = publicRepo("prompt-refused-repo");
    seed(ctx, PUSH_MAIN);
    const other = run(ctx, { cwd: repo, range: "HEAD~1..HEAD", remoteUrl: URL, remoteRef: "refs/heads/other", json: true });
    assert.equal(other.exitCode, 2, "another ref");
    assert.equal(lastJsonLine<{ code: string }>(other.stderr).code, "PUBLIC_PUSH_NEEDS_HUMAN");
    // a ref that merely starts like the approved one
    const prefix = run(ctx, { cwd: repo, range: "HEAD~1..HEAD", remoteUrl: URL, remoteRef: "refs/heads/main2", json: true });
    assert.equal(prefix.exitCode, 2, "a longer ref name");

    const elsewhere = makeRepo("prompt-refused-other", { class: "public-eligible", visibility: "public", originUrl: "git@github.com:acme/y.git" });
    const otherRepo = run(ctx, { cwd: elsewhere, range: "HEAD~1..HEAD", remoteUrl: "git@github.com:acme/y.git", remoteRef: "refs/heads/main", json: true });
    assert.equal(otherRepo.exitCode, 2, "another repository");

    const ctx2 = auditedCtx("prompt-expired");
    seed(ctx2, PUSH_MAIN, new Date(Date.now() - 10 * 60_000));
    const expired = run(ctx2, { cwd: repo, range: "HEAD~1..HEAD", remoteUrl: URL, remoteRef: "refs/heads/main", json: true });
    assert.equal(expired.exitCode, 2, "an expired record");
    assert.match(lastJsonLine<{ error: string }>(expired.stderr).error, /for 2 minutes/);
  });

  it("a record for a PR on the same repository never lets a push through (F1b)", () => {
    const ctx = auditedCtx("prompt-pr-only");
    const repo = publicRepo("prompt-pr-only-repo");
    seed(ctx, { verb: "gh-pr-create", org: "acme", repo: "x" });
    seed(ctx, { verb: "gh-release-create", org: "acme", repo: "x" });
    const r = run(ctx, { cwd: repo, range: "HEAD~1..HEAD", remoteUrl: URL, remoteRef: "refs/heads/main", json: true });
    assert.equal(r.exitCode, 2, r.stderr);
    assert.equal(lastJsonLine<{ code: string }>(r.stderr).code, "PUBLIC_PUSH_NEEDS_HUMAN");
  });

  it("the new-ref path binds the REMOTE side: --push-ref refs/heads/feat --remote-ref refs/heads/main passes against `main`", () => {
    const ctx = auditedCtx("prompt-new-ref");
    const repo = publicRepo("prompt-new-ref-repo");
    execFileSync("git", ["branch", "feat"], { cwd: repo });
    seed(ctx, PUSH_MAIN);
    const ok = run(ctx, { cwd: repo, pushRef: "refs/heads/feat", remoteUrl: URL, remoteRef: "refs/heads/main", json: true });
    assert.equal(ok.exitCode, undefined, ok.stderr);
    // The local side is not what is approved: a record for `feat` does not cover pushing feat TO main.
    const ctx2 = auditedCtx("prompt-new-ref-local");
    seed(ctx2, { ...PUSH_MAIN, ref: "feat" });
    const no = run(ctx2, { cwd: repo, pushRef: "refs/heads/feat", remoteUrl: URL, remoteRef: "refs/heads/main", json: true });
    assert.equal(no.exitCode, 2, "binding to the local ref would let this through");
  });

  it("no --remote-ref (an older installed script) is refused, and the text names `repo-aegis install hooks`", () => {
    const ctx = auditedCtx("prompt-old-script");
    const repo = publicRepo("prompt-old-script-repo");
    seed(ctx, PUSH_MAIN);
    for (const opts of [{ range: "HEAD~1..HEAD" }, { pushRef: "refs/heads/main" }]) {
      const r = run(ctx, { cwd: repo, ...opts, remoteUrl: URL, json: true });
      assert.equal(r.exitCode, 2, r.stderr);
      const j = lastJsonLine<{ code: string; error: string }>(r.stderr);
      assert.equal(j.code, "PUBLIC_PUSH_NEEDS_HUMAN");
      assert.match(j.error, /repo-aegis install hooks/);
    }
  });

  it("a terminal approval still wins first, and is audited as terminal", () => {
    const ctx = auditedCtx("prompt-terminal-first");
    const repo = publicRepo("prompt-terminal-first-repo");
    const t = mintApproval({ target: { org: "acme", repo: "x" }, path: approvalsPath(ctx.home) });
    seed(ctx, PUSH_MAIN);
    const r = run(ctx, { cwd: repo, range: "HEAD~1..HEAD", remoteUrl: URL, remoteRef: "refs/heads/main", json: true });
    assert.equal(r.exitCode, undefined, r.stderr);
    assert.match(r.stderr, new RegExp(`human approval ${t.id} stands in`));
    const use = readFileSync(auditLogPath(ctx.home), "utf8")
      .trim()
      .split("\n")
      .map(l => JSON.parse(l) as { action: string; details: Record<string, unknown> })
      .find(l => l.action === "egress-approval-use");
    assert.equal(use?.details["source"], "terminal");
  });

  it("a person at the keyboard needs no approval (unchanged)", () => {
    const ctx = auditedCtx("prompt-unchanged");
    const repo = publicRepo("prompt-unchanged-repo");
    const human = run(ctx, { cwd: repo, range: "HEAD~1..HEAD", remoteUrl: URL, remoteRef: "refs/heads/main", json: true }, { tty: true });
    assert.equal(human.exitCode, undefined, human.stderr);
  });
});
