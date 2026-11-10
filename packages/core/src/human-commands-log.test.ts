// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// `repo-aegis log --off` is person-only (complexity-review P1-I): the egress guard refuses an agent command whose text
// runs it, or writes the decision log's switch file, in any shape. Reading the log and `log --on` are allowed.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { findHumanOnlyCommand, humanCommandRefusal, HUMAN_VERB_PATHS } from "./human-commands.js";

describe("findHumanOnlyCommand: the decision log's off switch (P1-I)", () => {
  const REFUSED: readonly string[] = [
    "repo-aegis log --off",
    "repo-aegis --json log --off",
    "repo-aegis log --last 1 --off",
    "repo-aegis --home /x log --off",
    "/usr/local/bin/repo-aegis log --off",
    "node packages/cli/dist/index.js log --off",
    "npx -y @de-otio/repo-aegis log --off",
    "sudo -u me repo-aegis log --off",
    "env FOO=1 repo-aegis log --off",
    "bash -c 'repo-aegis log --off'",
    "ls && repo-aegis log --off",
    "python3 -c 'import subprocess; subprocess.run([\"repo-aegis\",\"log\",\"--off\"])'",
    "alias ra=repo-aegis; ra log --off",
    // the switch file, written by a shell, under a repo-aegis path
    `echo '{"enabled": false}' > ~/.config/repo-aegis/state/decision-log.json`,
    `printf '{"enabled":false}' >> "$REPO_AEGIS_HOME/state/decision-log.json"`,
    "cp /tmp/off.json ~/.config/repo-aegis/state/decision-log.json",
    "tee ~/.config/repo-aegis/state/decision-log.json < /tmp/off.json",
    "mv /tmp/x ~/.config/repo-aegis/state/Decision-Log.JSON",
    "sed -i 's/true/false/' ~/.config/repo-aegis/state/decision-log.json",
    "python3 -c \"open('/Users/me/.config/repo-aegis/state/decision-log.json','w').write('{}')\"",
    // the log itself and its rotations (review F3)
    "rm ~/.config/repo-aegis/state/decisions.jsonl",
    "truncate -s 0 ~/.config/repo-aegis/state/decisions.jsonl",
    `: > "$REPO_AEGIS_HOME/state/decisions.jsonl"`,
    "mv ~/.config/repo-aegis/state/decisions.jsonl.1 /tmp/x",
    "cp /dev/null ~/.config/repo-aegis/state/decisions.jsonl",
  ];
  for (const command of REFUSED) {
    it(`refuses ${JSON.stringify(command)}`, () => assert.deepEqual(findHumanOnlyCommand(command), { kind: "log-off" }));
  }

  const ALLOWED: readonly string[] = [
    "repo-aegis log",
    "repo-aegis log --last 1",
    "repo-aegis log --last 1 --json",
    "repo-aegis --json log --code CROSS_ORG_PUSH --since 1h",
    "repo-aegis log --layer pre-push",
    // `--on` only turns recording back on
    "repo-aegis log --on",
    // reading the file, or the help
    "cat ~/.config/repo-aegis/state/decision-log.json",
    "jq . ~/.config/repo-aegis/state/decision-log.json",
    "tail -n 20 ~/.config/repo-aegis/state/decisions.jsonl",
    // deleting is a refused write only for the log: removing a pause or an approval only tightens, so that is unchanged
    "rm ~/.config/repo-aegis/pause.json",
    "cat ~/.config/repo-aegis/state/decisions.jsonl.1",
    "grep -c refuse ~/.config/repo-aegis/state/decisions.jsonl",
    "repo-aegis log --help",
    "repo-aegis log --off --help",
    "repo-aegis help log",
    // an unrelated `log` and `--off`
    "git log --oneline",
    "repo-aegis audit-log off",
    "repo-aegis audit-log show",
    "git commit -m 'repo-aegis log --off is person-only'",
    "grep -rn 'log --off' doc/",
  ];
  for (const command of ALLOWED) {
    it(`allows ${JSON.stringify(command)}`, () => assert.equal(findHumanOnlyCommand(command), null));
  }

  it("the refusal is fixed text that names the verb, says why, and says the person runs it", () => {
    const text = humanCommandRefusal({ kind: "log-off" });
    assert.match(text, /repo-aegis log --off/);
    assert.match(text, /removing the data its own next refusal needs/);
    assert.match(text, /A person runs it in their own terminal/);
    assert.match(text, /\[AGENT_RAN_HUMAN_COMMAND;/);
  });

  it("the help exemption table knows the verb: `log` is how its help is asked for", () => {
    assert.deepEqual(HUMAN_VERB_PATHS["log-off"], [["log"]]);
  });
});
