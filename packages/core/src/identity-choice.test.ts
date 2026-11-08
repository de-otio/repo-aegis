// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// doc/plan-owner-identity.md §13.1: identityPresence, ghCallTargets, chooseIdentity (rules 1 to 11, in order).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  chooseIdentity,
  ghCallInfo,
  ghCallTargets,
  identityPresence,
  type ChooseIdentityInput,
  type GhCallTarget,
  type IdentityChoice,
  type IdentityPresence,
} from "./identity-choice.js";
import type { Identity, OwnerIdentities, Registry } from "./registry.js";
import type { TerminalCheck } from "./process-ancestry.js";

// ---- fixtures --------------------------------------------------------------

const ME: Identity = { name: "me", kind: "gh-login", login: "alice" };
const ME_BOT: Identity = { name: "me-bot", kind: "github-app", app: "example-bot" };
const WORK: Identity = { name: "work", kind: "gh-login", login: "alice-work" };

/** owner → identities. `both-org`: person + agent; `person-org`: person only; `agent-org`: agent only. */
const MAP: ReadonlyMap<string, OwnerIdentities> = new Map<string, OwnerIdentities>([
  ["both-org", { person: ME, agent: ME_BOT }],
  ["person-org", { person: WORK }],
  ["agent-org", { agent: ME_BOT }],
]);

function reg(over: Partial<Registry> = {}): Registry {
  return { engagements: [], alwaysBlock: [], identityMap: MAP, ...over };
}

const lit = (owner: string, repo: string | null = "r"): GhCallTarget => ({ owner, repo, source: "literal" });
const cwdT = (owner: string, repo: string | null = "r"): GhCallTarget => ({ owner, repo, source: "cwd" });

const PR_VIEW = ["pr", "view", "5", "--repo", "both-org/r"] as const;

function input(over: Partial<ChooseIdentityInput> = {}): ChooseIdentityInput {
  return {
    args: PR_VIEW,
    isWrite: false,
    targets: [lit("both-org")],
    registry: reg(),
    presence: "person",
    approvalFor: () => null,
    suppliedToken: false,
    redirect: null,
    registeredOwner: () => false,
    ...over,
  };
}

function refused(c: IdentityChoice): string {
  assert.equal(c.kind, "refuse", JSON.stringify(c));
  return c.kind === "refuse" ? c.code : "";
}

// ---- identityPresence (A1) -------------------------------------------------

describe("identityPresence", () => {
  const CASES: [TerminalCheck, IdentityPresence][] = [
    [{ kind: "clear" }, "person"],
    [{ kind: "clear", root: "Terminal" }, "person"],
    [{ kind: "skipped" }, "person"],
    [{ kind: "agent", ancestor: "claude" }, "agent"],
    [{ kind: "agent", ancestor: "claude", via: "env" }, "agent"],
    [{ kind: "no-tty" }, "agent"],
    [{ kind: "unrooted" }, "unknown"],
    [{ kind: "undeterminable", why: "x" }, "unknown"],
  ];
  for (const [check, want] of CASES) {
    it(`${check.kind} -> ${want}`, () => assert.equal(identityPresence(check), want));
  }
  it("an unforeseen kind is unknown, never person", () => {
    assert.equal(identityPresence({ kind: "weird" } as unknown as TerminalCheck), "unknown");
  });
});

// ---- ghCallTargets ---------------------------------------------------------

describe("ghCallTargets", () => {
  const T = (args: string[], ctx: Parameters<typeof ghCallTargets>[1] = {}): GhCallTarget[] => ghCallTargets(args, ctx);

  it("--repo, lowercased", () => {
    assert.deepEqual(T(["pr", "view", "5", "--repo", "Example-Org/Repo"]), [
      { owner: "example-org", repo: "repo", source: "literal" },
    ]);
  });
  it("-R, -R attached, -R=, --repo=", () => {
    for (const a of [["-R", "o/r"], ["-Ro/r"], ["-R=o/r"], ["--repo=o/r"]]) {
      assert.deepEqual(T(["issue", "list", ...a]), [{ owner: "o", repo: "r", source: "literal" }], a.join(" "));
    }
  });
  it("--repo before the command words", () => {
    assert.deepEqual(T(["--repo", "o/r", "issue", "create"]), [{ owner: "o", repo: "r", source: "literal" }]);
  });
  it("the last --repo wins (pflag)", () => {
    assert.deepEqual(T(["issue", "list", "--repo", "a/x", "--repo", "b/y"]), [{ owner: "b", repo: "y", source: "literal" }]);
  });
  it("a github.com URL argument names its repository", () => {
    assert.deepEqual(T(["pr", "view", "https://github.com/Example-Org/r/pull/5"]), [
      { owner: "example-org", repo: "r", source: "literal" },
    ]);
  });
  it("a URL argument and the cwd: the URL replaces the base", () => {
    assert.deepEqual(
      T(["pr", "view", "https://github.com/o/r/pull/5"], { cwdRemoteOwnerRepo: { owner: "c", repo: "d" } }),
      [{ owner: "o", repo: "r", source: "literal" }],
    );
  });
  it("gh repo view <owner>/<repo> is literal (a read names its owner too)", () => {
    assert.deepEqual(T(["repo", "view", "o/r"]), [{ owner: "o", repo: "r", source: "literal" }]);
  });
  it("gh api repos/<o>/<r>/...", () => {
    assert.deepEqual(T(["api", "repos/O/R/issues/5/comments", "-f", "body=x"]), [{ owner: "o", repo: "r", source: "literal" }]);
  });
  it("gh api orgs/<o>/... is an org-level target", () => {
    assert.deepEqual(T(["api", "orgs/O/repos"]), [{ owner: "o", repo: null, source: "literal" }]);
  });
  it("gh api with {owner}/{repo} placeholders uses the base", () => {
    assert.deepEqual(T(["api", "repos/{owner}/{repo}/issues"], { cwdRemoteOwnerRepo: { owner: "c", repo: "d" } }), [
      { owner: "c", repo: "d", source: "cwd" },
    ]);
    assert.deepEqual(T(["api", "repos/{owner}/{repo}/issues"], { ghRepoEnv: "e/f" }), [{ owner: "e", repo: "f", source: "gh-repo-env" }]);
  });
  it("M2: gh api endpoints that name no owner get no base", () => {
    const ctx = { cwdRemoteOwnerRepo: { owner: "c", repo: "d" }, ghRepoEnv: "e/f" };
    for (const ep of ["user", "user/repos", "notifications", "search/issues?q=x", "gists", "rate_limit"]) {
      assert.deepEqual(T(["api", ep], ctx), [], ep);
    }
  });
  it("graphql: a write keeps the base, a read (or unknown) gets none", () => {
    const base = { cwdRemoteOwnerRepo: { owner: "c", repo: "d" } };
    assert.deepEqual(T(["api", "graphql", "-f", "query=x"], { ...base, isWrite: true }), [{ owner: "c", repo: "d", source: "cwd" }]);
    assert.deepEqual(T(["api", "graphql", "-f", "query=x"], { ...base, ghRepoEnv: "e/f", isWrite: true }), [{ owner: "e", repo: "f", source: "gh-repo-env" }]);
    assert.deepEqual(T(["api", "graphql", "-f", "query=x"], { ...base, isWrite: false }), []);
    assert.deepEqual(T(["api", "graphql", "-f", "query=x"], base), []);
  });
  it("graphql write with only a cwd base is refused for an agent with an agent identity; a read is not injected", () => {
    const args = ["api", "graphql", "-f", "query=x"];
    const base = { cwdRemoteOwnerRepo: { owner: "both-org", repo: "r" } };
    const w = chooseIdentity(input({ args, presence: "agent", isWrite: true, targets: ghCallTargets(args, { ...base, isWrite: true }) }));
    assert.equal(refused(w), "GH_IDENTITY_NEEDS_LITERAL_TARGET");
    const r = chooseIdentity(input({ args, presence: "agent", isWrite: false, targets: ghCallTargets(args, { ...base, isWrite: false }) }));
    assert.deepEqual(r, { kind: "none" });
  });
  it("M2: owner-less groups get no base", () => {
    const ctx = { cwdRemoteOwnerRepo: { owner: "c", repo: "d" }, ghRepoEnv: "e/f" };
    for (const a of [["gist", "list"], ["ssh-key", "list"], ["gpg-key", "list"], ["org", "list"], ["status"], ["auth", "status"], ["codespace", "list"], ["extension", "list"], ["alias", "list"], ["config", "get", "x"], ["search", "repos", "foo"], ["repo", "list"]]) {
      assert.deepEqual(T(a, ctx), [], a.join(" "));
    }
  });
  it("M2: gh repo list <owner> and gh search --owner <o> are owner-only literals", () => {
    const ctx = { cwdRemoteOwnerRepo: { owner: "c", repo: "d" } };
    assert.deepEqual(T(["repo", "list", "O"], ctx), [{ owner: "o", repo: null, source: "literal" }]);
    assert.deepEqual(T(["search", "repos", "foo", "--owner", "O"], ctx), [{ owner: "o", repo: null, source: "literal" }]);
    assert.deepEqual(T(["search", "repos", "foo", "--owner=O"], ctx), [{ owner: "o", repo: null, source: "literal" }]);
    assert.deepEqual(T(["search", "issues", "foo", "--repo", "o/r"], ctx), [{ owner: "o", repo: "r", source: "literal" }]);
  });
  it("L1: {owner}/{repo} placeholders use the base only when no --repo was given", () => {
    const ctx = { cwdRemoteOwnerRepo: { owner: "c", repo: "d" } };
    assert.deepEqual(T(["api", "repos/{owner}/{repo}/issues", "-R", "o/r"], ctx), [{ owner: "o", repo: "r", source: "literal" }]);
  });
  it("an opaque api endpoint yields no target and no fallback", () => {
    assert.deepEqual(T(["api", "repos/$X/r/issues"], { cwdRemoteOwnerRepo: { owner: "c", repo: "d" } }), []);
  });
  it("GH_REPO, with source gh-repo-env", () => {
    assert.deepEqual(T(["issue", "list"], { ghRepoEnv: "E/F" }), [{ owner: "e", repo: "f", source: "gh-repo-env" }]);
  });
  it("--repo beats GH_REPO, GH_REPO beats the cwd", () => {
    const ctx = { ghRepoEnv: "e/f", cwdRemoteOwnerRepo: { owner: "c", repo: "d" } };
    assert.deepEqual(T(["issue", "list", "-R", "o/r"], ctx), [{ owner: "o", repo: "r", source: "literal" }]);
    assert.deepEqual(T(["issue", "list"], ctx), [{ owner: "e", repo: "f", source: "gh-repo-env" }]);
  });
  it("the cwd's remote, source cwd, lowercased", () => {
    assert.deepEqual(T(["issue", "list"], { cwdRemoteOwnerRepo: { owner: "C", repo: "D" } }), [{ owner: "c", repo: "d", source: "cwd" }]);
  });
  it("nothing to resolve from: no targets", () => {
    assert.deepEqual(T(["issue", "list"]), []);
    assert.deepEqual(T([]), []);
    assert.deepEqual(T(["--version"], { cwdRemoteOwnerRepo: { owner: "c", repo: "d" } }), []);
  });
  it("an unreadable --repo or GH_REPO yields no target and does not fall back", () => {
    const cwd = { cwdRemoteOwnerRepo: { owner: "c", repo: "d" } };
    assert.deepEqual(T(["issue", "list", "--repo", "$X"], cwd), []);
    assert.deepEqual(T(["issue", "list"], { ...cwd, ghRepoEnv: "$X" }), []);
  });
  it("aliases are not expanded: an unknown first word is scanned as written", () => {
    // `co` could be an alias for anything; it is not rewritten, so nothing is named but the base.
    assert.deepEqual(T(["co", "5"], { cwdRemoteOwnerRepo: { owner: "c", repo: "d" } }), [{ owner: "c", repo: "d", source: "cwd" }]);
    assert.deepEqual(T(["co", "5", "--repo", "o/r"]), [{ owner: "o", repo: "r", source: "literal" }]);
  });
  it("several owners, in the order they appear", () => {
    assert.deepEqual(T(["pr", "view", "https://github.com/a/x/pull/1", "https://github.com/b/y/pull/2"]), [
      { owner: "a", repo: "x", source: "literal" },
      { owner: "b", repo: "y", source: "literal" },
    ]);
    assert.deepEqual(T(["issue", "transfer", "5", "b/y", "--repo", "a/x"]), [
      { owner: "a", repo: "x", source: "literal" },
      { owner: "b", repo: "y", source: "literal" },
    ]);
  });
  it("issue transfer without --repo judges the base as well", () => {
    assert.deepEqual(T(["issue", "transfer", "5", "b/y"], { cwdRemoteOwnerRepo: { owner: "a", repo: "x" } }), [
      { owner: "b", repo: "y", source: "literal" },
      { owner: "a", repo: "x", source: "cwd" },
    ]);
  });
  it("--org of secret set names an org-level target", () => {
    assert.deepEqual(T(["secret", "set", "NAME", "--org", "O"], { cwdRemoteOwnerRepo: { owner: "c", repo: "d" } }), [
      { owner: "o", repo: null, source: "literal" },
    ]);
  });
  it("duplicates collapse", () => {
    assert.deepEqual(T(["pr", "view", "https://github.com/a/x/pull/1", "https://github.com/A/X/pull/2"]).length, 1);
  });
  it("M1: a reference on another host yields no target and sets the foreign flag", () => {
    const ctx = { cwdRemoteOwnerRepo: { owner: "c", repo: "d" } };
    const FOREIGN: string[][] = [
      ["issue", "list", "--repo", "evil.example.com/mapped/r"],
      ["pr", "view", "https://evil.example.com/mapped/r/pull/1"],
      ["repo", "view", "git@evil.example.com:mapped/r"],
      ["issue", "list", "--repo", "tenant.ghe.com/mapped/r"],
      ["issue", "list", "--repo", "localhost/mapped/r"],
      ["issue", "list", "--repo", "EVIL.example.com/mapped/r"],
      ["issue", "list", "-R", "ssh://git@evil.example.com/mapped/r"],
      ["pr", "view", "https://github.com@evil.example.com/mapped/r/pull/1"],
      ["pr", "view", "https://github.com.evil.example.com/mapped/r/pull/1"],
      ["api", "https://evil.example.com/repos/mapped/r/issues"],
    ];
    for (const a of FOREIGN) {
      const info = ghCallInfo(a, ctx);
      assert.deepEqual(info.targets, [], a.join(" "));
      assert.equal(info.foreignHost, true, a.join(" "));
    }
    const h = ghCallInfo(["api", "--hostname", "evil.example.com", "repos/mapped/r/issues"], ctx);
    assert.equal(h.foreignHost, true, "--hostname with a foreign host sets the flag");
    assert.ok(ghCallInfo(["issue", "list", "--repo", "evil.example.com/mapped/r"], ctx).foreignOwners.includes("mapped"));
    assert.ok(ghCallInfo(["pr", "view", "https://evil.example.com/mapped/r/pull/1"], ctx).foreignOwners.includes("mapped"));
    assert.ok(ghCallInfo(["issue", "list", "--repo", "localhost/mapped/r"], ctx).foreignOwners.includes("mapped"));
    assert.ok(ghCallInfo(["repo", "view", "git@evil.example.com:mapped/r"], ctx).foreignOwners.includes("mapped"));
  });
  it("M1: github.com and www.github.com are not foreign (any case); GH_REPO with a foreign host is", () => {
    for (const a of [["issue", "list", "--repo", "github.com/o/r"], ["issue", "list", "--repo", "WWW.GitHub.com/o/r"], ["pr", "view", "https://github.com/o/r/pull/1"], ["repo", "view", "git@github.com:o/r"]]) {
      const info = ghCallInfo(a, {});
      assert.equal(info.foreignHost, false, a.join(" "));
      assert.deepEqual(info.targets, [{ owner: "o", repo: "r", source: "literal" }], a.join(" "));
    }
    const env = ghCallInfo(["issue", "list"], { ghRepoEnv: "evil.example.com/o/r" });
    assert.equal(env.foreignHost, true);
    assert.deepEqual(env.targets, []);
  });
  it("never throws on odd input", () => {
    for (const args of [[""], ["--"], ["-"], ["--repo"], ["-R"], ["api"], ["api", ""], ["\u0000", "‮"]]) {
      assert.ok(Array.isArray(ghCallTargets(args, { ghRepoEnv: "", cwdRemoteOwnerRepo: { owner: "", repo: "" } })));
    }
  });
});

// ---- chooseIdentity: one table per rule ------------------------------------

describe("rule 1 (A10): auth-changing verbs need a person", () => {
  const BAD: string[][] = [
    ["auth", "token"],
    ["auth", "login"],
    ["auth", "logout"],
    ["auth", "switch"],
    ["auth", "refresh"],
    ["auth", "setup-git"],
    ["auth", "status", "--show-token"],
    ["auth", "status", "-t"],
    ["auth", "status", "-ht"],
    ["auth", "--hostname", "github.com", "token"],
    ["config", "set", "editor", "vim"],
    ["config", "clear-cache"],
    ["alias", "set", "x", "pr list"],
    ["alias", "import"],
    ["alias", "delete", "x"],
    ["extension", "install", "o/gh-x"],
    ["extension", "upgrade", "--all"],
    ["extension", "exec", "x"],
  ];
  const OK: string[][] = [
    ["auth", "status"],
    ["auth", "status", "--hostname", "github.com"],
    ["config", "get", "editor"],
    ["config", "list"],
    ["alias", "list"],
    ["extension", "list"],
    ["pr", "list"],
  ];
  for (const presence of ["agent", "unknown"] as const) {
    for (const args of BAD) {
      it(`${presence}: gh ${args.join(" ")} is GH_AUTH_NEEDS_HUMAN, whatever the registry and targets`, () => {
        for (const targets of [[], [lit("both-org")], [lit("nobody")]]) {
          assert.equal(refused(chooseIdentity(input({ args, presence, targets }))), "GH_AUTH_NEEDS_HUMAN");
        }
      });
    }
    for (const args of OK) {
      it(`${presence}: gh ${args.join(" ")} is not refused by rule 1`, () => {
        const c = chooseIdentity(input({ args, presence, targets: [] }));
        assert.deepEqual(c, { kind: "none" });
      });
    }
  }
  it("a person present is not refused by rule 1", () => {
    for (const args of BAD) assert.notEqual(chooseIdentity(input({ args, presence: "person", targets: [] })).kind, "refuse", args.join(" "));
  });
  it("comes first: it beats the unknown-presence refusal", () => {
    assert.equal(refused(chooseIdentity(input({ args: ["auth", "token"], presence: "unknown" }))), "GH_AUTH_NEEDS_HUMAN");
  });
  it("the reason names no token and carries the code", () => {
    const c = chooseIdentity(input({ args: ["auth", "token"], presence: "agent" }));
    assert.ok(c.kind === "refuse" && c.reason.includes("GH_AUTH_NEEDS_HUMAN") && c.reason.includes("do not run that yourself"));
  });
});

describe("rule 2: no target", () => {
  it("is none for every presence", () => {
    for (const presence of ["person", "agent", "unknown"] as const) {
      assert.deepEqual(chooseIdentity(input({ presence, targets: [] })), { kind: "none" });
    }
  });
  it("beats a redirect, a supplied token and unsafe arguments", () => {
    assert.deepEqual(
      chooseIdentity(input({ targets: [], presence: "agent", redirect: "HTTPS_PROXY", suppliedToken: true, args: ["pr", "view", "-w"] })),
      { kind: "none" },
    );
  });
});

describe("rule 3: several owners", () => {
  it("any mapped -> GH_IDENTITY_SEVERAL_OWNERS, for every presence and verb kind", () => {
    for (const presence of ["person", "agent", "unknown"] as const) {
      for (const isWrite of [true, false]) {
        const c = chooseIdentity(input({ presence, isWrite, targets: [lit("both-org"), lit("nobody")] }));
        assert.equal(refused(c), "GH_IDENTITY_SEVERAL_OWNERS");
      }
    }
  });
  it("owners compare lowercased, so the same owner twice is one owner", () => {
    const c = chooseIdentity(input({ targets: [lit("BOTH-ORG", "a"), lit("both-org", "b")] }));
    assert.equal(c.kind, "inject");
    assert.equal(c.kind === "inject" ? c.repo : "x", null, "two repositories of one owner: no single repository");
  });
  it("none of them mapped -> not rule 3", () => {
    assert.deepEqual(chooseIdentity(input({ targets: [lit("nobody"), lit("other")] })), { kind: "none" });
  });
  it("names no owner in the reason", () => {
    const c = chooseIdentity(input({ targets: [lit("both-org"), lit("secret-owner")] }));
    assert.ok(c.kind === "refuse" && !c.reason.includes("secret-owner") && !c.reason.includes("both-org"));
  });
  it("comes before rule 4 and rule 5", () => {
    assert.equal(refused(chooseIdentity(input({ presence: "unknown", targets: [lit("both-org"), lit("nobody")] }))), "GH_IDENTITY_SEVERAL_OWNERS");
  });
});

describe("rule 4: unmapped owner", () => {
  const strict = reg({ requireIdentity: true });
  it("requireIdentity + write + agent + registered -> GH_IDENTITY_UNMAPPED_OWNER", () => {
    const c = chooseIdentity(input({ registry: strict, isWrite: true, presence: "agent", targets: [lit("lost-org")], registeredOwner: () => true }));
    assert.equal(refused(c), "GH_IDENTITY_UNMAPPED_OWNER");
  });
  it("presence unknown counts as not a person", () => {
    const c = chooseIdentity(input({ registry: strict, isWrite: true, presence: "unknown", targets: [lit("lost-org")], registeredOwner: () => true }));
    assert.equal(refused(c), "GH_IDENTITY_UNMAPPED_OWNER");
  });
  const NONE: [string, Partial<ChooseIdentityInput>][] = [
    ["requireIdentity unset", { registry: reg() }],
    ["requireIdentity false", { registry: reg({ requireIdentity: false }) }],
    ["a read", { isWrite: false }],
    ["a person present", { presence: "person" }],
    ["the owner not registered", { registeredOwner: () => false }],
  ];
  for (const [name, over] of NONE) {
    it(`is none: ${name}`, () => {
      const base: Partial<ChooseIdentityInput> = {
        registry: strict, isWrite: true, presence: "agent", targets: [lit("lost-org")], registeredOwner: () => true,
      };
      assert.deepEqual(chooseIdentity(input({ ...base, ...over })), { kind: "none" });
    });
  }
  it("an identityMap entry with neither column is unmapped", () => {
    const registry = reg({ requireIdentity: true, identityMap: new Map([["empty-org", {}]]) });
    const c = chooseIdentity(input({ registry, isWrite: true, presence: "agent", targets: [lit("empty-org")], registeredOwner: () => true }));
    assert.equal(refused(c), "GH_IDENTITY_UNMAPPED_OWNER");
  });
  it("a registry without identityMap has no mapped owner", () => {
    const c = chooseIdentity(input({ registry: { engagements: [], alwaysBlock: [] }, presence: "agent", suppliedToken: true, redirect: "X" }));
    assert.deepEqual(c, { kind: "none" });
  });
  it("registeredOwner receives the lowercased owner", () => {
    const seen: string[] = [];
    chooseIdentity(input({ registry: strict, isWrite: true, presence: "agent", targets: [lit("Lost-Org")], registeredOwner: o => (seen.push(o), false) }));
    assert.deepEqual(seen, ["lost-org"]);
  });
  it("comes before the token, redirect and argument rules: an unmapped call is passed through", () => {
    assert.deepEqual(
      chooseIdentity(input({ targets: [lit("nobody")], presence: "agent", suppliedToken: true, redirect: "HTTPS_PROXY", args: ["pr", "view", "-w"] })),
      { kind: "none" },
    );
  });
});

describe("rule 5: mapped owner, presence unknown", () => {
  it("is GH_IDENTITY_PRESENCE_UNKNOWN for every mapped shape", () => {
    for (const owner of ["both-org", "person-org", "agent-org"]) {
      for (const isWrite of [true, false]) {
        assert.equal(refused(chooseIdentity(input({ presence: "unknown", isWrite, targets: [lit(owner)] }))), "GH_IDENTITY_PRESENCE_UNKNOWN");
      }
    }
  });
  it("ORDER: beats a supplied token, a redirect and unsafe arguments", () => {
    const c = chooseIdentity(input({ presence: "unknown", suppliedToken: true, redirect: "GH_HOST", args: ["pr", "view", "-w"] }));
    assert.equal(refused(c), "GH_IDENTITY_PRESENCE_UNKNOWN");
  });
  it("an approval does not help", () => {
    const c = chooseIdentity(input({ presence: "unknown", isWrite: true, approvalFor: () => "a1", targets: [lit("person-org")] }));
    assert.equal(refused(c), "GH_IDENTITY_PRESENCE_UNKNOWN");
  });
});

describe("rule 6: redirecting environment", () => {
  for (const presence of ["person", "agent"] as const) {
    it(`${presence}: any redirect on a mapped owner is GH_IDENTITY_ENV_REDIRECT`, () => {
      for (const redirect of ["HTTPS_PROXY", "GH_HOST", "http_unix_socket"]) {
        assert.equal(refused(chooseIdentity(input({ presence, redirect }))), "GH_IDENTITY_ENV_REDIRECT");
      }
    });
  }
  it("ORDER: beats a supplied token and unsafe arguments", () => {
    const c = chooseIdentity(input({ presence: "agent", redirect: "HTTPS_PROXY", suppliedToken: true, args: ["pr", "view", "-w"] }));
    assert.equal(refused(c), "GH_IDENTITY_ENV_REDIRECT");
  });
  it("null redirect does not refuse", () => assert.equal(chooseIdentity(input({ redirect: null })).kind, "inject"));
});

describe("rule 7: a supplied token with an agent", () => {
  it("agent + suppliedToken on a mapped owner is GH_IDENTITY_TOKEN_SUPPLIED, for every mapped shape", () => {
    for (const owner of ["both-org", "person-org", "agent-org"]) {
      assert.equal(refused(chooseIdentity(input({ presence: "agent", suppliedToken: true, targets: [lit(owner)] }))), "GH_IDENTITY_TOKEN_SUPPLIED");
    }
  });
  it("ORDER: beats unsafe arguments", () => {
    assert.equal(refused(chooseIdentity(input({ presence: "agent", suppliedToken: true, args: ["pr", "view", "-w"] }))), "GH_IDENTITY_TOKEN_SUPPLIED");
  });
  it("ORDER: presence unknown with a supplied token is PRESENCE_UNKNOWN, not TOKEN_SUPPLIED", () => {
    assert.equal(refused(chooseIdentity(input({ presence: "unknown", suppliedToken: true }))), "GH_IDENTITY_PRESENCE_UNKNOWN");
  });
  it("a person with a supplied token is injected, with compareSuppliedToken set", () => {
    const c = chooseIdentity(input({ presence: "person", suppliedToken: true }));
    assert.ok(c.kind === "inject" && c.compareSuppliedToken === true);
  });
  it("no supplied token: compareSuppliedToken is false", () => {
    const c = chooseIdentity(input({ presence: "person", suppliedToken: false }));
    assert.ok(c.kind === "inject" && c.compareSuppliedToken === false);
  });
});

describe("rule 8 (A2): unsafe arguments", () => {
  const BAD: string[][] = [
    ["pr", "create", "--editor"],
    ["pr", "create", "-e"],
    ["pr", "create", "-we"],
    ["issue", "create", "--web"],
    ["issue", "create", "-w"],
    ["api", "https://api.github.com/repos/both-org/r"],
    ["co", "5"],
    ["--repo", "both-org/r", "co", "5"],
    ["gh-extension-thing", "x"],
  ];
  const OK: string[][] = [
    ["pr", "view", "5", "--repo", "both-org/r"],
    ["api", "repos/both-org/r/issues"],
    ["api", "--method", "POST", "repos/both-org/r/issues", "-f", "title=x"],
    ["issue", "create", "--title", "w", "--body", "e", "--repo", "both-org/r"],
    ["issue", "create", "--repo", "both-org/r", "--", "-w"],
  ];
  const FOREIGN: string[][] = [
    ["api", "--hostname", "example.com", "repos/both-org/r"],
    ["api", "--hostname=example.com", "repos/both-org/r"],
    ["api", "https://example.com/repos/both-org/r"],
  ];
  for (const args of FOREIGN) {
    for (const presence of ["person", "agent"] as const) {
      it(`M1: ${presence}: gh ${args.join(" ")} is refused (a github.com token must not go to another host)`, () => {
        assert.equal(refused(chooseIdentity(input({ presence, args }))), "GH_IDENTITY_ARG_UNSAFE");
      });
    }
  }
  for (const args of BAD) {
    it(`agent: gh ${args.join(" ")} is refused`, () => assert.equal(refused(chooseIdentity(input({ presence: "agent", args }))), "GH_IDENTITY_ARG_UNSAFE"));
    it(`person: gh ${args.join(" ")} is injected, not refused`, () => {
      const c = chooseIdentity(input({ presence: "person", args }));
      assert.ok(c.kind === "inject" && c.column === "person", JSON.stringify(c));
    });
    it(`agent: gh ${args.join(" ")} is refused even with no target (L6/rule 8)`, () => {
      if (!["co", "gh-extension-thing"].includes(args.find(a => !a.startsWith("-")) ?? "")) return;
      assert.equal(refused(chooseIdentity(input({ presence: "agent", args, targets: [] }))), "GH_IDENTITY_ARG_UNSAFE");
    });
  }
  for (const presence of ["person", "agent"] as const) {
    for (const args of OK) {
      it(`${presence}: gh ${args.join(" ")} is injected`, () => assert.equal(chooseIdentity(input({ presence, args })).kind, "inject"));
    }
  }
  it("applies to a mapped owner only", () => {
    assert.deepEqual(chooseIdentity(input({ args: ["pr", "view", "-w"], targets: [lit("nobody")] })), { kind: "none" });
  });
  it("a person on an agent-only owner with -w is none, not refused", () => {
    assert.equal(chooseIdentity(input({ args: ["pr", "view", "-w"], targets: [lit("agent-org")], presence: "person" })).kind, "none");
  });
});

describe("rule 9: a person is present", () => {
  it("injects the person identity, scope read", () => {
    const c = chooseIdentity(input());
    assert.deepEqual(c, { kind: "inject", identity: ME, column: "person", owner: "both-org", repo: "r", scope: "read", compareSuppliedToken: false });
  });
  it("scope write when the call is a write; no approval is consulted", () => {
    let called = 0;
    const c = chooseIdentity(input({ isWrite: true, approvalFor: () => (called++, "a") }));
    assert.ok(c.kind === "inject" && c.scope === "write" && c.column === "person" && c.approvalId === undefined);
    assert.equal(called, 0);
  });
  it("person-only owner: the person identity", () => {
    const c = chooseIdentity(input({ targets: [lit("person-org", null)], args: ["api", "orgs/person-org/repos"] }));
    assert.ok(c.kind === "inject" && c.identity === WORK && c.repo === null);
  });
  it("agent-only owner: none, with a hint", () => {
    const c = chooseIdentity(input({ targets: [lit("agent-org")] }));
    assert.equal(c.kind, "none");
    assert.ok(c.kind === "none" && typeof c.hint === "string" && c.hint.length > 0);
  });
  it("the cwd as the only source is fine for a person", () => {
    const c = chooseIdentity(input({ isWrite: true, targets: [cwdT("both-org")] }));
    assert.equal(c.kind, "inject");
  });
  it("owner and repo are the lowercased target", () => {
    const c = chooseIdentity(input({ targets: [lit("BOTH-ORG", "Repo")] }));
    assert.ok(c.kind === "inject" && c.owner === "both-org" && c.repo === "Repo");
  });
});

describe("rule 10: agent presence with an agent identity", () => {
  it("injects the agent, scope read", () => {
    const c = chooseIdentity(input({ presence: "agent" }));
    assert.deepEqual(c, { kind: "inject", identity: ME_BOT, column: "agent", owner: "both-org", repo: "r", scope: "read", compareSuppliedToken: false });
  });
  it("a literal write injects the agent, scope write, no approval needed or used", () => {
    const c = chooseIdentity(input({ presence: "agent", isWrite: true, approvalFor: () => "a1" }));
    assert.ok(c.kind === "inject" && c.identity === ME_BOT && c.scope === "write" && c.approvalId === undefined);
  });
  it("a GH_REPO write counts as literal", () => {
    const c = chooseIdentity(input({ presence: "agent", isWrite: true, targets: [{ owner: "both-org", repo: "r", source: "gh-repo-env" }] }));
    assert.equal(c.kind, "inject");
  });
  it("a cwd-only write is GH_IDENTITY_NEEDS_LITERAL_TARGET", () => {
    assert.equal(refused(chooseIdentity(input({ presence: "agent", isWrite: true, targets: [cwdT("both-org")] }))), "GH_IDENTITY_NEEDS_LITERAL_TARGET");
    assert.equal(refused(chooseIdentity(input({ presence: "agent", isWrite: true, targets: [cwdT("agent-org")] }))), "GH_IDENTITY_NEEDS_LITERAL_TARGET");
  });
  it("a write with a literal and a cwd target of the owner is refused too", () => {
    assert.equal(
      refused(chooseIdentity(input({ presence: "agent", isWrite: true, targets: [lit("both-org", "a"), cwdT("both-org", "a")] }))),
      "GH_IDENTITY_NEEDS_LITERAL_TARGET",
    );
  });
  it("L2: an agent identity that is not a github-app is GH_IDENTITY_UNAVAILABLE, never injected", () => {
    const registry = reg({ identityMap: new Map([["bad-org", { person: ME, agent: { name: "oops", kind: "gh-login", login: "mallory" } as Identity }]]) });
    for (const isWrite of [true, false]) {
      assert.equal(refused(chooseIdentity(input({ registry, presence: "agent", isWrite, targets: [lit("bad-org")] }))), "GH_IDENTITY_UNAVAILABLE");
    }
  });
  it("a cwd READ keeps working (A3: reads keep the hint)", () => {
    const c = chooseIdentity(input({ presence: "agent", isWrite: false, targets: [cwdT("both-org")] }));
    assert.ok(c.kind === "inject" && c.identity === ME_BOT);
  });
  it("agent-only owner works the same", () => {
    const c = chooseIdentity(input({ presence: "agent", isWrite: true, targets: [lit("agent-org")] }));
    assert.ok(c.kind === "inject" && c.identity === ME_BOT && c.column === "agent");
  });
  it("beats rule 11: an approval for the person is ignored", () => {
    const seen: string[] = [];
    chooseIdentity(input({ presence: "agent", isWrite: true, approvalFor: (...a) => (seen.push(a.join()), "a1") }));
    assert.deepEqual(seen, []);
  });
  it("the repository is null for an org-level target", () => {
    const c = chooseIdentity(input({ presence: "agent", targets: [lit("both-org", null)], args: ["api", "orgs/both-org/repos"] }));
    assert.ok(c.kind === "inject" && c.repo === null);
  });
});

describe("rule 11: agent presence, only a person identity", () => {
  const PERSON_ONLY = [lit("person-org")];
  it("a read injects the person (Q1)", () => {
    const c = chooseIdentity(input({ presence: "agent", targets: PERSON_ONLY }));
    assert.deepEqual(c, { kind: "inject", identity: WORK, column: "person", owner: "person-org", repo: "r", scope: "read", compareSuppliedToken: false });
  });
  it("a read does not consult approvals", () => {
    let n = 0;
    chooseIdentity(input({ presence: "agent", targets: PERSON_ONLY, approvalFor: () => (n++, null) }));
    assert.equal(n, 0);
  });
  it("a write with an approval injects the person with the approval id; the lookup is (owner, repo, login)", () => {
    const calls: unknown[][] = [];
    const c = chooseIdentity(input({ presence: "agent", isWrite: true, targets: PERSON_ONLY, approvalFor: (...a) => (calls.push(a), "appr-7") }));
    assert.ok(c.kind === "inject" && c.identity === WORK && c.column === "person" && c.scope === "write" && c.approvalId === "appr-7");
    assert.deepEqual(calls, [["person-org", "r", "alice-work"]]);
  });
  it("a write without one is GH_IDENTITY_WRITE_NEEDS_HUMAN", () => {
    assert.equal(refused(chooseIdentity(input({ presence: "agent", isWrite: true, targets: PERSON_ONLY }))), "GH_IDENTITY_WRITE_NEEDS_HUMAN");
  });
  it("a cwd-only write needs the approval too (and gets no literal-target refusal)", () => {
    assert.equal(refused(chooseIdentity(input({ presence: "agent", isWrite: true, targets: [cwdT("person-org")] }))), "GH_IDENTITY_WRITE_NEEDS_HUMAN");
    const c = chooseIdentity(input({ presence: "agent", isWrite: true, targets: [cwdT("person-org")], approvalFor: () => "a" }));
    assert.equal(c.kind, "inject");
  });
  it("an org-level write asks for the approval with repo null", () => {
    const calls: unknown[][] = [];
    chooseIdentity(input({ presence: "agent", isWrite: true, targets: [lit("person-org", null)], args: ["api", "orgs/person-org/repos"], approvalFor: (...a) => (calls.push(a), null) }));
    assert.deepEqual(calls, [["person-org", null, "alice-work"]]);
  });
  it("the reason says a '*' approval does not help and names no token", () => {
    const c = chooseIdentity(input({ presence: "agent", isWrite: true, targets: PERSON_ONLY }));
    assert.ok(c.kind === "refuse" && c.reason.includes("'*'") && c.reason.includes("GH_IDENTITY_WRITE_NEEDS_HUMAN"));
  });
});

describe("L3: several repositories of one owner", () => {
  const two = [lit("both-org", "a"), lit("both-org", "b")];
  it("a write is GH_IDENTITY_SEVERAL_REPOS for every presence that gets this far, and for person-only owners", () => {
    for (const presence of ["person", "agent"] as const) {
      for (const owner of ["both-org", "person-org", "agent-org"]) {
        const t = [lit(owner, "a"), lit(owner, "b")];
        assert.equal(refused(chooseIdentity(input({ presence, isWrite: true, targets: t }))), "GH_IDENTITY_SEVERAL_REPOS");
      }
    }
  });
  it("a read keeps repo null", () => {
    const c = chooseIdentity(input({ presence: "agent", isWrite: false, targets: two }));
    assert.ok(c.kind === "inject" && c.repo === null);
  });
  it("the same repository twice is one repository", () => {
    const c = chooseIdentity(input({ presence: "agent", isWrite: true, targets: [lit("both-org", "a"), lit("both-org", "A")] }));
    assert.equal(c.kind, "inject");
  });
  it("an unmapped owner is not affected", () => {
    assert.deepEqual(chooseIdentity(input({ isWrite: true, targets: [lit("nobody", "a"), lit("nobody", "b")] })), { kind: "none" });
  });
});

describe("M1 and L6 at chooseIdentity", () => {
  const FOREIGN_ARGS: string[][] = [
    ["issue", "list", "--repo", "evil.example.com/both-org/r"],
    ["pr", "view", "https://evil.example.com/both-org/r/pull/1"],
    ["repo", "view", "git@evil.example.com:both-org/r"],
    ["issue", "list", "--repo", "tenant.ghe.com/both-org/r"],
    ["issue", "list", "--repo", "localhost/both-org/r"],
  ];
  for (const args of FOREIGN_ARGS) {
    for (const presence of ["person", "agent"] as const) {
      it(`${presence}: gh ${args.join(" ")} is GH_IDENTITY_ARG_UNSAFE even though no target was found`, () => {
        assert.equal(refused(chooseIdentity(input({ presence, args, targets: ghCallTargets(args, {}) }))), "GH_IDENTITY_ARG_UNSAFE");
      });
    }
  }
  it("a foreign host naming only unmapped owners is passed through", () => {
    assert.deepEqual(chooseIdentity(input({ args: ["issue", "list", "--repo", "evil.example.com/nobody/r"], targets: [] })), { kind: "none" });
  });
  it("a foreign reference next to a mapped target refuses", () => {
    const args = ["pr", "view", "https://evil.example.com/nobody/r/pull/1", "--repo", "both-org/r"];
    assert.equal(refused(chooseIdentity(input({ args, targets: ghCallTargets(args, {}) }))), "GH_IDENTITY_ARG_UNSAFE");
  });
  it("the caller's foreignHost (GH_REPO with a host) refuses when the registry maps any owner", () => {
    assert.equal(refused(chooseIdentity(input({ foreignHost: true, targets: [] }))), "GH_IDENTITY_ARG_UNSAFE");
    assert.deepEqual(chooseIdentity(input({ foreignHost: true, targets: [], registry: { engagements: [], alwaysBlock: [] } })), { kind: "none" });
  });
  it("L6: an agent's alias/extension first word is refused with no target; a person's is not", () => {
    for (const args of [["co", "5"], ["my-extension"], ["--repo", "o/r", "co"]]) {
      assert.equal(refused(chooseIdentity(input({ presence: "agent", args, targets: [] }))), "GH_IDENTITY_ARG_UNSAFE");
      assert.deepEqual(chooseIdentity(input({ presence: "person", args, targets: [] })), { kind: "none" });
      assert.deepEqual(chooseIdentity(input({ presence: "unknown", args, targets: [] })), { kind: "none" });
    }
  });
  it("L6 comes after rule 1", () => {
    assert.equal(refused(chooseIdentity(input({ presence: "agent", args: ["auth", "token"], targets: [] }))), "GH_AUTH_NEEDS_HUMAN");
  });
});

describe("L4: help is not a rule-1 hit", () => {
  for (const args of [["auth"], ["auth", "--help"], ["auth", "token", "--help"], ["config", "set", "--help"], ["alias", "set", "--help"], ["extension", "install", "--help"]]) {
    it(`gh ${args.join(" ")}`, () => assert.deepEqual(chooseIdentity(input({ presence: "agent", args, targets: [] })), { kind: "none" }));
  }
  it("--help does not excuse `--show-token` being a different command's word", () => {
    assert.equal(refused(chooseIdentity(input({ presence: "agent", args: ["auth", "token"], targets: [] }))), "GH_AUTH_NEEDS_HUMAN");
  });
});

describe("totality and reasons", () => {
  it("a throwing approvalFor, registeredOwner or getter is a refusal, not a throw", () => {
    const boom = (): never => {
      throw new Error("boom");
    };
    const a = chooseIdentity(input({ presence: "agent", isWrite: true, targets: [lit("person-org")], approvalFor: boom }));
    assert.ok(a.kind === "refuse" && a.code === "GH_IDENTITY_UNAVAILABLE");
    const b = chooseIdentity(input({ presence: "agent", isWrite: true, registry: reg({ requireIdentity: true }), targets: [lit("x")], registeredOwner: boom }));
    assert.ok(b.kind === "refuse" && b.code === "GH_IDENTITY_UNAVAILABLE");
    const hostile = { get identityMap(): never { return boom(); } } as unknown as Registry;
    const h = chooseIdentity(input({ registry: hostile }));
    assert.ok(h.kind === "refuse" && h.code === "GH_IDENTITY_UNAVAILABLE");
  });
  it("an invalid destination name is not echoed", () => {
    const evil = "x$(touch pwned)";
    const c = chooseIdentity(input({ presence: "unknown", targets: [lit("both-org", evil)] }));
    assert.ok(c.kind === "refuse" && !c.reason.includes("touch pwned"));
  });
  it("every refusal carries its own code and the agent-guide anchor", () => {
    const cases: IdentityChoice[] = [
      chooseIdentity(input({ presence: "unknown" })),
      chooseIdentity(input({ redirect: "X" })),
      chooseIdentity(input({ presence: "agent", suppliedToken: true })),
      chooseIdentity(input({ presence: "agent", args: ["pr", "view", "-w"] })),
    ];
    for (const c of cases) assert.ok(c.kind === "refuse" && c.reason.includes(`[${c.code}, see doc/agent-guide.md#${c.code.toLowerCase()}]`));
  });
});

// ---- seeded-random properties (LCG, as in process-ancestry-paren.test.ts) --------

const N = 4000;

function makeRng(seed: number): { next: () => number; int: (n: number) => number; pick: <T>(xs: readonly T[]) => T; flip: () => boolean } {
  let s = seed;
  const next = (): number => (s = (s * 1103515245 + 12345) % 2147483648);
  // The low bits of this LCG have a tiny period (the lowest two repeat every four draws): use the high ones.
  const int = (n: number): number => Math.floor((next() / 2147483648) * n);
  return { next, int, pick: xs => xs[int(xs.length)]!, flip: () => int(2) === 0 };
}
type Rng = ReturnType<typeof makeRng>;

const OWNERS = ["o-a", "o-b", "o-c", "o-d"] as const;
const ARGS: readonly (readonly string[])[] = [
  ["pr", "view", "5", "--repo", "o-a/r"],
  ["issue", "create", "--title", "t", "--repo", "o-b/r"],
  ["api", "repos/o-c/r/issues"],
  ["api", "--method", "POST", "repos/o-a/r/issues"],
  ["pr", "view", "-w"],
  ["pr", "create", "--editor"],
  ["co", "5"],
  ["auth", "token"],
  ["auth", "status"],
  ["config", "set", "editor", "vim"],
  ["api", "https://example.com/x"],
  ["api", "--hostname", "example.com", "user"],
  ["repo", "view", "o-d/r"],
  ["issue", "list"],
];
const REDIRECTS = [null, null, null, "HTTPS_PROXY", "GH_HOST", "http_unix_socket"] as const;

interface Case {
  input: ChooseIdentityInput;
  entryOf: (owner: string) => OwnerIdentities | undefined;
}

function genRegistry(rng: Rng): { registry: Registry; map: Map<string, OwnerIdentities> } {
  const map = new Map<string, OwnerIdentities>();
  let k = 0;
  for (const o of OWNERS) {
    const shape = rng.pick([0, 1, 2, 3, 3, 1, 2]); // 0 unmapped, 1 person, 2 agent, 3 both
    if (shape === 0) continue;
    const person: Identity = { name: `p${k}`, kind: "gh-login", login: `login-${k}` };
    const agent: Identity = { name: `a${k}`, kind: "github-app", app: `app-${k}` };
    k++;
    map.set(o, { ...(shape !== 2 && { person }), ...(shape >= 2 && { agent }) });
  }
  const registry: Registry = { engagements: [], alwaysBlock: [], identityMap: map, requireIdentity: rng.flip() };
  return { registry, map };
}

function genCase(rng: Rng): Case & { map: Map<string, OwnerIdentities> } {
  const { registry, map } = genRegistry(rng);
  const nTargets = rng.pick([1, 1, 1, 1, 1, 0, 2, 3]);
  const targets: GhCallTarget[] = [];
  for (let i = 0; i < nTargets; i++) {
    targets.push({
      owner: rng.pick(OWNERS),
      repo: rng.pick(["r", "s", null]),
      source: rng.pick(["literal", "literal", "gh-repo-env", "cwd"] as const),
    });
  }
  const approvedBits = rng.next();
  const presence = rng.pick(["person", "agent", "unknown"] as const);
  const c: ChooseIdentityInput = {
    args: rng.pick([...ARGS, ...ARGS.slice(0, 4), ...ARGS.slice(0, 4), ...ARGS.slice(12)]),
    isWrite: rng.flip(),
    targets,
    registry,
    presence,
    approvalFor: (owner, repo, login) => ((approvedBits + owner.length + (repo?.length ?? 7) + login.length) % 2 === 0 ? `appr-${login}` : null),
    suppliedToken: rng.int(4) === 0,
    redirect: rng.pick(REDIRECTS),
    registeredOwner: o => (approvedBits >> (o.charCodeAt(o.length - 1) % 8)) % 2 === 1,
  };
  return { input: c, entryOf: o => map.get(o), map };
}

function singleOwner(targets: readonly GhCallTarget[]): string | null {
  const owners = new Set(targets.map(t => t.owner.toLowerCase()));
  return owners.size === 1 ? [...owners][0]! : null;
}

/** The column presence selects for an owner's entry: person -> person; agent -> agent if there is one, else person. */
function expectedColumn(presence: IdentityPresence, e: OwnerIdentities): "person" | "agent" {
  return presence === "agent" && e.agent !== undefined ? "agent" : "person";
}

describe("properties (seeded LCG)", () => {
  it("an injected identity is the registry's identity for the single target owner, in the column presence selects", () => {
    const rng = makeRng(20261108);
    let injected = 0;
    for (let i = 0; i < N; i++) {
      const { input: inp, map } = genCase(rng);
      const c = chooseIdentity(inp);
      if (c.kind !== "inject") continue;
      injected++;
      const owner = singleOwner(inp.targets);
      assert.notEqual(owner, null, "an injected call has exactly one owner");
      const e = map.get(owner!);
      assert.ok(e !== undefined, "the owner is mapped");
      assert.notEqual(inp.presence, "unknown");
      const col = expectedColumn(inp.presence, e!);
      assert.equal(c.column, col);
      assert.equal(c.identity, e![col], "the very identity the registry maps");
      assert.equal(c.owner, owner);
    }
    assert.ok(injected > N / 20, `enough injected cases to mean something (${injected})`);
  });

  it("presence agent with an agent identity never injects a gh-login", () => {
    const rng = makeRng(7);
    let agentInjects = 0;
    let withAgentIdentity = 0;
    for (let i = 0; i < N; i++) {
      const { input: inp, map } = genCase(rng);
      const forced: ChooseIdentityInput = { ...inp, presence: "agent" };
      const owner = singleOwner(forced.targets);
      const c = chooseIdentity(forced);
      if (owner !== null && map.get(owner)?.agent !== undefined) {
        withAgentIdentity++;
        if (c.kind === "inject") {
          agentInjects++;
          assert.notEqual(c.identity.kind, "gh-login");
          assert.equal(c.column, "agent");
        }
      }
    }
    assert.ok(agentInjects > 50 && withAgentIdentity >= agentInjects, `${agentInjects}/${withAgentIdentity}`);
  });

  it("the column is a function of presence alone: approvals, environment and verb kind never change it (A11)", () => {
    const rng = makeRng(99);
    let both = 0;
    for (let i = 0; i < N; i++) {
      const { input: a } = genCase(rng);
      // Perturb everything but presence, registry, targets and args.
      const b: ChooseIdentityInput = {
        ...a,
        isWrite: !a.isWrite,
        suppliedToken: false,
        redirect: null,
        approvalFor: (o, r, l) => `other-${o}-${r ?? "x"}-${l}`,
        registeredOwner: () => !a.registeredOwner("o-a"),
      };
      const ca = chooseIdentity(a);
      const cb = chooseIdentity(b);
      if (ca.kind === "inject" && cb.kind === "inject") {
        both++;
        assert.equal(ca.column, cb.column);
        assert.equal(ca.identity, cb.identity);
        assert.equal(ca.column, expectedColumn(a.presence, a.registry.identityMap!.get(ca.owner)!));
      }
      // And with every approval granted, then none: the column of an injection is still the same.
      for (const approvalFor of [() => "yes", () => null] as const) {
        const cc = chooseIdentity({ ...a, approvalFor });
        if (ca.kind === "inject" && cc.kind === "inject") assert.equal(ca.column, cc.column);
      }
    }
    assert.ok(both > N / 20, `enough paired injections (${both})`);
  });

  it("suppliedToken with presence agent never injects", () => {
    const rng = makeRng(31337);
    let mappedSingle = 0;
    for (let i = 0; i < N; i++) {
      const { input: inp, map } = genCase(rng);
      const forced: ChooseIdentityInput = { ...inp, presence: "agent", suppliedToken: true };
      const c = chooseIdentity(forced);
      assert.notEqual(c.kind, "inject", JSON.stringify(c));
      const o = singleOwner(forced.targets);
      if (o !== null && map.has(o) && forced.args[0] !== "auth") mappedSingle++;
    }
    assert.ok(mappedSingle > 100, `enough mapped single-owner cases (${mappedSingle})`);
  });

  it("is total: never throws, always one of the three kinds, whatever the input", () => {
    const rng = makeRng(5);
    const junk = ["", "-", "--", "--repo", "-R", "api", "\u0000", "a/b", "https://x", "--editor", "-w", "$(x)"];
    for (let i = 0; i < N; i++) {
      const { input: inp } = genCase(rng);
      const args = Array.from({ length: rng.int(6) }, () => rng.pick(junk));
      const c = chooseIdentity({ ...inp, args });
      assert.ok(["none", "inject", "refuse"].includes(c.kind));
      const t = ghCallTargets(args, { ghRepoEnv: rng.pick(["", "a/b", "$X", "o-a/r"]), cwdRemoteOwnerRepo: rng.flip() ? { owner: "O-A", repo: "R" } : undefined });
      for (const x of t) assert.equal(x.owner, x.owner.toLowerCase());
    }
  });
});

// ---- H1: gh's git children read git command-line options after GIT_CONFIG_COUNT -----------------------------

describe("H1: git passthrough and clone options are unsafe for the agent column", () => {
  const CLONE = ["repo", "clone", "both-org/r"];
  const UNSAFE: string[][] = [
    [...CLONE, "--", "-c", "core.hooksPath=/tmp/h"],
    [...CLONE, "--", "--template=/tmp/t"],
    [...CLONE, "--", "--depth", "1"],
    [...CLONE, "--template=/tmp/t"],
    [...CLONE, "--template", "/tmp/t"],
    [...CLONE, "--config", "core.hooksPath=/tmp/h"],
    [...CLONE, "--config=core.hooksPath=/tmp/h"],
    [...CLONE, "-c", "core.hooksPath=/tmp/h"],
    ["repo", "fork", "both-org/r", "--clone", "--", "-c", "core.fsmonitor=/tmp/x"],
    ["repo", "fork", "both-org/r", "--clone", "--template=/tmp/t"],
    ["gist", "clone", "abc123", "--", "-c", "core.hooksPath=/tmp/h"],
    ["gist", "clone", "abc123", "--template=/tmp/t"],
  ];
  for (const args of UNSAFE) {
    it(`agent: gh ${args.join(" ")} is GH_IDENTITY_ARG_UNSAFE`, () => {
      assert.equal(refused(chooseIdentity(input({ presence: "agent", args, targets: [lit("both-org")] }))), "GH_IDENTITY_ARG_UNSAFE");
    });
    it(`person: gh ${args.join(" ")} is not refused (rule 8 is the agent column's)`, () => {
      assert.equal(chooseIdentity(input({ presence: "person", args, targets: [lit("both-org")] })).kind, "inject");
    });
  }

  it("a plain clone, and a `-c`/`--` on a verb that spawns no clone, are not refused by this rule", () => {
    for (const args of [CLONE, ["repo", "fork", "both-org/r"], ["pr", "view", "5", "--repo", "both-org/r"], ["api", "repos/both-org/r", "-f", "x=-c"]]) {
      assert.equal(chooseIdentity(input({ presence: "agent", args, targets: [lit("both-org")] })).kind, "inject", args.join(" "));
    }
  });
});
