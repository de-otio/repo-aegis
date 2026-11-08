// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// Subprocess tests for the two PR 2b refusals in `repo-aegis hook guard-egress`
// (issue #151; plan §8.1 S10 and §8.4 F5):
//
//   - AGENT_RAN_HUMAN_COMMAND: any Bash command whose text runs a command only
//     a person may run (approve, owner adds, upstreams add, init
//     --migrate-classify/--force), through any wrapper, alias or interpreter,
//     even with a terminal and even with the human-only env override set;
//   - EGRESS_PTY_WRAPPER: an egress segment run under a pty-providing wrapper,
//     with no registry and no approval able to lift it.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cliBuilt, cliPath } from "../_subprocess-utils.js";
import { scrubGitEnv } from "../_test-utils.js";
import { approvalsPath, mintApproval } from "@de-otio/repo-aegis-core";

let restoreGitEnv: () => void;
let tmp: string;
before(() => {
  restoreGitEnv = scrubGitEnv();
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "repo-aegis-guard-human-test-")));
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

function aegisHome(name: string, registry?: string): string {
  const dir = join(tmp, `${name}-aegis`);
  mkdirSync(join(dir, "markers"), { recursive: true });
  mkdirSync(join(dir, "state"), { recursive: true });
  if (registry !== undefined) writeFileSync(join(dir, "engagements.yaml"), registry);
  return dir;
}

function runGuard(command: string, home: string, opts: { human?: boolean; agent?: string } = {}): GuardResult {
  const env: NodeJS.ProcessEnv = { ...process.env, REPO_AEGIS_HOME: home, REPO_AEGIS_VISIBILITY_LOOKUP: "0" };
  delete env["REPO_AEGIS_EGRESS_HUMAN"];
  delete env["REPO_AEGIS_ASSUME_PUBLIC"];
  if (opts.human) env["REPO_AEGIS_EGRESS_HUMAN"] = "1";
  const r = spawnSync(process.execPath, [cliPath, "hook", "guard-egress", ...(opts.agent ? ["--agent", opts.agent] : [])], {
    cwd: tmp,
    env,
    encoding: "utf8",
    input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, cwd: tmp }),
  });
  return { stdout: r.stdout, stderr: r.stderr, code: r.status };
}

const REGISTRY = "schemaVersion: 2\npersonalOrgs:\n  - acme\nengagements: []\n";

/** The shapes a person-only command can arrive in. Each must be refused. */
const HUMAN_COMMANDS: ReadonlyArray<readonly [label: string, command: string]> = [
  ["approve", "repo-aegis approve '*'"],
  ["approve a repo", "repo-aegis approve acme/svc --ttl 1h"],
  ["owner add --personal-org", "repo-aegis engagements add --personal-org stranger"],
  ["owner add --github-org", "repo-aegis engagements add customer-a --github-org customer-a-org"],
  ["upstreams add", "repo-aegis upstreams add upstream-org/lib"],
  ["init --migrate-classify", "repo-aegis init --migrate-classify"],
  ["init --force", "repo-aegis init --force"],
  ["identity add", "repo-aegis identity add me --gh-login alice"],
  ["identity remove", "repo-aegis identity remove me"],
  ["identity require --off", "repo-aegis identity require --off"],
  ["engagements set-identity", "repo-aegis engagements set-identity customer-a --person me"],
  ["set-identity for a personal org", "repo-aegis engagements set-identity --personal-org acme --agent me-bot"],
  // wrappers and shells
  ["sudo", "sudo -u someone repo-aegis approve '*'"],
  ["env", "env FOO=1 repo-aegis approve '*'"],
  ["timeout", "timeout 5 repo-aegis approve '*'"],
  ["bash -c", "bash -c 'repo-aegis approve *'"],
  ["eval", `eval "repo-aegis engagements add --personal-org stranger"`],
  ["&& chain", "ls && repo-aegis approve '*'"],
  ["command substitution", "echo $(repo-aegis approve '*')"],
  // pty wrappers and multiplexers
  ["script", "script -q /dev/null repo-aegis approve '*'"],
  ["unbuffer", "unbuffer repo-aegis approve '*'"],
  ["expect", "expect -c 'spawn repo-aegis approve *; interact'"],
  ["tmux new -d", `tmux new -d "repo-aegis approve '*'"`],
  ["tmux send-keys", "tmux send-keys -t 0 'repo-aegis approve *' Enter"],
  ["screen -dm", "screen -dm repo-aegis upstreams add upstream-org/lib"],
  ["ssh -tt", "ssh -tt localhost repo-aegis approve '*'"],
  ["socat pty", "socat - EXEC:'repo-aegis approve *',pty"],
  // interpreters and heredocs
  ["python subprocess", `python3 -c 'import subprocess; subprocess.run(["repo-aegis","approve","*"])'`],
  ["python pty", `python3 -c 'import pty; pty.spawn(["repo-aegis","approve","*"])'`],
  ["heredoc", "cat > mint.sh <<EOF\nrepo-aegis approve '*'\nEOF\nbash mint.sh"],
  ["node -e", `node -e "require('child_process').execSync('repo-aegis approve *')"`],
  // aliases, functions, quoting, paths
  ["alias", "alias ra=repo-aegis; ra approve '*'"],
  ["function", `ra() { repo-aegis "$@"; }; ra engagements add --github-org x`],
  ["split quotes", `"repo-""aegis" app\\rove '*'`],
  ["absolute path", "/opt/homebrew/bin/repo-aegis approve '*'"],
  ["node dist", "node packages/cli/dist/index.js approve '*'"],
  ["npx", "npx -y @de-otio/repo-aegis approve '*'"],
  // P7: the managed drop-in
  // the internal entry points (M3c/L2): reached only through the gh shim and git
  ["internal gh entry", "repo-aegis gh --home /x -- pr view 1"],
  ["internal gh entry via npx", "npx repo-aegis gh -- api user"],
  ["internal gh entry via dist", "node /p/packages/cli/dist/index.js gh -- pr view 1"],
  ["internal git-credential entry", "printf 'host=x\\n\\n' | repo-aegis git-credential get"],
  ["install claude-md --uninstall", "repo-aegis install claude-md --uninstall"],
  ["install claude-md --uninstall under script", "script -q /dev/null repo-aegis install claude-md --uninstall"],
  ["install claude-md --uninstall under expect", "expect -c 'spawn repo-aegis install claude-md --uninstall; interact'"],
  ["full uninstall", "repo-aegis uninstall --yes"],
  ["sudo rm of the drop-in", "sudo rm '/Library/Application Support/ClaudeCode/managed-settings.d/50-repo-aegis-501.json'"],
  ["sudo tee into the system directory", "echo '{}' | sudo tee /etc/claude-code/managed-settings.d/50-x.json"],
  ["sudo mv under script", "script -q /dev/null sudo mv /tmp/x /etc/claude-code/managed-settings.json"],
];

describe("hook guard-egress — AGENT_RAN_HUMAN_COMMAND", { skip: !cliBuilt() }, () => {
  for (const [label, command] of HUMAN_COMMANDS) {
    it(`refuses: ${label}`, () => {
      const home = aegisHome("human-cmd", REGISTRY);
      const r = runGuard(command, home);
      assert.equal(r.code, 2, `${command}\n${r.stderr}`);
      const body = JSON.parse(r.stderr) as { code: string; error: string };
      assert.equal(body.code, "AGENT_RAN_HUMAN_COMMAND");
      const decision = JSON.parse(r.stdout) as {
        hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string };
      };
      assert.equal(decision.hookSpecificOutput.permissionDecision, "deny");
      assert.equal(decision.hookSpecificOutput.permissionDecisionReason, body.error);
    });
  }

  it("the message answers the five §3.9 questions and carries nothing from the command line", () => {
    const home = aegisHome("human-msg", REGISTRY);
    const r = runGuard("repo-aegis engagements add customer-zeta --github-org zeta-org", home);
    const { error } = JSON.parse(r.stderr) as { error: string };
    assert.match(error, /^repo-aegis engagements add --personal-org\/--github-org: refused\./); // what
    assert.match(error, /vouches for a publish or an owner/); // why
    assert.match(error, /No approval covers this/); // approval
    assert.match(error, /A person runs it in their own terminal: repo-aegis engagements add/); // fix + who
    assert.match(error, /Agents: do not run that yourself/);
    assert.match(error, /\[AGENT_RAN_HUMAN_COMMAND, see doc\/agent-guide\.md#agent_ran_human_command\]/); // where
    assert.doesNotMatch(error, /customer-zeta|zeta-org/);
  });

  it("refuses with no registry at all (it needs none)", () => {
    const home = aegisHome("human-noreg");
    assert.equal(runGuard("repo-aegis approve '*'", home).code, 2);
  });

  it("refuses even when a person is declared present (REPO_AEGIS_EGRESS_HUMAN=1)", () => {
    const home = aegisHome("human-env", REGISTRY);
    const r = runGuard("repo-aegis approve '*'", home, { human: true });
    assert.equal(r.code, 2);
    assert.equal((JSON.parse(r.stderr) as { code: string }).code, "AGENT_RAN_HUMAN_COMMAND");
  });

  it("refuses for the Codex and Gemini hosts too", () => {
    const home = aegisHome("human-agents", REGISTRY);
    for (const agent of ["codex", "gemini"]) {
      assert.equal(runGuard("repo-aegis approve '*'", home, { agent }).code, 2, agent);
    }
  });

  it("L2: `approve --revoke` only tightens, so it passes; `approve --list` names org scopes, so it is refused", () => {
    const home = aegisHome("human-revoke", REGISTRY);
    for (const command of ["repo-aegis approve --revoke all", "repo-aegis --json approve --revoke ab12cd34"]) {
      const r = runGuard(command, home);
      assert.equal(r.code, 0, `${command}\n${r.stderr}`);
    }
    assert.equal(runGuard("repo-aegis approve --list", home).code, 2);
  });

  it("L2: a directory, a git -C value or a search pattern that says repo-aegis is not the program", () => {
    const home = aegisHome("human-l2", REGISTRY);
    for (const command of [
      "git -C /Users/me/repos/dot/repo-aegis log --grep approve",
      `grep -rn "repo-aegis approve" doc/`,
      "cd /Users/me/repos/dot/repo-aegis && git status",
      "gh pr view 5 --repo de-otio/repo-aegis --json title",
    ]) {
      const r = runGuard(command, home);
      assert.equal(r.code, 0, `${command}\n${r.stderr}`);
    }
  });

  it("leaves ordinary repo-aegis and git commands alone", () => {
    const home = aegisHome("human-ok", REGISTRY);
    for (const command of [
      "repo-aegis status",
      "repo-aegis scan .",
      "repo-aegis engagements add customer-a",
      "repo-aegis upstreams list",
      "repo-aegis doctor --json",
      "git commit -m 'refuse repo-aegis approve in agent text'",
      "cd /x/repo-aegis && git status",
    ]) {
      const r = runGuard(command, home);
      assert.equal(r.code, 0, `${command}\n${r.stderr}`);
      assert.equal(r.stdout, "");
    }
  });
});

describe("hook guard-egress — EGRESS_PTY_WRAPPER", { skip: !cliBuilt() }, () => {
  const WRAPPED: ReadonlyArray<readonly [label: string, command: string]> = [
    ["script (BSD)", "script -q /dev/null gh issue create --repo acme/svc --title x"],
    ["script (util-linux)", "script -qc 'gh issue create --repo acme/svc --title x' /dev/null"],
    ["unbuffer", "unbuffer gh issue create --repo acme/svc --title x"],
    ["expect", "expect -c 'spawn gh issue create --repo acme/svc; interact'"],
    ["faketty", "faketty git push origin main"],
    ["socat", "socat - EXEC:'gh issue create --repo acme/svc',pty"],
    ["ssh -tt", "ssh -tt localhost gh issue create --repo acme/svc"],
    ["screen (attached)", "screen gh issue create --repo acme/svc --title x"],
    ["sshpass", "sshpass -p x git push origin main"],
    ["rlwrap", "rlwrap gh issue create --repo acme/svc --title x"],
    ["alias to script", "alias s=script; s -q /dev/null git push origin main"],
    ["function around script", `s() { script "$@"; }; s -q /dev/null git push origin main`],
    ["variable holding script", "S=script; $S -q /dev/null git push origin main"],
    ["$(which script)", "$(which script) -q /dev/null git push origin main"],
    ["command script", "command script -q /dev/null git push origin main"],
    ["copied script binary", "cp /usr/bin/script /tmp/s; /tmp/s -q /dev/null git push origin main"],
    ["python pty.spawn", `python3 -c 'import pty; pty.spawn(["gh","issue","create","--repo","acme/svc"])'`],
    ["perl IO::Pty", "perl -MIO::Pty -e 'system(q(gh issue create --repo acme/svc))'"],
    ["ruby PTY", `ruby -rpty -e 'PTY.spawn("gh issue create --repo acme/svc")'`],
    ["inside bash -c", `bash -c "script -q /dev/null gh issue create --repo acme/svc"`],
  ];

  for (const [label, command] of WRAPPED) {
    it(`refuses: ${label}`, () => {
      const home = aegisHome("pty", REGISTRY);
      const r = runGuard(command, home);
      assert.equal(r.code, 2, `${command}\n${r.stderr}`);
      const body = JSON.parse(r.stderr) as { code: string; error: string };
      assert.equal(body.code, "EGRESS_PTY_WRAPPER");
      assert.match(body.error, /No approval covers this/);
      assert.match(body.error, /\[EGRESS_PTY_WRAPPER, see doc\/agent-guide\.md#egress_pty_wrapper\]/);
    });
  }

  it("needs no registry", () => {
    const home = aegisHome("pty-noreg");
    const r = runGuard("script -q /dev/null gh issue create --repo acme/svc --title x", home);
    assert.equal(r.code, 2);
    assert.equal((JSON.parse(r.stderr) as { code: string }).code, "EGRESS_PTY_WRAPPER");
  });

  it("is not lifted by a live '*' approval or by REPO_AEGIS_EGRESS_HUMAN=1", () => {
    const home = aegisHome("pty-approved", REGISTRY);
    mintApproval({ target: { org: "*", repo: "*" }, ttlMs: 15 * 60_000, by: "test", path: approvalsPath(home) });
    for (const human of [false, true]) {
      const r = runGuard("script -q /dev/null gh issue create --repo acme/svc --title x", home, { human });
      assert.equal(r.code, 2, `human=${human}\n${r.stderr}`);
      assert.equal((JSON.parse(r.stderr) as { code: string }).code, "EGRESS_PTY_WRAPPER");
    }
  });

  it("does not touch a plain gh command or a title that says 'script'", () => {
    const home = aegisHome("pty-plain", REGISTRY);
    const r = runGuard("gh issue create --repo acme/svc --title script --body 'tmux and screen'", home, { human: true });
    assert.equal(r.code, 0, r.stderr);
  });
});

describe("hook guard-egress — AGENT_DETACHED_SESSION (H2b)", { skip: !cliBuilt() }, () => {
  const DETACHED: ReadonlyArray<readonly [label: string, command: string]> = [
    ["tmux new -d", "tmux new -d 'sleep 100'"],
    ["tmux new-session -d", "tmux new-session -d -s dev 'npm run dev'"],
    ["tmux new-session -Ad", "tmux new-session -Ads dev"],
    ["tmux with a socket", "tmux -L work new -d"],
    ["tmux new-window", "tmux new-window 'npm run dev'"],
    ["tmux split-window", "tmux split-window -h 'npm run dev'"],
    ["tmux send-keys (egress text too)", "tmux send-keys -t 0 'gh issue create --repo acme/svc' Enter"],
    ["tmux send-keys, any target", "tmux send-keys -t %9 'ls' Enter"],
    ["tmux respawn-pane", "tmux respawn-pane -k 'sh'"],
    ["screen -X stuff", "screen -S dev -X stuff 'ls\\n'"],
    ["screen -X screen", "screen -S dev -X screen sh"],
    ["screen -dm", "screen -dm sleep 100"],
    ["screen -dmS", "screen -dmS dev npm run dev"],
    ["screen -d -m", "screen -d -m sleep 100"],
    ["setsid", "setsid npm run dev"],
    ["setsid by path", "/usr/bin/setsid ./server"],
    ["daemonize", "daemonize /usr/bin/node server.js"],
    ["nohup + disown", "nohup npm run dev > out.log 2>&1 & disown"],
    ["python double fork", `python3 -c 'import os; os.fork() or os.setsid()'`],
    ["inside bash -c", `bash -c "setsid sleep 100"`],
    ["a non-egress command", "ls && setsid true"],
  ];

  for (const [label, command] of DETACHED) {
    it(`refuses: ${label}`, () => {
      const home = aegisHome("detached", REGISTRY);
      const r = runGuard(command, home);
      assert.equal(r.code, 2, `${command}\n${r.stderr}`);
      const body = JSON.parse(r.stderr) as { code: string; error: string };
      assert.equal(body.code, "AGENT_DETACHED_SESSION");
      assert.match(body.error, /^[^:]+: refused\./); // what
      assert.match(body.error, /re-parented to the system's init process/); // why
      assert.match(body.error, /No approval covers this/); // approval
      assert.match(body.error, /Re-issue as: run the command in the foreground/); // fix, agent
      assert.match(body.error, /a person starts it in their own terminal/); // fix, person
      assert.match(body.error, /\[AGENT_DETACHED_SESSION, see doc\/agent-guide\.md#agent_detached_session\]/); // where
    });
  }

  it("is not lifted by REPO_AEGIS_EGRESS_HUMAN=1", () => {
    const home = aegisHome("detached-human", REGISTRY);
    assert.equal(runGuard("setsid true", home, { human: true }).code, 2);
  });

  it("a plain `nohup cmd &` stays allowed (dev servers), and so do attached or unrelated uses", () => {
    const home = aegisHome("detached-ok", REGISTRY);
    for (const command of [
      "nohup npm run dev > out.log 2>&1 &",
      "tmux ls",
      "tmux attach -t dev",
      "tmux new -s dev",
      "screen -ls",
      "grep -rn setsid src/",
      "man setsid",
      "which setsid",
      "type tmux",
      "command -v screen",
      "pgrep tmux",
      "pkill setsid",
      "git commit -m 'document the setsid refusal'",
      "echo disown",
    ]) {
      const r = runGuard(command, home);
      assert.equal(r.code, 0, `${command}\n${r.stderr}`);
    }
  });
});
