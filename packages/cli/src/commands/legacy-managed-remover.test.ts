// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// legacy-managed-remover: remove in 0.17
//
// The managed drop-in feature is gone. What is left is detection: `doctor`, `install claude-md --uninstall`
// and `uninstall` must still find a drop-in an older build wrote and print the exact command that removes it,
// and must never run it. The managed-settings directory is a temp directory (the `systemDir` seam).
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureOutput, captureOutputAsync, withEnvAsync, withEnv } from "../_test-utils.js";
import { buildProgram } from "../program.js";
import { installClaudeMd } from "./install-claude-md.js";
import { uninstall } from "./uninstall.js";
import { clearLegacyState, detectLegacyDropIn, legacyDropInLines, legacyManagedCheck, legacySystemDir } from "./legacy-managed-remover.js";

const UID = 4242;
const DROPIN = `50-repo-aegis-${UID}.json`;

let tmp: string;
let n = 0;
before(() => {
  tmp = mkdtempSync(join(tmpdir(), "repo-aegis-legacy-managed-"));
});
after(() => {
  rmSync(tmp, { recursive: true, force: true });
});

interface Case {
  /** The stand-in for the managed-settings system directory. */
  systemDir: string;
  dropinDir: string;
  aegisHome: string;
  claudeHome: string;
  seams: { systemDir: string; uid: number };
  /** Write a drop-in file (default: this uid's). */
  put(name?: string, text?: string): string;
}

let c: Case;
beforeEach(() => {
  const base = join(tmp, `case-${n++}`);
  const systemDir = join(base, "ClaudeCode");
  const dropinDir = join(systemDir, "managed-settings.d");
  const aegisHome = join(base, "aegis");
  const claudeHome = join(base, "claude");
  mkdirSync(join(aegisHome, "state"), { recursive: true });
  mkdirSync(claudeHome, { recursive: true });
  c = {
    systemDir,
    dropinDir,
    aegisHome,
    claudeHome,
    seams: { systemDir, uid: UID },
    put(name = DROPIN, text = "{}\n") {
      mkdirSync(dropinDir, { recursive: true });
      const f = join(dropinDir, name);
      writeFileSync(f, text);
      return f;
    },
  };
});

const inHome = <T>(fn: () => T): T => withEnv("REPO_AEGIS_HOME", c.aegisHome, fn);
const ledgerFile = (): string => join(c.aegisHome, "state", "claude-md-managed.json");
const heartbeatFile = (): string => join(c.aegisHome, "state", "managed-hooks-seen");
const writeLedger = (createdDirs: { system: boolean; dropin: boolean }): void =>
  writeFileSync(ledgerFile(), JSON.stringify({ version: 1, uid: String(UID), file: "ignored", digest: "x", installedAt: "2026-01-01T00:00:00Z", createdDirs, legacyFile: false }));

describe("detectLegacyDropIn", () => {
  it("is null when there is no managed-settings directory at all", () => {
    assert.equal(detectLegacyDropIn(c.seams), null);
  });

  it("is null when the directory exists but holds only someone else's files", () => {
    c.put("10-corporate-policy.json");
    c.put("50-repo-aegis-9999.json"); // another account's drop-in is not this uid's to remove
    assert.equal(detectLegacyDropIn(c.seams), null);
  });

  it("finds this uid's drop-in, and prints the exact quoted remove command", () => {
    const f = c.put();
    const d = detectLegacyDropIn(c.seams);
    assert.deepEqual(d?.files, [f]);
    assert.deepEqual(d?.commands, [`sudo rm '${f}'`]);
  });

  it("quotes a path with a space and a quote, so the line pastes safely", () => {
    const base = join(tmp, `quoted-${n++}`, "it's here");
    const dropinDir = join(base, "managed-settings.d");
    mkdirSync(dropinDir, { recursive: true });
    const f = join(dropinDir, DROPIN);
    writeFileSync(f, "{}");
    const d = detectLegacyDropIn({ systemDir: base, uid: UID });
    assert.deepEqual(d?.commands, [`sudo rm '${f.replace(/'/g, `'\\''`)}'`]);
  });

  it("also finds the uid-less file an earlier build wrote", () => {
    const a = c.put("50-repo-aegis.json");
    const b = c.put();
    assert.deepEqual(detectLegacyDropIn(c.seams)?.files, [b, a]);
  });

  it("a dangling symlink at the drop-in name still counts as present", () => {
    mkdirSync(c.dropinDir, { recursive: true });
    const f = join(c.dropinDir, DROPIN);
    // lstat, not stat: a link whose target is gone is still a file Claude Code would trip over.
    symlinkSync(join(c.dropinDir, "no-such-target"), f);
    assert.deepEqual(detectLegacyDropIn(c.seams)?.files, [f]);
  });

  it("adds a rmdir line only for directories the old ledger says repo-aegis created", () => {
    const f = c.put();
    assert.deepEqual(inHome(() => detectLegacyDropIn(c.seams))?.commands, [`sudo rm '${f}'`]);

    writeLedger({ system: true, dropin: true });
    const both = inHome(() => detectLegacyDropIn(c.seams));
    assert.equal(both?.commands.length, 2);
    assert.match(both!.commands[1]!, new RegExp(`^sudo rmdir '${c.dropinDir}' '${c.systemDir}'`));

    writeLedger({ system: false, dropin: true });
    assert.match(inHome(() => detectLegacyDropIn(c.seams))!.commands[1]!, new RegExp(`^sudo rmdir '${c.dropinDir}'   #`));
  });

  it("takes no path from the ledger: a ledger naming another file changes nothing", () => {
    const f = c.put();
    writeFileSync(ledgerFile(), JSON.stringify({ version: 1, uid: "1", file: "/etc/passwd", createdDirs: { system: false, dropin: false } }));
    assert.deepEqual(inHome(() => detectLegacyDropIn(c.seams))?.commands, [`sudo rm '${f}'`]);
  });

  it("a garbled ledger is ignored", () => {
    const f = c.put();
    writeFileSync(ledgerFile(), "{not json");
    assert.deepEqual(inHome(() => detectLegacyDropIn(c.seams))?.commands, [`sudo rm '${f}'`]);
  });

  it("under the test runner, no seam means nothing is detected (a developer machine's real drop-in stays out of the suite)", () => {
    assert.equal(detectLegacyDropIn(), null);
  });

  it("knows where each platform keeps the directory", () => {
    assert.equal(legacySystemDir("darwin"), "/Library/Application Support/ClaudeCode");
    assert.equal(legacySystemDir("linux"), "/etc/claude-code");
    assert.equal(legacySystemDir("win32"), null);
  });

  it("the message names the file, says repo-aegis will not run sudo, and shows the command", () => {
    const f = c.put();
    const text = legacyDropInLines(detectLegacyDropIn(c.seams)!).join("\n");
    assert.ok(text.includes(f));
    assert.match(text, /never runs sudo/);
    assert.ok(text.includes(`  sudo rm '${f}'`));
  });
});

describe("clearLegacyState", () => {
  it("removes the old ledger and heartbeat marker, and nothing else in state/", () => {
    writeLedger({ system: false, dropin: false });
    writeFileSync(heartbeatFile(), "");
    writeFileSync(join(c.aegisHome, "state", "audit.jsonl"), "keep\n");
    inHome(() => clearLegacyState());
    assert.equal(existsSync(ledgerFile()), false);
    assert.equal(existsSync(heartbeatFile()), false);
    assert.equal(readFileSync(join(c.aegisHome, "state", "audit.jsonl"), "utf8"), "keep\n");
  });

  it("is quiet when there is nothing to remove", () => {
    inHome(() => clearLegacyState());
  });
});

describe("doctor: MANAGED_LEGACY_PRESENT", () => {
  it("is a warning, with the remove command as the fix, and never a failure", () => {
    const f = c.put();
    const check = legacyManagedCheck(c.seams)!;
    assert.equal(check.code, "MANAGED_LEGACY_PRESENT");
    assert.equal(check.ok, false);
    assert.equal(check.severity, "warn");
    assert.ok(check.fix?.includes(`sudo rm '${f}'`));
    assert.match(check.fix ?? "", /repo-aegis install claude-md/);
  });

  it("is absent when there is no drop-in", () => {
    assert.equal(legacyManagedCheck(c.seams), null);
  });
});

describe("install claude-md --uninstall with a legacy drop-in", () => {
  const run = (extra: Record<string, unknown> = {}) =>
    inHome(() => captureOutput(() => installClaudeMd({ claudeHome: c.claudeHome, uninstall: true, legacyManaged: c.seams, ...extra })));

  it("prints the sudo command, does not touch the file, and keeps the old ledger until the file is gone", () => {
    const f = c.put("50-repo-aegis-4242.json", '{"hooks":{}}\n');
    writeLedger({ system: false, dropin: false });
    const r = run();
    assert.equal(r.exitCode, undefined, r.stderr);
    assert.ok(r.stdout.includes(`sudo rm '${f}'`), r.stdout);
    assert.match(r.stdout, /legacy root-owned managed drop-in is still installed/);
    assert.equal(readFileSync(f, "utf8"), '{"hooks":{}}\n', "repo-aegis must not remove or edit a root-owned file");
    assert.equal(existsSync(ledgerFile()), true, "the ledger is the record the person may still need");
  });

  it("with the drop-in gone, says nothing about it and clears the stale ledger and heartbeat", () => {
    writeLedger({ system: false, dropin: false });
    writeFileSync(heartbeatFile(), "");
    const r = run();
    assert.ok(!/managed drop-in|sudo/.test(r.stdout), r.stdout);
    assert.equal(existsSync(ledgerFile()), false);
    assert.equal(existsSync(heartbeatFile()), false);
  });

  it("--json carries the file and commands; the other steps still run", () => {
    const f = c.put();
    writeFileSync(join(c.claudeHome, "CLAUDE.md"), "mine\n");
    const r = run({ json: true });
    const j = JSON.parse(r.stdout) as { legacyManagedDropIn: { files: string[]; commands: string[] } | null };
    assert.deepEqual(j.legacyManagedDropIn, { files: [f], commands: [`sudo rm '${f}'`] });
    assert.ok(!("managed" in j));
  });

  it("--json says null when there is none", () => {
    const j = JSON.parse(run({ json: true }).stdout) as { legacyManagedDropIn: unknown };
    assert.equal(j.legacyManagedDropIn, null);
  });

  it("never asks for a terminal or a password: it works with no TTY", () => {
    c.put();
    const r = run({ silent: true });
    assert.equal(r.exitCode, undefined);
    assert.equal(r.stderr, "");
    assert.equal(r.stdout, "");
  });
});

describe("install claude-md (install) with a legacy drop-in", () => {
  it("writes settings.json as always, and tells the person the drop-in is still there", () => {
    const f = c.put();
    const r = inHome(() => captureOutput(() => installClaudeMd({ claudeHome: c.claudeHome, legacyManaged: c.seams })));
    assert.equal(r.exitCode, undefined, r.stderr);
    assert.ok(existsSync(join(c.claudeHome, "settings.json")));
    assert.ok(r.stdout.includes(`sudo rm '${f}'`), r.stdout);
  });

  it("accepts --user-settings as a no-op: same result with and without it", () => {
    const run = (extra: Record<string, unknown>) => {
      const home = join(tmp, `user-settings-${n++}`);
      mkdirSync(home, { recursive: true });
      inHome(() => captureOutput(() => installClaudeMd({ claudeHome: home, json: true, ...extra })));
      return readFileSync(join(home, "settings.json"), "utf8");
    };
    assert.equal(run({ userSettings: true }), run({}));
  });
});

describe("repo-aegis uninstall with a legacy drop-in", () => {
  const run = (extra: Record<string, unknown>) =>
    inHome(() => captureOutput(() => uninstall({ claudeHome: c.claudeHome, cwd: c.claudeHome, legacyManaged: c.seams, ...extra })));

  for (const [name, extra] of [["dry run", {}], ["--yes", { yes: true }]] as const) {
    it(`${name}: prints the sudo command and leaves the file alone`, () => {
      const f = c.put();
      const r = run(extra);
      assert.equal(r.exitCode, undefined, r.stderr);
      assert.ok(r.stdout.includes(`sudo rm '${f}'`), r.stdout);
      assert.equal(existsSync(f), true);
    });
  }

  it("--json reports a failing legacy step with the commands", () => {
    const f = c.put();
    const j = JSON.parse(run({ yes: true, json: true }).stdout) as { steps: Array<{ step: string; ok: boolean; details?: { commands?: string[] } }> };
    const step = j.steps.find(s => s.step.startsWith("legacy managed drop-in"));
    assert.ok(step);
    assert.equal(step.ok, false);
    assert.deepEqual(step.details?.commands, [`sudo rm '${f}'`]);
  });

  it("is silent about it when there is none", () => {
    const r = run({ yes: true });
    assert.ok(!/legacy|sudo/.test(r.stdout), r.stdout);
  });
});

describe("install claude-md --user-settings (CLI)", () => {
  const cli = (args: string[]) =>
    withEnvAsync("REPO_AEGIS_HOME", c.aegisHome, () =>
      captureOutputAsync(async () => {
        await (await buildProgram()).parseAsync(["node", "repo-aegis", "install", "claude-md", "--claude-home", c.claudeHome, "--dry-run", ...args]);
      }),
    );

  it("is accepted, works as before, and prints a one-line note on stderr", async () => {
    const r = await cli(["--user-settings"]);
    assert.equal(r.exitCode, undefined, r.stderr);
    assert.match(r.stderr, /--user-settings is now the only mode; the flag is ignored/);
    assert.equal(r.stderr.trim().split("\n").length, 1);
    assert.match(r.stdout, /Would-be settings\.json/);
  });

  it("without the flag, no note", async () => {
    const r = await cli([]);
    assert.doesNotMatch(r.stderr, /user-settings/);
  });
});
