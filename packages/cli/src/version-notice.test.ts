// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// The once-per-version notice (P1-H): printed once per version on stderr, from interactive commands and git
// hooks only, never inside a protocol (the Claude Code hook JSON, the git credential helper).
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cliBuilt, cliPath } from "./_subprocess-utils.js";
import { buildProgram } from "./program.js";
import { isNewer,lastVersionPath, noticeApplies, noticeLine, readLastVersion, recordVersion, versionNotice } from "./version-notice.js";

let tmp: string;
let n = 0;
before(() => {
  tmp = mkdtempSync(join(tmpdir(), "repo-aegis-version-notice-"));
});
after(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const freshHome = (): string => {
  const home = join(tmp, `home-${n++}`);
  mkdirSync(home, { recursive: true });
  return home;
};

function notices(home: string, version: string): string[] {
  const lines: string[] = [];
  versionNotice({ home, version, write: t => void lines.push(t) });
  return lines;
}

describe("versionNotice", () => {
  it("prints once per version: the first run of a version, not the second", () => {
    const home = freshHome();
    assert.deepEqual(notices(home, "0.14.0"), [`${noticeLine("0.14.0")}\n`]);
    assert.deepEqual(notices(home, "0.14.0"), []);
    assert.deepEqual(notices(home, "0.14.0"), []);
    // The next release is news again, once.
    assert.deepEqual(notices(home, "0.14.1"), [`${noticeLine("0.14.1")}\n`]);
    assert.deepEqual(notices(home, "0.14.1"), []);
  });

  it("says exactly `repo-aegis <ver> is new here: run `repo-aegis upgrade``", () => {
    assert.equal(noticeLine("0.14.0"), "repo-aegis 0.14.0 is new here: run `repo-aegis upgrade`");
  });

  it("records the version in <home>/state/last-version, mode 0600", () => {
    const home = freshHome();
    notices(home, "0.14.0");
    assert.equal(lastVersionPath(home), join(home, "state", "last-version"));
    assert.equal(readLastVersion(home), "0.14.0");
    assert.equal(statSync(lastVersionPath(home)).mode & 0o777, 0o600);
  });

  it("an install from before the file existed (no record) is told once", () => {
    const home = freshHome();
    assert.equal(readLastVersion(home), null);
    assert.equal(notices(home, "0.14.0").length, 1);
  });

  it("a lower version run against a higher record prints nothing and leaves the record at the highest", () => {
    const home = freshHome();
    recordVersion(home, "0.15.0");
    assert.deepEqual(notices(home, "0.14.0"), []);
    assert.equal(readLastVersion(home), "0.15.0", "the downgrade does not overwrite the record");
    assert.deepEqual(notices(home, "0.15.0"), [], "so the higher version is not announced again");
    assert.equal(notices(home, "0.16.0").length, 1, "a genuinely newer release still is");
  });

  it("two installs sharing one home, run in turn: one line in total, not one per switch", () => {
    const home = freshHome();
    const lines: string[] = [];
    for (const v of ["0.14.0", "0.13.2", "0.14.0", "0.13.2", "0.14.0", "0.13.2"]) lines.push(...notices(home, v));
    assert.deepEqual(lines, [`${noticeLine("0.14.0")}\n`], "the first run of the higher one, then silence from both");
    assert.equal(readLastVersion(home), "0.14.0");
  });

  it("recordVersion keeps the highest too (upgrade and init record through it)", () => {
    const home = freshHome();
    assert.equal(recordVersion(home, "0.14.0"), true);
    assert.equal(recordVersion(home, "0.13.2"), true, "nothing to write counts as recorded");
    assert.equal(readLastVersion(home), "0.14.0");
    assert.equal(recordVersion(home, "0.14.1"), true);
    assert.equal(readLastVersion(home), "0.14.1");
  });

  it("a machine with no <home> gets no notice and no directory (nothing was installed there to go stale)", () => {
    const home = join(tmp, `never-created-${n++}`);
    assert.deepEqual(notices(home, "0.14.0"), []);
    assert.equal(recordVersion(home, "0.14.0"), false);
    assert.equal(existsSync(home), false);
  });

  it("when the record cannot be written nothing is printed (it could not stay 'once')", () => {
    const home = freshHome();
    writeFileSync(join(home, "state"), "a file where the state directory should be");
    assert.deepEqual(notices(home, "0.14.0"), []);
    assert.deepEqual(notices(home, "0.14.0"), []);
  });

  it("a prerelease is below its release and prereleases compare numerically (semver precedence)", () => {
    assert.equal(isNewer("0.14.0-rc.1", "0.14.0"), false, "a prerelease is not news after its release");
    assert.equal(isNewer("0.14.0", "0.14.0-rc.1"), true);
    assert.equal(isNewer("0.14.0-rc.10", "0.14.0-rc.2"), true, "numeric, not lexical");
    assert.equal(isNewer("0.14.0-rc.2", "0.14.0-rc.10"), false);
    assert.equal(isNewer("0.14.0-rc.1", "0.14.0-rc.1"), false);
    assert.equal(isNewer("0.14.0-rc.1", "0.13.9"), true);
    assert.equal(isNewer("0.14.0-beta", "0.14.0-alpha"), true);
    assert.equal(isNewer("0.14.0-rc.1.1", "0.14.0-rc.1"), true, "a longer list above the list it prefixes");
    assert.equal(isNewer("0.14.0+build.5", "0.14.0"), false, "build metadata is ignored");
  });

  it("a release and its prerelease sharing one home: one line in total, not one per switch", () => {
    const home = freshHome();
    const lines: string[] = [];
    for (const v of ["0.14.0", "0.14.0-rc.1", "0.14.0", "0.14.0-rc.1"]) lines.push(...notices(home, v));
    assert.deepEqual(lines, [`${noticeLine("0.14.0")}\n`]);
    assert.equal(readLastVersion(home), "0.14.0");
  });

  it("a version that is not semver at all counts as news whenever it differs", () => {
    assert.equal(isNewer("dev-build", "0.14.0"), true);
    assert.equal(isNewer("0.14.0", "dev-build"), true);
    assert.equal(isNewer("0.14.0", "0.14.0"), false);
    assert.equal(isNewer("0.14.1", "0.14.0"), true);
    assert.equal(isNewer("0.9.0", "0.10.0"), false, "numeric, not lexical");
    assert.equal(isNewer("1.0.0", "0.99.99"), true);
  });
});

describe("noticeApplies: where it is never printed", () => {
  const none: NodeJS.ProcessEnv = {};
  it("interactive commands, including nested ones, get it", () => {
    for (const path of [["status"], ["doctor"], ["check"], ["install", "hooks"], ["context", "status"], ["engagements", "list"]]) {
      assert.equal(noticeApplies(path, none), true, path.join(" "));
    }
  });
  it("Claude Code hook commands, the credential helper, the gh entry points, explain and upgrade/init/uninstall do not", () => {
    for (const path of [
      ["hook", "guard-egress"],
      ["hook", "check-write"],
      ["hook", "scan-after-write"],
      ["hook", "prompt-submit"],
      ["git-credential"],
      ["gh"],
      ["egress-check"],
      ["egress-readback"],
      ["upgrade"],
      ["init"],
      ["uninstall"],
      ["explain"],
      [],
    ]) {
      assert.equal(noticeApplies(path, none), false, path.join(" "));
    }
  });
  it("every top-level command is classified on purpose: a new command must be added here as notice or quiet", async () => {
    // Commands a person runs at a terminal: they print the notice. Everything else must be in QUIET_COMMANDS (checked
    // through noticeApplies), so a command that is a protocol or machine reader cannot pick the notice up by default.
    const WITH_NOTICE = new Set([
      "allow", "approve", "audit", "audit-log", "check", "classify", "context", "deny", "doctor", "engagements", "identity", "install", "log", "markers", "pause", "registry", "render", "resume", "scan-env", "status", "suggest-markers", "upstreams", "waive",
    ]);
    const top = (await buildProgram()).commands.map(c => c.name());
    const unclassified = top.filter(name => !WITH_NOTICE.has(name) && noticeApplies([name], none));
    assert.deepEqual(unclassified, [], `classify these as notice or quiet in version-notice.ts and here: ${unclassified.join(", ")}`);
    const wrong = [...WITH_NOTICE].filter(name => top.includes(name) && !noticeApplies([name], none));
    assert.deepEqual(wrong, [], "listed as notice here but quiet in version-notice.ts");
  });
  it("--json (global or command level) does not: a machine reads that output and drops stderr", () => {
    assert.equal(noticeApplies(["status"], none, true), false);
    assert.equal(noticeApplies(["check"], none, true), false);
    assert.equal(noticeApplies(["status"], none, false), true);
  });
  it("a CI run does not (a fresh home on every job would print it every time)", () => {
    assert.equal(noticeApplies(["check"], { CI: "true" }), false);
    assert.equal(noticeApplies(["check"], { CI: "1" }), false);
    assert.equal(noticeApplies(["check"], { CI: "false" }), true);
    assert.equal(noticeApplies(["check"], { CI: "" }), true);
  });
});

// The wiring: the real entry point, a fresh home each time.
describe("the notice at the CLI entry point", { skip: !cliBuilt() }, () => {
  function cli(home: string, args: string[], input?: string): { stdout: string; stderr: string; code: number | null } {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      REPO_AEGIS_HOME: home,
      // A throwaway HOME: `upgrade` reads Claude Code's settings and git's configuration from the user's home.
      HOME: join(tmp, "user-home"),
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    };
    delete env["CI"];
    const r = spawnSync(process.execPath, [cliPath, ...args], { env, encoding: "utf8", cwd: tmp, ...(input !== undefined && { input }) });
    return { stdout: r.stdout, stderr: r.stderr, code: r.status };
  }
  const NOTICE = /repo-aegis \S+ is new here: run `repo-aegis upgrade`/g;
  const count = (text: string): number => (text.match(NOTICE) ?? []).length;

  it("an interactive command prints it once on stderr (never stdout), then not again", () => {
    const home = freshHome();
    const first = cli(home, ["context", "status"]);
    assert.equal(count(first.stderr), 1, first.stderr);
    assert.equal(count(first.stdout), 0, "stdout stays the command's own");
    const second = cli(home, ["context", "status"]);
    assert.equal(count(second.stderr), 0);
    assert.ok(readLastVersion(home) !== null);
  });

  it("--json commands neither print the notice nor use it up: the next interactive command still gets it (M2)", () => {
    const home = freshHome();
    const file = join(tmp, "scanned.txt");
    writeFileSync(file, "nothing here\n");
    // The VS Code extension runs exactly these two and discards stderr.
    for (const args of [["status", "--json"], ["--json", "status"], ["check", "--path", file, "--json"]]) {
      const r = cli(home, args);
      assert.equal(count(r.stderr), 0, `${args.join(" ")}: ${r.stderr}`);
      assert.equal(count(r.stdout), 0, `${args.join(" ")}: ${r.stdout}`);
      assert.equal(existsSync(lastVersionPath(home)), false, `${args.join(" ")} did not record the version`);
    }
    assert.equal(count(cli(home, ["context", "status"]).stderr), 1, "a person's command after the machine's still gets the line");
  });

  it("the Claude Code hook commands print nothing extra and record nothing, whatever they emit", () => {
    const home = freshHome();
    const payloads: Array<[string[], string]> = [
      [["hook", "guard-egress"], JSON.stringify({ tool_name: "Bash", tool_input: { command: "ls" } })],
      [["hook", "check-write"], JSON.stringify({ tool_name: "Write", tool_input: { file_path: "/tmp/x", content: "x" } })],
      [["hook", "scan-after-write"], JSON.stringify({ tool_name: "Write", tool_input: { file_path: "/tmp/x" } })],
      [["hook", "prompt-submit"], "{}"],
      [["hook", "egress-receipt"], JSON.stringify({ tool_name: "Bash", tool_input: { command: "ls" } })],
    ];
    for (const [args, input] of payloads) {
      const r = cli(home, args, input);
      assert.equal(count(r.stderr), 0, `${args.join(" ")}: ${r.stderr}`);
      assert.equal(count(r.stdout), 0, `${args.join(" ")}: ${r.stdout}`);
      const out = r.stdout.trim();
      if (out !== "") assert.doesNotThrow(() => JSON.parse(out), `${args.join(" ")} stdout is still clean JSON: ${out}`);
    }
    assert.equal(existsSync(lastVersionPath(home)), false, "a hook run does not use up the notice");
    // ...so the person's next interactive command still gets it.
    assert.equal(count(cli(home, ["context", "status"]).stderr), 1);
  });

  it("git-credential's stdout is the protocol alone and its stderr carries no notice", () => {
    const home = freshHome();
    for (const input of ["", "protocol=https\nhost=github.com\npath=example-org/example-repo\n\n", "protocol=https\nhost=example.com\n\n"]) {
      const r = cli(home, ["git-credential", "get"], input);
      assert.equal(count(r.stderr), 0, r.stderr);
      assert.equal(count(r.stdout), 0, r.stdout);
      for (const line of r.stdout.split("\n")) {
        assert.match(line, /^(?:[a-z]+=.*)?$/, `a credential protocol line, not prose: ${line}`);
      }
    }
    assert.equal(existsSync(lastVersionPath(home)), false);
  });

  it("`upgrade` uses the notice up: after it, no command prints one; a --dry-run does not", () => {
    const dryHome = freshHome();
    const dry = cli(dryHome, ["upgrade", "--dry-run", "--json"]);
    assert.equal(dry.code, 0, dry.stderr);
    assert.equal(count(dry.stderr), 0, "upgrade itself never prints the notice");
    assert.equal(existsSync(lastVersionPath(dryHome)), false, "--dry-run records nothing");
    assert.equal(count(cli(dryHome, ["context", "status"]).stderr), 1, "so the notice is still due");

    const home = freshHome();
    const real = cli(home, ["upgrade", "--json"]);
    assert.equal(real.code, 0, real.stderr);
    assert.equal(count(real.stderr), 0);
    const report = JSON.parse(real.stdout) as { action: string; nothingToUpgrade: boolean; next: string };
    assert.deepEqual([report.action, report.nothingToUpgrade, report.next], ["upgrade", true, "repo-aegis doctor"]);
    assert.equal(readLastVersion(home), JSON.parse(readFileSync(join(cliPath, "..", "..", "package.json"), "utf8")).version);
    assert.equal(count(cli(home, ["context", "status"]).stderr), 0);
  });

  it("`init` writes this version's installs, so it prints nothing and the next command is quiet", () => {
    const home = join(freshHome(), "fresh");
    const init = cli(home, ["init", "--no-with-hooks", "--no-with-claude"]);
    assert.equal(init.code, 0, init.stderr);
    assert.equal(count(init.stderr), 0);
    assert.ok(readLastVersion(home) !== null, "init records the version");
    assert.equal(count(cli(home, ["context", "status"]).stderr), 0);
  });

  it("`explain` stays read-only: it creates no home and no state", () => {
    const home = join(freshHome(), "never-created");
    const r = cli(home, ["explain", "--list"]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(count(r.stderr), 0);
    assert.equal(existsSync(home), false);
  });

  it("a CI run prints nothing and records nothing", () => {
    const home = freshHome();
    const env = { ...process.env, REPO_AEGIS_HOME: home, CI: "true" };
    const r = spawnSync(process.execPath, [cliPath, "context", "status"], { env, encoding: "utf8", cwd: tmp });
    assert.equal(count(r.stderr), 0);
    assert.equal(existsSync(lastVersionPath(home)), false);
  });
});
