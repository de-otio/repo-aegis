// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// `parseRemoteUrl` / `resolveRemoteUrl` hardening for rule h
// (doc/plan-unregistered-owner-egress.md §3.3 item 6, §8.4 F4).
// Placeholder owners only (`stranger`, `acme`, `example`).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyRemoteUrl, parseRemoteUrl, resolveRemoteUrl, type RemoteTarget } from "./remote-url.js";
import type { SshHostLookup } from "./ssh-config.js";

const NO_SSH_CONFIG = (): SshHostLookup => ({ kind: "none" });

describe("parseRemoteUrl — every GitHub form the review listed (F4)", () => {
  const cases: Array<[string, string, string]> = [
    ["https://GitHub.COM/Stranger/R.git", "stranger", "r"],
    ["https://github.com:443/stranger/r", "stranger", "r"],
    ["ssh://git@ssh.github.com:443/stranger/r.git", "stranger", "r"],
    ["ssh://git@github.com:22/stranger/r.git", "stranger", "r"],
    ["https://github.com./stranger/r", "stranger", "r"],
    ["git@github.com.:stranger/r.git", "stranger", "r"],
    ["https://www.github.com/stranger/r", "stranger", "r"],
    ["ssh://deploy@github.com/stranger/r", "stranger", "r"],
    ["deploy@github.com:stranger/r.git", "stranger", "r"],
    ["git@ssh.github.com:stranger/r.git", "stranger", "r"],
    ["git@github.com:/stranger/r.git", "stranger", "r"],
    ["github.com:stranger/r.git", "stranger", "r"],
    ["ssh://github.com/stranger/r", "stranger", "r"],
    ["https://x-access-token:abc@github.com/stranger/r.git", "stranger", "r"],
    ["git@GITHUB.COM:Stranger/R", "stranger", "r"],
    ["git@github.com-work:stranger/r.git", "stranger", "r"], // the long-standing alias convention
  ];
  for (const [input, org, repo] of cases) {
    it(`parses ${JSON.stringify(input)}`, () => {
      assert.deepEqual(parseRemoteUrl(input), { host: "github.com", org, repo });
    });
  }
});

describe("parseRemoteUrl — hostile URLs are never attributed", () => {
  const hostile: Array<[string, string]> = [
    ["https://github.com.evil.example/stranger/r", "another host"],
    ["https://github.com@evil.example/stranger/r", "userinfo trick: the host is evil.example"],
    ["https://github.com:80@evil.example/stranger/r", "userinfo trick with a port-shaped userinfo"],
    ["https://evil.example/github.com/stranger/r", "github.com in the path"],
    ["https://github.com\\@evil.example/stranger/r", "a backslash"],
    ["https://github.com/stranger/r%2F..%2Fother", "percent-encoding in the path"],
    ["https://github.com/%73tranger/r", "percent-encoded owner"],
    ["https://github.com/stranger/../acme/r", "dot-dot segment"],
    ["https://github.com/stranger/..", "dot-dot repo"],
    ["https://github.com/stranger/.", "dot repo"],
    ["https://github.com/stranger/r/extra", "extra path segment"],
    ["https://github.com/stranger/r?x=1", "query string"],
    ["https://github.com/stranger/r#frag", "fragment"],
    ["https://github.com:abc/stranger/r", "non-numeric port"],
    ["https://github.com:/stranger/r", "empty port"],
    ["https://%67ithub.com/stranger/r", "percent-encoded host"],
    ["https://a@b@github.com/stranger/r", "two @ in the authority"],
    ["https://github.com/stranger /r", "a space"],
    ["https://github.com/stran\nger/r", "a newline"],
    ["https://github.com/stranger/r\u202e", "a bidi control"],
    ["https://github.com/-stranger/r", "owner starts with a hyphen"],
    ["https://github.com/stranger_x/r", "owner with an underscore"],
    [`https://github.com/${"a".repeat(40)}/r`, "owner over 39 characters"],
    [`https://github.com/stranger/${"r".repeat(101)}`, "repo over 100 characters"],
    ["https://github.com/stranger/*", "a wildcard repo"],
    ["https://github.com/stranger/$(id)", "shell syntax in the repo"],
    ["git@github.com:stranger/r$(id).git", "shell syntax in an scp path"],
    ["git@github.com:stranger/../acme/r.git", "dot-dot in an scp path"],
    ["git@github.com:~stranger/r.git", "a ~user path"],
    ["foo://github.com/stranger/r", "a remote-helper scheme naming github"],
    ["://github.com/stranger/r", "no scheme"],
  ];
  for (const [input, why] of hostile) {
    it(`parseRemoteUrl(${JSON.stringify(input)}) is null (${why})`, () => {
      assert.equal(parseRemoteUrl(input), null);
    });
  }

  it("a URL on another host is non-GitHub, not unresolved", () => {
    for (const u of [
      "https://github.com.evil.example/stranger/r",
      "https://github.com@evil.example/stranger/r",
      "https://gitlab.com/stranger/r.git",
      "git@gitlab.com:stranger/r.git", // no ssh config here: its own host
      "file:///srv/git/r.git",
      "/srv/git/r.git",
      "../relative/path",
      "C:/Users/x/repo",
      "origin",
    ]) {
      assert.equal(resolveRemoteUrl(u, NO_SSH_CONFIG).kind, "non-github", u);
    }
  });

  it("a URL-shaped value that is not cleanly github.com/<owner>/<repo> is UNRESOLVED, never no-destination", () => {
    for (const u of [
      "https://github.com/stranger/../acme/r",
      "https://github.com/stranger/r%2Fx",
      "https://github.com:abc/stranger/r",
      "https://a@b@github.com/stranger/r",
      "https://github.com/stranger/r/extra",
      "git@github.com:stranger/r$(id).git",
      "https://github.com\\@evil.example/stranger/r",
      "foo://github.com/stranger/r",
      "://github.com/stranger/r",
    ]) {
      assert.equal(resolveRemoteUrl(u, NO_SSH_CONFIG).kind, "unresolved", u);
    }
  });
});

describe("resolveRemoteUrl — ssh Host aliases", () => {
  const lookupTable =
    (table: Record<string, SshHostLookup>) =>
    (host: string): SshHostLookup =>
      table[host] ?? { kind: "none" };

  it("an alias whose HostName is github.com is GitHub (the owner comes from the path)", () => {
    const lookup = lookupTable({ "gh-work": { kind: "hostname", hostName: "github.com" } });
    assert.deepEqual(resolveRemoteUrl("git@gh-work:stranger/r.git", lookup), {
      kind: "github",
      org: "stranger",
      repo: "r",
    });
    assert.deepEqual(resolveRemoteUrl("ssh://git@gh-work/stranger/r.git", lookup), {
      kind: "github",
      org: "stranger",
      repo: "r",
    });
  });

  it("ssh.github.com is GitHub too", () => {
    const lookup = lookupTable({ "gh-work": { kind: "hostname", hostName: "ssh.github.com" } });
    assert.equal(resolveRemoteUrl("git@gh-work:stranger/r.git", lookup).kind, "github");
  });

  it("an alias whose HostName is not GitHub is not GitHub", () => {
    const lookup = lookupTable({ "gh-work": { kind: "hostname", hostName: "git.example.org" } });
    assert.equal(resolveRemoteUrl("git@gh-work:stranger/r.git", lookup).kind, "non-github");
  });

  it("an alias the ssh config does not mention is its own host, so not GitHub", () => {
    assert.equal(resolveRemoteUrl("git@gh-work:stranger/r.git", NO_SSH_CONFIG).kind, "non-github");
  });

  it("an alias the parser cannot resolve is UNRESOLVED (fail closed)", () => {
    const lookup = lookupTable({ "gh-work": { kind: "unresolved", why: "a Match block" } });
    assert.equal(resolveRemoteUrl("git@gh-work:stranger/r.git", lookup).kind, "unresolved");
  });

  it("an alias that IS GitHub still needs a clean owner/repo path", () => {
    const lookup = lookupTable({ "gh-work": { kind: "hostname", hostName: "github.com" } });
    assert.equal(resolveRemoteUrl("git@gh-work:stranger/../acme/r.git", lookup).kind, "unresolved");
  });

  it("the `github.com-<alias>` convention stays GitHub when the ssh config says nothing about it", () => {
    assert.equal(resolveRemoteUrl("git@github.com-work:stranger/r.git", NO_SSH_CONFIG).kind, "github");
  });

  it("…but when the ssh config cannot be resolved for it, that is a doubt: unresolved, and the reason names the doubt", () => {
    const unresolved = lookupTable({ "github.com-work": { kind: "unresolved", why: "an ssh Match block sets HostName" } });
    const t = resolveRemoteUrl("git@github.com-work:stranger/r.git", unresolved);
    assert.equal(t.kind, "unresolved");
    if (t.kind === "unresolved") assert.match(t.why, /Match block/);
  });

  it("…but an ssh config that says that alias is another host wins", () => {
    const lookup = lookupTable({ "github.com-work": { kind: "hostname", hostName: "git.example.org" } });
    assert.equal(resolveRemoteUrl("git@github.com-work:stranger/r.git", lookup).kind, "non-github");
  });

  it("a hostile alias name is unresolved, never looked up", () => {
    let asked = false;
    const lookup = (): SshHostLookup => {
      asked = true;
      return { kind: "none" };
    };
    assert.equal(resolveRemoteUrl("git@$(id):stranger/r.git", lookup).kind, "unresolved");
    assert.equal(asked, false);
  });
});

describe("bracketed hosts are classified by their inner host (C1: git strips the brackets)", () => {
  it("`[github.com]` in every position is github.com, never skipped", () => {
    for (const u of [
      "[github.com]:stranger/r.git",
      "git@[github.com]:stranger/r.git",
      "[github.com:22]:stranger/r.git",
      "git@[github.com:22]:stranger/r.git",
      "ssh://[github.com]/stranger/r.git",
      "ssh://git@[github.com]/stranger/r.git",
      "ssh://git@[github.com]:22/stranger/r.git",
      "ssh://git@[ssh.github.com]:443/stranger/r.git",
    ]) {
      assert.deepEqual(resolveRemoteUrl(u, NO_SSH_CONFIG), { kind: "github", org: "stranger", repo: "r" }, u);
      assert.deepEqual(parseRemoteUrl(u), { host: "github.com", org: "stranger", repo: "r" }, u);
    }
  });

  it("a bracketed alias is looked up by its inner host", () => {
    const asked: string[] = [];
    const lookup = (h: string): SshHostLookup => {
      asked.push(h);
      return { kind: "hostname", hostName: "github.com" };
    };
    assert.equal(resolveRemoteUrl("[gh-work]:stranger/r.git", lookup).kind, "github");
    assert.deepEqual(asked, ["gh-work"]);
  });

  it("a real IP literal in brackets is unresolved (v4, v6, numeric spellings)", () => {
    for (const u of [
      "[::1]:stranger/r.git",
      "git@[2001:db8::1]:stranger/r.git",
      "ssh://git@[::1]/stranger/r.git",
      "ssh://[2001:db8::1]:22/stranger/r.git",
      "git@[127.0.0.1]:stranger/r.git",
      "[140.82.112.3]:stranger/r.git",
      "ssh://git@[140.82.112.3]/stranger/r.git",
    ]) {
      assert.equal(resolveRemoteUrl(u, NO_SSH_CONFIG).kind, "unresolved", u);
    }
  });

  it("malformed brackets are unresolved, never GitHub", () => {
    for (const u of [
      "[github.com:stranger/r.git",
      "[github.com]x:stranger/r.git",
      "ssh://[github.com/stranger/r.git",
      "ssh://[github.com]x/stranger/r.git",
      "[github.com:abc]:stranger/r.git",
      "x[github.com]:stranger/r.git",
    ]) {
      assert.notEqual(resolveRemoteUrl(u, NO_SSH_CONFIG).kind, "github", u);
    }
  });
});

describe("only the guard being SURE makes a push non-GitHub (M2, M4, L1)", () => {
  const ssh = (hostName: string): ((h: string) => SshHostLookup) => () => ({ kind: "hostname", hostName });

  it("a one-letter scp host is ssh, not a local path (M2)", () => {
    assert.equal(classifyRemoteUrl("a:stranger/r.git").kind, "alias");
    const asked: string[] = [];
    const t = resolveRemoteUrl("a:stranger/r.git", h => {
      asked.push(h);
      return { kind: "hostname", hostName: "github.com" };
    });
    assert.deepEqual(t, { kind: "github", org: "stranger", repo: "r" });
    assert.deepEqual(asked, ["a"]);
  });

  it("IP-literal hosts are unresolved, directly or through HostName (M4)", () => {
    for (const u of [
      "git@140.82.112.3:stranger/r.git",
      "ssh://git@140.82.112.3/stranger/r.git",
      "https://140.82.112.3/stranger/r.git",
      "https://2130706433/stranger/r.git",
      "https://0x7f.1/stranger/r.git",
    ]) {
      assert.equal(resolveRemoteUrl(u, NO_SSH_CONFIG).kind, "unresolved", u);
    }
    assert.equal(resolveRemoteUrl("git@gh-work:stranger/r.git", ssh("140.82.112.3")).kind, "unresolved");
    assert.equal(resolveRemoteUrl("git@gh-work:stranger/r.git", ssh("::1")).kind, "unresolved");
  });

  it("a github.com subdomain other than ssh.github.com is unresolved, directly or through HostName (M4)", () => {
    for (const u of [
      "git@gist.github.com:stranger/r.git",
      "git@www.github.com:stranger/r.git",
      "ssh://git@api.github.com/stranger/r.git",
      "https://gist.github.com/stranger/r.git",
    ]) {
      assert.equal(resolveRemoteUrl(u, NO_SSH_CONFIG).kind, "unresolved", u);
    }
    assert.equal(resolveRemoteUrl("git@gh-work:stranger/r.git", ssh("gist.github.com")).kind, "unresolved");
    // ...while a look-alike that is not under github.com is just another host.
    assert.equal(resolveRemoteUrl("https://notgithub.com/stranger/r.git", NO_SSH_CONFIG).kind, "non-github");
    assert.equal(resolveRemoteUrl("git@gh-work:stranger/r.git", ssh("github.com.evil.example")).kind, "non-github");
  });

  it("a remote-helper address is classified by its address; an unknown helper is unresolved (L1)", () => {
    assert.deepEqual(resolveRemoteUrl("https::https://github.com/stranger/r.git", NO_SSH_CONFIG), {
      kind: "github",
      org: "stranger",
      repo: "r",
    });
    for (const u of [
      "ext::ssh git@github.com %S stranger/r.git",
      "foo::https://github.com/stranger/r.git",
      "testgit::git@github.com:stranger/r.git",
      "fd::3",
      "https::git@github.com:stranger/r.git",
    ]) {
      assert.equal(resolveRemoteUrl(u, NO_SSH_CONFIG).kind, "unresolved", u);
    }
  });

  it("an ssh override makes every ssh alias unresolved; a literal github.com only when it can redirect (H2)", () => {
    const found = ssh("github.com");
    const plain = { present: true, mayRedirect: false };
    const redirecting = { present: true, mayRedirect: true };
    assert.equal(resolveRemoteUrl("git@gh-work:stranger/r.git", found, { sshOverride: plain }).kind, "unresolved");
    assert.equal(resolveRemoteUrl("git@gh-work:stranger/r.git", found, { sshOverride: redirecting }).kind, "unresolved");
    assert.equal(resolveRemoteUrl("git@gitlab.example:stranger/r.git", NO_SSH_CONFIG, { sshOverride: plain }).kind, "unresolved");
    assert.equal(resolveRemoteUrl("git@github.com:stranger/r.git", found, { sshOverride: plain }).kind, "github");
    assert.equal(resolveRemoteUrl("git@github.com:stranger/r.git", found, { sshOverride: redirecting }).kind, "unresolved");
    // An override changes nothing for a non-ssh transport.
    assert.equal(resolveRemoteUrl("https://github.com/stranger/r.git", found, { sshOverride: redirecting }).kind, "github");
    assert.equal(resolveRemoteUrl("https://gitlab.example/stranger/r.git", found, { sshOverride: redirecting }).kind, "non-github");
  });
});

describe("classifyRemoteUrl — properties (seeded, deterministic)", () => {
  // mulberry32: a fixed seed keeps the run reproducible without a property-test dependency.
  function rng(seed: number): () => number {
    let a = seed;
    return () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const pick = (r: () => number, chars: string, len: number): string =>
    Array.from({ length: len }, () => chars[Math.floor(r() * chars.length)]).join("");
  const ALNUM = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

  it("a clean github.com URL round-trips to its lower-cased owner and repo", () => {
    const r = rng(1);
    for (let i = 0; i < 300; i++) {
      const o = pick(r, ALNUM, 1) + pick(r, ALNUM + "-", Math.floor(r() * 38));
      const name = pick(r, ALNUM + "._-", 1 + Math.floor(r() * 50));
      if (name === "." || name === ".." || name.endsWith(".git")) continue;
      for (const url of [
        `https://github.com/${o}/${name}.git`,
        `git@github.com:${o}/${name}`,
        `ssh://git@github.com/${o}/${name}/`,
      ]) {
        const t: RemoteTarget = resolveRemoteUrl(url, NO_SSH_CONFIG);
        assert.deepEqual(t, { kind: "github", org: o.toLowerCase(), repo: name.toLowerCase() }, url);
      }
    }
  });

  it("never throws, and never attributes a non-github.com authority to an owner", () => {
    const r = rng(2);
    const NOISE = ALNUM + " .-_%@:/\\?#\n‮$()";
    for (let i = 0; i < 500; i++) {
      const a = pick(r, NOISE, Math.floor(r() * 20));
      const b = pick(r, NOISE, Math.floor(r() * 20));
      assert.doesNotThrow(() => classifyRemoteUrl(a));
      const host = a.replace(/[/?#@:\\\s%]/g, "");
      const t = resolveRemoteUrl(`https://${host}.invalid/${b}`, NO_SSH_CONFIG);
      assert.notEqual(t.kind, "github", `https://${host}.invalid/${b}`);
    }
  });
});
