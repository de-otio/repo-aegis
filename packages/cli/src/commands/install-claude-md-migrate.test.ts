// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// D8.5: moving to the managed drop-in removes repo-aegis's own earlier entries
// from the user's settings.json, and only after the managed write is verified and
// no other managed source shadows it. T17: everything else in that file survives
// byte for byte. Placeholder names only; the system is simulated.
import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EnforcementPin } from "@de-otio/repo-aegis-core";
import { captureOutput, withEnv } from "../_test-utils.js";
import { makeFakeSystem, putFile, type FakeSystem } from "../_managed-test-utils.js";
import { installClaudeMd, registryDenyPlan } from "./install-claude-md.js";
import { managedPaths } from "./managed-dropin.js";

let tmp: string;
let n = 0;
const systems: FakeSystem[] = [];
before(() => {
  tmp = mkdtempSync(join(tmpdir(), "repo-aegis-migrate-"));
});
after(() => {
  rmSync(tmp, { recursive: true, force: true });
});
afterEach(() => {
  for (const s of systems.splice(0)) rmSync(s.root, { recursive: true, force: true });
});

const PIN: EnforcementPin = { node: "/opt/node-x/bin/node", cli: "/opt/lib/node_modules/@de-otio/repo-aegis/dist/index.js" };
const PERSON = { stderrIsTTY: true, stdinIsTTY: true, readAnswer: () => "y" };

interface Env {
  claudeHome: string;
  aegisHome: string;
  settingsPath: string;
  sys: FakeSystem;
}
function makeEnv(platform: NodeJS.Platform = "linux"): Env {
  const base = join(tmp, `case-${n++}`);
  const claudeHome = join(base, "claude");
  const aegisHome = join(base, "aegis");
  mkdirSync(claudeHome, { recursive: true });
  mkdirSync(join(aegisHome, "state"), { recursive: true });
  const sys = makeFakeSystem({ platform, uid: platform === "darwin" ? 501 : 1000 });
  systems.push(sys);
  return { claudeHome, aegisHome, settingsPath: join(claudeHome, "settings.json"), sys };
}
function run(e: Env, opts: Record<string, unknown>) {
  return withEnv("REPO_AEGIS_MARKERS_DIR", undefined, () =>
    withEnv("REPO_AEGIS_REGISTRY", undefined, () =>
      withEnv("REPO_AEGIS_HOME", e.aegisHome, () =>
        captureOutput(() => installClaudeMd({ claudeHome: e.claudeHome, pin: PIN, managed: { env: e.sys.env, terminal: PERSON }, ...opts })),
      ),
    ),
  );
}

/** `install claude-md` again, with `terminal` and any further managed seams. */
function rerun(e: Env, terminal: Record<string, unknown>, seams: Record<string, unknown> = {}) {
  return withEnv("REPO_AEGIS_HOME", e.aegisHome, () =>
    captureOutput(() => installClaudeMd({ claudeHome: e.claudeHome, pin: PIN, managed: { env: e.sys.env, terminal, ...seams } })),
  );
}

/** What the user keeps in their own file, in an order that is not alphabetical. */
const USER_OWN = {
  model: "sonnet",
  env: { EXAMPLE_FLAG: "1" },
  permissions: { allow: ["Bash(ls:*)"], deny: ["Bash(rm:*)"] },
  hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo mine" }] }] },
};

/** The user's file as a D7 install left it: their own settings with repo-aegis's entries merged in, serialised with `indent`. */
function seedWithOurEntries(e: Env, indent: string | number, trailingNewline = true): string {
  writeFileSync(e.settingsPath, JSON.stringify(USER_OWN, null, 2) + "\n");
  run(e, { userSettings: true });
  const merged = JSON.parse(readFileSync(e.settingsPath, "utf8")) as unknown;
  const text = JSON.stringify(merged, null, indent) + (trailingNewline ? "\n" : "");
  writeFileSync(e.settingsPath, text);
  return text;
}

describe("T17: migration removes the old user-file entries and keeps everything else byte for byte", () => {
  for (const [name, indent, nl] of [
    ["two-space JSON", 2, true],
    ["four-space JSON", 4, true],
    ["tab-indented JSON", "\t", true],
    ["two-space JSON with no trailing newline", 2, false],
  ] as const) {
    it(name, () => {
      const e = makeEnv();
      seedWithOurEntries(e, indent, nl);
      const before = JSON.parse(readFileSync(e.settingsPath, "utf8")) as { hooks: Record<string, unknown>; permissions: { deny: string[] } };
      assert.ok(Object.keys(before.hooks).length > 1 && before.permissions.deny.length > 1, "the seed holds repo-aegis's entries");

      const out = run(e, {});
      assert.equal(out.exitCode, undefined, out.stderr);
      const expected = JSON.stringify(USER_OWN, null, indent) + (nl ? "\n" : "");
      assert.equal(readFileSync(e.settingsPath, "utf8"), expected);
    });
  }

  it("a compact one-line file stays compact", () => {
    const e = makeEnv();
    seedWithOurEntries(e, 2);
    writeFileSync(e.settingsPath, JSON.stringify(JSON.parse(readFileSync(e.settingsPath, "utf8"))));
    run(e, {});
    assert.equal(readFileSync(e.settingsPath, "utf8"), JSON.stringify(USER_OWN));
  });

  it("a deny rule the user wrote themselves is kept, even when it is identical to one install writes (the ledger decides)", () => {
    const e = makeEnv();
    const theirs = withEnv("REPO_AEGIS_HOME", e.aegisHome, () => registryDenyPlan(PIN).rules[0]!);
    const own = { ...USER_OWN, permissions: { allow: USER_OWN.permissions.allow, deny: ["Bash(rm:*)", theirs] } };
    writeFileSync(e.settingsPath, JSON.stringify(own, null, 2) + "\n");
    run(e, { userSettings: true });
    run(e, {});
    assert.equal(readFileSync(e.settingsPath, "utf8"), JSON.stringify({ ...own, hooks: USER_OWN.hooks }, null, 2) + "\n");
  });

  it("removes old by-name `repo-aegis hook ...` entries too", () => {
    const e = makeEnv();
    writeFileSync(
      e.settingsPath,
      JSON.stringify({ model: "x", hooks: { PostToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "repo-aegis hook scan-bash-output" }, { type: "command", command: "echo mine" }] }] } }, null, 2) + "\n",
    );
    run(e, {});
    assert.equal(
      readFileSync(e.settingsPath, "utf8"),
      JSON.stringify({ model: "x", hooks: { PostToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo mine" }] }] } }, null, 2) + "\n",
    );
  });

  it("a user file with nothing of ours is not rewritten, and a missing one is not created", () => {
    const e = makeEnv();
    const odd = '{ "model":   "x",\n\n  "env": {} }\n';
    writeFileSync(e.settingsPath, odd);
    run(e, {});
    assert.equal(readFileSync(e.settingsPath, "utf8"), odd, "hand formatting survives untouched");
    const e2 = makeEnv();
    run(e2, {});
    assert.throws(() => readFileSync(e2.settingsPath, "utf8"), /ENOENT/);
  });

  it("running it again changes nothing", () => {
    const e = makeEnv();
    seedWithOurEntries(e, 2);
    run(e, {});
    const once = readFileSync(e.settingsPath, "utf8");
    const out = run(e, {});
    assert.equal(readFileSync(e.settingsPath, "utf8"), once);
    assert.equal(out.exitCode, undefined, out.stderr);
  });

  it("tells the person to confirm /status shows the drop-in", () => {
    const e = makeEnv();
    seedWithOurEntries(e, 2);
    const out = run(e, {});
    assert.ok(out.stdout.includes("/status"), out.stdout);
    assert.ok(out.stdout.includes("(drop-ins)") && out.stdout.includes("(file + drop-ins)"), out.stdout);
  });
});

describe("D8.5: it only happens after the managed write is verified and nothing shadows it", () => {
  it("a failed managed write leaves the user file exactly as it was", () => {
    const e = makeEnv();
    const text = seedWithOurEntries(e, 2);
    e.sys.intercept = c => (c.args[0] === "/usr/bin/tee" ? { status: 1, stdout: "", stderr: "disk full" } : undefined);
    const out = run(e, {});
    assert.equal(out.exitCode, 1);
    assert.equal(readFileSync(e.settingsPath, "utf8"), text);
  });

  it("a declined install leaves the user file exactly as it was", () => {
    const e = makeEnv();
    const text = seedWithOurEntries(e, 2);
    const out = withEnv("REPO_AEGIS_HOME", e.aegisHome, () =>
      captureOutput(() =>
        installClaudeMd({ claudeHome: e.claudeHome, pin: PIN, managed: { env: e.sys.env, terminal: { ...PERSON, readAnswer: () => "n" } } }),
      ),
    );
    assert.equal(out.exitCode, 2);
    assert.equal(readFileSync(e.settingsPath, "utf8"), text);
  });

  it("a sibling managed file that sets disableAllHooks keeps the old entries and says why", () => {
    const e = makeEnv();
    const text = seedWithOurEntries(e, 2);
    const paths = managedPaths("linux", 1000)!;
    putFile(e.sys, `${paths.dropinDir}/10-corp.json`, '{"disableAllHooks": true}\n');
    const out = run(e, {});
    assert.equal(out.exitCode, undefined, out.stderr);
    assert.equal(readFileSync(e.settingsPath, "utf8"), text, "the user-file entries are the only enforcement that works now");
    assert.match(out.stdout, /MANAGED_HOOKS_DISABLED/);
    assert.match(out.stdout, /10-corp\.json/);
  });

  it("a macOS configuration profile (first-wins) keeps the old entries and says why", () => {
    const e = makeEnv("darwin");
    const text = seedWithOurEntries(e, 2);
    putFile(e.sys, "/Library/Managed Preferences/com.anthropic.claudecode.plist", "<plist/>");
    const out = run(e, {});
    assert.equal(out.exitCode, undefined, out.stderr);
    assert.equal(readFileSync(e.settingsPath, "utf8"), text);
    assert.match(out.stdout, /MANAGED_SOURCE_SHADOWED/);
  });

  it("the same profile does not matter on Linux, and no profile matters on macOS", () => {
    const linux = makeEnv("linux");
    seedWithOurEntries(linux, 2);
    putFile(linux.sys, "/Library/Managed Preferences/com.anthropic.claudecode.plist", "<plist/>");
    run(linux, {});
    assert.equal(readFileSync(linux.settingsPath, "utf8"), JSON.stringify(USER_OWN, null, 2) + "\n");
    const mac = makeEnv("darwin");
    seedWithOurEntries(mac, 2);
    run(mac, {});
    assert.equal(readFileSync(mac.settingsPath, "utf8"), JSON.stringify(USER_OWN, null, 2) + "\n");
  });

  it("an already-installed, unchanged drop-in still migrates old entries, with a person at the terminal and no root step", () => {
    const e = makeEnv();
    run(e, {});
    const text = seedWithOurEntries(e, 2);
    assert.ok(text.includes("hooks"));
    const before = e.sys.calls.length;
    const out = rerun(e, PERSON);
    assert.equal(out.exitCode, undefined, out.stderr);
    assert.equal(e.sys.calls.length, before, "nothing ran as root");
    assert.equal(readFileSync(e.settingsPath, "utf8"), JSON.stringify(USER_OWN, null, 2) + "\n");
  });
});

// Security review M1: with the drop-in unchanged there is no root step, so nothing
// asked for a terminal, and an agent could strip the user-file fallback that a
// person had put back because the drop-in was shadowed.
describe("M1: migration needs a person at a terminal and a heartbeat that does not fail", () => {
  /** An unchanged drop-in installed an hour ago, and a user file a person re-added our entries to. */
  function installedThenReadded(): { e: Env; text: string } {
    const e = makeEnv();
    run(e, {});
    const l = JSON.parse(readFileSync(join(e.aegisHome, "state", "claude-md-managed.json"), "utf8")) as Record<string, unknown>;
    writeFileSync(join(e.aegisHome, "state", "claude-md-managed.json"), JSON.stringify({ ...l, installedAt: new Date(Date.now() - 3_600_000).toISOString() }));
    const text = seedWithOurEntries(e, 2);
    e.sys.calls.length = 0;
    return { e, text };
  }

  it("drop-in unchanged + the heartbeat failing: the user file stays byte-identical and says why", () => {
    const { e, text } = installedThenReadded();
    // A session started after the install and no heartbeat was ever recorded.
    const out = rerun(e, PERSON, { sessionBirths: () => [Date.now() - 60_000] });
    assert.equal(out.exitCode, undefined, out.stderr);
    assert.equal(readFileSync(e.settingsPath, "utf8"), text);
    assert.match(out.stdout, /MANAGED_HOOKS_NOT_FIRING/);
    assert.equal(e.sys.calls.length, 0, "nothing ran as root");
  });

  it("drop-in unchanged + the heartbeat fine: it migrates", () => {
    const { e } = installedThenReadded();
    writeFileSync(join(e.aegisHome, "state", "managed-hooks-seen"), new Date().toISOString() + "\n");
    const out = rerun(e, PERSON, { sessionBirths: () => [Date.now() - 60_000] });
    assert.equal(out.exitCode, undefined, out.stderr);
    assert.equal(readFileSync(e.settingsPath, "utf8"), JSON.stringify(USER_OWN, null, 2) + "\n");
  });

  it("drop-in unchanged + no terminal: the user file stays byte-identical and the output lists what a terminal run would remove", () => {
    const { e, text } = installedThenReadded();
    const out = rerun(e, { stderrIsTTY: false });
    assert.equal(out.exitCode, undefined, out.stderr);
    assert.equal(readFileSync(e.settingsPath, "utf8"), text);
    assert.match(out.stdout, /from a terminal/);
    assert.match(out.stdout, /would remove \d+ hook entr(y|ies) and \d+ permissions\.deny rule/);
    assert.equal(e.sys.calls.length, 0);
  });

  it("a terminal where an agent host sits above the process counts as no terminal", () => {
    const { e, text } = installedThenReadded();
    const out = rerun(e, { stderrIsTTY: true, ancestry: () => [{ pid: 2, ppid: 1, comm: "claude", argv: ["claude"], uid: 501 }, { pid: 1, ppid: 0, comm: "launchd", argv: ["launchd"], uid: 0 }] });
    assert.equal(out.exitCode, undefined, out.stderr);
    assert.equal(readFileSync(e.settingsPath, "utf8"), text);
  });

  it("no terminal and nothing to remove says nothing about migration", () => {
    const e = makeEnv();
    run(e, {});
    const out = rerun(e, { stderrIsTTY: false });
    assert.equal(out.exitCode, undefined, out.stderr);
    assert.doesNotMatch(out.stdout, /would remove/);
  });
});
