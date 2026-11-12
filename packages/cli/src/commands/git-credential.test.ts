// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// The git credential helper (doc/plan-owner-identity.md §5.6, §13.4, A5, A7, A17; P1-A: the helper only chooses the
// account, and refuses nothing about the process list or approvals). Placeholder names only:
// owner `o` has an agent identity, `p` only a person identity, `q` is registered with none. The "taaad" is a
// stub script on a temp path; no network, no real App. Presence and the process chain are injected for the
// decision tests; the `git credential fill` tests run the real git and the built CLI.
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { mintApproval, mintPause, pausePath, type AncestorInfo, type IdentityPresence } from "@de-otio/repo-aegis-core";
import { cliBuilt, cliPath } from "../_subprocess-utils.js";
import { hermeticGitEnv, scrubGitEnv } from "../_test-utils.js";
import { parseShowScopeList } from "../git-credential-config.js";
import { encryptedNote, parentFromAncestry, realGitCredentialDeps, runGitCredential, type GitCredentialDeps, type LoginTokenResult } from "./git-credential.js";
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
    loadRegistry: realGitCredentialDeps().loadRegistry,
    destinationPublic: () => destinationPublic,
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
/** What the injected destination cache says: true (public or unknown) is the fail-closed default. */
let destinationPublic = true;
beforeEach(() => {
  destinationPublic = true;
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

  it("push through global options, send-pack, an alias, an unreadable subcommand: all contents-write (anything but a known read is a push)", () => {
    const write = (sub: string[]): void => {
      get(request(), deps({ ancestry: () => remoteChain(sub) }));
      assert.match(argv(), /--permissions contents-write/, sub.join(" "));
    };
    write(["-C", "/x", "-c", "a=b", "push"]);
    write(["send-pack", "--stateless-rpc"]);
    write(["pp", "origin"]);
    write(["-C", "/a", "-c", "x=y", "-c"]);
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
    const r = get(request(), deps({ loadRegistry: () => ((read = true), "unreadable") }, "person"));
    assert.deepEqual(r, { stdout: "", stderr: "" });
    assert.equal(read, false);
    assert.equal(calls(), 0);
  });

  it("an unmapped owner: nothing", () => {
    assert.equal(get(request("q/r.git")).stdout, "");
    assert.equal(get(request("stranger/r.git")).stdout, "");
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
    const r = get(request());
    assertRefused(r, "GH_IDENTITY_UNAVAILABLE");
    assert.match(r.stderr, /exists but cannot be read/);
    assert.match(r.stderr, /repo-aegis doctor/);
  });

  it("an owner with only a person identity and a push is NOT refused any more: the mapped login's token (D1)", () => {
    const r = get(request("p/r.git"));
    assert.equal(r.stdout, `username=x-access-token\npassword=${PERSON_TOKEN}\n`);
    assert.ok(!r.stderr.includes("GH_IDENTITY_WRITE_NEEDS_HUMAN"), r.stderr);
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

describe("git-credential get: the parent chain (A7): only a known read is told apart; everything else is a push", () => {
  const credentialFill: AncestorInfo[] = [
    { pid: 9, ppid: 8, comm: "git", argv: ["git", "credential", "fill"] },
    { pid: 8, ppid: 1, comm: "zsh", argv: ["zsh"] },
  ];
  const answeredAsPush = (r: { stdout: string; stderr: string }, label: string): void => {
    assert.match(r.stdout, /^username=x-access-token\npassword=ghs_exampletoken0123456789abcdef\n/, `${label}: ${r.stderr}`);
    assert.equal(r.stderr, "", label);
    assert.match(argv(), /--permissions contents-write --json$/, `${label}: the wider scope`);
  };

  it("no git-remote-https in the chain (git credential fill run directly): answered as a push; no approval exists or is needed", () => {
    answeredAsPush(get(request(), deps({ ancestry: () => credentialFill })), "direct");
    assert.equal(calls(), 1);
  });

  it("an unmapped owner on a direct chain: nothing (the person's own helper answers, as for any unmapped owner)", () => {
    const direct: AncestorInfo[] = [{ pid: 8, ppid: 1, comm: "zsh", argv: ["zsh"] }];
    assert.deepEqual(get(request("q/r.git"), deps({ ancestry: () => direct })), { stdout: "", stderr: "" });
    assert.equal(calls(), 0);
  });

  it("an unreadable chain (null, a throw, an empty list, a remote helper with no git above it): answered as a push", () => {
    answeredAsPush(get(request(), deps({ ancestry: () => null })), "null");
    answeredAsPush(get(request(), deps({ ancestry: () => ({ ancestors: [], complete: false }) })), "empty");
    answeredAsPush(
      get(request(), deps({ ancestry: () => { throw new Error("ps: operation not permitted"); } })),
      "throws",
    );
    answeredAsPush(
      get(request(), deps({ ancestry: () => [{ pid: 10, ppid: 1, comm: "git-remote-https", argv: ["git-remote-https", "origin", "https://github.com/o/r.git"] }] })),
      "no git above the remote helper",
    );
    assert.equal(calls(), 4);
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
    writeFileSync(join(stubDir, "out.json"), jsonFor({ permissions: { contents: "read", metadata: "read" } }));
    assert.match(get(request(), deps({ ancestry: () => realChain(["fetch", "origin"]) })).stdout, /^username=/);
    assert.match(argv(), /--permissions read --json$/, "a known read mints read");
  });

  it("only a dispatcher with the remote helper's own arguments is skipped", () => {
    assert.deepEqual(
      parentFromAncestry(realChain(["push", "origin", "main"], [url, "https://github.com/o/other.git"]), "o/r.git"),
      { kind: "remote", sub: "remote-https" },
    );
  });
});

describe("git-credential get: the audit record (L6) names no approval", () => {
  const auditOn = (): void => writeFileSync(join(home, "state", "audit-log.json"), JSON.stringify({ enabled: true }));
  const withHome = <T>(h: string, fn: () => T): T => {
    const saved = process.env["REPO_AEGIS_HOME"];
    process.env["REPO_AEGIS_HOME"] = h;
    try {
      return fn();
    } finally {
      if (saved === undefined) delete process.env["REPO_AEGIS_HOME"];
      else process.env["REPO_AEGIS_HOME"] = saved;
    }
  };

  it("an App push's record has the identity, scope and verb, and no approval, covers or login key", () => {
    auditOn();
    withHome(home, () => get(request(), deps({ ancestry: () => null })));
    const lines = readFileSync(join(home, "state", "audit.log"), "utf8").trim().split("\n");
    const rec = JSON.parse(lines[lines.length - 1]!) as { action: string; details: Record<string, unknown> };
    assert.equal(rec.action, "git-credential");
    assert.deepEqual({ ...rec.details }, { identity: "bot", kind: "github-app", owner: "o", repo: "r", scope: "contents-write", verb: "push" });
    assert.ok(!lines.join("\n").includes("example-user"), "the person's login is not copied into the log");
  });

  it("the record lands in the PINNED home even when the caller's REPO_AEGIS_HOME points elsewhere", () => {
    auditOn();
    const elsewhere = mkdtempSync(join(tmpdir(), "rae-other-home-"));
    try {
      withHome(elsewhere, () => {
        get(request());
        assert.equal(process.env["REPO_AEGIS_HOME"], elsewhere, "the caller's variable is restored");
      });
      assert.ok(existsSync(join(home, "state", "audit.log")), "written to the pinned home");
      assert.ok(!existsSync(join(elsewhere, "state", "audit.log")), "not to the caller's home");
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});

describe("git-credential get: the chain's shape (M3)", () => {
  const sh: AncestorInfo = { pid: 11, ppid: 10, comm: "sh", argv: ["sh", "-c", "x get"] };
  // A shape that is not git's remote helper is `direct`: classified as such, and answered as a push (the wider
  // scope), never as a read.
  const direct = (chain: AncestorInfo[], label: string): void => {
    assert.deepEqual(parentFromAncestry(chain, "o/r.git"), { kind: "direct" }, label);
    assert.match(get(request(), deps({ ancestry: () => chain })).stdout, /^username=x-access-token/, label);
    assert.match(argv(), /--permissions contents-write/, `${label}: answered as a push`);
  };
  const [remote, gitProc, shell] = remoteChain(["push", "origin", "main"]) as [AncestorInfo, AncestorInfo, AncestorInfo];

  it("a shell between the helper and git-remote-https (git did not exec the helper directly) is fine", () => {
    assert.match(get(request(), deps({ ancestry: () => [sh, remote, gitProc, shell] })).stdout, /^username=/);
  });

  it("a forged git-remote-https (a copy of sh as a hook) running `git credential fill`: classified direct, never read as a fetch", () => {
    const forged: AncestorInfo = { pid: 10, ppid: 8, comm: "git-remote-https", argv: ["/tmp/git-remote-https", "/tmp/hook"] };
    const fill: AncestorInfo = { pid: 12, ppid: 10, comm: "git", argv: ["git", "credential", "fill"] };
    direct([fill, forged, shell], "credential fill under a forged remote helper");
    // even with a perfect-looking argv, a `git credential` between is refused
    direct([fill, { ...remote }, gitProc, shell], "git credential between");
    direct([{ pid: 12, ppid: 10, comm: "git", argv: ["git", "credential-osxkeychain", "get"] }, remote, gitProc], "credential-<x> between");
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

  it("a `git credential…` above the remote helper is classified direct too", () => {
    direct([remote, { pid: 9, ppid: 8, comm: "git", argv: ["git", "credential", "fill"] }, shell], "credential above");
  });
});

describe("git-credential get: person column answers known reads as the mapped login (L1)", () => {
  it("fetch, pull, clone, ls-remote, archive, remote, submodule get the MAPPED login's token, with no approval and no output line", () => {
    for (const sub of ["fetch", "pull", "clone", "ls-remote", "archive", "remote", "submodule"]) {
      loginCalls = [];
      const r = get(request("p/r.git"), deps({ ancestry: () => remoteChain([sub]) }));
      assert.deepEqual(r, { stdout: `username=x-access-token\npassword=${PERSON_TOKEN}\n`, stderr: "" }, sub);
      assert.equal(loginCalls.length, 1, sub);
      assert.equal(loginCalls[0]!.login, "example-user", `${sub}: the mapped login, not whichever account is active`);
    }
    assert.equal(calls(), 0, "no App token is minted for a person column");
  });

  it("a known read skips the push-time checks: a proxy, a trace variable or a repo-local helper do not stop a fetch", () => {
    const proxyEnv = { DOCKER_HTTPS_PROXY: "http://localhost:3128", HTTPS_PROXY: "http://localhost:3128", GIT_TRACE_CURL: "1" };
    const cfg = parseShowScopeList("global\thttp.proxy http://localhost:3128\nlocal\tcredential.helper !evil");
    for (const sub of ["fetch", "pull", "clone"]) {
      loginCalls = [];
      const r = get(request("p/r.git"), deps({ ancestry: () => remoteChain([sub]), env: proxyEnv, readConfig: () => cfg }));
      assert.deepEqual(r, { stdout: `username=x-access-token\npassword=${PERSON_TOKEN}\n`, stderr: "" }, sub);
    }
  });

  it("a read and a push are both answered under a proxy variable or proxy config (the Claude Code sandbox sets one)", () => {
    const proxyEnv = { DOCKER_HTTPS_PROXY: "http://localhost:3128", HTTPS_PROXY: "http://localhost:3128" };
    const proxyCfg = parseShowScopeList("global\thttp.proxy http://localhost:3128");
    for (const sub of ["fetch", "pull", "clone"]) {
      loginCalls = [];
      const r = get(request("p/r.git"), deps({ ancestry: () => remoteChain([sub]), env: proxyEnv, readConfig: () => proxyCfg }));
      assert.deepEqual(r, { stdout: `username=x-access-token\npassword=${PERSON_TOKEN}\n`, stderr: "" }, sub);
    }
    // 0.14.0 (P1-A): a proxy no longer refuses a push either; the App push gets its token.
    const push = get(request(), deps({ env: proxyEnv }));
    assert.match(push.stdout, /^username=x-access-token\npassword=ghs_/, "an App push under the proxy variable is answered");
    assert.doesNotMatch(push.stdout, /quit=true/);
  });

  it("no token for the mapped login: refused with GH_IDENTITY_UNAVAILABLE rather than answered as another account", () => {
    personToken = () => ({ kind: "unavailable" });
    assertRefused(get(request("p/r.git"), deps({ ancestry: () => remoteChain(["fetch"]) })), "GH_IDENTITY_UNAVAILABLE");
  });
});

describe("git-credential get: a push as the owner's person account (D1: the default, with no approval)", () => {
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
  const NOTE = "repo-aegis: this push runs as the GitHub account mapped to p (its person identity)\n";

  it("a person-only owner, no approval: THAT login's token, not the active account's, with one stderr line", () => {
    const r = get(request("p/r.git"));
    assert.equal(r.stdout, `username=x-access-token\npassword=${PERSON_TOKEN}\n`);
    assert.equal(r.stderr, NOTE);
    assert.equal(loginCalls.length, 1);
    assert.equal(loginCalls[0]!.login, "example-user", "asked for the mapped login's token, by name");
    assert.equal(loginCalls[0]!.home, home, "through the pinned home");
    assert.equal(calls(), 0, "no App token is minted for a person column");
  });

  it("the owner and repository match case-insensitively", () => {
    const r = get(request("P/R.git"));
    assert.match(r.stdout, new RegExp(`password=${PERSON_TOKEN}`));
    assert.equal(r.stderr, "repo-aegis: this push runs as the GitHub account mapped to p (its person identity)\n");
  });

  it("the audit record has no approval key, and never the login or the token", () => {
    auditOn();
    withAudit(() => get(request("p/r.git")));
    const rec = lastAudit();
    assert.equal(rec.action, "git-credential");
    assert.deepEqual(
      { ...rec.details },
      { identity: "me", kind: "gh-login", column: "person", owner: "p", repo: "r", scope: "write", verb: "push" },
    );
    assert.ok(!("approval" in rec.details) && !("covers" in rec.details));
    const text = readFileSync(join(home, "state", "audit.log"), "utf8");
    assert.ok(!text.includes("example-user") && !text.includes(PERSON_TOKEN), "no login, no token in the log");
  });

  it("approvals are not consulted: whatever the store holds, the answer and its text are the same", () => {
    const before = get(request("p/r.git"));
    mintApproval({ target: { org: "p", repo: "r" }, login: "example-user", path: join(home, "egress-approvals.json") });
    mintApproval({ target: { org: "p", repo: "*" }, login: "mallory", path: join(home, "egress-approvals.json") });
    assert.deepEqual(get(request("p/r.git")), before);
  });

  it("an alias, push, send-pack, an unreadable subcommand or an unreadable chain: the same (everything but a known read is a push)", () => {
    for (const argvs of [["pp", "origin"], ["push"], ["send-pack"], ["-C", "/a", "-c", "x=y", "-c"]]) {
      loginCalls = [];
      const r = get(request("p/r.git"), deps({ ancestry: () => remoteChain(argvs, "p/r.git") }));
      assert.deepEqual(r, { stdout: `username=x-access-token\npassword=${PERSON_TOKEN}\n`, stderr: NOTE }, argvs.join(" "));
      assert.equal(loginCalls.length, 1);
    }
    const unreadable = get(request("p/r.git"), deps({ ancestry: () => null }));
    assert.equal(unreadable.stdout, `username=x-access-token\npassword=${PERSON_TOKEN}\n`);
  });

  it("the configuration checks apply to a person's token as to an App token (trace variables, a helper in local scope, an unreadable configuration)", () => {
    const hits: [string, NodeJS.ProcessEnv, string][] = [
      ["global\tcredential.https://github.com.helper !ours\nlocal\tcredential.helper !evil", {}, "AGENT_PUSH_CREDENTIAL_CONFIG"],
      ["", { GIT_TRACE_CURL: "1" }, "AGENT_PUSH_CREDENTIAL_CONFIG"],
      ["", { GIT_TRACE_REDACT: "0" }, "AGENT_PUSH_CREDENTIAL_CONFIG"],
    ];
    for (const [cfg, env, code] of hits) {
      const r = get(request("p/r.git"), deps({ readConfig: () => entries(cfg), env }));
      assertRefused(r, code, cfg);
      assert.ok(!r.stdout.includes(PERSON_TOKEN) && !r.stderr.includes(PERSON_TOKEN));
    }
    assertRefused(get(request("p/r.git"), deps({ readConfig: () => null })), "AGENT_PUSH_CREDENTIAL_CONFIG", "unreadable config");
    assert.equal(loginCalls.length, 0, "refused before the token was asked for");
  });

  const OURS = "!'/n' '/c' git-credential --home '/h'";
  const withLater = (later: string): string =>
    `global\tcredential.https://github.com.helper \nglobal\tcredential.https://github.com.helper ${OURS}\nglobal\tcredential.https://github.com.helper ${later}`;

  it("A5: a later OS store (osxkeychain, libsecret, wincred, a credential manager, cache) does NOT refuse a person's token, push or read", () => {
    for (const later of ["osxkeychain", "libsecret", "wincred", "manager", "manager-core", "git-credential-manager", "cache", "cache --timeout 60"]) {
      const push = get(request("p/r.git"), deps({ readConfig: () => entries(withLater(later)) }));
      assert.equal(push.stdout, `username=x-access-token\npassword=${PERSON_TOKEN}\n`, `${later} push: ${push.stderr}`);
      const read = get(request("p/r.git"), deps({ ancestry: () => remoteChain(["fetch"], "p/r.git"), readConfig: () => entries(withLater(later)) }));
      assert.equal(read.stdout, `username=x-access-token\npassword=${PERSON_TOKEN}\n`, `${later} read: ${read.stderr}`);
    }
  });

  it("A5: a later `store` (plaintext in ~/.git-credentials) or an unrecognised helper refuses a person's token, push and read alike, before any token is fetched", () => {
    for (const later of ["store", "store --file /tmp/x", "!/opt/x/bin/mystery"]) {
      loginCalls = [];
      const push = get(request("p/r.git"), deps({ readConfig: () => entries(withLater(later)) }));
      assertRefused(push, "AGENT_PUSH_CREDENTIAL_STORE", `${later} push`);
      assert.match(push.stderr, /the person's token (would be written in plaintext|might be written in plaintext)/, later);
      const read = get(request("p/r.git"), deps({ ancestry: () => remoteChain(["fetch"], "p/r.git"), readConfig: () => entries(withLater(later)) }));
      assertRefused(read, "AGENT_PUSH_CREDENTIAL_STORE", `${later} read`);
      assert.equal(loginCalls.length, 0, `${later}: refused before the token was asked for`);
    }
  });

  describe("the pre-push backstop: a repository's own core.hooksPath (husky)", () => {
    const HUSKY = "local\tcore.hookspath .husky/_";
    const GLOBAL_OWN = "global\tcore.hookspath /h/hooks";
    const push = (cfg: string, over: Partial<GitCredentialDeps> = {}): { stdout: string; stderr: string } =>
      get(request("p/r.git"), deps({ readConfig: () => entries(cfg), ...over }));

    it("a local hooksPath that is not repo-aegis's, and a destination that is unknown or public: refused, no token fetched", () => {
      destinationPublic = true;
      const r = push(HUSKY);
      assertRefused(r, "AGENT_PUSH_GUARD_NOT_RUNNING");
      assert.match(r.stderr, /core\.hooksPath is set in local scope/);
      assert.match(r.stderr, /pushes from a terminal, or chains repo-aegis's pre-push hook/);
      assert.equal(loginCalls.length, 0);
      assertRefused(push("worktree\tcore.hookspath /tmp/h"), "AGENT_PUSH_GUARD_NOT_RUNNING", "worktree");
    });

    it("command scope (`-c core.hooksPath=/dev/null` on the call itself) is the caller's choice, not a husky setting: the token", () => {
      destinationPublic = true;
      for (const cfg of ["command\tcore.hookspath /dev/null", "global\tcore.hookspath /h/hooks\ncommand\tcore.hookspath /dev/null"]) {
        assert.equal(push(cfg).stdout, `username=x-access-token\npassword=${PERSON_TOKEN}\n`, cfg);
      }
      // git reads the last value, so a command-scope value after a husky one is the caller's choice too.
      assert.equal(push(`${HUSKY}\ncommand\tcore.hookspath /dev/null`).stdout, `username=x-access-token\npassword=${PERSON_TOKEN}\n`);
      // A local override alone still refuses.
      assertRefused(push(HUSKY), "AGENT_PUSH_GUARD_NOT_RUNNING");
    });

    it("the same with the destination recorded private: the token", () => {
      destinationPublic = false;
      const r = push(HUSKY);
      assert.equal(r.stdout, `username=x-access-token\npassword=${PERSON_TOKEN}\n`, r.stderr);
    });

    it("a global hooksPath (the person's own or repo-aegis's), or none: the token, even for an unknown destination", () => {
      destinationPublic = true;
      for (const cfg of [GLOBAL_OWN, "global\tcore.hookspath /somewhere/else", "system\tcore.hookspath /x", ""]) {
        assert.equal(push(cfg).stdout, `username=x-access-token\npassword=${PERSON_TOKEN}\n`, cfg);
      }
    });

    it("a local hooksPath that IS repo-aegis's own hooks directory (install hooks --local) is not an override", () => {
      destinationPublic = true;
      const ownDir = join(home, "hooks");
      mkdirSync(ownDir, { recursive: true });
      assert.equal(push(`local\tcore.hookspath ${ownDir}`).stdout, `username=x-access-token\npassword=${PERSON_TOKEN}\n`);
      // The last value wins: a local override after a correct global one is still an override.
      assertRefused(push(`global\tcore.hookspath ${ownDir}\nlocal\tcore.hookspath .husky/_`), "AGENT_PUSH_GUARD_NOT_RUNNING");
      // ... and a correct local value after a foreign global one is fine.
      assert.equal(push(`global\tcore.hookspath /elsewhere\nlocal\tcore.hookspath ${ownDir}`).stdout, `username=x-access-token\npassword=${PERSON_TOKEN}\n`);
    });

    it("known reads, and the App column, are not affected", () => {
      destinationPublic = true;
      const read = get(request("p/r.git"), deps({ ancestry: () => remoteChain(["fetch"], "p/r.git"), readConfig: () => entries(HUSKY) }));
      assert.equal(read.stdout, `username=x-access-token\npassword=${PERSON_TOKEN}\n`, read.stderr);
      const app = get(request(), deps({ readConfig: () => entries(HUSKY) }));
      assert.match(app.stdout, /^username=x-access-token\npassword=ghs_/, app.stderr);
    });

    it("the real offline visibility rule: a repository recorded private passes, an uncached or public one is refused", () => {
      const repo = join(tmp, `husky-repo${n}`);
      mkdirSync(repo, { recursive: true });
      const git = (...a: string[]): void => void spawnSync("git", a, { cwd: repo, env: hermeticGitEnv(), stdio: "ignore" });
      git("init", "-q", "-b", "main");
      git("remote", "add", "origin", "https://github.com/p/r.git");
      const real = realGitCredentialDeps().destinationPublic;
      const check = (): boolean => real(repo, "p", "r", {}, home);
      assert.equal(check(), true, "no cache: unknown is treated as public");
      git("config", "repo-aegis.visibility", "public");
      assert.equal(check(), true);
      git("config", "repo-aegis.visibility", "private");
      assert.equal(check(), false, "recorded private");
      assert.equal(real(repo, "p", "other", {}, home), true, "another destination does not inherit this repository's cache");
      assert.equal(real(repo, "p", "r", { REPO_AEGIS_ASSUME_PUBLIC: "1" }, home), true, "the one-directional public override still applies");
      git("config", "repo-aegis.class", "public-eligible");
      assert.equal(check(), true, "a public-eligible declaration is public whatever the cache says");
      assert.equal(real(join(tmp, "not-a-repo-at-all"), "p", "r", {}, home), true, "fails closed");
      // Wired end to end: the injected-nothing deps decide.
      git("config", "repo-aegis.class", "private-strict");
      const r = get(request("p/r.git"), deps({ cwd: repo, readConfig: () => entries(HUSKY), destinationPublic: real }));
      assert.equal(r.stdout, `username=x-access-token\npassword=${PERSON_TOKEN}\n`, r.stderr);
      git("config", "repo-aegis.visibility", "public");
      assertRefused(get(request("p/r.git"), deps({ cwd: repo, readConfig: () => entries(HUSKY), destinationPublic: real })), "AGENT_PUSH_GUARD_NOT_RUNNING");
    });
  });

  it("no trusted gh, or no token for the mapped login: refused with a named code, audited as refused, nothing printed", () => {
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

describe("git-credential get: the registry has four states (F3, P1-A)", () => {
  const WARNING_FREE_NOTHING = { stdout: "", stderr: "" };
  const fresh = (name: string): string => {
    const h = join(tmp, `${name}${n}`);
    mkdirSync(join(h, "state"), { recursive: true });
    return h;
  };
  const run = (h: string, stdin: string, over: Partial<GitCredentialDeps> = {}): { stdout: string; stderr: string } =>
    runGitCredential("get", stdin, h, deps({ ...over }));

  it("the real loader maps missing, encrypted, unreadable (a newer schema, a parse error) and readable", () => {
    const load = realGitCredentialDeps().loadRegistry;
    assert.equal(load(fresh("missing")), "missing");
    const enc = fresh("encrypted");
    writeFileSync(join(enc, "engagements.yaml.age"), "age-encryption.org/v1\n");
    assert.equal(load(enc), "encrypted");
    const newer = fresh("newer");
    writeFileSync(join(newer, "engagements.yaml"), "schemaVersion: 99\nidentities: {}\npersonalOrgs: []\nengagements: []\n");
    assert.equal(load(newer), "unreadable", "a newer-schema registry is unreadable, never missing");
    const broken = fresh("broken");
    writeFileSync(join(broken, "engagements.yaml"), "schemaVersion: 3\nidentities: [oops\n");
    assert.equal(load(broken), "unreadable");
    assert.notEqual(load(home), "missing");
    assert.notEqual(load(home), "unreadable");
  });

  it("a push with a newer-schema registry: quit=true and GH_IDENTITY_UNAVAILABLE, and no token is ever asked for", () => {
    const h = fresh("newer-push");
    writeFileSync(join(h, "engagements.yaml"), "schemaVersion: 99\nidentities: {}\npersonalOrgs: []\nengagements: []\n");
    let asked = 0;
    const r = run(h, request("p/r.git"), { loginToken: () => (asked++, personToken()) });
    assert.equal(r.stdout, QUIT);
    assert.match(r.stderr, /\[GH_IDENTITY_UNAVAILABLE[;\]]/);
    assert.match(r.stderr, /exists but cannot be read \(it does not parse, or a newer repo-aegis wrote it\)/);
    assert.match(r.stderr, /repo-aegis doctor/);
    assert.equal(asked, 0, "loginToken was never called");
    assert.equal(calls(), 0, "taaad was never called");
    // An unparseable file is refused the same way.
    const h2 = fresh("broken-push");
    writeFileSync(join(h2, "engagements.yaml"), "schemaVersion: 3\nidentities: [oops\n");
    assertRefused(run(h2, request("p/r.git"), { loginToken: () => (asked++, personToken()) }), "GH_IDENTITY_UNAVAILABLE");
    assert.equal(asked, 0);
  });

  it("a known read with that home: nothing (the person's own helper answers it)", () => {
    const h = fresh("newer-read");
    writeFileSync(join(h, "engagements.yaml"), "schemaVersion: 99\nidentities: {}\npersonalOrgs: []\nengagements: []\n");
    let asked = 0;
    for (const sub of [["fetch", "origin"], ["pull"], ["clone", "https://github.com/p/r"], ["ls-remote", "origin"]]) {
      const r = run(h, request("p/r.git"), { ancestry: () => remoteChain(sub, "p/r.git"), loginToken: () => (asked++, personToken()) });
      assert.deepEqual(r, WARNING_FREE_NOTHING, sub.join(" "));
    }
    assert.equal(asked, 0);
  });

  it("an encrypted registry: stdout is empty and stderr is exactly the note (git's next helper answers); the note names only the validated path", () => {
    const h = fresh("encrypted-push");
    writeFileSync(join(h, "engagements.yaml.age"), "age-encryption.org/v1\n");
    const r = run(h, request("P/Repo.git"));
    assert.equal(r.stdout, "");
    assert.equal(
      r.stderr,
      "repo-aegis: the registry is encrypted, so no GitHub account was chosen for p/repo; git's next credential helper answers. A person runs `repo-aegis registry decrypt --identity <key>`.\n",
    );
    assert.equal(r.stderr, encryptedNote({ owner: "P", repo: "Repo" }));
    assert.equal(calls(), 0);
  });

  it("a person present never reads the registry at all, whatever its state", () => {
    const h = fresh("person");
    writeFileSync(join(h, "engagements.yaml"), "schemaVersion: 99\n");
    assert.deepEqual(runGitCredential("get", request(), h, deps({}, "person")), WARNING_FREE_NOTHING);
  });
});

describe("git-credential get: A5 configuration and environment (P1-A: only what would trace or store the token)", () => {
  const entries =(text: string): ReturnType<typeof parseShowScopeList> => parseShowScopeList(text);
  const refusedWith = (cfg: string, env: NodeJS.ProcessEnv = {}): void => {
    const before = calls();
    assertRefused(get(request(), deps({ readConfig: () => entries(cfg), env })), "AGENT_PUSH_CREDENTIAL_CONFIG", cfg + JSON.stringify(env));
    assert.equal(calls(), before, "refused before any mint");
  };
  const tokenWith = (cfg: string, env: NodeJS.ProcessEnv = {}, owner = "o/r.git"): { stdout: string; stderr: string } => {
    const r = get(request(owner), deps({ readConfig: () => entries(cfg), env }));
    assert.match(r.stdout, /^username=x-access-token\npassword=/, `${cfg} ${JSON.stringify(env)}: ${r.stderr}`);
    return r;
  };

  it("a helper from local, worktree or command scope", () => {
    refusedWith("global\tcredential.https://github.com.helper !ours\nlocal\tcredential.helper !evil");
    refusedWith("global\tcredential.https://github.com.helper !ours\nworktree\tcredential.https://github.com.helper !evil");
    refusedWith("global\tcredential.https://github.com.helper !ours\ncommand\tcredential.helper !evil");
  });

  it("the person's own entries re-applied in command scope (GIT_CONFIG_GLOBAL=/dev/null plus GIT_CONFIG_COUNT): repo-aegis's helper and gh's are no refusal", () => {
    const ours = "!'/usr/bin/node' '/x/dist/index.js' git-credential --home '/h'";
    const copied = [
      "command\tcredential.helper osxkeychain",
      "command\tcredential.https://github.com.helper ",
      `command\tcredential.https://github.com.helper ${ours}`,
      "command\tcredential.https://github.com.helper !/opt/homebrew/bin/gh auth git-credential",
      "command\tcredential.https://github.com.usehttppath true",
    ].join("\n");
    tokenWith(copied);
    tokenWith(copied, {}, "p/r.git");
    // A storing or unrecognised helper in command scope still refuses, as before.
    refusedWith(`${copied}\ncommand\tcredential.https://github.com.helper !evil`);
  });

  it("a proxy is no refusal: HTTPS_PROXY in the environment, and http.proxy in global config, each give the token (the default sandbox sets one)", () => {
    const viaEnv = tokenWith("", { HTTPS_PROXY: "http://127.0.0.1:3128", HTTP_PROXY: "http://127.0.0.1:3128", http_proxy: "http://127.0.0.1:3128", ALL_PROXY: "socks5://proxy.example:1080" });
    assert.equal(viaEnv.stderr, "");
    const viaConfig = tokenWith("global\thttp.proxy http://proxy.example:3128");
    assert.equal(viaConfig.stderr, "");
    tokenWith("local\thttp.https://github.com.proxy http://proxy.example:3128");
    tokenWith("local\tremote.origin.proxy http://proxy.example:3128");
  });

  it("a CA bundle, an extra header and a TLS backend are no refusal either (planting one is an attack, not an accident)", () => {
    tokenWith("global\thttp.sslcainfo /tmp/ca.pem");
    tokenWith("global\thttp.sslcapath /tmp/ca");
    tokenWith("local\thttp.extraheader Authorization: x");
    tokenWith("global\thttp.sslbackend openssl");
    tokenWith("", { GIT_SSL_CAINFO: "/tmp/ca.pem", GIT_SSL_CAPATH: "/tmp/ca" });
  });

  it("http.sslVerify off, or GIT_SSL_NO_VERIFY: the token, plus a warning line on stderr", () => {
    const cfg = tokenWith("local\thttp.sslverify false");
    assert.match(cfg.stderr, /^repo-aegis: warning: http\.sslVerify is off in local scope, so TLS certificates are not checked for this push; the token was given anyway\./m);
    assert.match(cfg.stderr, /`git config --list --show-origin` names the file to remove it from\.\n$/);
    const env = tokenWith("", { GIT_SSL_NO_VERIFY: "1" });
    assert.match(env.stderr, /^repo-aegis: warning: GIT_SSL_NO_VERIFY is set in the environment, so TLS certificates are not checked/m);
    // A person-mapped push carries the warning after its own line; a known read prints nothing.
    const person = tokenWith("global\thttp.sslverify false", {}, "p/r.git");
    assert.match(person.stderr, /^repo-aegis: this push runs as the GitHub account mapped to p \(its person identity\)\n/);
    assert.match(person.stderr, /^repo-aegis: warning: http\.sslVerify is off in global scope/m);
    const read = get(request("p/r.git"), deps({ ancestry: () => remoteChain(["fetch"], "p/r.git"), readConfig: () => entries("global\thttp.sslverify false") }));
    assert.equal(read.stderr, "");
    for (const ok of ["system\thttp.sslverify false", "global\thttp.sslverify true", "global\thttp.https://example.com.sslverify false"]) {
      assert.equal(tokenWith(ok).stderr, "", ok);
    }
  });

  it("the trace variables still refuse; harmless variables do not", () => {
    for (const env of [{ GIT_TRACE_CURL: "1" }, { GIT_CURL_VERBOSE: "1" }, { GIT_TRACE_PACKET: "1" }, { GIT_TRACE_REDACT: "0" }]) {
      refusedWith("", env);
    }
    const r = get(request(), deps({ readConfig: () => [], env: { GIT_TRACE_CURL: "1" } }));
    assert.match(r.stderr, /\[AGENT_PUSH_CREDENTIAL_CONFIG[;\]]/);
    assert.match(get(request(), deps({ env: { NO_PROXY: "example.com", GIT_TRACE_REDACT: "1", PATH: "/usr/bin" } })).stdout, /^username=/);
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

  it("a later helper that would persist an APP token is refused before any mint; gh's helper may follow", () => {
    const ours = "!'/n' '/c' git-credential --home '/h'";
    const cfg = (later: string): string =>
      `global\tcredential.https://github.com.helper \nglobal\tcredential.https://github.com.helper ${ours}\nglobal\tcredential.https://github.com.helper ${later}`;
    for (const later of ["osxkeychain", "store --file /tmp/x", "cache", "manager", "manager-core", "git-credential-manager", "libsecret", "wincred", "!/opt/x/bin/mystery", "store"]) {
      const before = calls();
      const r = get(request(), deps({ readConfig: () => entries(cfg(later)) }));
      assertRefused(r, "AGENT_PUSH_CREDENTIAL_STORE", later);
      assert.match(r.stderr, /the App token would be saved/);
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
      ["later storing helper", `global\tcredential.${pat}.helper osxkeychain`, "AGENT_PUSH_CREDENTIAL_STORE"],
    ];
    writeFileSync(join(stubDir, "out.json"), jsonFor({ repositories: ["Svc"] }));
    for (const requestPath of ["O/Svc.git", "o/svc", "O/Svc", "o/svc.git"]) {
      for (const [label, line, code] of cases) {
        const before = calls();
        assertRefused(get(request(requestPath), deps({ readConfig: () => entries(base + line) })), code, `${label} for ${requestPath}`);
        assert.equal(calls(), before, `${label}: taaad never called`);
      }
      // The sslVerify warning is matched by the same rule.
      const warned = get(request(requestPath), deps({ readConfig: () => entries(`${base}global\thttp.${pat}.sslverify false`) }));
      assert.match(warned.stderr, /http\.sslVerify is off in global scope/, requestPath);
    }
    // a pattern for another repository does not apply
    writeFileSync(join(stubDir, "out.json"), jsonFor({ repositories: ["svc"] }));
    assert.match(get(request("o/svc.git"), deps({ readConfig: () => entries(`${base}local\tcredential.https://github.com/o/other.helper !evil`) })).stdout, /^username=/);
  });

  it("an unreadable git configuration is refused", () => {
    assertRefused(get(request(), deps({ readConfig: () => null })), "AGENT_PUSH_CREDENTIAL_CONFIG");
  });
});

describe("git-credential get: the emergency pause (P1-E): step aside, never hand out a token", () => {
  const T0 = new Date("2026-11-10T12:00:00.000Z");
  const HOUR = 3_600_000;
  const NOTHING = { stdout: "", stderr: "" };
  const clock = (at: Date) => ({ now: () => at });
  /** A home whose registry cannot be read: without a pause a push is refused (`quit=true`), the strongest case to step aside from. */
  const brokenHome = (name: string): string => {
    const h = join(tmp, `${name}${n}`);
    mkdirSync(join(h, "state"), { recursive: true });
    writeFileSync(join(h, "engagements.yaml"), "schemaVersion: 3\nidentities: [oops\n");
    return h;
  };
  const pauseAt = (h: string, repo?: string, at: Date = T0): void => void mintPause({ path: pausePath(h), now: at, durationMs: HOUR, ...(repo !== undefined && { repo }) });
  const run = (h: string, stdin: string, at: Date = T0): { stdout: string; stderr: string } => runGitCredential("get", stdin, h, deps(clock(at)));

  it("control: with no pause the push is refused with quit=true", () => {
    assertRefused(run(brokenHome("ctl"), request("p/r.git")), "GH_IDENTITY_UNAVAILABLE");
  });

  it("an active pause: a push it would have refused prints nothing at all, and no token is asked for", () => {
    const h = brokenHome("active");
    pauseAt(h);
    let asked = 0;
    const r = runGitCredential("get", request("p/r.git"), h, deps({ ...clock(T0), loginToken: () => (asked++, personToken()) }));
    assert.deepEqual(r, NOTHING);
    assert.equal(asked, 0);
    assert.equal(calls(), 0, "taaad was never called");
  });

  it("an active pause: a push it answers is answered as without a pause: the App's token for an App-mapped owner", () => {
    pauseAt(home);
    const r = get(request("o/r.git"), deps(clock(T0)));
    assert.match(r.stdout, new RegExp(`username=x-access-token\\npassword=${TOKEN}`));
    assert.equal(calls(), 1, "the App token is minted exactly as without a pause");
    assert.match(argv(), /--repo o\/r/);
    // and it is byte-for-byte what no pause gives
    rmSync(pausePath(home), { force: true });
    const unpaused = get(request("o/r.git"), deps(clock(T0)));
    assert.equal(r.stdout, unpaused.stdout);
    assert.equal(r.stderr, unpaused.stderr);
  });

  it("an active pause: a person-mapped owner's push still gets the mapped login's token (identity choice unchanged)", () => {
    pauseAt(home);
    const r = get(request("p/r.git"), deps(clock(T0)));
    assert.match(r.stdout, new RegExp(`password=${PERSON_TOKEN}`));
    assert.equal(loginCalls.length, 1);
  });

  it("a pause covers reads too: the helper is as if repo-aegis were not installed", () => {
    const h = brokenHome("read");
    pauseAt(h);
    const r = runGitCredential("get", request("p/r.git"), h, deps({ ...clock(T0), ancestry: () => remoteChain(["fetch", "origin"], "p/r.git") }));
    assert.deepEqual(r, NOTHING);
  });

  it("after expiry (clock pinned past the end) the refusal is back", () => {
    const h = brokenHome("expired");
    pauseAt(h);
    assert.deepEqual(run(h, request("p/r.git"), new Date(T0.getTime() + HOUR - 1)), NOTHING);
    assertRefused(run(h, request("p/r.git"), new Date(T0.getTime() + HOUR)), "GH_IDENTITY_UNAVAILABLE", "at the expiry instant");
    assertRefused(run(h, request("p/r.git"), new Date(T0.getTime() + 3 * HOUR)), "GH_IDENTITY_UNAVAILABLE", "long after");
  });

  it("a future-dated, world-writable or foreign-owned pause file is no pause", () => {
    const future = brokenHome("future");
    pauseAt(future, undefined, new Date(T0.getTime() + HOUR));
    assertRefused(run(future, request("p/r.git")), "GH_IDENTITY_UNAVAILABLE", "future");
    const open = brokenHome("open");
    pauseAt(open);
    chmodSync(pausePath(open), 0o666);
    assertRefused(run(open, request("p/r.git")), "GH_IDENTITY_UNAVAILABLE", "world-writable");
    const garbage = brokenHome("garbage");
    writeFileSync(pausePath(garbage), JSON.stringify({ version: 1, expiresAt: "2099-01-01T00:00:00.000Z" }), { mode: 0o600 });
    assertRefused(run(garbage, request("p/r.git")), "GH_IDENTITY_UNAVAILABLE", "a hand-made file with no createdAt");
  });

  it("--repo p/r: a push to p/r steps aside (case-insensitively); a push to another repository is still refused", () => {
    const h = brokenHome("scoped");
    pauseAt(h, "p/r");
    assert.deepEqual(run(h, request("p/r.git")), NOTHING);
    assert.deepEqual(run(h, request("P/R.git")), NOTHING);
    assertRefused(run(h, request("p/other.git")), "GH_IDENTITY_UNAVAILABLE", "another repo");
    assertRefused(run(h, request("q/r.git")), "GH_IDENTITY_UNAVAILABLE", "another owner");
  });

  it("--repo: a request that names no repository path, or several, is out of scope; a machine-wide pause covers it", () => {
    const scoped = brokenHome("scoped-nopath");
    pauseAt(scoped, "p/r");
    const noPath = "protocol=https\nhost=github.com\n\n";
    assert.notDeepEqual(run(scoped, noPath), NOTHING);
    const two = "protocol=https\nhost=github.com\npath=p/r.git\npath=p/s.git\n\n";
    assert.notDeepEqual(run(scoped, two), NOTHING);
    const wide = brokenHome("wide-nopath");
    pauseAt(wide);
    assert.deepEqual(run(wide, noPath), NOTHING);
  });

  it("a relative home is never trusted to hold a pause", () => {
    const h = brokenHome("rel");
    pauseAt(h);
    const r = runGitCredential("get", request("p/r.git"), "relative/home", deps(clock(T0)));
    assert.equal(r.stdout, QUIT);
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

  it("direct fill by an agent with an App owner and a storing helper after ours: quit=true, nothing printed that could be a credential, the second helper never runs", () => {
    const r = fill("protocol=https\nhost=github.com\npath=o/r.git\n\n");
    assert.notEqual(r.status, 0, "git could not obtain a credential");
    // The chain is not git's remote helper (or cannot be read in a sandbox): it is answered as a push, and the
    // fixture's second helper would persist an App token, so the helper refuses before any mint.
    assert.match(r.stderr, /\[AGENT_PUSH_CREDENTIAL_STORE[;\]]/);
    assert.ok(!r.stdout.includes("password"), r.stdout);
    assert.ok(!r.stdout.includes(TOKEN) && !r.stderr.includes(TOKEN));
    assert.equal(calls(), 0, "taaad never called");
    assert.equal(existsSync(`${second}.log`), false, "quit=true: the next helper was never asked");
  });

  it("an unmapped owner prints nothing, so git asks the later helper (a refusal is the only thing that stops the chain)", () => {
    fill("protocol=https\nhost=github.com\npath=q/r.git\n\n");
    assert.equal(existsSync(`${second}.log`), true, "no answer from repo-aegis lets git ask the next helper");
    assert.equal(calls(), 0, "no mint for an unmapped owner");
  });

  it("a refusal stops the chain: an App owner behind a storing later helper is not passed on", () => {
    const r = fill("protocol=https\nhost=github.com\npath=o/r.git\n\n");
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
