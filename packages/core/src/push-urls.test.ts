// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// The URL(s) `git push <remote>` writes to (doc/plan-unregistered-owner-egress.md
// §3.3 item 5, §8.4 F7), and the claim the pre-push layer rests on: git hands
// the pre-push hook the URL AFTER every rewrite, once per push URL.
//
// Temp repos only; HOME and REPO_AEGIS_HOME point at temp dirs. No network:
// a fake `ssh` (GIT_SSH_COMMAND) answers `git-receive-pack` from a local bare
// repository, so a push to a GitHub-shaped URL runs for real and the pre-push
// hook really fires.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePushUrls, detectSshOverride } from "./push-urls.js";
import { defaultSshDir, setDefaultSshDirForTests } from "./ssh-config.js";
import { userInfo } from "node:os";
import { hermeticGitEnv, scrubGitEnv } from "./_test-git-env.js";
import {
  decideEgress,
  describeDestination,
  describeDestinationForReceipt,
  resolveDestinationOffline,
} from "./egress-policy.js";
import type { Registry } from "./registry.js";
import { parseEgressIntents } from "./egress-intent.js";

let root: string;
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
  restoreEnv = scrubGitEnv();
  root = mkdtempSync(join(tmpdir(), "repo-aegis-push-urls-"));
  bare = join(root, "bare.git");
  mkdirSync(bare);
  git(bare, ["init", "-q", "--bare", "-b", "main"]);
  // A fake ssh: whatever host and command git asks for, serve the local bare repo.
  fakeSsh = join(root, "fake-ssh.sh");
  writeFileSync(fakeSsh, `#!/bin/sh\nexec git receive-pack ${JSON.stringify(bare)}\n`);
  chmodSync(fakeSsh, 0o755);
  // A pre-push hook that records the URL it was handed ($2), one line per run.
  hookDir = join(root, "hooks");
  mkdirSync(hookDir);
  const hook = join(hookDir, "pre-push");
  writeFileSync(hook, `#!/bin/sh\necho "$2" >> "$RECORD"\ncat >/dev/null\nexit 0\n`);
  chmodSync(hook, 0o755);
});

after(() => {
  restoreEnv();
  rmSync(root, { recursive: true, force: true });
});

/** A repo with one commit and `config` applied via `git config` calls. */
function makeRepo(config: Array<[string, string]> = []): string {
  const dir = join(root, `repo-${n++}`);
  mkdirSync(dir);
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "t@example.com"]);
  git(dir, ["config", "user.name", "T"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  writeFileSync(join(dir, "a.txt"), "a\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "a"]);
  for (const [k, v] of config) git(dir, ["config", "--add", k, v]);
  return dir;
}

/** What git REALLY hands the pre-push hook for `git push --dry-run <remote> main`. */
function urlsGitHandsPrePush(repo: string, remote: string): string[] {
  const record = join(root, `record-${n++}.txt`);
  writeFileSync(record, "");
  git(repo, ["-c", `core.hooksPath=${hookDir}`, "push", "--dry-run", remote, "main"], {
    GIT_SSH_COMMAND: fakeSsh,
    RECORD: record,
  });
  return readFileSync(record, "utf8").split("\n").filter(Boolean);
}

describe("resolvePushUrls agrees with what git hands the pre-push hook", () => {
  it("plain remote: the fetch URL", () => {
    const repo = makeRepo([["remote.origin.url", "git@github.com:acme/x.git"]]);
    const real = urlsGitHandsPrePush(repo, "origin");
    assert.deepEqual(real, ["git@github.com:acme/x.git"]);
    assert.deepEqual(resolvePushUrls(repo, "origin"), real);
  });

  it("insteadOf rewrites the push URL: the hook gets the REWRITTEN URL", () => {
    const repo = makeRepo([
      ["remote.origin.url", "https://github.com/acme/x.git"],
      ["url.git@github.com:stranger/.insteadOf", "https://github.com/acme/"],
    ]);
    const real = urlsGitHandsPrePush(repo, "origin");
    assert.deepEqual(real, ["git@github.com:stranger/x.git"]);
    assert.deepEqual(resolvePushUrls(repo, "origin"), real);
  });

  it("pushInsteadOf rewrites the push URL only (the fetch URL stays acme)", () => {
    const repo = makeRepo([
      ["remote.origin.url", "git@github.com:acme/x.git"],
      ["url.git@github.com:stranger/.pushInsteadOf", "git@github.com:acme/"],
    ]);
    assert.equal(git(repo, ["remote", "get-url", "origin"]).trim(), "git@github.com:acme/x.git");
    const real = urlsGitHandsPrePush(repo, "origin");
    assert.deepEqual(real, ["git@github.com:stranger/x.git"]);
    assert.deepEqual(resolvePushUrls(repo, "origin"), real);
  });

  it("remote.<name>.pushurl differs from the fetch URL", () => {
    const repo = makeRepo([
      ["remote.origin.url", "git@github.com:acme/x.git"],
      ["remote.origin.pushurl", "git@github.com:stranger/x.git"],
    ]);
    const real = urlsGitHandsPrePush(repo, "origin");
    assert.deepEqual(real, ["git@github.com:stranger/x.git"]);
    assert.deepEqual(resolvePushUrls(repo, "origin"), real);
  });

  it("two push URLs: the hook runs once per URL, and both are returned", () => {
    const repo = makeRepo([
      ["remote.origin.url", "git@github.com:acme/x.git"],
      ["remote.origin.pushurl", "git@github.com:acme/x.git"],
      ["remote.origin.pushurl", "git@github.com:stranger/x.git"],
    ]);
    const real = urlsGitHandsPrePush(repo, "origin");
    assert.deepEqual([...real].sort(), ["git@github.com:acme/x.git", "git@github.com:stranger/x.git"]);
    assert.deepEqual([...(resolvePushUrls(repo, "origin") ?? [])].sort(), [...real].sort());
  });

  it("a URL given directly: $1 and $2 are that URL, rewritten like a remote's", () => {
    const repo = makeRepo([["url.git@github.com:stranger/.pushInsteadOf", "git@github.com:acme/"]]);
    const real = urlsGitHandsPrePush(repo, "git@github.com:acme/x.git");
    assert.deepEqual(real, ["git@github.com:stranger/x.git"]);
    assert.deepEqual(resolvePushUrls(repo, "git@github.com:acme/x.git"), real);
  });

  it("a URL given directly with only insteadOf set", () => {
    const repo = makeRepo([["url.git@github.com:stranger/.insteadOf", "git@github.com:acme/"]]);
    const real = urlsGitHandsPrePush(repo, "git@github.com:acme/x.git");
    assert.deepEqual(real, ["git@github.com:stranger/x.git"]);
    assert.deepEqual(resolvePushUrls(repo, "git@github.com:acme/x.git"), real);
  });

  it("pushInsteadOf beats insteadOf, and the longest prefix wins", () => {
    const repo = makeRepo([
      ["url.git@github.com:short/.insteadOf", "git@github.com:acme/"],
      ["url.git@github.com:stranger/.pushInsteadOf", "git@github.com:acme/"],
      ["url.git@github.com:longer/.pushInsteadOf", "git@github.com:acme/x"],
    ]);
    const real = urlsGitHandsPrePush(repo, "git@github.com:acme/x.git");
    assert.deepEqual(real, ["git@github.com:longer/.git"]);
    assert.deepEqual(resolvePushUrls(repo, "git@github.com:acme/x.git"), real);
  });
});

describe("resolvePushUrls — what is not a remote", () => {
  it("a local path or an unknown name resolves to nothing", () => {
    const repo = makeRepo();
    assert.equal(resolvePushUrls(repo, "../somewhere"), null);
    assert.equal(resolvePushUrls(repo, "no-such-remote"), null);
  });

  it("outside any repository, a URL is still rewritten against the global config, and a name is null", () => {
    const outside = join(root, "not-a-repo");
    mkdirSync(outside);
    assert.deepEqual(resolvePushUrls(outside, "git@github.com:acme/x.git"), ["git@github.com:acme/x.git"]);
    assert.equal(resolvePushUrls(outside, "origin"), null);
  });

  it("a configured remote wins over a URL-shaped reading of its name (git's precedence)", () => {
    const repo = makeRepo([["remote.git@github.com:acme/x.git.url", "git@github.com:stranger/x.git"]]);
    // A remote whose NAME looks like a URL but is configured: git pushes to its configured URL.
    assert.deepEqual(resolvePushUrls(repo, "git@github.com:acme/x.git"), ["git@github.com:stranger/x.git"]);
  });

  it("an option-shaped remote name cannot be read as a flag", () => {
    const repo = makeRepo();
    assert.equal(resolvePushUrls(repo, "--all"), null);
  });
});

describe("resolveDestinationOffline for `git push <remote>` uses the push URLs", () => {
  function destFor(repo: string, command: string): ReturnType<typeof resolveDestinationOffline> {
    const intents = parseEgressIntents(command);
    assert.equal(intents.length, 1, command);
    return resolveDestinationOffline(intents[0]!, repo);
  }

  it("a pushurl that differs from the fetch URL decides the destination", () => {
    const repo = makeRepo([
      ["remote.origin.url", "git@github.com:acme/x.git"],
      ["remote.origin.pushurl", "git@github.com:stranger/x.git"],
    ]);
    const d = destFor(repo, "git push origin main");
    assert.equal(d?.org, "stranger");
    assert.equal(d?.repo, "x");
  });

  it("several push URLs: the first leads, the rest are carried so rule h can require all of them", () => {
    const repo = makeRepo([
      ["remote.origin.url", "git@github.com:acme/x.git"],
      ["remote.origin.pushurl", "git@github.com:acme/x.git"],
      ["remote.origin.pushurl", "git@github.com:stranger/y.git"],
    ]);
    const d = destFor(repo, "git push origin main");
    assert.equal(d?.org, "acme");
    assert.deepEqual(
      d?.alsoTargets?.map(t => `${t.org}/${t.repo}`),
      ["stranger/y"],
    );
  });

  it("an insteadOf rewrite to another owner decides the destination", () => {
    const repo = makeRepo([
      ["remote.origin.url", "https://github.com/acme/x.git"],
      ["url.git@github.com:stranger/.insteadOf", "https://github.com/acme/"],
    ]);
    assert.equal(destFor(repo, "git push origin main")?.org, "stranger");
  });

  it("a push URL that is URL-shaped but not cleanly GitHub is an unresolved destination, not none", () => {
    const repo = makeRepo([["remote.origin.url", "https://github.com/stranger/../acme/x.git"]]);
    const d = destFor(repo, "git push origin main");
    assert.equal(d?.unresolved, "opaque-url");
  });

  it("a local-path remote and a non-GitHub host stay out of scope", () => {
    const repo = makeRepo([["remote.origin.url", "https://gitlab.example/stranger/x.git"]]);
    assert.equal(destFor(repo, "git push origin main"), null);
    const local = makeRepo([["remote.origin.url", bare]]);
    assert.equal(destFor(local, "git push origin main"), null);
  });

  it("a remote NAMED like a GitHub URL does not hide the URL it is configured with", () => {
    const repo = makeRepo([["remote.git@github.com:acme/x.git.url", "git@github.com:stranger/x.git"]]);
    const d = destFor(repo, "git push git@github.com:acme/x.git main");
    assert.equal(d?.org, "stranger");
  });
});

describe("resolveDestinationOffline — ssh aliases through a temp HOME", () => {
  after(() => {
    setDefaultSshDirForTests(undefined);
  });

  function withHome(sshConfig: string | null): string {
    const home = join(root, `home-${n++}`);
    mkdirSync(join(home, ".ssh"), { recursive: true });
    if (sshConfig !== null) writeFileSync(join(home, ".ssh", "config"), sshConfig);
    setDefaultSshDirForTests(join(home, ".ssh"));
    return home;
  }

  function destFor(remoteUrl: string): ReturnType<typeof resolveDestinationOffline> {
    const repo = makeRepo([["remote.origin.url", remoteUrl]]);
    return resolveDestinationOffline(parseEgressIntents("git push origin main")[0]!, repo);
  }

  it("an alias to github.com is GitHub: the stranger in the path is the owner", () => {
    withHome("Host gh-work\n  HostName github.com\n");
    const d = destFor("git@gh-work:stranger/r.git");
    assert.equal(d?.org, "stranger");
    assert.equal(d?.repo, "r");
  });

  it("an alias to another host is not GitHub", () => {
    withHome("Host gh-work\n  HostName git.example.org\n");
    assert.equal(destFor("git@gh-work:stranger/r.git"), null);
  });

  it("an alias behind a Match block is unresolved, and the Match is never run", () => {
    const sentinel = join(root, `match-sentinel-${n++}`);
    withHome(`Match exec "touch ${sentinel}"\n  HostName github.com\n`);
    const d = destFor("git@gh-work:stranger/r.git");
    assert.equal(d?.unresolved, "opaque-url");
    assert.equal(existsSync(sentinel), false);
  });
});

describe("rule h requires EVERY push URL to be admitted (decideEgress, default resolver)", () => {
  const registry = {
    engagements: [],
    alwaysBlock: [],
    personalOrgs: ["acme"],
    schemaVersion: 2,
  } as unknown as Registry;

  function decide(repo: string, humanPresent = false): ReturnType<typeof decideEgress> {
    return decideEgress({
      intents: parseEgressIntents("git push origin main"),
      cwd: repo,
      registry,
      registryState: "loaded",
      humanPresent,
      capabilities: { ask: false },
      lookupVisibility: () => null,
      findApproval: () => null,
    });
  }

  it("two registered push URLs pass rule h (they reach rule g, which is not rule h's)", () => {
    const repo = makeRepo([
      ["remote.origin.url", "git@github.com:acme/x.git"],
      ["remote.origin.pushurl", "git@github.com:acme/x.git"],
      ["remote.origin.pushurl", "git@github.com:acme/y.git"],
    ]);
    const d = decide(repo);
    assert.notEqual(d.action === "allow" ? "allow" : d.code, "UNREGISTERED_OWNER_EGRESS", JSON.stringify(d));
  });

  it("one registered and one unregistered push URL: refused, and the refusal names the unregistered one", () => {
    const repo = makeRepo([
      ["remote.origin.url", "git@github.com:acme/x.git"],
      ["remote.origin.pushurl", "git@github.com:acme/x.git"],
      ["remote.origin.pushurl", "git@github.com:stranger/y.git"],
    ]);
    const d = decide(repo);
    assert.equal(d.action, "deny");
    if (d.action !== "deny") return;
    assert.equal(d.code, "UNREGISTERED_OWNER_EGRESS");
    assert.match(d.reason, /stranger\/y/);
    assert.doesNotMatch(d.reason, /acme/);
  });

  it("the order of the push URLs does not matter", () => {
    const repo = makeRepo([
      ["remote.origin.url", "git@github.com:acme/x.git"],
      ["remote.origin.pushurl", "git@github.com:stranger/y.git"],
      ["remote.origin.pushurl", "git@github.com:acme/x.git"],
    ]);
    const d = decide(repo);
    assert.equal(d.action === "deny" && d.code, "UNREGISTERED_OWNER_EGRESS");
  });

  it("an unresolved push URL is refused for a caller with no person, and not for a person", () => {
    const repo = makeRepo([["remote.origin.url", "https://github.com/stranger/../acme/x.git"]]);
    const d = decide(repo);
    assert.equal(d.action === "deny" && d.code, "UNREGISTERED_OWNER_EGRESS");
    if (d.action === "deny") assert.match(d.reason, /does not resolve offline/);
    const withPerson = decide(repo, true);
    assert.equal(withPerson.action, "allow", JSON.stringify(withPerson));
  });
});

describe("rules e–g judge EVERY push target, and the most restrictive decision wins (M3)", () => {
  const registry = {
    engagements: [],
    alwaysBlock: [],
    personalOrgs: ["acme", "other-org"],
    schemaVersion: 2,
  } as unknown as Registry;

  /** `acme/x` is this repo's own origin, cached private; every other target has no cache (visibility unknown). */
  function privateRepo(config: Array<[string, string]>): string {
    const repo = makeRepo([
      ["remote.origin.url", "git@github.com:acme/x.git"],
      ["repo-aegis.class", "private-strict"],
      ["repo-aegis.visibility", "private"],
      ...config,
    ]);
    return repo;
  }

  function decide(repo: string, humanPresent = false): ReturnType<typeof decideEgress> {
    return decideEgress({
      intents: parseEgressIntents("git push origin main"),
      cwd: repo,
      registry,
      registryState: "loaded",
      humanPresent,
      capabilities: { ask: false },
      lookupVisibility: () => null,
      findApproval: () => null,
    });
  }

  it("a private first target does not hide a public-facing second one (rule g)", () => {
    const repo = privateRepo([
      ["remote.origin.pushurl", "git@github.com:acme/x.git"],
      ["remote.origin.pushurl", "git@github.com:acme/y.git"],
    ]);
    const d = decide(repo);
    assert.equal(d.action, "deny", JSON.stringify(d));
    if (d.action !== "deny") return;
    assert.equal(d.code, "PUBLIC_EGRESS_NEEDS_HUMAN");
    assert.match(d.reason, /acme\/y/);
  });

  it("a second target in another trust boundary is refused by rule e even when the first is fine", () => {
    const repo = privateRepo([
      ["remote.origin.pushurl", "git@github.com:acme/x.git"],
      ["remote.origin.pushurl", "git@github.com:other-org/y.git"],
    ]);
    const d = decide(repo);
    assert.equal(d.action, "deny", JSON.stringify(d));
    if (d.action === "deny") assert.equal(d.code, "CROSS_ORG_EGRESS");
  });

  it("…and the same push with only the private target is allowed (control)", () => {
    const repo = privateRepo([["remote.origin.pushurl", "git@github.com:acme/x.git"]]);
    assert.equal(decide(repo).action, "allow");
  });

  it("the order of the targets does not matter", () => {
    const repo = privateRepo([
      ["remote.origin.pushurl", "git@github.com:acme/y.git"],
      ["remote.origin.pushurl", "git@github.com:acme/x.git"],
    ]);
    const d = decide(repo);
    assert.equal(d.action, "deny", JSON.stringify(d));
  });

  it("a person present passes rule g for every target", () => {
    const repo = privateRepo([
      ["remote.origin.pushurl", "git@github.com:acme/x.git"],
      ["remote.origin.pushurl", "git@github.com:acme/y.git"],
    ]);
    assert.equal(decide(repo, true).action, "allow");
  });

  it("the receipt names every target, each through safeDestination", () => {
    const repo = privateRepo([
      ["remote.origin.pushurl", "git@github.com:acme/x.git"],
      ["remote.origin.pushurl", "git@github.com:other-org/y.git"],
    ]);
    const d = resolveDestinationOffline(parseEgressIntents("git push origin main")[0]!, repo, registry);
    const receipt = describeDestinationForReceipt(d);
    assert.match(receipt, /acme\/x/);
    assert.match(receipt, /other-org\/y/);
    assert.match(describeDestination(d), /acme\/x.*AND.*other-org\/y/);
    // A target whose name fails validation is never printed.
    const bad = { ...d!, alsoTargets: [{ ...d!, org: "o$(id)", repo: "r" }] };
    assert.doesNotMatch(describeDestinationForReceipt(bad), /\$\(id\)/);
    assert.doesNotMatch(describeDestination(bad), /\$\(id\)/);
  });
});

describe("an ssh override: GitHub-resolving hosts are judged by owner, every other ssh host is unresolved (H2)", () => {
  after(() => {
    setDefaultSshDirForTests(undefined);
    for (const k of ["GIT_SSH_COMMAND", "GIT_SSH", "GIT_SSH_VARIANT"]) delete process.env[k];
  });

  // Claude Code's own sandbox sets this on every agent command. It is just an override like any other.
  // (It names $SRT_SSH_PROXY_COMMAND but contains no credential; the variable below is a fake.)
  const SANDBOX_STYLE =
    "ssh -o ControlMaster=no -o ControlPath=none -o ProxyCommand=\"/bin/sh -c 'eval \\\"\\${SRT_SSH_PROXY_COMMAND:?unset}\\\"' sh '%h' %p\"";
  const FAKE_SRT = "fake-not-a-real-proxy-command";

  /** An ssh dir whose config maps `gh-work` and the `github.com-personal` alias to github.com. */
  function useSshConfig(text = "Host gh-work github.com-personal\n  HostName github.com\n"): void {
    const home = join(root, `home-${n++}`);
    mkdirSync(join(home, ".ssh"), { recursive: true });
    writeFileSync(join(home, ".ssh", "config"), text);
    setDefaultSshDirForTests(join(home, ".ssh"));
  }
  function dest(url: string, config: Array<[string, string]> = []): ReturnType<typeof resolveDestinationOffline> {
    const repo = makeRepo([["remote.origin.url", url], ...config]);
    return resolveDestinationOffline(parseEgressIntents("git push origin main")[0]!, repo);
  }
  /** Run `fn` with the process environment set to `env` (restored after). */
  function withProcessEnv<T>(env: Record<string, string>, fn: () => T): T {
    for (const [k, v] of Object.entries(env)) process.env[k] = v;
    try {
      return fn();
    } finally {
      for (const k of Object.keys(env)) delete process.env[k];
    }
  }

  const OVERRIDES: Array<[string, Record<string, string>, Array<[string, string]>]> = [
    ["the sandbox GIT_SSH_COMMAND template", { GIT_SSH_COMMAND: SANDBOX_STYLE, SRT_SSH_PROXY_COMMAND: FAKE_SRT }, []],
    ["a plain GIT_SSH_COMMAND", { GIT_SSH_COMMAND: "ssh -i /nowhere/key" }, []],
    ["GIT_SSH_VARIANT=ssh", { GIT_SSH_VARIANT: "ssh" }, []],
    ["core.sshCommand", {}, [["core.sshCommand", "ssh -i /nowhere/key"]]],
    ["/usr/bin/ssh with a quoted ProxyCommand", { GIT_SSH_COMMAND: "/usr/bin/ssh -o ProxyCommand='nc %h %p; true'" }, []],
    ["HOSTALIASES", { HOSTALIASES: "/nowhere/aliases" }, []],
    ["LOCALDOMAIN", { LOCALDOMAIN: "example.org" }, []],
    ["RES_OPTIONS", { RES_OPTIONS: "ndots:3" }, []],
  ];

  // Overrides that can send a DIFFERENT repository path than the URL names (P1).
  const PROGRAM_OVERRIDES: Array<[string, Record<string, string>, Array<[string, string]>]> = [
    ["GIT_SSH", { GIT_SSH: "/nowhere/wrapper" }, []],
    ["a wrapper program as GIT_SSH_COMMAND", { GIT_SSH_COMMAND: "/nowhere/wrapper" }, []],
    ["a wrapper program as core.sshCommand", {}, [["core.sshCommand", "/nowhere/wrapper"]]],
    ["ssh followed by a second command", { GIT_SSH_COMMAND: "ssh; /nowhere/wrapper" }, []],
    ["ssh piped to a program", { GIT_SSH_COMMAND: "ssh | /nowhere/wrapper" }, []],
    ["a command substitution", { GIT_SSH_COMMAND: "ssh $(/nowhere/wrapper)" }, []],
    ["a prefix assignment", { GIT_SSH_COMMAND: "FOO=1 ssh" }, []],
    ["ssh with RemoteCommand", { GIT_SSH_COMMAND: "ssh -o RemoteCommand=/nowhere/x" }, []],
    ["GIT_SSH_VARIANT=simple", { GIT_SSH_VARIANT: "simple" }, []],
    ["the sandbox template AND a GIT_SSH", { GIT_SSH_COMMAND: SANDBOX_STYLE, GIT_SSH: "/nowhere/wrapper" }, []],
  ];

  for (const [label, env, config] of PROGRAM_OVERRIDES) {
    describe(`with ${label}`, () => {
      it("EVERY ssh URL is unresolved: github.com, an alias to GitHub, an unknown host", () => {
        useSshConfig();
        for (const url of [
          "git@github.com:acme/x.git",
          "ssh://git@github.com/acme/x.git",
          "git@gh-work:acme/x.git",
          "git@github.com-personal:acme/x.git",
          "git@zz:acme/x.git",
        ]) {
          const d = withProcessEnv(env, () => dest(url, config));
          assert.equal(d?.unresolved, "opaque-url", url);
          assert.match(d?.unresolvedWhy ?? "", /different repository path/, url);
        }
      });

      it("rule h refuses even a REGISTERED owner (the wrapper could send another repository)", () => {
        const registry = { engagements: [], alwaysBlock: [], personalOrgs: ["acme"], schemaVersion: 2 } as unknown as Registry;
        const repo = makeRepo([["remote.origin.url", "git@github.com:acme/x.git"], ...config]);
        const d = withProcessEnv(env, () =>
          decideEgress({
            intents: parseEgressIntents("git push origin main"),
            cwd: repo,
            registry,
            registryState: "loaded",
            humanPresent: false,
            capabilities: { ask: false },
            lookupVisibility: () => null,
            findApproval: () => null,
          }),
        );
        assert.equal(d.action === "deny" && d.code, "UNREGISTERED_OWNER_EGRESS");
      });

      it("https is untouched", () => {
        const d = withProcessEnv(env, () => dest("https://github.com/acme/x.git", config));
        assert.equal(d?.org, "acme");
      });
    });
  }

  for (const [label, env, config] of OVERRIDES) {
    describe(`with ${label}`, () => {
      it("a non-GitHub-looking host is unresolved: `git@zz:` and `git@gitlab.com:`", () => {
        useSshConfig();
        for (const url of ["git@zz:stranger/r.git", "git@gitlab.com:x/y.git", "ssh://git@gitlab.example/x/y.git"]) {
          const d = withProcessEnv(env, () => dest(url, config));
          assert.equal(d?.unresolved, "opaque-url", url);
        }
      });

      it("a literal github.com host is GitHub, owner checked", () => {
        useSshConfig();
        const d = withProcessEnv(env, () => dest("git@github.com:stranger/r.git", config));
        assert.equal(d?.org, "stranger");
        assert.equal(d?.repo, "r");
        assert.equal(d?.unresolved, undefined);
      });

      it("an alias with HostName github.com (`gh-work`, `github.com-personal`) is GitHub, owner checked", () => {
        useSshConfig();
        for (const url of ["git@gh-work:stranger/r.git", "git@github.com-personal:stranger/r.git"]) {
          const d = withProcessEnv(env, () => dest(url, config));
          assert.equal(d?.org, "stranger", url);
          assert.equal(d?.unresolved, undefined, url);
        }
      });

      it("rule h judges the owner: a stranger is refused, a registered owner passes rule h", () => {
        useSshConfig();
        const registry = { engagements: [], alwaysBlock: [], personalOrgs: ["acme"], schemaVersion: 2 } as unknown as Registry;
        const decide = (url: string): ReturnType<typeof decideEgress> =>
          withProcessEnv(env, () => {
            const repo = makeRepo([["remote.origin.url", url], ...config]);
            return decideEgress({
              intents: parseEgressIntents("git push origin main"),
              cwd: repo,
              registry,
              registryState: "loaded",
              humanPresent: false,
              capabilities: { ask: false },
              lookupVisibility: () => null,
              findApproval: () => null,
            });
          });
        for (const url of ["git@github.com:stranger/r.git", "git@gh-work:stranger/r.git", "git@zz:stranger/r.git"]) {
          const d = decide(url);
          assert.equal(d.action === "deny" && d.code, "UNREGISTERED_OWNER_EGRESS", url);
        }
        for (const url of ["git@github.com:acme/x.git", "git@gh-work:acme/x.git", "git@github.com-personal:acme/x.git"]) {
          const d = decide(url);
          assert.notEqual(d.action === "allow" ? "allow" : d.code, "UNREGISTERED_OWNER_EGRESS", url);
        }
      });
    });
  }

  describe("with no override: unchanged", () => {
    it("a dotted non-GitHub host and an alias mapped elsewhere are not GitHub", () => {
      useSshConfig("Host gh-work\n  HostName git.example.org\n");
      assert.equal(dest("git@gitlab.com:x/y.git"), null);
      assert.equal(dest("git@gh-work:stranger/r.git"), null);
    });

    it("aliases resolve through the ssh config", () => {
      useSshConfig();
      assert.equal(dest("git@gh-work:stranger/r.git")?.org, "stranger");
      assert.equal(dest("git@github.com-personal:stranger/r.git")?.org, "stranger");
    });

    it("the hook's rule: an unmapped DOTLESS host is unresolved even with no override visible (the hook may not see the agent's GIT_SSH_COMMAND)", () => {
      useSshConfig();
      assert.equal(dest("git@zz:stranger/r.git")?.unresolved, "opaque-url");
      assert.match(dest("git@zz:stranger/r.git")?.unresolvedWhy ?? "", /does not map/);
    });

    it("a ProxyCommand in the applying ssh config acts as an override for that alias", () => {
      useSshConfig("Host gh-work\n  HostName github.com\n  ProxyCommand nc x 22\nHost other\n  HostName git.example.org\n  ProxyJump j\n");
      assert.equal(dest("git@gh-work:stranger/r.git")?.org, "stranger");
      assert.equal(dest("git@other:stranger/r.git")?.unresolved, "opaque-url");
    });
  });

  it("detectSshOverride: any of GIT_SSH_COMMAND, GIT_SSH, GIT_SSH_VARIANT or core.sshCommand, and nothing else", () => {
    const repo = makeRepo();
    assert.equal(detectSshOverride(repo, {}), "none");
    assert.equal(detectSshOverride(repo, { GIT_SSH_COMMAND: "  " }), "none");
    assert.equal(detectSshOverride(repo, { GIT_SSH_VARIANT: "ssh" }), "preserving");
    assert.equal(detectSshOverride(repo, { GIT_SSH_COMMAND: "ssh" }), "preserving");
    assert.equal(detectSshOverride(makeRepo([["core.sshCommand", "ssh -i k"]]), {}), "preserving");
    // Name-resolution overrides, when non-empty, may redirect a host name.
    for (const name of ["HOSTALIASES", "LOCALDOMAIN", "RES_OPTIONS"]) {
      assert.equal(detectSshOverride(repo, { [name]: "x" }), "preserving", name);
      assert.equal(detectSshOverride(repo, { [name]: " " }), "none", name);
    }
  });

  it("P1: ssh-preserving means plain ssh as the first word, with no second command (the sandbox template included, fake credential)", () => {
    const repo = makeRepo();
    const preserving = [
      "ssh",
      "/usr/bin/ssh",
      "ssh -i key",
      "ssh -o StrictHostKeyChecking=no -p 22",
      "ssh -o ProxyCommand='nc %h %p'",
      `ssh -o ProxyCommand="nc %h %p; true"`,
      "'ssh' -i key",
      SANDBOX_STYLE,
      // The same template with the (fake) proxy script inlined instead of read from the environment.
      `ssh -o ProxyCommand="/bin/sh -c 'echo fake-not-a-real-credential | nc 127.0.0.1 1' sh '%h' %p"`,
    ];
    for (const c of preserving) assert.equal(detectSshOverride(repo, { GIT_SSH_COMMAND: c }), "preserving", c);
    const other = [
      "ssh; /tmp/w",
      "ssh && /tmp/w",
      "ssh | /tmp/w",
      "ssh > /tmp/w",
      "ssh < /tmp/w",
      "ssh `/tmp/w`",
      "ssh $(/tmp/w)",
      "ssh ${X}",
      'ssh "$(/tmp/w)"',
      "ssh\n/tmp/w",
      "ssh\r/tmp/w",
      "/tmp/w",
      "./ssh",
      "sshx",
      "/usr/local/bin/ssh",
      "env ssh",
      "FOO=1 ssh",
      "ssh -o RemoteCommand=/tmp/w",
      "ssh -oRemoteCommand=/tmp/w",
      "ssh -o 'Remote Command=x'",
      "ssh -o ProxyCommand='nc",
      'ssh "unterminated',
      "ssh &",
      "ssh (x)",
      "",
    ].filter(c => c !== "");
    for (const c of other) assert.equal(detectSshOverride(repo, { GIT_SSH_COMMAND: c }), "other", JSON.stringify(c));
    // The same classification applies to core.sshCommand, and ANY non-preserving source wins.
    assert.equal(detectSshOverride(makeRepo([["core.sshCommand", "/tmp/w"]]), {}), "other");
    assert.equal(detectSshOverride(makeRepo([["core.sshCommand", "/tmp/w"]]), { GIT_SSH_COMMAND: "ssh" }), "other");
    assert.equal(detectSshOverride(repo, { GIT_SSH: "/tmp/w" }), "other");
    assert.equal(detectSshOverride(repo, { GIT_SSH_VARIANT: "simple" }), "other");
    assert.equal(detectSshOverride(repo, { GIT_SSH_COMMAND: "ssh", GIT_SSH: "/tmp/w" }), "other");
  });

  it("Q2: the default ssh directory is the passwd home's, whatever HOME says", () => {
    setDefaultSshDirForTests(undefined);
    const before = defaultSshDir();
    assert.equal(before, join(userInfo().homedir, ".ssh"));
    const savedHome = process.env["HOME"];
    process.env["HOME"] = join(root, "empty-home");
    try {
      assert.equal(defaultSshDir(), before);
    } finally {
      if (savedHome === undefined) delete process.env["HOME"];
      else process.env["HOME"] = savedHome;
    }
  });
});

describe("an alias origin counts as own at every layer (L2)", () => {
  after(() => {
    setDefaultSshDirForTests(undefined);
  });

  it("`git@gh-work:acme/x.git` is acme/x for the origin lookup and the working-tree helpers", async () => {
    const home = join(root, `home-${n++}`);
    mkdirSync(join(home, ".ssh"), { recursive: true });
    writeFileSync(join(home, ".ssh", "config"), "Host gh-work\n  HostName github.com\n");
    setDefaultSshDirForTests(join(home, ".ssh"));
    const repo = makeRepo([
      ["remote.origin.url", "git@gh-work:acme/x.git"],
      ["repo-aegis.class", "private-strict"],
      ["repo-aegis.visibility", "private"],
    ]);
    const { getRemoteOrg } = await import("./working-tree.js");
    assert.equal(getRemoteOrg(repo), "acme");
    // Pushing to the origin by name is judged as the repository's OWN declaration (private, cached).
    const d = resolveDestinationOffline(parseEgressIntents("git push origin main")[0]!, repo);
    assert.equal(d?.org, "acme");
    assert.equal(d?.classKnown, true);
    assert.equal(d?.visibility, "private");
  });
});
