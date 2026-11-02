// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// The text-level detector for commands only a person may run (issue #151,
// PR 2b). The agent hook refuses any Bash command whose text runs one of them,
// through any wrapper, alias or interpreter, whatever the terminal situation.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  AGENT_RAN_HUMAN_COMMAND,
  commandRegions,
  detachedStartRefusal,
  findDetachedStart,
  findHumanOnlyCommand,
  humanCommandRefusal,
  type DetachedKind,
  type HumanOnlyKind,
} from "./human-commands.js";

const HITS: ReadonlyArray<readonly [command: string, kind: HumanOnlyKind]> = [
  // plain
  ["repo-aegis approve '*'", "approve"],
  ["repo-aegis approve acme/svc --ttl 1h", "approve"],
  ["repo-aegis --json approve acme/*", "approve"],
  ["/usr/local/bin/repo-aegis approve acme/*", "approve"],
  ["node packages/cli/dist/index.js approve '*'", "approve"],
  ["npx -y @de-otio/repo-aegis approve '*'", "approve"],
  ["repo-aegis engagements add --personal-org acme", "owner-add"],
  ["repo-aegis engagements add customer-a --github-org customer-a-org", "owner-add"],
  ["repo-aegis engagements add customer-a --name 'Customer A' --github-org=customer-a-org", "owner-add"],
  ["repo-aegis upstreams add upstream-org/lib", "upstream-add"],
  ["repo-aegis init --migrate-classify", "init-migrate"],
  ["repo-aegis init --force", "init-force"],
  ["repo-aegis --home /x init --yes --force", "init-force"],
  // wrappers
  ["sudo -u me repo-aegis approve '*'", "approve"],
  ["env FOO=1 repo-aegis approve '*'", "approve"],
  ["timeout 5 repo-aegis approve '*'", "approve"],
  ["nohup repo-aegis approve '*' &", "approve"],
  ["script -q /dev/null repo-aegis approve '*'", "approve"],
  ["unbuffer repo-aegis engagements add --personal-org acme", "owner-add"],
  ["expect -c 'spawn repo-aegis approve *; interact'", "approve"],
  ["tmux new -d \"repo-aegis approve '*'\"", "approve"],
  ["tmux new-session -d 'repo-aegis upstreams add upstream-org/lib'", "upstream-add"],
  ["screen -dm repo-aegis approve '*'", "approve"],
  ["ssh -tt localhost repo-aegis approve '*'", "approve"],
  ["socat - EXEC:'repo-aegis approve *',pty", "approve"],
  // shells and eval
  ["bash -c 'repo-aegis approve *'", "approve"],
  ["sh -c \"repo-aegis engagements add --github-org x\"", "owner-add"],
  ["eval \"repo-aegis approve '*'\"", "approve"],
  ["echo ok && repo-aegis approve '*'", "approve"],
  ["$(which repo-aegis) approve '*'", "approve"],
  ["`command -v repo-aegis` approve '*'", "approve"],
  // interpreters and heredocs
  [`python3 -c 'import subprocess; subprocess.run(["repo-aegis","approve","*"])'`, "approve"],
  [`python3 -c 'import pty; pty.spawn(["repo-aegis","upstreams","add","a/b"])'`, "upstream-add"],
  ["python3 <<EOF\nimport os\nos.system('repo-aegis approve *')\nEOF", "approve"],
  ["cat > mint.sh <<EOF\nrepo-aegis approve '*'\nEOF", "approve"],
  ["bash <<'EOF'\nrepo-aegis init --migrate-classify\nEOF", "init-migrate"],
  ["node -e \"require('child_process').execSync('repo-aegis approve *')\"", "approve"],
  // aliases, functions, variables
  ["alias ra=repo-aegis; ra approve '*'", "approve"],
  ["alias ra='repo-aegis'\nra engagements add --personal-org acme", "owner-add"],
  ["RA=repo-aegis; $RA approve '*'", "approve"],
  ["ra() { repo-aegis \"$@\"; }; ra approve '*'", "approve"],
  ["function ra { repo-aegis \"$@\"; }; ra upstreams add a/b", "upstream-add"],
  // quoting and escapes
  ["\"repo-\"\"aegis\" app\\rove '*'", "approve"],
  ["repo-aegis 'approve' '*'", "approve"],
  ["repo-aegis approve --list", "approve"],
  ["repo-aegis approve --revoke all --list", "approve"],
  ["npx repo-aegis@0.11.0 approve '*'", "approve"],
  ["grep -r x . --pager 'repo-aegis approve *'", "approve"],
  ["repo-aegis --home \"a;b\" approve '*'", "approve"],
  // a substitution inside a commit message runs
  ["git commit -m \"$(repo-aegis approve '*')\"", "approve"],
];

const MISSES: ReadonlyArray<string> = [
  "repo-aegis status",
  "repo-aegis scan .",
  "repo-aegis check --remote-url x",
  "repo-aegis engagements add customer-a",
  "repo-aegis engagements list",
  "repo-aegis upstreams list",
  "repo-aegis upstreams remove a/b",
  "repo-aegis init",
  "repo-aegis doctor",
  "cd /x/repo-aegis && git status",
  "ls /x/repo-aegis/packages",
  "gh pr review 5 --approve",
  "gh pr review 5 --approve --body 'repo-aegis approve'",
  "echo approve",
  "npm run build",
  "git commit -m \"refuse repo-aegis approve in agent text\"",
  "git commit -m 'repo-aegis init --force is human only'",
  "git commit -m \"$(cat <<'EOF'\nrefuse repo-aegis approve and repo-aegis upstreams add\nEOF\n)\"",
  "gh issue create --title 'repo-aegis approve gate' --body 'repo-aegis engagements add --github-org'",
  "grep -r approve packages/",
  "repo-aegis approve --revoke all",
  "repo-aegis --json approve --revoke ab12cd34",
  "git -C /Users/me/repos/dot/repo-aegis log --grep approve",
  "git -C/Users/me/repos/dot/repo-aegis log approve",
  "git --git-dir=/x/repo-aegis/.git log approve",
  `grep -rn "repo-aegis approve" doc/`,
  "grep -rn 'repo-aegis engagements add --personal-org' README.md",
  "rg -n repo-aegis approve packages/",
  "cd /Users/me/repos/dot/repo-aegis && git status",
  "cd /Users/me/repos/dot/repo-aegis approve",
  "ls /Users/me/repos/dot/repo-aegis/doc approve",
  "cat /Users/me/repos/dot/repo-aegis/doc/approve.md",
  "gh pr view 5 --repo de-otio/repo-aegis --json title",
  "gh -R de-otio/repo-aegis pr review 5 --approve",
  "git remote add upstream git@github.com:de-otio/repo-aegis.git",
  "man repo-aegis approve",
  "repo-aegis status && echo approve",
  "x=$(repo-aegis status); echo approve",
  "x=$(repo-aegis status) && echo approve",
  "",
];

describe("findHumanOnlyCommand — refuses every human-only command, however it is run", () => {
  for (const [command, kind] of HITS) {
    it(JSON.stringify(command), () => {
      assert.deepEqual(findHumanOnlyCommand(command), { kind });
    });
  }
});

describe("findHumanOnlyCommand — leaves ordinary commands alone", () => {
  for (const command of MISSES) {
    it(JSON.stringify(command), () => {
      assert.equal(findHumanOnlyCommand(command), null);
    });
  }

  it("a quoted heredoc commit message cannot smuggle a command after its terminator", () => {
    const sneaky = "git commit -m \"$(cat <<'EOF'\nmsg\nEOF\nrepo-aegis approve '*'\n)\"";
    assert.deepEqual(findHumanOnlyCommand(sneaky), { kind: "approve" });
  });

  it("an unquoted heredoc in a message is expanded by the shell, so it is read", () => {
    const expanded = "git commit -m \"$(cat <<EOF\n$(repo-aegis approve '*')\nEOF\n)\"";
    assert.deepEqual(findHumanOnlyCommand(expanded), { kind: "approve" });
  });
});

describe("findDetachedStart — a detached session start is refused (H2b)", () => {
  const HITS: ReadonlyArray<readonly [string, DetachedKind]> = [
    ["tmux new -d", "tmux-detached"],
    ["tmux new-session -d -s x 'cmd'", "tmux-detached"],
    ["tmux new-session -Ads x", "tmux-detached"],
    ["tmux -L w new -d", "tmux-detached"],
    ["screen -dm cmd", "screen-detached"],
    ["screen -dmS x cmd", "screen-detached"],
    ["screen -d -m cmd", "screen-detached"],
    ["setsid cmd", "setsid"],
    ["/usr/bin/setsid cmd", "setsid"],
    ["python3 -c 'import os; os.setsid()'", "setsid"],
    ["perl -MPOSIX -e 'POSIX::setsid()'", "setsid"],
    ["daemonize cmd", "daemonize"],
    ["nohup cmd > /dev/null 2>&1 & disown", "nohup-disown"],
    ["nohup cmd &\ndisown %1", "nohup-disown"],
    ["bash -c 'setsid cmd'", "setsid"],
    ["sudo setsid cmd", "setsid"],
  ];
  for (const [command, kind] of HITS) {
    it(JSON.stringify(command), () => assert.deepEqual(findDetachedStart(command), { kind }));
  }

  const MISSES = [
    "nohup npm run dev > out.log 2>&1 &",
    "tmux ls",
    "tmux attach -t x",
    "tmux new -s x",
    "tmux send-keys -t 0 ls Enter",
    "screen -ls",
    "screen -r x",
    "disown",
    "grep -rn setsid src/",
    "man setsid",
    "git commit -m 'drop setsid'",
    "echo hello",
    "",
  ];
  for (const command of MISSES) {
    it(`leaves ${JSON.stringify(command)} alone`, () => assert.equal(findDetachedStart(command), null));
  }

  it("is a five-part message with fixed text", () => {
    const text = detachedStartRefusal({ kind: "setsid" });
    assert.match(text, /^setsid \(.*\): refused\./);
    assert.match(text, /re-parented to the system's init process/);
    assert.match(text, /No approval covers this/);
    assert.match(text, /Re-issue as: run the command in the foreground/);
    assert.match(text, /a person starts it in their own terminal/);
    assert.match(text, /\[AGENT_DETACHED_SESSION, see doc\/agent-guide\.md#agent_detached_session\]/);
  });
});

describe("commandRegions", () => {
  it("splits at unquoted separators only", () => {
    assert.deepEqual(commandRegions("a b; c 'd;e' && f"), [["a", "b"], ["c", "d", "e"], ["f"]]);
  });

  it("joins adjacent quoted pieces and drops escapes", () => {
    assert.deepEqual(commandRegions('"repo-""aegis" app\\rove'), [["repo-aegis", "approve"]]);
  });
});

describe("humanCommandRefusal — five parts (§3.9)", () => {
  const kinds: HumanOnlyKind[] = ["approve", "owner-add", "upstream-add", "init-migrate", "init-force"];
  for (const kind of kinds) {
    it(kind, () => {
      const text = humanCommandRefusal({ kind });
      assert.match(text, /refused\./); // what
      assert.match(text, /vouches for a publish or an owner/); // why
      assert.match(text, /No approval covers this/); // approval
      assert.match(text, /A person runs it in their own terminal: repo-aegis /); // fix + who
      assert.match(text, /Agents: do not run that yourself/);
      assert.match(text, new RegExp(`\\[${AGENT_RAN_HUMAN_COMMAND}, see doc/agent-guide\\.md#agent_ran_human_command\\]`)); // where
    });
  }

  it("is fixed text: nothing from the command line is interpolated", () => {
    const a = humanCommandRefusal({ kind: "approve" });
    assert.equal(a, humanCommandRefusal({ kind: "approve" }));
    assert.doesNotMatch(a, /acme|customer/);
  });
});
