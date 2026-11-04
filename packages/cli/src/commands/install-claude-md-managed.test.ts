// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// `install claude-md` writing the managed-settings drop-in
// (doc/plan-pin-enforcement-binary.md D8.1 to D8.4, D8.6, P3 to P7), end to end
// over a simulated system: platform, uid, file system root and the privileged
// runner are injected, so the darwin and the linux layouts run on any host and
// nothing ever escalates. Placeholder names only.
import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EnforcementPin } from "@de-otio/repo-aegis-core";
import { captureOutput, lastJsonLine, withEnv } from "../_test-utils.js";
import { makeDir, makeFakeSystem, type FakeSystem } from "../_managed-test-utils.js";
import { installClaudeMd, registryDenyPlan } from "./install-claude-md.js";
import { digestOf, managedPaths, renderDropIn, type DropInSpec } from "./managed-dropin.js";
import { readManagedLedger } from "./managed-ledger.js";
import { realSpawn } from "./managed-privileged.js";

let tmp: string;
let n = 0;
const systems: FakeSystem[] = [];
before(() => {
  tmp = mkdtempSync(join(tmpdir(), "repo-aegis-managed-install-"));
});
after(() => {
  rmSync(tmp, { recursive: true, force: true });
});
afterEach(() => {
  for (const s of systems.splice(0)) rmSync(s.root, { recursive: true, force: true });
});

const PIN: EnforcementPin = {
  node: "/opt/node-x/bin/node",
  cli: "/opt/lib/node_modules/@de-otio/repo-aegis/dist/index.js",
};

interface Env {
  claudeHome: string;
  aegisHome: string;
  settingsPath: string;
  sys: FakeSystem;
}

function makeEnv(platform: NodeJS.Platform = "linux", uid = platform === "darwin" ? 501 : 1000): Env {
  const base = join(tmp, `case-${n++}`);
  const claudeHome = join(base, "claude");
  const aegisHome = join(base, "aegis");
  mkdirSync(claudeHome, { recursive: true });
  mkdirSync(join(aegisHome, "state"), { recursive: true });
  const sys = makeFakeSystem({ platform, uid });
  systems.push(sys);
  return { claudeHome, aegisHome, settingsPath: join(claudeHome, "settings.json"), sys };
}

interface Terminal {
  stderrIsTTY?: boolean;
  stdinIsTTY?: boolean;
  readAnswer?: () => string;
}
const PERSON: Terminal = { stderrIsTTY: true, stdinIsTTY: true, readAnswer: () => "y" };

function install(e: Env, opts: Record<string, unknown> = {}, terminal: Terminal = PERSON) {
  return withEnv("REPO_AEGIS_MARKERS_DIR", undefined, () =>
    withEnv("REPO_AEGIS_REGISTRY", undefined, () =>
      withEnv("REPO_AEGIS_HOME", e.aegisHome, () =>
        captureOutput(() =>
          installClaudeMd({ claudeHome: e.claudeHome, pin: PIN, managed: { env: e.sys.env, terminal }, ...opts }),
        ),
      ),
    ),
  );
}

/** The text the installer should have written for `e`. */
function expectedText(e: Env, over: Partial<DropInSpec> = {}): string {
  const paths = managedPaths(e.sys.env.platform, e.sys.env.uid)!;
  return withEnv("REPO_AEGIS_HOME", e.aegisHome, () =>
    renderDropIn({ pin: PIN, uid: String(e.sys.env.uid), file: paths.file, firstTouch: false, denyRules: registryDenyPlan(PIN).rules, ...over }),
  );
}

const ledger = (e: Env) => withEnv("REPO_AEGIS_HOME", e.aegisHome, () => readManagedLedger());

for (const [platform, uid] of [["darwin", 501], ["linux", 1000]] as const) {
  describe(`install claude-md writes the managed drop-in (${platform})`, () => {
    it("creates the file as root:root 0644 with exactly the rendered content, and leaves the user's settings.json alone", () => {
      const e = makeEnv(platform, uid);
      const paths = managedPaths(platform, uid)!;
      const out = install(e);
      assert.equal(out.exitCode, undefined, out.stderr);
      assert.equal(readFileSync(e.sys.at(paths.file), "utf8"), expectedText(e));
      const st = e.sys.env.fs.lstat(paths.file)!;
      assert.deepEqual([st.uid, st.gid, st.mode & 0o7777], [0, 0, 0o644]);
      assert.equal(existsSync(e.settingsPath), false, "enforcement must not go into the user's file");
      assert.ok(out.stdout.includes(paths.file), out.stdout);
      assert.ok(readFileSync(join(e.claudeHome, "CLAUDE.md"), "utf8").includes("repo-aegis: managed block"));
    });

    it("records the digest and the directories it created in the ledger, before and after", () => {
      const e = makeEnv(platform, uid);
      install(e);
      const l = ledger(e)!;
      assert.equal(l.uid, String(uid));
      assert.equal(l.digest, digestOf(expectedText(e)));
      assert.deepEqual(l.createdDirs, { system: true, dropin: true });
    });

    it("only `sudo -k`, the directory creates, tee, chown, chmod and mv run as root", () => {
      const e = makeEnv(platform, uid);
      install(e);
      const verbs = e.sys.calls.map(c => c.args[0]!);
      assert.deepEqual(verbs, ["-k", "/usr/bin/install", "/usr/bin/install", "/usr/bin/tee", platform === "darwin" ? "/usr/sbin/chown" : "/bin/chown", "/bin/chmod", "/bin/mv", "-k"]);
    });
  });
}

describe("install claude-md (managed): the person decides", () => {
  it("without a terminal it refuses before writing or running anything (MANAGED_NEEDS_TTY)", () => {
    const e = makeEnv();
    const out = install(e, { json: true }, { stderrIsTTY: false, stdinIsTTY: false });
    assert.equal(out.exitCode, 2);
    assert.equal(lastJsonLine<{ code: string }>(out.stderr).code, "MANAGED_NEEDS_TTY");
    assert.equal(e.sys.calls.length, 0);
    assert.equal(existsSync(join(e.claudeHome, "CLAUDE.md")), false);
    assert.equal(ledger(e), null);
  });

  it("stdin that is not a terminal cannot confirm: nothing runs", () => {
    const e = makeEnv();
    const out = install(e, { json: true }, { stderrIsTTY: true, stdinIsTTY: false });
    assert.equal(out.exitCode, 2);
    assert.equal(lastJsonLine<{ code: string }>(out.stderr).code, "MANAGED_NOT_CONFIRMED");
    assert.equal(e.sys.calls.length, 0);
  });

  it("answering no writes nothing and runs nothing", () => {
    const e = makeEnv();
    const out = install(e, { json: true }, { stderrIsTTY: true, stdinIsTTY: true, readAnswer: () => "n" });
    assert.equal(out.exitCode, 2);
    assert.equal(lastJsonLine<{ code: string }>(out.stderr).code, "MANAGED_NOT_CONFIRMED");
    assert.equal(e.sys.calls.length, 0);
    assert.equal(ledger(e), null);
  });

  it("shows the target path, a byte count, a digest and a diff before asking (P5)", () => {
    const e = makeEnv("linux", 1000);
    const paths = managedPaths("linux", 1000)!;
    // Run twice with different pins: the second shows a diff against the first.
    install(e);
    const text = expectedText(e);
    const other: EnforcementPin = { node: PIN.node, cli: "/opt/other/dist/index.js" };
    const summary = install(e, { pin: other }).stderr;
    assert.ok(summary.includes(paths.file), summary);
    assert.ok(summary.includes(`${Buffer.byteLength(text)} bytes`) || /\d+ bytes/.test(summary), summary);
    assert.match(summary, /sha256 [0-9a-f]{64}/);
    assert.match(summary, /^\s*- .*\/opt\/lib\/node_modules/m, "the removed line");
    assert.match(summary, /^\s*\+ .*\/opt\/other\/dist/m, "the added line");
    assert.match(summary, /\[y\/N\]/);
  });
});

describe("install claude-md (managed): idempotence and re-pin", () => {
  it("a second run with nothing changed runs nothing as root and needs no terminal", () => {
    const e = makeEnv();
    install(e);
    const before = e.sys.calls.length;
    const out = install(e, {}, { stderrIsTTY: false, stdinIsTTY: false });
    assert.equal(out.exitCode, undefined, out.stderr);
    assert.equal(e.sys.calls.length, before);
    assert.match(out.stdout, /already installed|unchanged/);
  });

  // Security review L2: "unchanged" looked only at the file, so a drop-in directory that
  // had become group-writable was reported as installed and fine.
  it("L2: an unchanged file in a group-writable managed-settings.d is not 'already installed': it is refused before any root step", () => {
    const e = makeEnv();
    install(e);
    const paths = managedPaths("linux", 1000)!;
    chmodSync(e.sys.at(paths.dropinDir), 0o775);
    const before = e.sys.calls.length;
    const out = install(e, { json: true });
    assert.equal(out.exitCode, 2, out.stdout);
    const err = lastJsonLine<{ code: string; error: string }>(out.stderr);
    assert.equal(err.code, "SYSTEM_DIR_UNSAFE");
    assert.match(err.error, /managed-settings\.d/);
    assert.equal(e.sys.calls.length, before, "nothing ran as root");
    assert.doesNotMatch(out.stdout, /already installed/);
  });

  it("L2: the same unsafe directory is refused without a terminal too, rather than reported as unchanged", () => {
    const e = makeEnv();
    install(e);
    chmodSync(e.sys.at(managedPaths("linux", 1000)!.dropinDir), 0o775);
    const out = install(e, { json: true }, { stderrIsTTY: false, stdinIsTTY: false });
    assert.equal(out.exitCode, 2);
    assert.doesNotMatch(out.stdout, /already installed/);
  });

  it("a new pin replaces the file and keeps the created-directories record", () => {
    const e = makeEnv();
    install(e);
    const other: EnforcementPin = { node: PIN.node, cli: "/opt/other/dist/index.js" };
    const out = install(e, { pin: other });
    assert.equal(out.exitCode, undefined, out.stderr);
    const paths = managedPaths("linux", 1000)!;
    assert.ok(readFileSync(e.sys.at(paths.file), "utf8").includes("/opt/other/dist/index.js"));
    assert.deepEqual(ledger(e)!.createdDirs, { system: true, dropin: true });
  });

  it("directories that were already there are recorded as not ours", () => {
    const e = makeEnv();
    makeDir(e.sys, managedPaths("linux", 1000)!.dropinDir);
    install(e);
    assert.deepEqual(ledger(e)!.createdDirs, { system: false, dropin: false });
  });

  it("first-touch is kept once it was registered, even if a later run omits the flag", () => {
    const e = makeEnv();
    install(e, { firstTouch: true });
    const paths = managedPaths("linux", 1000)!;
    assert.ok(readFileSync(e.sys.at(paths.file), "utf8").includes("hook first-touch"));
    install(e, {});
    assert.ok(readFileSync(e.sys.at(paths.file), "utf8").includes("hook first-touch"));
  });
});

describe("install claude-md (managed): refusals before any root action", () => {
  it("P5: a path that breaks D6 (a newline in the registry home) is refused, nothing runs", () => {
    const e = makeEnv();
    e.aegisHome = join(tmp, `case-${n++}`, "aegis\nhome");
    mkdirSync(join(e.aegisHome, "state"), { recursive: true });
    const out = install(e, { json: true });
    assert.equal(out.exitCode, 2);
    assert.equal(lastJsonLine<{ code: string }>(out.stderr).code, "DROPIN_INVALID");
    assert.equal(e.sys.calls.length, 0);
  });

  it("P1: a sudo that root does not own is refused, with the --user-settings way out", () => {
    const e = makeEnv();
    e.sys.owners.set("/usr/bin/sudo", { uid: 1000, gid: 1000 });
    const out = install(e, { json: true });
    assert.equal(out.exitCode, 2);
    const err = lastJsonLine<{ code: string; error: string; details?: string }>(out.stderr);
    assert.equal(err.code, "PRIVILEGED_TOOL_UNSAFE");
    assert.match(err.error + (err.details ?? ""), /--user-settings/);
    assert.equal(e.sys.calls.length, 0);
    assert.equal(existsSync(join(e.claudeHome, "CLAUDE.md")), false);
  });

  it("P4: a group-writable system directory is refused (WSL, a shared box), with the --user-settings way out", () => {
    const e = makeEnv();
    makeDir(e.sys, managedPaths("linux", 1000)!.systemDir, 0o775);
    const out = install(e, { json: true });
    assert.equal(out.exitCode, 2);
    const err = lastJsonLine<{ code: string; error: string; details?: string }>(out.stderr);
    assert.equal(err.code, "SYSTEM_DIR_UNSAFE");
    assert.match(err.error + (err.details ?? ""), /--user-settings/);
    assert.equal(e.sys.calls.length, 0);
  });
});

describe("install claude-md (managed): failures after the person said yes", () => {
  it("a failed tee exits 1, leaves no file and no ledger, and says why", () => {
    const e = makeEnv();
    e.sys.intercept = c => (c.args[0] === "/usr/bin/tee" ? { status: 1, stdout: "", stderr: "No space left on device" } : undefined);
    const out = install(e, { json: true });
    assert.equal(out.exitCode, 1);
    assert.match(out.stderr, /could not stage/);
    assert.equal(existsSync(e.sys.at(managedPaths("linux", 1000)!.file)), false);
    assert.equal(existsSync(join(e.claudeHome, "CLAUDE.md")), false, "CLAUDE.md is only touched once the drop-in is in place");
    assert.ok(!e.sys.calls.some(c => c.args[0] === "/bin/mv"));
    assert.equal(ledger(e)?.createdDirs.dropin ?? false, true, "the directories it did create are recorded so uninstall can remove them");
  });

  it("L7: a symlink at the drop-in path exits 1 with no root step, and the symlink's target is not written", () => {
    const e = makeEnv();
    install(e);
    const paths = managedPaths("linux", 1000)!;
    rmSync(e.sys.at(paths.file));
    symlinkSync(e.sys.at("/victim"), e.sys.at(paths.file));
    e.sys.calls.length = 0;
    const out = install(e, { json: true });
    assert.equal(out.exitCode, 1);
    assert.match(out.stderr, /not a regular file/);
    assert.equal(e.sys.toolCalls().length, 0, "nothing ran as root");
    assert.equal(existsSync(e.sys.at("/victim")), false);
  });

  it("a read-back mismatch (P6) exits 1 and prints the sudo rm line", () => {
    const e = makeEnv();
    const paths = managedPaths("linux", 1000)!;
    e.sys.intercept = c => {
      if (c.args[0] !== "/bin/mv") return undefined;
      e.sys.owners.set(paths.tmp, { uid: 0, gid: 0 });
      writeFileSync(e.sys.at(paths.file), "{}\n", { mode: 0o644 });
      return { status: 0, stdout: "", stderr: "" };
    };
    const out = install(e, { json: true });
    assert.equal(out.exitCode, 1);
    assert.ok(out.stderr.includes(`sudo rm '${paths.file}'`), out.stderr);
    assert.notEqual(ledger(e), null, "the file may be there: the ledger stays so uninstall can find it");
  });
});

describe("install claude-md --dry-run (managed)", () => {
  it("prints the target, digest and the drop-in; writes nothing and runs nothing; needs no terminal", () => {
    const e = makeEnv();
    const paths = managedPaths("linux", 1000)!;
    const out = install(e, { dryRun: true }, { stderrIsTTY: false, stdinIsTTY: false });
    assert.equal(out.exitCode, undefined, out.stderr);
    assert.ok(out.stdout.includes(paths.file));
    assert.ok(out.stdout.includes(digestOf(expectedText(e))));
    assert.ok(out.stdout.includes("Edit(//"), "the deny rules are listed");
    assert.ok(out.stdout.includes("hook managed-heartbeat"));
    assert.equal(e.sys.calls.length, 0);
    assert.equal(existsSync(join(e.claudeHome, "CLAUDE.md")), false);
    assert.equal(existsSync(e.sys.at(paths.file)), false);
    assert.equal(ledger(e), null);
  });

  it("--json reports the managed target", () => {
    const e = makeEnv();
    const out = install(e, { dryRun: true, json: true }, { stderrIsTTY: false });
    const j = JSON.parse(out.stdout) as { mode: string; managed: { path: string; digest: string; bytes: number; contents: string } };
    assert.equal(j.mode, "managed");
    assert.equal(j.managed.path, managedPaths("linux", 1000)!.file);
    assert.equal(j.managed.contents, expectedText(e));
    assert.equal(j.managed.digest, digestOf(expectedText(e)));
  });
});

describe("install claude-md --json (managed)", () => {
  it("reports the drop-in that was written", () => {
    const e = makeEnv();
    const out = install(e, { json: true });
    const j = JSON.parse(out.stdout) as { mode: string; managed: { path: string; installed: boolean; digest: string } };
    assert.equal(j.mode, "managed");
    assert.equal(j.managed.installed, true);
    assert.equal(j.managed.digest, digestOf(expectedText(e)));
  });
});

describe("D8.6: --user-settings and the automatic fallbacks", () => {
  it("--user-settings writes ~/.claude/settings.json as before, with no terminal and no root action", () => {
    const e = makeEnv();
    const out = install(e, { userSettings: true }, { stderrIsTTY: false });
    assert.equal(out.exitCode, undefined, out.stderr);
    assert.equal(e.sys.calls.length, 0);
    const s = JSON.parse(readFileSync(e.settingsPath, "utf8")) as { hooks: unknown; permissions: { deny: string[] } };
    assert.ok(s.hooks && s.permissions.deny.length > 0);
    assert.equal(ledger(e), null);
  });

  for (const [name, mutate, expectNote] of [
    ["an unsupported platform", (e: Env) => ({ ...e.sys.env, platform: "win32" as NodeJS.Platform }), /platform/],
    ["running as root", (e: Env) => ({ ...e.sys.env, uid: 0 }), /root/],
    ["no /usr/bin/id", (e: Env) => { rmSync(e.sys.at("/usr/bin/id")); return e.sys.env; }, /\/usr\/bin\/id/],
  ] as const) {
    it(`${name} falls back to the user file and says so`, () => {
      const e = makeEnv();
      const env = mutate(e);
      const out = withEnv("REPO_AEGIS_HOME", e.aegisHome, () =>
        captureOutput(() => installClaudeMd({ claudeHome: e.claudeHome, pin: PIN, managed: { env, terminal: PERSON } })),
      );
      assert.equal(out.exitCode, undefined, out.stderr);
      assert.ok(existsSync(e.settingsPath), "the user file is where enforcement went");
      assert.match(out.stdout, expectNote);
      assert.match(out.stdout, /user settings|settings\.json/);
      assert.equal(e.sys.calls.length, 0);
    });
  }
});

describe("no test can escalate", () => {
  it("the real spawn refuses to run a privileged command under the test runner", () => {
    assert.throws(() => realSpawn("/usr/bin/sudo", ["-k"], { env: {}, shell: false }), /refusing to run/);
  });
});
