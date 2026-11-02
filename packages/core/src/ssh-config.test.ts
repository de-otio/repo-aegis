// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// The pure ssh-config reader (doc/plan-unregistered-owner-egress.md §3.3 item 5,
// §8.4 F8). Every config lives in a temp `sshDir`; the real ~/.ssh is never read.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lookupSshHost, SSH_INCLUDE_MAX_DEPTH } from "./ssh-config.js";

let root: string;
let n = 0;

before(() => {
  root = mkdtempSync(join(tmpdir(), "repo-aegis-ssh-config-"));
});
after(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A fresh sshDir holding `config` with `text` (and any extra files). */
function sshDirWith(text: string | null, extra: Record<string, string> = {}): string {
  const dir = join(root, `ssh-${n++}`);
  mkdirSync(dir, { recursive: true });
  if (text !== null) writeFileSync(join(dir, "config"), text);
  for (const [name, body] of Object.entries(extra)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), body);
  }
  return dir;
}

describe("lookupSshHost — Host and HostName", () => {
  it("no config file: the host is its own name", () => {
    assert.deepEqual(lookupSshHost("gh-work", { sshDir: sshDirWith(null) }), { kind: "none" });
  });

  it("an alias maps to its HostName (lower-cased, trailing dot removed)", () => {
    const sshDir = sshDirWith("Host gh-work\n  HostName GitHub.com.\n  User git\n");
    assert.deepEqual(lookupSshHost("gh-work", { sshDir }), { kind: "hostname", hostName: "github.com" });
  });

  it("accepts `HostName=value`, comments and quotes", () => {
    const sshDir = sshDirWith('# c\nHost "gh-work" # trailing\n  hostname = "ssh.github.com"\n');
    assert.deepEqual(lookupSshHost("gh-work", { sshDir }), { kind: "hostname", hostName: "ssh.github.com" });
  });

  it("an alias that points somewhere else is reported as that host", () => {
    const sshDir = sshDirWith("Host gh-other\n  HostName git.example.org\n");
    assert.deepEqual(lookupSshHost("gh-other", { sshDir }), { kind: "hostname", hostName: "git.example.org" });
  });

  it("a host with no Host block is its own name", () => {
    const sshDir = sshDirWith("Host gh-work\n  HostName github.com\n");
    assert.deepEqual(lookupSshHost("gitlab.example", { sshDir }), { kind: "none" });
  });

  it("supports * and ? in Host patterns", () => {
    const sshDir = sshDirWith("Host gh-*\n  HostName github.com\nHost x?y\n  HostName git.example.org\n");
    assert.deepEqual(lookupSshHost("gh-anything", { sshDir }), { kind: "hostname", hostName: "github.com" });
    assert.deepEqual(lookupSshHost("xay", { sshDir }), { kind: "hostname", hostName: "git.example.org" });
    assert.deepEqual(lookupSshHost("xaay", { sshDir }), { kind: "none" });
  });

  it("a negated pattern excludes the whole line", () => {
    const sshDir = sshDirWith("Host *.example !skip.example\n  HostName github.com\n");
    assert.deepEqual(lookupSshHost("a.example", { sshDir }), { kind: "hostname", hostName: "github.com" });
    assert.deepEqual(lookupSshHost("skip.example", { sshDir }), { kind: "none" });
  });

  it("the FIRST applicable HostName wins, as in ssh", () => {
    const sshDir = sshDirWith(
      "Host gh-work\n  HostName github.com\nHost gh-*\n  HostName git.example.org\nHost *\n  HostName elsewhere.example\n",
    );
    assert.deepEqual(lookupSshHost("gh-work", { sshDir }), { kind: "hostname", hostName: "github.com" });
    assert.deepEqual(lookupSshHost("gh-other", { sshDir }), { kind: "hostname", hostName: "git.example.org" });
  });

  it("a HostName before any Host line is global", () => {
    const sshDir = sshDirWith("HostName github.com\nHost x\n  User u\n");
    assert.deepEqual(lookupSshHost("anything", { sshDir }), { kind: "hostname", hostName: "github.com" });
  });

  it("a HostName with a % token is unresolved", () => {
    const sshDir = sshDirWith("Host gh-work\n  HostName %h.example\n");
    assert.equal(lookupSshHost("gh-work", { sshDir }).kind, "unresolved");
  });
});

describe("lookupSshHost — Match is never evaluated", () => {
  it("a Match block that sets HostName, reached before any decision, is unresolved", () => {
    const sshDir = sshDirWith('Match host gh-work\n  HostName github.com\n');
    assert.equal(lookupSshHost("gh-work", { sshDir }).kind, "unresolved");
  });

  it("an `exec` Match is never run (a sentinel stays absent) and is unresolved", () => {
    const sentinel = join(root, `sentinel-${n}`);
    const sshDir = sshDirWith(`Match exec "touch ${sentinel}"\n  HostName github.com\nHost gh-work\n  HostName github.com\n`);
    const r = lookupSshHost("gh-work", { sshDir });
    assert.equal(r.kind, "unresolved");
    assert.equal(existsSync(sentinel), false, "the ssh config reader must not execute Match exec");
  });

  it("a Match block that sets no HostName does not matter", () => {
    const sshDir = sshDirWith('Match exec "false"\n  ServerAliveInterval 5\nHost gh-work\n  HostName github.com\n');
    assert.deepEqual(lookupSshHost("gh-work", { sshDir }), { kind: "hostname", hostName: "github.com" });
  });

  it("an earlier Host block decides first, so a later Match HostName is moot", () => {
    const sshDir = sshDirWith('Host gh-work\n  HostName github.com\nMatch all\n  HostName git.example.org\n');
    assert.deepEqual(lookupSshHost("gh-work", { sshDir }), { kind: "hostname", hostName: "github.com" });
  });

  it("a Host line after a Match ends it", () => {
    const sshDir = sshDirWith("Match all\n  ServerAliveInterval 5\nHost gh-work\n  HostName github.com\n");
    assert.deepEqual(lookupSshHost("gh-work", { sshDir }), { kind: "hostname", hostName: "github.com" });
  });
});

describe("lookupSshHost — Include", () => {
  it("follows a relative Include (relative to the ssh dir)", () => {
    const sshDir = sshDirWith("Include extra\n", { extra: "Host gh-work\n  HostName github.com\n" });
    assert.deepEqual(lookupSshHost("gh-work", { sshDir }), { kind: "hostname", hostName: "github.com" });
  });

  it("follows a glob Include in sorted order", () => {
    const sshDir = sshDirWith("Include conf.d/*\n", {
      "conf.d/10-a": "Host gh-work\n  HostName github.com\n",
      "conf.d/20-b": "Host gh-work\n  HostName git.example.org\n",
    });
    assert.deepEqual(lookupSshHost("gh-work", { sshDir }), { kind: "hostname", hostName: "github.com" });
  });

  it("a missing Include target is ignored", () => {
    const sshDir = sshDirWith("Include nothing-here\nInclude gone/*\nHost gh-work\n  HostName github.com\n");
    assert.deepEqual(lookupSshHost("gh-work", { sshDir }), { kind: "hostname", hostName: "github.com" });
  });

  it("an Include inside a Host block that does not apply is not followed", () => {
    const sshDir = sshDirWith("Host other\n  Include extra\n", { extra: "HostName git.example.org\n" });
    assert.deepEqual(lookupSshHost("gh-work", { sshDir }), { kind: "none" });
  });

  it("an Include under a Match block makes an included HostName unresolved", () => {
    const sshDir = sshDirWith('Match exec "true"\n  Include extra\n', { extra: "HostName github.com\n" });
    assert.equal(lookupSshHost("gh-work", { sshDir }).kind, "unresolved");
  });

  it("an Include loop is bounded, not followed forever", () => {
    const sshDir = sshDirWith("Include loop\n", { loop: "Include loop\n" });
    const r = lookupSshHost("gh-work", { sshDir });
    assert.equal(r.kind, "unresolved");
  });

  it(`a chain deeper than ${SSH_INCLUDE_MAX_DEPTH} is unresolved; within it, followed`, () => {
    const files: Record<string, string> = {};
    const depth = SSH_INCLUDE_MAX_DEPTH + 1;
    for (let i = 1; i < depth; i++) files[`c${i}`] = `Include c${i + 1}\n`;
    files[`c${depth}`] = "Host gh-work\n  HostName github.com\n";
    assert.equal(lookupSshHost("gh-work", { sshDir: sshDirWith("Include c1\n", files) }).kind, "unresolved");

    const ok: Record<string, string> = {};
    for (let i = 1; i < SSH_INCLUDE_MAX_DEPTH; i++) ok[`c${i}`] = `Include c${i + 1}\n`;
    ok[`c${SSH_INCLUDE_MAX_DEPTH}`] = "Host gh-work\n  HostName github.com\n";
    assert.deepEqual(lookupSshHost("gh-work", { sshDir: sshDirWith("Include c1\n", ok) }), {
      kind: "hostname",
      hostName: "github.com",
    });
  });

  it("an Include using an environment variable or % token is unresolved", () => {
    assert.equal(lookupSshHost("h", { sshDir: sshDirWith("Include ${HOME}/x\n") }).kind, "unresolved");
    assert.equal(lookupSshHost("h", { sshDir: sshDirWith("Include %d/x\n") }).kind, "unresolved");
  });

  it("a glob in a directory component is unresolved", () => {
    assert.equal(lookupSshHost("h", { sshDir: sshDirWith("Include */config\n") }).kind, "unresolved");
  });
});

describe("lookupSshHost — unreadable input fails closed", () => {
  it("a config that exists but cannot be read is unresolved", (t) => {
    if (process.getuid?.() === 0) return t.skip("root can read anything");
    const sshDir = sshDirWith("Host gh-work\n  HostName github.com\n");
    chmodSync(join(sshDir, "config"), 0o000);
    try {
      assert.equal(lookupSshHost("gh-work", { sshDir }).kind, "unresolved");
    } finally {
      chmodSync(join(sshDir, "config"), 0o600);
    }
  });

  it("a config that is a directory is not a config (none), never a crash", () => {
    const sshDir = sshDirWith(null);
    mkdirSync(join(sshDir, "config"));
    assert.deepEqual(lookupSshHost("gh-work", { sshDir }), { kind: "none" });
  });

  it("never throws on garbage", () => {
    const sshDir = sshDirWith("\u0000\u0001 Host\nHost\nHostName\nInclude\n=\n\"unterminated\n");
    assert.doesNotThrow(() => lookupSshHost("x", { sshDir }));
  });
});
