// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// Issue #151, PR 2a — the wiring: the `gh` shim and the agent hook hand the
// parser the environment `gh` will run in (GH_REPO, the alias file), and the
// parser's attached-flag and positional fixes reach the verdict. Subprocess
// tests, because the contract is the process contract.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cliBuilt, cliPath } from "../_subprocess-utils.js";

let tmp: string;
let home: string;
let repo: string;
let ghConfig: string;

before(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "repo-aegis-parse-env-test-")));
  home = join(tmp, "aegis");
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "engagements.yaml"), "schemaVersion: 2\nengagements: []\n");
  // A checkout recorded as private: with nothing else in the command, publishing from it is allowed.
  repo = join(tmp, "internal");
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", "--initial-branch=main", repo], { stdio: "ignore" });
  execFileSync("git", ["-C", repo, "config", "remote.origin.url", "git@github.com:acme/internal.git"], { stdio: "ignore" });
  execFileSync("git", ["-C", repo, "config", "repo-aegis.class", "private-strict"], { stdio: "ignore" });
  execFileSync("git", ["-C", repo, "config", "repo-aegis.visibility", "private"], { stdio: "ignore" });
  ghConfig = join(tmp, "gh");
  mkdirSync(ghConfig);
  writeFileSync(join(ghConfig, "config.yml"), "aliases:\n    ic: issue create\n    sh: '!echo hi'\n");
});

after(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function scrubbedEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, REPO_AEGIS_HOME: home, ...extra };
  for (const k of ["REPO_AEGIS_EGRESS_HUMAN", "REPO_AEGIS_ASSUME_PUBLIC", "GH_REPO", "GH_CONFIG_DIR"]) {
    if (!(k in extra)) delete env[k];
  }
  return env;
}

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

function shim(args: string[], env: Record<string, string> = {}): Run {
  const r = spawnSync(process.execPath, [cliPath, "egress-check", "--cwd", repo, "--", ...args], {
    cwd: repo,
    env: scrubbedEnv(env),
    encoding: "utf8",
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

function hook(command: string, env: Record<string, string> = {}): Run {
  const r = spawnSync(process.execPath, [cliPath, "hook", "guard-egress"], {
    cwd: repo,
    env: scrubbedEnv(env),
    encoding: "utf8",
    input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, cwd: repo }),
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** The destination a refused shim call names, or null when the call was allowed. */
function shimRefusal(r: Run): { code: string; org?: string } | null {
  if (r.code === 0) return null;
  const p = JSON.parse(r.stderr.trim()) as { code: string; details: { destination?: { org: string } } };
  return { code: p.code, ...(p.details.destination && { org: p.details.destination.org }) };
}

const AVAILABLE = cliBuilt();

describe("gh shim — the parser sees the environment gh will run in", { skip: !AVAILABLE }, () => {
  it("baseline: an implicit target in the private checkout is allowed", () => {
    assert.equal(shimRefusal(shim(["issue", "create", "--title", "t", "--body", "b"])), null);
  });

  it("GH_REPO in the shim's own environment redirects the destination (S2)", () => {
    const refusal = shimRefusal(shim(["issue", "create", "--title", "t", "--body", "b"], { GH_REPO: "stranger/r" }));
    assert.ok(refusal, "a stranger's repository must not be judged as the private checkout");
    assert.equal(refusal.org, "stranger");
  });

  it("an attached -R names the stranger (F1)", () => {
    const refusal = shimRefusal(shim(["issue", "create", "-Rstranger/r", "--title", "t", "--body", "b"]));
    assert.ok(refusal);
    assert.equal(refusal.org, "stranger");
  });

  it("a PR URL positional names the stranger (S3)", () => {
    const refusal = shimRefusal(shim(["pr", "comment", "https://github.com/stranger/r/pull/5", "--body", "b"]));
    assert.ok(refusal);
    assert.equal(refusal.org, "stranger");
  });

  it("an attached -X on gh api is an intent again, naming the path's repository (F1)", () => {
    const refusal = shimRefusal(shim(["api", "-XPOST", "repos/stranger/r/issues", "-fbody=hi"]));
    assert.ok(refusal, "was: no intent at all, so the call was never judged");
    assert.equal(refusal.org, "stranger");
  });

  it("a gh alias is expanded from GH_CONFIG_DIR before classification (S11)", () => {
    const refusal = shimRefusal(shim(["ic", "-Rstranger/r", "--title", "t", "--body", "b"], { GH_CONFIG_DIR: ghConfig }));
    assert.ok(refusal);
    assert.equal(refusal.org, "stranger");
  });

  it("a shell alias is refused as unresolved: the script cannot be read", () => {
    const refusal = shimRefusal(shim(["sh"], { GH_CONFIG_DIR: ghConfig }));
    assert.ok(refusal);
    assert.equal(refusal.org, "*");
  });

  it("without the alias file, `ic` is an unknown word: it may be an alias this guard cannot read, so it is unresolved", () => {
    const refusal = shimRefusal(shim(["ic", "-Rstranger/r"], { GH_CONFIG_DIR: join(tmp, "no-such-dir") }));
    assert.ok(refusal);
    assert.equal(refusal.org, "*");
  });
});

describe("receipt hook — the same environment-aware parse as the guard (L1)", { skip: !AVAILABLE }, () => {
  function receipt(command: string, output: string, env: Record<string, string>): string {
    const r = spawnSync(process.execPath, [cliPath, "hook", "egress-receipt"], {
      cwd: repo,
      env: scrubbedEnv(env),
      encoding: "utf8",
      input: JSON.stringify({
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_input: { command },
        tool_response: { stdout: "", stderr: output },
        cwd: repo,
      }),
    });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
  }

  it("a GH_REPO in the hook's environment names the destination in the receipt", () => {
    const out = receipt("gh issue create --title t --body b", "https://github.com/stranger/r/issues/7", { GH_REPO: "stranger/r" });
    assert.match(out, /stranger\/r/);
    assert.ok(!out.includes("acme/internal"), out);
  });

  it("an alias is expanded from the hook's GH_CONFIG_DIR", () => {
    const out = receipt("gh ic -Rstranger/r --title t --body b", "https://github.com/stranger/r/issues/7", { GH_CONFIG_DIR: ghConfig });
    assert.match(out, /stranger\/r/);
    assert.ok(!out.includes("acme/internal"), out);
  });
});

describe("agent hook — the same parser, the hook's own environment", { skip: !AVAILABLE }, () => {
  it("baseline: an implicit target in the private checkout passes silently", () => {
    const r = hook("gh issue create --title t --body b");
    assert.equal(r.code, 0);
    assert.equal(r.stdout, "");
  });

  it("a prefix GH_REPO names the stranger (S2)", () => {
    const r = hook("GH_REPO=stranger/r gh issue create --title t --body b");
    assert.notEqual(r.stdout + r.stderr, "", "must not pass silently");
    assert.match(r.stdout + r.stderr, /stranger\/r/);
  });

  it("an export in an earlier segment is refused as unresolved", () => {
    const r = hook("export GH_REPO=stranger/r && gh issue create --title t --body b");
    assert.notEqual(r.stdout + r.stderr, "", "must not pass silently");
    assert.match(r.stdout + r.stderr, /env-override/);
  });

  it("the hook's inherited GH_REPO applies too", () => {
    const r = hook("gh issue create --title t --body b", { GH_REPO: "stranger/r" });
    assert.match(r.stdout + r.stderr, /stranger\/r/);
  });

  it("an attached -R and a URL positional are judged against the stranger", () => {
    assert.match(hook("gh issue create -Rstranger/r --title t --body b").stdout, /stranger\/r/);
    const url = hook("gh pr comment https://github.com/stranger/r/pull/5 --body b");
    assert.match(url.stdout + url.stderr, /stranger\/r/);
  });

  it("gh api -XPOST is judged (was: no intent, silent pass)", () => {
    const r = hook("gh api -XPOST repos/stranger/r/issues -fbody=hi");
    assert.match(r.stdout + r.stderr, /stranger\/r/);
  });

  it("an alias is expanded from the hook's GH_CONFIG_DIR", () => {
    const r = hook("gh ic -Rstranger/r --title t --body b", { GH_CONFIG_DIR: ghConfig });
    assert.match(r.stdout + r.stderr, /stranger\/r/);
  });
});
