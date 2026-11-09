// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// `repo-aegis gh` (doc/plan-owner-identity.md D1, §13.3), against STUB `gh` and `taaad` scripts. Never the real
// network, never a real token: every token below is a made-up string, and the stubs are bash scripts in a
// temp directory.
//
// Two ways to run it. In-process (`runGhCommand` with its test seams: the presence reader, `trust:
// "permissive"` because stubs are not in a root-owned directory, captured child output) for everything that
// needs a token to flow; as a SUBPROCESS (the built CLI, no seams, no TTY) for what must hold without any seam:
// refusals, pass-through, the refusal of an untrusted binary.
//
// Placeholders only: alice, bob, example-org, person-only-org, example-bot, other-org.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { approvalsPath, mintApproval, type TerminalCheck } from "@de-otio/repo-aegis-core";
import { cliBuilt, cliPath } from "../_subprocess-utils.js";
import { scrubGitEnv } from "../_test-utils.js";
import { runGhCommand, decisionLogPath, findPlainGh, type GhCommandDeps } from "./gh-command.js";
import { MintError, validateMintOutput } from "./taaad-mint.js";
import type { TaaadPin } from "./taaad-pin.js";

// ---------------------------------------------------------------------------
// Tokens and fixtures
// ---------------------------------------------------------------------------

const TOKEN_ALICE = "ghp_STUBalice0123456789abcdefXYZ";
const TOKEN_BOB = "ghp_STUBbob000123456789abcdefXYZ";
const TOKEN_BOT = "ghs_STUBexamplebot0123456789abcdef";
const ALL_TOKENS = [TOKEN_ALICE, TOKEN_BOB, TOKEN_BOT];

const REGISTRY = `schemaVersion: 3
identities:
  alice: { kind: gh-login, login: alice }
  bob: { kind: gh-login, login: bob }
  example-bot: { kind: github-app, app: example-bot }
personalOrgs:
  - { name: example-org, person: alice, agent: example-bot }
  - { name: person-only-org, person: alice }
  - { name: agent-only-org, agent: example-bot }
  - plain-org
engagements: []
`;

/** The stub `gh`. Argv is logged (never the environment); the environment goes to `gh.<n>.env`, the ONE place a token may be. */
const GH_STUB = `#!/usr/bin/env bash
D="$(dirname "$0")"
n=$(( $(cat "$D/seq" 2>/dev/null || echo 0) + 1 ))
echo "$n" > "$D/seq"
printf '%s\\n' "$*" >> "$D/gh.argv"
env | sort > "$D/gh.$n.env"
# What a hostile environment would do with a token, so a leak lands in a file the test scans:
[ -n "\${HTTPS_PROXY:-}" ] && printf 'proxy-sees GH_TOKEN=%s\\n' "\${GH_TOKEN:-}" >> "\${HTTPS_PROXY#file://}"
: "\${GH_TOKEN:-}"
case "$1 $2" in
  "auth token")
    if [ -n "\${GH_TOKEN:-}" ]; then echo "$GH_TOKEN"; exit 0; fi
    U=""; while [ $# -gt 0 ]; do [ "$1" = "--user" ] && U="$2"; shift; done
    [ -f "$D/token.$U" ] || exit 1
    cat "$D/token.$U"; exit 0 ;;
  "config get") [ -f "$D/socket" ] && cat "$D/socket"; exit 0 ;;
  "auth switch") touch "$D/switched"; exit 0 ;;
esac
[ -n "\${GH_EDITOR:-}" ] && "$GH_EDITOR" "$D/edit-target"
if [ "$1 $2" = "pr create" ]; then OUT="https://github.com/example-org/svc/pull/7"; else OUT="gh ran: $*"; fi
if [ -n "\${GH_FORCE_TTY:-}" ] && [ -n "\${GH_PAGER:-}" ]; then echo "$OUT" | $GH_PAGER; else echo "$OUT"; fi
[ -f "$D/fail" ] && { echo "HTTP 422" >&2; exit 1; }
exit 0
`;

/** The stub `taaad`: logs argv and its (token-free) environment, prints whatever \`mint.json\` holds. */
const TAAAD_STUB = `#!/usr/bin/env bash
D="$(dirname "$0")"
printf '%s\\n' "$*" >> "$D/taaad.argv"
env | sort > "$D/taaad.env"
[ -f "$D/taaad.fail" ] && exit 1
case "$*" in *"--permissions read"*) F="$D/mint.read.json" ;; *) F="$D/mint.json" ;; esac
[ -f "$F" ] && cat "$F"
exit 0
`;

/** A logging stub for a program that must never run (a pager, an editor, a bash first on PATH). */
const NEVER_STUB = `#!/bin/sh
D="$(dirname "$0")"
echo "RAN $0 $*" >> "$D/../never.log"
env >> "$D/../never.log"
exit 0
`;

function mintJson(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    token: TOKEN_BOT,
    expiresAt: "2099-01-01T00:00:00Z",
    installationAccount: "example-org",
    installationId: 1,
    appId: 2,
    repositories: ["svc"],
    permissions: { metadata: "read", contents: "write", pull_requests: "write" },
    ...over,
  });
}

let base: string;
let restoreGitEnv: () => void;
before(() => {
  restoreGitEnv = scrubGitEnv();
  base = mkdtempSync(join(tmpdir(), "repo-aegis-gh-command-test-"));
});
after(() => {
  restoreGitEnv();
  rmSync(base, { recursive: true, force: true });
});

interface World {
  root: string;
  home: string;
  stubs: string;
  /** A private-strict checkout whose origin is `example-org/svc`: egress allows writes to it with no approval. */
  repo: string;
  taaad: TaaadPin;
}

let worldCount = 0;

function writeStub(path: string, text: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text, { mode: 0o755 });
  chmodSync(path, 0o755);
}

function makeWorld(registry: string = REGISTRY): World {
  const root = join(base, `w${worldCount++}`);
  const home = join(root, "aegis");
  const stubs = join(root, "stubs");
  mkdirSync(join(home, "state"), { recursive: true });
  writeFileSync(join(home, "engagements.yaml"), registry);
  writeStub(join(stubs, "gh"), GH_STUB);
  writeStub(join(stubs, "taaad"), TAAAD_STUB);
  writeFileSync(join(stubs, "token.alice"), TOKEN_ALICE + "\n");
  writeFileSync(join(stubs, "token.bob"), TOKEN_BOB + "\n");
  writeFileSync(join(stubs, "mint.json"), mintJson());
  writeFileSync(join(stubs, "mint.read.json"), mintJson({ permissions: { metadata: "read", contents: "read", pull_requests: "read" } }));
  for (const name of ["pager", "editor"]) writeStub(join(root, "never", name), NEVER_STUB);
  writeStub(join(root, "fakebin", "bash"), NEVER_STUB);
  const repo = join(root, "svc");
  mkdirSync(repo, { recursive: true });
  const git = (...a: string[]): void => void spawnSync("git", a, { cwd: repo, stdio: "ignore" });
  git("init", "-q", "-b", "main");
  git("remote", "add", "origin", "git@github.com:example-org/svc.git");
  git("config", "repo-aegis.class", "private-strict");
  git("config", "repo-aegis.visibility", "private");
  return { root, home, stubs, repo, taaad: { launcher: join(stubs, "taaad"), interpreter: "/bin/bash", packageDir: stubs } };
}

type Presence = "person" | "agent" | "unknown" | "throws";

const TERMINALS: Record<Exclude<Presence, "throws">, TerminalCheck> = {
  person: { kind: "clear" },
  agent: { kind: "agent", ancestor: "claude" } as TerminalCheck,
  unknown: { kind: "unrooted" },
};

interface RunOpts {
  presence?: Presence;
  /** Merged over the caller environment (PATH has the stubs first). `undefined` values delete. */
  env?: Record<string, string | undefined>;
  cwd?: string;
  taaad?: TaaadPin | null;
  trust?: "default" | "permissive";
  /** Leave the fake bash off the caller's PATH (for pass-through cases, where the stub gh sees that PATH). */
  plainPath?: boolean;
  /** Replaces the egress decision (a test seam for a fault in it). */
  evaluate?: GhCommandDeps["evaluate"];
}

interface Ran {
  status: number;
  out: string;
  err: string;
  /** Argv of every gh stub call, one per line. */
  ghArgv: string[];
  taaadArgv: string[];
}

function lines(path: string): string[] {
  return existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(l => l !== "") : [];
}

function callerEnv(w: World, extra: RunOpts["env"] = {}, fakeBash = true): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    // A fake bash first on the caller's PATH, unless the case runs the stub gh with the caller's own environment
    // (the stubs start with `env bash`, which would find it).
    PATH: [...(fakeBash ? [join(w.root, "fakebin")] : []), w.stubs, process.env["PATH"] ?? ""].join(":"),
    HOME: join(w.root, "fake-home"),
    TERM: "xterm",
    LANG: "C",
    ...(process.env["TMPDIR"] !== undefined && { TMPDIR: process.env["TMPDIR"] }),
  };
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return env;
}

function run(w: World, args: string[], o: RunOpts = {}): Ran {
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  const presence = o.presence ?? "agent";
  const deps: GhCommandDeps = {
    env: callerEnv(w, o.env, o.plainPath !== true),
    terminal: presence === "throws" ? () => {
      throw new Error("the ancestry reader exploded");
    } : () => TERMINALS[presence],
    trust: o.trust ?? "permissive",
    taaad: o.taaad !== undefined ? o.taaad : w.taaad,
    io: { out: t => void outChunks.push(t), err: t => void errChunks.push(t) },
    captureChild: true,
    ...(o.evaluate !== undefined && { evaluate: o.evaluate }),
  };
  const status = runGhCommand(args, { home: w.home, cwd: o.cwd ?? w.repo }, deps);
  return {
    status,
    out: outChunks.join(""),
    err: errChunks.join(""),
    ghArgv: lines(join(w.stubs, "gh.argv")),
    taaadArgv: lines(join(w.stubs, "taaad.argv")),
  };
}

/** The environment (`NAME=value` lines) of the gh stub's n-th call, 1-based. */
function ghEnv(w: World, n: number): Record<string, string> {
  const out: Record<string, string> = {};
  for (const l of lines(join(w.stubs, `gh.${n}.env`))) {
    const i = l.indexOf("=");
    if (i > 0) out[l.slice(0, i)] = l.slice(i + 1);
  }
  return out;
}

/** The argv lines of gh stub calls that are the CALL ITSELF, not a token fetch or config read. */
function mainCalls(r: Ran): string[] {
  return r.ghArgv.filter(l => !l.startsWith("auth token") && !l.startsWith("config get"));
}

/** Index (1-based) of the call itself in the gh stub's log. */
function mainCallNumber(r: Ran): number {
  const i = r.ghArgv.findIndex(l => !l.startsWith("auth token") && !l.startsWith("config get"));
  return i + 1;
}

const WRITE = ["pr", "create", "--repo", "example-org/svc", "--title", "t", "--body", "b"];
const READ = ["pr", "view", "1", "--repo", "example-org/svc"];

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

function decisions(w: World): Array<Record<string, unknown>> {
  return lines(decisionLogPath(w.home)).map(l => JSON.parse(l) as Record<string, unknown>);
}

// ---------------------------------------------------------------------------
// I1, I2, I5: the injection itself
// ---------------------------------------------------------------------------

describe("repo-aegis gh: injection", () => {
  it("I1: an agent write to a mapped owner runs as the owner's github-app, narrowed to the repository", () => {
    const w = makeWorld();
    const r = run(w, WRITE, { presence: "agent" });
    assert.equal(r.status, 0, r.err);
    // taaad is asked for exactly this repository and the write scope.
    assert.deepEqual(r.taaadArgv, ["mint --app example-bot --repo example-org/svc --permissions write --json"]);
    // The gh stub received the App token, and nothing else was fetched with `gh auth token`.
    assert.deepEqual(r.ghArgv.filter(l => l.startsWith("auth token")), []);
    const n = mainCallNumber(r);
    assert.equal(ghEnv(w, n)["GH_TOKEN"], TOKEN_BOT);
    assert.match(r.err, /^repo-aegis: as example-bot \(github-app\) for example-org\/svc$/m);
    // The call's own arguments reached gh unchanged.
    assert.equal(mainCalls(r)[0], WRITE.join(" "));
    // The receipt follows gh's return.
    assert.match(r.err, /^PUBLISHED → example-org\/svc/m);
  });

  it("I1: a read gets the read class (metadata and contents, no write)", () => {
    const w = makeWorld();
    const r = run(w, READ, { presence: "agent" });
    assert.equal(r.status, 0, r.err);
    assert.deepEqual(r.taaadArgv, ["mint --app example-bot --repo example-org/svc --permissions read --json"]);
  });

  it("taaad is run with an environment of exactly HOME, PATH=/usr/bin:/bin, TERM and LANG (A4), whatever the caller sets", () => {
    const w = makeWorld();
    const r = run(w, WRITE, {
      presence: "agent",
      env: { TAAAD_CONFIG_DIR: join(w.root, "evil"), XDG_CONFIG_HOME: join(w.root, "evil"), HTTPS_PROXY: "http://127.0.0.1:9", BASH_ENV: join(w.root, "x") },
    });
    assert.equal(r.status, 0, r.err);
    const names = lines(join(w.stubs, "taaad.env"))
      .map(l => l.slice(0, l.indexOf("=")))
      // The shell adds PWD/SHLVL/_/OLDPWD; Node itself adds NODE_V8_COVERAGE to every child under coverage
      // (`npm run test:cov`), whatever env the spawn passes. Neither comes from the caller.
      .filter(n => !["PWD", "SHLVL", "_", "OLDPWD", "NODE_V8_COVERAGE"].includes(n))
      .sort();
    assert.deepEqual(names, ["HOME", "LANG", "PATH", "TERM"]);
    const path = lines(join(w.stubs, "taaad.env")).find(l => l.startsWith("PATH="));
    assert.equal(path, "PATH=/usr/bin:/bin");
  });

  it("I2: with a person present the same call runs as the person's gh login", () => {
    const w = makeWorld();
    const r = run(w, WRITE, { presence: "person" });
    assert.equal(r.status, 0, r.err);
    assert.deepEqual(r.taaadArgv, [], "no App token is minted for a person");
    assert.deepEqual(r.ghArgv.filter(l => l.startsWith("auth token")), ["auth token --hostname github.com --user alice"]);
    assert.equal(ghEnv(w, mainCallNumber(r))["GH_TOKEN"], TOKEN_ALICE);
    assert.match(r.err, /^repo-aegis: as alice \(gh-login\) for example-org\/svc$/m);
  });

  it("I5: an agent READ for an owner with only a person identity runs as that person", () => {
    const w = makeWorld();
    const r = run(w, ["pr", "view", "1", "--repo", "person-only-org/x"], { presence: "agent" });
    assert.equal(r.status, 0, r.err);
    assert.equal(ghEnv(w, mainCallNumber(r))["GH_TOKEN"], TOKEN_ALICE);
    assert.deepEqual(r.taaadArgv, []);
  });

  it("the gh child gets the A2 allowlisted environment and nothing the caller added", () => {
    const w = makeWorld();
    const proxySink = join(w.root, "proxy.sink");
    const r = run(w, WRITE, {
      presence: "agent",
      env: {
        GH_PAGER: join(w.root, "never", "pager"),
        PAGER: join(w.root, "never", "pager"),
        GH_FORCE_TTY: "1",
        GH_EDITOR: join(w.root, "never", "editor"),
        EDITOR: join(w.root, "never", "editor"),
        VISUAL: join(w.root, "never", "editor"),
        HTTPS_PROXY: `file://${proxySink}`,
        HTTP_PROXY: `file://${proxySink}`,
        BASH_ENV: join(w.root, "never", "bashenv"),
        SHELLOPTS: "xtrace",
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "core.fsmonitor",
        GIT_CONFIG_VALUE_0: join(w.root, "never", "editor"),
        SSL_CERT_FILE: join(w.root, "never", "cert"),
        GH_DEBUG: "api",
        LC_ALL: "C",
      },
    });
    assert.equal(r.status, 0, r.err);
    const env = ghEnv(w, mainCallNumber(r));
    for (const gone of ["EDITOR", "VISUAL", "GH_EDITOR", "PAGER", "HTTPS_PROXY", "HTTP_PROXY", "BASH_ENV", "SHELLOPTS", "SSL_CERT_FILE", "GH_DEBUG", "GH_FORCE_TTY"]) {
      assert.equal(env[gone], undefined, `${gone} reached the gh child`);
    }
    assert.equal(env["GH_PAGER"], "", "the pager is switched off");
    assert.equal(env["GH_PROMPT_DISABLED"], "1");
    assert.equal(env["GIT_TERMINAL_PROMPT"], "0");
    assert.equal(env["GIT_CONFIG_COUNT"], "4", "the caller's GIT_CONFIG_* is replaced, not extended");
    assert.deepEqual(
      [0, 1, 2, 3].map(i => `${env[`GIT_CONFIG_KEY_${i}`]}=${env[`GIT_CONFIG_VALUE_${i}`]}`),
      ["core.fsmonitor=false", "core.hooksPath=/dev/null", "credential.helper=", "core.sshCommand=ssh"],
    );
    assert.equal(env["LC_ALL"], "C", "locale variables are kept");
    // PATH is pinned: the caller's fake bash directory is not on it.
    assert.ok(!(env["PATH"] ?? "").includes("fakebin"), String(env["PATH"]));
    assert.equal(existsSync(join(w.root, "never.log")), false, "a pager, editor or fake bash ran");
    assert.equal(existsSync(proxySink), false, "the token reached the proxy");
  });

  it("GH_REPO, which the target was judged with, is kept for the child", () => {
    const w = makeWorld();
    const r = run(w, ["pr", "view", "1"], { presence: "agent", env: { GH_REPO: "example-org/svc" } });
    assert.equal(r.status, 0, r.err);
    assert.equal(ghEnv(w, mainCallNumber(r))["GH_REPO"], "example-org/svc");
    assert.equal(ghEnv(w, mainCallNumber(r))["GH_TOKEN"], TOKEN_BOT);
  });

  it("a gh failure is passed through: its exit status, its stderr, and the failure receipt, not the success one", () => {
    const w = makeWorld();
    writeFileSync(join(w.stubs, "fail"), "");
    const r = run(w, WRITE, { presence: "agent" });
    assert.equal(r.status, 1);
    assert.match(r.err, /HTTP 422/);
    assert.match(r.err, /^EGRESS FAILED → example-org\/svc/m);
    assert.ok(!r.err.includes("PUBLISHED"));
  });

  it("writes a decision-log record for the injected call, with no token in it (A15)", () => {
    const w = makeWorld();
    const r = run(w, WRITE, { presence: "agent" });
    assert.equal(r.status, 0, r.err);
    const [rec] = decisions(w);
    assert.ok(rec !== undefined);
    assert.equal(rec["decision"], "inject");
    assert.equal(rec["identity"], "example-bot");
    assert.equal(rec["kind"], "github-app");
    assert.equal(rec["column"], "agent");
    assert.equal(rec["owner"], "example-org");
    assert.equal(rec["repo"], "svc");
    assert.equal(rec["scope"], "write");
    assert.equal(typeof rec["verb"], "string");
    assert.equal(statSync(decisionLogPath(w.home)).mode & 0o777, 0o600);
    for (const t of ALL_TOKENS) assert.ok(!readFileSync(decisionLogPath(w.home), "utf8").includes(t));
  });
});

// ---------------------------------------------------------------------------
// I3, I4, I6–I9, T1, T4, T5: refusals and token checks
// ---------------------------------------------------------------------------

describe("repo-aegis gh: refusals never run gh", () => {
  it("I3: an agent write for an owner with only a person identity and no approval is GH_IDENTITY_WRITE_NEEDS_HUMAN", () => {
    const w = makeWorld();
    const r = run(w, ["pr", "create", "--repo", "person-only-org/x", "--title", "t", "--body", "b"], { presence: "agent" });
    // Egress may refuse an unknown destination first; both are refusals and gh must not run. Pin the identity one
    // by approving the egress side only through a private checkout of that owner.
    assert.equal(r.status, 2);
    assert.deepEqual(r.ghArgv, [], "gh ran");
    assert.deepEqual(r.taaadArgv, [], "taaad ran");
  });

  /** A private checkout of `person-only-org/x`, so egress allows the write and the identity rule is what decides. */
  function personOnlyRepo(w: World): string {
    const dir = join(w.root, "pox");
    mkdirSync(dir, { recursive: true });
    const git = (...a: string[]): void => void spawnSync("git", a, { cwd: dir, stdio: "ignore" });
    git("init", "-q", "-b", "main");
    git("remote", "add", "origin", "git@github.com:person-only-org/x.git");
    git("config", "repo-aegis.class", "private-strict");
    git("config", "repo-aegis.visibility", "private");
    return dir;
  }
  const POX_WRITE = ["pr", "create", "--repo", "person-only-org/x", "--title", "t", "--body", "b"];

  it("I3: ... named by the identity rule, with neither gh nor taaad called", () => {
    const w = makeWorld();
    const r = run(w, POX_WRITE, { presence: "agent", cwd: personOnlyRepo(w) });
    assert.equal(refusalCode(r), "GH_IDENTITY_WRITE_NEEDS_HUMAN", r.err);
    assert.equal(r.status, 2);
    assert.deepEqual(r.ghArgv, []);
    assert.deepEqual(r.taaadArgv, []);
  });

  it("I4: an approval minted for alice allows the write as alice; one with no login, one for bob and a '*' approval do not", () => {
    const w = makeWorld();
    const cwd = personOnlyRepo(w);
    const path = approvalsPath(w.home);
    const dest = { org: "person-only-org", repo: "x" };

    const withAlice = mintApproval({ target: dest, login: "alice", path });
    const ok = run(w, POX_WRITE, { presence: "agent", cwd });
    assert.equal(ok.status, 0, ok.err);
    assert.equal(ghEnv(w, mainCallNumber(ok))["GH_TOKEN"], TOKEN_ALICE);
    assert.equal(decisions(w).at(-1)?.["approvalId"], withAlice.id, "the decision log names the approval");

    for (const [label, mint] of [
      ["no login", () => mintApproval({ target: dest, path })],
      ["another login", () => mintApproval({ target: dest, login: "bob", path })],
      ["a star approval", () => mintApproval({ target: { org: "*", repo: "*" }, login: "alice", path })],
    ] as const) {
      rmSync(path, { force: true });
      mint();
      writeFileSync(join(w.stubs, "seq"), "0");
      rmSync(join(w.stubs, "gh.argv"), { force: true });
      const r = run(w, POX_WRITE, { presence: "agent", cwd });
      assert.equal(refusalCode(r), "GH_IDENTITY_WRITE_NEEDS_HUMAN", `${label}: ${r.err}`);
      assert.deepEqual(r.ghArgv, [], `${label}: gh ran`);
    }
  });

  it("I6: an agent that sets GH_TOKEN on a mapped call is refused, and nothing is minted", () => {
    const w = makeWorld();
    const r = run(w, WRITE, { presence: "agent", env: { GH_TOKEN: "x-supplied-token-0123" } });
    assert.equal(refusalCode(r), "GH_IDENTITY_TOKEN_SUPPLIED", r.err);
    assert.equal(r.status, 2);
    assert.deepEqual(r.taaadArgv, []);
    assert.deepEqual(r.ghArgv, []);
    assert.ok(!r.err.includes("x-supplied-token-0123"), "the supplied token is echoed");
  });

  it("I7: an installation of another account is refused, the token discarded and printed nowhere", () => {
    const w = makeWorld();
    writeFileSync(join(w.stubs, "mint.json"), mintJson({ installationAccount: "other-org" }));
    const r = run(w, WRITE, { presence: "agent" });
    assert.equal(refusalCode(r), "GH_IDENTITY_INSTALLATION_MISMATCH", r.err);
    assert.equal(r.status, 2);
    assert.deepEqual(mainCalls(r), []);
    assert.ok(!r.out.includes(TOKEN_BOT) && !r.err.includes(TOKEN_BOT));
  });

  it("I7: the installation account is compared case-insensitively", () => {
    const w = makeWorld();
    writeFileSync(join(w.stubs, "mint.json"), mintJson({ installationAccount: "Example-Org" }));
    assert.equal(run(w, WRITE, { presence: "agent" }).status, 0);
  });

  for (const [label, setup] of [
    ["exits non-zero", (w: World) => writeFileSync(join(w.stubs, "taaad.fail"), "")],
    ["prints nothing", (w: World) => writeFileSync(join(w.stubs, "mint.json"), "")],
    ["prints something that is not JSON", (w: World) => writeFileSync(join(w.stubs, "mint.json"), "not json at all")],
    ["names another repository", (w: World) => writeFileSync(join(w.stubs, "mint.json"), mintJson({ repositories: ["other"] }))],
    ["names two repositories", (w: World) => writeFileSync(join(w.stubs, "mint.json"), mintJson({ repositories: ["svc", "other"] }))],
    ["omits the repositories", (w: World) => writeFileSync(join(w.stubs, "mint.json"), mintJson({ repositories: undefined }))],
    ["returns wider permissions than the scope", (w: World) => writeFileSync(join(w.stubs, "mint.json"), mintJson({ permissions: { contents: "admin" } }))],
    ["returns no token", (w: World) => writeFileSync(join(w.stubs, "mint.json"), mintJson({ token: "" }))],
  ] as Array<[string, (w: World) => void]>) {
    it(`I8: taaad that ${label} is GH_IDENTITY_UNAVAILABLE and gh is not run`, () => {
      const w = makeWorld();
      setup(w);
      const r = run(w, WRITE, { presence: "agent" });
      assert.equal(refusalCode(r), "GH_IDENTITY_UNAVAILABLE", r.err);
      assert.equal(r.status, 2);
      assert.deepEqual(mainCalls(r), []);
      assert.ok(!r.err.includes(TOKEN_BOT) && !r.out.includes(TOKEN_BOT));
    });
  }

  it("I8: an org-level target for an owner with an App is GH_IDENTITY_UNAVAILABLE (mint needs a repository)", () => {
    const w = makeWorld();
    mintApproval({ target: { org: "example-org", repo: "*" }, path: approvalsPath(w.home) });
    const r = run(w, ["secret", "set", "S", "--org", "example-org", "--body", "x"], { presence: "agent" });
    assert.equal(refusalCode(r), "GH_IDENTITY_UNAVAILABLE", r.err);
    assert.deepEqual(r.taaadArgv, []);
    assert.deepEqual(mainCalls(r), []);
  });

  it("I9: a taaad first on PATH that is not the pinned one is never called; the pinned one is", () => {
    const w = makeWorld();
    writeStub(join(w.root, "fakebin", "taaad"), NEVER_STUB);
    const r = run(w, WRITE, { presence: "agent" });
    assert.equal(r.status, 0, r.err);
    assert.equal(r.taaadArgv.length, 1);
    assert.equal(existsSync(join(w.root, "never.log")), false);
  });

  it("I9: with no taaad pinned, a github-app identity is GH_BINARY_UNTRUSTED, and nothing on PATH is tried", () => {
    const w = makeWorld();
    writeStub(join(w.root, "fakebin", "taaad"), NEVER_STUB);
    const r = run(w, WRITE, { presence: "agent", taaad: null });
    assert.equal(refusalCode(r), "GH_BINARY_UNTRUSTED", r.err);
    assert.equal(existsSync(join(w.root, "never.log")), false);
    assert.deepEqual(mainCalls(r), []);
    // U7: no pin is a state `install shim` creates; the fix line is that command, and no approval covers it.
    assert.match(r.err, /repo-aegis pins taaad only at that step/);
    assert.match(r.err, /A person installs taaad v0\.6\.0 or later and re-runs `repo-aegis install shim`/);
    assert.match(r.err, /No approval covers this: an approval cannot stand in for an identity that could not be chosen or a token that could not be minted/);
  });

  it("under the real policy an untrusted gh is still refused before any mint (a non-root-owned taaad no longer is: plan §2.1, Q5)", () => {
    const w = makeWorld();
    const r = run(w, WRITE, { presence: "agent", trust: "default" });
    // The stub gh is in a temp directory, so the trusted-gh check refuses; no token is minted and gh does not run.
    assert.equal(refusalCode(r), "GH_BINARY_UNTRUSTED", r.err);
    assert.deepEqual(r.taaadArgv, []);
    assert.deepEqual(mainCalls(r), []);
    // U7: the cause, who put it there, the one fix line, and whether an approval covers it.
    assert.match(r.err, /the gh first on PATH is not in a trusted location/);
    assert.match(r.err, /repo-aegis did not put that gh there, it only refuses to trust it/);
    assert.match(r.err, /A person runs, from a terminal: repo-aegis doctor \(it names which gh is first on PATH/);
    assert.match(r.err, /No approval covers this: an approval cannot make a gh binary trustworthy/);
  });

  it("T1: a mapped person whose gh account has no token on this machine is GH_IDENTITY_UNAVAILABLE; the call and `auth switch` never run", () => {
    const w = makeWorld();
    rmSync(join(w.stubs, "token.alice"));
    const r = run(w, WRITE, { presence: "person" });
    assert.equal(refusalCode(r), "GH_IDENTITY_UNAVAILABLE", r.err);
    assert.equal(r.status, 2);
    assert.deepEqual(mainCalls(r), []);
    assert.equal(existsSync(join(w.stubs, "switched")), false);
  });

  it("T4: a token for another account in GH_TOKEN is GH_IDENTITY_TOKEN_MISMATCH even though gh would echo the environment's token", () => {
    const w = makeWorld();
    const r = run(w, WRITE, { presence: "person", env: { GH_TOKEN: TOKEN_BOB } });
    assert.equal(refusalCode(r), "GH_IDENTITY_TOKEN_MISMATCH", r.err);
    assert.deepEqual(mainCalls(r), []);
    assert.ok(!r.err.includes(TOKEN_BOB) && !r.out.includes(TOKEN_BOB), "the supplied token is echoed");
  });

  it("T4: the mapped login's own token in GH_TOKEN is accepted", () => {
    const w = makeWorld();
    const r = run(w, WRITE, { presence: "person", env: { GH_TOKEN: TOKEN_ALICE } });
    assert.equal(r.status, 0, r.err);
    assert.equal(ghEnv(w, mainCallNumber(r))["GH_TOKEN"], TOKEN_ALICE);
  });

  it("T5: GITHUB_TOKEN set alongside a mapped call is stripped; the child sees only GH_TOKEN, for the mapped account", () => {
    const w = makeWorld();
    const r = run(w, WRITE, { presence: "person", env: { GITHUB_TOKEN: TOKEN_ALICE, GH_ENTERPRISE_TOKEN: undefined } });
    assert.equal(r.status, 0, r.err);
    const env = ghEnv(w, mainCallNumber(r));
    assert.equal(env["GH_TOKEN"], TOKEN_ALICE);
    assert.equal(env["GITHUB_TOKEN"], undefined);
    assert.equal(env["GH_ENTERPRISE_TOKEN"], undefined);
    assert.equal(env["GITHUB_ENTERPRISE_TOKEN"], undefined);
    // A GITHUB_TOKEN of another account is a mismatch, not silently replaced.
    const bad = run(w, WRITE, { presence: "person", env: { GITHUB_TOKEN: TOKEN_BOB } });
    assert.equal(refusalCode(bad), "GH_IDENTITY_TOKEN_MISMATCH", bad.err);
  });

  it("T12: with no trusted gh (the stub is in a temp directory) an injecting call is GH_BINARY_UNTRUSTED and no token is fetched", () => {
    const w = makeWorld();
    const r = run(w, WRITE, { presence: "person", trust: "default" });
    assert.equal(refusalCode(r), "GH_BINARY_UNTRUSTED", r.err);
    assert.deepEqual(r.ghArgv, [], "the untrusted gh was run");
  });

  for (const v of ["GH_HOST", "GH_CONFIG_DIR", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"]) {
    it(`T15: ${v} on a mapped call is GH_IDENTITY_ENV_REDIRECT and no token is fetched`, () => {
      const w = makeWorld();
      const r = run(w, WRITE, { presence: "person", env: { [v]: "somewhere-else" } });
      assert.equal(refusalCode(r), "GH_IDENTITY_ENV_REDIRECT", r.err);
      assert.deepEqual(r.ghArgv, []);
      assert.deepEqual(r.taaadArgv, []);
    });
  }

  it("T15: a gh config with http_unix_socket is GH_IDENTITY_ENV_REDIRECT, found by asking the trusted gh, before any token", () => {
    const w = makeWorld();
    writeFileSync(join(w.stubs, "socket"), "/tmp/evil.sock\n");
    const r = run(w, WRITE, { presence: "agent" });
    assert.equal(refusalCode(r), "GH_IDENTITY_ENV_REDIRECT", r.err);
    assert.deepEqual(r.ghArgv, ["config get http_unix_socket"]);
    assert.deepEqual(r.taaadArgv, []);
  });

  it("presence that cannot be determined is GH_IDENTITY_PRESENCE_UNKNOWN for a mapped owner", () => {
    const w = makeWorld();
    const r = run(w, WRITE, { presence: "unknown" });
    assert.equal(refusalCode(r), "GH_IDENTITY_PRESENCE_UNKNOWN", r.err);
    assert.deepEqual(r.ghArgv, []);
  });

  it("T19: an agent write whose repository comes only from the cwd's remote is GH_IDENTITY_NEEDS_LITERAL_TARGET; a read is injected", () => {
    const w = makeWorld();
    const write = run(w, ["issue", "comment", "1", "--body", "b"], { presence: "agent" });
    assert.equal(refusalCode(write), "GH_IDENTITY_NEEDS_LITERAL_TARGET", write.err);
    assert.deepEqual(write.ghArgv, []);
    const read = run(w, ["pr", "view", "1"], { presence: "agent" });
    assert.equal(read.status, 0, read.err);
    assert.equal(ghEnv(w, mainCallNumber(read))["GH_TOKEN"], TOKEN_BOT);
    assert.deepEqual(read.taaadArgv, ["mint --app example-bot --repo example-org/svc --permissions read --json"]);
  });

  it("A10: with no person present `gh auth token` and `gh auth switch` are GH_AUTH_NEEDS_HUMAN, even for an unmapped owner; gh never runs", () => {
    const w = makeWorld();
    for (const args of [["auth", "token"], ["auth", "token", "--user", "alice"], ["auth", "switch", "-u", "alice"], ["auth", "status", "--show-token"]]) {
      const r = run(w, args, { presence: "agent" });
      assert.equal(refusalCode(r), "GH_AUTH_NEEDS_HUMAN", `${args.join(" ")}: ${r.err}`);
      assert.equal(r.status, 2);
    }
    assert.deepEqual(lines(join(w.stubs, "gh.argv")), []);
    // A person at a terminal is not refused.
    const person = run(w, ["auth", "status"], { presence: "person" });
    assert.equal(person.status, 0, person.err);
  });
});

// ---------------------------------------------------------------------------
// Faults, pass-through, D8
// ---------------------------------------------------------------------------

describe("repo-aegis gh: faults, pass-through and the pinned home", () => {
  it("T13: a fault between choosing and spawning on a mapped owner is GH_IDENTITY_UNAVAILABLE and gh does not run", () => {
    const w = makeWorld();
    // The decision log is where the fault is made: `state` is a file, so the record cannot be written.
    rmSync(join(w.home, "state"), { recursive: true });
    writeFileSync(join(w.home, "state"), "not a directory");
    const r = run(w, WRITE, { presence: "agent" });
    assert.equal(refusalCode(r), "GH_IDENTITY_UNAVAILABLE", r.err);
    assert.equal(r.status, 2);
    assert.deepEqual(mainCalls(r), []);
  });

  it("T14: the same kind of fault where nothing is known to be mapped keeps today's behaviour: a warning, then gh runs unchanged", () => {
    const w = makeWorld();
    const r = run(w, ["pr", "view", "1", "--repo", "plain-org/x"], { presence: "throws", plainPath: true });
    assert.equal(r.status, 0, r.err + r.out);
    assert.match(r.err, /repo-aegis gh: repo-aegis faulted while choosing a GitHub identity; proceeding/);
    assert.deepEqual(mainCalls(r), ["pr view 1 --repo plain-org/x"]);
    // Unchanged: no allowlisting, no token.
    assert.equal(ghEnv(w, 1)["GH_TOKEN"], undefined);
    assert.equal(ghEnv(w, 1)["GH_PROMPT_DISABLED"], undefined);
  });

  it("an unmapped owner runs the real gh with the caller's environment unchanged, and no decision is logged", () => {
    const w = makeWorld();
    const r = run(w, ["pr", "view", "1", "--repo", "plain-org/x"], { presence: "agent", plainPath: true, env: { MY_MARKER_VAR: "kept", HTTPS_PROXY: "http://127.0.0.1:9" } });
    assert.equal(r.status, 0, r.err);
    const env = ghEnv(w, 1);
    assert.equal(env["MY_MARKER_VAR"], "kept");
    assert.equal(env["HTTPS_PROXY"], "http://127.0.0.1:9");
    assert.equal(env["GH_TOKEN"], undefined);
    assert.deepEqual(r.taaadArgv, []);
    assert.deepEqual(decisions(w), []);
  });

  it("no registry at all: gh runs unchanged", () => {
    const w = makeWorld();
    rmSync(join(w.home, "engagements.yaml"));
    const r = run(w, READ, { presence: "agent", plainPath: true });
    assert.equal(r.status, 0, r.err);
    assert.deepEqual(mainCalls(r), [READ.join(" ")]);
  });

  it("a person at a terminal for an owner with only an agent identity runs as the active account, with a hint", () => {
    const w = makeWorld();
    const r = run(w, ["pr", "view", "1", "--repo", "agent-only-org/x"], { presence: "person" });
    assert.equal(r.status, 0, r.err);
    assert.match(r.err, /only an agent identity/);
    assert.equal(ghEnv(w, 1)["GH_TOKEN"], undefined);
    assert.deepEqual(r.taaadArgv, []);
  });

  it("T17: REPO_AEGIS_HOME and REPO_AEGIS_REGISTRY in the caller's environment do not choose the registry; the pinned home does", () => {
    const w = makeWorld();
    const other = join(w.root, "other-aegis");
    mkdirSync(other, { recursive: true });
    // A registry that maps the owner to BOB, and approvals there, as a caller could point them.
    writeFileSync(
      join(other, "engagements.yaml"),
      REGISTRY.replace("{ name: example-org, person: alice, agent: example-bot }", "{ name: example-org, person: bob }"),
    );
    const saved = { h: process.env["REPO_AEGIS_HOME"], r: process.env["REPO_AEGIS_REGISTRY"] };
    process.env["REPO_AEGIS_HOME"] = other;
    process.env["REPO_AEGIS_REGISTRY"] = join(other, "engagements.yaml");
    try {
      const r = run(w, WRITE, {
        presence: "person",
        env: { REPO_AEGIS_HOME: other, REPO_AEGIS_REGISTRY: join(other, "engagements.yaml"), REPO_AEGIS_MARKERS_DIR: other },
      });
      assert.equal(r.status, 0, r.err);
      assert.equal(ghEnv(w, mainCallNumber(r))["GH_TOKEN"], TOKEN_ALICE, "the caller's registry decided");
      assert.match(r.err, /as alice \(gh-login\)/);
      // The caller's variables are put back for an in-process caller.
      assert.equal(process.env["REPO_AEGIS_HOME"], other);
      assert.equal(process.env["REPO_AEGIS_REGISTRY"], join(other, "engagements.yaml"));
    } finally {
      if (saved.h === undefined) delete process.env["REPO_AEGIS_HOME"];
      else process.env["REPO_AEGIS_HOME"] = saved.h;
      if (saved.r === undefined) delete process.env["REPO_AEGIS_REGISTRY"];
      else process.env["REPO_AEGIS_REGISTRY"] = saved.r;
    }
  });

  it("T17: approvals are read from the pinned home only", () => {
    const w = makeWorld();
    const other = join(w.root, "other-aegis");
    mkdirSync(other, { recursive: true });
    // A login-bound approval in ANOTHER home must not cover the write.
    mintApproval({ target: { org: "person-only-org", repo: "x" }, login: "alice", path: approvalsPath(other) });
    const dir = join(w.root, "pox");
    mkdirSync(dir, { recursive: true });
    const git = (...a: string[]): void => void spawnSync("git", a, { cwd: dir, stdio: "ignore" });
    git("init", "-q", "-b", "main");
    git("remote", "add", "origin", "git@github.com:person-only-org/x.git");
    git("config", "repo-aegis.class", "private-strict");
    git("config", "repo-aegis.visibility", "private");
    const r = run(w, ["pr", "create", "--repo", "person-only-org/x", "--title", "t", "--body", "b"], {
      presence: "agent",
      cwd: dir,
      env: { REPO_AEGIS_HOME: other },
    });
    assert.equal(refusalCode(r), "GH_IDENTITY_WRITE_NEEDS_HUMAN", r.err);
  });

  it("an egress refusal is final: exit 2, the structured reason, and gh does not run", () => {
    const w = makeWorld();
    const r = run(w, ["pr", "create", "--title", "t", "--body-file", "relative/body.md"], { presence: "agent" });
    assert.equal(r.status, 2);
    assert.equal(refusalCode(r), "PAYLOAD_MODE_DEPENDENT_PATH", r.err);
    assert.deepEqual(r.ghArgv, []);
    assert.deepEqual(r.taaadArgv, []);
  });

  it("the home must be given, and absolute", () => {
    const w = makeWorld();
    const errs: string[] = [];
    const status = runGhCommand(["pr", "view", "1"], {}, { env: callerEnv(w), io: { out: () => undefined, err: t => void errs.push(t) } });
    assert.equal(status, 2);
    assert.match(errs.join(""), /USAGE/);
  });

  it("findPlainGh skips the shim's own directory and finds the next gh", () => {
    const w = makeWorld();
    mkdirSync(join(w.home, "bin"), { recursive: true });
    writeStub(join(w.home, "bin", "gh"), "#!/bin/sh\nexit 99\n");
    assert.equal(findPlainGh([join(w.home, "bin"), w.stubs].join(":"), w.home), join(w.stubs, "gh"));
    assert.equal(findPlainGh(join(w.home, "bin"), w.home), null);
  });

  it("a mapped call never runs gh without injecting a token (over presences and argv shapes)", () => {
    const w = makeWorld();
    const argvs: string[][] = [
      WRITE,
      READ,
      ["issue", "list", "--repo", "example-org/svc"],
      ["api", "repos/example-org/svc/pulls"],
      ["release", "view", "v1", "-R", "example-org/svc"],
      ["repo", "view", "example-org/svc"],
    ];
    for (const presence of ["person", "agent", "unknown"] as const) {
      for (const args of argvs) {
        rmSync(join(w.stubs, "seq"), { force: true });
        rmSync(join(w.stubs, "gh.argv"), { force: true });
        const r = run(w, args, { presence });
        const n = mainCallNumber(r);
        if (n > 0) {
          const token = ghEnv(w, n)["GH_TOKEN"];
          assert.ok(token !== undefined && ALL_TOKENS.includes(token), `${presence} ${args.join(" ")} ran gh without an identity`);
        } else {
          assert.equal(r.status === 2 || r.status === 1, true, `${presence} ${args.join(" ")}: ${r.err}`);
        }
        if (r.status === 2) assert.deepEqual(mainCalls(r), [], `${presence} ${args.join(" ")}: a refusal ran gh`);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// H1: git options and the repository's own git config, for the agent column
// ---------------------------------------------------------------------------

describe("H1: gh's git children cannot be steered by argv or by the repository's git config", () => {
  const git = (cwd: string, ...a: string[]): void => void spawnSync("git", a, { cwd, stdio: "ignore" });

  for (const args of [
    ["repo", "clone", "example-org/x", "--", "-c", "core.hooksPath=/tmp/h"],
    ["repo", "clone", "example-org/x", "--", "--template=/tmp/t"],
    ["repo", "clone", "example-org/x", "--template=/tmp/t"],
    ["repo", "clone", "example-org/x", "-c", "core.fsmonitor=/tmp/f"],
    ["repo", "fork", "example-org/x", "--clone", "--", "--template=/tmp/t"],
  ]) {
    it(`an agent's gh ${args.join(" ")} never runs gh`, () => {
      const w = makeWorld();
      // A person's approval for the owner lets egress (rule g) through, so the identity rule is what decides.
      mintApproval({ target: { org: "example-org", repo: "*" }, path: approvalsPath(w.home) });
      const r = run(w, args, { presence: "agent" });
      assert.equal(refusalCode(r), "GH_IDENTITY_ARG_UNSAFE", r.err);
      assert.equal(r.status, 2);
      assert.deepEqual(r.ghArgv, [], "gh ran");
      assert.deepEqual(r.taaadArgv, [], "a token was minted");
    });
  }

  for (const [label, key, value] of [
    ["core.hooksPath", "core.hooksPath", "/tmp/h"],
    ["core.fsmonitor", "core.fsmonitor", "/tmp/fsmon"],
    ["core.sshCommand", "core.sshCommand", "/tmp/ssh"],
    ["a url insteadOf rewrite", "url.https://example.net/.insteadOf", "https://github.com/"],
    ["a repo-local credential helper", "credential.helper", "!/tmp/helper"],
    ["http.proxy", "http.proxy", "http://127.0.0.1:9"],
  ] as Array<[string, string, string]>) {
    it(`a repo-local ${label} refuses an agent's gh pr checkout, before any token is minted`, () => {
      const w = makeWorld();
      git(w.repo, "config", key, value);
      const r = run(w, ["pr", "checkout", "1", "--repo", "example-org/svc"], { presence: "agent" });
      assert.equal(refusalCode(r), "GH_IDENTITY_ARG_UNSAFE", r.err);
      assert.deepEqual(r.ghArgv, []);
      assert.deepEqual(r.taaadArgv, []);
    });
  }

  it("the same configuration does not stop a verb that spawns no git, or a person at a terminal", () => {
    const w = makeWorld();
    git(w.repo, "config", "core.hooksPath", "/tmp/h");
    assert.equal(run(w, READ, { presence: "agent" }).status, 0, "pr view spawns no git");
    const person = run(w, ["pr", "checkout", "1", "--repo", "example-org/svc"], { presence: "person" });
    assert.equal(person.status, 0, person.err);
  });

  it("a harmless repo-local configuration (fsmonitor off, a benign key) does not refuse pr checkout", () => {
    const w = makeWorld();
    git(w.repo, "config", "core.fsmonitor", "false");
    git(w.repo, "config", "user.name", "alice");
    const r = run(w, ["pr", "checkout", "1", "--repo", "example-org/svc"], { presence: "agent" });
    assert.equal(r.status, 0, r.err);
    assert.equal(ghEnv(w, mainCallNumber(r))["GH_TOKEN"], TOKEN_BOT);
  });

  it("pr create, repo sync and issue develop --checkout are pre-flighted too; a caller's proxy variable is not a violation (the child's environment is allowlisted)", () => {
    const w = makeWorld();
    git(w.repo, "config", "core.hooksPath", "/tmp/h");
    mintApproval({ target: { org: "example-org", repo: "*" }, path: approvalsPath(w.home) });
    for (const args of [
      WRITE,
      ["repo", "sync", "--repo", "example-org/svc"],
      ["issue", "develop", "1", "--checkout", "--repo", "example-org/svc"],
    ]) {
      const r = run(w, args, { presence: "agent" });
      assert.equal(refusalCode(r), "GH_IDENTITY_ARG_UNSAFE", `${args.join(" ")}: ${r.err}`);
      assert.deepEqual(r.ghArgv, []);
    }
    const w2 = makeWorld();
    const ok = run(w2, ["pr", "checkout", "1", "--repo", "example-org/svc"], { presence: "agent", env: { HTTPS_PROXY: "http://127.0.0.1:9" } });
    assert.equal(ok.status, 0, ok.err);
  });
});

// ---------------------------------------------------------------------------
// Phase U, U1: repo-aegis's own hooks directory is not a steering setting
// ---------------------------------------------------------------------------

describe("U1: a repo-local core.hooksPath that is repo-aegis's own pinned hooks directory is accepted", () => {
  const git = (cwd: string, ...a: string[]): void => void spawnSync("git", a, { cwd, stdio: "ignore" });
  const CHECKOUT = ["pr", "checkout", "1", "--repo", "example-org/svc"];

  /** The directory `install hooks` writes under the pinned home. */
  function ownHooks(w: World): string {
    const dir = join(w.home, "hooks");
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  it("is accepted: the call runs as the App (refused before this change)", () => {
    const w = makeWorld();
    git(w.repo, "config", "core.hooksPath", ownHooks(w));
    const r = run(w, CHECKOUT, { presence: "agent" });
    assert.equal(refusalCode(r), undefined, r.err);
    assert.equal(r.status, 0, r.err);
    assert.equal(ghEnv(w, mainCallNumber(r))["GH_TOKEN"], TOKEN_BOT);
  });

  it("is accepted for pr create too (the observed failure), and by realpath: through a symlink and with a trailing slash", () => {
    const w = makeWorld();
    const dir = ownHooks(w);
    const link = join(w.root, "hooks-link");
    symlinkSync(dir, link);
    for (const value of [link, `${dir}/`, join(dir, "..", "hooks")]) {
      git(w.repo, "config", "core.hooksPath", value);
      const r = run(w, WRITE, { presence: "agent" });
      assert.equal(r.status, 0, `${value}: ${r.err}`);
      assert.equal(refusalCode(r), undefined, `${value}: ${r.err}`);
    }
  });

  it("another hooks directory still refuses, even one that exists and is next to the pinned one", () => {
    const w = makeWorld();
    ownHooks(w);
    const other = join(w.home, "hooks-other");
    mkdirSync(other, { recursive: true });
    for (const value of [other, "/tmp/h", join(w.root, "elsewhere-hooks"), join(w.home, "hooks", "sub")]) {
      git(w.repo, "config", "core.hooksPath", value);
      const r = run(w, CHECKOUT, { presence: "agent" });
      assert.equal(refusalCode(r), "GH_IDENTITY_ARG_UNSAFE", `${value}: ${r.err}`);
      assert.deepEqual(r.ghArgv, [], `${value}: gh ran`);
      assert.deepEqual(r.taaadArgv, [], `${value}: a token was minted`);
    }
  });

  it("a relative value still refuses, even one that would resolve to the hooks directory from the home", () => {
    const w = makeWorld();
    ownHooks(w);
    for (const value of ["hooks", "../aegis/hooks", ".git/hooks"]) {
      git(w.repo, "config", "core.hooksPath", value);
      const r = run(w, CHECKOUT, { presence: "agent" });
      assert.equal(refusalCode(r), "GH_IDENTITY_ARG_UNSAFE", `${value}: ${r.err}`);
    }
  });

  it("another home's hooks directory is not the pinned one", () => {
    const w = makeWorld();
    const w2 = makeWorld();
    git(w.repo, "config", "core.hooksPath", ownHooks(w2));
    assert.equal(refusalCode(run(w, CHECKOUT, { presence: "agent" })), "GH_IDENTITY_ARG_UNSAFE");
  });

  it("every other key keeps refusing: the own hooks path does not excuse core.sshCommand, core.fsmonitor or a url rewrite", () => {
    for (const [key, value] of [
      ["core.sshCommand", "/tmp/ssh"],
      ["core.fsmonitor", "/tmp/fsmon"],
      ["url.https://example.net/.insteadOf", "https://github.com/"],
      ["credential.helper", "!/tmp/helper"],
    ] as Array<[string, string]>) {
      const w = makeWorld();
      git(w.repo, "config", "core.hooksPath", ownHooks(w));
      git(w.repo, "config", key, value);
      const r = run(w, CHECKOUT, { presence: "agent" });
      assert.equal(refusalCode(r), "GH_IDENTITY_ARG_UNSAFE", `${key}: ${r.err}`);
      assert.deepEqual(r.taaadArgv, [], `${key}: a token was minted`);
    }
  });

  it("two local values, one of them foreign, refuse (git reads the last; the check judges each)", () => {
    const w = makeWorld();
    git(w.repo, "config", "core.hooksPath", ownHooks(w));
    git(w.repo, "config", "--add", "core.hooksPath", "/tmp/h");
    assert.equal(refusalCode(run(w, CHECKOUT, { presence: "agent" })), "GH_IDENTITY_ARG_UNSAFE");
  });
});

// ---------------------------------------------------------------------------
// Phase U, U5 (gh half): an account-bound approval covers GH_IDENTITY_ARG_UNSAFE for a git setting
// ---------------------------------------------------------------------------

describe("U5: an account-bound approval covers a repository git setting", () => {
  const git = (cwd: string, ...a: string[]): void => void spawnSync("git", a, { cwd, stdio: "ignore" });
  const CHECKOUT = ["pr", "checkout", "1", "--repo", "example-org/svc"];
  const dest = { org: "example-org", repo: "svc" };

  function worldWithHooksPath(): World {
    const w = makeWorld();
    git(w.repo, "config", "core.hooksPath", "/tmp/h");
    return w;
  }

  it("a live <org>/<repo> approval with a login lets the call run: one stderr line, a decision record naming the approval, the App's token", () => {
    const w = worldWithHooksPath();
    const a = mintApproval({ target: dest, login: "alice", path: approvalsPath(w.home) });
    for (const args of [CHECKOUT, WRITE]) {
      const r = run(w, args, { presence: "agent" });
      assert.equal(r.status, 0, `${args.join(" ")}: ${r.err}`);
      assert.equal(refusalCode(r), undefined, r.err);
      assert.equal(ghEnv(w, mainCallNumber(r))["GH_TOKEN"], TOKEN_BOT);
      const line = r.err.split("\n").filter(l => l.includes(`approval ${a.id}`));
      assert.deepEqual(line, [`repo-aegis: approval ${a.id} covers core.hooksPath (local scope) for example-org/svc`]);
      rmSync(join(w.stubs, "seq"), { force: true });
      rmSync(join(w.stubs, "gh.argv"), { force: true });
    }
    const last = decisions(w).at(-1)!;
    assert.equal(last["decision"], "inject");
    assert.equal(last["coveredBy"], a.id);
    assert.equal(last["covers"], "core.hooksPath (local scope)");
  });

  it("an <org>/* approval with a login covers every repository of the owner", () => {
    const w = worldWithHooksPath();
    const a = mintApproval({ target: { org: "example-org", repo: "*" }, login: "alice", path: approvalsPath(w.home) });
    const r = run(w, CHECKOUT, { presence: "agent" });
    assert.equal(r.status, 0, r.err);
    assert.match(r.err, new RegExp(`approval ${a.id} covers core\\.hooksPath`));
  });

  it("when the audit log is on, the use is recorded there too, with ids and names only", () => {
    const w = worldWithHooksPath();
    writeFileSync(join(w.home, "state", "audit-log.json"), JSON.stringify({ enabled: true }));
    const a = mintApproval({ target: dest, login: "alice", path: approvalsPath(w.home) });
    const r = run(w, CHECKOUT, { presence: "agent" });
    assert.equal(r.status, 0, r.err);
    const logFiles = readdirSync(join(w.home, "state")).filter(f => f.startsWith("audit") && f !== "audit-log.json");
    const text = logFiles.map(f => readFileSync(join(w.home, "state", f), "utf8")).join("\n");
    assert.match(text, /"action":"egress-approval-use"/);
    assert.ok(text.includes(a.id), text);
    for (const t of ALL_TOKENS) assert.ok(!text.includes(t));
  });

  it("an approval with no login, a '*' approval, one for another repository or owner, and an expired one do not cover it", () => {
    const w = worldWithHooksPath();
    const path = approvalsPath(w.home);
    const longAgo = new Date(Date.now() - 3 * 3600_000);
    for (const [label, mint] of [
      ["no login", () => mintApproval({ target: dest, path })],
      ["a star approval with a login", () => mintApproval({ target: { org: "*", repo: "*" }, login: "alice", path })],
      ["another repository", () => mintApproval({ target: { org: "example-org", repo: "other" }, login: "alice", path })],
      ["another owner", () => mintApproval({ target: { org: "other-org", repo: "*" }, login: "alice", path })],
      ["a ref-limited approval", () => mintApproval({ target: dest, login: "alice", ref: "main", path })],
      ["an expired approval", () => mintApproval({ target: dest, login: "alice", path, now: longAgo, ttlMs: 3600_000 })],
    ] as const) {
      rmSync(path, { force: true });
      mint();
      rmSync(join(w.stubs, "seq"), { force: true });
      rmSync(join(w.stubs, "gh.argv"), { force: true });
      const r = run(w, CHECKOUT, { presence: "agent" });
      assert.equal(refusalCode(r), "GH_IDENTITY_ARG_UNSAFE", `${label}: ${r.err}`);
      assert.equal(r.status, 2, label);
      assert.deepEqual(r.ghArgv, [], `${label}: gh ran`);
      assert.deepEqual(r.taaadArgv, [], `${label}: a token was minted`);
    }
  });

  it("with no approval the refusal says an account-bound approval from a terminal covers it", () => {
    const w = worldWithHooksPath();
    const r = run(w, CHECKOUT, { presence: "agent" });
    assert.equal(refusalCode(r), "GH_IDENTITY_ARG_UNSAFE");
    assert.match(r.err, /account-bound approval/);
    assert.match(r.err, /repo-aegis approve <owner>\/<repo>/);
  });

  it("U7: the setting refusal names the setting, says repo-aegis did not set it, gives the unset line, and keeps the trailer", () => {
    const w = worldWithHooksPath();
    const r = run(w, CHECKOUT, { presence: "agent" });
    assert.equal(refusalCode(r), "GH_IDENTITY_ARG_UNSAFE");
    assert.match(r.err, /core\.hooksPath is set in local scope/);
    assert.match(r.err, /repo-aegis did not set it \(its own hooks directory, written by `install hooks --local`, is exempt\)/);
    assert.match(r.err, /A person runs, from a terminal: git config --local --unset-all core\.hooksPath \(it only stops that setting applying to this checkout/);
    assert.match(r.err, /A person runs, from a terminal: repo-aegis approve <owner>\/<repo> \(account-bound: it covers this setting/);
    assert.match(r.err, /Agents: do not run that yourself, retry or reroute; report this to your human\./);
  });

  it("the approval covers only the git setting: an unsafe ARGUMENT (an editor option) still refuses", () => {
    const w = makeWorld();
    mintApproval({ target: dest, login: "alice", path: approvalsPath(w.home) });
    const r = run(w, ["pr", "create", "--editor", "--repo", "example-org/svc"], { presence: "agent" });
    assert.equal(refusalCode(r), "GH_IDENTITY_ARG_UNSAFE", r.err);
    assert.deepEqual(r.ghArgv, []);
  });
});

// ---------------------------------------------------------------------------
// Phase U, U4: a READ whose identity cannot be produced runs as the active account
// ---------------------------------------------------------------------------

describe("U4: a read whose identity cannot be produced runs as the active gh account, with one warning", () => {
  /** The single stderr line naming the code, for a call that went through the fallback. */
  function warning(r: Ran): string {
    const l = r.err.split("\n").filter(x => x.includes("GH_IDENTITY_UNAVAILABLE"));
    assert.equal(l.length, 1, r.err);
    return l[0]!;
  }

  it("a failed mint: the read runs plain (no token), the warning names the code and the reason", () => {
    const w = makeWorld();
    writeFileSync(join(w.stubs, "taaad.fail"), "");
    const r = run(w, READ, { presence: "agent", plainPath: true });
    assert.equal(r.status, 0, r.err);
    assert.equal(refusalCode(r), undefined);
    assert.match(warning(r), /^repo-aegis gh: GH_IDENTITY_UNAVAILABLE: .+, so this read runs as the active gh account; proceeding$/);
    assert.deepEqual(mainCalls(r), [READ.join(" ")]);
    assert.equal(ghEnv(w, mainCallNumber(r))["GH_TOKEN"], undefined, "the read ran with a token");
    assert.equal(ghEnv(w, mainCallNumber(r))["GH_PROMPT_DISABLED"], undefined, "the read ran with the allowlisted environment");
    assert.ok(!r.err.includes(TOKEN_BOT) && !r.out.includes(TOKEN_BOT));
    assert.equal(decisions(w).at(-1)?.["decision"], "fallback");
  });

  it("every unusable mint answer is the same for a read: no output, not JSON, another repository, wider permissions, no token", () => {
    for (const setup of [
      (w: World) => writeFileSync(join(w.stubs, "mint.read.json"), ""),
      (w: World) => writeFileSync(join(w.stubs, "mint.read.json"), "not json at all"),
      (w: World) => writeFileSync(join(w.stubs, "mint.read.json"), mintJson({ repositories: ["other"] })),
      (w: World) => writeFileSync(join(w.stubs, "mint.read.json"), mintJson({ permissions: { contents: "admin" } })),
      (w: World) => writeFileSync(join(w.stubs, "mint.read.json"), mintJson({ token: "" })),
    ]) {
      const w = makeWorld();
      setup(w);
      const r = run(w, READ, { presence: "agent", plainPath: true });
      assert.equal(r.status, 0, r.err);
      warning(r);
      assert.equal(ghEnv(w, mainCallNumber(r))["GH_TOKEN"], undefined);
      assert.ok(!r.err.includes(TOKEN_BOT));
    }
  });

  it("the same failed mint for a WRITE still refuses, and gh does not run", () => {
    const w = makeWorld();
    writeFileSync(join(w.stubs, "taaad.fail"), "");
    const r = run(w, WRITE, { presence: "agent" });
    assert.equal(refusalCode(r), "GH_IDENTITY_UNAVAILABLE", r.err);
    assert.equal(r.status, 2);
    assert.deepEqual(mainCalls(r), []);
  });

  it("a finding about the identity itself is not 'unavailable': an installation of another account still refuses a read", () => {
    const w = makeWorld();
    writeFileSync(join(w.stubs, "mint.read.json"), mintJson({ installationAccount: "other-org" }));
    const r = run(w, READ, { presence: "agent" });
    assert.equal(refusalCode(r), "GH_IDENTITY_INSTALLATION_MISMATCH", r.err);
    assert.deepEqual(mainCalls(r), []);
  });

  it("with no taaad pinned, a read is still GH_BINARY_UNTRUSTED (only the unavailable code falls through)", () => {
    const w = makeWorld();
    const r = run(w, READ, { presence: "agent", taaad: null });
    assert.equal(refusalCode(r), "GH_BINARY_UNTRUSTED", r.err);
    assert.deepEqual(mainCalls(r), []);
  });

  it("a person's read whose mapped account has no token runs as the active account too; the same call as a write still refuses (T1)", () => {
    const w = makeWorld();
    rmSync(join(w.stubs, "token.alice"));
    const read = run(w, READ, { presence: "person", plainPath: true });
    assert.equal(read.status, 0, read.err);
    assert.match(warning(read), /the mapped GitHub account has no usable token on this machine, so this read runs as the active gh account/);
    assert.equal(existsSync(join(w.stubs, "switched")), false, "gh auth switch ran");
    const write = run(w, WRITE, { presence: "person" });
    assert.equal(refusalCode(write), "GH_IDENTITY_UNAVAILABLE", write.err);
  });

  it("a fault after a token was minted: the read runs plain and the token is not handed to it; the write refuses (T13)", () => {
    const w = makeWorld();
    // The decision log is where the fault is made: `state` is a file, so the record cannot be written.
    rmSync(join(w.home, "state"), { recursive: true });
    writeFileSync(join(w.home, "state"), "not a directory");
    const read = run(w, READ, { presence: "agent", plainPath: true });
    assert.equal(read.status, 0, read.err);
    assert.ok(read.taaadArgv.length > 0, "a token was minted before the fault");
    assert.match(warning(read), /^repo-aegis gh: GH_IDENTITY_UNAVAILABLE: repo-aegis faulted while preparing the GitHub identity for a mapped owner, so this read runs as the active gh account; proceeding$/);
    assert.equal(ghEnv(w, mainCallNumber(read))["GH_TOKEN"], undefined, "the minted token reached the read");
    const write = run(w, WRITE, { presence: "agent" });
    assert.equal(refusalCode(write), "GH_IDENTITY_UNAVAILABLE", write.err);
  });

  it("a read whose egress parse faulted is judged as a write, so it still refuses (M5)", () => {
    const w = makeWorld();
    writeFileSync(join(w.stubs, "taaad.fail"), "");
    const r = run(w, READ, { presence: "agent", evaluate: () => ({ kind: "fault", message: "the parser exploded" }) });
    assert.equal(refusalCode(r), "GH_IDENTITY_UNAVAILABLE", r.err);
    assert.deepEqual(r.ghArgv, []);
  });
});

// ---------------------------------------------------------------------------
// M1, M5: an unreadable or missing registry, and a fault in the egress parse
// ---------------------------------------------------------------------------

describe("M1: verbs that read tokens are refused without a person whatever the registry", () => {
  it("a missing registry: `gh auth token` is GH_AUTH_NEEDS_HUMAN for an agent, and runs for a person", () => {
    const w = makeWorld();
    rmSync(join(w.home, "engagements.yaml"));
    const r = run(w, ["auth", "token"], { presence: "agent" });
    assert.equal(refusalCode(r), "GH_AUTH_NEEDS_HUMAN", r.err);
    assert.deepEqual(r.ghArgv, []);
    assert.equal(run(w, ["auth", "token", "--user", "alice"], { presence: "person", plainPath: true }).status, 0);
  });

  it("an unreadable registry: `gh auth token` is GH_AUTH_NEEDS_HUMAN for an agent", () => {
    const w = makeWorld();
    writeFileSync(join(w.home, "engagements.yaml"), "schemaVersion: 3\nidentities: [this is not valid\n");
    const r = run(w, ["auth", "token"], { presence: "agent" });
    assert.equal(refusalCode(r), "GH_AUTH_NEEDS_HUMAN", r.err);
    assert.deepEqual(r.ghArgv, []);
  });

  it("an unreadable registry: an agent WRITE naming an owner (literal, GH_REPO or the cwd) is refused, and gh does not run", () => {
    const w = makeWorld();
    writeFileSync(join(w.home, "engagements.yaml"), "schemaVersion: 3\nidentities: [this is not valid\n");
    for (const [args, env] of [
      [WRITE, {}],
      [["pr", "comment", "1", "--body", "b"], { GH_REPO: "plain-org/x" }],
      [["pr", "comment", "1", "--body", "b"], {}], // the owner comes from the cwd's remote
    ] as Array<[string[], Record<string, string>]>) {
      const r = run(w, args, { presence: "agent", env });
      // Rule h (egress) refuses a write to an owner it cannot vouch for before the identity decision is made.
      assert.ok(["UNREGISTERED_OWNER_EGRESS", "GH_IDENTITY_UNAVAILABLE"].includes(refusalCode(r) ?? ""), `${args.join(" ")} ${JSON.stringify(env)}: ${r.err}`);
      assert.equal(r.status, 2);
      assert.deepEqual(r.ghArgv, []);
    }
  });

  // U4: the same three shapes as READS no longer stop; they run as the active account with one warning line.
  it("U4: an unreadable registry: an agent READ naming an owner (literal, GH_REPO or the cwd) runs as the active account, with one warning", () => {
    const w = makeWorld();
    writeFileSync(join(w.home, "engagements.yaml"), "schemaVersion: 3\nidentities: [this is not valid\n");
    for (const [args, env] of [
      [READ, {}],
      [["pr", "view", "1"], { GH_REPO: "plain-org/x" }],
      [["pr", "view", "1"], {}], // the owner comes from the cwd's remote
    ] as Array<[string[], Record<string, string>]>) {
      const r = run(w, args, { presence: "agent", env, plainPath: true });
      assert.equal(r.status, 0, `${args.join(" ")} ${JSON.stringify(env)}: ${r.err}`);
      assert.equal(refusalCode(r), undefined);
      const warn = r.err.split("\n").filter(l => l.includes("GH_IDENTITY_UNAVAILABLE"));
      assert.equal(warn.length, 1, r.err);
      assert.match(warn[0]!, /^repo-aegis gh: GH_IDENTITY_UNAVAILABLE: the registry in the pinned home could not be read.*so this read runs as the active gh account; proceeding$/);
    }
  });

  it("an unreadable registry: a call that names no owner still runs for an agent, and a person's call warns and runs", () => {
    const w = makeWorld();
    writeFileSync(join(w.home, "engagements.yaml"), "schemaVersion: 3\nidentities: [this is not valid\n");
    const none = run(w, ["api", "user"], { presence: "agent", plainPath: true });
    assert.equal(none.status, 0, none.err);
    const person = run(w, READ, { presence: "person", plainPath: true });
    assert.equal(person.status, 0, person.err);
    assert.match(person.err, /registry could not be read/);
    assert.deepEqual(mainCalls(person), ["api user", READ.join(" ")]);
  });
});

describe("M5: a fault in the egress parse on a mapped owner", () => {
  const fault: GhCommandDeps["evaluate"] = () => ({ kind: "fault", message: "the parser exploded" });

  it("is GH_IDENTITY_UNAVAILABLE for an agent, and gh is not run", () => {
    const w = makeWorld();
    const r = run(w, READ, { presence: "agent", evaluate: fault });
    assert.equal(refusalCode(r), "GH_IDENTITY_UNAVAILABLE", r.err);
    assert.equal(r.status, 2);
    assert.deepEqual(r.ghArgv, []);
    assert.deepEqual(r.taaadArgv, []);
  });

  it("with an unmapped owner, or a person present, keeps warn-and-run", () => {
    const w = makeWorld();
    const unmapped = run(w, ["pr", "view", "1", "--repo", "plain-org/x"], { presence: "agent", evaluate: fault, plainPath: true });
    assert.equal(unmapped.status, 0, unmapped.err);
    assert.match(unmapped.err, /the egress decision failed \(the parser exploded\); proceeding/);
    const person = run(w, READ, { presence: "person", evaluate: fault });
    assert.equal(person.status, 0, person.err);
    assert.match(person.err, /proceeding/);
  });
});

// ---------------------------------------------------------------------------
// I16 / T11: the token is never anywhere but the gh child's environment
// ---------------------------------------------------------------------------

/** Every regular file under `dir` except the ones that are ALLOWED to hold a token: the gh stub's environment dumps and the stubs' own inputs. */
function filesThatMustNotHoldATokenIn(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) {
        const b = basename(p);
        if (/^gh\.\d+\.env$/.test(b) || /^mint(\.read)?\.json$/.test(b) || /^token\./.test(b)) continue;
        out.push(p);
      }
    }
  };
  walk(dir);
  return out;
}

describe("I16: the token never appears except in the gh child's environment", () => {
  const HOSTILE: Record<string, string | undefined> = {};

  function hostile(w: World): Record<string, string | undefined> {
    writeFileSync(join(w.root, "never", "bashenv"), `env > "${join(w.root, "bashenv.out")}"\n`);
    return {
      ...HOSTILE,
      GH_PAGER: join(w.root, "never", "pager"),
      GH_FORCE_TTY: "1",
      GH_EDITOR: join(w.root, "never", "editor"),
      EDITOR: join(w.root, "never", "editor"),
      HTTPS_PROXY: `file://${join(w.root, "proxy.sink")}`,
      BASH_ENV: join(w.root, "never", "bashenv"),
      SHELLOPTS: "xtrace",
    };
  }

  for (const [label, presence, args, token] of [
    ["github-app (agent column)", "agent", WRITE, TOKEN_BOT],
    ["gh-login (person column)", "person", WRITE, TOKEN_ALICE],
    ["gh-login read by an agent", "agent", ["pr", "view", "1", "--repo", "person-only-org/x"], TOKEN_ALICE],
  ] as Array<[string, Presence, string[], string]>) {
    it(`${label}: nothing but the gh stub's environment holds the token`, () => {
      const w = makeWorld();
      const r = run(w, args, { presence, env: hostile(w) });
      assert.equal(r.status, 0, r.err);
      // Positive control: the child did get it.
      assert.equal(ghEnv(w, mainCallNumber(r))["GH_TOKEN"], token);
      // stdout and stderr of the whole command, including what the children wrote.
      assert.ok(!r.out.includes(token), "stdout");
      assert.ok(!r.err.includes(token), "stderr");
      // The argv of every process (the stubs record theirs).
      for (const l of [...r.ghArgv, ...r.taaadArgv]) assert.ok(!l.includes(token), `argv: ${l}`);
      // The decision log, and every other file any process wrote: a pager, editor, proxy sink, BASH_ENV output.
      for (const f of filesThatMustNotHoldATokenIn(w.root)) {
        const text = readFileSync(f, "utf8");
        for (const t of ALL_TOKENS) assert.ok(!text.includes(t), `${t} found in ${f}`);
      }
      assert.equal(existsSync(join(w.root, "never.log")), false, "a pager, editor or fake bash ran");
      assert.equal(existsSync(join(w.root, "bashenv.out")), false, "BASH_ENV was sourced by a child");
      assert.equal(existsSync(join(w.root, "proxy.sink")), false, "the proxy was told the token");
    });
  }

  it("the audit log, when enabled, holds no token either (the approval-use record names ids only)", () => {
    const w = makeWorld();
    writeFileSync(join(w.home, "state", "audit-log.json"), JSON.stringify({ enabled: true }));
    const r = run(w, WRITE, { presence: "agent", env: hostile(w) });
    assert.equal(r.status, 0, r.err);
    for (const f of filesThatMustNotHoldATokenIn(w.home)) {
      const text = readFileSync(f, "utf8");
      for (const t of ALL_TOKENS) assert.ok(!text.includes(t), `${t} found in ${f}`);
    }
  });

  it("a refusal prints no token either: a mismatch, an installation mismatch and an unavailable mint", () => {
    const w = makeWorld();
    const mismatch = run(w, WRITE, { presence: "person", env: { GH_TOKEN: TOKEN_BOB } });
    assert.equal(refusalCode(mismatch), "GH_IDENTITY_TOKEN_MISMATCH");
    writeFileSync(join(w.stubs, "mint.json"), mintJson({ installationAccount: "other-org" }));
    const inst = run(w, WRITE, { presence: "agent" });
    assert.equal(refusalCode(inst), "GH_IDENTITY_INSTALLATION_MISMATCH");
    for (const r of [mismatch, inst]) for (const t of ALL_TOKENS) assert.ok(!r.err.includes(t) && !r.out.includes(t));
    for (const f of filesThatMustNotHoldATokenIn(w.home)) {
      for (const t of ALL_TOKENS) assert.ok(!readFileSync(f, "utf8").includes(t));
    }
  });
});

// ---------------------------------------------------------------------------
// The pure checks on taaad's answer
// ---------------------------------------------------------------------------

describe("validateMintOutput (the shared check on taaad's answer)", () => {
  const target = { owner: "example-org", repo: "svc" };
  const ok = (raw: string, scope: "read" | "write" | "contents-write" = "write"): boolean => {
    try {
      validateMintOutput(raw, { ...target, scope });
      return true;
    } catch (err) {
      assert.ok(err instanceof MintError);
      return false;
    }
  };

  it("accepts an exact answer, and the owner/repo form of the repository", () => {
    assert.equal(ok(mintJson()), true);
    assert.equal(ok(mintJson({ repositories: ["example-org/svc"] })), true);
    assert.equal(ok(mintJson({ repositories: ["SVC"] })), true);
  });

  it("refuses a repository list that is not exactly the one repository, and a missing one", () => {
    for (const repositories of [[], ["svc", "x"], ["x"], "svc", null, undefined, [3]]) {
      assert.equal(ok(mintJson({ repositories })), false, JSON.stringify(repositories));
    }
  });

  it("scopes: read allows any key at read level only (taaad plan 0004); contents-write only metadata and contents; write never admin", () => {
    const perms = (permissions: unknown): string => mintJson({ permissions });
    // taaad 0.6.0's fixed read class still passes.
    assert.equal(ok(perms({ metadata: "read", contents: "read", pull_requests: "read", issues: "read" }), "read"), true);
    // taaad ≥ 0.7.0's derived read class: every granted key at read.
    assert.equal(ok(perms({ metadata: "read", security_events: "read", actions: "read" }), "read"), true);
    assert.equal(ok(perms({ actions: "read" }), "read"), true);
    // Never a write or admin level under read, whatever the key.
    assert.equal(ok(perms({ contents: "write" }), "read"), false);
    assert.equal(ok(perms({ metadata: "read", security_events: "write" }), "read"), false);
    assert.equal(ok(perms({ metadata: "read", administration: "admin" }), "read"), false);
    assert.equal(ok(perms({}), "read"), false, "empty");
    assert.equal(ok(perms({ metadata: "read", contents: "write" }), "contents-write"), true);
    assert.equal(ok(perms({ metadata: "write" }), "contents-write"), false);
    assert.equal(ok(perms({ pull_requests: "read" }), "contents-write"), false);
    assert.equal(ok(perms({ actions: "write", contents: "write", issues: "read" }), "write"), true);
    assert.equal(ok(perms({ contents: "admin" }), "write"), false);
    assert.equal(ok(perms(null), "write"), false);
    assert.equal(ok(perms(["contents"]), "write"), false);
  });

  it("property: under read, a permissions map passes iff it is non-empty and every value is read (seeded)", () => {
    const keys = ["metadata", "contents", "pull_requests", "issues", "actions", "security_events", "checks", "administration"];
    const levels = ["read", "write", "admin", "none", "", "READ"];
    let seed = 0x5eed_0004;
    const next = (n: number): number => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      return seed % n;
    };
    for (let i = 0; i < 500; i++) {
      const map: Record<string, string> = {};
      const size = next(5);
      for (let j = 0; j < size; j++) map[keys[next(keys.length)]!] = levels[next(levels.length)]!;
      const expected = Object.keys(map).length > 0 && Object.values(map).every(v => v === "read");
      assert.equal(ok(mintJson({ permissions: map }), "read"), expected, JSON.stringify(map));
    }
  });

  it("an installation of another account is its own failure kind, case-insensitively matched", () => {
    assert.throws(
      () => validateMintOutput(mintJson({ installationAccount: "other" }), { ...target, scope: "write" }),
      (e: unknown) => e instanceof MintError && e.kind === "installation-mismatch",
    );
    assert.equal(ok(mintJson({ installationAccount: "EXAMPLE-ORG" })), true);
  });
});

// ---------------------------------------------------------------------------
// Subprocess: no seams, no TTY. What must hold for a real caller.
// ---------------------------------------------------------------------------

describe("repo-aegis gh (subprocess, no test seams)", { skip: cliBuilt() ? false : "CLI not built" }, () => {
  function cli(w: World, args: string[], env: Record<string, string> = {}): { status: number | null; stdout: string; stderr: string } {
    const childEnv: NodeJS.ProcessEnv = {
      PATH: [w.stubs, process.env["PATH"] ?? ""].join(":"),
      HOME: process.env["HOME"] ?? "",
      REPO_AEGIS_VISIBILITY_LOOKUP: "0",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      ...env,
    };
    const r = spawnSync(process.execPath, [cliPath, "gh", "--home", w.home, "--", ...args], { cwd: w.repo, env: childEnv, encoding: "utf8" });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  }

  it("an unmapped read passes through: gh runs with the caller's argv and environment, and its output is untouched", () => {
    const w = makeWorld();
    const r = cli(w, ["pr", "view", "1", "--repo", "plain-org/x"], { SOME_VAR: "kept" });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, "gh ran: pr view 1 --repo plain-org/x\n");
    assert.equal(ghEnv(w, 1)["SOME_VAR"], "kept");
  });

  it("a mapped call from a subprocess (no TTY: an agent) with an untrusted stub gh is refused, and gh never runs", () => {
    const w = makeWorld();
    const r = cli(w, WRITE);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /GH_BINARY_UNTRUSTED/);
    assert.deepEqual(lines(join(w.stubs, "gh.argv")), []);
  });

  it("`gh auth token` from a subprocess (no TTY) is GH_AUTH_NEEDS_HUMAN, whatever is mapped", () => {
    const w = makeWorld();
    const r = cli(w, ["auth", "token"]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /GH_AUTH_NEEDS_HUMAN/);
    assert.deepEqual(lines(join(w.stubs, "gh.argv")), []);
  });

  it("an egress refusal exits 2 with the structured reason on stderr and gh never runs", () => {
    const w = makeWorld();
    const r = cli(w, ["pr", "create", "--title", "t", "--body-file", "/var/folders/xx/pr.md"]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /PAYLOAD_MODE_DEPENDENT_PATH/);
    assert.deepEqual(lines(join(w.stubs, "gh.argv")), []);
  });

  it("with REPO_AEGIS_HOME and REPO_AEGIS_REGISTRY pointing elsewhere, the pinned --home still decides (no mapping there: plain)", () => {
    const w = makeWorld();
    const other = join(w.root, "other-aegis");
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, "engagements.yaml"), "schemaVersion: 2\npersonalOrgs:\n  - plain-org\nengagements: []\n");
    const r = cli(w, WRITE, { REPO_AEGIS_HOME: other, REPO_AEGIS_REGISTRY: join(other, "engagements.yaml") });
    // The pinned registry maps example-org, so the call is judged as a mapped one (and refused: untrusted stub gh).
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /GH_BINARY_UNTRUSTED/);
  });
});
