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
import { resolvePushUrls } from "./push-urls.js";
import { decideEgress, resolveDestinationOffline } from "./egress-policy.js";
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
    env: { ...process.env, ...env },
  });
}

before(() => {
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
    assert.deepEqual(d?.alsoTargets, [{ org: "stranger", repo: "y" }]);
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
  const savedHome = process.env["HOME"];
  after(() => {
    if (savedHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = savedHome;
  });

  function withHome(sshConfig: string | null): string {
    const home = join(root, `home-${n++}`);
    mkdirSync(join(home, ".ssh"), { recursive: true });
    if (sshConfig !== null) writeFileSync(join(home, ".ssh", "config"), sshConfig);
    process.env["HOME"] = home;
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
