// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// The refusal-text audit (doc/plan-landscape-recommendations.md, U7). Every refusal that tells an agent to stop and
// report to a person must, in its own text: name the concrete cause (a setting, a file or an environment condition,
// not just a code), say whether repo-aegis itself created that condition when it could have, give the one fix line a
// person runs, and say whether an approval covers it. This table pins that for the refusals on the agent publish path
// that core's `chooseIdentity` and the git credential helper produce; the `repo-aegis gh` and `git push` ones are
// pinned beside their own harnesses (gh-command.test.ts, check.test.ts). Placeholders only.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chooseIdentity, loadRegistry, type AncestorInfo, type ChooseIdentityInput, type IdentityPresence, type Registry } from "@de-otio/repo-aegis-core";
import { parseShowScopeList } from "../git-credential-config.js";
import { runGitCredential, type GitCredentialDeps } from "./git-credential.js";
import { MintError } from "./taaad-mint.js";

interface Row {
  label: string;
  code: string;
  text: string;
  /** The concrete setting, file or condition the refusal names. */
  cause: RegExp;
  /** Whether repo-aegis created the condition, when it could have (absent when it plainly could not have). */
  created?: RegExp;
  /** The one fix line a person runs, or the step they take. */
  fix: RegExp;
  /** Whether an approval covers it, said either way. */
  approval: RegExp;
}

function check(rows: readonly Row[]): void {
  for (const r of rows) {
    it(`${r.code}: ${r.label}`, () => {
      assert.ok(r.text.includes(r.code), `names its code: ${r.text}`);
      assert.match(r.text, r.cause, `names the cause: ${r.text}`);
      if (r.created !== undefined) assert.match(r.text, r.created, `says whether repo-aegis created it: ${r.text}`);
      assert.match(r.text, r.fix, `gives the fix: ${r.text}`);
      assert.match(r.text, r.approval, `says whether an approval covers it: ${r.text}`);
      assert.match(r.text, /Agents: do not run that yourself, retry or reroute; report this to your human\./, `keeps the trailer: ${r.text}`);
    });
  }
}

// ---------------------------------------------------------------------------
// core: chooseIdentity
// ---------------------------------------------------------------------------

describe("U7 refusal text: chooseIdentity", () => {
  const ME = { name: "me", kind: "gh-login", login: "alice" } as const;
  const BOT = { name: "bot", kind: "github-app", app: "example-bot" } as const;
  const LOGIN_AGENT = { name: "me2", kind: "gh-login", login: "bob" } as const;
  const map = new Map([
    ["both-org", { person: ME, agent: BOT }],
    ["person-org", { person: ME }],
    ["login-agent-org", { agent: LOGIN_AGENT }],
  ]);
  const registry = (over: Partial<Registry> = {}): Registry => ({ engagements: [], alwaysBlock: [], identityMap: map, ...over }) as Registry;
  const choose = (over: Partial<ChooseIdentityInput>): string => {
    const c = chooseIdentity({
      args: ["pr", "view", "5", "--repo", "both-org/r"],
      isWrite: false,
      targets: [{ owner: "both-org", repo: "r", source: "literal" }],
      registry: registry(),
      presence: "agent",
      approvalFor: () => null,
      suppliedToken: false,
      redirect: null,
      registeredOwner: () => false,
      ...over,
    });
    assert.equal(c.kind, "refuse", JSON.stringify(c));
    return c.kind === "refuse" ? c.reason : "";
  };
  const lit = (owner: string): ChooseIdentityInput["targets"] => [{ owner, repo: "r", source: "literal" }];
  const NO_APPROVAL = /No approval covers this/;

  check([
    {
      label: "gh auth token",
      code: "GH_AUTH_NEEDS_HUMAN",
      text: choose({ args: ["auth", "token"], targets: [] }),
      cause: /reads a token or changes which account or program gh uses, and no person is at this terminal/,
      created: /no repo-aegis setting or install step created this condition/,
      fix: /A person runs the original command, from a terminal/,
      approval: /an approval never lets an agent read a token/,
    },
    {
      label: "requireIdentity and an owner with no identity",
      code: "GH_IDENTITY_UNMAPPED_OWNER",
      text: choose({ args: ["pr", "create"], isWrite: true, targets: lit("plain-org"), registry: registry({ requireIdentity: true }), registeredOwner: () => true }),
      cause: /`requireIdentity` set.*registered but has no GitHub identity mapped/,
      created: /a person turned it on/,
      fix: /repo-aegis engagements set-identity <id> --person <name>/,
      approval: /an approval cannot add an identity/,
    },
    {
      label: "presence unknown",
      code: "GH_IDENTITY_PRESENCE_UNKNOWN",
      text: choose({ presence: "unknown" }),
      cause: /process ancestry; a sandbox that blocks the process list is a common cause/,
      created: /repo-aegis did not create it/,
      fix: /runs the original command from a terminal they opened themselves/,
      approval: /an approval is only consulted once repo-aegis knows an agent is running/,
    },
    {
      label: "an agent column that is not a GitHub App",
      code: "GH_IDENTITY_UNAVAILABLE",
      text: choose({ args: ["pr", "view", "5", "--repo", "login-agent-org/r"], targets: lit("login-agent-org") }),
      cause: /maps this owner's agent column to a GitHub login, not a GitHub App/,
      created: /a person made that mapping; repo-aegis maps none by itself/,
      fix: /repo-aegis engagements set-identity <id> --agent <app-name>/,
      approval: /an approval cannot turn a login into a GitHub App/,
    },
    {
      label: "an internal error while judging",
      code: "GH_IDENTITY_UNAVAILABLE",
      text: choose({
        registry: {
          get identityMap(): never {
            throw new Error("boom");
          },
        } as unknown as Registry,
      }),
      cause: /hit an internal error while judging the arguments or reading the registry/,
      created: /repo-aegis created no setting for it/,
      fix: /repo-aegis doctor/,
      approval: /an approval cannot stand in for a judgement that could not be made/,
    },
    {
      label: "a write as a person's account with no agent identity",
      code: "GH_IDENTITY_WRITE_NEEDS_HUMAN",
      text: choose({ args: ["pr", "create", "--repo", "person-org/r"], isWrite: true, targets: lit("person-org") }),
      cause: /this owner has no agent identity \(none is mapped, and repo-aegis maps none by itself\)/,
      created: /repo-aegis maps none by itself/,
      fix: /repo-aegis approve <owner>\/<repo>/,
      approval: /Only an approval minted for this owner and repository, for that account, covers this; a '\*' approval does not/,
    },
  ]);

  it("the arguments refusal says an approval never covers arguments, and is not a person's step (no trailer)", () => {
    const text = choose({ args: ["pr", "create", "--editor", "--repo", "both-org/r"], isWrite: true });
    assert.match(text, /GH_IDENTITY_ARG_UNSAFE/);
    assert.match(text, /the arguments are the cause, and no repo-aegis setting created this/);
    assert.match(text, /an approval covers a repository git setting, never these arguments/);
    assert.match(text, NO_APPROVAL);
  });
});

// ---------------------------------------------------------------------------
// the git credential helper
// ---------------------------------------------------------------------------

const REGISTRY = `schemaVersion: 3
identities:
  me: { kind: gh-login, login: example-user }
  bot: { kind: github-app, app: example-bot }
personalOrgs:
  - { name: o, agent: bot }
  - { name: p, person: me }
engagements: []
`;

describe("U7 refusal text: git credential helper", () => {
  let tmp: string;
  let home: string;
  before(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), "repo-aegis-refusal-text-")));
    home = join(tmp, "home");
    mkdirSync(join(home, "state"), { recursive: true });
    writeFileSync(join(home, "engagements.yaml"), REGISTRY);
  });
  after(() => rmSync(tmp, { recursive: true, force: true }));

  const chainFor = (path: string): AncestorInfo[] => [
    { pid: 10, ppid: 9, comm: "git-remote-https", argv: ["git-remote-https", "origin", `https://github.com/${path}`] },
    { pid: 9, ppid: 8, comm: "git", argv: ["git", "push", "origin", "main"] },
    { pid: 8, ppid: 1, comm: "zsh", argv: ["zsh"] },
  ];
  const pushChain = (): AncestorInfo[] => chainFor("o/r.git");
  const deps = (over: Partial<GitCredentialDeps> = {}, presence: IdentityPresence = "agent"): GitCredentialDeps => ({
    env: {},
    cwd: tmp,
    presence: () => presence,
    ancestry: pushChain,
    readConfig: () => [],
    loadRegistry: h => loadRegistry(join(h, "engagements.yaml")),
    resolveTaaad: () => "/stub/taaad",
    mint: () => {
      throw new Error("a refusal must not mint");
    },
    ...over,
  });
  const req = (path = "o/r.git"): string => `protocol=https\nhost=github.com\npath=${path}\n\n`;
  const refused = (stdin: string, d: GitCredentialDeps = deps(), h: string = home): string => {
    const r = runGitCredential("get", stdin, h, d);
    assert.equal(r.stdout, "quit=true\n", r.stderr);
    return r.stderr;
  };
  const entries = (text: string): ReturnType<typeof parseShowScopeList> => parseShowScopeList(text);
  /** Every refusal of this helper but the unreadable process list says which one condition an approval covers. */
  const ONLY_CHAIN = /No approval covers this; only an unreadable process list \(AGENT_PUSH_CHAIN_UNREADABLE\) is covered, by an account-bound `repo-aegis approve <owner>\/<repo>`/;
  const ours = "!'/n' '/c' git-credential --home '/h'";

  const rows: Row[] = [];
  before(() => {
    rows.push(
      {
        label: "the helper line has no absolute --home",
        code: "GH_IDENTITY_UNAVAILABLE",
        text: refused(req(), deps(), "relative/home"),
        cause: /has no absolute --home/,
        created: /repo-aegis writes that line itself in `install git-credential`/,
        fix: /A person runs, from a terminal: repo-aegis install git-credential \(.*re-running it is safe\)/,
        approval: ONLY_CHAIN,
      },
      {
        label: "git credential fill run directly",
        code: "AGENT_CREDENTIAL_DIRECT_FILL",
        text: refused(req(), deps({ ancestry: () => [{ pid: 8, ppid: 1, comm: "zsh", argv: ["zsh"] }] })),
        cause: /`git credential fill` was run directly/,
        created: /no repo-aegis setting created it/,
        fix: /runs the original `git push` from a terminal/,
        approval: ONLY_CHAIN,
      },
      {
        label: "two hosts in one request",
        code: "AGENT_PUSH_CREDENTIAL_PATH",
        text: refused("protocol=https\nhost=github.com\nurl=https://example.com/x\npath=o/r.git\n\n"),
        cause: /more than one protocol or host/,
        created: /no repo-aegis setting created this/,
        fix: /runs the push on its own, from a terminal/,
        approval: ONLY_CHAIN,
      },
      {
        label: "two repository paths in one request",
        code: "AGENT_PUSH_CREDENTIAL_PATH",
        text: refused("protocol=https\nhost=github.com\npath=o/r.git\npath=o/other.git\n\n"),
        cause: /more than one repository path/,
        created: /no repo-aegis setting created this/,
        fix: /one repository at a time, from a terminal/,
        approval: ONLY_CHAIN,
      },
      {
        label: "no owner/repo path (useHttpPath off)",
        code: "AGENT_PUSH_CREDENTIAL_CONFIG",
        text: refused("protocol=https\nhost=github.com\n\n"),
        cause: /credential\.useHttpPath must be true for github\.com/,
        created: /so it was never installed or the setting was turned off afterwards/,
        fix: /repo-aegis install git-credential \(it sets credential\.useHttpPath/,
        approval: ONLY_CHAIN,
      },
      {
        label: "the registry cannot be read",
        code: "GH_IDENTITY_UNAVAILABLE",
        text: refused(req(), deps({ loadRegistry: () => null })),
        cause: /registry in the pinned home could not be read \(it is encrypted or damaged/,
        created: /repo-aegis did not change it/,
        fix: /repo-aegis doctor/,
        approval: ONLY_CHAIN,
      },
      {
        label: "a person's account, a push",
        code: "GH_IDENTITY_WRITE_NEEDS_HUMAN",
        text: refused(req("p/r.git"), deps({ ancestry: () => chainFor("p/r.git") })),
        cause: /would run as a person's GitHub account, and the git subcommand is not one known to only read/,
        created: /repo-aegis created no setting for it/,
        fix: /runs the push from a terminal/,
        approval: /does not consult approvals for a person's account, so an approval does not help here/,
      },
      {
        label: "the agent identity is a login, not an App",
        code: "GH_IDENTITY_UNAVAILABLE",
        // The loader rejects this registry, so the shape is handed in.
        text: refused(
          req("l/r.git"),
          deps({
            ancestry: () => chainFor("l/r.git"),
            loadRegistry: () =>
              ({
                engagements: [],
                alwaysBlock: [],
                personalOrgs: ["l"],
                identityMap: new Map([["l", { agent: { name: "x", kind: "gh-login", login: "bob" } }]]),
              }) as unknown as Registry,
          }),
        ),
        // chooseIdentity refuses first, so this is core's text relayed by the helper (the helper's own branch below it is a second defence).
        cause: /maps this owner's agent column to a GitHub login, not a GitHub App/,
        created: /a person made that mapping; repo-aegis maps none by itself/,
        fix: /repo-aegis engagements set-identity <id> --agent <app-name>/,
        approval: /No approval covers this: an approval cannot turn a login into a GitHub App/,
      },
      {
        label: "git's configuration cannot be read",
        code: "AGENT_PUSH_CREDENTIAL_CONFIG",
        text: refused(req(), deps({ readConfig: () => null })),
        cause: /git's configuration could not be read \(git failed to start, or a config file is unreadable/,
        created: /repo-aegis did not cause it/,
        fix: /git config --list --show-origin/,
        approval: ONLY_CHAIN,
      },
      {
        label: "a proxy in the git configuration",
        code: "AGENT_PUSH_CREDENTIAL_CONFIG",
        text: refused(req(), deps({ readConfig: () => entries("global\thttp.proxy http://proxy.example:3128") })),
        cause: /http\.proxy is set in global scope, which could redirect or capture the token/,
        created: /repo-aegis did not set it/,
        fix: /git config --list --show-origin \(it names the file that sets it; remove the setting there/,
        approval: ONLY_CHAIN,
      },
      {
        label: "a trace variable in the environment",
        code: "AGENT_PUSH_CREDENTIAL_CONFIG",
        text: refused(req(), deps({ env: { GIT_TRACE_CURL: "1" } })),
        cause: /GIT_TRACE_CURL is set in the environment/,
        created: /repo-aegis did not set it/,
        fix: /unsets that environment variable in the shell the push runs from/,
        approval: ONLY_CHAIN,
      },
      {
        label: "a later helper would store the token",
        code: "AGENT_PUSH_CREDENTIAL_STORE",
        text: refused(
          req(),
          deps({
            readConfig: () =>
              entries(`global\tcredential.https://github.com.helper \nglobal\tcredential.https://github.com.helper ${ours}\nglobal\tcredential.https://github.com.helper osxkeychain`),
          }),
        ),
        cause: /would be saved by a later credential helper \(osxkeychain\)/,
        created: /repo-aegis did not add that helper/,
        fix: /git config --list --show-origin \(it lists the helpers in order/,
        approval: ONLY_CHAIN,
      },
      {
        label: "no pinned taaad",
        code: "GH_BINARY_UNTRUSTED",
        text: refused(req(), deps({ resolveTaaad: () => null })),
        cause: /no pinned taaad is known to use/,
        created: /repo-aegis pins taaad only when `repo-aegis install shim` runs/,
        fix: /repo-aegis install shim \(it needs taaad v0\.6\.0 or later installed first; re-running it is safe\)/,
        approval: ONLY_CHAIN,
      },
      {
        label: "a failed mint",
        code: "GH_IDENTITY_UNAVAILABLE",
        text: refused(
          req(),
          deps({
            mint: () => {
              throw new MintError("unavailable", "the pinned taaad could not be started");
            },
          }),
        ),
        cause: /the pinned taaad could not be started/,
        fix: /repo-aegis doctor/,
        approval: ONLY_CHAIN,
      },
      {
        label: "an internal error",
        code: "GH_IDENTITY_UNAVAILABLE",
        text: refused(
          req(),
          deps({
            presence: () => {
              throw new Error("boom");
            },
          }),
        ),
        cause: /the credential helper hit an internal error/,
        created: /not a setting you made, and not one repo-aegis wrote/,
        fix: /repo-aegis doctor/,
        approval: ONLY_CHAIN,
      },
    );
  });

  // The rows are built in `before`, so the table is checked in one test per row at run time.
  it("every row names its cause, who created it, the fix, and whether an approval covers it", () => {
    assert.ok(rows.length >= 15, "the table was built");
    for (const r of rows) {
      assert.ok(r.text.includes(r.code), `${r.label}: names its code: ${r.text}`);
      assert.match(r.text, r.cause, `${r.label}: names the cause: ${r.text}`);
      if (r.created !== undefined) assert.match(r.text, r.created, `${r.label}: says whether repo-aegis created it: ${r.text}`);
      assert.match(r.text, r.fix, `${r.label}: gives the fix: ${r.text}`);
      assert.match(r.text, r.approval, `${r.label}: says whether an approval covers it: ${r.text}`);
      assert.match(r.text, /Agents: do not run that yourself, retry or reroute; report this to your human\./, `${r.label}: keeps the trailer: ${r.text}`);
    }
  });

  it("AGENT_PUSH_CHAIN_UNREADABLE (left as landed) still says which approval covers it", () => {
    const text = refused(req(), deps({ ancestry: () => null }));
    assert.match(text, /AGENT_PUSH_CHAIN_UNREADABLE/);
    assert.match(text, /a sandbox that blocks the process list \(the default Claude Code sandbox does\) is the likely cause/);
    assert.match(text, /An approval for o\/r from a person covers this when the owner has a person identity mapped/);
  });
});
