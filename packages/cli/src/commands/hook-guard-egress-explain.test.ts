// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// An agent may run the two read-only commands a refusal sends it to (`explain`, `identity list`), through the
// real `hook guard-egress`, while the mutating identity and approval commands stay refused. Kept apart from
// hook-guard-egress-human.test.ts so the golden recordings there are not touched.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cliBuilt, cliPath } from "../_subprocess-utils.js";
import { scrubGitEnv } from "../_test-utils.js";

let restoreGitEnv: () => void;
let tmp: string;
let home: string;
before(() => {
  restoreGitEnv = scrubGitEnv();
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "repo-aegis-guard-explain-test-")));
  home = join(tmp, "aegis");
  mkdirSync(join(home, "markers"), { recursive: true });
  mkdirSync(join(home, "state"), { recursive: true });
  writeFileSync(join(home, "engagements.yaml"), "schemaVersion: 2\npersonalOrgs:\n  - example-org\nengagements: []\n");
});
after(() => {
  restoreGitEnv();
  rmSync(tmp, { recursive: true, force: true });
});

function guard(command: string): { code: number | null; stdout: string; stderr: string } {
  const env: NodeJS.ProcessEnv = { ...process.env, REPO_AEGIS_HOME: home, REPO_AEGIS_VISIBILITY_LOOKUP: "0" };
  delete env["REPO_AEGIS_EGRESS_HUMAN"];
  delete env["REPO_AEGIS_ASSUME_PUBLIC"];
  const r = spawnSync(process.execPath, [cliPath, "hook", "guard-egress"], {
    cwd: tmp,
    env,
    encoding: "utf8",
    input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, cwd: tmp }),
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe("hook guard-egress: read-only commands an agent is sent to", { skip: !cliBuilt() }, () => {
  const ALLOWED = [
    "repo-aegis explain GH_IDENTITY_WRITE_NEEDS_HUMAN",
    "repo-aegis explain AGENT_RAN_HUMAN_COMMAND --json",
    "repo-aegis explain --list",
    "node /opt/repo-aegis/packages/cli/dist/index.js explain UNREGISTERED_OWNER_EGRESS",
    "npx -y @de-otio/repo-aegis explain GH_IDENTITY_UNAVAILABLE",
    "repo-aegis identity list",
    "repo-aegis identity list --json",
    "repo-aegis --json identity list",
  ];
  for (const command of ALLOWED) {
    it(`does not refuse: ${command}`, () => {
      const r = guard(command);
      assert.equal(r.code, 0, `${command}\n${r.stderr}`);
      assert.doesNotMatch(r.stdout + r.stderr, /AGENT_RAN_HUMAN_COMMAND|"deny"|"ask"/);
    });
  }

  // The same family, mutating or minting: still a person's.
  const REFUSED = [
    "repo-aegis identity add work --gh-login alice",
    "repo-aegis identity remove work",
    "repo-aegis identity require --off",
    "repo-aegis identity list add work --gh-login alice",
    "repo-aegis identity list; repo-aegis identity add work --gh-login alice",
    "repo-aegis engagements set-identity customer-a --person work",
    "repo-aegis engagements set-identity --personal-org example-org --agent work-bot",
    "repo-aegis approve example-org/svc",
    "repo-aegis approve 'example-org/*' --ttl 1h",
    "repo-aegis explain GH_IDENTITY_WRITE_NEEDS_HUMAN && repo-aegis approve example-org/svc",
  ];
  for (const command of REFUSED) {
    it(`still refuses: ${command}`, () => {
      const r = guard(command);
      assert.equal(r.code, 2, `${command}\n${r.stderr}`);
      assert.equal((JSON.parse(r.stderr) as { code: string }).code, "AGENT_RAN_HUMAN_COMMAND");
    });
  }
});
