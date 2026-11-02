// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// PR 2c of the unregistered-owner plan (doc/plan-unregistered-owner-egress.md):
// §3.3 items 3, 4 and 9 (which owner a `gh` write lands on), M5 (several
// candidate repositories), and the destination side of the gist rule. The shape
// rules b′, b″ and D10 are in egress-shape-2c.test.ts.
//
// The git fixtures are hermetic: no global or system config, and none of the
// sandbox's own GIT_SSH_COMMAND.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyApiEndpoint, parseEgressIntents } from "./egress-intent.js";
import {
  decideEgress,
  findApprovalDefault,
  resolveDestinationOffline,
  type DecideEgressOptions,
} from "./egress-policy.js";
import { mintApproval, revokeApprovals } from "./egress-approval.js";
import type { Registry } from "./registry.js";

const REGISTRY = {
  engagements: [
    { id: "customer-a", name: "Customer A", started: "2026-01-01", markers: [], githubOrgs: ["customer-a-org"] },
  ],
  alwaysBlock: [],
  personalOrgs: ["acme"],
  schemaVersion: 2,
} as unknown as Registry;

const HERMETIC_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};
delete HERMETIC_ENV["GIT_SSH_COMMAND"];
delete HERMETIC_ENV["GIT_SSH"];

let root: string;
let priorHome: string | undefined;
let n = 0;

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, env: HERMETIC_ENV, stdio: "ignore" });
}

/** A fresh checkout with the given remotes (name → URL) and extra config (key → value). */
function checkout(remotes: Record<string, string>, config: Record<string, string> = {}): string {
  const dir = join(root, `co-${++n}`);
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  for (const [name, url] of Object.entries(remotes)) git(dir, "remote", "add", name, url);
  for (const [k, v] of Object.entries(config)) git(dir, "config", k, v);
  return dir;
}

before(() => {
  root = mkdtempSync(join(tmpdir(), "egress-2c-"));
  mkdirSync(join(root, "home"));
  priorHome = process.env["REPO_AEGIS_HOME"];
  process.env["REPO_AEGIS_HOME"] = join(root, "home");
});

after(() => {
  if (priorHome === undefined) delete process.env["REPO_AEGIS_HOME"];
  else process.env["REPO_AEGIS_HOME"] = priorHome;
  rmSync(root, { recursive: true, force: true });
});

function decide(command: string, cwd: string, over: Partial<DecideEgressOptions> = {}) {
  return decideEgress({
    intents: parseEgressIntents(command),
    cwd,
    registry: REGISTRY,
    registryState: "loaded",
    humanPresent: false,
    capabilities: { ask: true },
    lookupVisibility: () => null,
    scanPayload: () => 0,
    findApproval: () => null,
    ...over,
  });
}

function resolve(command: string, cwd: string) {
  const intent = parseEgressIntents(command)[0];
  assert.ok(intent, command);
  return resolveDestinationOffline(intent, cwd, REGISTRY);
}

function code(d: ReturnType<typeof decide>): string | undefined {
  return d.action === "allow" ? undefined : d.code;
}

describe("gh base repository: the candidate set (§3.3 item 3)", () => {
  it("a checkout with no GitHub origin but upstream=stranger/r is judged against stranger/r, not skipped", () => {
    // Before PR 2c this resolved to null (no origin), so rule h never ran.
    const dir = checkout({ upstream: "git@github.com:stranger/r.git" });
    const d = resolve("gh issue create -b x", dir);
    assert.equal(`${d?.org}/${d?.repo}`, "stranger/r");
    const decision = decide("gh issue create -b x", dir);
    assert.equal(code(decision), "UNREGISTERED_OWNER_EGRESS");
  });

  it("origin=acme/fork + upstream=stranger/r, no --repo: every remote is a candidate; refused for the stranger", () => {
    const dir = checkout({
      origin: "git@github.com:acme/fork.git",
      upstream: "https://github.com/stranger/r.git",
    });
    const d = resolve("gh issue comment 5 -b x", dir);
    assert.equal(d?.unresolved, "ambiguous-target");
    assert.deepEqual(
      d?.candidates?.map(c => `${c.org}/${c.repo}`),
      ["stranger/r", "acme/fork"],
      "gh's priority order: upstream, then origin",
    );
    const decision = decide("gh issue comment 5 -b x", dir);
    assert.equal(code(decision), "UNREGISTERED_OWNER_EGRESS");
    const reason = decision.action === "deny" ? decision.reason : "";
    assert.match(reason, /"stranger" is not registered/);
    assert.ok(!reason.includes("acme"), `a registered owner is not named: ${reason}`);
  });

  it("an upstream in allowedUpstreams makes the fork checkout workable for `gh issue comment`", () => {
    const dir = checkout({
      origin: "git@github.com:acme/fork.git",
      upstream: "https://github.com/upstream-org/lib.git",
    });
    const registry = { ...REGISTRY, allowedUpstreams: ["upstream-org/lib"] } as unknown as Registry;
    const d = decide("gh issue comment 5 -b x", dir, { registry });
    assert.notEqual(code(d), "UNREGISTERED_OWNER_EGRESS", "both candidates are admitted");
    // Still not silently allowed: the target is ambiguous, so rule g wants a person.
    assert.equal(d.action, "ask");
  });

  it("both candidates registered: rule h passes, and rule g still wants a person (no single repository)", () => {
    const dir = checkout({
      origin: "git@github.com:acme/fork.git",
      upstream: "git@github.com:acme/x.git",
    });
    const d = decide("gh issue create -b x", dir);
    assert.notEqual(code(d), "UNREGISTERED_OWNER_EGRESS");
    assert.equal(d.action, "ask");
  });

  it("gh-resolved=base on origin: the only candidate is origin's owner", () => {
    const dir = checkout(
      { origin: "git@github.com:acme/fork.git", upstream: "https://github.com/stranger/r.git" },
      { "remote.origin.gh-resolved": "base" },
    );
    const d = resolve("gh issue create -b x", dir);
    assert.equal(`${d?.org}/${d?.repo}`, "acme/fork");
    assert.equal(d?.unresolved, undefined);
    assert.notEqual(code(decide("gh issue create -b x", dir)), "UNREGISTERED_OWNER_EGRESS");
  });

  it("gh-resolved=stranger/r on origin redirects every implicit gh write to THAT repository (F2)", () => {
    const dir = checkout({ origin: "git@github.com:acme/fork.git" }, { "remote.origin.gh-resolved": "stranger/r" });
    const d = resolve("gh issue create -b x", dir);
    assert.equal(`${d?.org}/${d?.repo}`, "stranger/r");
    assert.equal(code(decide("gh issue create -b x", dir)), "UNREGISTERED_OWNER_EGRESS");
  });

  it("a gh-resolved of any other shape is unresolved and refused", () => {
    const dir = checkout({ origin: "git@github.com:acme/fork.git" }, { "remote.origin.gh-resolved": "other" });
    const d = resolve("gh issue create -b x", dir);
    assert.equal(d?.unresolved, "gh-resolved");
    assert.equal(code(decide("gh issue create -b x", dir)), "UNREGISTERED_OWNER_EGRESS");
  });

  it("gh-resolved=base on a remote with no GitHub URL is unresolved (fail closed)", () => {
    const dir = checkout({ origin: "/srv/local/repo.git" }, { "remote.origin.gh-resolved": "base" });
    assert.equal(resolve("gh issue create -b x", dir)?.unresolved, "gh-resolved");
  });

  it("everyday: a plain checkout with origin only resolves to origin, and an explicit --repo wins over remotes", () => {
    const dir = checkout({ origin: "git@github.com:acme/svc.git" });
    const d = resolve("gh issue create -b x", dir);
    assert.equal(`${d?.org}/${d?.repo}`, "acme/svc");
    assert.equal(d?.unresolved, undefined);
    assert.notEqual(code(decide("gh issue create -b x", dir)), "UNREGISTERED_OWNER_EGRESS");
    const explicit = checkout({ origin: "git@github.com:acme/svc.git", upstream: "https://github.com/stranger/r.git" });
    const e = decide("gh issue create --repo acme/x -b x", explicit);
    assert.notEqual(code(e), "UNREGISTERED_OWNER_EGRESS");
  });

  it("a directory that is not a git checkout has no candidates: no destination", () => {
    const dir = join(root, "plain");
    mkdirSync(dir);
    assert.equal(resolve("gh issue create -b x", dir), null);
  });

  it("the same repository on two remotes is one candidate", () => {
    const dir = checkout({ origin: "git@github.com:acme/svc.git", mirror: "https://github.com/ACME/svc.git" });
    const d = resolve("gh issue create -b x", dir);
    assert.equal(d?.unresolved, undefined);
    assert.equal(`${d?.org}/${d?.repo}`, "acme/svc");
  });

  it("the refusal for a gh-resolved junk value carries no remote URL or owner from the checkout", () => {
    const dir = checkout({ origin: "git@github.com:secret-org/secret-repo.git" }, { "remote.origin.gh-resolved": "other" });
    const d = decide("gh issue create -b x", dir);
    const reason = d.action === "deny" ? d.reason : "";
    assert.ok(reason.length > 0);
    for (const leaked of ["secret-org", "secret-repo"]) assert.ok(!reason.includes(leaked), reason);
    assert.match(reason, /gh-resolved/);
  });
});

describe("M5: several named repositories are all checked", () => {
  const dir = (): string => {
    const d = join(root, `plain-${++n}`);
    mkdirSync(d);
    return d;
  };

  it("`gh issue transfer 5 acme/y -R acme/x` passes rule h when both are registered, and needs a person", () => {
    const d = decide("gh issue transfer 5 acme/y -R acme/x", dir());
    assert.notEqual(code(d), "UNREGISTERED_OWNER_EGRESS");
    assert.equal(d.action, "ask");
  });

  it("`gh issue transfer 5 stranger/y -R acme/x` is refused for the stranger, naming only the stranger", () => {
    const d = decide("gh issue transfer 5 stranger/y -R acme/x", dir());
    assert.equal(code(d), "UNREGISTERED_OWNER_EGRESS");
    const reason = d.action === "deny" ? d.reason : "";
    assert.match(reason, /"stranger" is not registered/);
    assert.ok(!reason.includes("acme"), reason);
  });

  it("a `*/*` approval changes nothing for the ambiguous case (rule h never asks the finder)", () => {
    let consulted = 0;
    const approval = { id: "aaaaaaaa", org: "*", repo: "*", createdAt: "", expiresAt: "", by: "op" };
    const d = decide("gh issue transfer 5 stranger/y -R acme/x", dir(), {
      findApproval: () => {
        consulted++;
        return approval;
      },
    });
    assert.equal(code(d), "UNREGISTERED_OWNER_EGRESS");
    assert.equal(consulted, 0);
  });
});

describe("gh api endpoints (§3.3 item 4)", () => {
  const dir = (): string => {
    const d = checkout({ origin: "git@github.com:acme/svc.git" });
    return d;
  };

  it("repositories/<id>/… and gists are unresolved opaque-endpoint writes, refused by rule h (not the cwd's origin)", () => {
    for (const cmd of [
      "gh api -X POST repositories/123/issues -f body=x",
      "gh api -X POST gists -f description=x",
      "gh api -X PATCH projects/columns/cards/9 -f note=x",
      "gh api -X POST teams/1/discussions -f title=x",
    ]) {
      const intent = parseEgressIntents(cmd)[0];
      assert.equal(intent?.unresolved, "opaque-endpoint", cmd);
      const d = decide(cmd, dir());
      assert.equal(code(d), "UNREGISTERED_OWNER_EGRESS", cmd);
      assert.equal(d.action === "deny" && d.destination?.unresolved, "opaque-endpoint", cmd);
    }
  });

  it("the refusal explains the endpoint and the repos/<owner>/<repo>/… alternative", () => {
    const d = decide("gh api -X POST repositories/123/issues -f body=x", dir());
    const reason = d.action === "deny" ? d.reason : "";
    assert.match(reason, /does not name an owner/);
    assert.match(reason, /repos\/<owner>\/<repo>\/…/);
    assert.match(reason, /No approval covers this/);
  });

  it("an attached method flag does not hide it: -XPOST on repositories/<id>", () => {
    assert.equal(parseEgressIntents("gh api -XPOST repositories/123/issues -fbody=x")[0]?.unresolved, "opaque-endpoint");
  });

  it("`gh api -X POST markdown` renders text and is not egress", () => {
    assert.deepEqual(parseEgressIntents("gh api -X POST markdown -f text=hi"), []);
    assert.deepEqual(parseEgressIntents("gh api -X POST markdown/raw -f text=hi"), []);
  });

  it("`user/…` is the account's own resources: exempt from rule h, never covered by `*`", () => {
    const cwd = dir();
    const d = resolve("gh api -X PUT user/starred/stranger/r", cwd);
    assert.equal(d?.unresolved, "self");
    const decision = decide("gh api -X PUT user/starred/stranger/r", cwd);
    assert.notEqual(code(decision), "UNREGISTERED_OWNER_EGRESS");
    assert.equal(decision.action, "ask");
    mintApproval({ target: { org: "*", repo: "*" } });
    try {
      const withStar = decide("gh api -X PUT user/starred/stranger/r", cwd, { findApproval: findApprovalDefault });
      assert.equal(withStar.action, "ask", "a live `*` approval does not cover an account-level write");
    } finally {
      revokeApprovals("all");
    }
  });

  it("`user/…` is not attributed to the cwd's origin", () => {
    const d = resolve("gh api -X POST user/repos -f name=x", dir());
    assert.equal(d?.org, "*");
    assert.equal(d?.repo, "*");
  });

  it("repos/<o>/<r>/… is still that owner, and the placeholders still fill from the cwd", () => {
    const cwd = dir();
    assert.equal(resolve("gh api -X POST repos/stranger/r/issues -f body=x", cwd)?.org, "stranger");
    assert.equal(resolve("gh api -X POST orgs/stranger/repos -f name=x", cwd)?.org, "stranger");
    const ph = resolve("gh api -X POST repos/{owner}/{repo}/issues -f body=x", cwd);
    assert.equal(`${ph?.org}/${ph?.repo}`, "acme/svc");
  });

  it("an endpoint on another host is opaque, whatever its first path segment", () => {
    assert.equal(classifyApiEndpoint("https://example.test/user/x").kind, "opaque-endpoint");
    assert.equal(classifyApiEndpoint("https://api.github.com/user/starred/a/b").kind, "self");
    assert.equal(classifyApiEndpoint("https://api.github.com.example.test/user").kind, "opaque-endpoint");
  });

  it("classifyApiEndpoint table", () => {
    const kinds: Array<[string, string]> = [
      ["repos/o/r/issues", "named"],
      ["orgs/o/repos", "named"],
      ["repos/{owner}/{repo}/issues", "cwd"],
      ["user", "self"],
      ["user/repos", "self"],
      ["markdown", "markdown"],
      ["markdown/raw", "markdown"],
      ["graphql", "graphql"],
      ["gists", "opaque-endpoint"],
      ["repositories/1/issues", "opaque-endpoint"],
      ["users/someone/x", "opaque-endpoint"],
      ["repos/acme/x/../../stranger/r/issues", "opaque"],
    ];
    for (const [endpoint, kind] of kinds) assert.equal(classifyApiEndpoint(endpoint).kind, kind, endpoint);
  });
});

describe("gh gist create is the account's, never the cwd's (§3.3 item 9)", () => {
  it("resolves to the account, from any checkout", () => {
    const cwd = checkout({ origin: "git@github.com:acme/svc.git" });
    assert.equal(resolve("gh gist create --public notes.txt", cwd)?.unresolved, "self");
    assert.equal(resolve("gh gist edit abc123 -a x.txt", cwd)?.unresolved, "self");
  });

  it("passes rule h (it is no registered owner's), and no approval covers it", () => {
    const cwd = checkout({ origin: "git@github.com:acme/svc.git" });
    for (const target of [
      { org: "*", repo: "*" },
      { org: "acme", repo: "*" },
      { org: "acme", repo: "svc" },
    ]) {
      mintApproval({ target });
      try {
        const d = decide("gh gist create --public notes.txt", cwd, { findApproval: findApprovalDefault });
        assert.notEqual(code(d), "UNREGISTERED_OWNER_EGRESS");
        assert.equal(d.action, "ask", JSON.stringify(target));
      } finally {
        revokeApprovals("all");
      }
    }
  });

  it("the ask says a person must run it, not 'name a valid owner/repo'", () => {
    const cwd = checkout({ origin: "git@github.com:acme/svc.git" });
    const d = decide("gh gist create notes.txt", cwd);
    assert.equal(d.action, "ask");
    const reason = d.action === "ask" ? d.reason : "";
    assert.match(reason, /your own GitHub account/);
    assert.match(reason, /run it from a terminal/);
    assert.ok(!/valid owner\/repo/.test(reason), reason);
  });
});
