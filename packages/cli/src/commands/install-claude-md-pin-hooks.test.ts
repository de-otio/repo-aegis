// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// The Claude Code hook commands `install claude-md` writes are pinned too
// (doc/plan-pin-enforcement-binary.md D7, T13, T14): each runs the pinned node
// and CLI by absolute path and fails closed with exit 2 when either is gone,
// instead of resolving `repo-aegis` on the agent's PATH.
//
// T19 (D8.6): every case here goes through `--user-settings`, the fallback that
// writes the user's settings.json exactly as D7 did; the default target is now the
// managed drop-in (install-claude-md-managed.test.ts), so these cases would
// otherwise stop being about this file.
//
// Subprocess cases use a temp REPO_AEGIS_HOME and a temp claude home; nothing
// reads or writes the real ones. Placeholder names only.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { isPinnedHookCommand, pinnedHookCommand, type EnforcementPin } from "@de-otio/repo-aegis-core";
import { captureOutput, lastJsonLine, withEnv } from "../_test-utils.js";
import { cliBuilt, cliPath } from "../_subprocess-utils.js";
import { installClaudeMd } from "./install-claude-md.js";

let tmp: string;
let n = 0;

before(() => {
  tmp = mkdtempSync(join(tmpdir(), "repo-aegis-pin-hooks-"));
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
  mkdirSync(join(aegisHome, "state"), { recursive: true });
  // A registry with no owners: guard-egress then judges on shape alone.
  writeFileSync(join(aegisHome, "engagements.yaml"), "schemaVersion: 2\nengagements: []\n");
  return { claudeHome, aegisHome, settingsPath: join(claudeHome, "settings.json") };
}

function install(e: Env, opts: Record<string, unknown>): { stdout: string; stderr: string; exitCode?: number } {
  return withEnv("REPO_AEGIS_HOME", e.aegisHome, () =>
    captureOutput(() => installClaudeMd({ claudeHome: e.claudeHome, userSettings: true, ...opts })),
  );
}

/** This build's real node and CLI, so subprocess cases run the real hook. */
const REAL_PIN: EnforcementPin = { node: process.execPath, cli: cliPath };

interface Hook {
  type?: string;
  command?: string;
}
interface Settings {
  hooks?: Record<string, Array<{ matcher?: string; hooks?: Hook[] }>>;
  [k: string]: unknown;
}
const readSettings = (e: Env): Settings => JSON.parse(readFileSync(e.settingsPath, "utf8")) as Settings;

/** Every hook command under every event and matcher, with where it sits. */
function allCommands(s: Settings): Array<{ event: string; matcher: string; command: string }> {
  const out: Array<{ event: string; matcher: string; command: string }> = [];
  for (const [event, entries] of Object.entries(s.hooks ?? {})) {
    for (const entry of entries) {
      for (const h of entry.hooks ?? []) out.push({ event, matcher: entry.matcher ?? "", command: h.command ?? "" });
    }
  }
  return out;
}

/** The six hook commands, per event and matcher, as install writes them for `pin`. */
function expectedCommands(pin: EnforcementPin): Array<{ event: string; matcher: string; command: string }> {
  const c = (args: string): string => pinnedHookCommand(pin, args);
  return [
    { event: "PreToolUse", matcher: "Write|Edit|MultiEdit", command: c("hook check-write") },
    { event: "PreToolUse", matcher: "Bash", command: c("hook guard-egress --agent claude") },
    { event: "PostToolUse", matcher: "Write|Edit|MultiEdit", command: c("hook scan-after-write") },
    { event: "PostToolUse", matcher: "Bash", command: c("hook scan-bash-output") },
    { event: "PostToolUse", matcher: "Bash", command: c("hook egress-receipt") },
    { event: "SessionStart", matcher: "*", command: c("hook first-touch") },
  ];
}

const sortKey = (x: { event: string; matcher: string; command: string }): string => `${x.event}|${x.matcher}|${x.command}`;
const sorted = (xs: Array<{ event: string; matcher: string; command: string }>) =>
  [...xs].sort((a, b) => sortKey(a).localeCompare(sortKey(b)));

/** The by-name commands an older install wrote. */
const BY_NAME = [
  { event: "PreToolUse", matcher: "Write|Edit|MultiEdit", command: "repo-aegis hook check-write" },
  { event: "PreToolUse", matcher: "Bash", command: "repo-aegis hook guard-egress --agent claude" },
  { event: "PostToolUse", matcher: "Write|Edit|MultiEdit", command: "repo-aegis hook scan-after-write" },
  { event: "PostToolUse", matcher: "Bash", command: "repo-aegis hook scan-bash-output" },
  { event: "PostToolUse", matcher: "Bash", command: "repo-aegis hook egress-receipt" },
  { event: "SessionStart", matcher: "*", command: "repo-aegis hook first-touch" },
];

function seed(e: Env, commands: typeof BY_NAME, extra: Settings = {}): void {
  const hooks: NonNullable<Settings["hooks"]> = {};
  for (const { event, matcher, command } of commands) {
    const entries = (hooks[event] ??= []);
    let entry = entries.find(x => x.matcher === matcher);
    if (entry === undefined) entries.push((entry = { matcher, hooks: [] }));
    entry.hooks!.push({ type: "command", command });
  }
  writeFileSync(e.settingsPath, JSON.stringify({ ...extra, hooks }));
}

describe("T13/T19: install claude-md --user-settings writes pinned hook commands", () => {
  it("every hook command is the pinned form, none is a by-name `repo-aegis hook` entry", () => {
    const e = makeEnv("pinned");
    install(e, { firstTouch: true, pin: REAL_PIN });
    const cmds = allCommands(readSettings(e));
    assert.deepEqual(sorted(cmds), sorted(expectedCommands(REAL_PIN)));
    for (const { command } of cmds) {
      assert.ok(!command.startsWith("repo-aegis hook"), command);
      assert.ok(command.includes(REAL_PIN.cli) && command.includes(REAL_PIN.node), command);
      assert.match(command, /exit 2$/, "fails closed");
    }
  });

  it("re-running adds nothing", () => {
    const e = makeEnv("rerun");
    install(e, { firstTouch: true, pin: REAL_PIN });
    const first = readFileSync(e.settingsPath, "utf8");
    install(e, { firstTouch: true, pin: REAL_PIN });
    assert.equal(readFileSync(e.settingsPath, "utf8"), first);
  });

  it("replaces an old by-name entry in place instead of adding a second one; the user's own hooks stay", () => {
    const e = makeEnv("replace");
    seed(e, BY_NAME, { model: "x" });
    // A hook of the user's own, sharing the Bash matcher entry.
    const s = readSettings(e);
    s.hooks!["PostToolUse"]!.find(x => x.matcher === "Bash")!.hooks!.push({ type: "command", command: "echo mine" });
    writeFileSync(e.settingsPath, JSON.stringify(s));

    const out = install(e, { firstTouch: true, pin: REAL_PIN });
    assert.equal(out.exitCode, undefined);
    const after = readSettings(e);
    const cmds = allCommands(after);
    assert.deepEqual(
      sorted(cmds.filter(c => c.command !== "echo mine")),
      sorted(expectedCommands(REAL_PIN)),
      "exactly one pinned command per hook, no by-name leftovers",
    );
    assert.ok(cmds.some(c => c.command === "echo mine"), "the user's own hook was kept");
    assert.equal(after["model"], "x");
    // Replaced where it stood: the egress receipt still follows the output scan.
    const bashPost = after.hooks!["PostToolUse"]!.find(x => x.matcher === "Bash")!.hooks!.map(h => h.command);
    assert.deepEqual(bashPost.slice(0, 2), [
      pinnedHookCommand(REAL_PIN, "hook scan-bash-output"),
      pinnedHookCommand(REAL_PIN, "hook egress-receipt"),
    ]);
  });

  it("replaces a command pinned to an OLDER pin (a Node upgrade), once", () => {
    const e = makeEnv("repin");
    const old: EnforcementPin = { node: "/opt/old-node/bin/node", cli: "/opt/old/dist/index.js" };
    install(e, { firstTouch: true, pin: old });
    install(e, { firstTouch: true, pin: REAL_PIN });
    assert.deepEqual(sorted(allCommands(readSettings(e))), sorted(expectedCommands(REAL_PIN)));
  });

  it("--uninstall removes the pinned form, the by-name form, or a mix, and keeps the user's hooks", () => {
    const e = makeEnv("uninstall");
    install(e, { firstTouch: true, pin: REAL_PIN });
    const s = readSettings(e);
    // Turn two of the pinned entries back into by-name ones and add a user hook.
    s.hooks!["PreToolUse"]!.find(x => x.matcher === "Bash")!.hooks![0]!.command = "repo-aegis hook guard-egress --agent claude";
    s.hooks!["SessionStart"]![0]!.hooks![0]!.command = "repo-aegis hook first-touch";
    s.hooks!["PreToolUse"]!.find(x => x.matcher === "Bash")!.hooks!.push({ type: "command", command: "echo mine" });
    writeFileSync(e.settingsPath, JSON.stringify(s));

    install(e, { uninstall: true, pin: REAL_PIN });
    assert.deepEqual(
      allCommands(readSettings(e)).map(c => c.command),
      ["echo mine"],
    );
  });

  it("--dry-run shows the pinned commands and writes nothing", () => {
    const e = makeEnv("dry");
    const out = install(e, { dryRun: true, firstTouch: true, pin: REAL_PIN });
    assert.ok(out.stdout.includes(pinnedHookCommand(REAL_PIN, "hook guard-egress --agent claude")), out.stdout);
    assert.equal(existsSync(e.settingsPath), false);
  });

  it("--json reports the pinned command for each hook", () => {
    const e = makeEnv("json");
    const out = install(e, { json: true, firstTouch: true, pin: REAL_PIN });
    const j = JSON.parse(out.stdout) as {
      hookCommand: string;
      guardEgressHook: { hookCommand: string };
      firstTouch: { hookCommand: string };
    };
    assert.equal(j.hookCommand, pinnedHookCommand(REAL_PIN, "hook scan-after-write"));
    assert.equal(j.guardEgressHook.hookCommand, pinnedHookCommand(REAL_PIN, "hook guard-egress --agent claude"));
    assert.equal(j.firstTouch.hookCommand, pinnedHookCommand(REAL_PIN, "hook first-touch"));
  });

  it("refuses a pin path with a newline (PIN_PATH_UNSUPPORTED) and writes nothing", () => {
    const e = makeEnv("newline");
    const out = install(e, { json: true, pin: { node: REAL_PIN.node, cli: "/opt/a\nb/index.js" } });
    assert.equal(out.exitCode, 2);
    assert.equal(lastJsonLine<{ code: string }>(out.stderr).code, "PIN_PATH_UNSUPPORTED");
    assert.equal(existsSync(e.settingsPath), false);
  });
});

const subprocess = { skip: cliBuilt() ? undefined : `built CLI not found at ${cliPath}` };

/** The POSIX shell the hook commands must work in (D8.8): dash where it is installed (Debian and Ubuntu's `sh`), else this platform's `/bin/sh`. */
const POSIX_SH = ["/bin/dash", "/usr/bin/dash"].find(p => existsSync(p)) ?? "/bin/sh";

/** Runs a settings.json hook `command` the way Claude Code does: through `sh -c`, tool call on stdin. */
function runHookCommand(command: string, input: string, env: NodeJS.ProcessEnv): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(POSIX_SH, ["-c", command], { input, env, encoding: "utf8" });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

const GUARD_ARGS = "hook guard-egress --agent claude";
/** A PATH with no `repo-aegis` on it, so a pin-gone case cannot fall back to a developer's own install. */
const NO_REPO_AEGIS_PATH = "/usr/bin:/bin";
const bashCall = (command: string): string =>
  JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } });

describe("T14: the rendered guard-egress hook command", subprocess, () => {
  function hookEnv(e: Env, path = process.env["PATH"] ?? ""): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env, REPO_AEGIS_HOME: e.aegisHome, PATH: path };
    delete env["REPO_AEGIS_EGRESS_HUMAN"];
    delete env["REPO_AEGIS_ASSUME_PUBLIC"];
    return env;
  }

  it("pinned CLI deleted: exit 2 (not 127), the missing path and the fix on stderr", () => {
    const e = makeEnv("t14-missing-cli");
    const gone = join(tmp, "t14-gone", "dist", "index.js");
    const r = runHookCommand(
      pinnedHookCommand({ node: process.execPath, cli: gone }, GUARD_ARGS),
      bashCall("ls"),
      hookEnv(e, NO_REPO_AEGIS_PATH),
    );
    assert.equal(r.status, 2, `stdout=${r.stdout} stderr=${r.stderr}`);
    assert.ok(r.stderr.includes(gone), r.stderr);
    assert.ok(r.stderr.includes("repo-aegis install claude-md"), r.stderr);
  });

  it("pinned node deleted: exit 2 with the path and the fix", () => {
    const e = makeEnv("t14-missing-node");
    const gone = join(tmp, "t14-gone-node", "node");
    const r = runHookCommand(pinnedHookCommand({ node: gone, cli: cliPath }, GUARD_ARGS), bashCall("ls"), hookEnv(e, NO_REPO_AEGIS_PATH));
    assert.equal(r.status, 2, r.stderr);
    assert.ok(r.stderr.includes(gone), r.stderr);
    assert.ok(r.stderr.includes("repo-aegis install claude-md"), r.stderr);
  });

  it("the command `install claude-md` actually wrote: impostor first on PATH loses; a deleted pinned CLI exits 2", () => {
    const e = makeEnv("t14-installed");
    const dir = join(tmp, `t14-inst-${n++}`);
    mkdirSync(join(dir, "dist"), { recursive: true });
    const cliCopy = join(dir, "dist", "index.js");
    writeFileSync(cliCopy, readFileSync(cliPath));
    // The second install below pins this copy so it can be deleted; the first pins the real entry.
    install(e, { pin: REAL_PIN });
    const guard = allCommands(readSettings(e)).find(c => c.event === "PreToolUse" && c.matcher === "Bash")!.command;

    const bin = join(dir, "bin");
    mkdirSync(bin, { recursive: true });
    const log = join(dir, "impostor.log");
    writeFileSync(join(bin, "repo-aegis"), `#!/bin/sh\necho x >> "${log}"\nexit 0\n`, { mode: 0o755 });
    chmodSync(join(bin, "repo-aegis"), 0o755);
    const env = hookEnv(e, [bin, process.env["PATH"] ?? ""].join(delimiter));
    const denied = runHookCommand(guard, bashCall("git push"), env);
    assert.equal(denied.status, 2, `the installed command did not run the pinned guard: ${denied.stdout}${denied.stderr}`);
    assert.match(denied.stderr, /PUSH_IMPLICIT_TARGET/);
    assert.equal(existsSync(log), false, "an impostor from PATH ran");

    // The same install, pinned to a CLI that is then deleted.
    const e2 = makeEnv("t14-installed-gone");
    install(e2, { pin: { node: process.execPath, cli: cliCopy } });
    rmSync(cliCopy);
    const guard2 = allCommands(readSettings(e2)).find(c => c.event === "PreToolUse" && c.matcher === "Bash")!.command;
    const gone = runHookCommand(guard2, bashCall("ls"), env);
    assert.equal(gone.status, 2, `${gone.stdout}${gone.stderr}`);
    assert.ok(gone.stderr.includes(cliCopy) && gone.stderr.includes("repo-aegis install claude-md"), gone.stderr);
  });

  it("a pin path with spaces and quotes still runs the CLI", () => {
    const e = makeEnv("t14-quoting");
    const dir = join(tmp, `t14-odd-${n++}`, `it's "odd"`);
    mkdirSync(dir, { recursive: true });
    const cli = join(dir, "stub cli.cjs");
    writeFileSync(cli, `process.stdout.write("ran:" + process.argv.slice(2).join(" "));\n`);
    const r = runHookCommand(pinnedHookCommand({ node: process.execPath, cli }, GUARD_ARGS), bashCall("ls"), hookEnv(e));
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, "ran:hook guard-egress --agent claude");
  });

  it("an impostor `repo-aegis` (and `node`) first on PATH does not run; the pinned CLI still decides", () => {
    const e = makeEnv("t14-impostor");
    const bin = join(tmp, `t14-bin-${n++}`);
    const log = join(tmp, `t14-impostor-${n++}.log`);
    mkdirSync(bin, { recursive: true });
    for (const name of ["repo-aegis", "node"]) {
      writeFileSync(join(bin, name), `#!/bin/sh\necho ${name} >> "${log}"\nexit 0\n`, { mode: 0o755 });
      chmodSync(join(bin, name), 0o755);
    }
    const env = hookEnv(e, [bin, process.env["PATH"] ?? ""].join(delimiter));
    const command = pinnedHookCommand(REAL_PIN, GUARD_ARGS);

    // The real guard refuses a bare `git push` (PUSH_IMPLICIT_TARGET): exit 2.
    const denied = runHookCommand(command, bashCall("git push"), env);
    assert.equal(denied.status, 2, `the pinned guard did not decide: ${denied.stdout}${denied.stderr}`);
    assert.match(denied.stderr, /PUSH_IMPLICIT_TARGET/);
    // And a command with no egress passes silently, so the refusal above is the verdict, not breakage.
    const allowed = runHookCommand(command, bashCall("ls -la"), env);
    assert.equal(allowed.status, 0, allowed.stderr);
    assert.equal(existsSync(log), false, "an impostor from PATH ran");
  });

  it("the by-name form is what an impostor wins (control: why the pin exists)", () => {
    const e = makeEnv("t14-control");
    const bin = join(tmp, `t14-ctl-bin-${n++}`);
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "repo-aegis"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    chmodSync(join(bin, "repo-aegis"), 0o755);
    const env = hookEnv(e, [bin, process.env["PATH"] ?? ""].join(delimiter));
    const r = runHookCommand(`repo-aegis ${GUARD_ARGS}`, bashCall("git push"), env);
    assert.equal(r.status, 0, "the impostor allowed it");
  });
});

describe("the pinned hook command: pin gone, PATH fallback (P1-D)", subprocess, () => {
  /** Runs `command` through sh -c with a PATH holding a stub `repo-aegis` (or none), and reports what the stub saw. */
  function runWithStub(
    label: string,
    command: string,
    stubVersion: string | null,
    stdin = bashCall("ls"),
    versionExit = 0,
  ): { status: number | null; stderr: string; argv: string[]; stdinSeen: string; stubCalled: boolean } {
    const dir = join(tmp, `fb-${label}-${n++}`);
    const bin = join(dir, "bin");
    mkdirSync(bin, { recursive: true });
    const argvLog = join(dir, "argv.log");
    const stdinLog = join(dir, "stdin.log");
    const called = join(dir, "called");
    if (stubVersion !== null) {
      writeFileSync(
        join(bin, "repo-aegis"),
        `#!/bin/sh\n: > "$STUB_CALLED"\nif [ "$1" = "--version" ]; then printf '%s\\n' "$VER"; exit "$VER_EXIT"; fi\necho "$*" >> "$ARGV_LOG"\ncat >> "$STDIN_LOG"\nexit 0\n`,
        { mode: 0o755 },
      );
      chmodSync(join(bin, "repo-aegis"), 0o755);
    }
    const r = runHookCommand(command, stdin, {
      PATH: `${bin}:${NO_REPO_AEGIS_PATH}`,
      HOME: dir,
      ARGV_LOG: argvLog,
      STDIN_LOG: stdinLog,
      STUB_CALLED: called,
      VER: stubVersion ?? "",
      VER_EXIT: String(versionExit),
    });
    const read = (p: string): string => (existsSync(p) ? readFileSync(p, "utf8") : "");
    return {
      status: r.status,
      stderr: r.stderr,
      argv: read(argvLog).split("\n").filter(l => l !== ""),
      stdinSeen: read(stdinLog),
      stubCalled: existsSync(called),
    };
  }

  const goneCli = (label: string): string => join(tmp, `fb-gone-${label}`, "dist", "index.js");
  const pinned = (label: string, version: string | undefined): string =>
    pinnedHookCommand({ node: process.execPath, cli: goneCli(label), ...(version !== undefined && { version }) }, GUARD_ARGS);

  for (const have of ["0.14.0", "0.14.1", "1.0.0"]) {
    it(`a PATH repo-aegis ${have} (not older than the pinned 0.14.0) runs the hook with the payload on stdin, after a WARNING`, () => {
      const payload = bashCall("ls");
      const r = runWithStub(`ok-${have}`, pinned(`ok-${have}`, "0.14.0"), have, payload);
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(r.argv, [GUARD_ARGS]);
      assert.equal(r.stdinSeen, payload, "the tool call reached the fallback unread by --version");
      assert.match(r.stderr, /^repo-aegis: WARNING: the pinned enforcement binary is missing or not usable \(.*index\.js\); running .*\/bin\/repo-aegis /m);
      assert.ok(r.stderr.includes(`(${have}, pinned 0.14.0) instead. Re-pin it by running: repo-aegis install claude-md`), r.stderr);
    });
  }

  for (const have of ["0.13.9", "0.9.0"]) {
    it(`an older PATH repo-aegis ${have} is refused with exit 2, naming both versions; the stub never got the hook`, () => {
      const r = runWithStub(`older-${have}`, pinned(`older-${have}`, "0.14.0"), have);
      assert.equal(r.status, 2, r.stderr);
      assert.ok(r.stderr.includes(`is ${have}, older than the pinned 0.14.0`), r.stderr);
      assert.ok(r.stderr.includes("Install 0.14.0 or later, then run: repo-aegis install claude-md"), r.stderr);
      assert.ok(r.stderr.startsWith("repo-aegis: hook blocked: "), r.stderr);
      assert.deepEqual(r.argv, []);
    });
  }

  it("no repo-aegis on PATH is refused with exit 2 (not 127) and says so", () => {
    const r = runWithStub("none", pinned("none", "0.14.0"), null);
    assert.equal(r.status, 2, r.stderr);
    assert.ok(r.stderr.includes("no repo-aegis is on PATH"), r.stderr);
    assert.ok(r.stderr.includes("Re-pin it by running: repo-aegis install claude-md"), r.stderr);
  });

  for (const [i, version] of ["0.14.0-rc.1", "v0.14.0", "0.14", "", "1234567890.0.0", "9.9.9-secret-token"].entries()) {
    it(`a PATH repo-aegis printing ${JSON.stringify(version)} is refused with exit 2 and never echoed`, () => {
      const r = runWithStub(`unparsable-${i}`, pinned(`unparsable-${i}`, "0.14.0"), version);
      assert.equal(r.status, 2, r.stderr);
      assert.ok(r.stderr.includes("did not report a plain MAJOR.MINOR.PATCH version (pinned 0.14.0)"), r.stderr);
      assert.ok(!r.stderr.includes("secret-token"), r.stderr);
      assert.deepEqual(r.argv, []);
    });
  }

  it("a PATH repo-aegis that prints a valid, new-enough version but exits non-zero from --version is refused (sh and dash alike)", () => {
    const r = runWithStub("version-exit", pinned("version-exit", "0.14.0"), "9.9.9", bashCall("ls"), 1);
    assert.equal(r.status, 2, r.stderr);
    assert.ok(r.stderr.includes("did not report a plain MAJOR.MINOR.PATCH version (pinned 0.14.0)"), r.stderr);
    assert.deepEqual(r.argv, []);
  });

  it("the fallback exports REPO_AEGIS_PIN_FALLBACK=1 to the repo-aegis it runs (so the hook can tell the person)", () => {
    const dir = join(tmp, `fb-env-${n++}`);
    mkdirSync(join(dir, "bin"), { recursive: true });
    const out = join(dir, "env.out");
    writeFileSync(join(dir, "bin", "repo-aegis"), `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 0.14.0; exit 0; fi\necho "fb=$REPO_AEGIS_PIN_FALLBACK" >> "${out}"\nexit 0\n`, { mode: 0o755 });
    chmodSync(join(dir, "bin", "repo-aegis"), 0o755);
    const env = { PATH: `${join(dir, "bin")}:${NO_REPO_AEGIS_PATH}`, HOME: dir };
    const r = runHookCommand(pinned("env", "0.14.0"), bashCall("ls"), env);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readFileSync(out, "utf8"), "fb=1\n");
  });

  it("a pin installed without a recorded version never falls back, however new the PATH repo-aegis is", () => {
    const r = runWithStub("noversion", pinned("noversion", undefined), "99.0.0");
    assert.equal(r.status, 2, r.stderr);
    assert.ok(r.stderr.includes("installed without a recorded version"), r.stderr);
    assert.deepEqual(r.argv, []);
    assert.equal(r.stubCalled, false, "PATH is not even asked");
  });

  it("a valid pin never looks at PATH: the stub is not called, not even with --version", () => {
    const dir = join(tmp, `fb-valid-${n++}`);
    mkdirSync(dir, { recursive: true });
    const cli = join(dir, "stub-cli.cjs");
    writeFileSync(cli, `process.stdout.write("ran:" + process.argv.slice(2).join(" "));\n`);
    const r = runWithStub("valid", pinnedHookCommand({ node: process.execPath, cli, version: "0.14.0" }, GUARD_ARGS), "99.0.0");
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stubCalled, false);
    assert.ok(!r.stderr.includes("WARNING"), r.stderr);
  });

  it("the command still reads as a pinned hook command to `doctor` and `install` (starts `if [ -f `, ends `; exit 2`)", () => {
    const c = pinned("shape", "0.14.0");
    assert.ok(c.startsWith("if [ -f "));
    assert.ok(c.endsWith("; exit 2"));
    assert.ok(isPinnedHookCommand(c, "guard-egress"));
    assert.ok(c.indexOf("__ra_version='0.14.0'") > c.indexOf("; fi; "), "the version sits after the pinned exec");
  });
});
