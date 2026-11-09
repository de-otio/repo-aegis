// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// Fixture-driven subprocess tests for `hook guard-egress` across hosts (plan
// T0a/T1a, doc/plan-landscape-recommendations.md §5). Every host fixture in
// `__fixtures__/hosts/` is run with a set of probe commands substituted in.
//
// Two layers:
//   - standing assertions that hold for every fixture whatever the adapter:
//     a non-egress command is silent, and nothing ever prints a rewritten
//     command (the decision-only oracle);
//   - the opt-in golden comparison (`REPO_AEGIS_GUARD_GOLDEN=record|compare`,
//     hook-hosts/_golden.ts): byte-identical stdout, stderr and exit code
//     before and after a refactor.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditLogPath } from "@de-otio/repo-aegis-core";
import { scrubGitEnv } from "../_test-utils.js";
import { cliBuilt, cliPath } from "../_subprocess-utils.js";
import { assertGoldenComplete, golden, HOST_FIXTURES_DIR } from "./hook-hosts/_golden.js";
import { FIXTURE_CWD, loadFixture, loadFixtureIndex, withCommand } from "./hook-hosts/_fixtures.js";

const SUITE = "hook-guard-egress-hosts";

type Decision = "allow" | "ask" | "deny";

/**
 * Probe commands: one per decision path the hook has, with what MUST come back. `ask-or-deny` is an `ask` on a
 * host that can ask (claude, cursor, copilot) and a `deny` on one that cannot, in no case an allow. `code` is
 * the refusal's structured code on stderr (every deny, on every host, ask included where the host denies).
 */
const PROBES: ReadonlyArray<{ label: string; command: string; want: Decision | "ask-or-deny"; code?: string }> = [
  { label: "non-egress", command: "echo hello", want: "allow" },
  { label: "bare push (shape deny)", command: "git push", want: "deny", code: "PUSH_IMPLICIT_TARGET" },
  { label: "egress after cd (shape deny)", command: "cd sub && git push origin main", want: "deny", code: "EGRESS_AFTER_CD" },
  { label: "explicit push to a public destination (ask, or deny without ask)", command: "git push origin main", want: "ask-or-deny", code: "PUBLIC_EGRESS_NEEDS_HUMAN" },
  { label: "human-only command", command: "repo-aegis approve '*'", want: "deny", code: "AGENT_RAN_HUMAN_COMMAND" },
  {
    label: "raw API write (R6)",
    command: "curl -X POST https://api.github.com/repos/acme/svc/issues -d @body.json",
    want: "deny",
    code: "GITHUB_API_VIA_HTTP_CLIENT",
  },
];

/** What each `--agent` answers with: whether it can ask, the exit code of a block, and how to read its stdout. */
interface HostFacts {
  hasAsk: boolean;
  /** Exit code of a deny: 2 where exit 2 blocks, 0 where the deny is on stdout. */
  denyExit: number;
  /** The decision on stdout; "allow" for what an allow prints. */
  read(stdout: string): Decision;
}

function readFamily(stdout: string): Decision {
  if (stdout === "") return "allow";
  const out = JSON.parse(stdout) as { hookSpecificOutput: { hookEventName: string; permissionDecision: Decision } };
  assert.equal(out.hookSpecificOutput.hookEventName, "PreToolUse");
  return out.hookSpecificOutput.permissionDecision;
}

const HOSTS: Readonly<Record<string, HostFacts>> = {
  claude: { hasAsk: true, denyExit: 2, read: readFamily },
  codex: { hasAsk: false, denyExit: 2, read: readFamily },
  gemini: { hasAsk: false, denyExit: 2, read: readFamily },
  copilot: {
    hasAsk: true,
    denyExit: 2,
    read: stdout => {
      if (stdout === "") return "allow";
      const out = JSON.parse(stdout) as { permissionDecision: Decision; hookSpecificOutput: { permissionDecision: Decision } };
      assert.equal(out.hookSpecificOutput.permissionDecision, out.permissionDecision, "both places carry the same decision");
      return out.permissionDecision;
    },
  },
  cursor: { hasAsk: true, denyExit: 0, read: stdout => (JSON.parse(stdout) as { permission: Decision }).permission },
  antigravity: { hasAsk: false, denyExit: 0, read: stdout => (JSON.parse(stdout) as { decision: Decision }).decision },
};

/** The one stderr line a payload that was not judged prints (fixed text, no payload bytes). */
const NOT_JUDGED = /^repo-aegis: guard-egress: this payload was not judged \([^)]+\); check that the hook is registered with the right --agent and event\n$/;

/** Fixtures that are NOT judged by design: Cursor's `preToolUse` (its `ask` is not enforced there). */
const FIXTURES_NOT_JUDGED = new Set(["cursor.pre-tool-use.json"]);

const MALFORMED: ReadonlyArray<readonly [label: string, input: string]> = [
  ["empty stdin", ""],
  ["not JSON", "this is not json"],
  ["truncated JSON", '{"tool_name": "Bash", "tool_input": {"command": "git pu'],
  ["JSON array", "[1,2,3]"],
  ["JSON string", '"git push"'],
];

const SUBPROCESS_TESTS_AVAILABLE = cliBuilt();

let restoreGitEnv: () => void;
let tmp: string;
let home: string;
let repo: string;

before(() => {
  restoreGitEnv = scrubGitEnv();
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "repo-aegis-guard-hosts-test-")));
  home = join(tmp, "aegis");
  mkdirSync(join(home, "markers"), { recursive: true });
  mkdirSync(join(home, "state"), { recursive: true });
  writeFileSync(join(home, "engagements.yaml"), "schemaVersion: 2\nengagements: []\n");
  repo = join(tmp, "repo");
  mkdirSync(join(repo, "sub"), { recursive: true });
  execFileSync("git", ["init", "-q", "--initial-branch=main", repo], { stdio: "ignore" });
  execFileSync("git", ["-C", repo, "config", "remote.origin.url", "git@github.com:acme/svc.git"], { stdio: "ignore" });
  execFileSync("git", ["-C", repo, "config", "repo-aegis.class", "public-eligible"], { stdio: "ignore" });
});

after(() => {
  restoreGitEnv();
  rmSync(tmp, { recursive: true, force: true });
  assertGoldenComplete(SUITE);
});

interface Run {
  stdout: string;
  stderr: string;
  code: number | null;
}

function run(input: string, agent: string, label: string): Run {
  const env: NodeJS.ProcessEnv = { ...process.env, REPO_AEGIS_HOME: home, REPO_AEGIS_VISIBILITY_LOOKUP: "0" };
  delete env["REPO_AEGIS_EGRESS_HUMAN"];
  delete env["REPO_AEGIS_ASSUME_PUBLIC"];
  const r = spawnSync(process.execPath, [cliPath, "hook", "guard-egress", "--agent", agent], {
    cwd: tmp,
    env,
    encoding: "utf8",
    input,
  });
  const result = { stdout: r.stdout, stderr: r.stderr, code: r.status };
  golden(SUITE, { label, agent, input }, result, [tmp]);
  return result;
}

/** Everything the hook may print must be free of a rewritten command (invariant 1). */
function assertDecisionOnly(r: Run, label: string): void {
  for (const channel of [r.stdout, r.stderr]) {
    assert.doesNotMatch(channel, /updatedInput|updated_input|modifiedArgs|overwrite|tool_input/, `${label}: decision-only`);
  }
}

/**
 * What an allowed (or fail-open) command prints, per `--agent`. Empty where the host takes empty stdout as
 * "proceed"; otherwise the host's minimal allow (plan §5.2 rule 6): Cursor blocks on invalid output and
 * Antigravity requires a `decision`.
 */
const ALLOW_STDOUT: Readonly<Record<string, string>> = {
  cursor: '{"permission":"allow"}\n',
  antigravity: '{"decision":"allow"}\n',
};
const allowStdout = (agent: string): string => ALLOW_STDOUT[agent] ?? "";

describe("hook guard-egress — host fixtures", { skip: !SUBPROCESS_TESTS_AVAILABLE }, () => {
  const fixtures = loadFixtureIndex();

  it("the fixture index lists every fixture file and each parses as JSON", () => {
    assert.ok(fixtures.length >= 9);
    for (const f of fixtures) {
      assert.match(f.provenance, /^(observed|doc-derived)$/, f.file);
      JSON.parse(readFileSync(join(HOST_FIXTURES_DIR, f.file), "utf8"));
    }
  });

  for (const f of fixtures) {
    const payload = loadFixture(f);

    const judged = !FIXTURES_NOT_JUDGED.has(f.file);
    const host = HOSTS[f.agent]!;

    it(`${f.file}: the fixture as captured ${judged ? "is silent (exit 0, only the host's allow)" : "is not judged: the host's allow, and one line saying so"}`, () => {
      const r = run(JSON.stringify(payload).split(FIXTURE_CWD).join(repo), f.agent, "as-captured");
      assert.equal(r.code, 0, r.stderr);
      assert.equal(r.stdout, allowStdout(f.agent));
      if (judged) assert.equal(r.stderr, "");
      else assert.match(r.stderr, NOT_JUDGED);
    });

    if (f.commandPath === null) continue;
    for (const probe of PROBES) {
      it(`${f.file}: ${probe.label}`, () => {
        const input = JSON.stringify(withCommand(payload, f.commandPath!, probe.command)).split(FIXTURE_CWD).join(repo);
        const r = run(input, f.agent, probe.label);
        assertDecisionOnly(r, `${f.file} ${probe.label}`);
        const where = `${f.file} ${probe.label}\nstdout=${r.stdout}\nstderr=${r.stderr}`;

        if (!judged) {
          // Fails open on every probe, saying once that nothing was judged: never a deny, never silent.
          assert.equal(r.code, 0, where);
          assert.equal(r.stdout, allowStdout(f.agent), where);
          assert.match(r.stderr, NOT_JUDGED, where);
          return;
        }

        if (probe.want === "allow") {
          assert.equal(r.code, 0, where);
          assert.equal(r.stdout, allowStdout(f.agent), `cheap and silent on non-egress (invariant 2)\n${where}`);
          assert.equal(r.stderr, "", where);
          return;
        }

        // A decision that stops or asks: the exact exit code and the decision in THIS host's shape.
        const want: Decision = probe.want === "ask-or-deny" ? (host.hasAsk ? "ask" : "deny") : probe.want;
        assert.equal(host.read(r.stdout), want, where);
        assert.equal(r.code, want === "deny" ? host.denyExit : 0, where);
        if (want === "deny") assert.match(r.stderr, new RegExp(`"code": "${probe.code}"`), where);
      });
    }
  }

  for (const agent of ["claude", "codex", "gemini", "cursor", "copilot", "antigravity"]) {
    for (const [label, input] of MALFORMED) {
      it(`--agent ${agent}: ${label} fails open (the host's allow) and says once that nothing was judged`, () => {
        const r = run(input, agent, `malformed: ${label}`);
        assert.equal(r.code, 0);
        assert.equal(r.stdout, allowStdout(agent));
        assert.match(r.stderr, NOT_JUDGED);
      });
    }
  }

  // Skip stays silent; misconfiguration does not. The wrong --agent for a payload names a shell command.
  const BASH = { tool_name: "Bash", tool_input: { command: "git push" }, cwd: "/w" };
  const AGY = { toolCall: { name: "run_command", args: { CommandLine: "git push" } } };
  const CURSOR_PRE = { hook_event_name: "preToolUse", tool_name: "Shell", tool_input: { command: "git push" }, cwd: "/w" };
  const COPILOT_CAMEL = { toolName: "bash", toolArgs: '{"command":"git push"}', cwd: "/w" };
  const MISROUTED: ReadonlyArray<readonly [label: string, agent: string, payload: unknown]> = [
    ["a Claude-shaped payload under --agent antigravity", "antigravity", BASH],
    ["an Antigravity payload under --agent claude", "claude", AGY],
    ["an Antigravity payload under --agent gemini", "gemini", AGY],
    ["a Copilot camelCase payload under --agent codex", "codex", COPILOT_CAMEL],
    ["a Cursor preToolUse payload under --agent cursor", "cursor", CURSOR_PRE],
    ["a Claude-shaped payload under --agent cursor", "cursor", BASH],
    ["an Antigravity payload under --agent copilot", "copilot", AGY],
  ];
  for (const [label, agent, payload] of MISROUTED) {
    it(`${label}: not judged, fails open, says so`, () => {
      const r = run(JSON.stringify(payload), agent, `misrouted: ${label}`);
      assert.equal(r.code, 0);
      assert.equal(r.stdout, allowStdout(agent));
      assert.match(r.stderr, NOT_JUDGED);
    });
  }

  it("a payload for a non-shell tool stays silent on every host", () => {
    const NON_SHELL: ReadonlyArray<readonly [string, unknown]> = [
      ["claude", { tool_name: "Write", tool_input: { file_path: "/x", content: "y" } }],
      ["codex", { tool_name: "apply_patch", tool_input: { command: "git push" } }],
      ["gemini", { tool_name: "read_file", tool_input: { absolute_path: "/x" } }],
      ["copilot", { toolName: "edit", toolArgs: '{"path":"/x"}' }],
      ["cursor", { hook_event_name: "preToolUse", tool_name: "Write", tool_input: { file_path: "/x" } }],
      ["antigravity", { toolCall: { name: "view_file", args: { AbsolutePath: "/x" } } }],
    ];
    for (const [agent, payload] of NON_SHELL) {
      const r = run(JSON.stringify(payload), agent, `non-shell: ${agent}`);
      assert.equal(r.code, 0, agent);
      assert.equal(r.stdout, allowStdout(agent), agent);
      assert.equal(r.stderr, "", agent);
    }
  });

  it("interactive shell-input tools are judged: a push typed into an open session is denied", () => {
    const cases: ReadonlyArray<readonly [agent: string, payload: unknown]> = [
      ["copilot", { sessionId: "s", cwd: repo, toolName: "write_bash", toolArgs: JSON.stringify({ input: "git push\n" }) }],
      ["copilot", { sessionId: "s", cwd: repo, toolName: "write_powershell", toolArgs: JSON.stringify({ input: "git push\n" }) }],
      ["antigravity", { toolCall: { name: "send_command_input", args: { Input: "git push\n", Cwd: repo } } }],
    ];
    for (const [agent, payload] of cases) {
      const r = run(JSON.stringify(payload), agent, `input tool: ${agent}`);
      const host = HOSTS[agent]!;
      assert.equal(host.read(r.stdout), "deny", `${agent}\n${r.stdout}${r.stderr}`);
      assert.equal(r.code, host.denyExit, agent);
      assert.match(r.stderr, /"code": "PUSH_IMPLICIT_TARGET"/, agent);
    }
  });

  it("an unknown --agent name is judged in whatever known shape arrives, answered as a host without ask", () => {
    for (const payload of [BASH, AGY, COPILOT_CAMEL, { command: "git push" }]) {
      const r = run(JSON.stringify(payload), "not-a-host", "unknown agent");
      assert.equal(readFamily(r.stdout), "deny", r.stdout + r.stderr);
      assert.equal(r.code, 2);
    }
  });

  it("with the audit log on, a payload that was not judged writes a `guard-egress-malformed` record with fixed text only", () => {
    const log = auditLogPath(home);
    writeFileSync(join(home, "state", "audit-log.json"), JSON.stringify({ enabled: true }));
    try {
      const secret = "customer-a-payload-text";
      const r = run(JSON.stringify({ tool_name: "Bash", tool_input: { note: secret } }), "claude", "audit");
      assert.equal(r.code, 0);
      assert.match(r.stderr, NOT_JUDGED);
      const lines = readFileSync(log, "utf8").trim().split("\n");
      const rec = JSON.parse(lines[lines.length - 1]!) as { action: string; details: { agent: string; reason: string } };
      assert.equal(rec.action, "guard-egress-malformed");
      assert.equal(rec.details.agent, "claude");
      assert.ok(rec.details.reason.length > 0);
      assert.ok(!lines.join("\n").includes(secret), "no payload bytes in the audit log");
      // A silent skip writes nothing.
      const before = readFileSync(log, "utf8");
      run(JSON.stringify({ tool_name: "Write", tool_input: {} }), "claude", "audit-skip");
      assert.equal(readFileSync(log, "utf8"), before);
    } finally {
      rmSync(join(home, "state", "audit-log.json"), { force: true });
    }
  });

  it("--agent is case-insensitive: Antigravity answers in its own shape", () => {
    const r = run(JSON.stringify(AGY), "Antigravity", "case");
    assert.equal(HOSTS["antigravity"]!.read(r.stdout), "deny");
    assert.equal(r.code, 0);
  });
});
