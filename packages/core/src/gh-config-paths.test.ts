// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ghConfigDirs, isGhConfigFile } from "./gh-config-paths.js";

const HOME = "/home/example";
const ctx = (env: NodeJS.ProcessEnv = {}, cwd = "/work/repo") => ({ env, home: HOME, cwd });

describe("isGhConfigFile (L6)", () => {
  it("covers config.yml and hosts.yml in ~/.config/gh, as absolute, ~ and relative paths", () => {
    for (const p of [
      "/home/example/.config/gh/config.yml",
      "/home/example/.config/gh/hosts.yml",
      "~/.config/gh/hosts.yml",
      "../../home/example/.config/gh/hosts.yml",
      "/home/example/.config/gh/../gh/hosts.yml",
      "/home/example/.config//gh/hosts.yml",
    ]) {
      assert.equal(isGhConfigFile(p, ctx()), true, p);
    }
    assert.equal(isGhConfigFile("hosts.yml", ctx({}, "/home/example/.config/gh")), true);
  });

  it("covers $GH_CONFIG_DIR and $XDG_CONFIG_HOME/gh, and still ~/.config/gh", () => {
    assert.equal(isGhConfigFile("/opt/gh-conf/hosts.yml", ctx({ GH_CONFIG_DIR: "/opt/gh-conf" })), true);
    assert.equal(isGhConfigFile("/opt/xdg/gh/config.yml", ctx({ XDG_CONFIG_HOME: "/opt/xdg" })), true);
    assert.equal(isGhConfigFile("/home/example/.config/gh/hosts.yml", ctx({ GH_CONFIG_DIR: "/opt/gh-conf" })), true);
    assert.deepEqual(ghConfigDirs(ctx({ GH_CONFIG_DIR: "/a", XDG_CONFIG_HOME: "/b" })), ["/home/example/.config/gh", "/a", "/b/gh"]);
  });

  it("does not touch other files or other directories", () => {
    for (const p of [
      "/home/example/.config/gh/state.yml",
      "/home/example/.config/gh/hosts.yml.bak",
      "/home/example/.config/gh/sub/hosts.yml",
      "/home/example/.config/other/config.yml",
      "/home/example/.config/ghx/hosts.yml",
      "/work/repo/config.yml",
      "/work/repo/hosts.yml",
      "/opt/gh-conf/hosts.yml",
    ]) {
      assert.equal(isGhConfigFile(p, ctx()), false, p);
    }
  });

  it("follows a symlinked directory", () => {
    const tmp = realpathSync(mkdtempSync(join(tmpdir(), "repo-aegis-gh-config-")));
    try {
      const real = join(tmp, "real-gh");
      mkdirSync(real);
      const link = join(tmp, "link");
      symlinkSync(real, link);
      assert.equal(isGhConfigFile(join(link, "hosts.yml"), ctx({ GH_CONFIG_DIR: real })), true);
      assert.equal(isGhConfigFile(join(real, "hosts.yml"), ctx({ GH_CONFIG_DIR: link })), true);
      assert.equal(isGhConfigFile(join(link, "other.yml"), ctx({ GH_CONFIG_DIR: real })), false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
