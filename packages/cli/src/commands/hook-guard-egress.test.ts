// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// Subprocess tests for `repo-aegis hook guard-egress`. Subprocess rather
// than in-process because the whole contract IS the process contract: the
// exit code, which stream the reason lands on, and the absence of anything
// resembling a rewritten command in what the hook prints.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cliBuilt, cliPath } from "../_subprocess-utils.js";
import { approvalsPath, mintApproval, revokeApprovals } from "@de-otio/repo-aegis-core";

let tmp: string;

before(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "repo-aegis-guard-egress-test-")));
});

after(() => {
  rmSync(tmp, { recursive: true, force: true });
});

interface GuardResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

interface GuardOptions {
  home: string;
  cwd?: string;
  /** Set `REPO_AEGIS_EGRESS_HUMAN=1` for this invocation (the documented human-only escape). */
  human?: boolean;
  agent?: string;
}

/**
 * Run the hook as the agent would. The environment is scrubbed of the two
 * variables that would otherwise let a developer's shell change the
 * verdict: the human-presence escape and the CI "assume public" assertion.
 * Tests must never depend on the developer's environment (CONTRIBUTING.md).
 */
function runGuard(input: string, opts: GuardOptions): GuardResult {
  const env: NodeJS.ProcessEnv = { ...process.env, REPO_AEGIS_HOME: opts.home };
  delete env["REPO_AEGIS_EGRESS_HUMAN"];
  delete env["REPO_AEGIS_ASSUME_PUBLIC"];
  if (opts.human) env["REPO_AEGIS_EGRESS_HUMAN"] = "1";
  const args = ["hook", "guard-egress", ...(opts.agent ? ["--agent", opts.agent] : [])];
  const r = spawnSync(process.execPath, [cliPath, ...args], {
    cwd: opts.cwd ?? tmp,
    env,
    encoding: "utf8",
    input,
  });
  return { stdout: r.stdout, stderr: r.stderr, code: r.status };
}

function aegisHome(name: string, registry?: string): string {
  const dir = join(tmp, `${name}-aegis`);
  mkdirSync(join(dir, "markers"), { recursive: true });
  mkdirSync(join(dir, "state"), { recursive: true });
  if (registry !== undefined) writeFileSync(join(dir, "engagements.yaml"), registry);
  return dir;
}

const EMPTY_REGISTRY = "schemaVersion: 2\nengagements: []\n";

function makeRepo(name: string, opts: { remote?: string; class?: string } = {}): string {
  const dir = join(tmp, name);
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q", "--initial-branch=main", dir], { stdio: "ignore" });
  if (opts.remote) {
    execFileSync("git", ["-C", dir, "config", "remote.origin.url", opts.remote], { stdio: "ignore" });
  }
  if (opts.class) {
    execFileSync("git", ["-C", dir, "config", "repo-aegis.class", opts.class], { stdio: "ignore" });
  }
  return dir;
}

/** Claude Code PreToolUse payload. */
function claudePayload(command: string, cwd?: string): string {
  return JSON.stringify({
    session_id: "test",
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command, description: "a command" },
    ...(cwd !== undefined && { cwd }),
  });
}

/** Codex CLI PreToolUse payload: same field, different tool name. */
function codexPayload(command: string, cwd?: string): string {
  return JSON.stringify({
    tool_name: "shell",
    tool_input: { command },
    ...(cwd !== undefined && { cwd }),
  });
}

/** Gemini CLI BeforeTool payload: matcher `run_shell_command`. */
function geminiPayload(command: string, cwd?: string): string {
  return JSON.stringify({
    hook_event_name: "BeforeTool",
    tool_name: "run_shell_command",
    tool_input: { command },
    ...(cwd !== undefined && { cwd }),
  });
}

interface DenyPayload {
  code: string;
  error: string;
  details: {
    verb: string;
    destination?: { org: string; repo: string; visibility: string; class: string };
    registry?: string;
  };
}

interface DecisionJson {
  hookSpecificOutput: {
    hookEventName: string;
    permissionDecision: string;
    permissionDecisionReason: string;
  };
}

const SUBPROCESS_TESTS_AVAILABLE = cliBuilt();

describe("hook guard-egress — silent on everything that is not egress", { skip: !SUBPROCESS_TESTS_AVAILABLE }, () => {
  it("exits 0 with no output on a command with no publishing operation", () => {
    const home = aegisHome("quiet", EMPTY_REGISTRY);
    const r = runGuard(claudePayload("ls -la && npm run build"), { home });
    assert.equal(r.code, 0);
    assert.equal(r.stdout, "");
    assert.equal(r.stderr, "");
  });

  it("exits 0 on garbage stdin", () => {
    const home = aegisHome("garbage", EMPTY_REGISTRY);
    const r = runGuard("this is not json {{{", { home });
    assert.equal(r.code, 0);
    assert.equal(r.stdout, "");
    assert.equal(r.stderr, "");
  });

  it("exits 0 on empty stdin", () => {
    const home = aegisHome("empty", EMPTY_REGISTRY);
    const r = runGuard("", { home });
    assert.equal(r.code, 0);
    assert.equal(r.stdout, "");
  });

  it("exits 0 when the tool is not a shell tool, even if the payload mentions a push", () => {
    // A Write of a file whose content happens to contain `git push` must
    // not be judged as egress; only shell tools carry commands.
    const home = aegisHome("not-bash", EMPTY_REGISTRY);
    const r = runGuard(
      JSON.stringify({ tool_name: "Write", tool_input: { command: "git push" } }),
      { home },
    );
    assert.equal(r.code, 0);
    assert.equal(r.stdout, "");
    assert.equal(r.stderr, "");
  });

  it("exits 0 when there is no command field at all", () => {
    const home = aegisHome("no-command", EMPTY_REGISTRY);
    const r = runGuard(JSON.stringify({ tool_name: "Bash", tool_input: {} }), { home });
    assert.equal(r.code, 0);
    assert.equal(r.stdout, "");
  });
});

describe("hook guard-egress — payload shapes across agents", { skip: !SUBPROCESS_TESTS_AVAILABLE }, () => {
  const bare = "git push";

  it("reads tool_input.command from a Claude Code payload", () => {
    const home = aegisHome("shape-claude", EMPTY_REGISTRY);
    const r = runGuard(claudePayload(bare), { home });
    assert.equal(r.code, 2);
    assert.equal((JSON.parse(r.stderr) as DenyPayload).code, "PUSH_IMPLICIT_TARGET");
  });

  it("reads tool_input.command from a Codex CLI payload", () => {
    const home = aegisHome("shape-codex", EMPTY_REGISTRY);
    const r = runGuard(codexPayload(bare), { home, agent: "codex" });
    assert.equal(r.code, 2);
    assert.equal((JSON.parse(r.stderr) as DenyPayload).code, "PUSH_IMPLICIT_TARGET");
  });

  it("reads tool_input.command from a Gemini CLI payload", () => {
    const home = aegisHome("shape-gemini", EMPTY_REGISTRY);
    const r = runGuard(geminiPayload(bare), { home, agent: "gemini" });
    assert.equal(r.code, 2);
    assert.equal((JSON.parse(r.stderr) as DenyPayload).code, "PUSH_IMPLICIT_TARGET");
  });

  it("falls back to a root-level command field", () => {
    const home = aegisHome("shape-root", EMPTY_REGISTRY);
    const r = runGuard(JSON.stringify({ command: bare }), { home });
    assert.equal(r.code, 2);
    assert.equal((JSON.parse(r.stderr) as DenyPayload).code, "PUSH_IMPLICIT_TARGET");
  });

  it("flattens an argv-style command to the script it would run", () => {
    // Harnesses that exec directly rather than through a shell send
    // `["bash", "-lc", "<script>"]`; the script is the part to judge.
    const home = aegisHome("shape-argv", EMPTY_REGISTRY);
    const r = runGuard(
      JSON.stringify({ tool_name: "shell", tool_input: { command: ["bash", "-lc", bare] } }),
      { home, agent: "codex" },
    );
    assert.equal(r.code, 2);
    assert.equal((JSON.parse(r.stderr) as DenyPayload).code, "PUSH_IMPLICIT_TARGET");
  });
});

describe("hook guard-egress — the two incident commands, genericised", { skip: !SUBPROCESS_TESTS_AVAILABLE }, () => {
  it("refuses the bare push at the tail of a `;`-chained command", () => {
    // The second incident: a leading `cd` that did not take effect, and a
    // bare `git push` at the end of a chain whose prerequisites could
    // fail independently. Three shape rules match; the earliest one
    // (a bare push with no explicit target) is the reported code.
    const home = aegisHome("incident-push", EMPTY_REGISTRY);
    const command =
      "cd /x && python3 regen.py ; git add -A && git commit -m x ; git push";
    const r = runGuard(claudePayload(command), { home });
    assert.equal(r.code, 2);
    const payload = JSON.parse(r.stderr) as DenyPayload;
    assert.equal(payload.code, "PUSH_IMPLICIT_TARGET");
    assert.equal(payload.details.verb, "git push");
    assert.match(payload.error, /git push <remote> <branch>/);
  });

  it("refuses a payload file under $TMPDIR", () => {
    // The first incident: `$TMPDIR` resolves to two different directories
    // depending on whether the shell is sandboxed, and a stale body file
    // of the same name from another session is read silently.
    const home = aegisHome("incident-body", EMPTY_REGISTRY);
    const command =
      'gh pr create --title x --body-file "$TMPDIR/pr-body.md" --repo acme/svc';
    const r = runGuard(claudePayload(command), { home });
    assert.equal(r.code, 2);
    const payload = JSON.parse(r.stderr) as DenyPayload;
    assert.equal(payload.code, "PAYLOAD_MODE_DEPENDENT_PATH");
    assert.equal(payload.details.verb, "gh pr create");
    // The basename may be named; the directory it came from must not be
    // presented as usable, and the scratchpad is the offered alternative.
    assert.match(payload.error, /session scratchpad/);
  });

  it("still refuses the shape rules with no registry file on disk", () => {
    // Shape rules are unconditional: they need no registry, no class and
    // no cached visibility. A fresh machine is exactly where the guard
    // matters most, so it must not be inert there.
    const home = join(tmp, "no-registry-home");
    mkdirSync(home, { recursive: true });
    const r = runGuard(claudePayload("git push"), { home });
    assert.equal(r.code, 2);
    assert.equal((JSON.parse(r.stderr) as DenyPayload).code, "PUSH_IMPLICIT_TARGET");
  });

  it("refuses an egress verb that follows a `cd` in the same command", () => {
    const home = aegisHome("after-cd", EMPTY_REGISTRY);
    const r = runGuard(claudePayload("cd /x && gh pr merge 7 --repo acme/svc"), { home });
    assert.equal(r.code, 2);
    const payload = JSON.parse(r.stderr) as DenyPayload;
    assert.equal(payload.code, "EGRESS_AFTER_CD");
    assert.match(payload.error, /git -C <abs-path>/);
  });

  it("refuses an egress verb joined to its prerequisite by `;`", () => {
    const home = aegisHome("chain", EMPTY_REGISTRY);
    const r = runGuard(claudePayload("npm run build ; npm publish"), { home });
    assert.equal(r.code, 2);
    assert.equal((JSON.parse(r.stderr) as DenyPayload).code, "EGRESS_UNGUARDED_CHAIN");
  });
});

describe("hook guard-egress — public destination needs a human", { skip: !SUBPROCESS_TESTS_AVAILABLE }, () => {
  let repo: string;
  let home: string;

  before(() => {
    home = aegisHome("public", EMPTY_REGISTRY);
    repo = makeRepo("public-repo", {
      remote: "git@github.com:acme/svc.git",
      class: "public-eligible",
    });
  });

  it("asks on Claude Code, which has an ask", () => {
    const r = runGuard(claudePayload("git push origin main", repo), { home, cwd: repo });
    assert.equal(r.code, 0, `expected ask (exit 0); got ${r.code} ${r.stderr}`);
    assert.equal(r.stderr, "", "an ask is not an error; nothing belongs on stderr");
    const j = JSON.parse(r.stdout) as DecisionJson;
    assert.equal(j.hookSpecificOutput.hookEventName, "PreToolUse");
    assert.equal(j.hookSpecificOutput.permissionDecision, "ask");
    assert.match(j.hookSpecificOutput.permissionDecisionReason, /PUBLIC destination/);
    assert.match(j.hookSpecificOutput.permissionDecisionReason, /acme\/svc/);
  });

  it("denies on Codex, where ask degrades to deny rather than to allow", () => {
    const r = runGuard(codexPayload("git push origin main", repo), {
      home,
      cwd: repo,
      agent: "codex",
    });
    assert.equal(r.code, 2, `expected deny; got ${r.code} ${r.stdout}`);
    const payload = JSON.parse(r.stderr) as DenyPayload;
    assert.equal(payload.code, "PUBLIC_EGRESS_NEEDS_HUMAN");
    assert.equal(payload.details.destination?.org, "acme");
    assert.equal(payload.details.destination?.repo, "svc");
    assert.equal(payload.details.destination?.class, "public-eligible");
    // The recovery is a person, never the agent setting the variable.
    assert.match(payload.error, /re-run it from a terminal/);
    assert.match(payload.error, /an agent never sets it/);
  });

  it("denies on Gemini too", () => {
    const r = runGuard(geminiPayload("git push origin main", repo), {
      home,
      cwd: repo,
      agent: "gemini",
    });
    assert.equal(r.code, 2);
    assert.equal((JSON.parse(r.stderr) as DenyPayload).code, "PUBLIC_EGRESS_NEEDS_HUMAN");
  });

  it("allows when a human has declared themselves present", () => {
    const r = runGuard(claudePayload("git push origin main", repo), {
      home,
      cwd: repo,
      human: true,
    });
    assert.equal(r.code, 0, `expected allow; got ${r.code} ${r.stderr}`);
    assert.equal(r.stdout, "", "an allow is silent");
    assert.equal(r.stderr, "");
  });

  it("allows on a live human approval for the destination, saying so on the JSON channel, and records the use", () => {
    const approvalsHome = aegisHome("approved", EMPTY_REGISTRY);
    writeFileSync(join(approvalsHome, "state", "audit-log.json"), JSON.stringify({ enabled: true }));
    const a = mintApproval({ target: { org: "acme", repo: "svc" }, path: approvalsPath(approvalsHome), by: "op" });
    const r = runGuard(claudePayload("git push origin main", repo), { home: approvalsHome, cwd: repo });
    assert.equal(r.code, 0, `expected allow; got ${r.code} ${r.stderr}`);
    const j = JSON.parse(r.stdout) as DecisionJson;
    assert.equal(j.hookSpecificOutput.permissionDecision, "allow");
    assert.match(j.hookSpecificOutput.permissionDecisionReason, new RegExp(`human approval ${a.id}`));
    assert.match(j.hookSpecificOutput.permissionDecisionReason, /acme\/svc/);
    // Audit trail: the use is recorded with the id and the layer.
    const log = readFileSync(join(approvalsHome, "state", "audit.log"), "utf8");
    assert.match(log, /"egress-approval-use"/);
    assert.match(log, new RegExp(`"id":"${a.id}"`));
    assert.match(log, /"layer":"hook guard-egress"/);
    // A ref-scoped approval for another branch does not cover this push.
    revokeApprovals("all", approvalsPath(approvalsHome));
    mintApproval({ target: { org: "acme", repo: "svc" }, ref: "release", path: approvalsPath(approvalsHome) });
    const r2 = runGuard(claudePayload("git push origin main", repo), { home: approvalsHome, cwd: repo });
    assert.equal((JSON.parse(r2.stdout) as DecisionJson).hookSpecificOutput.permissionDecision, "ask");
    // An expired one neither.
    revokeApprovals("all", approvalsPath(approvalsHome));
    mintApproval({ target: { org: "acme", repo: "svc" }, ttlMs: 1, path: approvalsPath(approvalsHome), now: new Date(Date.now() - 60_000) });
    const r3 = runGuard(claudePayload("git push origin main", repo), { home: approvalsHome, cwd: repo });
    assert.equal((JSON.parse(r3.stdout) as DecisionJson).hookSpecificOutput.permissionDecision, "ask");
  });

  it("an approval does not launder a shape violation", () => {
    const approvalsHome = aegisHome("approved-shape", EMPTY_REGISTRY);
    mintApproval({ target: { org: "*", repo: "*" }, path: approvalsPath(approvalsHome) });
    const r = runGuard(claudePayload("cd /elsewhere && git push origin main", repo), { home: approvalsHome, cwd: repo });
    assert.equal(r.code, 2);
    assert.equal((JSON.parse(r.stderr) as DenyPayload).code, "EGRESS_AFTER_CD");
  });

  it("allows an explicit push to a non-public destination with no human", () => {
    const privateRepo = makeRepo("private-repo", {
      remote: "git@github.com:acme/internal.git",
      class: "private-strict",
    });
    const r = runGuard(claudePayload("git push origin main", privateRepo), {
      home,
      cwd: privateRepo,
    });
    assert.equal(r.code, 0, `expected allow; got ${r.code} ${r.stderr}`);
    assert.equal(r.stdout, "");
  });

  it("reads the cwd from the payload, not from where the hook was spawned", () => {
    // Same reason as `hook check-write`: the hook process is spawned in
    // whatever directory the agent happened to be in. The command will run
    // in the payload's cwd, and that is where the destination lives.
    const elsewhere = makeRepo("spawn-elsewhere", {
      remote: "git@github.com:acme/internal.git",
      class: "private-strict",
    });
    const r = runGuard(claudePayload("git push origin main", repo), {
      home,
      cwd: elsewhere,
    });
    assert.equal(r.code, 0);
    const j = JSON.parse(r.stdout) as DecisionJson;
    assert.equal(j.hookSpecificOutput.permissionDecision, "ask");
    assert.match(j.hookSpecificOutput.permissionDecisionReason, /acme\/svc/);
  });
});

describe("hook guard-egress — output channels", { skip: !SUBPROCESS_TESTS_AVAILABLE }, () => {
  it("puts the deny reason on stderr AND the decision JSON on stdout", () => {
    // stderr is what these frameworks feed back to the model on a non-zero
    // exit (Bug A in doc/bugs/repo-aegis-check-write-flake.md); stdout is
    // the JSON channel for frameworks that read it instead. A deny must
    // reach the agent whichever one it listens to.
    const home = aegisHome("channels", EMPTY_REGISTRY);
    const r = runGuard(claudePayload("git push"), { home });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /PUSH_IMPLICIT_TARGET/);
    const j = JSON.parse(r.stdout) as DecisionJson;
    assert.equal(j.hookSpecificOutput.hookEventName, "PreToolUse");
    assert.equal(j.hookSpecificOutput.permissionDecision, "deny");
    assert.ok(j.hookSpecificOutput.permissionDecisionReason.length > 0);
  });

  it("reports only org, repo, visibility and class about a destination", () => {
    const home = aegisHome("dest-fields", EMPTY_REGISTRY);
    const repo = makeRepo("dest-fields-repo", {
      remote: "git@github.com:acme/svc.git",
      class: "public-eligible",
    });
    const r = runGuard(codexPayload("git push origin main", repo), {
      home,
      cwd: repo,
      agent: "codex",
    });
    const payload = JSON.parse(r.stderr) as DenyPayload;
    assert.deepEqual(Object.keys(payload.details.destination!).sort(), [
      "class",
      "org",
      "repo",
      "visibility",
    ]);
  });

  it("treats an unrecognised --agent as a framework without an ask", () => {
    const home = aegisHome("unknown-agent", EMPTY_REGISTRY);
    const repo = makeRepo("unknown-agent-repo", {
      remote: "git@github.com:acme/svc.git",
      class: "public-eligible",
    });
    const r = runGuard(claudePayload("git push origin main", repo), {
      home,
      cwd: repo,
      agent: "some-other-agent",
    });
    assert.equal(r.code, 2, "conservative default: no ask means deny, never allow");
    assert.equal((JSON.parse(r.stderr) as DenyPayload).code, "PUBLIC_EGRESS_NEEDS_HUMAN");
  });
});

describe("hook guard-egress — decision-only oracle", { skip: !SUBPROCESS_TESTS_AVAILABLE }, () => {
  it("never emits `updatedInput` (or any rewritten command) on any path", () => {
    // The locked decision from doc/design/egress-guard.md: rewriting
    // `git push` into `git push origin <branch>` would rebuild the
    // implicit-destination defect one layer up with the agent's intent
    // still unexamined. This oracle runs every decision the hook can
    // reach and greps everything it printed.
    const home = aegisHome("oracle", EMPTY_REGISTRY);
    const publicRepo = makeRepo("oracle-public", {
      remote: "git@github.com:acme/svc.git",
      class: "public-eligible",
    });
    const privateRepo = makeRepo("oracle-private", {
      remote: "git@github.com:acme/internal.git",
      class: "private-strict",
    });

    const scenarios: { name: string; input: string; opts: GuardOptions }[] = [
      { name: "allow (no intent)", input: claudePayload("ls -la"), opts: { home } },
      {
        name: "allow (explicit private push)",
        input: claudePayload("git push origin main", privateRepo),
        opts: { home, cwd: privateRepo },
      },
      {
        name: "ask (public push, claude)",
        input: claudePayload("git push origin main", publicRepo),
        opts: { home, cwd: publicRepo },
      },
      {
        name: "deny (public push, codex)",
        input: codexPayload("git push origin main", publicRepo),
        opts: { home, cwd: publicRepo, agent: "codex" },
      },
      { name: "deny (bare push)", input: claudePayload("git push"), opts: { home } },
      {
        name: "deny (mode-dependent payload)",
        input: claudePayload('gh pr create --body-file "$TMPDIR/b.md" --repo acme/svc'),
        opts: { home },
      },
      {
        name: "deny (after cd)",
        input: claudePayload("cd /x && git push origin main"),
        opts: { home },
      },
      { name: "garbage stdin", input: "}{", opts: { home } },
    ];

    for (const s of scenarios) {
      const r = runGuard(s.input, s.opts);
      const everything = `${r.stdout}\n${r.stderr}`;
      assert.ok(
        !everything.includes("updatedInput"),
        `${s.name}: hook emitted updatedInput; it must be decision-only`,
      );
      // Belt and braces: no framework-specific rewrite key under any name.
      assert.ok(!everything.includes("hookSpecificOutput\":{\"updated"), s.name);
      assert.ok(!/"(?:updatedInput|modifiedCommand|rewritten\w*)"/.test(everything), s.name);
    }
  });
});
