// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// `install claude-md --uninstall` and the managed drop-in
// (doc/plan-pin-enforcement-binary.md D8.9, P1 to P4, P7). T24: uninstall removes
// only what the ledger lists, never anything it merely finds, and fails if the
// file remains. The privileged runner is a simulator over a temp directory.
import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EnforcementPin } from "@de-otio/repo-aegis-core";
import { captureOutput, lastJsonLine, withEnv } from "../_test-utils.js";
import { listDir, makeDir, makeFakeSystem, putFile, type FakeSystem } from "../_managed-test-utils.js";
import { installClaudeMd } from "./install-claude-md.js";
import { managedPaths } from "./managed-dropin.js";
import { managedLedgerPath, readManagedLedger } from "./managed-ledger.js";

let tmp: string;
let n = 0;
const systems: FakeSystem[] = [];
before(() => {
  tmp = mkdtempSync(join(tmpdir(), "repo-aegis-uninstall-managed-"));
});
after(() => {
  rmSync(tmp, { recursive: true, force: true });
});
afterEach(() => {
  for (const s of systems.splice(0)) rmSync(s.root, { recursive: true, force: true });
});

const PIN: EnforcementPin = { node: "/opt/node-x/bin/node", cli: "/opt/lib/node_modules/@de-otio/repo-aegis/dist/index.js" };
const PERSON = { stderrIsTTY: true, stdinIsTTY: true, readAnswer: () => "y" };
const paths = managedPaths("linux", 1000)!;

interface Env {
  claudeHome: string;
  aegisHome: string;
  settingsPath: string;
  sys: FakeSystem;
}
function makeEnv(): Env {
  const base = join(tmp, `case-${n++}`);
  const claudeHome = join(base, "claude");
  const aegisHome = join(base, "aegis");
  mkdirSync(claudeHome, { recursive: true });
  mkdirSync(join(aegisHome, "state"), { recursive: true });
  const sys = makeFakeSystem({ platform: "linux", uid: 1000 });
  systems.push(sys);
  return { claudeHome, aegisHome, settingsPath: join(claudeHome, "settings.json"), sys };
}
function run(e: Env, opts: Record<string, unknown>, terminal: Record<string, unknown> = PERSON) {
  return withEnv("REPO_AEGIS_MARKERS_DIR", undefined, () =>
    withEnv("REPO_AEGIS_REGISTRY", undefined, () =>
      withEnv("REPO_AEGIS_HOME", e.aegisHome, () =>
        captureOutput(() => installClaudeMd({ claudeHome: e.claudeHome, pin: PIN, managed: { env: e.sys.env, terminal }, ...opts })),
      ),
    ),
  );
}
const ledger = (e: Env) => withEnv("REPO_AEGIS_HOME", e.aegisHome, () => readManagedLedger());
const ledgerFile = (e: Env) => withEnv("REPO_AEGIS_HOME", e.aegisHome, () => managedLedgerPath());
const installed = (): Env => {
  const e = makeEnv();
  const out = run(e, {});
  assert.equal(out.exitCode, undefined, out.stderr);
  e.sys.calls.length = 0;
  return e;
};
const tool = (e: Env): string[][] => e.sys.toolCalls().map(c => [...c.args]);

describe("T24: uninstall removes the drop-in and what the ledger says repo-aegis created", () => {
  it("removes the file, then the two directories it created, then the ledger; sudo -k first and last", () => {
    const e = installed();
    const out = run(e, { uninstall: true });
    assert.equal(out.exitCode, undefined, out.stderr);
    assert.equal(existsSync(e.sys.at(paths.file)), false);
    assert.equal(existsSync(e.sys.at(paths.systemDir)), false);
    assert.deepEqual(
      e.sys.calls.map(c => c.args),
      [["-k"], ["/bin/rm", "-f", paths.file], ["/bin/rmdir", paths.dropinDir], ["/bin/rmdir", paths.systemDir], ["-k"]],
    );
    assert.equal(ledger(e), null);
    assert.ok(out.stdout.includes(paths.file), out.stdout);
  });

  it("never uses rm -r, and never names a path outside the drop-in's own directories", () => {
    const e = installed();
    run(e, { uninstall: true });
    for (const c of e.sys.toolCalls()) {
      assert.ok(!c.args.some(a => a === "-r" || a === "-rf" || a === "-R"), c.args.join(" "));
      for (const a of c.args.filter(x => x.startsWith("/") && !x.startsWith("/bin/"))) {
        assert.ok(a === paths.file || a === paths.dropinDir || a === paths.systemDir, a);
      }
    }
  });

  it("leaves managed-settings.json, another drop-in and another uid's drop-in alone, and so keeps the directories", () => {
    const e = installed();
    putFile(e.sys, `${paths.systemDir}/managed-settings.json`, '{"model":"x"}\n');
    putFile(e.sys, `${paths.dropinDir}/10-corp.json`, "{}\n");
    putFile(e.sys, `${paths.dropinDir}/50-repo-aegis-1001.json`, "{}\n");
    const out = run(e, { uninstall: true });
    assert.equal(out.exitCode, undefined, out.stderr);
    assert.equal(existsSync(e.sys.at(paths.file)), false);
    assert.deepEqual(listDir(e.sys, paths.dropinDir), ["10-corp.json", "50-repo-aegis-1001.json"]);
    assert.equal(readFileSync(e.sys.at(`${paths.systemDir}/managed-settings.json`), "utf8"), '{"model":"x"}\n');
    assert.ok(!e.sys.calls.some(c => c.args[0] === "/bin/rmdir"), "a non-empty directory is not even offered to rmdir");
    assert.equal(ledger(e), null);
  });

  it("does not remove directories the ledger does not say it created", () => {
    const e = makeEnv();
    makeDir(e.sys, paths.dropinDir);
    run(e, {});
    e.sys.calls.length = 0;
    run(e, { uninstall: true });
    assert.equal(existsSync(e.sys.at(paths.file)), false);
    assert.deepEqual(listDir(e.sys, paths.dropinDir), [], "an empty directory that was not ours stays");
    assert.ok(!e.sys.calls.some(c => c.args[0] === "/bin/rmdir"));
  });

  it("with the ledger deleted the drop-in is still removed (its path comes from platform and uid), the directories stay", () => {
    const e = installed();
    rmSync(ledgerFile(e));
    const out = run(e, { uninstall: true });
    assert.equal(out.exitCode, undefined, out.stderr);
    assert.equal(existsSync(e.sys.at(paths.file)), false);
    assert.ok(!e.sys.calls.some(c => c.args[0] === "/bin/rmdir"), "no ledger, no claim to have created a directory");
  });

  it("a forged ledger cannot redirect removal: its file and dirs are not paths, and it cannot make a non-empty directory go", () => {
    const e = installed();
    const forged = { ...ledger(e)!, file: "/etc/passwd", createdDirs: { system: true, dropin: true }, legacyFile: false };
    writeFileSync(ledgerFile(e), JSON.stringify(forged));
    putFile(e.sys, `${paths.dropinDir}/50-repo-aegis-1001.json`, "{}\n");
    run(e, { uninstall: true });
    assert.deepEqual(listDir(e.sys, paths.dropinDir), ["50-repo-aegis-1001.json"]);
    for (const c of e.sys.toolCalls()) assert.ok(!c.args.includes("/etc/passwd"));
  });

  it("the uid-less legacy file goes only if the ledger names it", () => {
    const e = installed();
    putFile(e.sys, paths.legacyFile, "{}\n");
    run(e, { uninstall: true });
    assert.equal(existsSync(e.sys.at(paths.legacyFile)), true, "not named by the ledger: left alone");

    const e2 = installed();
    putFile(e2.sys, paths.legacyFile, "{}\n");
    writeFileSync(ledgerFile(e2), JSON.stringify({ ...ledger(e2)!, legacyFile: true }));
    run(e2, { uninstall: true });
    assert.equal(existsSync(e2.sys.at(paths.legacyFile)), false);
  });

  it("fails with exit 1 naming the path if the file is still there afterwards, and keeps the ledger and the user entries", () => {
    const e = installed();
    writeFileSync(e.settingsPath, JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "repo-aegis hook guard-egress" }] }] } }, null, 2));
    e.sys.intercept = c => (c.args[0] === "/bin/rm" ? { status: 0, stdout: "", stderr: "" } : undefined);
    const out = run(e, { uninstall: true });
    assert.equal(out.exitCode, 1);
    assert.ok(out.stderr.includes(paths.file), out.stderr);
    assert.equal(existsSync(e.sys.at(paths.file)), true);
    assert.notEqual(ledger(e), null, "the ledger goes only after a verified removal");
    assert.ok(readFileSync(e.settingsPath, "utf8").includes("guard-egress"), "enforcement is not removed from anywhere else when the drop-in stays");
  });

  it("an rm that exits non-zero is a failure too", () => {
    const e = installed();
    e.sys.intercept = c => (c.args[0] === "/bin/rm" ? { status: 1, stdout: "", stderr: "denied" } : undefined);
    const out = run(e, { uninstall: true });
    assert.equal(out.exitCode, 1);
    assert.ok(out.stderr.includes(paths.file));
    assert.notEqual(ledger(e), null);
  });
});

describe("D8.9: the person decides, and root is only used when there is something to remove", () => {
  it("without a terminal it refuses (MANAGED_NEEDS_TTY) and removes nothing, user file included", () => {
    const e = installed();
    const out = run(e, { uninstall: true, json: true }, { stderrIsTTY: false, stdinIsTTY: false });
    assert.equal(out.exitCode, 2);
    assert.equal(lastJsonLine<{ code: string }>(out.stderr).code, "MANAGED_NEEDS_TTY");
    assert.equal(e.sys.calls.length, 0);
    assert.equal(existsSync(e.sys.at(paths.file)), true);
    assert.notEqual(ledger(e), null);
  });

  it("answering no removes nothing", () => {
    const e = installed();
    const out = run(e, { uninstall: true, json: true }, { stderrIsTTY: true, stdinIsTTY: true, readAnswer: () => "n" });
    assert.equal(out.exitCode, 2);
    assert.equal(lastJsonLine<{ code: string }>(out.stderr).code, "MANAGED_NOT_CONFIRMED");
    assert.equal(e.sys.calls.length, 0);
    assert.equal(existsSync(e.sys.at(paths.file)), true);
  });

  it("a ledger entry with no file (after a manual sudo rm) is cleaned up without sudo or a terminal when there is no directory of ours to remove", () => {
    const e = makeEnv();
    makeDir(e.sys, paths.dropinDir);
    makeDir(e.sys, paths.systemDir);
    assert.equal(run(e, {}).exitCode, undefined);
    e.sys.calls.length = 0;
    rmSync(e.sys.at(paths.file));
    const out = run(e, { uninstall: true }, { stderrIsTTY: false });
    assert.equal(out.exitCode, undefined, out.stderr);
    assert.equal(e.sys.calls.length, 0);
    assert.equal(ledger(e), null);
  });

  it("nothing installed, nothing to remove: no sudo and no terminal needed (the user-file uninstall is unchanged)", () => {
    const e = makeEnv();
    const out = run(e, { uninstall: true }, { stderrIsTTY: false });
    assert.equal(out.exitCode, undefined, out.stderr);
    assert.equal(e.sys.calls.length, 0);
  });

  it("an unsafe sudo or directory is refused here too, before anything runs", () => {
    const e = installed();
    e.sys.owners.set("/usr/bin/sudo", { uid: 1000, gid: 1000 });
    const out = run(e, { uninstall: true, json: true });
    assert.equal(out.exitCode, 2);
    assert.equal(lastJsonLine<{ code: string }>(out.stderr).code, "PRIVILEGED_TOOL_UNSAFE");
    assert.equal(e.sys.calls.length, 0);
    assert.equal(existsSync(e.sys.at(paths.file)), true);
  });

  it("silent uninstall (the full `repo-aegis uninstall` step) throws instead of exiting, so the other steps still run", () => {
    const e = installed();
    assert.throws(
      () =>
        withEnv("REPO_AEGIS_HOME", e.aegisHome, () =>
          installClaudeMd({ claudeHome: e.claudeHome, pin: PIN, uninstall: true, silent: true, managed: { env: e.sys.env, terminal: { stderrIsTTY: false } } }),
        ),
      /terminal/,
    );
    assert.equal(existsSync(e.sys.at(paths.file)), true);
  });

  it("also strips the user-file entries and the CLAUDE.md block afterwards, in that order", () => {
    const e = installed();
    writeFileSync(e.settingsPath, JSON.stringify({ model: "x", hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "repo-aegis hook guard-egress" }] }] } }, null, 2) + "\n");
    const out = run(e, { uninstall: true });
    assert.equal(out.exitCode, undefined, out.stderr);
    assert.equal(readFileSync(e.settingsPath, "utf8"), JSON.stringify({ model: "x" }, null, 2) + "\n");
    assert.ok(!readFileSync(join(e.claudeHome, "CLAUDE.md"), "utf8").includes("repo-aegis: managed block"));
  });

  it("--json reports what was removed", () => {
    const e = installed();
    const out = run(e, { uninstall: true, json: true });
    const j = JSON.parse(out.stdout) as { managed: { path: string; removed: boolean; dirsRemoved: string[]; ledgerRemoved: boolean } };
    assert.equal(j.managed.path, paths.file);
    assert.equal(j.managed.removed, true);
    assert.deepEqual(j.managed.dirsRemoved, [paths.dropinDir, paths.systemDir]);
    assert.equal(j.managed.ledgerRemoved, true);
  });
});
