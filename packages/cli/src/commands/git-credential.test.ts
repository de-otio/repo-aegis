// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// The git credential helper (doc/plan-owner-identity.md §5.6, §13.4, A5, A7, A17). Placeholder names only:
// owner `o` has an agent identity, `p` only a person identity, `q` is registered with none. The "taaad" is a
// stub script on a temp path; no network, no real App. Presence and the process chain are injected for the
// decision tests; the `git credential fill` tests run the real git and the built CLI.
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadRegistry, mintApproval, type AncestorInfo, type IdentityPresence } from "@de-otio/repo-aegis-core";
import { cliBuilt, cliPath } from "../_subprocess-utils.js";
import { hermeticGitEnv, scrubGitEnv } from "../_test-utils.js";
import { parseShowScopeList } from "../git-credential-config.js";
import { parentFromAncestry, runGitCredential, type GitCredentialDeps, type LoginTokenResult } from "./git-credential.js";
import { mintAppToken, resolvePinnedTaaad } from "./taaad-mint.js";
import { renderShimScript } from "./shim-script.js";

const TOKEN = "ghs_exampletoken0123456789abcdef";
const REGISTRY = `schemaVersion: 3
identities:
  me: { kind: gh-login, login: example-user }
  bot: { kind: github-app, app: example-bot }
personalOrgs:
  - { name: o, agent: bot, person: me }
  - { name: p, person: me }
  - q
engagements: []
`;

let tmp: string;
let home: string;
let stubDir: string;
let taaad: string;
let restoreEnv: () => void;
let n = 0;

before(() => {
  restoreEnv = scrubGitEnv();
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "repo-aegis-git-credential-")));
});
after(() => {
  restoreEnv();
  rmSync(tmp, { recursive: true, force: true });
});

function jsonFor(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    token: TOKEN,
    expiresAt: "2030-01-01T00:00:00Z",
    installationAccount: "O",
    installationId: 1,
    appId: 2,
    repositories: ["r"],
    permissions: { contents: "write", metadata: "read" },
    ...over,
  });
}

/** A stub taaad: records its argv and environment, prints `out.json`, exits with `exit`. */
function stubTaaad(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const script = join(dir, "taaad");
  writeFileSync(
    script,
    `#!/bin/sh\necho "$@" > "${dir}/argv"\n/usr/bin/env > "${dir}/env"\necho x >> "${dir}/calls"\nif [ -f "${dir}/exit" ]; then exit "$(cat "${dir}/exit")"; fi\ncat "${dir}/out.json"\n`,
  );
  chmodSync(script, 0o755);
  return script;
}

function setup(): void {
  n++;
  lastPath = "o/r.git";
  home = join(tmp, `home${n}`);
  mkdirSync(join(home, "state"), { recursive: true });
  writeFileSync(join(home, "engagements.yaml"), REGISTRY);
  stubDir = join(tmp, `stub${n}`);
  taaad = stubTaaad(stubDir);
  writeFileSync(join(stubDir, "out.json"), jsonFor());
}
beforeEach(setup);

const calls = (): number => (existsSync(join(stubDir, "calls")) ? readFileSync(join(stubDir, "calls"), "utf8").split("\n").length - 1 : 0);
const argv = (): string => readFileSync(join(stubDir, "argv"), "utf8").trim();

/** The path of the latest `request()`: the synthetic git-remote-https carries it in its URL, as the real one does. */
let lastPath = "o/r.git";
const remoteChain = (sub: string[], path: string = lastPath): AncestorInfo[] => [
  { pid: 10, ppid: 9, comm: "git-remote-https", argv: ["git-remote-https", "origin", `https://github.com/${path}`] },
  { pid: 9, ppid: 8, comm: "git", argv: ["git", ...sub] },
  { pid: 8, ppid: 1, comm: "zsh", argv: ["zsh"] },
];
const pushChain = (): AncestorInfo[] => remoteChain(["push", "origin", "main"]);

function deps(over: Partial<GitCredentialDeps> = {}, presence: IdentityPresence = "agent"): GitCredentialDeps {
  return {
    env: {},
    cwd: tmp,
    presence: () => presence,
    ancestry: pushChain,
    readConfig: () => [],
    loadRegistry: h => loadRegistry(join(h, "engagements.yaml")),
    resolveTaaad: () => taaad,
    mint: mintAppToken,
    loginToken: (login, env, h) => (loginCalls.push({ login, env, home: h }), personToken()),
    ...over,
  };
}

/** The stub for the trusted gh's `auth token --user <login>`: what it answers, and what it was asked. */
const PERSON_TOKEN = "gho_personTOKEN0123456789abcdef";
let personToken = (): LoginTokenResult => ({ kind: "token", token: PERSON_TOKEN });
let loginCalls: { login: string; env: NodeJS.ProcessEnv; home: string }[] = [];
beforeEach(() => {
  loginCalls = [];
  personToken = () => ({ kind: "token", token: PERSON_TOKEN });
});

const request = (path = "o/r.git", extra = ""): string => ((lastPath = path), `protocol=https\nhost=github.com\npath=${path}\n${extra}\n`);
const get = (stdin: string, d: GitCredentialDeps = deps()): { stdout: string; stderr: string } => runGitCredential("get", stdin, home, d);
const QUIT = "quit=true\n";

function assertRefused(r: { stdout: string; stderr: string }, code: string, label = ""): void {
  assert.equal(r.stdout, QUIT, `${label}: stdout must be exactly quit=true`);
  assert.ok(r.stderr.includes(code), `${label}: stderr names ${code}: ${r.stderr}`);
  assert.ok(!r.stderr.includes(TOKEN), `${label}: no token on stderr`);
}

describe("git-credential get: answering an agent push (I13, I13c, A7)", () => {
  it("I13: a push gets x-access-token and a contents-write token for exactly o/r", () => {
    const r = get(request());
    assert.match(r.stdout, /^username=x-access-token\npassword=ghs_exampletoken0123456789abcdef\n/);
    assert.equal(r.stderr, "", "nothing on stderr, the token least of all");
    const a = argv();
    assert.match(a, /^mint --app example-bot --repo o\/r --permissions contents-write --json$/);
    assert.equal(calls(), 1);
  });

  it("I13c: a fetch, pull or clone (any remote-https parent but push) asks for the read scope", () => {
    for (const sub of [["fetch", "origin"], ["pull"], ["clone", "https://github.com/o/r"], ["ls-remote", "origin"]]) {
      rmSync(join(stubDir, "calls"), { force: true });
      writeFileSync(join(stubDir, "out.json"), jsonFor({ permissions: { contents: "read", metadata: "read" } }));
      const r = get(request(), deps({ ancestry: () => remoteChain(sub) }));
      assert.match(r.stdout, /^username=x-access-token\npassword=/, sub.join(" "));
      assert.match(argv(), /--permissions read --json$/, sub.join(" "));
    }
  });

  it("push through global options, send-pack: write; an alias or unreadable subcommand: read", () => {
    const write = (sub: string[]): void => {
      get(request(), deps({ ancestry: () => remoteChain(sub) }));
      assert.match(argv(), /--permissions contents-write/, sub.join(" "));
    };
    write(["-C", "/x", "-c", "a=b", "push"]);
    write(["send-pack", "--stateless-rpc"]);
    writeFileSync(join(stubDir, "out.json"), jsonFor({ permissions: { contents: "read" } }));
    get(request(), deps({ ancestry: () => remoteChain(["pp", "origin"]) }));
    assert.match(argv(), /--permissions read/, "an alias is a read: it can only fail to push, never write");
  });

  it("the token is narrowed to the repository named in the path, .git suffix and case aside", () => {
    writeFileSync(join(stubDir, "out.json"), jsonFor({ repositories: ["Widgets"] }));
    const r = get(request("O/Widgets.git"));
    assert.match(r.stdout, /^username=x-access-token/);
    assert.match(argv(), /--repo o\/Widgets /);
  });

  it("host spellings: GitHub.com and github.com:443 are answered; other hosts and http are not", () => {
    const ok = (host: string): string => get(`protocol=https\nhost=${host}\npath=o/r.git\n\n`).stdout;
    assert.match(ok("GitHub.com"), /^username=/);
    assert.match(ok("github.com:443"), /^username=/);
    const before = calls();
    assert.equal(ok("gitlab.com"), "");
    assert.equal(ok("github.com:8443"), "");
    assert.equal(get("protocol=http\nhost=github.com\npath=o/r.git\n\n").stdout, "");
    assert.equal(calls(), before, "taaad untouched");
  });

  it("a URL with an embedded username still yields x-access-token", () => {
    const r = get(`protocol=https\nhost=github.com\npath=o/r.git\nusername=someone\npassword=old\n\n`);
    assert.match(r.stdout, /^username=x-access-token\npassword=ghs_/);
    assert.ok(!r.stdout.includes("someone"));
    const viaUrl = get(`url=https://someone@github.com/o/r.git\n\n`);
    assert.match(viaUrl.stdout, /^username=x-access-token\npassword=ghs_/);
  });

  it("the expiry is passed on for git to honour", () => {
    assert.match(get(request()).stdout, /password_expiry_utc=1893456000\n$/);
  });

  it("store and erase are ignored and never mint", () => {
    for (const action of ["store", "erase", "frobnicate"]) {
      assert.deepEqual(runGitCredential(action, request("o/r.git", `username=x-access-token\npassword=${TOKEN}\n`), home, deps()), { stdout: "", stderr: "" });
    }
    assert.equal(calls(), 0);
  });
});

describe("git-credential get: printing nothing (I14)", () => {
  it("a person present: nothing, no registry read, no mint", () => {
    let read = false;
    const r = get(request(), deps({ loadRegistry: () => ((read = true), null) }, "person"));
    assert.deepEqual(r, { stdout: "", stderr: "" });
    assert.equal(read, false);
    assert.equal(calls(), 0);
  });

  it("an unmapped owner, and an owner with only a person identity (a read as the person): nothing", () => {
    assert.equal(get(request("q/r.git")).stdout, "");
    assert.equal(get(request("stranger/r.git")).stdout, "");
    assert.equal(get(request("p/r.git"), deps({ ancestry: () => remoteChain(["fetch"]) })).stdout, "");
    assert.equal(calls(), 0);
  });

  it("no registry at all: nothing; presence unknown on a mapped owner is a refusal", () => {
    const missing = get(request(), deps({ loadRegistry: () => "missing" }));
    assert.deepEqual(missing, { stdout: "", stderr: "" });
    assertRefused(get(request(), deps({}, "unknown")), "GH_IDENTITY_PRESENCE_UNKNOWN");
    assert.equal(calls(), 0);
  });
});

describe("git-credential get: every refusal is exactly quit=true (A5, I15)", () => {
  it("taaad fails: GH_IDENTITY_UNAVAILABLE", () => {
    writeFileSync(join(stubDir, "exit"), "1");
    assertRefused(get(request()), "GH_IDENTITY_UNAVAILABLE");
  });

  it("a failed mint names the step, not a guess, and is written to the audit log (a fixed reason, no taaad output)", () => {
    writeFileSync(join(stubDir, "exit"), "1");
    writeFileSync(
      join(stubDir, "taaad"),
      `#!/bin/sh\necho "error: taaad mint: taaad-signer: User interaction is not allowed. customer-a-org ghs_${"B".repeat(36)}" >&2\nexit 1\n`,
    );
    writeFileSync(join(home, "state", "audit-log.json"), JSON.stringify({ enabled: true }));
    const saved = process.env["REPO_AEGIS_HOME"];
    process.env["REPO_AEGIS_HOME"] = home;
    let r: { stdout: string; stderr: string };
    try {
      r = get(request());
    } finally {
      if (saved === undefined) delete process.env["REPO_AEGIS_HOME"];
      else process.env["REPO_AEGIS_HOME"] = saved;
    }
    assertRefused(r, "GH_IDENTITY_UNAVAILABLE");
    assert.match(r.stderr, /screen is locked/);
    assert.ok(!r.stderr.includes("may not be installed"), "no guessed cause");
    for (const leak of ["customer-a-org", "ghs_"]) assert.ok(!r.stderr.includes(leak), `taaad's stderr leaked: ${leak}`);
    const lines = readFileSync(join(home, "state", "audit.log"), "utf8").trim().split("\n");
    const rec = JSON.parse(lines[lines.length - 1]!) as { action: string; details: Record<string, unknown> };
    assert.equal(rec.action, "git-credential");
    assert.deepEqual(
      { ...rec.details },
      { identity: "bot", kind: "github-app", owner: "o", repo: "r", scope: "contents-write", verb: "push", outcome: "refused", code: "GH_IDENTITY_UNAVAILABLE", reason: "screen-locked" },
    );
    const text = lines.join("\n");
    for (const leak of ["customer-a-org", "ghs_"]) assert.ok(!text.includes(leak), `audit log holds taaad output: ${leak}`);
  });

  it("I15b: the App is not installed on the repository (taaad refuses): refused, not passed through", () => {
    writeFileSync(join(stubDir, "exit"), "1");
    const r = get(request("o/other.git"));
    assertRefused(r, "GH_IDENTITY_UNAVAILABLE");
    assert.ok(!r.stdout.includes("username"));
  });

  it("taaad prints nothing, garbage, or no token: refused", () => {
    for (const body of ["", "not json", "[]", jsonFor({ token: "has space" }), jsonFor({ token: undefined })]) {
      writeFileSync(join(stubDir, "out.json"), body);
      assertRefused(get(request()), "GH_IDENTITY_UNAVAILABLE", body.slice(0, 12));
    }
  });

  it("the installation belongs to another account: GH_IDENTITY_INSTALLATION_MISMATCH", () => {
    writeFileSync(join(stubDir, "out.json"), jsonFor({ installationAccount: "other-org" }));
    assertRefused(get(request()), "GH_IDENTITY_INSTALLATION_MISMATCH");
  });

  it("the token names another repository, several, or a wider permission: refused", () => {
    for (const over of [
      { repositories: ["other"] },
      { repositories: ["r", "s"] },
      { repositories: [] },
      { permissions: { contents: "write", administration: "write" } },
      { permissions: { contents: "admin" } },
      { permissions: {} },
    ]) {
      writeFileSync(join(stubDir, "out.json"), jsonFor(over));
      assertRefused(get(request()), "GH_IDENTITY_UNAVAILABLE", JSON.stringify(over));
    }
    // a read request that comes back with write permission
    writeFileSync(join(stubDir, "out.json"), jsonFor({ permissions: { contents: "write" } }));
    assertRefused(get(request(), deps({ ancestry: () => remoteChain(["fetch"]) })), "GH_IDENTITY_UNAVAILABLE", "read got write");
  });

  it("no pinned taaad: GH_BINARY_UNTRUSTED", () => {
    assertRefused(get(request(), deps({ resolveTaaad: () => null })), "GH_BINARY_UNTRUSTED");
  });

  it("an unreadable registry: GH_IDENTITY_UNAVAILABLE (a faulted decision on a registered owner is not a fall-through)", () => {
    writeFileSync(join(home, "engagements.yaml"), "schemaVersion: 3\nidentities: [oops\n");
    assertRefused(get(request()), "GH_IDENTITY_UNAVAILABLE");
  });

  it("an agent owner with a write and only a person identity: GH_IDENTITY_WRITE_NEEDS_HUMAN", () => {
    assertRefused(get(request("p/r.git")), "GH_IDENTITY_WRITE_NEEDS_HUMAN");
  });

  it("a relative --home is refused", () => {
    assertRefused(runGitCredential("get", request(), "relative/home", deps()), "GH_IDENTITY_UNAVAILABLE");
  });

  it("no usable path (credential.useHttpPath off) is AGENT_PUSH_CREDENTIAL_CONFIG, not a fall-through", () => {
    assertRefused(get("protocol=https\nhost=github.com\n\n"), "AGENT_PUSH_CREDENTIAL_CONFIG");
    assertRefused(get("protocol=https\nhost=github.com\npath=o/r/extra\n\n"), "AGENT_PUSH_CREDENTIAL_CONFIG");
    assert.equal(calls(), 0);
  });

  it("A17: a second, differing path in the same invocation", () => {
    assertRefused(get("protocol=https\nhost=github.com\npath=o/r.git\npath=o/other.git\n\n"), "AGENT_PUSH_CREDENTIAL_PATH", "two paths");
    assertRefused(get("protocol=https\nhost=github.com\npath=o/r.git\nurl=https://github.com/o/moved.git\n\n"), "AGENT_PUSH_CREDENTIAL_PATH", "path and url");
    assert.match(get("protocol=https\nhost=github.com\npath=o/r.git\npath=O/R\n\n").stdout, /^username=/, "the same repository spelled twice is one path");
    assertRefused(get("protocol=https\nhost=github.com\nurl=https://example.com/x\npath=o/r.git\n\n"), "AGENT_PUSH_CREDENTIAL_PATH", "two hosts");
    assert.equal(calls(), 1, "only the one legitimate request minted");
  });
});

describe("git-credential get: the parent chain (A7, review finding)", () => {
  it("no git-remote-https in the chain (git credential fill run directly): quit=true, taaad never called", () => {
    const direct: AncestorInfo[] = [
      { pid: 9, ppid: 8, comm: "git", argv: ["git", "credential", "fill"] },
      { pid: 8, ppid: 1, comm: "zsh", argv: ["zsh"] },
    ];
    assertRefused(get(request(), deps({ ancestry: () => direct })), "AGENT_CREDENTIAL_DIRECT_FILL");
    assert.equal(calls(), 0);
  });

  it("direct fill is refused for an unmapped owner too (it must not hand the agent the person's helper answer)", () => {
    const direct: AncestorInfo[] = [{ pid: 8, ppid: 1, comm: "zsh", argv: ["zsh"] }];
    assertRefused(get(request("q/r.git"), deps({ ancestry: () => direct })), "AGENT_CREDENTIAL_DIRECT_FILL");
  });

  it("an unreadable chain, or a remote helper with no git above it: quit=true", () => {
    assertRefused(get(request(), deps({ ancestry: () => ({ ancestors: [], complete: false }) })), "AGENT_PUSH_CHAIN_UNREADABLE");
    assertRefused(get(request(), deps({ ancestry: () => { throw new Error("no ps"); } })), "AGENT_PUSH_CHAIN_UNREADABLE");
    assertRefused(
      get(request(), deps({ ancestry: () => [{ pid: 10, ppid: 1, comm: "git-remote-https", argv: ["git-remote-https", "origin", "https://github.com/o/r.git"] }] })),
      "AGENT_PUSH_CHAIN_UNREADABLE",
    );
    assert.equal(calls(), 0);
  });

  it("a person present is not subject to it: nothing, as before", () => {
    const direct: AncestorInfo[] = [{ pid: 8, ppid: 1, comm: "zsh", argv: ["zsh"] }];
    assert.deepEqual(get(request(), deps({ ancestry: () => direct }, "person")), { stdout: "", stderr: "" });
  });

  it("parentFromAncestry classifies", () => {
    assert.deepEqual(parentFromAncestry(pushChain(), "o/r.git"), { kind: "push", sub: "push" });
    assert.deepEqual(parentFromAncestry(remoteChain(["fetch"]), "o/r.git"), { kind: "remote", sub: "fetch" });
    assert.deepEqual(parentFromAncestry(null, null), { kind: "unreadable" });
    assert.deepEqual(parentFromAncestry([{ pid: 1, ppid: 0, comm: "zsh", argv: [] }], null), { kind: "direct" });
  });

  // Real git (seen with GIT_TRACE=1): `git push` runs `git remote-https <remote> <url>` and waits, and that
  // process runs git-remote-https as its child. The dispatcher must not decide push vs fetch.
  const url = "https://github.com/o/r.git";
  const realChain = (sub: string[], dispatcherArgs: string[] = [url, url]): AncestorInfo[] => [
    { pid: 11, ppid: 10, comm: "sh", argv: ["sh", "-c", "x get"] },
    { pid: 10, ppid: 9, comm: "git-remote-https", argv: ["git-remote-https", url, url] },
    { pid: 9, ppid: 8, comm: "git", argv: ["/opt/homebrew/opt/git/libexec/git-core/git", "remote-https", ...dispatcherArgs] },
    { pid: 8, ppid: 7, comm: "git", argv: ["git", ...sub] },
    { pid: 7, ppid: 1, comm: "zsh", argv: ["zsh"] },
  ];

  it("real git's chain: a push through the `git remote-https` dispatcher is a push", () => {
    assert.deepEqual(parentFromAncestry(realChain(["-C", "/w", "push", url, "main"]), "o/r.git"), { kind: "push", sub: "push" });
    assert.match(get(request(), deps({ ancestry: () => realChain(["push", "origin", "main"]) })).stdout, /^username=/);
    assert.match(argv(), /--permissions contents-write/, "a push mints contents-write, not read");
  });

  it("real git's chain: a fetch through the dispatcher is still a read", () => {
    assert.deepEqual(parentFromAncestry(realChain(["fetch", "origin"]), "o/r.git"), { kind: "remote", sub: "fetch" });
  });

  it("only a dispatcher with the remote helper's own arguments is skipped", () => {
    assert.deepEqual(
      parentFromAncestry(realChain(["push", "origin", "main"], [url, "https://github.com/o/other.git"]), "o/r.git"),
      { kind: "remote", sub: "remote-https" },
    );
  });
});

describe("git-credential get: an unreadable process list (U2, U5)", () => {
  const unreadable = (): GitCredentialDeps => deps({ ancestry: () => ({ ancestors: [], complete: false }) });
  const approvalsFile = (): string => join(home, "egress-approvals.json");
  const approve = (target: { org: string; repo: string }, over: { login?: string; ref?: string; now?: Date } = {}): string =>
    mintApproval({ target, path: approvalsFile(), ...over }).id;

  it("no approval: the text names a sandbox as the likely cause and three remedies, all a person's", () => {
    const r = get(request(), unreadable());
    assertRefused(r, "AGENT_PUSH_CHAIN_UNREADABLE");
    assert.match(r.stderr, /sandbox/i);
    assert.match(r.stderr, /process list/);
    assert.match(r.stderr, /A person runs the push from a terminal\./);
    assert.match(r.stderr, /A person runs, from a terminal: repo-aegis approve o\/r \(agents may then push to it for the approval's lifetime\)\./);
    assert.match(r.stderr, /A person lets the agent's command run outside the sandbox\./);
    assert.match(r.stderr, /Agents: do not run that yourself/);
    assert.match(r.stderr, /\[AGENT_PUSH_CHAIN_UNREADABLE; details: repo-aegis explain AGENT_PUSH_CHAIN_UNREADABLE\]/);
    assert.ok(!/(agent|you) (may|can|should) (disable|leave|run outside)/i.test(r.stderr), "never tells an agent to leave the sandbox");
    assert.equal(calls(), 0);
  });

  it("no approval and no usable path: still refused, and no approve command is offered", () => {
    const r = get("protocol=https\nhost=github.com\n\n", unreadable());
    assertRefused(r, "AGENT_PUSH_CHAIN_UNREADABLE");
    assert.ok(!r.stderr.includes("repo-aegis approve"), r.stderr);
    assert.equal(calls(), 0);
  });

  it("an approval for the repository covers it: a contents-write token, one stderr line, no other change", () => {
    const id = approve({ org: "o", repo: "r" }, { login: "example-user" });
    const r = get(request(), unreadable());
    assert.match(r.stdout, /^username=x-access-token\npassword=ghs_exampletoken0123456789abcdef\n/);
    assert.equal(r.stderr, `repo-aegis: approval ${id} covers an unreadable process list for o/r\n`);
    assert.match(argv(), /^mint --app example-bot --repo o\/r --permissions contents-write --json$/);
    assert.equal(calls(), 1);
  });

  it("an approval for the whole owner covers it; the owner and repository match case-insensitively", () => {
    const id = approve({ org: "o", repo: "*" }, { login: "example-user" });
    assert.match(get(request("O/R.git"), unreadable()).stderr, new RegExp(`approval ${id} covers`));
    assert.equal(calls(), 1);
  });

  it("the audit record names the approval id and what it covered", () => {
    const id = approve({ org: "o", repo: "r" }, { login: "example-user" });
    writeFileSync(join(home, "state", "audit-log.json"), JSON.stringify({ enabled: true }));
    const saved = process.env["REPO_AEGIS_HOME"];
    process.env["REPO_AEGIS_HOME"] = home;
    try {
      get(request(), unreadable());
    } finally {
      if (saved === undefined) delete process.env["REPO_AEGIS_HOME"];
      else process.env["REPO_AEGIS_HOME"] = saved;
    }
    const lines = readFileSync(join(home, "state", "audit.log"), "utf8").trim().split("\n");
    const rec = JSON.parse(lines[lines.length - 1]!) as { action: string; details: Record<string, unknown> };
    assert.equal(rec.action, "git-credential");
    assert.deepEqual(
      { ...rec.details },
      { identity: "bot", kind: "github-app", owner: "o", repo: "r", scope: "contents-write", verb: "push", approval: id, covers: "AGENT_PUSH_CHAIN_UNREADABLE" },
    );
    assert.ok(!lines.join("\n").includes("example-user"), "the person's login is not copied into the log");
  });

  it("the audit record lands in the PINNED home even when the caller's REPO_AEGIS_HOME points elsewhere (L6)", () => {
    approve({ org: "o", repo: "r" }, { login: "example-user" });
    writeFileSync(join(home, "state", "audit-log.json"), JSON.stringify({ enabled: true }));
    const elsewhere = mkdtempSync(join(tmpdir(), "rae-other-home-"));
    const saved = process.env["REPO_AEGIS_HOME"];
    process.env["REPO_AEGIS_HOME"] = elsewhere;
    try {
      get(request(), unreadable());
      assert.equal(process.env["REPO_AEGIS_HOME"], elsewhere, "the caller's variable is restored");
    } finally {
      if (saved === undefined) delete process.env["REPO_AEGIS_HOME"];
      else process.env["REPO_AEGIS_HOME"] = saved;
    }
    assert.ok(existsSync(join(home, "state", "audit.log")), "written to the pinned home");
    assert.ok(!existsSync(join(elsewhere, "state", "audit.log")), "not to the caller's home");
    rmSync(elsewhere, { recursive: true, force: true });
  });

  it("an approval that does not cover it leaves the refusal: another repo or owner, no login, `*`, a ref, expired", () => {
    const longAgo = new Date("2020-01-01T00:00:00Z");
    approve({ org: "o", repo: "other" }, { login: "example-user" });
    approve({ org: "p", repo: "*" }, { login: "example-user" });
    approve({ org: "o", repo: "r" }); // no login: the owner had no mapped person at mint time
    approve({ org: "*", repo: "*" });
    approve({ org: "o", repo: "r" }, { login: "example-user", ref: "main" });
    approve({ org: "o", repo: "r" }, { login: "example-user", now: longAgo });
    assertRefused(get(request(), unreadable()), "AGENT_PUSH_CHAIN_UNREADABLE");
    assert.equal(calls(), 0);
  });

  it("a chain that WAS read and shows a non-git caller is refused even with a covering approval", () => {
    approve({ org: "o", repo: "r" }, { login: "example-user" });
    const direct: AncestorInfo[] = [
      { pid: 9, ppid: 8, comm: "git", argv: ["git", "credential", "fill"] },
      { pid: 8, ppid: 1, comm: "zsh", argv: ["zsh"] },
    ];
    assertRefused(get(request(), deps({ ancestry: () => direct })), "AGENT_CREDENTIAL_DIRECT_FILL");
    const shell: AncestorInfo[] = [{ pid: 8, ppid: 1, comm: "zsh", argv: ["zsh"] }];
    assertRefused(get(request(), deps({ ancestry: () => shell })), "AGENT_CREDENTIAL_DIRECT_FILL");
    assert.equal(calls(), 0);
  });

  it("a request naming two paths or two hosts is not covered, and git's configuration is still checked", () => {
    approve({ org: "o", repo: "*" }, { login: "example-user" });
    assertRefused(get(request("o/r.git", "path=o/s.git\n"), unreadable()), "AGENT_PUSH_CHAIN_UNREADABLE");
    assertRefused(get("protocol=https\nhost=github.com\nhost=example.com\npath=o/r.git\n\n", unreadable()), "AGENT_PUSH_CHAIN_UNREADABLE");
    assertRefused(get(request(), deps({ ancestry: () => ({ ancestors: [], complete: false }), readConfig: () => null })), "AGENT_PUSH_CREDENTIAL_CONFIG");
    assert.equal(calls(), 0);
  });

  it("a covered request for an owner with no identity is not handed to the person's own helper", () => {
    approve({ org: "q", repo: "*" }, { login: "example-user" });
    assertRefused(get(request("q/r.git"), unreadable()), "AGENT_PUSH_CHAIN_UNREADABLE");
    assert.equal(calls(), 0);
    assert.equal(loginCalls.length, 0);
  });

  it("an approval minted for an account the owner is no longer mapped to covers nothing (U5, current login)", () => {
    // Minted while the owner's person identity was another login; the registry now maps `example-user`.
    approve({ org: "o", repo: "r" }, { login: "mallory" });
    assertRefused(get(request(), unreadable()), "AGENT_PUSH_CHAIN_UNREADABLE");
    // The same approval, minted for the login the registry maps now, covers (control).
    approve({ org: "o", repo: "r" }, { login: "EXAMPLE-USER" });
    assert.match(get(request(), unreadable()).stdout, /^username=x-access-token\npassword=ghs_/);
    assert.equal(calls(), 1, "only the second request minted");
  });

  it("an owner with no person identity has nothing to bind an approval to: nothing is covered", () => {
    // `b` has an agent identity only; an approval carrying some login (it cannot have been minted for `b`
    // by the CLI, but a store can hold anything) still covers nothing.
    writeFileSync(join(home, "engagements.yaml"), REGISTRY.replace("personalOrgs:\n", "personalOrgs:\n  - { name: b, agent: bot }\n"));
    approve({ org: "b", repo: "*" }, { login: "example-user" });
    assertRefused(get(request("b/r.git"), unreadable()), "AGENT_PUSH_CHAIN_UNREADABLE");
    assert.equal(calls(), 0);
  });

  it("an approval with a login, an unreadable chain and no registry: AGENT_PUSH_CHAIN_UNREADABLE, never the person's helper", () => {
    approve({ org: "o", repo: "r" }, { login: "example-user" });
    const r = get(request(), deps({ ancestry: () => ({ ancestors: [], complete: false }), loadRegistry: () => "missing" }));
    assertRefused(r, "AGENT_PUSH_CHAIN_UNREADABLE");
    assert.equal(calls(), 0);
    // An unreadable registry is refused the same way (there is no account to bind the approval to).
    assertRefused(get(request(), deps({ ancestry: () => ({ ancestors: [], complete: false }), loadRegistry: () => null })), "AGENT_PUSH_CHAIN_UNREADABLE");
    // Control: with the chain readable and no registry, the next helper answers.
    assert.deepEqual(get(request(), deps({ loadRegistry: () => "missing" })), { stdout: "", stderr: "" });
  });

  it("a person present is not subject to any of it: nothing, as before", () => {
    assert.deepEqual(get(request(), deps({ ancestry: () => ({ ancestors: [], complete: false }) }, "person")), { stdout: "", stderr: "" });
  });

  it("the approval store is the pinned home's, not REPO_AEGIS_HOME's", () => {
    const elsewhere = join(tmp, `elsewhere${n}`);
    mkdirSync(elsewhere, { recursive: true });
    const saved = process.env["REPO_AEGIS_HOME"];
    process.env["REPO_AEGIS_HOME"] = elsewhere;
    try {
      // An approval only in the caller's home does not count...
      mintApproval({ target: { org: "o", repo: "r" }, login: "example-user", path: join(elsewhere, "egress-approvals.json") });
      assertRefused(get(request(), unreadable()), "AGENT_PUSH_CHAIN_UNREADABLE");
      // ...and one in the pinned home counts whatever the caller's environment says.
      approve({ org: "o", repo: "r" }, { login: "example-user" });
      assert.match(get(request(), unreadable()).stdout, /^username=/);
    } finally {
      if (saved === undefined) delete process.env["REPO_AEGIS_HOME"];
      else process.env["REPO_AEGIS_HOME"] = saved;
    }
  });
});

describe("git-credential get: the chain's shape (M3)", () => {
  const sh: AncestorInfo = { pid: 11, ppid: 10, comm: "sh", argv: ["sh", "-c", "x get"] };
  const direct = (chain: AncestorInfo[], label: string): void => {
    assertRefused(get(request(), deps({ ancestry: () => chain })), "AGENT_CREDENTIAL_DIRECT_FILL", label);
  };
  const [remote, gitProc, shell] = remoteChain(["push", "origin", "main"]) as [AncestorInfo, AncestorInfo, AncestorInfo];

  it("a shell between the helper and git-remote-https (git did not exec the helper directly) is fine", () => {
    assert.match(get(request(), deps({ ancestry: () => [sh, remote, gitProc, shell] })).stdout, /^username=/);
  });

  it("a forged git-remote-https (a copy of sh as a hook) running `git credential fill`: refused, taaad never called", () => {
    const forged: AncestorInfo = { pid: 10, ppid: 8, comm: "git-remote-https", argv: ["/tmp/git-remote-https", "/tmp/hook"] };
    const fill: AncestorInfo = { pid: 12, ppid: 10, comm: "git", argv: ["git", "credential", "fill"] };
    direct([fill, forged, shell], "credential fill under a forged remote helper");
    // even with a perfect-looking argv, a `git credential` between is refused
    direct([fill, { ...remote }, gitProc, shell], "git credential between");
    direct([{ pid: 12, ppid: 10, comm: "git", argv: ["git", "credential-osxkeychain", "get"] }, remote, gitProc], "credential-<x> between");
    assert.equal(calls(), 0);
  });

  it("the remote helper must be the parent or grandparent, with only a shell between", () => {
    direct([sh, sh, remote, gitProc], "two shells");
    direct([{ pid: 11, ppid: 10, comm: "python3", argv: ["python3", "x.py"] }, remote, gitProc], "an interpreter between");
    direct([gitProc, remote], "remote helper above git");
  });

  it("its argv must be [git-remote-https, <remote>, https://github.com/<path>] with the request's path", () => {
    direct([{ ...remote, argv: ["git-remote-https", "origin"] }, gitProc], "no url");
    direct([{ ...remote, argv: ["git-remote-https"] }, gitProc], "bare");
    direct([{ ...remote, argv: ["git-remote-https", "origin", "https://example.com/o/r.git"] }, gitProc], "another host");
    direct([{ ...remote, argv: ["git-remote-https", "origin", "http://github.com/o/r.git"] }, gitProc], "not https");
    direct([{ ...remote, argv: ["git-remote-https", "origin", "https://github.com/o/other.git"] }, gitProc], "another repository");
    assert.match(get(request(), deps({ ancestry: () => [{ ...remote, argv: ["git-remote-https", "origin", "https://github.com/O/R"] }, gitProc] })).stdout, /^username=/, "case and .git do not matter");
  });

  it("a `git credential…` above the remote helper is refused too", () => {
    direct([remote, { pid: 9, ppid: 8, comm: "git", argv: ["git", "credential", "fill"] }, shell], "credential above");
  });
});

describe("git-credential get: person column falls through only for known reads (L1)", () => {
  it("fetch, pull, clone, ls-remote, archive, remote, submodule fall through for an owner with only a person identity", () => {
    for (const sub of ["fetch", "pull", "clone", "ls-remote", "archive", "remote", "submodule"]) {
      assert.deepEqual(get(request("p/r.git"), deps({ ancestry: () => remoteChain([sub]) })), { stdout: "", stderr: "" }, sub);
    }
    assert.equal(calls(), 0);
  });

  it("an alias, push, send-pack or an unreadable subcommand: quit=true GH_IDENTITY_WRITE_NEEDS_HUMAN", () => {
    for (const argv of [["pp", "origin"], ["push"], ["send-pack"], ["-C", "/a", "-c", "x=y", "-c"]]) {
      assertRefused(get(request("p/r.git"), deps({ ancestry: () => remoteChain(argv) })), "GH_IDENTITY_WRITE_NEEDS_HUMAN", argv.join(" "));
    }
  });
});

describe("git-credential get: a person's account under a login-bound approval (the helper consults the same approvals as `repo-aegis gh`)", () => {
  const approvalsFile = (): string => join(home, "egress-approvals.json");
  const approve = (target: { org: string; repo: string }, over: { login?: string; ref?: string; now?: Date } = {}): string =>
    mintApproval({ target, path: approvalsFile(), ...over }).id;
  const entries = (text: string): ReturnType<typeof parseShowScopeList> => parseShowScopeList(text);
  const auditOn = (): void => writeFileSync(join(home, "state", "audit-log.json"), JSON.stringify({ enabled: true }));
  const withAudit = <T>(fn: () => T): T => {
    const saved = process.env["REPO_AEGIS_HOME"];
    process.env["REPO_AEGIS_HOME"] = home;
    try {
      return fn();
    } finally {
      if (saved === undefined) delete process.env["REPO_AEGIS_HOME"];
      else process.env["REPO_AEGIS_HOME"] = saved;
    }
  };
  const lastAudit = (): { action: string; details: Record<string, unknown> } => {
    const lines = readFileSync(join(home, "state", "audit.log"), "utf8").trim().split("\n");
    return JSON.parse(lines[lines.length - 1]!) as { action: string; details: Record<string, unknown> };
  };

  it("a push for an owner whose only identity is a person, under an approval for its login: THAT login's token, not the active account's", () => {
    const id = approve({ org: "p", repo: "r" }, { login: "example-user" });
    const r = get(request("p/r.git"));
    assert.equal(r.stdout, `username=x-access-token\npassword=${PERSON_TOKEN}\n`);
    assert.equal(r.stderr, `repo-aegis: approval ${id} lets this push run as the GitHub account mapped to p\n`);
    assert.equal(loginCalls.length, 1);
    assert.equal(loginCalls[0]!.login, "example-user", "asked for the mapped login's token, by name");
    assert.equal(loginCalls[0]!.home, home, "through the pinned home");
    assert.equal(calls(), 0, "no App token is minted for a person column");
  });

  it("an approval for the whole owner covers it, and the owner and repository match case-insensitively", () => {
    const id = approve({ org: "p", repo: "*" }, { login: "EXAMPLE-USER" });
    const r = get(request("P/R.git"));
    assert.match(r.stdout, new RegExp(`password=${PERSON_TOKEN}`));
    assert.match(r.stderr, new RegExp(`approval ${id} lets this push`));
  });

  it("the audit record names the approval and never the login or the token", () => {
    const id = approve({ org: "p", repo: "r" }, { login: "example-user" });
    auditOn();
    withAudit(() => get(request("p/r.git")));
    const rec = lastAudit();
    assert.equal(rec.action, "git-credential");
    assert.deepEqual(
      { ...rec.details },
      { identity: "me", kind: "gh-login", column: "person", owner: "p", repo: "r", scope: "write", verb: "push", approval: id, covers: "GH_IDENTITY_WRITE_NEEDS_HUMAN" },
    );
    const text = readFileSync(join(home, "state", "audit.log"), "utf8");
    assert.ok(!text.includes("example-user") && !text.includes(PERSON_TOKEN), "no login, no token in the log");
  });

  it("without an approval the refusal stays, and its text says a login-bound approve from a terminal covers it", () => {
    const r = get(request("p/r.git"));
    assertRefused(r, "GH_IDENTITY_WRITE_NEEDS_HUMAN");
    assert.match(r.stderr, /login-bound `repo-aegis approve p\/r`/);
    assert.match(r.stderr, /from a terminal/);
    assert.ok(!/does not consult approvals/.test(r.stderr), r.stderr);
    assert.ok(!r.stderr.includes("an approval does not help"), r.stderr);
    assert.equal(loginCalls.length, 0);
  });

  it("an approval that does not cover it leaves the refusal: another account, no login, `*`, a ref, another repository or owner, expired", () => {
    const longAgo = new Date("2020-01-01T00:00:00Z");
    approve({ org: "p", repo: "r" }, { login: "mallory" });
    approve({ org: "p", repo: "r" }); // no login
    approve({ org: "*", repo: "*" });
    approve({ org: "p", repo: "r" }, { login: "example-user", ref: "main" });
    approve({ org: "p", repo: "other" }, { login: "example-user" });
    approve({ org: "o", repo: "*" }, { login: "example-user" });
    approve({ org: "p", repo: "r" }, { login: "example-user", now: longAgo });
    assertRefused(get(request("p/r.git")), "GH_IDENTITY_WRITE_NEEDS_HUMAN");
    assert.equal(loginCalls.length, 0, "no token was asked for");
  });

  it("an approval does not turn a read into a push: fetch still falls through to the person's own helper", () => {
    approve({ org: "p", repo: "*" }, { login: "example-user" });
    assert.deepEqual(get(request("p/r.git"), deps({ ancestry: () => remoteChain(["fetch", "origin"], "p/r.git") })), { stdout: "", stderr: "" });
    assert.equal(loginCalls.length, 0);
  });

  it("an alias or unreadable subcommand is judged as a write: covered by the approval, refused without one", () => {
    const aliasChain = (): AncestorInfo[] => remoteChain(["pp", "origin"], "p/r.git");
    assertRefused(get(request("p/r.git"), deps({ ancestry: aliasChain })), "GH_IDENTITY_WRITE_NEEDS_HUMAN");
    assert.equal(loginCalls.length, 0);
    approve({ org: "p", repo: "r" }, { login: "example-user" });
    assert.match(get(request("p/r.git"), deps({ ancestry: aliasChain })).stdout, new RegExp(`password=${PERSON_TOKEN}`));
  });

  it("an unreadable process list, covered by the same approval: the person's token, and both approvals' lines", () => {
    const id = approve({ org: "p", repo: "r" }, { login: "example-user" });
    const r = get(request("p/r.git"), deps({ ancestry: () => ({ ancestors: [], complete: false }) }));
    assert.match(r.stdout, new RegExp(`password=${PERSON_TOKEN}`));
    assert.match(r.stderr, new RegExp(`approval ${id} lets this push`));
    assert.match(r.stderr, new RegExp(`approval ${id} covers an unreadable process list for p/r`));
  });

  it("every pre-mint check applies to a person's token exactly as to an App token: A5 configuration, environment and the store guard", () => {
    approve({ org: "p", repo: "r" }, { login: "example-user" });
    const hits: [string, NodeJS.ProcessEnv, string][] = [
      ["global\tcredential.https://github.com.helper !ours\nlocal\tcredential.helper !evil", {}, "AGENT_PUSH_CREDENTIAL_CONFIG"],
      ["global\thttp.proxy http://proxy.example:3128", {}, "AGENT_PUSH_CREDENTIAL_CONFIG"],
      ["", { GIT_TRACE_CURL: "1" }, "AGENT_PUSH_CREDENTIAL_CONFIG"],
      [
        "global\tcredential.https://github.com.helper \nglobal\tcredential.https://github.com.helper !'/n' '/c' git-credential --home '/h'\nglobal\tcredential.https://github.com.helper osxkeychain",
        {},
        "AGENT_PUSH_CREDENTIAL_STORE",
      ],
    ];
    for (const [cfg, env, code] of hits) {
      const r = get(request("p/r.git"), deps({ readConfig: () => entries(cfg), env }));
      assertRefused(r, code, cfg);
      assert.ok(!r.stdout.includes(PERSON_TOKEN) && !r.stderr.includes(PERSON_TOKEN));
    }
    assertRefused(get(request("p/r.git"), deps({ readConfig: () => null })), "AGENT_PUSH_CREDENTIAL_CONFIG", "unreadable config");
    assert.equal(loginCalls.length, 0, "refused before the token was asked for");
  });

  it("no trusted gh, or no token for the mapped login: refused with a named code, audited as refused, nothing printed", () => {
    approve({ org: "p", repo: "r" }, { login: "example-user" });
    auditOn();
    personToken = () => ({ kind: "untrusted", reason: "the gh first on PATH is not in a trusted location" });
    const a = withAudit(() => get(request("p/r.git")));
    assertRefused(a, "GH_BINARY_UNTRUSTED");
    assert.match(a.stderr, /not in a trusted location/);
    assert.equal(lastAudit().details["outcome"], "refused");
    personToken = () => ({ kind: "unavailable" });
    const b = withAudit(() => get(request("p/r.git")));
    assertRefused(b, "GH_IDENTITY_UNAVAILABLE");
    assert.ok(!b.stderr.includes("example-user"), "the login is not echoed");
    assert.equal(lastAudit().details["code"], "GH_IDENTITY_UNAVAILABLE");
  });
});

describe("git-credential get: A5 configuration and environment", () => {
  const entries =(text: string): ReturnType<typeof parseShowScopeList> => parseShowScopeList(text);
  const refusedWith = (cfg: string, env: NodeJS.ProcessEnv = {}): void => {
    const before = calls();
    assertRefused(get(request(), deps({ readConfig: () => entries(cfg), env })), "AGENT_PUSH_CREDENTIAL_CONFIG", cfg + JSON.stringify(env));
    assert.equal(calls(), before, "refused before any mint");
  };

  it("a helper from local, worktree or command scope", () => {
    refusedWith("global\tcredential.https://github.com.helper !ours\nlocal\tcredential.helper !evil");
    refusedWith("global\tcredential.https://github.com.helper !ours\nworktree\tcredential.https://github.com.helper !evil");
    refusedWith("global\tcredential.https://github.com.helper !ours\ncommand\tcredential.helper !evil");
  });

  it("http.proxy, sslVerify=false, sslCAInfo, sslCAPath, extraHeader, sslBackend outside system scope", () => {
    refusedWith("global\thttp.proxy http://proxy.example:3128");
    refusedWith("local\thttp.https://github.com.proxy http://proxy.example:3128");
    refusedWith("local\thttp.sslverify false");
    refusedWith("global\thttp.sslcainfo /tmp/ca.pem");
    refusedWith("global\thttp.sslcapath /tmp/ca");
    refusedWith("local\thttp.extraheader Authorization: x");
    refusedWith("global\thttp.sslbackend openssl");
    refusedWith("local\tremote.origin.proxy http://proxy.example:3128");
  });

  it("the same settings at system scope, for another host, or harmless, are fine", () => {
    for (const cfg of [
      "system\thttp.proxy http://proxy.example:3128",
      "global\thttp.https://example.com.proxy http://proxy.example:3128",
      "global\thttp.sslverify true",
      "global\thttp.proxy ",
      "global\tcredential.https://github.com.helper !ours",
      "local\tcredential.https://github.com.helper !stale\nglobal\tcredential.https://github.com.helper \nglobal\tcredential.https://github.com.helper !ours",
    ]) {
      assert.match(get(request(), deps({ readConfig: () => entries(cfg) })).stdout, /^username=x-access-token/, cfg);
    }
  });

  it("the environment: trace, proxy and TLS variables", () => {
    for (const env of [
      { GIT_TRACE_CURL: "1" },
      { GIT_CURL_VERBOSE: "1" },
      { GIT_TRACE_PACKET: "1" },
      { GIT_TRACE_REDACT: "0" },
      { HTTPS_PROXY: "http://proxy.example:3128" },
      { http_proxy: "http://proxy.example:3128" },
      { ALL_PROXY: "socks5://proxy.example:1080" },
      { GIT_SSL_NO_VERIFY: "1" },
      { GIT_SSL_CAINFO: "/tmp/ca.pem" },
    ]) {
      refusedWith("", env);
    }
    assert.match(get(request(), deps({ env: { NO_PROXY: "example.com", GIT_TRACE_REDACT: "1", PATH: "/usr/bin" } })).stdout, /^username=/);
  });

  it("a later helper that would persist the token is refused before any mint; gh's helper may follow", () => {
    const ours = "!'/n' '/c' git-credential --home '/h'";
    const cfg = (later: string): string =>
      `global\tcredential.https://github.com.helper \nglobal\tcredential.https://github.com.helper ${ours}\nglobal\tcredential.https://github.com.helper ${later}`;
    for (const later of ["osxkeychain", "store --file /tmp/x", "cache", "manager", "manager-core", "git-credential-manager", "libsecret", "wincred", "!/opt/x/bin/mystery"]) {
      const before = calls();
      assertRefused(get(request(), deps({ readConfig: () => entries(cfg(later)) })), "AGENT_PUSH_CREDENTIAL_STORE", later);
      assert.equal(calls(), before, `${later}: taaad never called`);
    }
    for (const later of ["!/opt/homebrew/bin/gh auth git-credential", "!gh auth git-credential", ours]) {
      assert.match(get(request(), deps({ readConfig: () => entries(cfg(later)) })).stdout, /^username=/, later);
    }
    // a storing helper BEFORE ours is the order problem (install and doctor), not the helper's: git never reaches us after an answer
    const earlier = `global\tcredential.https://github.com.helper osxkeychain\nglobal\tcredential.https://github.com.helper ${ours}`;
    assert.match(get(request(), deps({ readConfig: () => entries(earlier) })).stdout, /^username=/);
  });

  it("M2: a URL pattern with mixed case and .git, as git compares it, is seen whichever way the request spells the path", () => {
    const pat = "https://github.com/O/Svc.git";
    const reset = "global\tcredential.https://github.com.helper \n";
    const ours = "!'/n' '/c' git-credential --home '/h'";
    const base = `${reset}global\tcredential.https://github.com.helper ${ours}\n`;
    const cases: [string, string, string][] = [
      ["local helper", `local\tcredential.${pat}.helper !evil`, "AGENT_PUSH_CREDENTIAL_CONFIG"],
      ["extraheader", `local\thttp.${pat}.extraheader X: y`, "AGENT_PUSH_CREDENTIAL_CONFIG"],
      ["proxy", `global\thttp.${pat}.proxy http://proxy.example:3128`, "AGENT_PUSH_CREDENTIAL_CONFIG"],
      ["later storing helper", `global\tcredential.${pat}.helper osxkeychain`, "AGENT_PUSH_CREDENTIAL_STORE"],
    ];
    for (const requestPath of ["O/Svc.git", "o/svc", "O/Svc", "o/svc.git"]) {
      for (const [label, line, code] of cases) {
        const before = calls();
        assertRefused(get(request(requestPath), deps({ readConfig: () => entries(base + line) })), code, `${label} for ${requestPath}`);
        assert.equal(calls(), before, `${label}: taaad never called`);
      }
    }
    // a pattern for another repository does not apply
    writeFileSync(join(stubDir, "out.json"), jsonFor({ repositories: ["svc"] }));
    assert.match(get(request("o/svc.git"), deps({ readConfig: () => entries(`${base}local\tcredential.https://github.com/o/other.helper !evil`) })).stdout, /^username=/);
  });

  it("an unreadable git configuration is refused", () => {
    assertRefused(get(request(), deps({ readConfig: () => null })), "AGENT_PUSH_CREDENTIAL_CONFIG");
  });
});

describe("the taaad spawn", () => {
  it("runs with exactly HOME, PATH=/usr/bin:/bin, TERM and LANG; nothing the caller set leaks", () => {
    const decoys = { TAAAD_CONFIG_DIR: "/tmp/decoy", XDG_CONFIG_HOME: "/tmp/decoy", GH_TOKEN: "decoy", GITHUB_TOKEN: "decoy", EXTRA: "1" };
    const saved = Object.fromEntries(Object.keys(decoys).map(k => [k, process.env[k]]));
    Object.assign(process.env, decoys);
    try {
      get(request());
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
    const seen = new Map(readFileSync(join(stubDir, "env"), "utf8").split("\n").filter(l => l.includes("=")).map(l => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
    for (const k of ["HOME", "PATH", "TERM", "LANG"]) assert.ok(seen.has(k), `${k} is set`);
    assert.equal(seen.get("PATH"), "/usr/bin:/bin");
    for (const k of Object.keys(decoys)) assert.ok(!seen.has(k), `${k} must not reach taaad`);
    // NODE_V8_COVERAGE: Node adds it to every child under coverage (`npm run test:cov`), whatever env is passed.
    const extra = [...seen.keys()].filter(k => !["HOME", "PATH", "TERM", "LANG", "PWD", "SHLVL", "_", "OLDPWD", "NODE_V8_COVERAGE"].includes(k));
    assert.deepEqual(extra, [], "no other variable");
  });

  it("resolvePinnedTaaad reads the pin from the shim `install shim` wrote, root-owned or not (a doctor warning only)", () => {
    const aegis = join(tmp, "pin-home");
    mkdirSync(join(aegis, "bin"), { recursive: true });
    assert.equal(resolvePinnedTaaad(aegis, "permissive"), null, "no shim, no pin");
    const pin = { launcher: taaad, interpreter: "/bin/sh", packageDir: dirname(taaad) };
    const cliPin = { node: process.execPath, cli: process.execPath };
    writeFileSync(join(aegis, "bin", "gh"), renderShimScript(cliPin, { home: aegis, taaad: null }));
    assert.equal(resolvePinnedTaaad(aegis, "permissive"), null, "a shim that pins no taaad");
    writeFileSync(join(aegis, "bin", "gh"), renderShimScript(cliPin, { home: aegis, taaad: pin }));
    assert.equal(resolvePinnedTaaad(aegis, "permissive"), taaad);
    assert.equal(resolvePinnedTaaad(aegis), taaad, "a taaad that is not root-owned is still used (plan §2.1, Q5)");
    // The state directory is no longer a source of pins: an agent-writable file there decides nothing.
    writeFileSync(join(aegis, "bin", "gh"), renderShimScript(cliPin, { home: aegis, taaad: null }));
    mkdirSync(join(aegis, "state"), { recursive: true });
    writeFileSync(join(aegis, "state", "taaad-pin.json"), JSON.stringify({ launcher: taaad }));
    assert.equal(resolvePinnedTaaad(aegis, "permissive"), null);
  });
});

// ---------------------------------------------------------------------------
// The real git and the built CLI
// ---------------------------------------------------------------------------

describe("through `git credential fill` (real git, built CLI)", { skip: !cliBuilt() }, () => {
  let work: string;
  let globalCfg: string;
  let second: string;

  function helperLine(h: string): string {
    return `!'${process.execPath}' '${cliPath}' git-credential --home '${h}'`;
  }

  function fill(input: string, extraEnv: NodeJS.ProcessEnv = {}, cwd = work): { status: number | null; stdout: string; stderr: string } {
    const r = spawnSync("git", ["credential", "fill"], {
      cwd,
      input,
      encoding: "utf8",
      env: hermeticGitEnv({ GIT_CONFIG_GLOBAL: globalCfg, GIT_TERMINAL_PROMPT: "0", REPO_AEGIS_HOME: home, ...extraEnv }),
    });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  }

  beforeEach(() => {
    work = join(tmp, `work${n}`);
    mkdirSync(work, { recursive: true });
    spawnSync("git", ["init", "-q", "."], { cwd: work, env: hermeticGitEnv() });
    second = join(tmp, `second${n}`);
    writeFileSync(second, `#!/bin/sh\necho "$1" >> "${second}.log"\ncat >> "${second}.log"\nexit 0\n`);
    chmodSync(second, 0o755);
    globalCfg = join(tmp, `gitconfig${n}`);
    writeFileSync(
      globalCfg,
      `[credential "https://github.com"]\n\thelper = \n\thelper = ${helperLine(home)}\n\thelper = ${second}\n\tuseHttpPath = true\n`,
    );
    writeFileSync(join(home, "state", "taaad-pin.json"), JSON.stringify({ launcher: taaad }));
  });

  it("direct fill by an agent with a mapped owner: nothing is printed that could be a credential, taaad and the second helper never run", () => {
    const r = fill("protocol=https\nhost=github.com\npath=o/r.git\n\n");
    assert.notEqual(r.status, 0, "git could not obtain a credential");
    // Where `ps` is unreadable (a sandbox) the chain cannot be read: that is refused too, under its own code.
    assert.match(r.stderr, /AGENT_CREDENTIAL_DIRECT_FILL|AGENT_PUSH_CHAIN_UNREADABLE/);
    assert.ok(!r.stdout.includes("password"), r.stdout);
    assert.ok(!r.stdout.includes(TOKEN) && !r.stderr.includes(TOKEN));
    assert.equal(calls(), 0, "taaad never called");
    assert.equal(existsSync(`${second}.log`), false, "quit=true: the next helper was never asked");
  });

  it("a failing helper decision stops the chain: the later helper is not consulted for an unmapped owner either", () => {
    const r = fill("protocol=https\nhost=github.com\npath=q/r.git\n\n");
    assert.notEqual(r.status, 0);
    assert.equal(existsSync(`${second}.log`), false);
  });

  it("a repo-local credential.helper is never asked on a refused request (the A5 config refusal itself is covered with an injected chain above: real git cannot run git-remote-https here without a server)", () => {
    const local = join(tmp, `local${n}`);
    writeFileSync(local, `#!/bin/sh\ncat >> "${local}.log"\n`);
    chmodSync(local, 0o755);
    spawnSync("git", ["config", "--local", "--add", "credential.helper", local], { cwd: work, env: hermeticGitEnv() });
    const r = fill("protocol=https\nhost=github.com\npath=o/r.git\n\n");
    assert.notEqual(r.status, 0);
    assert.equal(existsSync(`${local}.log`), false);
    assert.equal(calls(), 0);
  });

  it("a person's own helper answers when nothing refuses: an unrelated host reaches the second helper", () => {
    writeFileSync(
      globalCfg,
      `[credential]\n\thelper = ${helperLine(home)}\n\thelper = ${second}\n`,
    );
    fill("protocol=https\nhost=example.com\npath=o/r.git\n\n");
    assert.equal(existsSync(`${second}.log`), true, "no answer from repo-aegis lets git ask the next helper");
  });
});
