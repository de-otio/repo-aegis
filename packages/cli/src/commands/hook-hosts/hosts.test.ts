// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// In-process tests of the host-adapter contract (plan T1a, §5). Two layers:
//
//   1. Contract conformance, run for EVERY registered adapter (and the
//      unknown-agent fallback): an adapter added to ADAPTERS is checked by
//      these without writing a line here. They encode the contract's MUSTs.
//   2. Per-host fixture tables: the host's captured or doc-derived stdin →
//      the command and cwd it must yield; decision → exact host output.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ADAPTERS, adapterFor, type HookVerdict, type HostAdapter } from "./index.js";
import { FIXTURE_CWD, loadFixture, loadFixtureIndex, withCommand } from "./_fixtures.js";
import type { EgressDecision } from "@de-otio/repo-aegis-core";
import { outcomeOrError } from "../hook-guard-egress.js";

/** Seeded PRNG (same as the repo's other property tests): no flakiness. */
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

function randomText(rng: () => number, max: number): string {
  const alphabet = ' {}[]":,\\abcdefghijklmnopqrstuvwxyz0123456789-_/.\n\ttool_name command tool_input toolArgs toolCall';
  let s = "";
  const n = Math.floor(rng() * max);
  for (let i = 0; i < n; i++) s += alphabet[Math.floor(rng() * alphabet.length)];
  return s;
}

/** Fields through which a host lets a hook substitute the command: none may ever be printed (invariant 1). */
const REWRITE_FIELDS = /updatedInput|updated_input|modifiedArgs|overwrite|tool_input|toolArgs|CommandLine/;

const VERDICTS: readonly HookVerdict[] = [
  { action: "allow" },
  { action: "allow", reason: "repo-aegis: human approval 0123abcd (acme/svc, until 2026-11-09T12:00:00.000Z) stands in for a person on this publish." },
  { action: "ask", reason: "repo-aegis: a PUBLIC destination; have a human run or approve this." },
  { action: "deny", reason: "repo-aegis: refused. git push names no destination." },
  { action: "error" },
];

const ALL: readonly HostAdapter[] = [...ADAPTERS.values(), adapterFor("some-other-agent")];

describe("host adapters — contract conformance (every adapter)", () => {
  for (const a of ALL) {
    describe(`adapter ${a.name}`, () => {
      it("is selected by its own name", () => {
        assert.equal(adapterFor(a.name).name, a.name);
        assert.equal(adapterFor(a.name).hasAsk, a.hasAsk);
      });

      it("render is deterministic and never prints a rewritten command", () => {
        for (const v of VERDICTS) {
          const out = a.render(v);
          assert.deepEqual(a.render(v), out, `${v.action}: pure`);
          assert.doesNotMatch(out.stdout, REWRITE_FIELDS, `${v.action}: decision-only`);
          assert.ok(Number.isInteger(out.exitCode) && out.exitCode >= 0 && out.exitCode <= 255);
        }
      });

      it("deny blocks: a non-zero exit or a deny on stdout, and the reason reaches stdout", () => {
        const reason = "repo-aegis: refused. sentinel-reason-7f3a";
        const out = a.render({ action: "deny", reason });
        assert.ok(out.exitCode !== 0 || /deny/.test(out.stdout), "a deny must block");
        assert.ok(out.stdout.includes("sentinel-reason-7f3a"), "hosts that ignore stderr still see why");
      });

      it("ask never degrades to allow; without an ask it renders exactly as a deny", () => {
        const reason = "have a human run or approve this";
        const ask = a.render({ action: "ask", reason });
        if (a.hasAsk) {
          assert.match(ask.stdout, /ask/);
        } else {
          assert.deepEqual(ask, a.render({ action: "deny", reason }));
        }
        assert.doesNotMatch(ask.stdout, /"allow"/);
      });

      it("allow without a reason is the host's least output (no decision text, exit 0)", () => {
        const out = a.render({ action: "allow" });
        assert.equal(out.exitCode, 0);
        assert.doesNotMatch(out.stdout, /deny|ask|reason/i);
      });

      it("error is the host's fail-open answer: never a deny", () => {
        const out = a.render({ action: "error" });
        assert.doesNotMatch(out.stdout, /deny/);
        assert.notEqual(out.exitCode, 2);
      });

      it("parse never throws and never invents a command (seeded fuzz, 2000 inputs)", () => {
        const rng = mulberry32(0x7a1a);
        for (let i = 0; i < 2000; i++) {
          const s = randomText(rng, 120);
          const p = a.parse(s);
          assert.ok(p.kind === "command" || p.kind === "skip" || p.kind === "malformed");
          if (p.kind === "command") assert.ok(s.includes(p.command), `command must come from the input: ${JSON.stringify(s)}`);
          if (p.kind === "malformed") assert.ok(!p.reason.includes(s) || s.length < 3, "the reason carries no payload text");
        }
      });

      it("malformed input is `malformed`, never a command", () => {
        for (const s of ["", "not json", "[1,2,3]", '"git push"', "null", "42", '{"tool_input": {"command": "git pu']) {
          assert.equal(a.parse(s).kind, "malformed", JSON.stringify(s));
        }
      });

      it("oversized: refuses a cut payload unless the prefix proves a non-shell tool", () => {
        assert.equal(a.oversized(""), "refuse");
        assert.equal(a.oversized('{"tool_input": {"command": "git push ' + "x".repeat(5000)), "refuse");
      });
    });
  }
});

describe("host adapters — the PreToolUse family (claude, codex, gemini)", () => {
  it("claude asks; codex, gemini and an unknown agent do not", () => {
    assert.equal(adapterFor(undefined).name, "claude");
    assert.equal(adapterFor(undefined).hasAsk, true);
    assert.equal(adapterFor("codex").hasAsk, false);
    assert.equal(adapterFor("gemini").hasAsk, false);
    assert.equal(adapterFor("some-other-agent").hasAsk, false);
    assert.equal(adapterFor("").hasAsk, false, "an empty --agent is unknown, not claude");
  });

  it("names are matched case-insensitively: `Claude`, `CODEX`, `Antigravity` are the adapters, not the fallback", () => {
    assert.equal(adapterFor("Claude").name, "claude");
    assert.equal(adapterFor("Claude").hasAsk, true);
    assert.equal(adapterFor("CODEX").name, "codex");
    assert.equal(adapterFor("CODEX").hasAsk, false);
    assert.equal(adapterFor("Antigravity").name, "antigravity");
    assert.equal(adapterFor("Cursor").name, "cursor");
    assert.equal(adapterFor("Copilot").name, "copilot");
    // The deny shape is the host's own, which is the observable difference from the fallback.
    assert.equal(adapterFor("Antigravity").render({ action: "deny", reason: "r" }).stdout, '{"decision":"deny","reason":"r"}\n');
  });

  it("an unknown name tries every known shape in turn; its rendering is the no-ask PreToolUse family", () => {
    const a = adapterFor("some-other-agent");
    const payloads: ReadonlyArray<readonly [string, unknown, string]> = [
      ["PreToolUse tool_input.command", { tool_name: "Bash", tool_input: { command: "git push" }, cwd: "/w" }, "/w"],
      ["Copilot toolArgs (a JSON string)", { toolName: "bash", toolArgs: '{"command":"git push"}', cwd: "/w" }, "/w"],
      ["Copilot toolArgs (an object)", { toolName: "bash", toolArgs: { command: "git push" }, cwd: "/w" }, "/w"],
      ["root command", { command: "git push", cwd: "/w" }, "/w"],
      ["Antigravity toolCall", { toolCall: { name: "run_command", args: { CommandLine: "git push", Cwd: "/c" } } }, "/c"],
    ];
    for (const [label, payload, cwd] of payloads) {
      assert.deepEqual(a.parse(JSON.stringify(payload)), { kind: "command", command: "git push", cwd }, label);
    }
    assert.equal(a.hasAsk, false);
    assert.deepEqual(a.render({ action: "deny", reason: "r" }), adapterFor("codex").render({ action: "deny", reason: "r" }));
    // A non-shell tool in any host's spelling is skipped; a named shell tool with no command is visible.
    assert.deepEqual(a.parse(JSON.stringify({ toolName: "edit", toolArgs: '{"command":"git push"}' })), { kind: "skip" });
    assert.deepEqual(a.parse(JSON.stringify({ toolCall: { name: "view_file", args: { CommandLine: "git push" } } })), { kind: "skip" });
    assert.equal(a.parse(JSON.stringify({ tool_name: "Bash", tool_input: {} })).kind, "malformed");
    assert.deepEqual(a.parse("{}"), { kind: "skip" });
    // Oversized: proceeds only when the prefix names a non-shell tool in some host's key.
    const pad = "x".repeat(5000);
    assert.equal(a.oversized('{"toolName": "edit", "toolArgs": "' + pad), "proceed");
    assert.equal(a.oversized('{"toolCall": {"name": "view_file", "args": {"x": "' + pad), "proceed");
    assert.equal(a.oversized('{"toolCall": {"name": "run_command", "args": {"CommandLine": "' + pad), "refuse");
  });

  for (const a of [adapterFor("claude"), adapterFor("codex"), adapterFor("gemini")]) {
    it(`${a.name}: exact output for each decision`, () => {
      const json = (d: string, r: string): string =>
        JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: d, permissionDecisionReason: r } }) + "\n";
      assert.deepEqual(a.render({ action: "allow" }), { stdout: "", exitCode: 0 });
      assert.deepEqual(a.render({ action: "allow", reason: "r1" }), { stdout: json("allow", "r1"), exitCode: 0 });
      assert.deepEqual(a.render({ action: "deny", reason: "r2" }), { stdout: json("deny", "r2"), exitCode: 2 });
      assert.deepEqual(a.render({ action: "error" }), { stdout: "", exitCode: 1 });
      assert.deepEqual(
        a.render({ action: "ask", reason: "r3" }),
        a.hasAsk ? { stdout: json("ask", "r3"), exitCode: 0 } : { stdout: json("deny", "r3"), exitCode: 2 },
      );
    });

    it(`${a.name}: parse — tool_input.command, root command fallback, argv flattening, cwd`, () => {
      assert.deepEqual(a.parse(JSON.stringify({ tool_name: "Bash", tool_input: { command: "git push" }, cwd: "/w" })), {
        kind: "command",
        command: "git push",
        cwd: "/w",
      });
      assert.deepEqual(a.parse(JSON.stringify({ command: "git push" })), { kind: "command", command: "git push" });
      assert.deepEqual(a.parse(JSON.stringify({ tool_input: { command: ["bash", "-lc", "git push origin main"] } })), {
        kind: "command",
        command: "git push origin main",
      });
      assert.deepEqual(a.parse(JSON.stringify({ tool_input: { command: ["git", "push"] } })), { kind: "command", command: "git push" });
      assert.deepEqual(a.parse(JSON.stringify({ tool_input: { command: "" }, command: "npm publish" })), {
        kind: "command",
        command: "npm publish",
      });
      // An empty cwd is no cwd: the policy then falls back to the process cwd.
      assert.deepEqual(a.parse(JSON.stringify({ tool_input: { command: "x" }, cwd: "" })), { kind: "command", command: "x" });
    });

    it(`${a.name}: parse — shell tool names in any case are inspected; other tools and no command are skipped`, () => {
      for (const t of ["Bash", "bash", "BASH", "shell", "Shell", "run_shell_command", ""]) {
        assert.equal(a.parse(JSON.stringify({ tool_name: t, tool_input: { command: "git push" } })).kind, "command", t);
      }
      for (const t of ["Write", "Edit", "Read", "bash2", "run_command"]) {
        assert.deepEqual(a.parse(JSON.stringify({ tool_name: t, tool_input: { command: "git push" } })), { kind: "skip" }, t);
      }
      assert.deepEqual(a.parse("{}"), { kind: "skip" });
      // An empty command is nothing to judge, not a misconfiguration.
      assert.deepEqual(a.parse(JSON.stringify({ tool_name: "Bash", tool_input: { command: "" } })), { kind: "skip" });
    });

    it(`${a.name}: parse — a shell tool with no command, or a command in another host's shape, is malformed, not skip`, () => {
      const noCommand = a.parse(JSON.stringify({ tool_name: "Bash", tool_input: {} }));
      assert.equal(noCommand.kind, "malformed");
      assert.equal(a.parse(JSON.stringify({ tool_name: "Bash" })).kind, "malformed");
      // Copilot camelCase and Antigravity payloads under a PreToolUse-family --agent.
      for (const payload of [
        { toolName: "bash", toolArgs: '{"command":"git push"}' },
        { toolCall: { name: "run_command", args: { CommandLine: "git push" } } },
      ]) {
        const p = a.parse(JSON.stringify(payload));
        assert.equal(p.kind, "malformed", JSON.stringify(payload));
        if (p.kind === "malformed") assert.ok(!p.reason.includes("git push"), "the reason carries no payload text");
      }
      // A non-shell tool stays a silent skip, whatever its fields.
      assert.deepEqual(a.parse(JSON.stringify({ tool_name: "Write", tool_input: {} })), { kind: "skip" });
      assert.deepEqual(a.parse(JSON.stringify({ toolName: "edit", toolArgs: '{"command":"git push"}' })), { kind: "skip" });
    });

    it(`${a.name}: oversized — proceeds only on a named non-shell tool inside the first 4 KiB`, () => {
      assert.equal(a.oversized('{"tool_name": "Write", "tool_input": {"content": "' + "x".repeat(5000)), "proceed");
      assert.equal(a.oversized('{"tool_name": "Bash", "tool_input": {"command": "' + "x".repeat(5000)), "refuse");
      assert.equal(a.oversized('{"session": "' + "x".repeat(5000) + '", "tool_name": "Write"'), "refuse", "past 4 KiB is not read");
    });
  }
});

describe("hook guard-egress — rendering a decision that throws becomes the host's fail-open answer", () => {
  const deny = { action: "deny", code: "PUSH_IMPLICIT_TARGET", reason: "r", intent: { verb: "git-push" } } as unknown as EgressDecision;
  const ctx = { registryNote: undefined, ruleH: "applied", humanPresent: false } as const;

  it("a well-formed deny is planned as a deny with the structured refusal on stderr", () => {
    const o = outcomeOrError(deny, ctx);
    assert.deepEqual(o.verdict, { action: "deny", reason: "r" });
    assert.deepEqual(JSON.parse(o.stderr!), { code: "PUSH_IMPLICIT_TARGET", error: "r", details: { verb: "git push" } });
  });

  it("a decision whose rendering throws (here: no intent) is the `error` verdict, never an uncaught exception", () => {
    const broken = { action: "deny", code: "PUSH_IMPLICIT_TARGET", reason: "r" } as unknown as EgressDecision;
    const o = outcomeOrError(broken, ctx);
    assert.deepEqual(o.verdict, { action: "error" });
    assert.match(o.stderr!, /^repo-aegis: hook guard-egress failed, command not evaluated: /);
  });

  it("the error verdict renders as every host's fail-open answer: Copilot exits 0 (it fails closed on 1), nobody exits 2 or denies", () => {
    assert.deepEqual(adapterFor("copilot").render({ action: "error" }), { stdout: "", exitCode: 0 });
    for (const a of ALL) {
      const out = a.render({ action: "error" });
      assert.notEqual(out.exitCode, 2, a.name);
      assert.doesNotMatch(out.stdout, /deny/, a.name);
    }
  });
});

describe("host adapters — fixtures", () => {
  const fixtures = loadFixtureIndex();
  // Fixtures for hosts with a registered adapter. Cursor, Copilot and
  // Antigravity fixtures exist ahead of their adapters (plan T1b–T1d); each
  // new adapter's fixtures join this table as soon as it is in ADAPTERS.
  // Not judged by design, tested as `skip` in cursor-antigravity.test.ts: Cursor's `preToolUse` does not
  // enforce `ask`, so the Cursor adapter judges `beforeShellExecution` only.
  const NOT_JUDGED = new Set(["cursor.pre-tool-use.json"]);
  const covered = fixtures.filter(f => ADAPTERS.has(f.host) && !NOT_JUDGED.has(f.file));

  it("every registered adapter has at least one fixture", () => {
    for (const name of ADAPTERS.keys()) assert.ok(covered.some(f => f.host === name), name);
  });

  for (const f of covered) {
    const a = adapterFor(f.agent);
    const payload = loadFixture(f);

    if (f.commandPath === null) {
      it(`${f.file}: carries no command, so it is skipped`, () => {
        assert.equal(a.parse(JSON.stringify(payload)).kind, "skip");
      });
      continue;
    }

    it(`${f.file}: yields its command and cwd`, () => {
      assert.deepEqual(a.parse(JSON.stringify(payload)), { kind: "command", command: "echo hello", cwd: FIXTURE_CWD });
    });

    it(`${f.file}: any substituted command comes back verbatim (seeded, 500 commands)`, () => {
      const rng = mulberry32(0xc0de);
      for (let i = 0; i < 500; i++) {
        const command = randomText(rng, 80).trim() || "true";
        const p = a.parse(JSON.stringify(withCommand(payload, f.commandPath!, command)));
        assert.deepEqual(p, { kind: "command", command, cwd: FIXTURE_CWD });
      }
    });
  }
});
