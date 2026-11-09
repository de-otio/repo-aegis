// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// `hook guard-egress` and prompt approvals (doc/design/egress-guard.md §4a.1), against the BUILT hook with a temp
// REPO_AEGIS_HOME.
//
// The hook asks; if the host is Claude Code in a permission mode where a person answers, it records one short-lived
// approval for exactly the command it asked about, so the layers below the prompt can honour that yes. Two things
// must hold, and most of these tests exist for them:
//
//   - F9: in `auto`, `bypassPermissions`, `plan`, `dontAsk` (or any mode the hook does not know, or none) nobody
//     answered the prompt, so NOTHING is written and the prompt says so;
//   - F1: the hook NEVER reads a prompt record. The record is written before the person answers, so after a "no" it
//     is still live; a second, different command to the same repository must still ask.
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { listPromptApprovals, promptApprovalsDir, recordPromptApproval, auditLogPath } from "@de-otio/repo-aegis-core";
import { cliBuilt, cliPath } from "../_subprocess-utils.js";
import { scrubGitEnv } from "../_test-utils.js";
import { FIXTURE_CWD, loadFixture, loadFixtureIndex, withCommand } from "./hook-hosts/_fixtures.js";

let restoreGitEnv: () => void;
let tmp: string;
let repo: string;
let home: string;
let n = 0;

before(() => {
  restoreGitEnv = scrubGitEnv();
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "repo-aegis-guard-prompt-test-")));
  repo = join(tmp, "repo");
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-q", "--initial-branch=main", repo], { stdio: "ignore" });
  execFileSync("git", ["-C", repo, "config", "remote.origin.url", "git@github.com:acme/svc.git"], { stdio: "ignore" });
  execFileSync("git", ["-C", repo, "config", "repo-aegis.class", "public-eligible"], { stdio: "ignore" });
});
after(() => {
  restoreGitEnv();
  rmSync(tmp, { recursive: true, force: true });
});

/** A fresh home each test: no registry owners (rule h stays out of the way), the gh shim file in place, audit on. */
beforeEach(() => {
  home = join(tmp, `home-${n++}`);
  mkdirSync(join(home, "markers"), { recursive: true });
  mkdirSync(join(home, "state"), { recursive: true });
  mkdirSync(join(home, "bin"), { recursive: true });
  writeFileSync(join(home, "engagements.yaml"), "schemaVersion: 2\nengagements: []\n");
  writeFileSync(join(home, "bin", "gh"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(home, "bin", "gh"), 0o755);
  writeFileSync(join(home, "state", "audit-log.json"), JSON.stringify({ enabled: true }));
});

interface Run {
  stdout: string;
  stderr: string;
  code: number | null;
  decision: "allow" | "ask" | "deny" | "silent";
  reason: string;
}

function hook(input: unknown, agent = "claude"): Run {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    REPO_AEGIS_HOME: home,
    REPO_AEGIS_VISIBILITY_LOOKUP: "0",
    // The shim is first on PATH, so a `gh` verb can ask rather than be refused as unreachable.
    PATH: `${join(home, "bin")}${delimiter}${process.env["PATH"] ?? ""}`,
  };
  delete env["REPO_AEGIS_EGRESS_HUMAN"];
  delete env["REPO_AEGIS_ASSUME_PUBLIC"];
  const r = spawnSync(process.execPath, [cliPath, "hook", "guard-egress", "--agent", agent], {
    cwd: tmp,
    env,
    encoding: "utf8",
    input: JSON.stringify(input),
  });
  let decision: Run["decision"] = "silent";
  let reason = "";
  if (r.stdout !== "") {
    const out = JSON.parse(r.stdout) as Record<string, unknown>;
    const spec = out["hookSpecificOutput"] as { permissionDecision?: Run["decision"]; permissionDecisionReason?: string } | undefined;
    decision = spec?.permissionDecision ?? ((out["permission"] ?? out["permissionDecision"]) as Run["decision"]);
    reason = spec?.permissionDecisionReason ?? String(out["userMessage"] ?? out["permissionDecisionReason"] ?? "");
  }
  return { stdout: r.stdout, stderr: r.stderr, code: r.status, decision, reason };
}

/** What Claude Code sends for a Bash call. `mode` undefined leaves `permission_mode` out. */
function claude(command: string, mode?: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    session_id: "sess-0123",
    cwd: repo,
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command },
    ...(mode !== undefined && { permission_mode: mode }),
    ...extra,
  };
}

const records = () => listPromptApprovals(home);
const PUSH = "git push origin main";
const PR = "gh pr create --repo acme/svc --body x";
const noDir = () => assert.equal(existsSync(promptApprovalsDir(home)), false, "no prompt-approvals directory");

describe("hook guard-egress: prompt approvals are written for an ask in a mode where a person answers", { skip: !cliBuilt() }, () => {
  it("default: one record with verb, org/repo and destination ref, and the prompt says what a yes carries", () => {
    const r = hook(claude(PUSH, "default"));
    assert.equal(r.decision, "ask", r.stdout + r.stderr);
    assert.equal(r.code, 0);
    const [a, ...rest] = records();
    assert.equal(rest.length, 0, "exactly one record");
    assert.equal(a?.verb, "git-push");
    assert.equal(a?.org, "acme");
    assert.equal(a?.repo, "svc");
    assert.equal(a?.ref, "main");
    assert.equal(a?.permissionMode, "default");
    assert.equal(a?.session, "sess-0123");
    assert.match(a?.id ?? "", /^p[0-9a-f]{8}$/);
    assert.match(
      r.reason,
      /A yes here lets this git push to acme\/svc ref main through git's pre-push hook for 2 minutes; any other command asks again\./,
    );
  });

  it("acceptEdits: written too", () => {
    const r = hook(claude(PUSH, "acceptEdits"));
    assert.equal(r.decision, "ask");
    assert.equal(records().length, 1);
    assert.equal(records()[0]?.permissionMode, "acceptEdits");
  });

  it("the ref is the DESTINATION: HEAD:<branch> binds the branch, bare HEAD binds the current branch", () => {
    hook(claude("git push origin HEAD:release", "default"));
    hook(claude("git push origin HEAD", "default"));
    hook(claude("git push origin +feat:refs/heads/rel", "default"));
    assert.deepEqual(records().map(a => a.ref).sort(), ["main", "release", "rel"].sort());
  });

  it("a gh verb is bound to the verb and the repository, and the prompt names the shim", () => {
    const r = hook(claude(PR, "default"));
    assert.equal(r.decision, "ask", r.stdout + r.stderr);
    const [a] = records();
    assert.equal(a?.verb, "gh-pr-create");
    assert.equal(a?.repo, "svc");
    assert.equal(a?.ref, undefined);
    assert.match(r.reason, /A yes here lets this gh pr create to acme\/svc through the gh shim for 2 minutes/);
  });

  it("a compound push and PR writes one record per ask, and the prompt names both", () => {
    const r = hook(claude(`${PUSH} && ${PR}`, "default"));
    assert.equal(r.decision, "ask", r.stdout + r.stderr);
    assert.deepEqual(records().map(a => a.verb).sort(), ["gh-pr-create", "git-push"]);
    assert.match(r.reason, /this git push to acme\/svc ref main and this gh pr create to acme\/svc/);
  });
});

describe("hook guard-egress: no record where nobody answered the prompt (F9)", { skip: !cliBuilt() }, () => {
  const NO_CARRY = /In this permission mode a yes does not reach the layers below; a person mints `repo-aegis approve acme\/svc` from a terminal\./;

  for (const mode of ["auto", "bypassPermissions", "plan", "dontAsk", "", "Default", "default ", "ACCEPTEDITS", "x".repeat(65)]) {
    it(`permission_mode ${JSON.stringify(mode.length > 20 ? "(65 chars)" : mode)}: asks, writes nothing, says so`, () => {
      const r = hook(claude(PUSH, mode));
      assert.equal(r.decision, "ask", r.stdout + r.stderr);
      noDir();
      assert.match(r.reason, NO_CARRY);
      assert.doesNotMatch(r.reason, /A yes here lets/);
    });
  }

  it("no permission_mode at all, or one that is not a string: asks, writes nothing, says so", () => {
    for (const mode of [undefined, 7, null, true, ["default"], { mode: "default" }]) {
      const r = hook(claude(PUSH, mode));
      assert.equal(r.decision, "ask", String(mode));
      assert.match(r.reason, NO_CARRY, String(mode));
    }
    noDir();
  });
});

describe("hook guard-egress: what is never recorded", { skip: !cliBuilt() }, () => {
  it("an ask whose destination cannot be named offline (a GraphQL mutation) writes nothing", () => {
    const r = hook(claude("gh api graphql -f query='mutation { addComment(input: {}) { clientMutationId } }'", "default"));
    assert.equal(r.decision, "ask", r.stdout + r.stderr);
    noDir();
    assert.doesNotMatch(r.reason, /A yes here lets/);
  });

  it("a deny writes nothing (a bare push is refused before any ask)", () => {
    const r = hook(claude("git push", "default"));
    assert.equal(r.decision, "deny");
    noDir();
  });

  it("an allow writes nothing (not egress)", () => {
    const r = hook(claude("echo hello", "default"));
    assert.equal(r.decision, "silent");
    noDir();
  });

  it("Copilot and Cursor can ask, but their payloads carry no Claude permission mode that counts: nothing is written", () => {
    const wanted = loadFixtureIndex().filter(f =>
      ["copilot.pre-tool-use.camel.json", "copilot.pre-tool-use.pascal.json", "cursor.before-shell-execution.json"].includes(f.file),
    );
    assert.equal(wanted.length, 3);
    for (const f of wanted) {
      const payload = withCommand(loadFixture(f), f.commandPath!, PUSH) as Record<string, unknown>;
      const input = { ...payload, permission_mode: "default", permissionMode: "default" };
      const r = hook(JSON.parse(JSON.stringify(input).split(FIXTURE_CWD).join(repo)), f.agent);
      assert.equal(r.decision, "ask", `${f.file}\n${r.stdout}${r.stderr}`);
      noDir();
      assert.doesNotMatch(r.reason, /A yes here lets|permission mode/, f.file);
    }
  });

  it("Codex (which has no ask) denies and writes nothing, even with permission_mode default", () => {
    const f = loadFixtureIndex().find(x => x.file === "codex.pre-tool-use.json")!;
    const payload = withCommand(loadFixture(f), f.commandPath!, PUSH);
    const r = hook(JSON.parse(JSON.stringify(payload).split(FIXTURE_CWD).join(repo)), "codex");
    assert.equal(r.decision, "deny", r.stdout + r.stderr);
    assert.equal(r.code, 2);
    noDir();
  });
});

describe("hook guard-egress: a record never turns the hook's own ask into an allow (F1)", { skip: !cliBuilt() }, () => {
  const seed = (b: Parameters<typeof recordPromptApproval>[0]["binding"]) =>
    assert.ok(recordPromptApproval({ binding: b, permissionMode: "default", home }));

  it("a no, then a DIFFERENT command to the same repository: still asks (a pr-create record vs a push, and the reverse)", () => {
    seed({ verb: "gh-pr-create", org: "acme", repo: "svc" });
    const push = hook(claude(PUSH, "default"));
    assert.equal(push.decision, "ask", `a gh-pr-create record must not let a push through: ${push.stdout}${push.stderr}`);

    const home2 = home;
    seed({ verb: "git-push", org: "acme", repo: "svc", ref: "main" });
    const pr = hook(claude(PR, "default"));
    assert.equal(pr.decision, "ask", `a git-push record must not let a PR through: ${pr.stdout}${pr.stderr}`);
    assert.equal(home2, home);
  });

  it("even the IDENTICAL command, with an exactly matching record already live, asks: the hook never reads records", () => {
    seed({ verb: "gh-pr-create", org: "acme", repo: "svc" });
    const r = hook(claude(PR, "default"));
    assert.equal(r.decision, "ask", r.stdout + r.stderr);
    seed({ verb: "git-push", org: "acme", repo: "svc", ref: "main" });
    assert.equal(hook(claude(PUSH, "default")).decision, "ask");
  });

  it("a yes to a PR, then a push to the same repository: the hook asks again, with its own record (the pre-push half is in check-egress.test.ts)", () => {
    assert.equal(hook(claude(PR, "default")).decision, "ask");
    assert.equal(hook(claude(PUSH, "default")).decision, "ask");
    assert.deepEqual(records().map(a => a.verb).sort(), ["gh-pr-create", "git-push"]);
  });
});

describe("hook guard-egress: failures and the audit trail", { skip: !cliBuilt() }, () => {
  it("a home whose prompt-approvals cannot be written: still `ask`, one stderr line, exit 0, and the prompt says a yes will not carry", () => {
    // A regular file where the directory should be: mkdir fails.
    writeFileSync(join(home, "prompt-approvals"), "in the way");
    const r = hook(claude(PUSH, "default"));
    assert.equal(r.decision, "ask", r.stdout + r.stderr);
    assert.equal(r.code, 0);
    assert.equal(r.stderr.trim().split("\n").length, 1, r.stderr);
    assert.match(r.stderr, /could not record a prompt approval/);
    assert.match(r.reason, /a yes does not reach the layers below/);
  });

  it("each record is audited as an egress-approval-mint with source prompt, and never carries the command text", () => {
    const secret = "secret-body-text-xyz";
    const r = hook(claude(`git push origin main && gh pr create --repo acme/svc --body ${secret}`, "default"));
    assert.equal(r.decision, "ask", r.stdout + r.stderr);
    const lines = readFileSync(auditLogPath(home), "utf8").trim().split("\n");
    const mints = lines
      .map(l => JSON.parse(l) as { action: string; details: Record<string, unknown> })
      .filter(l => l.action === "egress-approval-mint");
    assert.equal(mints.length, 2);
    const push = mints.find(m => m.details["verb"] === "git-push")!;
    assert.equal(push.details["source"], "prompt");
    assert.equal(push.details["scope"], "acme/svc");
    assert.equal(push.details["ref"], "main");
    assert.equal(push.details["permissionMode"], "default");
    assert.equal(push.details["layer"], "hook guard-egress");
    assert.match(String(push.details["id"]), /^p[0-9a-f]{8}$/);
    assert.ok(Date.parse(String(push.details["expiresAt"])) > Date.now() - 1000);
    assert.ok(!lines.join("\n").includes(secret), "no command text in the audit log");
  });

  it("with no mode that counts, nothing is audited as a mint", () => {
    hook(claude(PUSH, "auto"));
    const log = existsSync(auditLogPath(home)) ? readFileSync(auditLogPath(home), "utf8") : "";
    assert.doesNotMatch(log, /egress-approval-mint/);
  });
});
