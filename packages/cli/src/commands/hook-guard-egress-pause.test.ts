// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// `repo-aegis hook guard-egress` under an emergency pause (complexity-review P1-E), as a subprocess: the answer a host
// sees. The design is the person-only gate, so most of this file is what a pause must NOT change: an agent that runs
// `repo-aegis pause`, `approve`, an identity change or an uninstall is refused paused or not.
//
// The pause file is written relative to the real clock with an hour of margin each way. Placeholder owners only.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cliBuilt, cliPath } from "../_subprocess-utils.js";
import { scrubGitEnv } from "../_test-utils.js";
import { mintPause, pausePath } from "@de-otio/repo-aegis-core";

const HOUR = 3_600_000;
const NOTICE = /repo-aegis: paused until \d\d:\d\d \(resume: repo-aegis resume\)/;
const REGISTRY = "schemaVersion: 2\npersonalOrgs:\n  - acme\nengagements: []\n";

let restoreGitEnv: () => void;
let tmp: string;
let n = 0;
before(() => {
  restoreGitEnv = scrubGitEnv();
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "repo-aegis-guard-pause-test-")));
});
after(() => {
  restoreGitEnv();
  rmSync(tmp, { recursive: true, force: true });
});

type PauseKind = "active" | "expired" | "none" | "future" | "world-writable";

function aegisHome(pause: PauseKind, repo?: string): string {
  const home = join(tmp, `h${n++}`);
  mkdirSync(join(home, "markers"), { recursive: true });
  mkdirSync(join(home, "state"), { recursive: true });
  writeFileSync(join(home, "engagements.yaml"), REGISTRY);
  const path = pausePath(home);
  const now = Date.now();
  const scope = repo !== undefined ? { repo } : {};
  if (pause === "active") mintPause({ path, now: new Date(now - 60_000), durationMs: HOUR, ...scope });
  if (pause === "expired") mintPause({ path, now: new Date(now - 2 * HOUR), durationMs: HOUR, ...scope });
  if (pause === "future") mintPause({ path, now: new Date(now + HOUR), durationMs: HOUR, ...scope });
  if (pause === "world-writable") {
    mintPause({ path, now: new Date(now - 60_000), durationMs: HOUR, ...scope });
    chmodSync(path, 0o666);
  }
  return home;
}

interface Result {
  stdout: string;
  stderr: string;
  code: number | null;
}

function guard(command: string, home: string, agent?: string): Result {
  const env: NodeJS.ProcessEnv = { ...process.env, REPO_AEGIS_HOME: home, REPO_AEGIS_VISIBILITY_LOOKUP: "0" };
  delete env["REPO_AEGIS_EGRESS_HUMAN"];
  delete env["REPO_AEGIS_ASSUME_PUBLIC"];
  const r = spawnSync(process.execPath, [cliPath, "hook", "guard-egress", ...(agent !== undefined ? ["--agent", agent] : [])], {
    cwd: tmp,
    env,
    encoding: "utf8",
    input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, cwd: tmp }),
  });
  return { stdout: r.stdout, stderr: r.stderr, code: r.status };
}

const SKIP = !cliBuilt();

/** An egress rule h refuses for a non-interactive shell: the owner is not registered. */
const UNREGISTERED = "gh pr create --repo stranger/svc --title t --body b";
/** A shape rule: a bare push has no destination the guard can name. */
const BARE_PUSH = "git push";

describe("guard-egress under a pause", { skip: SKIP }, () => {
  it("control: with no pause both commands are refused (codex has no ask, so it denies)", () => {
    const home = aegisHome("none");
    assert.equal(guard(UNREGISTERED, home, "codex").code, 2);
    assert.equal(guard(BARE_PUSH, home, "codex").code, 2);
  });

  it("an active pause allows both, with the notice as a systemMessage on Claude Code", () => {
    const home = aegisHome("active");
    for (const command of [UNREGISTERED, BARE_PUSH]) {
      const r = guard(command, home);
      assert.equal(r.code, 0, `${command}: ${r.stderr}`);
      const out = JSON.parse(r.stdout) as { systemMessage: string; hookSpecificOutput?: { permissionDecision?: string } };
      assert.match(out.systemMessage, NOTICE);
      // a notice must not skip the host's normal permission prompt
      assert.equal(out.hookSpecificOutput?.permissionDecision, undefined);
    }
  });

  it("every host adapter allows (those with no systemMessage channel allow silently)", () => {
    const home = aegisHome("active");
    for (const agent of ["claude", "codex", "gemini", "copilot", "cursor", "antigravity"]) {
      const r = guard(BARE_PUSH, home, agent);
      assert.equal(r.code, 0, `${agent}: ${r.stderr}`);
      assert.doesNotMatch(r.stdout, /deny/, agent);
    }
  });

  it("after expiry, with the clock past the end, the refusals are back with no command run", () => {
    const home = aegisHome("expired");
    assert.equal(guard(UNREGISTERED, home, "codex").code, 2);
    assert.equal(guard(BARE_PUSH, home, "codex").code, 2);
  });

  it("a future-dated or world-writable pause file is no pause", () => {
    for (const kind of ["future", "world-writable"] as const) {
      const home = aegisHome(kind);
      assert.equal(guard(BARE_PUSH, home, "codex").code, 2, kind);
    }
  });

  it("--repo stranger/svc paused: a command for stranger/svc passes, for another repository it is still refused", () => {
    const home = aegisHome("active", "stranger/svc");
    const inScope = guard(UNREGISTERED, home);
    assert.equal(inScope.code, 0, inScope.stderr);
    assert.match(inScope.stdout, NOTICE);
    // case-insensitively
    assert.equal(guard("gh pr create --repo Stranger/SVC --title t --body b", home).code, 0);
    // another repository of the same owner, another owner
    assert.equal(guard("gh pr create --repo stranger/other --title t --body b", home, "codex").code, 2);
    assert.equal(guard("gh pr create --repo elsewhere/svc --title t --body b", home, "codex").code, 2);
    // a command with no destination the guard can name is out of a scoped pause
    assert.equal(guard(BARE_PUSH, home, "codex").code, 2);
    // one command reaching the repository AND another is not covered
    assert.equal(guard("gh pr create --repo stranger/svc --title t --body b && gh pr create --repo stranger/other --title t --body b", home, "codex").code, 2);
  });

  it("a command with no egress is allowed with no notice (the cheap path does not read the pause)", () => {
    const home = aegisHome("active");
    const r = guard("ls -la", home);
    assert.equal(r.code, 0);
    assert.equal(r.stdout, "");
  });
});

describe("guard-egress: what a pause never lifts", { skip: SKIP }, () => {
  // The person-only verbs, in the shapes an agent can run them, each with an active machine-wide pause.
  const PERSON_ONLY: readonly string[] = [
    "repo-aegis pause",
    "repo-aegis pause --for 8h --repo acme/svc",
    "repo-aegis pause --list",
    "bash -c 'repo-aegis pause'",
    "repo-aegis approve '*'",
    "repo-aegis approve acme/svc --ttl 1h",
    "repo-aegis engagements add --personal-org stranger",
    "repo-aegis upstreams add upstream-org/lib",
    "repo-aegis identity add me --gh-login alice",
    "repo-aegis identity require --off",
    "repo-aegis engagements set-identity customer-a --person me",
    "repo-aegis init --force",
    "repo-aegis uninstall --yes",
    "repo-aegis install claude-md --uninstall",
    "repo-aegis gh pr list",
    "repo-aegis git-credential get",
  ];

  it("refuses an agent that runs a person-only verb, paused or not, on every host", () => {
    for (const kind of ["none", "active"] as const) {
      const home = aegisHome(kind);
      for (const command of PERSON_ONLY) {
        for (const agent of [undefined, "codex"]) {
          const r = guard(command, home, agent);
          assert.equal(r.code, 2, `${kind} ${agent ?? "claude"}: ${command}`);
          assert.match(r.stderr, /AGENT_RAN_HUMAN_COMMAND/, `${kind}: ${command}`);
        }
      }
    }
  });

  it("an agent may run `repo-aegis resume` (it only turns protection back on), paused or not", () => {
    for (const kind of ["none", "active"] as const) {
      const r = guard("repo-aegis resume", aegisHome(kind));
      assert.equal(r.code, 0, r.stderr);
      assert.doesNotMatch(r.stderr, /AGENT_RAN_HUMAN_COMMAND/);
    }
  });

  it("still refuses a detached session start (the gate behind the terminal gate), paused", () => {
    const home = aegisHome("active");
    for (const command of ["tmux new -d 'sleep 1'", "setsid sleep 1", "nohup sleep 1 & disown"]) {
      const r = guard(command, home);
      assert.equal(r.code, 2, command);
      assert.match(r.stderr, /AGENT_DETACHED_SESSION/);
    }
  });

  it("still refuses an identity-rule hit (a REPO_AEGIS_* variable on git), paused", () => {
    const home = aegisHome("active");
    const r = guard("REPO_AEGIS_EGRESS_HUMAN=1 git push origin main", home);
    assert.equal(r.code, 2);
    assert.doesNotMatch(r.stdout, /paused until/);
  });

  it("a machine-wide pause lifts the raw-network rule; a repository-scoped one does not", () => {
    const raw = "curl -X POST https://api.github.com/repos/acme/svc/issues -d '{}'";
    assert.equal(guard(raw, aegisHome("none"), "codex").code, 2);
    const wide = guard(raw, aegisHome("active"));
    assert.equal(wide.code, 0, wide.stderr);
    assert.match(wide.stdout, NOTICE);
    assert.equal(guard(raw, aegisHome("active", "acme/svc"), "codex").code, 2);
  });
});
