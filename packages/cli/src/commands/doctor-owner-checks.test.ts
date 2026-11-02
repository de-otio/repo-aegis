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
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { execFileSync } from "node:child_process";
import type { Registry } from "@de-otio/repo-aegis-core";
import { doctor } from "./doctor.js";
import { ghOwnerChecks, parseAuthStatusText, registryStateChecks } from "./doctor-owner-checks.js";
import { PERSON_RUNS_THIS, type DoctorCheck } from "./doctor-checks.js";
import { GH_SHIM_SCRIPT } from "./shim-script.js";

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
  "api --hostname")
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
  const checks = ghOwnerChecks(registry(["alice", "stranger-org"], ["acme-corp", "old-engagement-org"]), env(stub.path));

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
    // and both count as members through the union.
    assert.match(c!.fix ?? "", /old-engagement-org/);
    assert.doesNotMatch(c!.fix ?? "", /acme-corp|stranger-org|alice/);
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
    assert.match(calls, /auth token .*--user alice/);
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
    const checks = ghOwnerChecks(registry(["alice"], ["acme-corp", "elsewhere-org"]), env(stub.path));
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
    const checks = ghOwnerChecks(registry(["alice"], ["acme-corp"]), env(stub.path));
    const dave = checks.filter(c => c.account === "dave");
    assert.ok(dave.length >= 1 && dave.every(c => c.skipped === true && c.ok));
    assert.equal(checks.some(c => !c.ok && c.account === "dave"), false);
  });
});

describe("ghOwnerChecks — gh absent, logged out, or unlistable", () => {
  it("gh absent -> all three checks are skipped, none fails", () => {
    const empty = join(root, "empty-path");
    mkdirSync(empty, { recursive: true });
    const checks = ghOwnerChecks(registry(["alice"]), env(empty));
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
    const checks = ghOwnerChecks(registry(["alice"]), env(stub.path));
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
    const checks = ghOwnerChecks(registry(["alice"], ["acme-corp"]), env(stub.path));
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
    const checks = ghOwnerChecks(registry(["erin"], ["acme-corp"]), env(stub.path));
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
  writeFileSync(join(aegisHome, "bin", "gh"), GH_SHIM_SCRIPT, { mode: 0o755 });
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
  return { scanRoot: [w.scanRoot], claudeHome: w.claudeHome, homeDir: w.userHome, sshDir: join(w.userHome, ".ssh") };
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
    // They DO appear in the fix lines (that is where the operator types them).
    assert.match(text.stdout, /fix: .*side-project-org/);
    assert.match(text.stdout, /fix: .*customer-b-org/);

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
