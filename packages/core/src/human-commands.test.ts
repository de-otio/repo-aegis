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
  // P7: removing the managed drop-in is a root action only a person takes
  ["repo-aegis install claude-md --uninstall", "claude-md-uninstall"],
  ["repo-aegis --json install claude-md --uninstall", "claude-md-uninstall"],
  ["repo-aegis install claude-md --claude-home /x --uninstall", "claude-md-uninstall"],
  ["node packages/cli/dist/index.js install claude-md --uninstall", "claude-md-uninstall"],
  ["script -q /dev/null repo-aegis install claude-md --uninstall", "claude-md-uninstall"],
  ["expect -c 'spawn repo-aegis install claude-md --uninstall; interact'", "claude-md-uninstall"],
  ["sudo -u me repo-aegis install claude-md --uninstall", "claude-md-uninstall"],
  ["bash -c 'repo-aegis install claude-md --uninstall'", "claude-md-uninstall"],
  ["tmux new -d \"repo-aegis install claude-md --uninstall\"", "claude-md-uninstall"],
  ["alias ra=repo-aegis; ra install claude-md --uninstall", "claude-md-uninstall"],
  ["repo-aegis uninstall --yes", "claude-md-uninstall"],
  ["repo-aegis uninstall --yes --purge-state", "claude-md-uninstall"],
  // P7: sudo rm / mv / tee on the managed-settings directory, directly or under a pty wrapper
  ["sudo rm '/Library/Application Support/ClaudeCode/managed-settings.d/50-repo-aegis-501.json'", "managed-settings-write"],
  ["sudo rm /etc/claude-code/managed-settings.d/50-repo-aegis-1000.json", "managed-settings-write"],
  ["sudo mv /tmp/x /etc/claude-code/managed-settings.d/50-x.json", "managed-settings-write"],
  ["echo '{}' | sudo tee /etc/claude-code/managed-settings.json", "managed-settings-write"],
  ["script -q /dev/null sudo rm /etc/claude-code/managed-settings.d/a.json", "managed-settings-write"],
  ["expect -c 'spawn sudo rm /etc/claude-code/managed-settings.d/a.json; interact'", "managed-settings-write"],
  ["bash -c \"sudo tee /etc/claude-code/managed-settings.d/z.json < /tmp/x\"", "managed-settings-write"],
  ["cd /etc/claude-code/managed-settings.d && sudo rm 50-repo-aegis-1000.json", "managed-settings-write"],
  ["sudo sed -i s/a/b/ /Library/Application\\ Support/ClaudeCode/managed-settings.json", "managed-settings-write"],
  ["sudo rmdir /etc/claude-code/managed-settings.d", "managed-settings-write"],
  ["doas rm /etc/claude-code/managed-settings.d/x.json", "managed-settings-write"],
  ["sudo -n bash -c 'rm /etc/claude-code/managed-settings.d/x.json'", "managed-settings-write"],
  // L4: verbs, interpreters and path spellings the first list missed
  ["sudo unlink /etc/claude-code/managed-settings.d/50-repo-aegis-1000.json", "managed-settings-write"],
  ["sudo find /etc/claude-code -name '*.json' -delete", "managed-settings-write"],
  ["sudo find /etc/claude-code/managed-settings.d -type f -exec rm {} +", "managed-settings-write"],
  ["sudo rm /etc/./claude-code/m*/50-repo-aegis-1000.json", "managed-settings-write"],
  ["sudo rm /etc//claude-code//managed-settings.d/50-repo-aegis-1000.json", "managed-settings-write"],
  ["sudo rm /etc/x/../claude-code/managed-settings.d/50-repo-aegis-1000.json", "managed-settings-write"],
  ["sudo rm '/Library/Application Support/./ClaudeCode/managed-settings.d/50-repo-aegis-501.json'", "managed-settings-write"],
  ["sudo python3.12 -c \"import os; os.remove('/etc/claude-code/managed-settings.d/50-repo-aegis-1000.json')\"", "managed-settings-write"],
  ["sudo perl5.34 -e 'unlink glob q{/etc/claude-code/managed-settings.d/*}'", "managed-settings-write"],
  ["sudo ruby3.2 -e 'File.delete(%q{/etc/claude-code/managed-settings.d/x.json})'", "managed-settings-write"],
  ["sudo node22 -e \"require('fs').unlinkSync('/etc/claude-code/managed-settings.d/x.json')\"", "managed-settings-write"],
  ["sudo xargs rm < /etc/claude-code/managed-settings.d/list", "managed-settings-write"],
  ["sudo shred -u /etc/claude-code/managed-settings.d/x.json", "managed-settings-write"],
  ["sudo rsync -a --delete /tmp/empty/ /etc/claude-code/managed-settings.d/", "managed-settings-write"],
  ["sudo tar xf /tmp/x.tar -C /etc/claude-code/managed-settings.d", "managed-settings-write"],
  ["sudo env PATH=/tmp rm /etc/claude-code/managed-settings.d/x.json", "managed-settings-write"],
  ["sudo -n /usr/bin/env rm /etc/claude-code/managed-settings.d/x.json", "managed-settings-write"],
  // a glob that can only mean the managed directory: the verb may be hidden in the glob too
  ["sudo rm /etc/cl*/m*/50-repo-aegis-1000.json", "managed-settings-write"],
  ["sudo rm -rf /etc/claude-co?e", "managed-settings-write"],
  ["sudo /bin/r* '/Library/Application Support/Claude*/managed-settings.d/x.json'", "managed-settings-write"],
  ["sudo rm /Library/Application\\ Support/ClaudeCode/m*/x.json", "managed-settings-write"],
  ["script -q /dev/null sudo find /etc/claude-code -delete", "managed-settings-write"],
  ["cd /etc/./claude-code/managed-settings.d && sudo unlink 50-repo-aegis-1000.json", "managed-settings-write"],
  // any verb under sudo: reads there need no sudo (0755 directory, 0644 file), so no verb list decides
  ["sudo ls /etc/claude-code", "managed-settings-write"],
  ["sudo find /etc/claude-code -maxdepth 1 -type f", "managed-settings-write"],
  ["sudo ls /etc/claude-code/./managed-settings.d", "managed-settings-write"],
  ["sudo gzip /etc/claude-code/managed-settings.d/50-repo-aegis-1000.json", "managed-settings-write"],
  ["sudo patch /etc/claude-code/managed-settings.json /tmp/p", "managed-settings-write"],
  ["sudo setfacl -m u:me:rw /etc/claude-code/managed-settings.d/50-repo-aegis-1000.json", "managed-settings-write"],
  ["sudo awk 'BEGIN{system(\"true\")}' /etc/claude-code/managed-settings.d/x.json", "managed-settings-write"],
  ["sudo /opt/tool/bin/anything '/Library/Application Support/ClaudeCode/managed-settings.d/50-repo-aegis-501.json'", "managed-settings-write"],
  ["cd /etc/claude-code/managed-settings.d && sudo gzip 50-repo-aegis-1000.json", "managed-settings-write"],
  // registry identities (doc/plan-owner-identity.md §5.1)
  ["repo-aegis identity add me --gh-login alice", "identity-change"],
  ["repo-aegis identity add me-bot --app example-bot", "identity-change"],
  ["repo-aegis --json identity remove me", "identity-change"],
  ["repo-aegis identity require --off", "identity-change"],
  ["repo-aegis engagements set-identity customer-a --person me --agent me-bot", "identity-change"],
  ["repo-aegis engagements set-identity --personal-org example-org --person me", "identity-change"],
  ["repo-aegis engagements set-identity customer-a --clear", "identity-change"],
  ["bash -c 'repo-aegis identity add me --gh-login alice'", "identity-change"],
  ["env FOO=1 repo-aegis engagements set-identity customer-a --person me", "identity-change"],
  ["script -q /dev/null repo-aegis identity remove me", "identity-change"],
  ["tmux new -d 'repo-aegis identity require --off'", "identity-change"],
  ["python3 -c 'import subprocess; subprocess.run([\"repo-aegis\",\"identity\",\"add\",\"x\",\"--app\",\"y\"])'", "identity-change"],
  ["node packages/cli/dist/index.js identity add me --gh-login alice", "identity-change"],
  ["$(which repo-aegis) engagements set-identity customer-a --agent me-bot", "identity-change"],
  // the `identity` word alone, and `set-identity` anywhere after the program word (subcommand fed by a pipe or a vector)
  ["echo add me --app b | xargs script -q /dev/null repo-aegis identity", "identity-change"],
  ["printf 'add me --gh-login alice' | xargs repo-aegis identity", "identity-change"],
  ["alias ra=repo-aegis; ra identity add me --gh-login alice", "identity-change"],
  ["cat <<EOF | bash\nrepo-aegis identity remove me\nEOF", "identity-change"],
  [`python3 -c 'import pty; pty.spawn(["repo-aegis","identity","add","me","--gh-login","alice"])'`, "identity-change"],
  [`python3 -c 'import pty; pty.spawn(["repo-aegis","identity"] + ["require","--off"])'`, "identity-change"],
  ["repo-aegis --home /x set-identity customer-a --person me", "identity-change"],
  ["xargs repo-aegis engagements set-identity < args.txt", "identity-change"],
  ["repo-aegis identity require --off --on", "identity-change"],
  // the internal entry points, reached only through the gh shim and git (M3c/L2)
  ["repo-aegis gh -- pr view 1", "internal-entry"],
  ["repo-aegis gh --home /x -- pr create --repo o/r", "internal-entry"],
  ["repo-aegis --json gh -- api user", "internal-entry"],
  ["repo-aegis --home /x gh -- issue list", "internal-entry"],
  ["npx repo-aegis gh -- pr view 1", "internal-entry"],
  ["npx -y @de-otio/repo-aegis gh -- pr view 1", "internal-entry"],
  ["node /p/packages/cli/dist/index.js gh -- pr view 1", "internal-entry"],
  ["/opt/homebrew/bin/repo-aegis gh -- pr view 1", "internal-entry"],
  ["/usr/local/lib/node_modules/@de-otio/repo-aegis/dist/index.js gh -- pr view 1", "internal-entry"],
  ["sudo -u me repo-aegis gh -- pr view 1", "internal-entry"],
  ["env FOO=1 repo-aegis gh -- pr view 1", "internal-entry"],
  ["bash -c 'repo-aegis gh -- pr view 1'", "internal-entry"],
  ["echo $(repo-aegis gh -- api user)", "internal-entry"],
  ["ls && repo-aegis gh -- pr view 1", "internal-entry"],
  ["RA=repo-aegis; $RA gh -- pr view 1", "internal-entry"],
  ["alias ra=repo-aegis; ra gh -- pr view 1", "internal-entry"],
  ["script -q /dev/null repo-aegis gh -- pr view 1", "internal-entry"],
  ["repo-aegis git-credential get", "internal-entry"],
  ["repo-aegis git-credential --home /x get", "internal-entry"],
  ["printf 'host=x\\n\\n' | repo-aegis git-credential get", "internal-entry"],
  ["repo-aegis git-credential get <<EOF\nhost=x\nEOF", "internal-entry"],
  ["npx repo-aegis git-credential get", "internal-entry"],
  ["node /p/dist/index.js git-credential get", "internal-entry"],
];

const MISSES: ReadonlyArray<string> = [
  "repo-aegis status",
  "repo-aegis doctor",
  "repo-aegis install git-credential",
  "repo-aegis check --path docs/gh-notes.md",
  "git commit -m 'repo-aegis gh -- pr view'",
  "echo gh git-credential",
  "git commit -m 'document repo-aegis identity add and set-identity'",
  // `identity require --on` only tightens, so an agent may run it
  "repo-aegis identity require --on",
  "repo-aegis --json identity require --on",
  "grep -rn 'identity add' doc/ # repo-aegis",
  "repo-aegis engagements add customer-a --name 'Identity Team'",
  "repo-aegis engagements show customer-a",
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
  // the managed drop-in: install and a dry run are not refused, nor is looking
  "repo-aegis install claude-md",
  "repo-aegis install claude-md --dry-run",
  "repo-aegis install claude-md --user-settings",
  "repo-aegis install hooks --uninstall",
  "repo-aegis install shim --uninstall",
  "repo-aegis uninstall",
  "repo-aegis uninstall --purge-state",
  "git commit -m \"repo-aegis install claude-md --uninstall is refused in agent text\"",
  "ls /etc/claude-code",
  "cat /etc/claude-code/managed-settings.d/50-repo-aegis-1000.json",
  "sudo rm /tmp/x",
  "sudo apt install foo",
  "grep -rn managed-settings doc/",
  "git commit -m 'sudo rm /etc/claude-code/x is refused'",
  "ls -l '/Library/Application Support/ClaudeCode/managed-settings.d'",
  // L4: still allowed
  "sudo find /etc -maxdepth 1 -name hosts",
  "sudo xargs rm < /tmp/list",
  "sudo tar tf /tmp/x.tar",
  "sudo python3.12 -c 'print(1)'",
  "sudo env true",
  "python3.12 -c 'print(1)'",
  "find /tmp -name '*.json' -delete",
  "unlink /tmp/x",
  "sudo rm /tmp/./x",
  "sudo rm /tmp//x/../y",
  "sudo apt install foo-*",
  "rsync -a /tmp/a/ /tmp/b/",
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
    ["tmux new-window 'cmd'", "tmux-spawn"],
    ["tmux neww -d cmd", "tmux-spawn"],
    ["tmux split-window -h cmd", "tmux-spawn"],
    ["tmux send-keys -t 0 'ls' Enter", "tmux-spawn"],
    ["tmux send-keys -t %3 x", "tmux-spawn"],
    ["tmux respawn-pane -k cmd", "tmux-spawn"],
    ["tmux respawn-window -k cmd", "tmux-spawn"],
    ["tmux -S /tmp/sock send-keys x Enter", "tmux-spawn"],
    ["screen -S s -X stuff 'ls\\n'", "screen-inject"],
    ["screen -S s -X screen cmd", "screen-inject"],
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
    "which setsid",
    "type tmux",
    "command -v screen",
    "pkill setsid",
    "pgrep tmux",
    "whereis daemonize",
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
  it("identity-change", () => {
    const text = humanCommandRefusal({ kind: "identity-change" });
    assert.match(text, /refused\./);
    assert.match(text, /which GitHub account acts for an owner/);
    assert.match(text, /No approval covers this/);
    assert.match(text, /A person runs it in their own terminal/);
    assert.match(text, new RegExp(`\\[${AGENT_RAN_HUMAN_COMMAND}, see doc/agent-guide\\.md#agent_ran_human_command\\]`));
  });
  const managedKinds: HumanOnlyKind[] = ["claude-md-uninstall", "managed-settings-write"];
  for (const kind of managedKinds) {
    it(kind, () => {
      const text = humanCommandRefusal({ kind });
      assert.match(text, /refused\./); // what
      assert.match(text, /root-owned/); // why: the point of the drop-in
      assert.match(text, /No approval covers this/); // approval
      assert.match(text, /A person runs it in their own terminal/); // fix + who
      assert.match(text, /Agents: do not run that yourself/);
      assert.match(text, new RegExp(`\\[${AGENT_RAN_HUMAN_COMMAND}, see doc/agent-guide\\.md#agent_ran_human_command\\]`));
    });
  }
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
