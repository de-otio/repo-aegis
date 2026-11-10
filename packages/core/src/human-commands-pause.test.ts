// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// `repo-aegis pause` is person-only (complexity-review P1-E): the egress guard refuses an agent command whose text
// runs it, in any shape, and `resume` (which only turns protection back on) is allowed.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { findHumanOnlyCommand, humanCommandRefusal } from "./human-commands.js";

describe("findHumanOnlyCommand — the emergency pause (P1-E)", () => {
  // `pause` switches repo-aegis off, so it is refused in any shape an agent can run it in, paused or not.
  const REFUSED: readonly string[] = [
    "repo-aegis pause",
    "repo-aegis pause --for 8h",
    "repo-aegis pause --repo acme/svc --reason 'ship it'",
    "repo-aegis pause --list",
    "repo-aegis --json pause",
    "repo-aegis --home /x pause",
    "/usr/local/bin/repo-aegis pause",
    "node packages/cli/dist/index.js pause --for 1h",
    "npx -y @de-otio/repo-aegis pause",
    "sudo -u me repo-aegis pause",
    "env FOO=1 repo-aegis pause",
    "bash -c 'repo-aegis pause --for 2h'",
    "ls && repo-aegis pause",
    "script -q /dev/null repo-aegis pause",
    "python3 -c 'import subprocess; subprocess.run([\"repo-aegis\",\"pause\"])'",
    "alias ra=repo-aegis; ra pause",
    "echo $(repo-aegis pause)",
    "cat > p.sh <<EOF\nrepo-aegis pause\nEOF\nbash p.sh",
    '"repo-""aegis" pa\\use',
  ];
  for (const command of REFUSED) {
    it(`refuses ${JSON.stringify(command)}`, () => assert.deepEqual(findHumanOnlyCommand(command), { kind: "pause" }));
  }

  // `resume` only turns protection back on, so an agent may run it; nothing else about a pause is a command.
  const ALLOWED: readonly string[] = [
    "repo-aegis resume",
    "repo-aegis --json resume",
    "/usr/local/bin/repo-aegis resume",
    "repo-aegis status",
    "repo-aegis doctor",
    "git commit -m 'document repo-aegis pause'",
    "grep -rn pause packages/",
    "cd /Users/me/repos/dot/repo-aegis && git status",
    "git -C /Users/me/repos/dot/repo-aegis log --grep pause",
    "echo pause",
  ];
  for (const command of ALLOWED) {
    it(`allows ${JSON.stringify(command)}`, () => assert.equal(findHumanOnlyCommand(command), null));
  }

  // The shell route to the state file: the Edit deny rule and check-write do not see a shell, so the text is the lock.
  const FILE_WRITES: readonly string[] = [
    "echo '{}' > ~/.config/repo-aegis/pause.json",
    "echo '{}' >> ~/.config/repo-aegis/pause.json",
    "echo '{}'>~/.config/repo-aegis/pause.json",
    "printf x > \"$REPO_AEGIS_HOME/pause.json\"",
    "printf x > ${REPO_AEGIS_HOME}/Pause.json",
    "cat x.json | tee ~/.config/repo-aegis/PAUSE.JSON",
    "cp /tmp/x.json ~/.config/repo-aegis/pause.json",
    "mv x.json /Users/me/.config/repo-aegis/pause.json",
    "install -m 600 x.json ~/.config/repo-aegis/pause.json",
    "ln -s /tmp/x.json ~/.config/repo-aegis/pause.json",
    "cd ~/.config/repo-aegis && echo '{}' > pause.json",
    "cd ~/.config/repo-aegis && cp /tmp/x.json pause.json",
    "dd if=/tmp/x.json of=~/.config/repo-aegis/pause.json",
    "sed -i s/a/b/ ~/.config/repo-aegis/pause.json",
    "python3 -c \"open('/Users/me/.config/repo-aegis/pause.json','w').write('{}')\"",
    "node -e \"require('fs').writeFileSync(process.env.HOME+'/.config/repo-aegis/pause.json','{}')\"",
    "bash -c 'echo {} > ~/.config/repo-aegis/pause.json'",
  ];
  for (const command of FILE_WRITES) {
    it(`refuses a shell write to the pause file: ${JSON.stringify(command)}`, () => assert.deepEqual(findHumanOnlyCommand(command), { kind: "pause" }));
  }

  const FILE_READS: readonly string[] = [
    "cat ~/.config/repo-aegis/pause.json",
    "ls -la ~/.config/repo-aegis/pause.json",
    "jq . ~/.config/repo-aegis/pause.json",
    "grep expiresAt ~/.config/repo-aegis/pause.json",
    "echo '{}' > /tmp/pause.json",
    "cp x.json /tmp/pause.json",
    "git commit -m 'cp x ~/.config/repo-aegis/pause.json is refused'",
    "repo-aegis resume",
    "repo-aegis status",
  ];
  for (const command of FILE_READS) {
    it(`allows ${JSON.stringify(command)}`, () => assert.equal(findHumanOnlyCommand(command), null));
  }

  it("the refusal is fixed text that says why and names the person's way", () => {
    const text = humanCommandRefusal({ kind: "pause" });
    assert.match(text, /refused\./);
    assert.match(text, /switching off its own guard/);
    assert.match(text, /No approval covers this/);
    assert.match(text, /A person runs it in their own terminal: repo-aegis pause /);
    assert.match(text, /Agents: do not run that yourself/);
    assert.doesNotMatch(text, /acme|customer/);
  });
});
