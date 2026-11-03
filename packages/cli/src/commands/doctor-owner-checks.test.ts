// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// `doctor`'s registered-owner checks (doc/plan-unregistered-owner-egress.md
// §3.8) against a FAKE `gh` on a temp PATH. Nothing here runs the real `gh`,
// reads the real registry, or touches the real home: every case builds its own
// temp REPO_AEGIS_HOME, HOME, Claude home and PATH.
//
// Placeholder names only (`alice`, `acme-corp`, `stranger-org`): the repository
// is public.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import type { Registry } from "@de-otio/repo-aegis-core";
import { doctor } from "./doctor.js";
import {
  findRealGh,
  ghLocationReason,
  ghOwnerChecks,
  parseAuthStatusText,
  registryStateChecks,
  untrustedDirReason,
  untrustedGhReason,
  type GhCheckOptions,
} from "./doctor-owner-checks.js";
import { PERSON_RUNS_THIS, type DoctorCheck } from "./doctor-checks.js";
import { renderShimScript } from "./shim-script.js";
import { currentEnforcementPin } from "../enforcement-pin.js";
import { withStreamTty } from "../_test-utils.js";

// ---------------------------------------------------------------------------
// The fake gh
// ---------------------------------------------------------------------------

/**
 * A `gh` that answers from files next to itself, so a case configures it by
 * writing files:
 *
 *   status.json        stdout of `auth status --json hosts`   (missing -> flag unknown, exit 1)
 *   status.txt         stderr of text-mode `auth status`      (exit 1 when present, as real gh does)
 *   token.<login>      stdout of `auth token --user <login>`   (missing -> exit 1)
 *   user.<token>       login for `api user` acting as <token>  (missing -> exit 1)
 *   orgs.<token>       lines for `api user/orgs`               (missing -> exit 1)
 *   active.user / active.orgs   the same, with NO GH_TOKEN in the environment
 *   http_unix_socket   stdout of `config get http_unix_socket` (absent -> empty, as a default gh prints)
 *
 * Every call's ARGUMENTS (never its environment) are appended to calls.log, so
 * a case can assert what was run and that no token ever travelled in an argv.
 * `auth switch` drops a `switched` marker file; no case may ever see it.
 * Lookups key on $GH_TOKEN, so a finding is attributed to the right account
 * only if doctor really passed that account's token through the environment.
 */
const FAKE_GH = `#!/bin/sh
D="$(dirname "$0")"
echo "$*" >> "$D/calls.log"
case "$1 $2" in
  "auth status")
    case "$*" in
      *--json*) [ -f "$D/status.json" ] || { echo "unknown flag: --json" >&2; exit 1; }
                cat "$D/status.json"; exit 0 ;;
    esac
    if [ -f "$D/status.txt" ]; then cat "$D/status.txt" >&2; exit 1; fi
    echo "You are not logged into any GitHub hosts." >&2; exit 1 ;;
  "auth token")
    while [ $# -gt 0 ]; do [ "$1" = "--user" ] && U="$2"; shift; done
    [ -f "$D/token.$U" ] || exit 1
    cat "$D/token.$U"; exit 0 ;;
  "auth switch")
    touch "$D/switched"; exit 0 ;;
  "config get")
    [ -f "$D/http_unix_socket" ] && cat "$D/http_unix_socket"
    exit 0 ;;
  "api --hostname")
    # A trap: a careless caller that lets a child's stderr through would print the token.
    [ -n "\${GH_TOKEN:-}" ] && echo "\$GH_TOKEN" >&2
    case "$*" in *user/orgs*) KIND=orgs ;; *) KIND=user ;; esac
    if [ -n "\${GH_TOKEN:-}" ]; then F="$D/$KIND.$GH_TOKEN"; else F="$D/active.$KIND"; fi
    [ -f "$F" ] || exit 1
    cat "$F"; exit 0 ;;
esac
exit 1
`;

let root: string;
let counter = 0;

before(() => {
  root = mkdtempSync(join(tmpdir(), "repo-aegis-doctor-owners-"));
  // A PATH directory that reaches git but has no gh (the gh-absent cases).
  const dir = join(root, "git-only");
  mkdirSync(dir, { recursive: true });
  const git = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  writeFileSync(join(dir, "git"), `#!/bin/sh\nexec "${git}" "$@"\n`, { mode: 0o755 });
  chmodSync(join(dir, "git"), 0o755);
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

interface Account {
  login: string;
  /** The account `gh` itself would use (no token needed). Default: the first one listed. */
  active?: boolean;
  /** gh's verdict on the stored token. Default "success". */
  state?: string;
  /** Token the fake hands out for `auth token --user`; omit to make that call fail. */
  token?: string;
  /** Orgs `api user/orgs` returns for this token; omit to make the call fail. */
  orgs?: string[];
}

interface Stub {
  dir: string;
  /** PATH that reaches the fake gh and nothing else of interest. */
  path: string;
  calls(): string;
  switched(): boolean;
}

/** Build a fake gh configured for `accounts`. */
function makeStub(accounts: Account[], opts: { json?: boolean } = {}): Stub {
  const dir = join(root, `gh-${counter++}`);
  mkdirSync(dir, { recursive: true });
  const gh = join(dir, "gh");
  writeFileSync(gh, FAKE_GH, { mode: 0o755 });
  chmodSync(gh, 0o755);

  if (opts.json !== false) {
    const entries = accounts.map((a, i) => ({
      state: a.state ?? "success",
      active: i === 0,
      host: "github.com",
      login: a.login,
      tokenSource: "keyring",
      scopes: "repo",
      gitProtocol: "https",
    }));
    writeFileSync(join(dir, "status.json"), JSON.stringify({ hosts: { "github.com": entries } }));
  } else {
    const text = accounts
      .map(a =>
        a.state === undefined || a.state === "success"
          ? `github.com\n  ✓ Logged in to github.com account ${a.login} (keyring)\n  - Active account: true\n`
          : `github.com\n  X Failed to log in to github.com account ${a.login} (keyring)\n`,
      )
      .join("\n");
    writeFileSync(join(dir, "status.txt"), text);
  }
  accounts.forEach((a, i) => {
    const isActive = a.active ?? i === 0;
    if (isActive && a.orgs !== undefined && (a.state ?? "success") === "success") {
      writeFileSync(join(dir, "active.user"), `${a.login}\n`);
      writeFileSync(join(dir, "active.orgs"), a.orgs.join("\n") + "\n");
    }
  });
  for (const a of accounts) {
    if (a.token === undefined) continue;
    writeFileSync(join(dir, `token.${a.login}`), `${a.token}\n`);
    writeFileSync(join(dir, `user.${a.token}`), `${a.login}\n`);
    if (a.orgs !== undefined) writeFileSync(join(dir, `orgs.${a.token}`), a.orgs.join("\n") + "\n");
  }
  return {
    dir,
    path: `${dir}${delimiter}/usr/bin${delimiter}/bin`,
    calls: () => (existsSync(join(dir, "calls.log")) ? readFileSync(join(dir, "calls.log"), "utf8") : ""),
    switched: () => existsSync(join(dir, "switched")),
  };
}

// Sentinels: if any appears in any output, a token leaked.
const TOKEN_ALICE = "tok_SENTINEL_alice_91c3d2";
const TOKEN_BOB = "tok_SENTINEL_bob_77ab01";

function registry(personal: string[], engagementOrgs: string[] = []): Registry {
  return {
    engagements: [
      { id: "customer-a", name: "Customer A", markers: ["customer-a-marker"], githubOrgs: engagementOrgs },
    ],
    alwaysBlock: [],
    personalOrgs: personal,
  };
}

function byCode(checks: DoctorCheck[], code: DoctorCheck["code"]): DoctorCheck[] {
  return checks.filter(c => c.code === code);
}

/** Fake gh stubs live in temp directories, which the real policy refuses; every confirmation is yes. */
const PERMISSIVE: GhCheckOptions = { policy: "permissive", confirm: () => true };

function env(path: string): NodeJS.ProcessEnv {
  return { PATH: path, REPO_AEGIS_HOME: join(root, "no-such-aegis-home") };
}

// ---------------------------------------------------------------------------
// Multiple accounts
// ---------------------------------------------------------------------------

describe("ghOwnerChecks — several accounts", () => {
  const stub = makeStub([
    { login: "alice", token: TOKEN_ALICE, orgs: ["acme-corp", "side-project-org"] },
    { login: "bob", token: TOKEN_BOB, orgs: ["stranger-org", "customer-b-org"] },
  ]);
  // alice + acme-corp + stranger-org are registered; old-engagement-org is registered but nobody is a member.
  const checks = ghOwnerChecks(registry(["alice", "stranger-org"], ["acme-corp", "old-engagement-org"]), env(stub.path), PERMISSIVE);

  it("checks every account and attributes each finding to its own account", () => {
    const logins = byCode(checks, "GH_LOGIN_UNREGISTERED");
    assert.equal(logins.length, 2);
    const alice = logins.find(c => c.account === "alice")!;
    const bob = logins.find(c => c.account === "bob")!;
    assert.equal(alice.ok, true);
    assert.equal(bob.ok, false);
    assert.match(bob.detail, /gh account bob/);
    assert.match(bob.fix ?? "", /engagements add --personal-org bob/);
  });

  it("GH_MEMBER_ORG_UNREGISTERED fires per account, for that account's orgs only", () => {
    const members = byCode(checks, "GH_MEMBER_ORG_UNREGISTERED");
    assert.equal(members.length, 2);
    const alice = members.find(c => c.account === "alice")!;
    const bob = members.find(c => c.account === "bob")!;
    assert.equal(alice.ok, false);
    assert.match(alice.fix ?? "", /side-project-org/);
    assert.doesNotMatch(alice.fix ?? "", /stranger-org|customer-b-org|acme-corp/);
    assert.equal(bob.ok, false);
    assert.match(bob.fix ?? "", /customer-b-org/);
    assert.doesNotMatch(bob.fix ?? "", /side-project-org|acme-corp/);
  });

  it("REGISTERED_ORG_NOT_MEMBER uses the UNION of all accounts' memberships (info, not a failure)", () => {
    const [c] = byCode(checks, "REGISTERED_ORG_NOT_MEMBER");
    assert.equal(c!.ok, false);
    assert.equal(c!.severity, "info");
    // old-engagement-org belongs to neither account; stranger-org is only bob's and acme-corp only alice's,
    // and both count as members through the union. The names are in --json (`names`), not in the text line.
    assert.deepEqual(c!.names, ["old-engagement-org"]);
    assert.doesNotMatch(c!.fix ?? "", /old-engagement-org|acme-corp|stranger-org|alice/);
    assert.doesNotMatch(c!.detail, /old-engagement-org/);
  });

  it("every fix that changes owners says a person runs it from their own terminal", () => {
    const changing = checks.filter(c => /engagements add/.test(c.fix ?? ""));
    assert.ok(changing.length >= 3);
    for (const c of changing) assert.ok((c.fix ?? "").includes(PERSON_RUNS_THIS), `missing in ${c.code}`);
  });

  it("each account's calls carry that account's token in the environment (not in argv), and never switch accounts", () => {
    assert.equal(stub.switched(), false, "doctor must never run `gh auth switch`");
    const calls = stub.calls();
    assert.doesNotMatch(calls, /switch/);
    assert.doesNotMatch(calls, new RegExp(`${TOKEN_ALICE}|${TOKEN_BOB}`), "a token appeared in an argument vector");
    // alice is the account gh itself would use: no token is read for it. bob needs one.
    assert.doesNotMatch(calls, /--user alice/);
    assert.match(calls, /auth token .*--user bob/);
  });

  it("no token value appears anywhere in the returned checks", () => {
    const blob = JSON.stringify(checks);
    assert.doesNotMatch(blob, new RegExp(`${TOKEN_ALICE}|${TOKEN_BOB}`));
    assert.doesNotMatch(blob, /tok_SENTINEL/);
  });

  it("detail lines name the account but no organisation", () => {
    for (const c of checks) {
      assert.doesNotMatch(c.detail, /acme-corp|side-project-org|stranger-org|customer-b-org|old-engagement-org/, c.code);
    }
  });
});

describe("ghOwnerChecks — an unauthenticated account", () => {
  it("skips that account (by state) without failing, checks the others, and flags the union as possibly incomplete", () => {
    const stub = makeStub([
      { login: "alice", token: TOKEN_ALICE, orgs: ["acme-corp"] },
      { login: "carol", state: "error", token: TOKEN_BOB, orgs: ["carol-org"] },
    ]);
    const checks = ghOwnerChecks(registry(["alice"], ["acme-corp", "elsewhere-org"]), env(stub.path), PERMISSIVE);
    const carol = checks.filter(c => c.account === "carol");
    assert.ok(carol.length >= 1);
    for (const c of carol) {
      assert.equal(c.ok, true);
      assert.equal(c.skipped, true);
      assert.match(c.detail, /carol/);
    }
    // carol's token must not even be requested: gh already said it is invalid.
    assert.doesNotMatch(stub.calls(), /--user carol/);
    // alice is still judged.
    assert.equal(byCode(checks, "GH_LOGIN_UNREGISTERED").find(c => c.account === "alice")!.ok, true);
    const [notMember] = byCode(checks, "REGISTERED_ORG_NOT_MEMBER");
    assert.match(notMember!.detail, /may be incomplete/);
  });

  it("skips an account whose token cannot be read even though gh listed it as valid", () => {
    const stub = makeStub([
      { login: "alice", token: TOKEN_ALICE, orgs: ["acme-corp"] },
      { login: "dave" }, // no token file: `auth token --user dave` exits 1
    ]);
    const checks = ghOwnerChecks(registry(["alice"], ["acme-corp"]), env(stub.path), PERMISSIVE);
    const dave = checks.filter(c => c.account === "dave");
    assert.ok(dave.length >= 1 && dave.every(c => c.skipped === true && c.ok));
    assert.equal(checks.some(c => !c.ok && c.account === "dave"), false);
  });
});

describe("ghOwnerChecks — gh absent, logged out, or unlistable", () => {
  it("gh absent -> all three checks are skipped, none fails", () => {
    const empty = join(root, "empty-path");
    mkdirSync(empty, { recursive: true });
    const checks = ghOwnerChecks(registry(["alice"]), env(empty), PERMISSIVE);
    assert.deepEqual(
      checks.map(c => c.code).sort(),
      ["GH_LOGIN_UNREGISTERED", "GH_MEMBER_ORG_UNREGISTERED", "REGISTERED_ORG_NOT_MEMBER"],
    );
    for (const c of checks) {
      assert.equal(c.skipped, true);
      assert.equal(c.ok, true);
    }
  });

  it("the repo-aegis shim directory is never used as the gh", () => {
    // A `gh` that only exists in <REPO_AEGIS_HOME>/bin is the shim; doctor must skip it.
    const home = join(root, "shim-home");
    mkdirSync(join(home, "bin"), { recursive: true });
    writeFileSync(join(home, "bin", "gh"), "#!/bin/sh\ntouch \"$(dirname \"$0\")/shim-ran\"\nexit 0\n", { mode: 0o755 });
    chmodSync(join(home, "bin", "gh"), 0o755);
    const checks = ghOwnerChecks(registry(["alice"]), { PATH: join(home, "bin"), REPO_AEGIS_HOME: home });
    assert.ok(checks.every(c => c.skipped === true));
    assert.equal(existsSync(join(home, "bin", "shim-ran")), false);
  });

  it("logged out (no accounts, no active login) -> skipped, not failed", () => {
    const stub = makeStub([]);
    const checks = ghOwnerChecks(registry(["alice"]), env(stub.path), PERMISSIVE);
    assert.equal(checks.length, 3);
    assert.ok(checks.every(c => c.skipped === true && c.ok));
    assert.match(checks[0]!.detail, /not authenticated/);
  });

  it("an old gh without --json: the text form of `auth status` is parsed", () => {
    const stub = makeStub(
      [
        { login: "alice", token: TOKEN_ALICE, orgs: ["acme-corp"] },
        { login: "bob", token: TOKEN_BOB, orgs: [] },
      ],
      { json: false },
    );
    const checks = ghOwnerChecks(registry(["alice"], ["acme-corp"]), env(stub.path), PERMISSIVE);
    assert.deepEqual(
      byCode(checks, "GH_LOGIN_UNREGISTERED").map(c => c.account),
      ["alice", "bob"],
    );
    assert.equal(byCode(checks, "GH_LOGIN_UNREGISTERED")[1]!.ok, false);
  });

  it("listing fails -> falls back to the ACTIVE account and says so", () => {
    const stub = makeStub([], { json: false }); // writes an empty status.txt: nothing parseable, exit 1
    rmSync(join(stub.dir, "status.txt"), { force: true });
    writeFileSync(join(stub.dir, "status.txt"), "something went wrong\n");
    writeFileSync(join(stub.dir, "active.user"), "erin\n");
    writeFileSync(join(stub.dir, "active.orgs"), "acme-corp\nother-org\n");
    const checks = ghOwnerChecks(registry(["erin"], ["acme-corp"]), env(stub.path), PERMISSIVE);
    const login = byCode(checks, "GH_LOGIN_UNREGISTERED");
    assert.equal(login.length, 1);
    assert.equal(login[0]!.ok, true);
    assert.match(login[0]!.detail, /only the active account was checked/);
    const member = byCode(checks, "GH_MEMBER_ORG_UNREGISTERED")[0]!;
    assert.equal(member.ok, false);
    assert.match(member.detail, /only the active account was checked/);
    assert.match(member.fix ?? "", /other-org/);
    assert.equal(stub.switched(), false);
  });
});

describe("parseAuthStatusText", () => {
  it("reads logins from both gh phrasings and ignores token lines", () => {
    const text = [
      "github.com",
      "  ✓ Logged in to github.com account alice (keyring)",
      "  - Active account: true",
      "  - Token: gho_SHOULD_NEVER_BE_READ",
      "  ✓ Logged in to github.com as bob (oauth_token)",
      "  X Failed to log in to github.com account carol (keyring)",
      "  ✓ Logged in to enterprise.example account zed (keyring)",
    ].join("\n");
    assert.deepEqual(parseAuthStatusText(text), [
      { login: "alice", tokenValid: true },
      { login: "bob", tokenValid: true },
      { login: "carol", tokenValid: false },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Registry state (D4)
// ---------------------------------------------------------------------------

describe("registryStateChecks", () => {
  it("unreadable is a FAILURE (severity absent == fail), with a person-only fix when encrypted", () => {
    const [enc] = registryStateChecks("unreadable", null, true);
    assert.equal(enc!.code, "REGISTRY_UNREADABLE");
    assert.equal(enc!.ok, false);
    assert.equal(enc!.severity, undefined);
    assert.match(enc!.fix ?? "", /registry decrypt/);
    assert.ok((enc!.fix ?? "").includes(PERSON_RUNS_THIS));
    const [bad] = registryStateChecks("unreadable", null, false);
    assert.equal(bad!.ok, false);
    assert.doesNotMatch(bad!.fix ?? "", /decrypt/);
  });

  it("missing is not a finding; loaded with owners is not a finding", () => {
    assert.deepEqual(registryStateChecks("missing", null, false), []);
    assert.deepEqual(registryStateChecks("loaded", registry(["alice"]), false), []);
  });

  it("a loaded registry with no owners is OWNERS_UNDECLARED (a failure) with a person-only fix", () => {
    const [c] = registryStateChecks("loaded", registry([], []), false);
    assert.equal(c!.code, "OWNERS_UNDECLARED");
    assert.equal(c!.ok, false);
    assert.equal(c!.severity, undefined);
    assert.ok((c!.fix ?? "").includes(PERSON_RUNS_THIS));
  });
});

// ---------------------------------------------------------------------------
// End to end through doctor(): exit codes, text redaction, tokens
// ---------------------------------------------------------------------------

class ExitSignal extends Error {}

/** Variables that redirect or override gh's config; doctor refuses to read other tokens when any is set. */
const REDIRECT_VARS = ["GH_CONFIG_DIR", "GH_HOST", "GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"];

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number | undefined;
}

function runDoctor(opts: Parameters<typeof doctor>[0], envOverrides: Record<string, string>): RunResult {
  const out: string[] = [];
  const err: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  const origExit = process.exit;
  let exitCode: number | undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stdout as any).write = (c: any) => (out.push(String(c)), true);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stderr as any).write = (c: any) => (err.push(String(c)), true);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process as any).exit = (c?: number) => {
    exitCode = c;
    throw new ExitSignal();
  };
  const prev: Record<string, string | undefined> = {};
  // An ambient GH_TOKEN / GH_CONFIG_DIR on a developer machine would (rightly) stop doctor reading other
  // accounts' tokens; the cases below are about everything else.
  for (const k of REDIRECT_VARS) {
    prev[k] = process.env[k];
    delete process.env[k];
  }
  for (const [k, v] of Object.entries(envOverrides)) {
    prev[k] = process.env[k];
    process.env[k] = v;
  }
  try {
    doctor(opts);
  } catch (e) {
    if (!(e instanceof ExitSignal)) throw e;
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    process.stdout.write = origOut;
    process.stderr.write = origErr;
    process.exit = origExit;
  }
  return { stdout: out.join(""), stderr: err.join(""), exitCode };
}

interface World {
  aegisHome: string;
  userHome: string;
  claudeHome: string;
  scanRoot: string;
  registryFile: string;
  env: Record<string, string>;
}

function makeWorld(name: string, registryYaml: string | null, stubPath: string): World {
  const base = join(root, `world-${name}`);
  const aegisHome = join(base, "aegis");
  const userHome = join(base, "home");
  const claudeHome = join(base, "claude");
  const scanRoot = join(base, "scan");
  for (const d of [aegisHome, userHome, claudeHome, scanRoot]) mkdirSync(d, { recursive: true });
  // The shim is installed and first on PATH, as `doctor` wants; it must be skipped when looking for the real gh.
  mkdirSync(join(aegisHome, "bin"), { recursive: true });
  writeFileSync(join(aegisHome, "bin", "gh"), renderShimScript(currentEnforcementPin()), { mode: 0o755 });
  chmodSync(join(aegisHome, "bin", "gh"), 0o755);
  const registryFile = join(aegisHome, "engagements.yaml");
  if (registryYaml !== null) writeFileSync(registryFile, registryYaml);
  const globalConfig = join(base, "gitconfig");
  writeFileSync(globalConfig, "[push]\n\tdefault = nothing\n");
  return {
    aegisHome,
    userHome,
    claudeHome,
    scanRoot,
    registryFile,
    env: {
      REPO_AEGIS_HOME: aegisHome,
      REPO_AEGIS_REGISTRY: registryFile,
      HOME: userHome,
      PATH: `${join(aegisHome, "bin")}${delimiter}${stubPath}`,
      GIT_CONFIG_GLOBAL: globalConfig,
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    },
  };
}

function docOpts(w: World): Parameters<typeof doctor>[0] {
  return {
    scanRoot: [w.scanRoot],
    claudeHome: w.claudeHome,
    homeDir: w.userHome,
    sshDir: join(w.userHome, ".ssh"),
    ghOptions: PERMISSIVE,
  };
}

const REGISTRY_YAML = `\
always_block: []
personalOrgs:
  - alice
engagements:
  - id: customer-a
    name: Customer A
    markers:
      - customer-a-marker
    githubOrgs:
      - acme-corp
      - old-engagement-org
`;

describe("doctor — owner checks end to end", () => {
  // The guard-hook check is not under test here and would fail (exit 1); it is satisfied
  // so that the exit code reflects the checks this file is about.
  function satisfyMachineChecks(w: World): void {
    writeFileSync(
      join(w.claudeHome, "settings.json"),
      JSON.stringify({
        hooks: {
          PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "repo-aegis hook guard-egress --agent claude" }] }],
        },
      }),
    );
  }

  it("org names appear in `fix` and --json only, never in a summary line; tokens appear nowhere", () => {
    const stub = makeStub([
      { login: "alice", token: TOKEN_ALICE, orgs: ["acme-corp", "side-project-org"] },
      { login: "bob", token: TOKEN_BOB, orgs: ["stranger-org", "customer-b-org"] },
    ]);
    const w = makeWorld("redaction", REGISTRY_YAML, stub.path);
    satisfyMachineChecks(w);

    const text = runDoctor(docOpts(w), w.env);
    assert.equal(text.exitCode, 1, "an unregistered gh login is a failure");
    assert.match(text.stdout, /FAIL GH_LOGIN_UNREGISTERED/);
    assert.match(text.stdout, /FAIL GH_MEMBER_ORG_UNREGISTERED/);
    assert.match(text.stdout, /INFO REGISTERED_ORG_NOT_MEMBER/);

    const orgNames = ["acme-corp", "side-project-org", "stranger-org", "customer-b-org", "old-engagement-org"];
    for (const line of text.stdout.split("\n")) {
      const isFix = /^\s+fix: /.test(line);
      if (isFix) continue;
      for (const org of orgNames) {
        assert.ok(!line.includes(org), `org name "${org}" appears outside a fix line: ${line}`);
      }
    }
    // They DO appear in the fix lines of the owner-adding checks (that is where the operator types them)...
    assert.match(text.stdout, /fix: .*side-project-org/);
    assert.match(text.stdout, /fix: .*customer-b-org/);
    // ...but a REGISTRY owner (the info check) is never in the text at all: --json only.
    assert.doesNotMatch(text.stdout, /old-engagement-org/);

    // --json carries them too.
    const json = runDoctor({ ...docOpts(w), json: true }, w.env);
    assert.match(json.stdout, /side-project-org/);
    assert.match(json.stdout, /old-engagement-org/);

    for (const r of [text, json]) {
      assert.doesNotMatch(r.stdout, /tok_SENTINEL/);
      assert.doesNotMatch(r.stderr, /tok_SENTINEL/);
    }
    assert.doesNotMatch(stub.calls(), /tok_SENTINEL/);
    assert.equal(stub.switched(), false);
  });

  it("gh absent -> SKIP lines, no failure from these checks", () => {
    const empty = join(root, "empty-path-2");
    mkdirSync(empty, { recursive: true });
    const w = makeWorld("gh-absent", REGISTRY_YAML, empty);
    satisfyMachineChecks(w);
    // git is needed by the sweep's helpers; give PATH a tail that has it but no gh.
    const r = runDoctor(docOpts(w), {
      ...w.env,
      PATH: `${join(w.aegisHome, "bin")}${delimiter}${empty}${delimiter}${join(root, "git-only")}`,
    });
    assert.match(r.stdout, /SKIP GH_LOGIN_UNREGISTERED — skipped: `gh` is not installed/);
    assert.doesNotMatch(r.stdout, /FAIL GH_/);
  });

  it("a missing registry produces no owner findings and does not call gh", () => {
    const stub = makeStub([{ login: "alice", token: TOKEN_ALICE, orgs: [] }]);
    const w = makeWorld("no-registry", null, stub.path);
    satisfyMachineChecks(w);
    const r = runDoctor(docOpts(w), w.env);
    assert.doesNotMatch(r.stdout, /OWNERS_UNDECLARED|REGISTRY_UNREADABLE|GH_LOGIN|REGISTRY_AGENT_WRITABLE/);
    assert.equal(stub.calls(), "");
  });

  it("an unparseable registry is REGISTRY_UNREADABLE and exits 1; gh is not called", () => {
    const stub = makeStub([{ login: "alice", token: TOKEN_ALICE, orgs: [] }]);
    const w = makeWorld("bad-registry", "engagements: [unclosed\n  - : :\n", stub.path);
    satisfyMachineChecks(w);
    const r = runDoctor(docOpts(w), w.env);
    assert.equal(r.exitCode, 1);
    assert.match(r.stdout, /FAIL REGISTRY_UNREADABLE/);
    assert.equal(stub.calls(), "");
  });

  it("an encrypted-at-rest registry (only <registry>.age exists) is REGISTRY_UNREADABLE with the decrypt fix", () => {
    const stub = makeStub([]);
    const w = makeWorld("enc-registry", null, stub.path);
    satisfyMachineChecks(w);
    writeFileSync(`${w.registryFile}.age`, "age-encryption.org/v1\n");
    const r = runDoctor(docOpts(w), w.env);
    assert.equal(r.exitCode, 1);
    assert.match(r.stdout, /FAIL REGISTRY_UNREADABLE/);
    assert.match(r.stdout, /fix: repo-aegis registry decrypt/);
  });

  it("a registry with no owners is OWNERS_UNDECLARED and exits 1", () => {
    const stub = makeStub([]);
    const w = makeWorld(
      "no-owners",
      "always_block: []\nengagements:\n  - id: customer-a\n    name: Customer A\n    markers:\n      - customer-a-marker\n",
      stub.path,
    );
    satisfyMachineChecks(w);
    const r = runDoctor(docOpts(w), w.env);
    assert.equal(r.exitCode, 1);
    assert.match(r.stdout, /FAIL OWNERS_UNDECLARED/);
    assert.match(r.stdout, /fix: .*from their own terminal/);
  });

  it("warnings and info never change the exit code", () => {
    // alice registered, no orgs, gh clean; REGISTRY_AGENT_WRITABLE (warn) fires because settings has no deny rule.
    const stub = makeStub([{ login: "alice", token: TOKEN_ALICE, orgs: [] }]);
    const w = makeWorld("warn-only", "always_block: []\npersonalOrgs:\n  - alice\nengagements: []\n", stub.path);
    satisfyMachineChecks(w);
    const r = runDoctor(docOpts(w), w.env);
    assert.match(r.stdout, /WARN REGISTRY_AGENT_WRITABLE/);
    assert.equal(r.exitCode, undefined);
  });
});

// ---------------------------------------------------------------------------
// Which gh may be handed a token (credential harvest)
// ---------------------------------------------------------------------------

/** A gh that records the length of any GH_TOKEN it is given, then runs the real one. */
function makeHarvester(base: string, realDir: string): string {
  const dir = join(base, "evil-bin");
  mkdirSync(dir, { recursive: true });
  const log = join(base, "harvest.log");
  writeFileSync(
    join(dir, "gh"),
    `#!/bin/sh\n[ -n "$GH_TOKEN" ] && echo "harvested token of length \${#GH_TOKEN}" >> "${log}"\necho ran >> "${log}.ran"\nexec "${realDir}/gh" "$@"\n`,
    { mode: 0o755 },
  );
  chmodSync(join(dir, "gh"), 0o755);
  return dir;
}

function shimDirFor(base: string): { home: string; bin: string } {
  const home = join(base, "aegis");
  const bin = join(home, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "gh"), renderShimScript(currentEnforcementPin()), { mode: 0o755 });
  chmodSync(join(bin, "gh"), 0o755);
  return { home, bin };
}

describe("ghOwnerChecks — a hostile gh earlier on PATH never receives a token", () => {
  it("(a) another gh BEFORE the shim: every gh check is skipped, nothing is run", () => {
    const stub = makeStub([{ login: "alice", token: TOKEN_ALICE, orgs: ["acme-corp"] }, { login: "bob", token: TOKEN_BOB, orgs: [] }]);
    const base = join(root, `harvest-a-${counter++}`);
    const { home, bin } = shimDirFor(base);
    const evil = makeHarvester(base, stub.dir);
    const checks = ghOwnerChecks(
      registry(["alice"]),
      { PATH: `${evil}${delimiter}${bin}${delimiter}${stub.dir}`, REPO_AEGIS_HOME: home },
      PERMISSIVE, // even with the location policy off, order alone must stop it
    );
    assert.ok(checks.length === 3 && checks.every(c => c.skipped === true && c.ok), JSON.stringify(checks));
    assert.match(checks[0]!.detail, /precedes the repo-aegis shim/);
    assert.equal(existsSync(join(base, "harvest.log.ran")), false, "the hostile gh must not even be run");
    assert.equal(stub.calls(), "");
  });

  it("(b) a gh in a directory an agent can write (temp, $HOME, cwd) is refused with the default policy, and warned about", () => {
    const stub = makeStub([{ login: "alice", token: TOKEN_ALICE, orgs: ["acme-corp"] }, { login: "bob", token: TOKEN_BOB, orgs: [] }]);
    const base = join(root, `harvest-b-${counter++}`);
    const { home, bin } = shimDirFor(base);
    const evil = makeHarvester(base, stub.dir);
    // shim first (so (a) does not apply); the hostile gh is the one the shim would run.
    const checks = ghOwnerChecks(
      registry(["alice"]),
      { PATH: `${bin}${delimiter}${evil}${delimiter}${stub.dir}`, REPO_AEGIS_HOME: home, HOME: base },
      { confirm: () => true }, // default policy: temp dirs are refused
    );
    const skipped = checks.filter(c => c.skipped === true);
    assert.equal(skipped.length, 3);
    assert.match(skipped[0]!.detail, /not in a trusted location/);
    const warn = checks.find(c => c.code === "GH_BINARY_UNTRUSTED");
    assert.ok(warn && warn.ok === false && warn.severity === "warn");
    assert.equal(existsSync(join(base, "harvest.log.ran")), false, "the hostile gh must not be run");
    assert.equal(stub.calls(), "");
  });

  it("untrustedGhReason: home, temp and cwd are refused; a root-owned system binary is not", () => {
    const home = join(root, `home-${counter++}`);
    mkdirSync(join(home, "bin"), { recursive: true });
    writeFileSync(join(home, "bin", "gh"), "#!/bin/sh\n", { mode: 0o755 });
    assert.match(untrustedGhReason(realpathSync(join(home, "bin", "gh")), { HOME: home }) ?? "", /home directory/);
    assert.match(untrustedGhReason(join(realpathSync(tmpdir()), "x", "gh"), {}) ?? "", /agent can write/);
    assert.match(untrustedGhReason("relative/gh", {}) ?? "", /relative/);
    assert.equal(untrustedGhReason(realpathSync("/bin/sh"), { HOME: join(root, "nowhere") }), null);
  });

  it("untrustedGhReason: a group/world-writable directory or file is refused (location roots aside)", () => {
    const dir = join(root, `perm-${counter++}`);
    mkdirSync(dir, { recursive: true });
    const gh = join(dir, "gh");
    writeFileSync(gh, "#!/bin/sh\n", { mode: 0o755 });
    chmodSync(gh, 0o755);
    chmodSync(dir, 0o777);
    assert.match(untrustedGhReason(realpathSync(gh), {}, { skipLocationRoots: true }) ?? "", /directory is writable/);
    chmodSync(dir, 0o755);
    chmodSync(gh, 0o775);
    assert.match(untrustedGhReason(realpathSync(gh), {}, { skipLocationRoots: true }) ?? "", /file is writable/);
    chmodSync(gh, 0o755);
    // owned by the test user, not root, and not in a package-manager prefix:
    assert.match(untrustedGhReason(realpathSync(gh), {}, { skipLocationRoots: true }) ?? "", /not owned by root/);
  });

  it("MEDIUM 2: empty and relative PATH entries are skipped, and the shim is never reached through them", () => {
    const stub = makeStub([{ login: "alice", token: TOKEN_ALICE, orgs: ["acme-corp"] }]);
    const base = join(root, `harvest-c-${counter++}`);
    const { home, bin } = shimDirFor(base);
    const evil = makeHarvester(base, stub.dir);
    const prevCwd = process.cwd();
    process.chdir(evil); // a `gh` sits in the cwd: "" and "." both mean here
    try {
      const e = { PATH: `${bin}${delimiter}${delimiter}.${delimiter}../evil-bin${delimiter}${stub.dir}${delimiter}/usr/bin${delimiter}/bin`, REPO_AEGIS_HOME: home };
      const found = findRealGh(e);
      assert.equal(found, join(stub.dir, "gh"), "only the absolute entry may be chosen");
      assert.ok(isAbsolute(found!));
      const checks = ghOwnerChecks(registry(["alice"], ["acme-corp"]), e, PERMISSIVE);
      assert.equal(checks.some(c => c.skipped === true), false, JSON.stringify(checks));
    } finally {
      process.chdir(prevCwd);
    }
    assert.equal(existsSync(join(base, "harvest.log.ran")), false, "the gh in the cwd must never run");
  });

  it("MEDIUM 2: with ONLY an empty/relative entry that holds a gh, there is no gh", () => {
    const base = join(root, `harvest-d-${counter++}`);
    const evil = makeHarvester(base, base);
    const { home } = shimDirFor(base);
    const prevCwd = process.cwd();
    process.chdir(evil);
    try {
      assert.equal(findRealGh({ PATH: `${delimiter}.`, REPO_AEGIS_HOME: home }), null);
      const checks = ghOwnerChecks(registry(["alice"]), { PATH: `${delimiter}.`, REPO_AEGIS_HOME: home }, PERMISSIVE);
      assert.ok(checks.every(c => c.skipped === true));
    } finally {
      process.chdir(prevCwd);
    }
    assert.equal(existsSync(join(base, "harvest.log.ran")), false);
  });
});

describe("ghOwnerChecks — another account's token needs a terminal confirmation", () => {
  const accounts = (): Account[] => [
    { login: "alice", token: TOKEN_ALICE, orgs: ["acme-corp"] },
    { login: "bob", token: TOKEN_BOB, orgs: ["stranger-org"] },
  ];

  it("without a TTY: only the active account is checked, no `--user` token fetch happens, and it says so", () => {
    const stub = makeStub(accounts());
    // The default confirmation, with stdin pinned to "not a terminal".
    const checks = withStreamTty("stdin", false, () =>
      ghOwnerChecks(registry(["alice"], ["acme-corp"]), env(stub.path), { policy: "permissive" }),
    );
    assert.doesNotMatch(stub.calls(), /--user/);
    assert.doesNotMatch(stub.calls(), /auth token/);
    const alice = byCode(checks, "GH_LOGIN_UNREGISTERED").find(c => c.account === "alice")!;
    assert.equal(alice.ok, true);
    assert.match(alice.detail, /only the active account was checked/);
    const bob = byCode(checks, "GH_LOGIN_UNREGISTERED").find(c => c.account === "bob")!;
    assert.equal(bob.skipped, true);
    assert.match(bob.detail, /needs a y\/N confirmation at a terminal/);
    // Nothing of bob's was learned.
    assert.equal(byCode(checks, "GH_MEMBER_ORG_UNREGISTERED").find(c => c.account === "bob")!.skipped, true);
  });

  it("declined: same as no terminal", () => {
    const stub = makeStub(accounts());
    ghOwnerChecks(registry(["alice"]), env(stub.path), { policy: "permissive", confirm: () => false });
    assert.doesNotMatch(stub.calls(), /--user/);
  });

  it("confirmed: the prompt names the gh binary and the accounts, then the token is read", () => {
    const stub = makeStub(accounts());
    let asked: { gh: string; logins: string[] } | null = null;
    const checks = ghOwnerChecks(registry(["alice"], ["acme-corp"]), env(stub.path), {
      policy: "permissive",
      confirm: (gh, logins) => {
        asked = { gh, logins };
        return true;
      },
    });
    assert.deepEqual(asked, { gh: realpathSync(join(stub.dir, "gh")), logins: ["bob"] });
    assert.match(stub.calls(), /auth token .*--user bob/);
    assert.equal(byCode(checks, "GH_LOGIN_UNREGISTERED").find(c => c.account === "bob")!.ok, false);
  });

  it("no non-active account -> no question at all", () => {
    const stub = makeStub([{ login: "alice", token: TOKEN_ALICE, orgs: [] }]);
    let asked = false;
    ghOwnerChecks(registry(["alice"]), env(stub.path), { policy: "permissive", confirm: () => ((asked = true), true) });
    assert.equal(asked, false);
  });
});

// ---------------------------------------------------------------------------
// fds 1 and 2 of a real subprocess never show a token
// ---------------------------------------------------------------------------

describe("doctor as a subprocess", () => {
  it("neither stdout nor stderr ever contains a token, even though the fake gh prints it to ITS stderr", () => {
    const stub = makeStub([
      { login: "alice", token: TOKEN_ALICE, orgs: ["acme-corp"] },
      { login: "bob", token: TOKEN_BOB, orgs: ["stranger-org"] },
    ]);
    const w = makeWorld("subprocess", REGISTRY_YAML, stub.path);
    writeFileSync(
      join(w.claudeHome, "settings.json"),
      JSON.stringify({
        hooks: {
          PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "repo-aegis hook guard-egress --agent claude" }] }],
        },
      }),
    );
    // The harness calls doctor() with the test seams (permissive policy, confirm=yes) in a REAL child
    // process, so fds 1 and 2 are real pipes and nothing is intercepted in-process.
    const harness = join(w.aegisHome, "run-doctor.mjs");
    const doctorUrl = new URL("./doctor.js", import.meta.url).href;
    writeFileSync(
      harness,
      `import { doctor } from ${JSON.stringify(doctorUrl)};
doctor({ scanRoot: [${JSON.stringify(w.scanRoot)}], claudeHome: ${JSON.stringify(w.claudeHome)}, homeDir: ${JSON.stringify(w.userHome)},
  sshDir: ${JSON.stringify(join(w.userHome, ".ssh"))}, json: process.argv[2] === "json",
  ghOptions: { policy: "permissive", confirm: () => true } });
`,
    );
    for (const mode of ["text", "json"]) {
      const clean = { ...process.env };
      for (const k of REDIRECT_VARS) delete clean[k];
      const res = spawnSync(process.execPath, [harness, mode], { env: { ...clean, ...w.env }, encoding: "utf8" });
      assert.ok(res.stdout.length > 0, "doctor produced no output");
      for (const [name, text] of [["stdout", res.stdout], ["stderr", res.stderr]] as const) {
        assert.ok(!text.includes("tok_SENTINEL"), `a token reached ${name} in ${mode} mode`);
      }
    }
    // The trap is real: the fake gh did receive tokens in its environment.
    assert.match(stub.calls(), /api --hostname github\.com user/);
  });
});

// ---------------------------------------------------------------------------
// A link NAMED gh is not a gh; a PATH entry's own directory is vetted too
// ---------------------------------------------------------------------------

describe("ghLocationReason", () => {
  it("accepts a standard install path and a Homebrew Cellar/opt gh; refuses links to other programs", () => {
    assert.equal(ghLocationReason("/usr/bin/gh"), null);
    assert.equal(ghLocationReason("/opt/homebrew/Cellar/gh/2.102.0/bin/gh"), null);
    assert.equal(ghLocationReason("/usr/local/opt/gh/bin/gh"), null);
    assert.equal(ghLocationReason("/home/linuxbrew/.linuxbrew/Cellar/gh/2.1/bin/gh"), null);
    // The probe: `gh -> /bin/sh` (root-owned target) and `/usr/bin/env`, which runs ./auth from the cwd.
    assert.match(ghLocationReason(realpathSync("/bin/sh")) ?? "", /not named gh/);
    assert.match(ghLocationReason(realpathSync("/usr/bin/env")) ?? "", /not named gh/);
    // Named gh but not where a package manager puts it.
    assert.match(ghLocationReason("/opt/homebrew/Cellar/other/1/bin/gh") ?? "", /not a standard gh install path/);
    assert.match(ghLocationReason("/Users/x/bin/gh") ?? "", /not a standard gh install path/);
    assert.match(ghLocationReason("gh") ?? "", /relative/);
  });
});

describe("ghOwnerChecks — links named gh", () => {
  function evilBin(base: string, target: string): string {
    const dir = join(base, "evil");
    mkdirSync(dir, { recursive: true });
    symlinkSync(target, join(dir, "gh"));
    return dir;
  }

  for (const target of ["/bin/sh", "/usr/bin/env"]) {
    it(`gh -> ${target} is refused and nothing the agent planted in the cwd runs`, () => {
      const base = join(root, `link-${counter++}`);
      const { home, bin } = shimDirFor(base);
      const evil = evilBin(base, target);
      const repo = join(base, "repo");
      mkdirSync(repo, { recursive: true });
      // `sh auth status ...` would run ./auth as a script; `env auth ...` would exec ./auth.
      writeFileSync(join(repo, "auth"), `#!/bin/sh\ntouch "${base}/agent-code-ran"\n`, { mode: 0o755 });
      const prev = process.cwd();
      process.chdir(repo);
      try {
        const checks = ghOwnerChecks(
          registry(["alice"]),
          { PATH: `${bin}${delimiter}${evil}${delimiter}/usr/bin${delimiter}/bin`, REPO_AEGIS_HOME: home, HOME: base },
          { confirm: () => true },
        );
        assert.ok(checks.filter(c => c.skipped === true).length === 3, JSON.stringify(checks));
        assert.ok(checks.some(c => c.code === "GH_BINARY_UNTRUSTED"));
      } finally {
        process.chdir(prev);
      }
      assert.equal(existsSync(join(base, "agent-code-ran")), false, "agent-planted ./auth was executed");
    });
  }

  it("the 'is this file a gh' test is wired in on its own: with the directory tests off, gh -> /bin/sh is still refused", () => {
    const base = join(root, `link-wired-${counter++}`);
    const { home, bin } = shimDirFor(base);
    const evil = evilBin(base, "/bin/sh");
    const checks = ghOwnerChecks(
      registry(["alice"]),
      { PATH: `${bin}${delimiter}${evil}${delimiter}/usr/bin${delimiter}/bin`, REPO_AEGIS_HOME: home },
      { skipDirectoryChecks: true, confirm: () => true },
    );
    assert.equal(checks.filter(c => c.skipped === true).length, 3, JSON.stringify(checks));
    assert.match(checks.find(c => c.code === "GH_BINARY_UNTRUSTED")!.detail, /not named gh/);
  });

  const brewGh = "/opt/homebrew/bin/gh";
  it(
    "a gh in ~/bin linked to the REAL Homebrew gh is refused because of the PATH entry's own directory",
    { skip: !existsSync(brewGh) },
    () => {
      const base = join(root, `homebin-${counter++}`);
      const { home, bin } = shimDirFor(base);
      const homeBin = join(base, "bin");
      mkdirSync(homeBin, { recursive: true });
      symlinkSync(brewGh, join(homeBin, "gh"));
      const real = realpathSync(brewGh);
      // The target alone is fine: that is exactly why the entry's directory has to be vetted too.
      assert.equal(ghLocationReason(real), null);
      assert.equal(untrustedGhReason(real, {}), null);
      assert.match(untrustedDirReason(realpathSync(homeBin), { HOME: base }) ?? "", /your home directory/);
      const checks = ghOwnerChecks(
        registry(["alice"]),
        { PATH: `${bin}${delimiter}${homeBin}${delimiter}/usr/bin${delimiter}/bin`, REPO_AEGIS_HOME: home, HOME: base },
        { confirm: () => true },
      );
      assert.equal(checks.filter(c => c.skipped === true).length, 3, JSON.stringify(checks));
      assert.match(checks.find(c => c.code === "GH_BINARY_UNTRUSTED")!.detail, /your home directory/);
    },
  );
});

// ---------------------------------------------------------------------------
// A trusted gh can still be steered by its own configuration
// ---------------------------------------------------------------------------

describe("ghOwnerChecks — a redirected gh never reads another account's token", () => {
  const twoAccounts = (): Account[] => [
    { login: "alice", token: TOKEN_ALICE, orgs: ["acme-corp"] },
    { login: "bob", token: TOKEN_BOB, orgs: ["stranger-org"] },
  ];
  function run(stub: Stub, envExtra: Record<string, string> = {}): { checks: DoctorCheck[]; asked: boolean } {
    let asked = false;
    const checks = ghOwnerChecks(registry(["alice"], ["acme-corp"]), { ...env(stub.path), ...envExtra }, {
      policy: "permissive",
      confirm: () => ((asked = true), true),
    });
    return { checks, asked };
  }

  it("http_unix_socket set in gh's config: no prompt, no token read, a warning, active account still checked", () => {
    const stub = makeStub(twoAccounts());
    writeFileSync(join(stub.dir, "http_unix_socket"), "/tmp/agent.sock\n");
    const { checks, asked } = run(stub);
    assert.equal(asked, false, "nobody is asked to confirm something unsafe");
    assert.doesNotMatch(stub.calls(), /--user|auth token/);
    const warn = checks.find(c => c.code === "GH_CONFIG_REDIRECT")!;
    assert.equal(warn.ok, false);
    assert.equal(warn.severity, "warn");
    assert.match(warn.detail, /http_unix_socket/);
    assert.doesNotMatch(JSON.stringify(checks), /agent\.sock/, "the socket path is not echoed");
    assert.equal(byCode(checks, "GH_LOGIN_UNREGISTERED").find(c => c.account === "alice")!.ok, true);
    assert.equal(byCode(checks, "GH_LOGIN_UNREGISTERED").find(c => c.account === "bob")!.skipped, true);
  });

  for (const name of ["GH_CONFIG_DIR", "GH_HOST", "GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"]) {
    it(`${name} in doctor's environment: other tokens are not read, and the value is never printed`, () => {
      const stub = makeStub(twoAccounts());
      const { checks, asked } = run(stub, { [name]: "SENTINEL_VALUE_xyz" });
      assert.equal(asked, false);
      assert.doesNotMatch(stub.calls(), /--user|auth token/);
      const warn = checks.find(c => c.code === "GH_CONFIG_REDIRECT")!;
      assert.match(warn.detail, new RegExp(name));
      assert.doesNotMatch(JSON.stringify(checks), /SENTINEL_VALUE_xyz/);
    });
  }

  it("no redirect: the question is asked, as before", () => {
    const stub = makeStub(twoAccounts());
    const { checks, asked } = run(stub);
    assert.equal(asked, true);
    assert.equal(checks.some(c => c.code === "GH_CONFIG_REDIRECT"), false);
    assert.match(stub.calls(), /auth token .*--user bob/);
  });

  it("an unreadable http_unix_socket setting fails closed", () => {
    const stub = makeStub(twoAccounts());
    // A gh whose `config get` errors.
    writeFileSync(join(stub.dir, "gh"), readFileSync(join(stub.dir, "gh"), "utf8").replace('"config get")', '"config xxx")'), {
      mode: 0o755,
    });
    const { asked } = run(stub);
    assert.equal(asked, false);
    assert.doesNotMatch(stub.calls(), /--user/);
  });
});
