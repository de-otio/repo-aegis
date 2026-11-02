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
      "ssh://git@[::1]/stranger/r",
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

  it("the `github.com-<alias>` convention stays GitHub when nothing contradicts it, and when the config cannot be read", () => {
    assert.equal(resolveRemoteUrl("git@github.com-work:stranger/r.git", NO_SSH_CONFIG).kind, "github");
    const unresolved = lookupTable({ "github.com-work": { kind: "unresolved", why: "x" } });
    assert.equal(resolveRemoteUrl("git@github.com-work:stranger/r.git", unresolved).kind, "github");
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
