// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// P1-F: an agent can always read `--help`. Asking a person-only verb for help changes nothing, so
// `repo-aegis hook guard-egress` lets a call whose ONLY arguments are `--help` / `-h` (or `repo-aegis help <verb>`)
// through; any other argument next to it keeps the AGENT_RAN_HUMAN_COMMAND refusal. The honest mistake this covers
// is an agent that guesses a command's flags, or tells its person something wrong, because it could not read the help.
// Placeholders only.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Command } from "commander";
import { findHumanOnlyCommand, HUMAN_VERB_PATHS, type HumanOnlyKind } from "@de-otio/repo-aegis-core";
import { cliBuilt, cliPath } from "../_subprocess-utils.js";
import { scrubGitEnv } from "../_test-utils.js";
import { buildProgram } from "../program.js";

let restoreGitEnv: () => void;
let tmp: string;
let home: string;
before(() => {
  restoreGitEnv = scrubGitEnv();
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "repo-aegis-guard-help-test-")));
  home = join(tmp, "aegis");
  mkdirSync(join(home, "markers"), { recursive: true });
});
after(() => {
  restoreGitEnv();
  rmSync(tmp, { recursive: true, force: true });
});

interface GuardResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

function runGuard(command: string): GuardResult {
  const env: NodeJS.ProcessEnv = { ...process.env, REPO_AEGIS_HOME: home, REPO_AEGIS_VISIBILITY_LOOKUP: "0" };
  delete env["REPO_AEGIS_EGRESS_HUMAN"];
  delete env["REPO_AEGIS_ASSUME_PUBLIC"];
  const r = spawnSync(process.execPath, [cliPath, "hook", "guard-egress"], {
    cwd: tmp,
    env,
    encoding: "utf8",
    input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, cwd: tmp }),
  });
  return { stdout: r.stdout, stderr: r.stderr, code: r.status };
}

function assertAllowed(command: string): void {
  const r = runGuard(command);
  assert.equal(r.code, 0, `${command}\n${r.stderr}`);
  assert.equal(r.stdout, "", command);
}

function assertRefusedAsHumanCommand(command: string): void {
  const r = runGuard(command);
  assert.equal(r.code, 2, `${command}\n${r.stdout}`);
  assert.equal((JSON.parse(r.stderr) as { code: string }).code, "AGENT_RAN_HUMAN_COMMAND", command);
}

/**
 * One command per person-only kind that the guard refuses WITHOUT `--help`. Typed over every kind, so a new kind
 * cannot be added without a sample here (a compile error in this file), and the table below then covers it.
 */
const REFUSED_SAMPLE: Readonly<Record<HumanOnlyKind, string>> = {
  approve: "repo-aegis approve acme/svc --ttl 1h",
  "owner-add": "repo-aegis engagements add --personal-org stranger",
  "upstream-add": "repo-aegis upstreams add upstream-org/lib",
  "init-migrate": "repo-aegis init --migrate-classify",
  "init-force": "repo-aegis init --force",
  "identity-change": "repo-aegis identity add me --gh-login alice",
  "claude-md-uninstall": "repo-aegis install claude-md --uninstall",
  "internal-entry": "repo-aegis gh -- pr view 1",
  "managed-settings-write": "sudo rm '/Library/Application Support/ClaudeCode/managed-settings.d/50-repo-aegis-501.json'",
};

describe("hook guard-egress: --help on a person-only verb is allowed", { skip: !cliBuilt() }, () => {
  // A table over HUMAN_VERB_PATHS (every verb the human-commands list knows), so a new verb is covered by default.
  for (const [kind, paths] of Object.entries(HUMAN_VERB_PATHS) as Array<[HumanOnlyKind, ReadonlyArray<readonly string[]>]>) {
    for (const path of paths) {
      const verb = path.join(" ");
      it(`${kind}: repo-aegis ${verb} --help, -h and help ${verb}`, () => {
        assertAllowed(`repo-aegis ${verb} --help`);
        assertAllowed(`repo-aegis ${verb} -h`);
        assertAllowed(`repo-aegis help ${verb}`);
      });
    }
  }

  it("the table covers every kind that has a refusal sample", () => {
    assert.deepEqual(Object.keys(HUMAN_VERB_PATHS).sort(), Object.keys(REFUSED_SAMPLE).sort());
  });

  it("every kind's sample is refused, and stays refused with --help or -h added to it", () => {
    for (const [kind, sample] of Object.entries(REFUSED_SAMPLE)) {
      const code = kind === "managed-settings-write" ? null : "AGENT_RAN_HUMAN_COMMAND";
      for (const command of [sample, `${sample} --help`, `${sample} -h`]) {
        const r = runGuard(command);
        assert.equal(r.code, 2, `${kind}: ${command}\n${r.stdout}`);
        if (code !== null) assert.equal((JSON.parse(r.stderr) as { code: string }).code, code, command);
      }
    }
  });

  it("the program word may be spelled any way the refusal reads it", () => {
    for (const command of [
      "node packages/cli/dist/index.js approve --help",
      "npx -y @de-otio/repo-aegis approve --help",
      "/opt/homebrew/bin/repo-aegis approve --help",
      "sudo -u someone repo-aegis approve --help",
      "env FOO=1 repo-aegis approve --help",
      "bash -c 'repo-aegis approve --help'",
      "alias ra=repo-aegis; ra approve --help",
      "repo-aegis approve --help 2>&1",
      "repo-aegis approve --help | cat",
      "cd /x && repo-aegis identity add --help",
      "$(which repo-aegis) approve --help",
    ]) {
      assertAllowed(command);
    }
  });

  it("the three shapes with another argument are still refused", () => {
    assertRefusedAsHumanCommand("repo-aegis approve acme/svc --help");
    assertRefusedAsHumanCommand("repo-aegis approve --help acme/svc");
    assertRefusedAsHumanCommand("repo-aegis approve --help && repo-aegis approve acme/svc");
  });

  it("any other argument, flag, segment or form next to --help is refused", () => {
    for (const command of [
      "repo-aegis approve '*' -h",
      "repo-aegis approve --ttl 1h --help",
      "repo-aegis approve --help --list",
      "repo-aegis approve --help=acme/svc",
      "repo-aegis approve -- --help acme/svc",
      "repo-aegis approve --help; repo-aegis approve acme/svc",
      "repo-aegis approve --help || repo-aegis approve acme/svc",
      "repo-aegis approve --help | repo-aegis approve acme/svc",
      "repo-aegis approve --help\nrepo-aegis approve acme/svc",
      "bash -c 'repo-aegis approve --help; repo-aegis approve acme/svc'",
      "repo-aegis approve --help repo-aegis approve acme/svc",
      "repo-aegis --home /x approve acme/svc --help",
      "repo-aegis help approve acme/svc",
      "repo-aegis approve help",
      "repo-aegis identity add me --gh-login alice --help",
      "repo-aegis engagements set-identity customer-a --person me --help",
      "repo-aegis engagements add --personal-org stranger --help",
      "repo-aegis upstreams add upstream-org/lib --help",
      "repo-aegis init --force --help",
      "repo-aegis init --migrate-classify -h",
      "repo-aegis uninstall --yes --help",
      "repo-aegis install claude-md --uninstall --help",
      "repo-aegis gh --help -- pr view 1",
      "repo-aegis git-credential --help get",
      "alias ra=repo-aegis; ra approve --help; ra approve acme/svc",
      "$(which repo-aegis) approve --help acme/svc",
    ]) {
      assertRefusedAsHumanCommand(command);
    }
  });

  it("`--help` that is not a whole argument is not help: Commander runs the action for each of these", () => {
    for (const command of [
      "repo-aegis approve >--help",
      "repo-aegis approve >-h",
      "repo-aegis approve <<<--help",
      "repo-aegis approve <<--help\n-help",
      "repo-aegis approve ' --help'",
      "repo-aegis approve 'gh --help'",
      "repo-aegis approve gh,--help",
      "repo-aegis approve gh=--help",
      "repo-aegis approve '!--help'",
      "repo-aegis approve '[--help]'",
      "repo-aegis approve '{--help}'",
      "repo-aegis approve gh\f--help",
      "repo-aegis identity remove gh >--help",
      "repo-aegis identity remove >--help 7",
      "repo-aegis gh >--help",
      "$(which repo-aegis) approve >--help",
      "bash -c 'repo-aegis approve >--help'",
      "script -q /dev/null repo-aegis identity remove install >--help",
      "script -q /dev/null repo-aegis approve >--help",
      "alias ra=repo-aegis; bash -c 'ra approve acme/svc'",
    ]) {
      assertRefusedAsHumanCommand(command);
    }
  });

  it("whole redirections around a help request are allowed, and `<group> help <sub>` and global boolean flags too", () => {
    for (const command of [
      "repo-aegis approve --help > /tmp/help.txt",
      "repo-aegis approve --help 2>/dev/null",
      "repo-aegis approve --help </dev/null",
      "repo-aegis approve --help 2>&1",
      "repo-aegis identity help add",
      "repo-aegis --json approve --help",
      "repo-aegis --no-color identity add --help",
    ]) {
      assertAllowed(command);
    }
  });

  it("--help on a managed-settings write is not a help read (it is not a repo-aegis verb)", () => {
    assert.equal(runGuard("sudo ls /etc/claude-code/managed-settings.d --help").code, 2);
  });
});

/** Every command and subcommand path under `program`, skipping Commander's implicit `help`. */
function commandPaths(cmd: Command, prefix: readonly string[] = []): string[][] {
  return cmd.commands
    .filter(c => c.name() !== "help")
    .flatMap(c => [[...prefix, c.name()], ...commandPaths(c, [...prefix, c.name()])]);
}

describe("hook guard-egress: --help on every command is allowed", { skip: !cliBuilt() }, () => {
  it("walks Commander's tree: `repo-aegis <command> --help` is refused for none (an agent-shaped call)", async () => {
    const paths = commandPaths(await buildProgram());
    assert.ok(paths.length > 40, `the walk found only ${paths.length} commands`);
    assert.ok(paths.some(p => p.join(" ") === "approve"), "approve is in the tree");
    assert.ok(paths.some(p => p.length === 2), "subcommands are in the tree");
    const refused: string[] = [];
    for (const path of paths) {
      const command = `repo-aegis ${path.join(" ")} --help`;
      const r = runGuard(command);
      if (r.code !== 0) refused.push(`${command}\n  exit ${r.code}: ${r.stderr.split("\n")[0]}`);
    }
    assert.deepEqual(refused, []);
  });

  it("the same walk with `-h`, and with `repo-aegis help <command>`, refuses none (the guard's own matcher, in process)", async () => {
    const refused: string[] = [];
    for (const path of commandPaths(await buildProgram())) {
      for (const command of [`repo-aegis ${path.join(" ")} -h`, `repo-aegis help ${path.join(" ")}`]) {
        if (findHumanOnlyCommand(command) !== null) refused.push(command);
      }
    }
    assert.deepEqual(refused, []);
  });

  it("the premise: Commander prints help and runs no action for `<verb> --help` and `<group> help <sub>` of every person-only verb", () => {
    const env: NodeJS.ProcessEnv = { ...process.env, REPO_AEGIS_HOME: home };
    for (const paths of Object.values(HUMAN_VERB_PATHS)) {
      for (const path of paths) {
        const forms = [[...path, "--help"], ...(path.length > 1 ? [[path[0]!, "help", ...path.slice(1)]] : [])];
        for (const args of forms) {
          const r = spawnSync(process.execPath, [cliPath, ...args], { cwd: tmp, env, encoding: "utf8" });
          assert.equal(r.status, 0, `${args.join(" ")}\n${r.stderr}`);
          assert.match(r.stdout, /^Usage: /, args.join(" "));
        }
      }
    }
  });

  it("every verb in the human-commands table is a real command in the tree", async () => {
    const real = new Set(commandPaths(await buildProgram()).map(p => p.join(" ")));
    for (const paths of Object.values(HUMAN_VERB_PATHS)) {
      for (const path of paths) assert.ok(real.has(path.join(" ")), `HUMAN_VERB_PATHS names "${path.join(" ")}", which is not a command`);
    }
  });

  it("the root --help and `help` are allowed too", () => {
    assertAllowed("repo-aegis --help");
    assertAllowed("repo-aegis help");
  });
});
