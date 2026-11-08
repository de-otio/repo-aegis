// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// loadGhAliases reads gh's config through one descriptor (code-scanning js/file-system-race): the size cap
// and the read see the same file, and a path that is not a regular file makes the aliases UNKNOWN (null)
// without blocking.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadGhAliases } from "./gh-env.js";

function configDir(): string {
  return mkdtempSync(join(tmpdir(), "gh-env-test-"));
}

describe("loadGhAliases: bounded, race-free read", () => {
  it("no config files: no aliases (empty, not unknown)", () => {
    const dir = configDir();
    assert.deepEqual([...(loadGhAliases({ GH_CONFIG_DIR: dir }) ?? new Map([["unknown", ""]]))], []);
  });

  it("reads the aliases map of config.yml", () => {
    const dir = configDir();
    writeFileSync(join(dir, "config.yml"), "aliases:\n  ic: issue create\n");
    assert.equal(loadGhAliases({ GH_CONFIG_DIR: dir })?.get("ic"), "issue create");
  });

  it("a file exactly at the 1 MiB cap is read; one byte over makes the aliases unknown", () => {
    const head = "aliases:\n  ic: issue create\n#";
    const atCap = configDir();
    writeFileSync(join(atCap, "config.yml"), head + "x".repeat(1024 * 1024 - head.length));
    assert.equal(loadGhAliases({ GH_CONFIG_DIR: atCap })?.get("ic"), "issue create");
    const over = configDir();
    writeFileSync(join(over, "config.yml"), head + "x".repeat(1024 * 1024 - head.length + 1));
    assert.equal(loadGhAliases({ GH_CONFIG_DIR: over }), null);
  });

  it("a directory at the config path makes the aliases unknown", () => {
    const dir = configDir();
    mkdirSync(join(dir, "config.yml"));
    assert.equal(loadGhAliases({ GH_CONFIG_DIR: dir }), null);
  });

  it("a FIFO at the config path makes the aliases unknown and does not block", { skip: process.platform === "win32" }, () => {
    const dir = configDir();
    execFileSync("mkfifo", [join(dir, "config.yml")]);
    assert.equal(loadGhAliases({ GH_CONFIG_DIR: dir }), null);
  });
});
