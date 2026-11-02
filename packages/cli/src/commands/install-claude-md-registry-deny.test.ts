// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// `install claude-md` registry write protection (doc/plan-unregistered-owner-
// egress.md §8.2, R1): permissions.deny for Edit/Write under the registry
// directory, the opposite in `--uninstall`, and the doctor check
// REGISTRY_AGENT_WRITABLE that reads them back.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureOutput, withEnv } from "../_test-utils.js";
import {
  checkRegistryAgentWritable,
  denyRuleCoversDir,
  installClaudeMd,
  registryDenyRules,
} from "./install-claude-md.js";

let tmp: string;
let n = 0;

before(() => {
  tmp = mkdtempSync(join(tmpdir(), "repo-aegis-registry-deny-"));
});
after(() => {
  rmSync(tmp, { recursive: true, force: true });
});

interface Env {
  claudeHome: string;
  aegisHome: string;
  settingsPath: string;
}

function makeEnv(name: string): Env {
  const base = join(tmp, `${name}-${n++}`);
  const claudeHome = join(base, "claude");
  const aegisHome = join(base, "aegis");
  mkdirSync(claudeHome, { recursive: true });
  mkdirSync(aegisHome, { recursive: true });
  return { claudeHome, aegisHome, settingsPath: join(claudeHome, "settings.json") };
}

/** Run `fn` with the registry resolved from `e.aegisHome` (and no REPO_AEGIS_REGISTRY override). */
function inEnv<T>(e: Env, fn: () => T): T {
  return withEnv("REPO_AEGIS_REGISTRY", undefined, () => withEnv("REPO_AEGIS_HOME", e.aegisHome, fn));
}

function readSettings(e: Env): { permissions?: { deny?: string[]; allow?: string[] }; hooks?: unknown; [k: string]: unknown } {
  return JSON.parse(readFileSync(e.settingsPath, "utf8")) as ReturnType<typeof readSettings>;
}

describe("registryDenyRules", () => {
  it("is Edit and Write under the registry directory, using Claude Code's absolute-path prefix", () => {
    assert.deepEqual(registryDenyRules("/home/u/.config/repo-aegis"), [
      "Edit(//home/u/.config/repo-aegis/**)",
      "Write(//home/u/.config/repo-aegis/**)",
    ]);
  });

  it("follows REPO_AEGIS_HOME, and the directory of REPO_AEGIS_REGISTRY when that is set", () => {
    const e = makeEnv("rules-dir");
    inEnv(e, () => assert.deepEqual(registryDenyRules(), [`Edit(/${e.aegisHome}/**)`, `Write(/${e.aegisHome}/**)`]));
    withEnv("REPO_AEGIS_REGISTRY", "/elsewhere/reg/engagements.yaml", () =>
      assert.deepEqual(registryDenyRules(), ["Edit(//elsewhere/reg/**)", "Write(//elsewhere/reg/**)"]),
    );
  });
});

describe("install claude-md — registry deny rules", () => {
  it("adds Edit and Write deny rules, keeps the user's own rules, and is idempotent", () => {
    const e = makeEnv("install");
    writeFileSync(
      e.settingsPath,
      JSON.stringify({ permissions: { deny: ["Read(//secrets/**)"], allow: ["Bash(ls)"] }, model: "x" }),
    );
    inEnv(e, () => captureOutput(() => installClaudeMd({ claudeHome: e.claudeHome })));
    const first = readSettings(e);
    const rules = inEnv(e, () => registryDenyRules());
    assert.deepEqual(first.permissions?.deny, ["Read(//secrets/**)", ...rules]);
    assert.deepEqual(first.permissions?.allow, ["Bash(ls)"]);
    assert.equal(first["model"], "x");

    inEnv(e, () => captureOutput(() => installClaudeMd({ claudeHome: e.claudeHome })));
    assert.deepEqual(readSettings(e).permissions?.deny, first.permissions?.deny, "re-running must not duplicate");
  });

  it("tells the operator to add the directory to sandbox.filesystem.denyWrite (it does not edit sandbox settings itself)", () => {
    const e = makeEnv("sandbox-note");
    const out = inEnv(e, () => captureOutput(() => installClaudeMd({ claudeHome: e.claudeHome })));
    assert.match(out.stdout, /sandbox\.filesystem\.denyWrite/);
    assert.ok(out.stdout.includes(e.aegisHome));
    assert.equal((readSettings(e) as { sandbox?: unknown }).sandbox, undefined);
  });

  it("--dry-run shows the rules and writes nothing", () => {
    const e = makeEnv("dry");
    const out = inEnv(e, () => captureOutput(() => installClaudeMd({ claudeHome: e.claudeHome, dryRun: true })));
    assert.match(out.stdout, /Edit\(\/\//);
    assert.match(out.stdout, /Write\(\/\//);
    assert.equal(existsSync(e.settingsPath), false);
  });

  it("--json reports the rules and what was added", () => {
    const e = makeEnv("json");
    const out = inEnv(e, () => captureOutput(() => installClaudeMd({ claudeHome: e.claudeHome, json: true })));
    const parsed = JSON.parse(out.stdout) as { registryDeny: { rules: string[]; added: string[]; sandboxDenyWrite: string } };
    assert.equal(parsed.registryDeny.added.length, 2);
    assert.equal(parsed.registryDeny.sandboxDenyWrite, e.aegisHome);
  });

  it("--uninstall removes exactly those rules and leaves the user's, and drops empty stubs", () => {
    const e = makeEnv("uninstall");
    writeFileSync(e.settingsPath, JSON.stringify({ permissions: { deny: ["Read(//secrets/**)"] } }));
    inEnv(e, () => captureOutput(() => installClaudeMd({ claudeHome: e.claudeHome })));
    inEnv(e, () => captureOutput(() => installClaudeMd({ claudeHome: e.claudeHome, uninstall: true })));
    const after = readSettings(e);
    assert.deepEqual(after.permissions?.deny, ["Read(//secrets/**)"]);
    assert.equal(after.hooks, undefined);

    // With no user rules the stub keys disappear entirely.
    const f = makeEnv("uninstall-clean");
    inEnv(f, () => captureOutput(() => installClaudeMd({ claudeHome: f.claudeHome })));
    inEnv(f, () => captureOutput(() => installClaudeMd({ claudeHome: f.claudeHome, uninstall: true })));
    assert.equal(readSettings(f).permissions, undefined);
  });

  it("--uninstall on a settings.json with only our rules still writes the file (rules alone are a change)", () => {
    const e = makeEnv("uninstall-rules-only");
    const rules = inEnv(e, () => registryDenyRules());
    writeFileSync(e.settingsPath, JSON.stringify({ permissions: { deny: rules } }));
    const out = inEnv(e, () => captureOutput(() => installClaudeMd({ claudeHome: e.claudeHome, uninstall: true })));
    assert.match(out.stdout, /removed 2 registry permissions\.deny rule/);
    assert.equal(readSettings(e).permissions, undefined);
  });
});

describe("denyRuleCoversDir", () => {
  const dir = "/home/u/.config/repo-aegis";
  it("accepts an absolute pattern at or above the directory, and a bare tool", () => {
    assert.equal(denyRuleCoversDir("Edit(//home/u/.config/repo-aegis/**)", "Edit", dir), true);
    assert.equal(denyRuleCoversDir("Edit(//home/u/.config/**)", "Edit", dir), true);
    assert.equal(denyRuleCoversDir("Edit(//home/u/.config/repo-aegis/*)", "Edit", dir), true);
    assert.equal(denyRuleCoversDir("Write", "Write", dir), true);
    assert.equal(denyRuleCoversDir("Edit(~/.config/repo-aegis/**)", "Edit", dir, "/home/u"), true);
  });
  it("rejects other directories, the wrong tool, relative patterns, prefixes that only look alike, and non-strings", () => {
    assert.equal(denyRuleCoversDir("Edit(//home/u/.config/other/**)", "Edit", dir), false);
    assert.equal(denyRuleCoversDir("Edit(//home/u/.config/repo-aeg/**)", "Edit", dir), false);
    assert.equal(denyRuleCoversDir("Write(//home/u/.config/repo-aegis/**)", "Edit", dir), false);
    assert.equal(denyRuleCoversDir("Edit(./.config/repo-aegis/**)", "Edit", dir), false);
    assert.equal(denyRuleCoversDir("Edit(/.config/repo-aegis/**)", "Edit", dir), false);
    assert.equal(denyRuleCoversDir(42, "Edit", dir), false);
  });
});

describe("checkRegistryAgentWritable", () => {
  it("warns (never fails) with no settings.json, an empty one, or only one of the two rules", () => {
    const e = makeEnv("check-warn");
    const dir = e.aegisHome;
    const none = checkRegistryAgentWritable(e.claudeHome, dir);
    assert.equal(none.ok, false);
    assert.equal(none.severity, "warn");
    assert.match(none.fix ?? "", /install claude-md/);
    assert.match(none.fix ?? "", /sandbox\.filesystem\.denyWrite/);

    writeFileSync(e.settingsPath, JSON.stringify({ permissions: { deny: [`Edit(/${dir}/**)`] } }));
    assert.equal(checkRegistryAgentWritable(e.claudeHome, dir).ok, false, "Edit alone is not enough");

    writeFileSync(e.settingsPath, "{ not json");
    const bad = checkRegistryAgentWritable(e.claudeHome, dir);
    assert.equal(bad.ok, false);
    assert.equal(bad.severity, "warn");
  });

  it("is clean once `install claude-md` has run, and warns again after `--uninstall`", () => {
    const e = makeEnv("check-roundtrip");
    inEnv(e, () => captureOutput(() => installClaudeMd({ claudeHome: e.claudeHome })));
    assert.equal(inEnv(e, () => checkRegistryAgentWritable(e.claudeHome)).ok, true);
    inEnv(e, () => captureOutput(() => installClaudeMd({ claudeHome: e.claudeHome, uninstall: true })));
    assert.equal(inEnv(e, () => checkRegistryAgentWritable(e.claudeHome)).ok, false);
  });
});
