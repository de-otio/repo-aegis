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
import { scrubGitEnv } from "../_test-utils.js";
import { cliBuilt, cliPath } from "../_subprocess-utils.js";
import { assertGoldenComplete, golden, HOST_FIXTURES_DIR } from "./hook-hosts/_golden.js";
import { FIXTURE_CWD, loadFixture, loadFixtureIndex, withCommand } from "./hook-hosts/_fixtures.js";

const SUITE = "hook-guard-egress-hosts";

/** Probe commands: one per decision path the hook has. */
const PROBES: ReadonlyArray<readonly [label: string, command: string]> = [
  ["non-egress", "echo hello"],
  ["bare push (shape deny)", "git push"],
  ["egress after cd (shape deny)", "cd sub && git push origin main"],
  ["explicit push to a public destination (ask, or deny without ask)", "git push origin main"],
  ["human-only command", "repo-aegis approve '*'"],
  ["raw API write (R6)", "curl -X POST https://api.github.com/repos/acme/svc/issues -d @body.json"],
];

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

    it(`${f.file}: the fixture as captured is silent (exit 0, no output)`, () => {
      const r = run(JSON.stringify(payload).split(FIXTURE_CWD).join(repo), f.agent, "as-captured");
      assert.equal(r.code, 0, r.stderr);
      assert.equal(r.stdout, "");
      assert.equal(r.stderr, "");
    });

    if (f.commandPath === null) continue;
    for (const [label, command] of PROBES) {
      it(`${f.file}: ${label}`, () => {
        const input = JSON.stringify(withCommand(payload, f.commandPath!, command)).split(FIXTURE_CWD).join(repo);
        const r = run(input, f.agent, label);
        assertDecisionOnly(r, `${f.file} ${label}`);
        if (label === "non-egress") {
          assert.equal(r.code, 0);
          assert.equal(r.stdout, "", "cheap and silent on non-egress (invariant 2)");
          assert.equal(r.stderr, "");
        }
        // A guard error is exit 1; nothing here may provoke one.
        assert.notEqual(r.code, 1, `${f.file} ${label}: internal error\n${r.stderr}`);
      });
    }
  }

  for (const agent of ["claude", "codex", "gemini", "cursor", "copilot", "antigravity"]) {
    for (const [label, input] of MALFORMED) {
      it(`--agent ${agent}: ${label} fails open, silently`, () => {
        const r = run(input, agent, `malformed: ${label}`);
        assert.equal(r.code, 0);
        assert.equal(r.stdout, "");
        assert.equal(r.stderr, "");
      });
    }
  }
});
