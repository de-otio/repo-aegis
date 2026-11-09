// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// In-process tests of the Copilot CLI adapter (plan T1c) and the Codex
// corrections. The contract conformance suite in hosts.test.ts already runs
// on every registered adapter, copilot included; this file pins what is
// specific to these two hosts: exact outputs and the payload shapes.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { adapterFor } from "./index.js";
import { FIXTURE_CWD } from "./_fixtures.js";

const copilot = adapterFor("copilot");
const codex = adapterFor("codex");

const camel = (toolArgs: unknown, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ sessionId: "s", timestamp: 1, cwd: "/w", toolName: "bash", toolArgs, ...extra });

describe("copilot adapter — render", () => {
  it("hasAsk: the interactive CLI asks; cloud and autopilot treat ask as deny (safe direction)", () => {
    assert.equal(copilot.hasAsk, true);
  });

  it("exact output for each decision", () => {
    // Both events' places in one object: camelCase reads the top level, PascalCase reads hookSpecificOutput.
    const json = (d: string, r: string): string =>
      JSON.stringify({
        permissionDecision: d,
        permissionDecisionReason: r,
        hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: d, permissionDecisionReason: r },
      }) + "\n";
    assert.deepEqual(copilot.render({ action: "allow" }), { stdout: "", exitCode: 0 });
    assert.deepEqual(copilot.render({ action: "allow", reason: "r1" }), { stdout: json("allow", "r1"), exitCode: 0 });
    assert.deepEqual(copilot.render({ action: "ask", reason: "r2" }), { stdout: json("ask", "r2"), exitCode: 0 });
    assert.deepEqual(copilot.render({ action: "deny", reason: "r3" }), { stdout: json("deny", "r3"), exitCode: 2 });
  });

  it("error never exits non-zero (Copilot fails CLOSED on any exit but 0 and 2)", () => {
    assert.deepEqual(copilot.render({ action: "error" }), { stdout: "", exitCode: 0 });
    for (const v of [
      { action: "allow" },
      { action: "allow", reason: "r" },
      { action: "ask", reason: "r" },
      { action: "deny", reason: "r" },
      { action: "error" },
    ] as const) {
      assert.ok([0, 2].includes(copilot.render(v).exitCode), `${v.action}: exit must be 0 or 2, never 1`);
    }
  });
});

describe("copilot adapter — parse", () => {
  it("camelCase preToolUse: the command is inside the JSON-string toolArgs", () => {
    assert.deepEqual(copilot.parse(camel(JSON.stringify({ command: "git push origin main", description: "d" }))), {
      kind: "command",
      command: "git push origin main",
      cwd: "/w",
    });
  });

  it("camelCase: a command with quotes, newlines and backslashes survives the double decode", () => {
    const command = 'git commit -m "a\\nb"\ngit push\torigin \'x\'';
    assert.deepEqual(copilot.parse(camel(JSON.stringify({ command }))), { kind: "command", command, cwd: "/w" });
  });

  it("PascalCase PreToolUse: tool_input as an object", () => {
    assert.deepEqual(copilot.parse(JSON.stringify({ tool_name: "Bash", tool_input: { command: "git push" }, cwd: "/w" })), {
      kind: "command",
      command: "git push",
      cwd: "/w",
    });
  });

  it("PascalCase PreToolUse: tool_input as a JSON string", () => {
    assert.deepEqual(copilot.parse(JSON.stringify({ tool_name: "Bash", tool_input: JSON.stringify({ command: "git push" }), cwd: "/w" })), {
      kind: "command",
      command: "git push",
      cwd: "/w",
    });
  });

  it("takes cwd only from the payload", () => {
    assert.deepEqual(copilot.parse(JSON.stringify({ toolName: "bash", toolArgs: '{"command":"x"}' })), { kind: "command", command: "x" });
    assert.deepEqual(copilot.parse(JSON.stringify({ toolName: "bash", toolArgs: '{"command":"x"}', cwd: "" })), { kind: "command", command: "x" });
    assert.deepEqual(copilot.parse(JSON.stringify({ toolName: "bash", toolArgs: '{"command":"x"}', cwd: FIXTURE_CWD })), {
      kind: "command",
      command: "x",
      cwd: FIXTURE_CWD,
    });
  });

  it("argv-style commands are flattened like the rest of the family", () => {
    assert.deepEqual(copilot.parse(camel(JSON.stringify({ command: ["bash", "-lc", "git push origin main"] }))), {
      kind: "command",
      command: "git push origin main",
      cwd: "/w",
    });
  });

  it("shell tools in any case are inspected; other tools and payloads without a command are skipped", () => {
    for (const t of ["bash", "Bash", "powershell", "PowerShell", ""]) {
      assert.equal(copilot.parse(camel('{"command":"git push"}', { toolName: t })).kind, "command", t);
    }
    for (const t of ["edit", "view", "create", "bash2", "run_command"]) {
      assert.deepEqual(copilot.parse(camel('{"command":"git push"}', { toolName: t })), { kind: "skip" }, t);
    }
    assert.deepEqual(copilot.parse("{}"), { kind: "skip" });
    assert.deepEqual(copilot.parse(camel('{"command":""}')), { kind: "skip" });
  });

  it("a shell tool with no command field, or a command in another host's shape, is malformed (visible), not skip", () => {
    assert.equal(copilot.parse(camel("{}")).kind, "malformed");
    assert.equal(copilot.parse(JSON.stringify({ toolName: "bash" })).kind, "malformed");
    assert.equal(copilot.parse(JSON.stringify({ tool_name: "Bash", tool_input: {} })).kind, "malformed");
    // An Antigravity payload under --agent copilot.
    assert.equal(copilot.parse(JSON.stringify({ toolCall: { name: "run_command", args: { CommandLine: "git push" } } })).kind, "malformed");
    // Not for a non-shell tool.
    assert.deepEqual(copilot.parse(JSON.stringify({ toolCall: { name: "view_file", args: { CommandLine: "git push" } } })), { kind: "skip" });
  });

  it("write_bash and write_powershell: the typed `input` is judged as the command", () => {
    for (const toolName of ["write_bash", "write_powershell", "WRITE_BASH"]) {
      assert.deepEqual(
        copilot.parse(camel(JSON.stringify({ sessionId: "s1", input: "git push origin main\n", delay: 5 }), { toolName })),
        { kind: "command", command: "git push origin main\n", cwd: "/w" },
        toolName,
      );
      assert.deepEqual(
        copilot.parse(JSON.stringify({ tool_name: toolName, tool_input: { input: "git push" }, cwd: "/w" })),
        { kind: "command", command: "git push", cwd: "/w" },
        `${toolName} PascalCase`,
      );
    }
    // `command` is bash's field, not the input tools': a write_bash with only `command` has nothing typed.
    assert.equal(copilot.parse(camel('{"command":"git push"}', { toolName: "write_bash" })).kind, "malformed");
    // And `input` is not read for bash.
    assert.equal(copilot.parse(camel('{"input":"git push"}', { toolName: "bash" })).kind, "malformed");
    assert.equal(copilot.oversized('{"toolName": "write_bash", "toolArgs": "' + "x".repeat(5000)), "refuse");
  });

  it("a non-shell tool is skipped even when its toolArgs is not JSON", () => {
    assert.deepEqual(copilot.parse(camel("not json at all", { toolName: "edit" })), { kind: "skip" });
  });

  it("a toolArgs or tool_input of the wrong type is malformed, with no payload text in the reason", () => {
    for (const bad of ["not json", "[1,2]", '"git push"', "42", "null", ""]) {
      const p = copilot.parse(camel(bad));
      assert.equal(p.kind, "malformed", bad);
      if (p.kind === "malformed") assert.ok(!p.reason.includes("git push") && (bad.length < 3 || !p.reason.includes(bad)));
    }
    assert.equal(copilot.parse(camel(42)).kind, "malformed");
    assert.equal(copilot.parse(camel(["git", "push"])).kind, "malformed");
    assert.equal(copilot.parse(JSON.stringify({ tool_name: "Bash", tool_input: 7 })).kind, "malformed");
  });

  it("oversized: proceeds only for a named non-shell tool, in either key spelling", () => {
    const pad = "x".repeat(5000);
    assert.equal(copilot.oversized('{"toolName": "edit", "toolArgs": "' + pad), "proceed");
    assert.equal(copilot.oversized('{"tool_name": "Write", "tool_input": {"content": "' + pad), "proceed");
    assert.equal(copilot.oversized('{"toolName": "bash", "toolArgs": "' + pad), "refuse");
    assert.equal(copilot.oversized('{"tool_name": "Bash", "tool_input": "' + pad), "refuse");
    assert.equal(copilot.oversized('{"sessionId": "' + pad + '", "toolName": "edit"'), "refuse", "past 4 KiB is not read");
  });
});

describe("codex adapter — corrections", () => {
  it("matcher `Bash` (current docs) and `shell` (older builds) both reach the command; the unified exec tool is Bash too", () => {
    for (const toolName of ["Bash", "shell"]) {
      assert.deepEqual(
        codex.parse(JSON.stringify({ hook_event_name: "PreToolUse", tool_name: toolName, tool_input: { command: "git push" }, cwd: "/w" })),
        { kind: "command", command: "git push", cwd: "/w" },
        toolName,
      );
    }
  });

  it("another Codex tool is skipped", () => {
    assert.deepEqual(codex.parse(JSON.stringify({ tool_name: "apply_patch", tool_input: { command: "git push" } })), { kind: "skip" });
  });

  it("write_stdin (typed input to a running session) is NOT judged: a documented limit (doc/design/egress-guard.md)", () => {
    for (const tool_input of [{ chars: "git push\n" }, { input: "git push\n" }, { command: "git push" }]) {
      assert.deepEqual(codex.parse(JSON.stringify({ tool_name: "write_stdin", tool_input })), { kind: "skip" });
    }
  });

  it("has no ask: ask renders as a deny with the same reason and exit 2, never an allow", () => {
    assert.equal(codex.hasAsk, false);
    const ask = codex.render({ action: "ask", reason: "have a human run or approve this" });
    assert.deepEqual(ask, codex.render({ action: "deny", reason: "have a human run or approve this" }));
    assert.equal(ask.exitCode, 2);
    assert.match(ask.stdout, /"permissionDecision":"deny"/);
  });
});
