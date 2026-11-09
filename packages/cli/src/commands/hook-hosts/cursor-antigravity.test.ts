// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// The Cursor (plan T1b) and Antigravity (unverified) adapters: exact outputs,
// exact parse results on the doc-derived fixtures (__fixtures__/hosts/), the
// "judge beforeShellExecution only" rule, and the T1f property test: any
// generated non-egress command is allowed and nothing that denies is printed,
// both in-process and through the real hook.
//
// The contract conformance suite in hosts.test.ts already runs on both.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scrubGitEnv } from "../../_test-utils.js";
import { cliBuilt, cliPath } from "../../_subprocess-utils.js";
import { adapterFor } from "./index.js";
import { FIXTURE_CWD, loadFixture, loadFixtureIndex, withCommand } from "./_fixtures.js";

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const cursor = adapterFor("cursor");
const agy = adapterFor("antigravity");

function fixturePayload(file: string): unknown {
  const f = loadFixtureIndex().find(x => x.file === file);
  assert.ok(f, file);
  return loadFixture(f);
}

describe("cursor adapter (beforeShellExecution)", () => {
  it("registers with ask, unlike codex and gemini", () => {
    assert.equal(cursor.hasAsk, true);
    assert.equal(cursor.name, "cursor");
  });

  it("exact output for each decision: explicit allow, deny and ask on stdout with exit 0, error is exit 1 with no stdout", () => {
    assert.deepEqual(cursor.render({ action: "allow" }), { stdout: '{"permission":"allow"}\n', exitCode: 0 });
    assert.deepEqual(cursor.render({ action: "allow", reason: "r1" }), {
      stdout: '{"permission":"allow","user_message":"r1","agent_message":"r1"}\n',
      exitCode: 0,
    });
    assert.deepEqual(cursor.render({ action: "deny", reason: "r2" }), {
      stdout: '{"permission":"deny","user_message":"r2","agent_message":"r2"}\n',
      exitCode: 0,
    });
    assert.deepEqual(cursor.render({ action: "ask", reason: "r3" }), {
      stdout: '{"permission":"ask","user_message":"r3","agent_message":"r3"}\n',
      exitCode: 0,
    });
    // Fail open: Cursor treats a non-zero exit other than 2 as non-blocking. Never 2, never a deny.
    assert.deepEqual(cursor.render({ action: "error" }), { stdout: "", exitCode: 1 });
  });

  it("a deny reason with quotes, newlines and non-ASCII stays valid JSON that round-trips", () => {
    const reason = 'refused: "git push"\nsee `repo-aegis approve` ü  ';
    const out = cursor.render({ action: "deny", reason });
    const parsed = JSON.parse(out.stdout) as { permission: string; user_message: string; agent_message: string };
    assert.deepEqual(parsed, { permission: "deny", user_message: reason, agent_message: reason });
  });

  it("the doc-derived beforeShellExecution fixture yields its command and cwd", () => {
    assert.deepEqual(cursor.parse(JSON.stringify(fixturePayload("cursor.before-shell-execution.json"))), {
      kind: "command",
      command: "echo hello",
      cwd: FIXTURE_CWD,
    });
  });

  it("the preToolUse fixture is not judged (its `ask` is not enforced by Cursor), nor is afterFileEdit", () => {
    assert.deepEqual(cursor.parse(JSON.stringify(fixturePayload("cursor.pre-tool-use.json"))), { kind: "skip" });
    assert.deepEqual(cursor.parse(JSON.stringify(fixturePayload("cursor.after-file-edit.json"))), { kind: "skip" });
  });

  it("a payload with no hook_event_name but a root command is still judged; another event with a command is not", () => {
    assert.deepEqual(cursor.parse(JSON.stringify({ command: "git push" })), { kind: "command", command: "git push" });
    assert.deepEqual(cursor.parse(JSON.stringify({ hook_event_name: "beforeShellExecution", command: "git push", cwd: "" })), {
      kind: "command",
      command: "git push",
    });
    assert.deepEqual(cursor.parse(JSON.stringify({ hook_event_name: "beforeMCPExecution", command: "git push" })), { kind: "skip" });
  });

  it("a command of the wrong type is malformed (fail open with the contract's reason), an empty or absent one is skipped", () => {
    for (const command of [1, null, ["git", "push"], { a: 1 }, true]) {
      assert.equal(cursor.parse(JSON.stringify({ command })).kind, "malformed", JSON.stringify(command));
    }
    assert.deepEqual(cursor.parse(JSON.stringify({ command: "" })), { kind: "skip" });
    assert.deepEqual(cursor.parse("{}"), { kind: "skip" });
  });

  it("oversized: refuses a cut beforeShellExecution payload, proceeds on a named non-shell tool", () => {
    assert.equal(cursor.oversized('{"hook_event_name": "beforeShellExecution", "command": "git push ' + "x".repeat(5000)), "refuse");
    assert.equal(cursor.oversized('{"tool_name": "Write", "tool_input": {"contents": "' + "x".repeat(5000)), "proceed");
  });
});

describe("antigravity adapter (UNVERIFIED: PreToolUse, run_command)", () => {
  it("has no ask", () => {
    assert.equal(agy.hasAsk, false);
    assert.equal(agy.name, "antigravity");
  });

  it("exact output: every answer exits 0 (exit codes are undocumented); deny and ask deny on stdout; error is a plain allow", () => {
    assert.deepEqual(agy.render({ action: "allow" }), { stdout: '{"decision":"allow"}\n', exitCode: 0 });
    assert.deepEqual(agy.render({ action: "allow", reason: "r1" }), { stdout: '{"decision":"allow","reason":"r1"}\n', exitCode: 0 });
    assert.deepEqual(agy.render({ action: "deny", reason: "r2" }), { stdout: '{"decision":"deny","reason":"r2"}\n', exitCode: 0 });
    assert.deepEqual(agy.render({ action: "ask", reason: "r3" }), { stdout: '{"decision":"deny","reason":"r3"}\n', exitCode: 0 });
    assert.deepEqual(agy.render({ action: "error" }), { stdout: '{"decision":"allow"}\n', exitCode: 0 });
  });

  it("the doc-derived fixture yields CommandLine and the Cwd arg (there is no root cwd)", () => {
    const payload = fixturePayload("antigravity.pre-tool-use.json");
    assert.deepEqual(agy.parse(JSON.stringify(payload)), { kind: "command", command: "echo hello", cwd: FIXTURE_CWD });
    // No Cwd arg: no cwd. The workspacePaths list is NOT used (several roots, no way to pick one).
    const noCwd = structuredClone(payload) as { toolCall: { args: Record<string, unknown> } };
    delete noCwd.toolCall.args["Cwd"];
    assert.deepEqual(agy.parse(JSON.stringify(noCwd)), { kind: "command", command: "echo hello" });
  });

  it("another tool is skipped even when it carries a CommandLine; a missing toolCall, args or CommandLine is skipped", () => {
    const payload = fixturePayload("antigravity.pre-tool-use.json");
    for (const name of ["write_to_file", "view_file", "run_command2"]) {
      const p = structuredClone(payload) as { toolCall: { name: string } };
      p.toolCall.name = name;
      assert.deepEqual(agy.parse(JSON.stringify(p)), { kind: "skip" }, name);
    }
    assert.deepEqual(agy.parse("{}"), { kind: "skip" });
    assert.deepEqual(agy.parse(JSON.stringify({ toolCall: { name: "run_command" } })), { kind: "skip" });
    assert.deepEqual(agy.parse(JSON.stringify({ toolCall: { name: "run_command", args: {} } })), { kind: "skip" });
    assert.deepEqual(agy.parse(JSON.stringify({ toolCall: { name: "run_command", args: { CommandLine: "" } } })), { kind: "skip" });
  });

  it("a gemini-shaped payload is not judged here (skip), so the wrong --agent value is visible, not silently half-working", () => {
    assert.deepEqual(agy.parse(JSON.stringify({ tool_name: "run_shell_command", tool_input: { command: "git push" } })), { kind: "skip" });
  });

  it("wrong types are malformed: toolCall, args, CommandLine", () => {
    for (const p of [
      { toolCall: "run_command" },
      { toolCall: [] },
      { toolCall: { name: "run_command", args: "git push" } },
      { toolCall: { name: "run_command", args: { CommandLine: ["git", "push"] } } },
      { toolCall: { name: "run_command", args: { CommandLine: 7 } } },
    ]) {
      assert.equal(agy.parse(JSON.stringify(p)).kind, "malformed", JSON.stringify(p));
    }
  });

  it("oversized: proceeds only when toolCall.name inside the first 4 KiB is not run_command", () => {
    const pad = "x".repeat(5000);
    assert.equal(agy.oversized('{"toolCall": {"name": "write_to_file", "args": {"Content": "' + pad), "proceed");
    assert.equal(agy.oversized('{"toolCall": {"name": "run_command", "args": {"CommandLine": "' + pad), "refuse");
    assert.equal(agy.oversized('{"lastUserInput": "' + pad + '", "toolCall": {"name": "write_to_file"'), "refuse", "past 4 KiB is not read");
  });
});

// T1f: seeded-random property. A generated command that is not egress is allowed, and nothing that
// denies is printed, whatever the command's text.
const SAFE_WORDS = [
  "ls", "echo", "cat", "grep", "sed", "awk", "make", "cargo", "npm", "test", "build", "git", "status", "log", "diff",
  "fetch-me-not", "cd", "src", "-la", "--help", "&&", ";", "|", "$HOME", "'quoted word'", '"dq"', "a.txt", "./x.sh", "2>&1",
  "# push is only a comment word", "pushd", "publisher", "ghost", "curlicue",
];

/** Commands from a vocabulary with no egress verb: never `git push`, `gh`, `npm publish` or a raw network write. */
function generateNonEgressCommand(rng: () => number): string {
  const n = 1 + Math.floor(rng() * 8);
  const words: string[] = [];
  for (let i = 0; i < n; i++) words.push(SAFE_WORDS[Math.floor(rng() * SAFE_WORDS.length)]!);
  return words.join(" ");
}

const ADAPTER_FIXTURES: ReadonlyArray<readonly [agent: string, file: string, allowStdout: string]> = [
  ["cursor", "cursor.before-shell-execution.json", '{"permission":"allow"}\n'],
  ["antigravity", "antigravity.pre-tool-use.json", '{"decision":"allow"}\n'],
];

describe("property: a non-egress command is allowed and nothing that denies is printed (T1f)", () => {
  for (const [agent, file, allowStdout] of ADAPTER_FIXTURES) {
    it(`${agent}: parse returns the command verbatim and the allow rendering carries no deny (seeded, 500 commands)`, () => {
      const rng = mulberry32(0xf00d);
      const a = adapterFor(agent);
      const f = loadFixtureIndex().find(x => x.file === file)!;
      const payload = loadFixture(f);
      for (let i = 0; i < 500; i++) {
        const command = generateNonEgressCommand(rng);
        const p = a.parse(JSON.stringify(withCommand(payload, f.commandPath!, command)));
        assert.deepEqual(p, { kind: "command", command, cwd: FIXTURE_CWD });
        const out = a.render({ action: "allow" });
        assert.equal(out.stdout, allowStdout);
        assert.equal(out.exitCode, 0);
        assert.doesNotMatch(out.stdout, /deny|ask/);
      }
    });
  }
});

const SUBPROCESS_TESTS_AVAILABLE = cliBuilt();

describe("property through the real hook: non-egress commands exit 0 with only the host's allow", { skip: !SUBPROCESS_TESTS_AVAILABLE }, () => {
  let restoreGitEnv: () => void;
  let tmp: string;
  let home: string;
  let repo: string;

  before(() => {
    restoreGitEnv = scrubGitEnv();
    tmp = realpathSync(mkdtempSync(join(tmpdir(), "repo-aegis-cursor-agy-test-")));
    home = join(tmp, "aegis");
    mkdirSync(join(home, "markers"), { recursive: true });
    mkdirSync(join(home, "state"), { recursive: true });
    writeFileSync(join(home, "engagements.yaml"), "schemaVersion: 2\nengagements: []\n");
    repo = join(tmp, "repo");
    mkdirSync(repo);
    execFileSync("git", ["init", "-q", "--initial-branch=main", repo], { stdio: "ignore" });
  });

  after(() => {
    restoreGitEnv();
    rmSync(tmp, { recursive: true, force: true });
  });

  function run(agent: string, input: string): { stdout: string; stderr: string; code: number | null } {
    const env: NodeJS.ProcessEnv = { ...process.env, REPO_AEGIS_HOME: home, REPO_AEGIS_VISIBILITY_LOOKUP: "0" };
    delete env["REPO_AEGIS_EGRESS_HUMAN"];
    delete env["REPO_AEGIS_ASSUME_PUBLIC"];
    const r = spawnSync(process.execPath, [cliPath, "hook", "guard-egress", "--agent", agent], { cwd: tmp, env, encoding: "utf8", input });
    return { stdout: r.stdout, stderr: r.stderr, code: r.status };
  }

  for (const [agent, file, allowStdout] of ADAPTER_FIXTURES) {
    it(`${agent}: 30 seeded non-egress commands`, () => {
      const rng = mulberry32(0xbeef);
      const f = loadFixtureIndex().find(x => x.file === file)!;
      const payload = loadFixture(f);
      for (let i = 0; i < 30; i++) {
        const command = generateNonEgressCommand(rng);
        const r = run(agent, JSON.stringify(withCommand(payload, f.commandPath!, command)).split(FIXTURE_CWD).join(repo));
        assert.equal(r.code, 0, `${command}\n${r.stderr}`);
        assert.equal(r.stdout, allowStdout, command);
        assert.equal(r.stderr, "", command);
      }
    });

    it(`${agent}: a bare git push is refused on the host's own channel (the property's converse: the adapter does deny)`, () => {
      const f = loadFixtureIndex().find(x => x.file === file)!;
      const payload = withCommand(loadFixture(f), f.commandPath!, "git push");
      const r = run(agent, JSON.stringify(payload).split(FIXTURE_CWD).join(repo));
      const out = JSON.parse(r.stdout) as Record<string, string>;
      assert.equal(out["permission"] ?? out["decision"], "deny");
      assert.match(r.stderr, /"code"/, "the core still writes the structured refusal to stderr");
      assert.equal(r.code, 0, "both hosts are answered with exit 0 and a deny on stdout");
    });
  }

  it("cursor: malformed input and a non-shell event fail open with the explicit allow", () => {
    for (const input of ["", "not json", "[1]", '{"hook_event_name":"afterFileEdit","file_path":"/x"}']) {
      const r = run("cursor", input);
      assert.equal(r.code, 0, input);
      assert.equal(r.stdout, '{"permission":"allow"}\n', input);
    }
  });
});
