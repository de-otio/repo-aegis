// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// Rule h at the git pre-push layer: `check --remote-url`
// (doc/plan-unregistered-owner-egress.md §3.5, §5.3, §8.3).
//
// Placeholder owners only: `acme` (personal), `customer-a-org` (customer),
// `upstream-org/lib` (allowed upstream); `stranger` is registered nowhere.
//
// Everything is local: a temp HOME (a fixture ~/.ssh/config), a temp
// REPO_AEGIS_HOME and registry, temp repos. A fake `ssh` (GIT_SSH_COMMAND)
// serves a local bare repository, so the URLs the pre-push layer is judged on
// are the URLs git REALLY hands the hook after insteadOf / pushInsteadOf /
// pushurl, not URLs this file made up.
import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { captureOutput, withEnv, lastJsonLine, scrubGitEnv, hermeticGitEnv } from "../_test-utils.js";
import { check } from "./check.js";
import { approvalsPath, mintApproval, HOOK_SCRIPTS } from "@de-otio/repo-aegis-core";

let tmp: string;
let originalCwd: string;
let bare: string;
let fakeSsh: string;
let hookDir: string;
let n = 0;

function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: hermeticGitEnv(env),
  });
}

let restoreEnv: () => void;

before(() => {
  // No outer GIT_SSH_COMMAND / GIT_CONFIG_* / user git config: the ssh override
  // check reads them, so a wrapper's values would change what is under test.
  restoreEnv = scrubGitEnv();
  tmp = mkdtempSync(join(tmpdir(), "repo-aegis-check-rule-h-"));
  originalCwd = process.cwd();
  bare = join(tmp, "bare.git");
  mkdirSync(bare);
  git(bare, ["init", "-q", "--bare", "-b", "main"]);
  fakeSsh = join(tmp, "fake-ssh.sh");
  writeFileSync(fakeSsh, `#!/bin/sh\nexec git receive-pack ${JSON.stringify(bare)}\n`);
  chmodSync(fakeSsh, 0o755);
  hookDir = join(tmp, "hooks");
  mkdirSync(hookDir);
  const hook = join(hookDir, "pre-push");
  writeFileSync(hook, `#!/bin/sh\necho "$2" >> "$RECORD"\ncat >/dev/null\nexit 0\n`);
  chmodSync(hook, 0o755);
});

after(() => {
  process.chdir(originalCwd);
  restoreEnv();
  rmSync(tmp, { recursive: true, force: true });
});

afterEach(() => {
  process.chdir(originalCwd);
});

const REGISTRY = `\
always_block: []
personalOrgs:
  - acme
engagements:
  - id: customer-a
    name: Customer A
    githubOrgs:
      - customer-a-org
    markers:
      - customer-a-marker
allowedUpstreams:
  - upstream-org/lib
`;

interface Ctx {
  /** REPO_AEGIS_HOME. */
  home: string;
  /** REPO_AEGIS_REGISTRY. */
  registry: string;
  /** HOME, holding `.ssh/config` when a test writes one. */
  userHome: string;
}

/** A fresh REPO_AEGIS_HOME, HOME and registry. `registry: null` means the file does not exist. */
function setup(name: string, registry: string | null = REGISTRY): Ctx {
  const home = join(tmp, `${name}-home`);
  mkdirSync(join(home, "markers"), { recursive: true });
  mkdirSync(join(home, "state"), { recursive: true });
  writeFileSync(join(home, "markers", "_always.txt"), "leak-token\n");
  const userHome = join(tmp, `${name}-userhome`);
  mkdirSync(join(userHome, ".ssh"), { recursive: true });
  const registryPath = join(tmp, `${name}-registry.yaml`);
  if (registry !== null) writeFileSync(registryPath, registry);
  return { home, registry: registryPath, userHome };
}

function sshConfig(ctx: Ctx, text: string): void {
  writeFileSync(join(ctx.userHome, ".ssh", "config"), text);
}

/** A repo with two clean commits, class private-strict, visibility cached private. */
function makeRepo(name: string, originUrl: string, config: Array<[string, string]> = []): string {
  const dir = join(tmp, name);
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  git(dir, ["config", "repo-aegis.class", "private-strict"]);
  git(dir, ["config", "repo-aegis.visibility", "private"]);
  git(dir, ["config", "remote.origin.url", originUrl]);
  for (const [k, v] of config) git(dir, ["config", "--add", k, v]);
  writeFileSync(join(dir, "a.txt"), "first\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "first"]);
  writeFileSync(join(dir, "b.txt"), "second\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "second"]);
  return dir;
}

/** What git REALLY hands the pre-push hook for `git push --dry-run <remote> main`, one entry per push URL. */
function urlsGitHandsPrePush(repo: string, remote: string): string[] {
  const record = join(tmp, `record-${n++}.txt`);
  writeFileSync(record, "");
  git(repo, ["-c", `core.hooksPath=${hookDir}`, "push", "--dry-run", remote, "main"], {
    GIT_SSH_COMMAND: fakeSsh,
    RECORD: record,
  });
  return readFileSync(record, "utf8").split("\n").filter(Boolean);
}

/** Pin stderr's TTY-ness: `isHumanPresent` tests it. */
function withStderrTty<T>(isTty: boolean, fn: () => T): T {
  const desc = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");
  Object.defineProperty(process.stderr, "isTTY", { value: isTty, configurable: true, writable: true });
  try {
    return fn();
  } finally {
    if (desc) Object.defineProperty(process.stderr, "isTTY", desc);
    else delete (process.stderr as { isTTY?: boolean }).isTTY;
  }
}

/** `check --remote-url <url>` as the pre-push hook runs it, non-interactive unless told otherwise. */
function pushCheck(
  ctx: Ctx,
  repo: string,
  remoteUrl: string,
  env: { tty?: boolean; human?: string; lookup?: () => null } = {},
): ReturnType<typeof captureOutput> {
  return withEnv("HOME", ctx.userHome, () =>
    withEnv("REPO_AEGIS_HOME", ctx.home, () =>
      withEnv("REPO_AEGIS_REGISTRY", ctx.registry, () =>
        withEnv("REPO_AEGIS_EGRESS_HUMAN", env.human, () =>
          withEnv("REPO_AEGIS_VISIBILITY_LOOKUP", "0", () =>
            withStderrTty(env.tty ?? false, () =>
              captureOutput(() =>
                check({
                  cwd: repo,
                  pushRef: "refs/heads/main",
                  remoteUrl,
                  json: true,
                  ...(env.lookup !== undefined && { lookupVisibility: env.lookup }),
                }),
              ),
            ),
          ),
        ),
      ),
    ),
  );
}

interface Refusal {
  code: string;
  error: string;
  details: { destination?: string; ref?: string; ruleH?: string };
}

function refusalOf(r: ReturnType<typeof captureOutput>): Refusal {
  assert.equal(r.exitCode, 2, r.stderr);
  return lastJsonLine<Refusal>(r.stderr);
}

describe("pre-push rule h — an unregistered owner is refused with no person present", () => {
  it("refuses a push to `stranger/r` with UNREGISTERED_OWNER_EGRESS, naming only the destination", () => {
    const ctx = setup("h-refuse");
    const repo = makeRepo("h-refuse-repo", "git@github.com:acme/x.git");
    const r = refusalOf(pushCheck(ctx, repo, "git@github.com:stranger/r.git"));
    assert.equal(r.code, "UNREGISTERED_OWNER_EGRESS");
    assert.match(r.error, /stranger\/r/);
    // The five-part shape (§3.9): what, why, approval, fix + who, where.
    assert.match(r.error, /^git push → stranger\/r: refused\./);
    assert.equal(r.details.ref, "refs/heads/main");
    assert.match(r.error, /No approval covers this/);
    assert.match(r.error, /a person runs, from a terminal: repo-aegis engagements add --personal-org stranger/);
    assert.match(r.error, /Agents: do not run that yourself/);
    assert.match(r.error, /\[UNREGISTERED_OWNER_EGRESS, see doc\/agent-guide\.md#unregistered_owner_egress\]/);
    assert.equal(r.details.destination, "stranger/r");
    assert.equal(r.details.ruleH, "applied");
  });

  it("is decided before the visibility lookup: no `gh repo view` goes to the owner it refuses", () => {
    const ctx = setup("h-no-lookup");
    const repo = makeRepo("h-no-lookup-repo", "git@github.com:acme/x.git");
    let asked = 0;
    const r = pushCheck(ctx, repo, "git@github.com:stranger/r.git", {
      lookup: () => {
        asked++;
        return null;
      },
    });
    assert.equal(refusalOf(r).code, "UNREGISTERED_OWNER_EGRESS");
    assert.equal(asked, 0);
  });

  it("is decided before the cross-org rule: the code is rule h's, not CROSS_ORG_PUSH", () => {
    const ctx = setup("h-before-cross");
    const repo = makeRepo("h-before-cross-repo", "git@github.com:acme/x.git");
    assert.equal(refusalOf(pushCheck(ctx, repo, "git@github.com:stranger/r.git")).code, "UNREGISTERED_OWNER_EGRESS");
  });

  it("no approval covers it: not stranger/r, not stranger/*, not `*`", () => {
    const ctx = setup("h-approvals");
    const repo = makeRepo("h-approvals-repo", "git@github.com:acme/x.git");
    const path = approvalsPath(ctx.home);
    for (const target of [
      { org: "stranger", repo: "r" },
      { org: "stranger", repo: "*" },
      { org: "*", repo: "*" },
    ]) {
      mintApproval({ target, path });
      assert.equal(
        refusalOf(pushCheck(ctx, repo, "git@github.com:stranger/r.git")).code,
        "UNREGISTERED_OWNER_EGRESS",
        JSON.stringify(target),
      );
    }
  });

  it("a registered owner passes rule h (personal org, customer org, same-origin push)", () => {
    const ctx = setup("h-registered");
    const same = makeRepo("h-registered-same", "git@github.com:acme/x.git");
    const ok = pushCheck(ctx, same, "git@github.com:acme/x.git");
    assert.equal(ok.exitCode, undefined, ok.stderr);
    assert.match(ok.stderr, /repo-aegis: pushing refs\/heads\/main → acme\/x/);

    // A registered customer owner is not refused by rule h; the cross-org rule still judges it.
    const r = refusalOf(pushCheck(ctx, same, "git@github.com:customer-a-org/svc.git"));
    assert.equal(r.code, "CROSS_ORG_PUSH");
  });

  it("an owner is matched case-insensitively", () => {
    const ctx = setup("h-case");
    const repo = makeRepo("h-case-repo", "git@github.com:acme/x.git");
    const ok = pushCheck(ctx, repo, "git@github.com:ACME/x.git");
    assert.equal(ok.exitCode, undefined, ok.stderr);
    assert.equal(refusalOf(pushCheck(ctx, repo, "git@github.com:STRANGER/r.git")).code, "UNREGISTERED_OWNER_EGRESS");
  });

  it("an allowed upstream does NOT lift rule h for git push (PRs and issues only)", () => {
    const ctx = setup("h-upstream");
    const repo = makeRepo("h-upstream-repo", "git@github.com:acme/x.git");
    const r = refusalOf(pushCheck(ctx, repo, "git@github.com:upstream-org/lib.git"));
    assert.equal(r.code, "UNREGISTERED_OWNER_EGRESS");
    assert.match(r.error, /allowed upstream/);
    assert.match(r.error, /not git push/);
  });

  it("a person present passes rule h: a TTY on stderr, or REPO_AEGIS_EGRESS_HUMAN=1", () => {
    const ctx = setup("h-human");
    const repo = makeRepo("h-human-repo", "git@github.com:stranger/r.git");
    const tty = pushCheck(ctx, repo, "git@github.com:stranger/r.git", { tty: true });
    assert.equal(tty.exitCode, undefined, tty.stderr);
    const human = pushCheck(ctx, repo, "git@github.com:stranger/r.git", { human: "1" });
    assert.equal(human.exitCode, undefined, human.stderr);
  });
});

describe("pre-push rule h — registry states match the hook and the shim (D4)", () => {
  const STRANGER = "git@github.com:stranger/r.git";

  it("no registry file: rule h is skipped, and says so", () => {
    const ctx = setup("s-missing", null);
    const repo = makeRepo("s-missing-repo", STRANGER);
    const r = pushCheck(ctx, repo, STRANGER);
    assert.equal(r.exitCode, undefined, r.stderr);
    assert.match(r.stderr, /rule h \(unregistered-owner check\) skipped: no registry file exists/);
  });

  it("a registry that declares no owners: rule h is skipped, and says so", () => {
    const ctx = setup("s-no-owners", "schemaVersion: 2\nengagements: []\n");
    const repo = makeRepo("s-no-owners-repo", STRANGER);
    const r = pushCheck(ctx, repo, STRANGER);
    assert.equal(r.exitCode, undefined, r.stderr);
    assert.match(r.stderr, /rule h \(unregistered-owner check\) skipped: the registry declares no owners/);
  });

  it("an unparseable registry refuses, and says it could not be read", () => {
    const ctx = setup("s-corrupt", "engagements: [\n");
    const repo = makeRepo("s-corrupt-repo", STRANGER);
    const r = refusalOf(pushCheck(ctx, repo, STRANGER));
    assert.equal(r.code, "UNREGISTERED_OWNER_EGRESS");
    assert.match(r.error, /registry could not be read/);
    assert.equal(r.details.ruleH, "applied");
  });

  it("an encrypted registry (ciphertext only) refuses, even for an owner it would have listed", () => {
    const ctx = setup("s-encrypted", null);
    writeFileSync(`${ctx.registry}.age`, "age-encryption.org/v1\n");
    const repo = makeRepo("s-encrypted-repo", "git@github.com:acme/x.git");
    const r = refusalOf(pushCheck(ctx, repo, "git@github.com:acme/x.git"));
    assert.equal(r.code, "UNREGISTERED_OWNER_EGRESS");
    assert.match(r.error, /registry could not be read/);
  });

  it("a registry from a newer schema is unreadable, so it refuses", () => {
    const ctx = setup("s-newer", "schemaVersion: 99\nengagements: []\n");
    const repo = makeRepo("s-newer-repo", STRANGER);
    assert.equal(refusalOf(pushCheck(ctx, repo, STRANGER)).code, "UNREGISTERED_OWNER_EGRESS");
  });

  it("an unreadable registry does not refuse a person at a terminal", () => {
    const ctx = setup("s-corrupt-human", "engagements: [\n");
    const repo = makeRepo("s-corrupt-human-repo", STRANGER);
    const r = pushCheck(ctx, repo, STRANGER, { tty: true });
    assert.equal(r.exitCode, undefined, r.stderr);
  });

  it("an unreadable registry still lets a non-GitHub destination through (no destination, no rule)", () => {
    const ctx = setup("s-corrupt-nongithub", "engagements: [\n");
    const repo = makeRepo("s-corrupt-nongithub-repo", STRANGER);
    const r = pushCheck(ctx, repo, "https://gitlab.example/stranger/r.git");
    assert.equal(r.exitCode, undefined, r.stderr);
  });
});

describe("pre-push rule h — URL rewriting: judged on the URL git actually hands the hook", () => {
  it("insteadOf rewrites a registered fetch URL to a stranger: the hook sees the stranger, and refuses", () => {
    const ctx = setup("r-instead");
    const repo = makeRepo("r-instead-repo", "https://github.com/acme/x.git", [
      ["url.git@github.com:stranger/.insteadOf", "https://github.com/acme/"],
    ]);
    const handed = urlsGitHandsPrePush(repo, "origin");
    assert.deepEqual(handed, ["git@github.com:stranger/x.git"]);
    assert.equal(refusalOf(pushCheck(ctx, repo, handed[0]!)).code, "UNREGISTERED_OWNER_EGRESS");
  });

  it("control: without the rewrite the same push is to the registered owner and passes", () => {
    const ctx = setup("r-instead-control");
    const repo = makeRepo("r-instead-control-repo", "git@github.com:acme/x.git");
    const handed = urlsGitHandsPrePush(repo, "origin");
    assert.deepEqual(handed, ["git@github.com:acme/x.git"]);
    const r = pushCheck(ctx, repo, handed[0]!);
    assert.equal(r.exitCode, undefined, r.stderr);
  });

  it("pushInsteadOf differs from the fetch URL: the hook sees the stranger, and refuses", () => {
    const ctx = setup("r-pushinstead");
    const repo = makeRepo("r-pushinstead-repo", "git@github.com:acme/x.git", [
      ["url.git@github.com:stranger/.pushInsteadOf", "git@github.com:acme/"],
    ]);
    assert.equal(git(repo, ["remote", "get-url", "origin"]).trim(), "git@github.com:acme/x.git");
    const handed = urlsGitHandsPrePush(repo, "origin");
    assert.deepEqual(handed, ["git@github.com:stranger/x.git"]);
    assert.equal(refusalOf(pushCheck(ctx, repo, handed[0]!)).code, "UNREGISTERED_OWNER_EGRESS");
  });

  it("remote.<name>.pushurl differs from the fetch URL: the hook sees the stranger, and refuses", () => {
    const ctx = setup("r-pushurl");
    const repo = makeRepo("r-pushurl-repo", "git@github.com:acme/x.git", [
      ["remote.origin.pushurl", "git@github.com:stranger/x.git"],
    ]);
    const handed = urlsGitHandsPrePush(repo, "origin");
    assert.deepEqual(handed, ["git@github.com:stranger/x.git"]);
    assert.equal(refusalOf(pushCheck(ctx, repo, handed[0]!)).code, "UNREGISTERED_OWNER_EGRESS");
  });

  it("two push URLs, one registered and one not: the hook runs once per URL, and the stranger's run refuses", () => {
    const ctx = setup("r-two");
    const repo = makeRepo("r-two-repo", "git@github.com:acme/x.git", [
      ["remote.origin.pushurl", "git@github.com:acme/x.git"],
      ["remote.origin.pushurl", "git@github.com:stranger/x.git"],
    ]);
    const handed = urlsGitHandsPrePush(repo, "origin");
    assert.equal(handed.length, 2, "git runs the hook once per push URL");
    const verdicts = handed.map(url => ({ url, r: pushCheck(ctx, repo, url) }));
    const refused = verdicts.filter(v => v.r.exitCode === 2);
    assert.equal(refused.length, 1, JSON.stringify(verdicts.map(v => [v.url, v.r.exitCode])));
    assert.equal(refused[0]!.url, "git@github.com:stranger/x.git");
    assert.equal(lastJsonLine<Refusal>(refused[0]!.r.stderr).code, "UNREGISTERED_OWNER_EGRESS");
  });
});

describe("pre-push rule h — ssh Host aliases, resolved by a pure parser", () => {
  it("an alias whose HostName is github.com is GitHub: a stranger behind it is refused", () => {
    const ctx = setup("a-github");
    sshConfig(ctx, "Host gh-work\n  HostName github.com\n  User git\n");
    const repo = makeRepo("a-github-repo", "git@github.com:acme/x.git");
    const r = refusalOf(pushCheck(ctx, repo, "git@gh-work:stranger/r.git"));
    assert.equal(r.code, "UNREGISTERED_OWNER_EGRESS");
    assert.equal(r.details.destination, "stranger/r");
  });

  it("an alias to github.com for a REGISTERED owner passes rule h, and is judged as that repository", () => {
    const ctx = setup("a-github-ok");
    sshConfig(ctx, "Host gh-work\n  HostName github.com\n");
    const repo = makeRepo("a-github-ok-repo", "git@gh-work:acme/x.git");
    const r = pushCheck(ctx, repo, "git@gh-work:acme/x.git");
    assert.equal(r.exitCode, undefined, r.stderr);
    assert.match(r.stderr, /repo-aegis: pushing refs\/heads\/main → acme\/x/);
  });

  it("ssh.github.com is GitHub too", () => {
    const ctx = setup("a-ssh-github");
    sshConfig(ctx, "Host gh-work\n  HostName ssh.github.com\n  Port 443\n");
    const repo = makeRepo("a-ssh-github-repo", "git@github.com:acme/x.git");
    assert.equal(refusalOf(pushCheck(ctx, repo, "git@gh-work:stranger/r.git")).code, "UNREGISTERED_OWNER_EGRESS");
  });

  it("an alias whose HostName is not GitHub is not GitHub: out of scope, no refusal", () => {
    const ctx = setup("a-other");
    sshConfig(ctx, "Host gh-work\n  HostName git.example.org\n");
    const repo = makeRepo("a-other-repo", "git@github.com:acme/x.git");
    const r = pushCheck(ctx, repo, "git@gh-work:stranger/r.git");
    assert.equal(r.exitCode, undefined, r.stderr);
    assert.doesNotMatch(r.stderr, /pushing/);
  });

  it("an alias behind a Match block is UNRESOLVED and refused; the Match is never executed", () => {
    const ctx = setup("a-match");
    const sentinel = join(tmp, `match-sentinel-${n++}`);
    sshConfig(ctx, `Match exec "touch ${sentinel}"\n  HostName github.com\nHost gh-work\n  HostName github.com\n`);
    const repo = makeRepo("a-match-repo", "git@github.com:acme/x.git");
    const r = refusalOf(pushCheck(ctx, repo, "git@gh-work:stranger/r.git"));
    assert.equal(r.code, "UNREGISTERED_OWNER_EGRESS");
    assert.equal(r.details.destination, "(unresolved)");
    assert.match(r.error, /does not resolve offline/);
    assert.equal(existsSync(sentinel), false, "ssh config must be parsed, never evaluated (no `ssh -G`, no `Match exec`)");
    // The unresolved alias is named nowhere: no alias, no owner in the text.
    assert.doesNotMatch(r.error, /gh-work|stranger/);
  });

  it("an unresolved alias does not refuse a person at a terminal", () => {
    const ctx = setup("a-match-human");
    sshConfig(ctx, `Match exec "true"\n  HostName github.com\n`);
    const repo = makeRepo("a-match-human-repo", "git@github.com:acme/x.git");
    const r = pushCheck(ctx, repo, "git@gh-work:stranger/r.git", { tty: true });
    assert.equal(r.exitCode, undefined, r.stderr);
  });

  it("with no registry, an unresolved alias is skipped like any other destination (rule h is off)", () => {
    const ctx = setup("a-match-missing", null);
    sshConfig(ctx, `Match exec "true"\n  HostName github.com\n`);
    const repo = makeRepo("a-match-missing-repo", "git@github.com:acme/x.git");
    const r = pushCheck(ctx, repo, "git@gh-work:stranger/r.git");
    assert.equal(r.exitCode, undefined, r.stderr);
  });

  it("an alias with no ssh config at all is its own host, so not GitHub", () => {
    const ctx = setup("a-noconfig");
    const repo = makeRepo("a-noconfig-repo", "git@github.com:acme/x.git");
    const r = pushCheck(ctx, repo, "git@gh-work:stranger/r.git");
    assert.equal(r.exitCode, undefined, r.stderr);
  });
});

describe("pre-push rule h — hostile URLs are never mis-attributed", () => {
  const cases: Array<[string, string]> = [
    ["https://github.com/stranger/../acme/x.git", "dot-dot: a registered-looking tail"],
    ["https://github.com/stranger/x%2F..%2F..%2Facme/x", "percent-encoded slashes"],
    ["https://github.com:abc/stranger/x", "a port that is not a number"],
    ["https://a@b@github.com/stranger/x", "two @ in the authority"],
    ["https://github.com/stranger/x/extra", "an extra path segment"],
    ["git@github.com:stranger/x$(id).git", "shell syntax in the repo name"],
    ["git@github.com:str$(id)/x.git", "shell syntax in the owner"],
    ["https://github.com\\@evil.example/acme/x", "a backslash"],
  ];
  for (const [url, why] of cases) {
    it(`${JSON.stringify(url)} is refused as unresolved (${why})`, () => {
      const ctx = setup(`x-${n++}`);
      const repo = makeRepo(`x-repo-${n}`, "git@github.com:acme/x.git");
      const r = refusalOf(pushCheck(ctx, repo, url));
      assert.equal(r.code, "UNREGISTERED_OWNER_EGRESS");
      assert.equal(r.details.destination, "(unresolved)");
      // A name that is not a GitHub name never reaches the output.
      assert.doesNotMatch(r.error, /\$\(id\)|\\|evil/);
    });
  }

  it("a URL on another host is not GitHub, however it spells github.com", () => {
    const ctx = setup("x-other");
    const repo = makeRepo("x-other-repo", "git@github.com:acme/x.git");
    for (const url of [
      "https://github.com.evil.example/stranger/r",
      "https://github.com@evil.example/stranger/r",
      "https://evil.example/github.com/stranger/r",
    ]) {
      const r = pushCheck(ctx, repo, url);
      assert.equal(r.exitCode, undefined, `${url}: ${r.stderr}`);
    }
  });
});

describe("pre-push rule h — redaction: no registry content in any output (§3.9, §8.3)", () => {
  // Every name in the registry fixture. None may reach a refusal for `stranger`.
  const REGISTERED = ["acme", "customer-a", "customer-a-org", "customer-a-marker", "upstream-org", "lib"];

  function assertNoRegistryContent(label: string, out: ReturnType<typeof captureOutput>): void {
    for (const name of REGISTERED) {
      assert.ok(!out.stderr.includes(name), `${label}: stderr leaks registry entry "${name}":\n${out.stderr}`);
      assert.ok(!out.stdout.includes(name), `${label}: stdout leaks registry entry "${name}"`);
    }
  }

  it("a refusal for a stranger names the stranger and nothing the registry holds", () => {
    const ctx = setup("red-owner");
    // The pushing repo's own origin is a registered owner: even that must not appear.
    const repo = makeRepo("red-owner-repo", "git@github.com:acme/x.git");
    const r = pushCheck(ctx, repo, "git@github.com:stranger/r.git");
    assert.equal(refusalOf(r).code, "UNREGISTERED_OWNER_EGRESS");
    assertNoRegistryContent("owner refusal", r);
  });

  it("an unresolved URL's refusal carries no registry content either", () => {
    const ctx = setup("red-unresolved");
    const repo = makeRepo("red-unresolved-repo", "git@github.com:acme/x.git");
    const r = pushCheck(ctx, repo, "https://github.com/stranger/../r");
    assert.equal(refusalOf(r).code, "UNREGISTERED_OWNER_EGRESS");
    assertNoRegistryContent("unresolved refusal", r);
  });

  it("an unreadable registry's refusal carries no registry content", () => {
    const ctx = setup("red-unreadable", "engagements: [\n  - id: customer-a\n");
    const repo = makeRepo("red-unreadable-repo", "git@github.com:acme/x.git");
    const r = pushCheck(ctx, repo, "git@github.com:stranger/r.git");
    assert.equal(refusalOf(r).code, "UNREGISTERED_OWNER_EGRESS");
    assertNoRegistryContent("unreadable refusal", r);
  });

  it("the cross-org refusal no longer enumerates the trust boundary (it can hold customer orgs)", () => {
    const ctx = setup("red-cross");
    // The boundary here is the customer engagement's org set.
    const repo = makeRepo("red-cross-repo", "git@github.com:customer-a-org/svc.git");
    git(repo, ["config", "repo-aegis.class", "customer-coupled"]);
    git(repo, ["config", "repo-aegis.engagement", "customer-a"]);
    const r = pushCheck(ctx, repo, "git@github.com:acme/other.git");
    const j = refusalOf(r);
    assert.equal(j.code, "CROSS_ORG_PUSH");
    assert.match(j.error, /acme\/other/);
    for (const name of ["customer-a", "customer-a-org", "customer-a-marker", "upstream-org"]) {
      assert.ok(!r.stderr.includes(name), `cross-org refusal leaks "${name}": ${r.stderr}`);
    }
    assert.equal((j.details as { boundaryOrgs?: unknown }).boundaryOrgs, undefined);
  });
});

describe("pre-push rule h — bracketed hosts (C1): git strips the brackets, so must the guard", () => {
  const BRACKETED = [
    "[github.com]:stranger/r.git",
    "git@[github.com]:stranger/r.git",
    "[github.com:22]:stranger/r.git",
    "ssh://[github.com]/stranger/r.git",
    "ssh://git@[github.com]/stranger/r.git",
  ];
  for (const url of BRACKETED) {
    it(`${JSON.stringify(url)} is judged as github.com/stranger/r, and refused`, () => {
      const ctx = setup(`c1-${n++}`);
      const repo = makeRepo(`c1-repo-${n}`, "git@github.com:acme/x.git");
      const r = refusalOf(pushCheck(ctx, repo, url));
      assert.equal(r.code, "UNREGISTERED_OWNER_EGRESS");
      assert.equal(r.details.destination, "stranger/r");
    });
  }

  it("git really hands the hook the bracketed URL and really pushes through it", () => {
    const ctx = setup("c1-real");
    const repo = makeRepo("c1-real-repo", "git@github.com:acme/x.git");
    const handed = urlsGitHandsPrePush(repo, "[github.com]:stranger/r.git");
    assert.deepEqual(handed, ["[github.com]:stranger/r.git"]);
    assert.equal(refusalOf(pushCheck(ctx, repo, handed[0]!)).code, "UNREGISTERED_OWNER_EGRESS");
  });

  it("a registered owner behind brackets passes rule h", () => {
    const ctx = setup("c1-ok");
    const repo = makeRepo("c1-ok-repo", "git@github.com:acme/x.git");
    const r = pushCheck(ctx, repo, "ssh://git@[github.com]/acme/x.git");
    assert.equal(r.exitCode, undefined, r.stderr);
  });

  it("an IP literal in brackets is unresolved and refused", () => {
    const ctx = setup("c1-ip");
    const repo = makeRepo("c1-ip-repo", "git@github.com:acme/x.git");
    const r = refusalOf(pushCheck(ctx, repo, "ssh://git@[2001:db8::1]/acme/x.git"));
    assert.equal(r.code, "UNREGISTERED_OWNER_EGRESS");
    assert.equal(r.details.destination, "(unresolved)");
    assert.match(r.error, /IP address/);
  });
});

describe("pre-push rule h — an ssh override makes aliases unresolved (H2)", () => {
  it("GIT_SSH_COMMAND, GIT_SSH and GIT_SSH_VARIANT each do, for an alias that would resolve to GitHub", () => {
    for (const name of ["GIT_SSH_COMMAND", "GIT_SSH", "GIT_SSH_VARIANT"]) {
      const ctx = setup(`h2-env-${name}`);
      sshConfig(ctx, "Host gh-work\n  HostName github.com\n");
      const repo = makeRepo(`h2-env-${name}-repo`, "git@github.com:acme/x.git");
      const r = refusalOf(withEnv(name, "ssh", () => pushCheck(ctx, repo, "git@gh-work:acme/x.git")));
      assert.equal(r.code, "UNREGISTERED_OWNER_EGRESS", name);
      assert.equal(r.details.destination, "(unresolved)");
      assert.match(r.error, /ssh override/);
    }
  });

  it("core.sshCommand in the git config does too, even for a REGISTERED owner behind the alias", () => {
    const ctx = setup("h2-config");
    sshConfig(ctx, "Host gh-work\n  HostName github.com\n");
    const repo = makeRepo("h2-config-repo", "git@github.com:acme/x.git", [["core.sshCommand", "ssh -i /nowhere/key"]]);
    assert.equal(refusalOf(pushCheck(ctx, repo, "git@gh-work:acme/x.git")).code, "UNREGISTERED_OWNER_EGRESS");
  });

  it("a LITERAL github.com host with a plain `ssh -i key` override is still judged (a registered owner passes)", () => {
    const ctx = setup("h2-literal");
    const repo = makeRepo("h2-literal-repo", "git@github.com:acme/x.git", [["core.sshCommand", "ssh -i /nowhere/key"]]);
    const ok = pushCheck(ctx, repo, "git@github.com:acme/x.git");
    assert.equal(ok.exitCode, undefined, ok.stderr);
    assert.equal(refusalOf(pushCheck(ctx, repo, "git@github.com:stranger/r.git")).details.destination, "stranger/r");
  });

  it("…but not when the override can move the connection (-o HostName, a proxy, -J, -F, GIT_SSH)", () => {
    for (const cmd of ["ssh -o HostName=elsewhere.example", "ssh -o ProxyCommand=nc", "ssh -J jump", "ssh -F /x/config"]) {
      const ctx = setup(`h2-redirect-${n++}`);
      const repo = makeRepo(`h2-redirect-repo-${n}`, "git@github.com:acme/x.git", [["core.sshCommand", cmd]]);
      const r = refusalOf(pushCheck(ctx, repo, "git@github.com:acme/x.git"));
      assert.equal(r.details.destination, "(unresolved)", cmd);
    }
    const ctx = setup("h2-redirect-gitssh");
    const repo = makeRepo("h2-redirect-gitssh-repo", "git@github.com:acme/x.git");
    const r = refusalOf(withEnv("GIT_SSH", "/nowhere/wrapper", () => pushCheck(ctx, repo, "git@github.com:acme/x.git")));
    assert.equal(r.details.destination, "(unresolved)");
  });

  it("https is untouched by an ssh override", () => {
    const ctx = setup("h2-https");
    const repo = makeRepo("h2-https-repo", "git@github.com:acme/x.git", [["core.sshCommand", "ssh -J jump"]]);
    const r = pushCheck(ctx, repo, "https://github.com/acme/x.git");
    assert.equal(r.exitCode, undefined, r.stderr);
  });

  it("an ssh config with a ProxyCommand for the alias is unresolved", () => {
    const ctx = setup("h2-proxy");
    sshConfig(ctx, "Host gh-work\n  HostName github.com\n  ProxyCommand nc evil.example 22\n");
    const repo = makeRepo("h2-proxy-repo", "git@github.com:acme/x.git");
    assert.equal(refusalOf(pushCheck(ctx, repo, "git@gh-work:acme/x.git")).details.destination, "(unresolved)");
  });

  it("a Match doubt says so in the refusal text", () => {
    const ctx = setup("h2-match-text");
    sshConfig(ctx, `Match exec "true"\n  HostName github.com\n`);
    const repo = makeRepo("h2-match-text-repo", "git@github.com:acme/x.git");
    const r = refusalOf(pushCheck(ctx, repo, "git@gh-work:acme/x.git"));
    assert.match(r.error, /Match block/);
  });
});

describe("pre-push refusals — the CROSS_ORG person-fix and the `*` approval sentence", () => {
  it("the CROSS_ORG_PUSH fix never suggests adding the destination owner to an engagement (L3)", () => {
    const ctx = setup("l3");
    const repo = makeRepo("l3-repo", "git@github.com:acme/x.git");
    const r = refusalOf(pushCheck(ctx, repo, "git@github.com:customer-a-org/svc.git"));
    assert.equal(r.code, "CROSS_ORG_PUSH");
    assert.doesNotMatch(r.error, /engagements add|--github-org|--personal-org/);
    assert.match(r.error, /inside this repository's trust boundary/);
    assert.match(r.error, /repo-aegis classify/);
  });

  it("a live `*` approval that does not cover a customer destination is named, as the hook does (D7)", () => {
    const ctx = setup("star-customer");
    const repo = makeRepo("star-customer-repo", "git@github.com:customer-a-org/svc.git");
    git(repo, ["config", "repo-aegis.class", "customer-coupled"]);
    git(repo, ["config", "repo-aegis.engagement", "customer-a"]);
    const star = mintApproval({ target: { org: "*", repo: "*" }, path: approvalsPath(ctx.home) });
    const r = refusalOf(pushCheck(ctx, repo, "git@github.com:customer-a-org/other.git"));
    assert.equal(r.code, "PUBLIC_PUSH_NEEDS_HUMAN");
    assert.match(r.error, new RegExp(`A '\\*' approval \\(${star.id}, until `));
    assert.match(r.error, /customer-a-org is a customer org/);
    assert.match(r.error, /repo-aegis approve 'customer-a-org\/\*'/);
  });

  it("a `*` approval still covers a personal-org destination", () => {
    const ctx = setup("star-personal");
    const repo = makeRepo("star-personal-repo", "git@github.com:acme/x.git");
    const star = mintApproval({ target: { org: "*", repo: "*" }, path: approvalsPath(ctx.home) });
    const r = pushCheck(ctx, repo, "git@github.com:acme/other.git");
    assert.equal(r.exitCode, undefined, r.stderr);
    assert.match(r.stderr, new RegExp(`human approval ${star.id} stands in`));
  });

  it("with no `*` approval the refusal does not claim one exists", () => {
    const ctx = setup("star-none");
    const repo = makeRepo("star-none-repo", "git@github.com:acme/x.git");
    const r = refusalOf(pushCheck(ctx, repo, "git@github.com:acme/other.git"));
    assert.equal(r.code, "PUBLIC_PUSH_NEEDS_HUMAN");
    assert.doesNotMatch(r.error, /'\*' approval/);
  });
});

describe("pre-push rule h — the shipped pre-push hook script, end to end (L4)", () => {
  let binDir: string;
  before(() => {
    binDir = join(tmp, "bin");
    mkdirSync(binDir);
    const cli = fileURLToPath(new URL("../index.js", import.meta.url));
    writeFileSync(
      join(binDir, "repo-aegis"),
      `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(cli)} "$@"\n`,
    );
    chmodSync(join(binDir, "repo-aegis"), 0o755);
    mkdirSync(join(tmp, "shipped-hooks"));
    writeFileSync(join(tmp, "shipped-hooks", "pre-push"), HOOK_SCRIPTS["pre-push"]);
    chmodSync(join(tmp, "shipped-hooks", "pre-push"), 0o755);
  });

  /** Run the REAL `git push` with the shipped hook; returns the exit status and stderr. */
  function realPush(ctx: Ctx, repo: string, remote: string): { status: number; stderr: string } {
    try {
      execFileSync("git", ["-c", `core.hooksPath=${join(tmp, "shipped-hooks")}`, "push", remote, "main"], {
        cwd: repo,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: hermeticGitEnv({
          PATH: `${binDir}:${process.env["PATH"] ?? ""}`,
          GIT_SSH_COMMAND: fakeSsh,
          HOME: ctx.userHome,
          REPO_AEGIS_HOME: ctx.home,
          REPO_AEGIS_REGISTRY: ctx.registry,
          REPO_AEGIS_VISIBILITY_LOOKUP: "0",
        }),
      });
      return { status: 0, stderr: "" };
    } catch (err) {
      const e = err as { status?: number; stderr?: string };
      return { status: e.status ?? 1, stderr: String(e.stderr ?? "") };
    }
  }

  it("a push to a registered owner goes through", () => {
    const ctx = setup("e2e-ok");
    const repo = makeRepo("e2e-ok-repo", "git@github.com:acme/x.git");
    const r = realPush(ctx, repo, "origin");
    assert.equal(r.status, 0, r.stderr);
  });

  it("a push to an unregistered owner is refused by the hook, whatever git was told to rewrite", () => {
    const ctx = setup("e2e-refused");
    const repo = makeRepo("e2e-refused-repo", "git@github.com:acme/x.git", [
      ["url.git@github.com:stranger/.pushInsteadOf", "git@github.com:acme/"],
    ]);
    const r = realPush(ctx, repo, "origin");
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /UNREGISTERED_OWNER_EGRESS/);
    assert.match(r.stderr, /stranger\/x/);
  });

  it("a push through a bracketed URL is refused by the hook (C1)", () => {
    const ctx = setup("e2e-bracket");
    const repo = makeRepo("e2e-bracket-repo", "git@github.com:acme/x.git");
    const r = realPush(ctx, repo, "[github.com]:stranger/r.git");
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /UNREGISTERED_OWNER_EGRESS/);
  });
});
