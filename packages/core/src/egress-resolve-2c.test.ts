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
import { scrubGitEnv } from "./_test-git-env.js";

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

let restoreEnv: (() => void) | undefined;

before(() => {
  // The resolver reads this process's ssh-override variables and git config: make them hermetic.
  restoreEnv = scrubGitEnv();
  root = mkdtempSync(join(tmpdir(), "egress-2c-"));
  mkdirSync(join(root, "home"));
  priorHome = process.env["REPO_AEGIS_HOME"];
  process.env["REPO_AEGIS_HOME"] = join(root, "home");
});

after(() => {
  restoreEnv?.();
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

describe("gh base repository: gh's own pick (§3.3 item 3, superseded after the PR 2c review)", () => {
  const issue = "gh issue create -b x";

  it("a checkout with no GitHub origin but upstream=stranger/r is judged against stranger/r, not skipped", () => {
    // Before PR 2c this resolved to null (no origin), so rule h never ran.
    const dir = checkout({ upstream: "git@github.com:stranger/r.git" });
    const d = resolve(issue, dir);
    assert.equal(`${d?.org}/${d?.repo}`, "stranger/r");
    assert.equal(code(decide(issue, dir)), "UNREGISTERED_OWNER_EGRESS");
  });

  it("the fork checkout origin=acme/lib + upstream=upstream-org/lib is judged upstream-org/lib (gh picks upstream)", () => {
    const dir = checkout({
      origin: "git@github.com:acme/lib.git",
      upstream: "https://github.com/upstream-org/lib.git",
    });
    const d = resolve("gh issue comment 5 -b x", dir);
    assert.equal(`${d?.org}/${d?.repo}`, "upstream-org/lib");
    assert.equal(d?.unresolved, undefined, "no candidate set, no ambiguity");
    assert.equal(code(decide("gh issue comment 5 -b x", dir)), "UNREGISTERED_OWNER_EGRESS");
    const decision = decide("gh issue comment 5 -b x", dir);
    const reason = decision.action === "deny" ? decision.reason : "";
    assert.ok(!reason.includes("acme"), `a registered owner is not named: ${reason}`);
  });

  it("an allowed upstream makes that pick workable for `gh issue comment`, and rule g then asks", () => {
    const dir = checkout({
      origin: "git@github.com:acme/lib.git",
      upstream: "https://github.com/upstream-org/lib.git",
    });
    const registry = { ...REGISTRY, allowedUpstreams: ["upstream-org/lib"] } as unknown as Registry;
    const d = decide("gh issue comment 5 -b x", dir, { registry });
    assert.notEqual(code(d), "UNREGISTERED_OWNER_EGRESS");
    assert.equal(d.action, "ask");
  });

  it("origin=acme/x + upstream=acme/y is judged acme/y, and a `*` approval covers it (acme is personal)", () => {
    const dir = checkout({ origin: "git@github.com:acme/x.git", upstream: "git@github.com:acme/y.git" });
    const d = resolve(issue, dir);
    assert.equal(`${d?.org}/${d?.repo}`, "acme/y");
    assert.equal(d?.unresolved, undefined);
    let seen: string | undefined;
    mintApproval({ target: { org: "*", repo: "*" } });
    try {
      const decision = decide(issue, dir, {
        findApproval: (dest, ref, scope) => {
          seen = dest === null ? "null" : `${dest.org}/${dest.repo}`;
          return findApprovalDefault(dest, ref, scope);
        },
        // acme/y is not this checkout's origin and has no cached class: assumed public, so rule g wants an approval.
      });
      assert.equal(decision.action, "allow", "the `*` approval covers a personal-org repository");
      assert.equal(seen, "acme/y");
    } finally {
      revokeApprovals("all");
    }
  });

  it("gh-resolved=base on origin wins over an upstream remote that sorts first (SmartBaseRepo)", () => {
    const dir = checkout(
      { origin: "git@github.com:acme/fork.git", upstream: "https://github.com/stranger/r.git" },
      { "remote.origin.gh-resolved": "base" },
    );
    const d = resolve(issue, dir);
    assert.equal(`${d?.org}/${d?.repo}`, "acme/fork");
    assert.notEqual(code(decide(issue, dir)), "UNREGISTERED_OWNER_EGRESS");
  });

  it("gh-resolved=base on origin is IGNORED by the plain BaseRepo groups: `gh variable set` goes to upstream (H3)", () => {
    const dir = checkout(
      { origin: "git@github.com:acme/fork.git", upstream: "https://github.com/stranger/r.git" },
      { "remote.origin.gh-resolved": "base" },
    );
    for (const cmd of ["gh variable set NAME --body v", "gh secret set NAME --body v"]) {
      const d = resolve(cmd, dir);
      assert.equal(`${d?.org}/${d?.repo}`, "stranger/r", cmd);
      assert.equal(code(decide(cmd, dir)), "UNREGISTERED_OWNER_EGRESS", cmd);
    }
  });

  it("gh-resolved=stranger/r on origin redirects every implicit gh write to THAT repository (F2)", () => {
    const dir = checkout({ origin: "git@github.com:acme/fork.git" }, { "remote.origin.gh-resolved": "stranger/r" });
    const d = resolve(issue, dir);
    assert.equal(`${d?.org}/${d?.repo}`, "stranger/r");
    assert.equal(code(decide(issue, dir)), "UNREGISTERED_OWNER_EGRESS");
  });

  it("the FIRST remote in gh's order that carries gh-resolved wins", () => {
    const dir = checkout(
      { origin: "git@github.com:acme/fork.git", upstream: "https://github.com/acme/up.git" },
      { "remote.origin.gh-resolved": "stranger/r", "remote.upstream.gh-resolved": "base" },
    );
    const d = resolve(issue, dir);
    assert.equal(`${d?.org}/${d?.repo}`, "acme/up");
  });

  it("a gh-resolved of any other shape is unresolved and refused", () => {
    const dir = checkout({ origin: "git@github.com:acme/fork.git" }, { "remote.origin.gh-resolved": "other" });
    const d = resolve(issue, dir);
    assert.equal(d?.unresolved, "gh-resolved");
    assert.equal(code(decide(issue, dir)), "UNREGISTERED_OWNER_EGRESS");
  });

  it("a remote on a non-GitHub host is filtered out, as gh filters to authenticated hosts", () => {
    const dir = checkout(
      { upstream: "https://gitlab.com/stranger/r.git", origin: "git@github.com:acme/svc.git" },
      { "remote.upstream.gh-resolved": "base" },
    );
    const d = resolve(issue, dir);
    assert.equal(`${d?.org}/${d?.repo}`, "acme/svc");
    const local = checkout({ origin: "/srv/local/repo.git" }, { "remote.origin.gh-resolved": "base" });
    assert.equal(resolve(issue, local), null, "no GitHub remote: nothing to judge");
  });

  it("everyday: a plain checkout with origin only resolves to origin, and an explicit --repo wins over remotes", () => {
    const dir = checkout({ origin: "git@github.com:acme/svc.git" });
    const d = resolve(issue, dir);
    assert.equal(`${d?.org}/${d?.repo}`, "acme/svc");
    assert.equal(d?.unresolved, undefined);
    assert.notEqual(code(decide(issue, dir)), "UNREGISTERED_OWNER_EGRESS");
    const explicit = checkout({ origin: "git@github.com:acme/svc.git", upstream: "https://github.com/stranger/r.git" });
    const e = decide("gh issue create --repo acme/x -b x", explicit);
    assert.notEqual(code(e), "UNREGISTERED_OWNER_EGRESS");
  });

  it("a directory that is not a git checkout has no remotes: no destination", () => {
    const dir = join(root, "plain");
    mkdirSync(dir);
    assert.equal(resolve(issue, dir), null);
  });

  it("the same repository on two remotes is one pick", () => {
    const dir = checkout({ origin: "git@github.com:acme/svc.git", mirror: "https://github.com/ACME/svc.git" });
    const d = resolve(issue, dir);
    assert.equal(d?.unresolved, undefined);
    assert.equal(`${d?.org}/${d?.repo}`, "acme/svc");
  });

  it("a top position shared by 'other' remotes naming different repositories is unresolved (gh's order is unstable)", () => {
    const dir = checkout({ aaa: "git@github.com:acme/one.git", bbb: "git@github.com:stranger/two.git" });
    assert.equal(resolve(issue, dir)?.unresolved, "opaque-remote");
    assert.equal(code(decide(issue, dir)), "UNREGISTERED_OWNER_EGRESS");
    // The same two on one repository agree, so there is nothing unstable about it.
    const same = checkout({ aaa: "git@github.com:acme/one.git", bbb: "https://github.com/acme/one" });
    assert.equal(`${resolve(issue, same)?.org}/${resolve(issue, same)?.repo}`, "acme/one");
    // And a ranked name beats the others whatever they are.
    const ranked = checkout({ aaa: "git@github.com:acme/one.git", bbb: "git@github.com:stranger/two.git", origin: "git@github.com:acme/o.git" });
    assert.equal(resolve(issue, ranked)?.repo, "o");
  });

  it("a remote that is URL-shaped but not a clean GitHub URL is never dropped: unresolved when gh could pick it", () => {
    for (const url of ["https://github.com/acme/svc/extra/segments", "https://192.0.2.7/acme/svc.git", "https://sub.github.com/acme/svc.git"]) {
      const dir = checkout({ upstream: url, origin: "git@github.com:acme/svc.git" });
      assert.equal(resolve(issue, dir)?.unresolved, "opaque-remote", url);
      assert.equal(code(decide(issue, dir)), "UNREGISTERED_OWNER_EGRESS", url);
    }
    // A lower-ranked unclean remote does not matter: gh would take origin.
    const lower = checkout({ origin: "git@github.com:acme/svc.git", zzz: "https://github.com/acme/svc/extra/segments" });
    assert.equal(resolve(issue, lower)?.repo, "svc");
  });

  it("every GitHub URL form gh accepts is read the way gh reads it (H1)", () => {
    const forms = [
      "https://GITHUB.COM/stranger/r.git",
      "https://github.com:443/stranger/r.git",
      "ssh://git@ssh.github.com:443/stranger/r.git",
      "https://github.com./stranger/r.git",
      "https://www.github.com/stranger/r.git",
      "ssh://deploy@github.com/stranger/r.git",
      "deploy@github.com:stranger/r.git",
      "git@github.com:/stranger/r.git",
      "git@GitHub.com:stranger/r",
      "https://user:token@github.com/stranger/r",
    ];
    for (const url of forms) {
      const dir = checkout({ origin: url });
      const d = resolve(issue, dir);
      assert.equal(`${d?.org}/${d?.repo}`, "stranger/r", url);
      assert.equal(code(decide(issue, dir)), "UNREGISTERED_OWNER_EGRESS", url);
    }
  });

  it("an insteadOf rewrite set in a separate call redirects the remote, and is read through `git remote -v` (H2)", () => {
    const dir = checkout({ origin: "git@github.com:acme/svc.git" });
    assert.equal(resolve(issue, dir)?.org, "acme");
    git(dir, "config", "url.git@github.com:stranger/.insteadOf", "git@github.com:acme/");
    const d = resolve(issue, dir);
    assert.equal(`${d?.org}/${d?.repo}`, "stranger/svc");
    assert.equal(code(decide(issue, dir)), "UNREGISTERED_OWNER_EGRESS");
  });

  it("R1: a dotted subsection key is attributed to the FIRST dot-segment, as gh does, and the last value wins", () => {
    // `remote.origin.evil.gh-resolved` belongs to `origin` for gh (SplitN(key, ".", 3)[1]), not to `origin.evil`.
    const dir = checkout({ origin: "git@github.com:acme/x.git" });
    assert.equal(resolve(issue, dir)?.org, "acme");
    git(dir, "config", "remote.origin.evil.gh-resolved", "stranger/r");
    const d = resolve(issue, dir);
    assert.equal(`${d?.org}/${d?.repo}`, "stranger/r");
    assert.equal(code(decide(issue, dir)), "UNREGISTERED_OWNER_EGRESS");
    // …and it wins over an earlier `remote.origin.gh-resolved=base` (config order, last wins).
    const both = checkout({ origin: "git@github.com:acme/x.git" }, { "remote.origin.gh-resolved": "base" });
    assert.equal(resolve(issue, both)?.org, "acme");
    git(both, "config", "remote.origin.evil.gh-resolved", "stranger/r");
    assert.equal(`${resolve(issue, both)?.org}/${resolve(issue, both)?.repo}`, "stranger/r");
    // Within one remote, a later value replaces an earlier one (config order).
    const twice = checkout({ origin: "git@github.com:acme/x.git" }, { "remote.origin.gh-resolved": "stranger/r" });
    git(twice, "config", "--add", "remote.origin.gh-resolved", "base");
    assert.equal(`${resolve(issue, twice)?.org}/${resolve(issue, twice)?.repo}`, "acme/x");
  });

  it("R2: the push URL is read only where gh reads it", () => {
    // upstream's FETCH url parses on another host: gh drops the remote by host and never reads its push URL.
    const dir = checkout({ upstream: "https://gitlab.com/x/y.git", origin: "git@github.com:stranger/r.git" });
    git(dir, "remote", "set-url", "--push", "upstream", "git@github.com:acme/x.git");
    const d = resolve(issue, dir);
    assert.equal(`${d?.org}/${d?.repo}`, "stranger/r");
    assert.equal(code(decide(issue, dir)), "UNREGISTERED_OWNER_EGRESS");
    // A fetch URL gh cannot parse (a local path) falls back to the push URL.
    const local = checkout({ upstream: "/srv/local/up.git", origin: "git@github.com:stranger/r.git" });
    git(local, "remote", "set-url", "--push", "upstream", "git@github.com:acme/x.git");
    assert.equal(`${resolve(issue, local)?.org}/${resolve(issue, local)?.repo}`, "acme/x");
  });

  it("the refusal for a gh-resolved junk value carries no remote URL or owner from the checkout", () => {
    const dir = checkout({ origin: "git@github.com:secret-org/secret-repo.git" }, { "remote.origin.gh-resolved": "other" });
    const d = decide(issue, dir);
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
