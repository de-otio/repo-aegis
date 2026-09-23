// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// Subprocess tests for `repo-aegis hook egress-receipt`. The contract is
// the one line the agent reads after a command that published — and,
// just as load-bearing, the line it reads when the command did NOT.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cliBuilt, cliPath } from "../_subprocess-utils.js";

let tmp: string;
let home: string;

before(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "repo-aegis-egress-receipt-test-")));
  home = join(tmp, "aegis-home");
  mkdirSync(join(home, "state"), { recursive: true });
  writeFileSync(join(home, "engagements.yaml"), "schemaVersion: 2\nengagements: []\n");
});

after(() => {
  rmSync(tmp, { recursive: true, force: true });
});

interface RunResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

function runReceipt(input: string, cwd?: string): RunResult {
  const env: NodeJS.ProcessEnv = { ...process.env, REPO_AEGIS_HOME: home };
  delete env["REPO_AEGIS_ASSUME_PUBLIC"];
  const r = spawnSync(process.execPath, [cliPath, "hook", "egress-receipt"], {
    cwd: cwd ?? tmp,
    env,
    encoding: "utf8",
    input,
  });
  return { stdout: r.stdout, stderr: r.stderr, code: r.status };
}

function makeRepo(name: string, opts: { remote?: string; class?: string } = {}): string {
  const dir = join(tmp, name);
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q", "--initial-branch=main", dir], { stdio: "ignore" });
  if (opts.remote) {
    execFileSync("git", ["-C", dir, "config", "remote.origin.url", opts.remote], { stdio: "ignore" });
  }
  if (opts.class) {
    execFileSync("git", ["-C", dir, "config", "repo-aegis.class", opts.class], { stdio: "ignore" });
  }
  return dir;
}

function payload(command: string, output: string, cwd?: string): string {
  return JSON.stringify({
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_input: { command },
    tool_response: { stdout: "", stderr: output },
    ...(cwd !== undefined && { cwd }),
  });
}

function contextOf(r: RunResult): string {
  const j = JSON.parse(r.stdout) as {
    hookSpecificOutput: { hookEventName: string; additionalContext: string };
  };
  assert.equal(j.hookSpecificOutput.hookEventName, "PostToolUse");
  return j.hookSpecificOutput.additionalContext;
}

const SUBPROCESS_TESTS_AVAILABLE = cliBuilt();

let repo: string;

describe("hook egress-receipt — silence", { skip: !SUBPROCESS_TESTS_AVAILABLE }, () => {
  it("says nothing about a command that published nothing", () => {
    const r = runReceipt(payload("npm run build", "built ok"));
    assert.equal(r.code, 0);
    assert.equal(r.stdout, "");
    assert.equal(r.stderr, "");
  });

  it("says nothing on garbage stdin", () => {
    const r = runReceipt("not json at all {{");
    assert.equal(r.code, 0);
    assert.equal(r.stdout, "");
  });

  it("says nothing on an empty payload", () => {
    const r = runReceipt("");
    assert.equal(r.code, 0);
    assert.equal(r.stdout, "");
  });

  it("says nothing when the tool was not a shell tool", () => {
    const r = runReceipt(
      JSON.stringify({ tool_name: "Read", tool_input: { command: "git push origin main" } }),
    );
    assert.equal(r.code, 0);
    assert.equal(r.stdout, "");
  });
});

describe("hook egress-receipt — git push", { skip: !SUBPROCESS_TESTS_AVAILABLE }, () => {
  before(() => {
    repo = makeRepo("receipt-repo", {
      remote: "git@github.com:acme/svc.git",
      class: "public-eligible",
    });
  });

  it("names the destination and the refs git actually moved", () => {
    const output = [
      "Enumerating objects: 5, done.",
      "Writing objects: 100% (3/3), 285 bytes | 285.00 KiB/s, done.",
      "To github.com:acme/svc.git",
      "   1a2b3c4..5d6e7f8  main -> main",
    ].join("\n");
    const r = runReceipt(payload("git push origin main", output, repo), repo);
    assert.equal(r.code, 0);
    const ctx = contextOf(r);
    assert.match(ctx, /^PUBLISHED → acme\/svc \(/);
    assert.match(ctx, /class public-eligible/);
    assert.match(ctx, /main \(main -> main\)/);
    assert.equal(ctx.split("\n").length, 1, "one line per intent");
  });

  it("reports a new branch", () => {
    const output = ["To github.com:acme/svc.git", " * [new branch]      topic -> topic"].join("\n");
    const r = runReceipt(payload("git push origin topic", output, repo), repo);
    assert.match(contextOf(r), /topic -> topic/);
  });

  it("reports EGRESS FAILED — never a receipt — when the push was rejected", () => {
    // A receipt that claims a publish which did not happen is worse than
    // no receipt: it would stop the agent retrying and leave it believing
    // the bytes landed.
    const output = [
      "To github.com:acme/svc.git",
      " ! [rejected]        main -> main (fetch first)",
      "error: failed to push some refs to 'github.com:acme/svc.git'",
    ].join("\n");
    const r = runReceipt(payload("git push origin main", output, repo), repo);
    const ctx = contextOf(r);
    assert.match(ctx, /^EGRESS FAILED → acme\/svc/);
    assert.ok(!ctx.includes("PUBLISHED"), "must not claim a publish");
  });

  it("reports EGRESS FAILED on a fatal error", () => {
    const output = "fatal: 'origin' does not appear to be a git repository";
    const r = runReceipt(payload("git push origin main", output, repo), repo);
    assert.match(contextOf(r), /^EGRESS FAILED/);
  });

  it("treats Everything up-to-date as confirmation, and falls back to the refspec", () => {
    // Nothing travelled, but the remote provably has it: that is a
    // confirmed state, not an unknown one.
    const r = runReceipt(payload("git push origin main", "Everything up-to-date", repo), repo);
    assert.match(contextOf(r), /PUBLISHED → acme\/svc \(.*\): main$/);
  });

  it("treats an '= [up to date]' ref line as confirmation too", () => {
    const output = ["To github.com:acme/svc.git", " = [up to date]      main -> main"].join("\n");
    const r = runReceipt(payload("git push origin main", output, repo), repo);
    const ctx = contextOf(r);
    assert.match(ctx, /^PUBLISHED → acme\/svc/);
    assert.ok(!ctx.includes("main -> main"), "an up-to-date ref did not move");
  });

  it("reports EGRESS UNCONFIRMED when the output proves nothing either way", () => {
    // The 2026-09-12 case: a push that died in ssh got `PUBLISHED →`
    // because no ENGLISH failure word appeared, and absence of failure was
    // read as success. Silence is not a receipt.
    const r = runReceipt(payload("git push origin main", "", repo), repo);
    const ctx = contextOf(r);
    assert.match(ctx, /^EGRESS UNCONFIRMED → acme\/svc \(/);
    assert.match(ctx, /verify before retrying$/);
    assert.ok(!ctx.includes("PUBLISHED"), "must not claim a publish");
  });

  it("does not receipt a push that died at the ssh layer", () => {
    // `ssh_dispatch_run_fatal:` slipped past `\bfatal:` — `_` is a word
    // character, so there is no boundary before `fatal`.
    const output = [
      "ssh_dispatch_run_fatal: Connection to 140.82.121.4 port 22: Broken pipe",
      "Schwerwiegend: Konnte nicht aus dem Remote-Repository lesen.",
    ].join("\n");
    const r = runReceipt(payload("git push origin main", output, repo), repo);
    const ctx = contextOf(r);
    assert.match(ctx, /^EGRESS FAILED → acme\/svc/);
    assert.ok(!ctx.includes("PUBLISHED"), "must not claim a publish");
  });

  it("reads a rejection in a language it does not speak", () => {
    // A German git writes `[zurückgewiesen]` and `Fehler:`; no failure
    // pattern here matches either. The `!` flag and the arrow are not
    // translated, and that is what the ref table is read for.
    const output = [
      "To github.com:acme/svc.git",
      " ! [zurückgewiesen]  main -> main (nicht vorspulbar)",
      "Fehler: Fehler beim Push einiger Referenzen nach 'github.com:acme/svc.git'",
    ].join("\n");
    const r = runReceipt(payload("git push origin main", output, repo), repo);
    const ctx = contextOf(r);
    assert.match(ctx, /^EGRESS FAILED → acme\/svc/);
    assert.ok(!ctx.includes("PUBLISHED"), "must not claim a publish");
  });

  it("still reports a partly refused push as a publish, and says how partly", () => {
    const output = [
      "To github.com:acme/svc.git",
      "   1a2b3c4..5d6e7f8  topic -> topic",
      " ! [rejected]        main -> main (fetch first)",
      "error: failed to push some refs",
    ].join("\n");
    const r = runReceipt(payload("git push origin", output, repo), repo);
    const ctx = contextOf(r);
    assert.match(ctx, /^PUBLISHED → acme\/svc/);
    assert.match(ctx, /topic -> topic; 1 rejected$/);
  });

  it("believes the harness's own exit code over the absence of failure text", () => {
    const r = runReceipt(
      JSON.stringify({
        tool_name: "Bash",
        tool_input: { command: "git push origin main" },
        tool_response: { stdout: "", stderr: "", exit_code: 1 },
        cwd: repo,
      }),
      repo,
    );
    assert.match(contextOf(r), /^EGRESS FAILED → acme\/svc/);
  });

  it("repeats nothing from the tool output beyond the extracted refs", () => {
    // The output of a Bash call can contain anything the agent just read.
    // The receipt is assembled from extracted refs only.
    const output = [
      "remote: PROJECT-CODENAME internal banner, do not repeat",
      "To github.com:acme/svc.git",
      "   1a2b3c4..5d6e7f8  main -> main",
    ].join("\n");
    const r = runReceipt(payload("git push origin main", output, repo), repo);
    const ctx = contextOf(r);
    assert.ok(!ctx.includes("PROJECT-CODENAME"));
    assert.ok(!ctx.includes("internal banner"));
    assert.match(ctx, /main -> main/);
  });

  it("emits one line per intent when a command pushed twice", () => {
    const output = [
      "To github.com:acme/svc.git",
      "   1a2b3c4..5d6e7f8  main -> main",
    ].join("\n");
    const r = runReceipt(
      payload("git push origin main && git push backup main", output, repo),
      repo,
    );
    assert.equal(contextOf(r).split("\n").length, 2);
  });
});

describe("hook egress-receipt — gh verbs", { skip: !SUBPROCESS_TESTS_AVAILABLE }, () => {
  before(() => {
    repo = makeRepo("receipt-gh-repo", {
      remote: "git@github.com:acme/svc.git",
      class: "public-eligible",
    });
  });

  it("extracts the PR number from the URL gh prints", () => {
    const body = join(tmp, "pr-body.md");
    writeFileSync(body, "a body");
    const r = runReceipt(
      payload(
        `gh pr create --title x --body-file ${body} --repo acme/svc`,
        "https://github.com/acme/svc/pull/42\n",
        repo,
      ),
      repo,
    );
    const ctx = contextOf(r);
    assert.match(ctx, /^PUBLISHED → acme\/svc \(.*\): PR #42$/);
  });

  it("extracts the PR number from a root tool_result_text payload shape", () => {
    const r = runReceipt(
      JSON.stringify({
        tool_name: "Bash",
        tool_input: { command: "gh pr edit 7 --body-file /tmp/x.md --repo acme/svc" },
        tool_result_text: "https://github.com/acme/svc/pull/7",
        cwd: repo,
      }),
      repo,
    );
    assert.match(contextOf(r), /PR #7$/);
  });

  it("extracts the tag from a release URL", () => {
    const r = runReceipt(
      payload(
        "gh release create v1.2.3 --notes-file /abs/notes.md --repo acme/svc",
        "https://github.com/acme/svc/releases/tag/v1.2.3\n",
        repo,
      ),
      repo,
    );
    assert.match(contextOf(r), /tag v1\.2\.3$/);
  });

  it("falls back to the verb label when nothing identifiable was printed", () => {
    // A verb with no success output of its own keeps the old rule: there is
    // no evidence to require, so the failure scan is the only test there is.
    const r = runReceipt(
      payload("gh issue create --title x --body-file /abs/b.md --repo acme/svc", "", repo),
      repo,
    );
    const ctx = contextOf(r);
    assert.match(ctx, /^PUBLISHED → acme\/svc/);
    assert.match(ctx, /gh issue create$/);
  });

  it("reports EGRESS UNCONFIRMED when gh printed no PR URL and no error", () => {
    // `gh pr create` prints the URL on success and nothing on some
    // failures; without the URL there is no evidence a PR exists.
    const r = runReceipt(
      payload("gh pr create --title x --body-file /abs/b.md --repo acme/svc", "", repo),
      repo,
    );
    const ctx = contextOf(r);
    assert.match(ctx, /^EGRESS UNCONFIRMED → acme\/svc/);
    assert.ok(!ctx.includes("PUBLISHED"), "must not claim a publish");
  });

  it("reports EGRESS FAILED when gh refused", () => {
    const r = runReceipt(
      payload(
        "gh pr create --title x --body-file /abs/b.md --repo acme/svc",
        "error: could not create pull request",
        repo,
      ),
      repo,
    );
    assert.match(contextOf(r), /^EGRESS FAILED/);
  });

  it("gh api: the receipt names the repository in the API path, not the cwd's origin", () => {
    // The 2026-09-12 receipt read `PUBLISHED → <the cwd's private repo>` for a
    // merge into a different, public one. The path names the destination.
    const elsewhere = makeRepo("receipt-gh-api-cwd", {
      remote: "git@github.com:acme/notes.git",
      class: "private-strict",
    });
    const r = runReceipt(
      payload(
        "gh api -X PUT repos/acme/svc/pulls/103/merge -f merge_method=squash",
        '{"sha":"abc","merged":true}\n',
        elsewhere,
      ),
      elsewhere,
    );
    assert.match(contextOf(r), /^PUBLISHED → acme\/svc \(.*\): gh api \(mutating\)$/);
  });

  it("gh api graphql: a mutation's receipt says UNKNOWN, not the cwd's repository (#113)", () => {
    // The mutation names its target by node id; nothing offline can say
    // which repository that is, and the cwd is certainly not the answer.
    const elsewhere = makeRepo("receipt-gh-graphql-cwd", {
      remote: "git@github.com:acme/notes.git",
      class: "private-strict",
    });
    const r = runReceipt(
      payload(
        "gh api graphql -F id=PR_kwDOAAAAAA -f query='mutation($id: ID!) { enqueuePullRequest(input: {pullRequestId: $id}) { clientMutationId } }'",
        '{"data":{"enqueuePullRequest":{"clientMutationId":null}}}\n',
        elsewhere,
      ),
      elsewhere,
    );
    const ctx = contextOf(r);
    assert.equal(
      ctx,
      "PUBLISHED → UNKNOWN (GRAPHQL MUTATION TARGET NOT RESOLVED, TREATED AS PUBLIC): gh api (mutating)",
    );
    assert.ok(!ctx.includes("acme/notes"), ctx);
  });
});
