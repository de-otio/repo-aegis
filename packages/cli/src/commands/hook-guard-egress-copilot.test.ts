// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// Subprocess tests of `hook guard-egress --agent copilot` and `--agent codex`
// (plan T1c, T1f). Two jobs:
//
//   1. Regression for the gap Phase 0 found: a Copilot camelCase payload
//      carries its command in `toolArgs`, a JSON-encoded string. The hook
//      used to look only at `tool_input.command` and a root `command`, find
//      neither, and silently ALLOW `git push`. It is now judged.
//   2. Property (seeded random): any generated command with no publishing
//      operation is allowed silently (exit 0, empty stdout and stderr) on
//      every payload shape of these hosts, and nothing denies it.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scrubGitEnv } from "../_test-utils.js";
import { cliBuilt, cliPath } from "../_subprocess-utils.js";

const SUBPROCESS_TESTS_AVAILABLE = cliBuilt();

let restoreGitEnv: () => void;
let tmp: string;
let home: string;
let repo: string;

before(() => {
  restoreGitEnv = scrubGitEnv();
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "repo-aegis-guard-copilot-test-")));
  home = join(tmp, "aegis");
  mkdirSync(join(home, "markers"), { recursive: true });
  mkdirSync(join(home, "state"), { recursive: true });
  writeFileSync(join(home, "engagements.yaml"), "schemaVersion: 2\nengagements: []\n");
  repo = join(tmp, "repo");
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-q", "--initial-branch=main", repo], { stdio: "ignore" });
  execFileSync("git", ["-C", repo, "config", "remote.origin.url", "git@github.com:acme/svc.git"], { stdio: "ignore" });
  execFileSync("git", ["-C", repo, "config", "repo-aegis.class", "public-eligible"], { stdio: "ignore" });
});

after(() => {
  restoreGitEnv();
  rmSync(tmp, { recursive: true, force: true });
});

interface Run {
  stdout: string;
  stderr: string;
  code: number | null;
}

function run(input: string, agent: string): Run {
  const env: NodeJS.ProcessEnv = { ...process.env, REPO_AEGIS_HOME: home, REPO_AEGIS_VISIBILITY_LOOKUP: "0" };
  delete env["REPO_AEGIS_EGRESS_HUMAN"];
  delete env["REPO_AEGIS_ASSUME_PUBLIC"];
  const r = spawnSync(process.execPath, [cliPath, "hook", "guard-egress", "--agent", agent], {
    cwd: tmp,
    env,
    encoding: "utf8",
    input,
  });
  return { stdout: r.stdout, stderr: r.stderr, code: r.status };
}

/** The three payload shapes of these hosts, each carrying `command`. */
const shapes = (command: string): ReadonlyArray<readonly [shape: string, agent: string, payload: string]> => [
  ["copilot camelCase preToolUse", "copilot", JSON.stringify({ sessionId: "s", timestamp: 1, cwd: repo, toolName: "bash", toolArgs: JSON.stringify({ command }) })],
  ["copilot PascalCase PreToolUse", "copilot", JSON.stringify({ hook_event_name: "PreToolUse", cwd: repo, tool_name: "Bash", tool_input: { command } })],
  ["codex PreToolUse", "codex", JSON.stringify({ hook_event_name: "PreToolUse", cwd: repo, tool_name: "Bash", tool_input: { command } })],
];

describe("hook guard-egress --agent copilot — regression: toolArgs payloads are judged", { skip: !SUBPROCESS_TESTS_AVAILABLE }, () => {
  it("a bare `git push` in a camelCase payload is denied (it was silently allowed before T1c)", () => {
    const [, agent, payload] = shapes("git push")[0]!;
    const r = run(payload, agent);
    assert.equal(r.code, 2, `stdout=${r.stdout} stderr=${r.stderr}`);
    const out = JSON.parse(r.stdout) as Record<string, unknown>;
    assert.deepEqual(Object.keys(out).sort(), ["permissionDecision", "permissionDecisionReason"]);
    assert.equal(out["permissionDecision"], "deny");
    assert.match(String(out["permissionDecisionReason"]), /git push/);
    assert.match(r.stderr, /PUSH_[A-Z_]+/);
    assert.doesNotMatch(r.stdout + r.stderr, /modifiedArgs|updatedInput|toolArgs/);
  });

  it("the same command is denied on every shape these hosts send", () => {
    for (const [shape, agent, payload] of shapes("cd sub && git push origin main")) {
      const r = run(payload, agent);
      assert.equal(r.code, 2, `${shape}: ${r.stdout}${r.stderr}`);
      assert.match(r.stdout, /deny/, shape);
    }
  });

  it("a push to a public destination is never allowed silently: copilot asks (or denies), codex denies", () => {
    const [, agent, payload] = shapes("git push origin main")[0]!;
    const r = run(payload, agent);
    assert.notEqual(r.stdout, "", "a silent allow would be the pre-T1c hole");
    const decision = (JSON.parse(r.stdout) as { permissionDecision: string }).permissionDecision;
    assert.ok(decision === "ask" || decision === "deny", decision);
    assert.equal(r.code, decision === "deny" ? 2 : 0);

    const [, codexAgent, codexPayload] = shapes("git push origin main")[2]!;
    const c = run(codexPayload, codexAgent);
    assert.equal(c.code, 2, "codex has no ask: ask degrades to deny");
    assert.match(c.stdout, /"permissionDecision":"deny"/);
  });

  it("a raw GitHub API write in toolArgs is refused too (the any-command rules read the same field)", () => {
    const [, agent, payload] = shapes("curl -X POST https://api.github.com/repos/acme/svc/issues -d @body.json")[0]!;
    const r = run(payload, agent);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /GITHUB_API_VIA_HTTP_CLIENT/);
  });

  it("a non-shell tool and unusable payloads still fail open, silently", () => {
    const edit = JSON.stringify({ sessionId: "s", cwd: repo, toolName: "edit", toolArgs: JSON.stringify({ command: "git push" }) });
    for (const input of [edit, "", "not json", '{"toolName":"bash","toolArgs":"not json"}', '{"toolName":"bash","toolArgs":[1]}']) {
      const r = run(input, "copilot");
      assert.deepEqual(r, { stdout: "", stderr: "", code: 0 }, input);
    }
  });
});

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

const PROGRAMS = ["ls", "echo", "cat", "grep -rn", "git status", "git log --oneline", "git diff", "git add -A", "git commit -m 'wip'", "npm test", "node -v", "make build", "pwd", "wc -l", "sort"];
const ARGS = ["a.txt", "src/", "-la", '"hello world"', "'x y'", "$HOME", "./scripts/build.sh", "--flag=1", "2>&1", "*.ts", "README.md"];
const JOINERS = [" && ", " ; ", " | ", " || ", "\n"];

/** A command line with no publishing operation: a few simple commands, joined. */
function randomNonEgressCommand(rng: () => number): string {
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rng() * xs.length)]!;
  const parts: string[] = [];
  for (let i = 0, n = 1 + Math.floor(rng() * 3); i < n; i++) {
    const args: string[] = [];
    for (let j = 0, m = Math.floor(rng() * 3); j < m; j++) args.push(pick(ARGS));
    parts.push([pick(PROGRAMS), ...args].join(" "));
  }
  return parts.reduce((acc, p) => (acc === "" ? p : acc + pick(JOINERS) + p), "");
}

describe("hook guard-egress — property: a non-egress command is allowed silently (copilot, codex)", { skip: !SUBPROCESS_TESTS_AVAILABLE }, () => {
  it("30 seeded random commands × 3 payload shapes: exit 0, no stdout, no stderr", () => {
    const rng = mulberry32(0x1c0f);
    for (let i = 0; i < 30; i++) {
      const command = randomNonEgressCommand(rng);
      for (const [shape, agent, payload] of shapes(command)) {
        const r = run(payload, agent);
        assert.deepEqual(r, { stdout: "", stderr: "", code: 0 }, `${shape}: ${JSON.stringify(command)}`);
      }
    }
  });
});
