// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// Phase U exit criterion (doc/plan-landscape-recommendations.md, U6): an agent in a sandboxed session, holding ONE
// human approval bound to an account, can publish with no further human step. Everything is local and stubbed:
// a temp repo-aegis home, a temp git repo, stub `gh` and `taaad` scripts, an injected ancestry reader. No network,
// no real token (every token is a made-up string), no real approval or registry.
//
// The world, as `repo-aegis install hooks --local` and onboarding leave it (the 2026-11-09 observation):
//   - owner `example-org` has an agent identity (github-app) and a person identity (gh-login alice);
//   - the repo's origin is https://github.com/example-org/svc.git, and `core.hooksPath` is set to repo-aegis's own
//     hooks directory in BOTH the global config and the repo-local config (the duplicate `install hooks --local`
//     writes);
//   - a person ran `repo-aegis approve example-org/*`, so an approval bound to `alice` is live;
//   - the process list cannot be read (the default Claude Code sandbox blocks it).
//
// Assertions (a) to (c) FAILED on v0.12.2 (Phase U exit criterion) with:
//   (a) AGENT_PUSH_CHAIN_UNREADABLE          (fixed by U5; P1-A then removed the chain check, so the helper no longer reads approvals)
//   (b) GH_IDENTITY_ARG_UNSAFE                (fixed by U1 and/or U5)
//   (c) GH_IDENTITY_UNAVAILABLE for a read    (fixed by U4)
// The (d) negatives for `repo-aegis gh` pass today and must keep passing: without the approval, the refusals stand.
// The (d) negatives for the credential helper flipped in P1-A: an unreadable process list is no longer a refusal.
//
// P1 acceptance (its own describe below): an agent push from the default Claude Code sandbox, with NO approval, a
// proxy in the environment and no process list, goes through as the mapped person (the D1 default).
//
// Placeholders only: alice, example-org, example-bot.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  approvalsPath,
  identityPresence,
  loadRegistry,
  mintApproval,
  type IdentityPresence,
  type TerminalCheck,
} from "@de-otio/repo-aegis-core";
import { cliBuilt, cliPath } from "./_subprocess-utils.js";
import { hermeticGitEnv, scrubGitEnv } from "./_test-utils.js";
import { renderShimScript } from "./commands/shim-script.js";
import { runGhCommand, type GhCommandDeps } from "./commands/gh-command.js";
import { runGitCredential, type GitCredentialDeps } from "./commands/git-credential.js";
import { mintAppToken } from "./commands/taaad-mint.js";
import { readCredentialConfig } from "./git-credential-config.js";
import type { TaaadPin } from "./commands/taaad-pin.js";

const TOKEN_BOT = "ghs_STUBexamplebot0123456789abcdef";

const REGISTRY = `schemaVersion: 3
identities:
  alice: { kind: gh-login, login: alice }
  example-bot: { kind: github-app, app: example-bot }
personalOrgs:
  - { name: example-org, person: alice, agent: example-bot }
engagements: []
`;

/** The stub `gh`: logs argv, and whether a token was injected (never the token itself). */
const GH_STUB = `#!/bin/bash
D="$(dirname "$0")"
printf '%s\\n' "$*" >> "$D/gh.argv"
if [ -n "\${GH_TOKEN:-}" ]; then echo "token" >> "$D/gh.token-seen"; fi
case "$1 $2" in
  "config get") exit 0 ;;
esac
if [ "$1 $2" = "pr create" ]; then echo "https://github.com/example-org/svc/pull/7"; else echo "gh ran: $*"; fi
exit 0
`;

/**
 * The stub `taaad`: prints `mint.json` (a PR write), `mint.push.json` (a git push: exactly contents write, nothing
 * wider, or the mint validator refuses it) or `mint.read.json` (a read); fails when `taaad.fail` exists.
 */
const TAAAD_STUB = `#!/bin/bash
D="$(dirname "$0")"
printf '%s\\n' "$*" >> "$D/taaad.argv"
[ -f "$D/taaad.fail" ] && exit 1
case "$*" in
  *"--permissions read"*) F="$D/mint.read.json" ;;
  *"--permissions contents-write"*) F="$D/mint.push.json" ;;
  *) F="$D/mint.json" ;;
esac
cat "$F"
exit 0
`;

function mintJson(permissions: Record<string, string>): string {
  return JSON.stringify({
    token: TOKEN_BOT,
    expiresAt: "2099-01-01T00:00:00Z",
    installationAccount: "example-org",
    installationId: 1,
    appId: 2,
    repositories: ["svc"],
    permissions,
  });
}

let base: string;
let restoreGitEnv: () => void;
let worlds = 0;

before(() => {
  restoreGitEnv = scrubGitEnv();
  base = realpathSync(mkdtempSync(join(tmpdir(), "repo-aegis-agent-publish-")));
});
after(() => {
  restoreGitEnv();
  rmSync(base, { recursive: true, force: true });
});

interface World {
  root: string;
  home: string;
  hooksDir: string;
  stubs: string;
  repo: string;
  globalConfig: string;
  taaadPath: string;
  taaad: TaaadPin;
}

function write(path: string, text: string, mode = 0o644): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text, { mode });
  chmodSync(path, mode);
}

/** Build the world described at the top of the file. `localHooksPath` is what the repo-local config holds. */
function makeWorld(opts: { localHooksPath?: "own" | "foreign" | "none"; approve?: boolean; registry?: string } = {}): World {
  const root = join(base, `w${worlds++}`);
  const home = join(root, "aegis");
  const hooksDir = join(home, "hooks");
  const stubs = join(root, "stubs");
  const repo = join(root, "svc");
  const globalConfig = join(root, "gitconfig");
  mkdirSync(join(home, "state"), { recursive: true });
  mkdirSync(hooksDir, { recursive: true });
  write(join(home, "engagements.yaml"), opts.registry ?? REGISTRY);
  write(join(hooksDir, "pre-commit"), "#!/bin/sh\nexit 0\n", 0o755);
  write(join(hooksDir, "pre-push"), "#!/bin/sh\nexit 0\n", 0o755);
  write(join(stubs, "gh"), GH_STUB, 0o755);
  write(join(stubs, "taaad"), TAAAD_STUB, 0o755);
  write(join(stubs, "mint.json"), mintJson({ metadata: "read", contents: "write", pull_requests: "write" }));
  write(join(stubs, "mint.push.json"), mintJson({ metadata: "read", contents: "write" }));
  write(join(stubs, "mint.read.json"), mintJson({ metadata: "read", contents: "read", pull_requests: "read" }));

  // The global config `install hooks` and `install git-credential` write: the hooks path and the helper.
  const env = hermeticGitEnv({ GIT_CONFIG_GLOBAL: globalConfig });
  const git = (cwd: string, ...a: string[]): void => void spawnSync("git", a, { cwd, env, stdio: "ignore" });
  git(root, "config", "--global", "core.hooksPath", hooksDir);
  git(root, "config", "--global", "credential.https://github.com.useHttpPath", "true");
  git(root, "config", "--global", "credential.https://github.com.helper", `!repo-aegis git-credential --home ${home}`);

  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "remote", "add", "origin", "https://github.com/example-org/svc.git");
  git(repo, "config", "repo-aegis.class", "private-strict");
  git(repo, "config", "repo-aegis.visibility", "private");
  const local = opts.localHooksPath ?? "own";
  if (local === "own") git(repo, "config", "--local", "core.hooksPath", hooksDir);
  if (local === "foreign") git(repo, "config", "--local", "core.hooksPath", join(root, "someone-elses-hooks"));

  // The human step: `repo-aegis approve example-org/*`, bound to the mapped person's account.
  if (opts.approve !== false) mintApproval({ target: { org: "example-org", repo: "*" }, login: "alice", path: approvalsPath(home) });

  return {
    root,
    home,
    hooksDir,
    stubs,
    repo,
    globalConfig,
    taaadPath: join(stubs, "taaad"),
    taaad: { launcher: join(stubs, "taaad"), interpreter: "/bin/bash", packageDir: stubs },
  };
}

const lines = (path: string): string[] => (existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(l => l !== "") : []);

// ---------------------------------------------------------------------------
// The push: git asks the credential helper
// ---------------------------------------------------------------------------

/** What git writes to the helper for `git push origin <branch>` with credential.useHttpPath=true. */
const GIT_ASKS = "protocol=https\nhost=github.com\npath=example-org/svc.git\n\n";

type Unreadable = "null" | "throws" | "readable";

function helperEnv(w: World): NodeJS.ProcessEnv {
  return { PATH: process.env["PATH"] ?? "", HOME: join(w.root, "fake-home"), GIT_CONFIG_GLOBAL: w.globalConfig, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_SYSTEM: "/dev/null" };
}

function helper(
  w: World,
  how: Unreadable,
  presence: IdentityPresence = "agent",
  over: Partial<GitCredentialDeps> = {},
): { stdout: string; stderr: string } {
  const env = helperEnv(w);
  const deps: GitCredentialDeps = {
    env,
    cwd: w.repo,
    presence: () => presence,
    // The sandbox: `ps` is blocked, so the chain cannot be read (a null chain, or a reader that faults).
    ancestry: () => {
      if (how === "throws") throw new Error("ps: operation not permitted");
      if (how === "readable") {
        // Outside a sandbox: git push -> git-remote-https -> the helper.
        return [
          { pid: 10, ppid: 9, comm: "git-remote-https", argv: ["git-remote-https", "origin", "https://github.com/example-org/svc.git"] },
          { pid: 9, ppid: 8, comm: "git", argv: ["git", "push", "origin", "main"] },
          { pid: 8, ppid: 1, comm: "zsh", argv: ["zsh"] },
        ];
      }
      return null;
    },
    readConfig: readCredentialConfig,
    loadRegistry: h => loadRegistry(join(h, "engagements.yaml")),
    resolveTaaad: () => w.taaadPath,
    mint: mintAppToken,
    loginToken: () => ({ kind: "unavailable" }),
    ...over,
  };
  return runGitCredential("get", GIT_ASKS, w.home, deps);
}

describe("Phase U exit criterion: an agent publishes under one account-bound approval, in a sandbox", () => {
  for (const how of ["null", "throws"] as const) {
    describe(`(a) git push over HTTPS, process list unreadable (${how})`, () => {
      it("the helper returns the App's credential, with no approval notice (the helper does not read approvals)", () => {
        const w = makeWorld();
        const r = helper(w, how);
        assert.match(r.stdout, /^username=x-access-token\npassword=ghs_STUBexamplebot0123456789abcdef\n/, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
        // No U5 notice (an approval exists in this world and is ignored), and never the token.
        assert.equal(r.stderr, "");
        // Narrowed to exactly this repository, for a push.
        assert.deepEqual(lines(join(w.stubs, "taaad.argv")), ["mint --app example-bot --repo example-org/svc --permissions contents-write --json"]);
      });

      it("(d) with no approval the helper answers all the same: an unreadable process list is no refusal", () => {
        const w = makeWorld({ approve: false });
        const r = helper(w, how);
        assert.match(r.stdout, /^username=x-access-token\npassword=ghs_STUBexamplebot0123456789abcdef\n/, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
        assert.ok(!r.stderr.includes("AGENT_PUSH_CHAIN_UNREADABLE"), r.stderr);
        assert.deepEqual(lines(join(w.stubs, "taaad.argv")), ["mint --app example-bot --repo example-org/svc --permissions contents-write --json"]);
      });
    });
  }

  it("control: with a readable process chain the same fixture world yields the credential (the fixture itself is sound)", () => {
    const w = makeWorld({ approve: false });
    const r = helper(w, "readable");
    assert.match(r.stdout, /^username=x-access-token\npassword=ghs_STUBexamplebot0123456789abcdef\n/, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
  });

  // -------------------------------------------------------------------------
  // P1 acceptance
  // -------------------------------------------------------------------------

  describe("P1 acceptance: an agent push from the default Claude Code sandbox", () => {
    const PERSON_ONLY = `schemaVersion: 3
identities:
  alice: { kind: gh-login, login: alice }
personalOrgs:
  - { name: example-org, person: alice }
engagements: []
`;
    const TOKEN_ALICE = "gho_STUBalice0123456789abcdef";

    /** The sandbox: a proxy variable, no process list, no tty, no approval, and a stubbed login token. */
    function sandboxPush(w: World, extraEnv: Record<string, string> = {}): { stdout: string; stderr: string; asked: string[] } {
      const asked: string[] = [];
      const env: NodeJS.ProcessEnv = {
        ...helperEnv(w),
        HTTP_PROXY: "http://127.0.0.1:3128",
        HTTPS_PROXY: "http://127.0.0.1:3128",
        http_proxy: "http://127.0.0.1:3128",
        https_proxy: "http://127.0.0.1:3128",
        NO_PROXY: "localhost",
        SANDBOX_RUNTIME: "1",
        ...extraEnv,
      };
      const r = helper(w, "throws", "agent", {
        env,
        ancestry: () => {
          throw new Error("ps: operation not permitted");
        },
        presence: () => identityPresence({ kind: "no-tty" } as TerminalCheck),
        loginToken: login => {
          asked.push(login);
          return { kind: "token", token: TOKEN_ALICE };
        },
      });
      return { ...r, asked };
    }

    it("person-only registry (the D1 default): the mapped login's token, nothing refused, nothing minted", () => {
      const w = makeWorld({ approve: false, registry: PERSON_ONLY });
      const r = sandboxPush(w);
      assert.equal(r.stdout, `username=x-access-token\npassword=${TOKEN_ALICE}\n`, `stderr: ${r.stderr}`);
      assert.deepEqual(r.asked, ["alice"]);
      assert.doesNotMatch(r.stderr, /\[[A-Z_]+[;\]]/, `no refusal code: ${r.stderr}`);
      assert.ok(!r.stderr.includes("gho_"), "the token never reaches stderr");
      assert.deepEqual(lines(join(w.stubs, "taaad.argv")), []);
    });

    it("App opt-in (the registry maps an agent App): the App token, narrowed to the repository, stderr empty", () => {
      const w = makeWorld({ approve: false });
      const r = sandboxPush(w);
      assert.match(r.stdout, /^username=x-access-token\npassword=ghs_STUBexamplebot0123456789abcdef\n/, `stderr: ${r.stderr}`);
      assert.deepEqual(lines(join(w.stubs, "taaad.argv")), ["mint --app example-bot --repo example-org/svc --permissions contents-write --json"]);
      assert.equal(r.stderr, "");
      assert.deepEqual(r.asked, [], "no login token was asked for");
    });

    it("an unmapped owner: nothing on stdout (git's next helper answers)", () => {
      const w = makeWorld({ approve: false, registry: PERSON_ONLY.replace("name: example-org", "name: other-org") });
      const r = sandboxPush(w);
      assert.equal(r.stdout, "");
      assert.deepEqual(r.asked, []);
    });

    it("control: the same world with GIT_TRACE_CURL=1 is refused (the fixture is not vacuous)", () => {
      const w = makeWorld({ approve: false, registry: PERSON_ONLY });
      const r = sandboxPush(w, { GIT_TRACE_CURL: "1" });
      assert.equal(r.stdout, "quit=true\n");
      assert.match(r.stderr, /AGENT_PUSH_CREDENTIAL_CONFIG/);
      assert.deepEqual(r.asked, []);
    });
  });

  // -------------------------------------------------------------------------
  // The PR: `repo-aegis gh`
  // -------------------------------------------------------------------------

  const TERMINAL_AGENT: TerminalCheck = { kind: "agent", ancestor: "claude" } as TerminalCheck;

  interface Ran {
    status: number;
    out: string;
    err: string;
    ghArgv: string[];
    taaadArgv: string[];
    tokenSeenByGh: boolean;
  }

  /** The gh stub's calls that are the call itself: not the trusted-gh config probe made before a mint. */
  const mainCalls = (r: Ran): string[] => r.ghArgv.filter(l => !l.startsWith("config get"));

  function runGh(w: World, args: string[]): Ran {
    const out: string[] = [];
    const err: string[] = [];
    const deps: GhCommandDeps = {
      env: {
        PATH: [w.stubs, process.env["PATH"] ?? ""].join(":"),
        HOME: join(w.root, "fake-home"),
        TERM: "xterm",
        LANG: "C",
        GIT_CONFIG_GLOBAL: w.globalConfig,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_SYSTEM: "/dev/null",
        ...(process.env["TMPDIR"] !== undefined && { TMPDIR: process.env["TMPDIR"] }),
      },
      // The sandbox: no process list, no pty; the presence reader says "agent".
      terminal: () => TERMINAL_AGENT,
      trust: "permissive",
      taaad: w.taaad,
      io: { out: t => void out.push(t), err: t => void err.push(t) },
      captureChild: true,
    };
    const status = runGhCommand(args, { home: w.home, cwd: w.repo }, deps);
    return {
      status,
      out: out.join(""),
      err: err.join(""),
      ghArgv: lines(join(w.stubs, "gh.argv")),
      taaadArgv: lines(join(w.stubs, "taaad.argv")),
      tokenSeenByGh: existsSync(join(w.stubs, "gh.token-seen")),
    };
  }

  function refusalCode(r: Ran): string | undefined {
    for (const l of r.err.split("\n")) {
      if (!l.startsWith("{")) continue;
      try {
        const j = JSON.parse(l) as { code?: string };
        if (j.code !== undefined) return j.code;
      } catch {
        /* not JSON */
      }
    }
    return undefined;
  }

  const PR_CREATE = ["pr", "create", "--repo", "example-org/svc", "--title", "t", "--body", "b"];
  const PR_VIEW = ["pr", "view", "1", "--repo", "example-org/svc"];

  describe("(b) gh pr create, repo-local core.hooksPath equal to repo-aegis's own hooks directory", () => {
    it("runs as the App instead of refusing GH_IDENTITY_ARG_UNSAFE", () => {
      const w = makeWorld({ localHooksPath: "own" });
      const r = runGh(w, PR_CREATE);
      assert.notEqual(refusalCode(r), "GH_IDENTITY_ARG_UNSAFE", r.err);
      assert.equal(r.status, 0, r.err);
      assert.deepEqual(mainCalls(r), [PR_CREATE.join(" ")]);
      assert.ok(r.tokenSeenByGh, "the call ran with the App's token");
      assert.deepEqual(r.taaadArgv, ["mint --app example-bot --repo example-org/svc --permissions write --json"]);
      assert.match(r.err, /^PUBLISHED → example-org\/svc/m);
    });

    it("also runs for a FOREIGN repo-local core.hooksPath, because the account-bound approval covers it (U5)", () => {
      const w = makeWorld({ localHooksPath: "foreign" });
      const r = runGh(w, PR_CREATE);
      assert.notEqual(refusalCode(r), "GH_IDENTITY_ARG_UNSAFE", r.err);
      assert.equal(r.status, 0, r.err);
      assert.ok(r.tokenSeenByGh);
    });

    it("(d) a foreign repo-local core.hooksPath with no approval still refuses GH_IDENTITY_ARG_UNSAFE, before any token is minted", () => {
      const w = makeWorld({ localHooksPath: "foreign", approve: false });
      const r = runGh(w, PR_CREATE);
      assert.equal(refusalCode(r), "GH_IDENTITY_ARG_UNSAFE", r.err);
      assert.equal(r.status, 2);
      assert.deepEqual(r.ghArgv, [], "gh ran");
      assert.deepEqual(r.taaadArgv, [], "a token was minted");
    });

    it("(d) an approval for another owner does not cover a foreign repo-local core.hooksPath", () => {
      const w = makeWorld({ localHooksPath: "foreign", approve: false });
      mintApproval({ target: { org: "other-org", repo: "*" }, login: "alice", path: approvalsPath(w.home) });
      mintApproval({ target: { org: "example-org", repo: "*" }, path: approvalsPath(w.home) }); // no account bound
      const r = runGh(w, PR_CREATE);
      assert.equal(refusalCode(r), "GH_IDENTITY_ARG_UNSAFE", r.err);
      assert.deepEqual(r.ghArgv, []);
    });
  });

  it("control: with no repo-local core.hooksPath and no approval, pr create runs as the App (the fixture itself is sound)", () => {
    const w = makeWorld({ localHooksPath: "none", approve: false });
    const r = runGh(w, PR_CREATE);
    assert.equal(r.status, 0, r.err);
    assert.ok(r.tokenSeenByGh);
    assert.deepEqual(mainCalls(r), [PR_CREATE.join(" ")]);
  });

  describe("(c) a read whose identity cannot be minted", () => {
    it("gh pr view runs as the active account with one warning line, not GH_IDENTITY_UNAVAILABLE", () => {
      const w = makeWorld();
      writeFileSync(join(w.stubs, "taaad.fail"), "");
      const r = runGh(w, PR_VIEW);
      assert.notEqual(refusalCode(r), "GH_IDENTITY_UNAVAILABLE", r.err);
      assert.equal(r.status, 0, r.err);
      assert.deepEqual(mainCalls(r), [PR_VIEW.join(" ")], "gh ran the read");
      assert.equal(r.tokenSeenByGh, false, "no token was injected: it ran as the active account");
      const warnings = r.err.split("\n").filter(l => /^repo-aegis/.test(l) && /active|identity/i.test(l));
      assert.equal(warnings.length, 1, `exactly one warning line on stderr: ${r.err}`);
    });

    it("(d) a WRITE whose identity cannot be minted still refuses GH_IDENTITY_UNAVAILABLE and never runs gh", () => {
      const w = makeWorld({ localHooksPath: "none" });
      writeFileSync(join(w.stubs, "taaad.fail"), "");
      const r = runGh(w, PR_CREATE);
      assert.equal(refusalCode(r), "GH_IDENTITY_UNAVAILABLE", r.err);
      assert.equal(r.status, 2);
      assert.deepEqual(mainCalls(r), [], "gh ran as the active account for a write");
    });
  });
});

// ---------------------------------------------------------------------------
// The real seams, once
// ---------------------------------------------------------------------------

describe("the real seams: the built helper with the real process-list reader and presence reader", { skip: !cliBuilt() }, () => {
  it("answers the push with the App credential, never a crash or silent empty output", () => {
    const w = makeWorld({ approve: false }); // no approval: the helper does not read them
    write(join(w.home, "bin", "gh"), renderShimScript({ node: process.execPath, cli: cliPath }, { home: w.home, taaad: w.taaad }), 0o755);
    // A `ps` that fails, first on PATH. The real reader runs ps by ABSOLUTE path (an agent must not be able to
    // fake it), so this does not make the process list unreadable here; where the sandbox does block it, the
    // chain is unreadable. Either way the helper answers the push. Nothing is injected: the real
    // `readProcessAncestry`, the real presence reader and the real git config reader all run. HTTPS_PROXY is set,
    // as in the default Claude Code sandbox: a proxy variable does not stop the token.
    const fakeBin = join(w.root, "fakebin");
    write(join(fakeBin, "ps"), "#!/bin/sh\nexit 1\n", 0o755);
    const r = spawnSync(process.execPath, [cliPath, "git-credential", "--home", w.home, "get"], {
      cwd: w.repo,
      input: GIT_ASKS,
      encoding: "utf8",
      env: {
        PATH: `${fakeBin}:${process.env["PATH"] ?? ""}`,
        HTTPS_PROXY: "http://127.0.0.1:3128",
        HOME: join(w.root, "fake-home"),
        GIT_CONFIG_GLOBAL: w.globalConfig,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_SYSTEM: "/dev/null",
      },
    });
    const label = `status=${r.status} stdout=${JSON.stringify(r.stdout)} stderr=${r.stderr}`;
    assert.equal(r.status, 0, `a helper always exits 0: ${label}`);
    assert.notEqual(r.stdout, "", `silent empty output would hand the agent the person's own helper: ${label}`);
    assert.ok(!/TypeError|ReferenceError|\n\s+at .*\.js:\d+/.test(r.stderr), `no stack trace: ${label}`);
    assert.ok(!r.stderr.includes("ghs_"), `the token never reaches stderr: ${label}`);
    assert.match(r.stdout, /^username=x-access-token\npassword=ghs_STUBexamplebot0123456789abcdef\n/, label);
    assert.equal(r.stderr, "", label);
  });
});
