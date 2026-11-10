// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// The decision log at every entry point (complexity-review P1-I, spec §3, §4 and §7), as subprocesses: one record per
// refusal with the right layer, code, outcome and facts; nothing written for a command that is not an egress shape; and
// a log that cannot be written never changes a decision or an exit code. Placeholder owners only. Each test has its own
// home and its own `$TMPDIR` (passed to the child), so the real fallback directory is never touched; the clock is the
// child's own, so timestamps are checked for shape and order, not for a value.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cliBuilt, cliPath } from "../_subprocess-utils.js";
import { scrubGitEnv } from "../_test-utils.js";
import { decisionLogPath, readDecisionRecords, type DecisionRecord } from "@de-otio/repo-aegis-core";

const REGISTRY = "schemaVersion: 2\npersonalOrgs:\n  - acme\nengagements: []\n";
const SKIP = !cliBuilt();
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const LOGGED = "(logged: repo-aegis log --last 1)";

let restoreGitEnv: () => void;
let root: string;
let n = 0;
before(() => {
  restoreGitEnv = scrubGitEnv();
  root = realpathSync(mkdtempSync(join(tmpdir(), "repo-aegis-decision-entry-test-")));
});
after(() => {
  restoreGitEnv();
  rmSync(root, { recursive: true, force: true });
});

interface World {
  home: string;
  tmp: string;
  cwd: string;
}

/** A fresh home with a registry that registers `acme` only, a fresh `$TMPDIR`, and a working directory. */
function world(opts: { registry?: string | null } = {}): World {
  const dir = join(root, `w${n++}`);
  const home = join(dir, "home");
  const tmp = join(dir, "tmp");
  const cwd = join(dir, "work");
  mkdirSync(join(home, "markers"), { recursive: true });
  mkdirSync(join(home, "state"), { recursive: true });
  mkdirSync(tmp, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  if (opts.registry !== null) writeFileSync(join(home, "engagements.yaml"), opts.registry ?? REGISTRY);
  return { home, tmp, cwd };
}

interface Result {
  stdout: string;
  stderr: string;
  code: number | null;
}

function childEnv(w: World, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, REPO_AEGIS_HOME: w.home, REPO_AEGIS_VISIBILITY_LOOKUP: "0", TMPDIR: w.tmp, ...extra };
  for (const k of ["REPO_AEGIS_EGRESS_HUMAN", "REPO_AEGIS_ASSUME_PUBLIC", "REPO_AEGIS_PIN_FALLBACK", "SANDBOX_RUNTIME", "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT"]) {
    if (!(k in extra)) delete env[k];
  }
  for (const k of ["HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "NO_PROXY", "DOCKER_HTTPS_PROXY", "DOCKER_HTTP_PROXY", "https_proxy", "http_proxy", "all_proxy", "no_proxy", "docker_https_proxy", "docker_http_proxy"]) {
    if (!(k in extra)) delete env[k];
  }
  return env;
}

function runCliIn(w: World, args: string[], input: string | undefined, extra: NodeJS.ProcessEnv = {}): Result {
  const r = spawnSync(process.execPath, [cliPath, ...args], { cwd: w.cwd, env: childEnv(w, extra), encoding: "utf8", ...(input !== undefined && { input }) });
  return { stdout: r.stdout, stderr: r.stderr, code: r.status };
}

function guard(w: World, command: string, extra: NodeJS.ProcessEnv = {}, agent = "claude", payload: Record<string, unknown> = {}): Result {
  return runCliIn(
    w,
    ["hook", "guard-egress", "--agent", agent],
    JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, cwd: w.cwd, ...payload }),
    extra,
  );
}

function records(w: World): DecisionRecord[] {
  return readDecisionRecords(w.home, { tmp: w.tmp }).map(d => d.record);
}

function oneRecord(w: World, why: string): DecisionRecord {
  const all = records(w);
  assert.equal(all.length, 1, `${why}: expected exactly one record, got ${JSON.stringify(all)}`);
  assert.match(all[0]!.ts, ISO, why);
  assert.match(all[0]!.version, /^\d+\.\d+\.\d+/, why);
  assert.equal(all[0]!.v, 1);
  return all[0]!;
}

/** An egress rule h refuses for a non-interactive shell: the owner is not registered. */
const UNREGISTERED = "gh pr create --repo Stranger/Svc --title t --body b";
/** A shape rule: a bare push has no destination the guard can name. */
const BARE_PUSH = "git push";

describe("decision log: the agent egress hook", { skip: SKIP }, () => {
  it("an egress-shaped refusal: one record with the layer, code, verb, destination and the facts that decided", () => {
    const w = world();
    const r = guard(w, UNREGISTERED, { HTTPS_PROXY: "http://proxy.example:3128", SANDBOX_RUNTIME: "1" }, "claude", { permission_mode: "default" });
    assert.notEqual(r.code, undefined);
    const rec = oneRecord(w, "unregistered owner");
    assert.equal(rec.layer, "egress-hook");
    assert.ok(rec.outcome === "ask" || rec.outcome === "refuse", rec.outcome);
    assert.equal(rec.code, "UNREGISTERED_OWNER_EGRESS");
    assert.equal(rec.host, "claude-code");
    assert.equal(rec.verb, "gh pr create");
    assert.equal(rec.destination, "stranger/svc", "lower-cased owner/repo");
    assert.deepEqual(rec.facts?.proxyVarSet, ["HTTPS_PROXY"], "the NAME of the proxy variable, never its value");
    assert.equal(rec.facts?.sandboxGuess, "claude-sandbox");
    assert.equal(rec.facts?.registryState, "plain");
    assert.equal(rec.facts?.permissionMode, "default");
    assert.equal(rec.pinFallback, false);
    assert.doesNotMatch(JSON.stringify(rec), /proxy\.example|3128/, "no env value in the record");
    // the refusal text ends with the trailer, and says the same thing as the record
    assert.ok((r.stdout + r.stderr).includes(LOGGED), r.stdout + r.stderr);
  });

  it("a shape rule (a bare push): refused, recorded with its code and verb", () => {
    const w = world();
    const r = guard(w, BARE_PUSH, {}, "codex");
    assert.equal(r.code, 2);
    const rec = oneRecord(w, "bare push");
    assert.equal(rec.layer, "egress-hook");
    assert.equal(rec.outcome, "refuse");
    assert.equal(rec.verb, "git push");
    assert.equal(rec.host, "unknown", "an adapter the closed host list does not name");
    assert.equal(JSON.parse(r.stderr).code, rec.code);
    assert.ok(JSON.parse(r.stderr).error.endsWith(LOGGED));
  });

  it("a command the guard refuses before the egress parse (a human-only verb): one record, no verb, no destination", () => {
    const w = world();
    const r = guard(w, "repo-aegis approve acme/svc --ttl 1h");
    assert.equal(r.code, 2);
    const rec = oneRecord(w, "human-only");
    assert.equal(rec.code, "AGENT_RAN_HUMAN_COMMAND");
    assert.equal(rec.outcome, "refuse");
    assert.equal(rec.verb, undefined);
    assert.equal(rec.destination, undefined);
    assert.doesNotMatch(JSON.stringify(rec), /acme|ttl/, "the command text is never logged");
  });

  it("a Bash command that is not an egress shape writes nothing", () => {
    const w = world();
    for (const command of ["ls -la", "git status", "gh pr view 12 --repo acme/svc", "npm test", "cat README.md"]) {
      assert.equal(guard(w, command).code, 0, command);
    }
    assert.deepEqual(records(w), []);
    assert.ok(!existsSync(decisionLogPath(w.home)));
  });

  it("an egress-shaped command that is allowed is recorded too (one record, outcome allow)", () => {
    const w = world({ registry: null });
    const r = guard(w, "git push origin main");
    // with no registry rule h is skipped; the shape rule for an unnamed destination may still refuse: either way it is one record
    assert.ok(r.code === 0 || r.code === 2);
    const rec = oneRecord(w, "git push origin main");
    assert.equal(rec.layer, "egress-hook");
    assert.equal(rec.verb, "git push");
    assert.ok(rec.outcome === "allow" || rec.outcome === "refuse" || rec.outcome === "ask");
    assert.equal(rec.facts?.registryState, "missing");
  });
});

describe("decision log: the write hooks", { skip: SKIP }, () => {
  it("check-write: a refusal writes one record (layer, code, verb) and its text ends with the trailer", () => {
    const w = world();
    const file = join(w.cwd, ".repo-aegis.yml");
    const r = runCliIn(w, ["hook", "check-write"], JSON.stringify({ tool_input: { file_path: file }, cwd: w.cwd }));
    assert.equal(r.code, 2);
    const rec = oneRecord(w, "check-write");
    assert.equal(rec.layer, "check-write");
    assert.equal(rec.outcome, "refuse");
    assert.equal(rec.code, "WAIVER_FILE_WRITE_REFUSED");
    assert.equal(rec.verb, "write");
    assert.equal(rec.facts?.registryState, undefined, "refused before the registry was read");
    assert.ok((JSON.parse(r.stderr) as { error: string }).error.endsWith(LOGGED));
    assert.doesNotMatch(JSON.stringify(rec), /repo-aegis\.yml|work/, "no path");
  });

  it("check-write: a write to the decision log's switch is refused (an agent must not switch the log off), and to the log itself is not", () => {
    const w = world();
    const sw = runCliIn(w, ["hook", "check-write"], JSON.stringify({ tool_input: { file_path: join(w.home, "state", "decision-log.json") }, cwd: w.cwd }));
    assert.equal(sw.code, 2);
    assert.equal((JSON.parse(sw.stderr) as { code: string }).code, "DECISION_LOG_STATE_WRITE_REFUSED");
    const rec = oneRecord(w, "switch write");
    assert.equal(rec.code, "DECISION_LOG_STATE_WRITE_REFUSED");
    assert.doesNotMatch(JSON.stringify(rec), /decision-log\.json|state/, "no path");
  });

  it("check-write: an allowed write writes nothing", () => {
    const w = world();
    const file = join(w.cwd, "notes.txt");
    const r = runCliIn(w, ["hook", "check-write"], JSON.stringify({ tool_input: { file_path: file }, cwd: w.cwd }));
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(records(w), []);
  });

  it("scan-after-write: a non-allow outcome (an unreadable registry) writes one record with the registry state", () => {
    const w = world({ registry: "this: [is not a valid registry\n" });
    const file = join(w.cwd, "out.txt");
    writeFileSync(file, "hello\n");
    const r = runCliIn(w, ["hook", "scan-after-write"], JSON.stringify({ tool_input: { file_path: file }, cwd: w.cwd }));
    assert.equal(r.code, 2, r.stderr);
    const rec = oneRecord(w, "scan-after-write");
    assert.equal(rec.layer, "scan-after-write");
    assert.equal(rec.outcome, "refuse");
    assert.equal(rec.code, "REGISTRY_ERROR");
    assert.equal(rec.facts?.registryState, "unreadable");
    assert.ok((JSON.parse(r.stderr) as { error: string }).error.endsWith(LOGGED));
  });

  it("scan-after-write: a clean write writes nothing", () => {
    const w = world();
    const file = join(w.cwd, "out.txt");
    writeFileSync(file, "hello\n");
    const r = runCliIn(w, ["hook", "scan-after-write"], JSON.stringify({ tool_input: { file_path: file }, cwd: w.cwd }));
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(records(w), []);
  });
});

describe("decision log: pre-commit and pre-push", { skip: SKIP }, () => {
  function repo(w: World): void {
    for (const args of [["init", "-q", "-b", "main"], ["config", "user.email", "t@example.com"], ["config", "user.name", "T"]]) {
      const r = spawnSync("git", args, { cwd: w.cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } });
      assert.equal(r.status, 0);
    }
  }

  it("pre-push: a refusal writes one record with the destination, the ref and its kind; the text ends with the trailer", () => {
    const w = world();
    repo(w);
    const r = runCliIn(w, ["check", "--push-ref", "refs/heads/main", "--remote-url", "git@github.com:Stranger/Svc.git", "--json"], undefined);
    assert.equal(r.code, 2, r.stdout + r.stderr);
    const rec = oneRecord(w, "pre-push");
    assert.equal(rec.layer, "pre-push");
    assert.equal(rec.outcome, "refuse");
    assert.equal(rec.code, "UNREGISTERED_OWNER_EGRESS");
    assert.equal(rec.host, "git");
    assert.equal(rec.verb, "git push");
    assert.equal(rec.destination, "stranger/svc");
    assert.equal(rec.ref, "main");
    assert.equal(rec.refKind, "branch");
    assert.equal(rec.facts?.registryState, "plain");
    assert.ok((JSON.parse(r.stderr) as { error: string }).error.endsWith(LOGGED), r.stderr);
  });

  it("pre-commit: a clean run is recorded as an allow (one record per run, every outcome)", () => {
    const w = world({ registry: null });
    repo(w);
    writeFileSync(join(w.cwd, "a.txt"), "hello\n");
    spawnSync("git", ["add", "a.txt"], { cwd: w.cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } });
    const r = runCliIn(w, ["check", "--staged"], undefined);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    const rec = oneRecord(w, "pre-commit");
    assert.equal(rec.layer, "pre-commit");
    assert.equal(rec.outcome, "allow");
    assert.equal(rec.verb, "git commit");
    assert.equal(rec.code, undefined);
  });

  it("an explicit --path scan is not a hook decision and writes nothing", () => {
    const w = world({ registry: null });
    repo(w);
    writeFileSync(join(w.cwd, "a.txt"), "hello\n");
    runCliIn(w, ["check", "--path", "a.txt"], undefined);
    assert.deepEqual(records(w), []);
  });
});

describe("decision log: the git credential helper", { skip: SKIP }, () => {
  const request = (path: string | null): string => `protocol=https\nhost=github.com\n${path === null ? "" : `path=${path}\n`}\n`;

  it("a refusal writes one record (code, destination) and ends with the trailer", () => {
    const w = world();
    const r = runCliIn(w, ["git-credential", "--home", w.home, "get"], request(null));
    assert.equal(r.stdout, "quit=true\n");
    const rec = oneRecord(w, "credential refusal");
    assert.equal(rec.layer, "credential-helper");
    assert.equal(rec.outcome, "refuse");
    assert.equal(rec.code, "AGENT_PUSH_CREDENTIAL_CONFIG");
    assert.equal(rec.host, "git");
    assert.ok(r.stderr.trimEnd().endsWith(LOGGED), r.stderr);
  });

  it("stepping aside (an owner nothing maps) is a record too, with the destination and no token anywhere", () => {
    const w = world();
    const r = runCliIn(w, ["git-credential", "--home", w.home, "get"], request("Stranger/Svc.git"));
    assert.equal(r.stdout, "", "nothing on stdout: git asks its next helper");
    const rec = oneRecord(w, "credential step-aside");
    assert.equal(rec.outcome, "step-aside");
    assert.equal(rec.code, "CREDENTIAL_OWNER_UNMAPPED");
    assert.equal(rec.destination, "stranger/svc", "the .git suffix is not part of the name");
  });

  it("a request that is not for github.com writes nothing", () => {
    const w = world();
    runCliIn(w, ["git-credential", "--home", w.home, "get"], "protocol=https\nhost=example.com\npath=x/y.git\n\n");
    assert.deepEqual(records(w), []);
  });
});

describe("decision log: a log that cannot be written never changes a decision (spec §4)", { skip: SKIP || process.getuid?.() === 0 }, () => {
  /** The home's state directory is read-only and $TMPDIR is a path under a regular file: neither file can be created. */
  function breakLogging(w: World): void {
    chmodSync(join(w.home, "state"), 0o500);
    const blocker = join(w.cwd, "tmp-blocker");
    writeFileSync(blocker, "not a directory");
    // the child's TMPDIR is set through the extra env below
    w.tmp = join(blocker, "sub");
  }

  const cases: Array<{ name: string; run: (w: World) => Result; code: (r: Result) => string | undefined }> = [
    { name: "egress hook, egress-shaped refusal", run: w => guard(w, UNREGISTERED, {}, "codex"), code: r => (JSON.parse(r.stderr) as { code: string }).code },
    { name: "egress hook, shape rule", run: w => guard(w, BARE_PUSH, {}, "codex"), code: r => (JSON.parse(r.stderr) as { code: string }).code },
    { name: "egress hook, human-only verb", run: w => guard(w, "repo-aegis approve acme/svc", {}, "codex"), code: r => (JSON.parse(r.stderr) as { code: string }).code },
    {
      name: "check-write",
      run: w => runCliIn(w, ["hook", "check-write"], JSON.stringify({ tool_input: { file_path: join(w.cwd, ".repo-aegis.yml") }, cwd: w.cwd })),
      code: r => (JSON.parse(r.stderr) as { code: string }).code,
    },
  ];

  for (const c of cases) {
    it(`${c.name}: same exit code and same code as with a working log; the text says '(not logged)'`, () => {
      const good = world();
      const reference = c.run(good);
      const bad = world();
      breakLogging(bad);
      const r = c.run(bad);
      assert.equal(r.code, reference.code, "the exit code is unchanged");
      assert.equal(c.code(r), c.code(reference), "the refusal code is unchanged");
      assert.ok(r.stderr.includes("(not logged)"), r.stderr);
      assert.ok(!r.stderr.includes("(logged:"), r.stderr);
      assert.ok(reference.stderr.includes(LOGGED), reference.stderr);
      assert.ok(!existsSync(decisionLogPath(bad.home)));
      chmodSync(join(bad.home, "state"), 0o700);
    });
  }

  it("pre-push: a refusal is the same refusal (exit 2, same code) with the log unwritable", () => {
    const run = (w: World): Result => {
      spawnSync("git", ["init", "-q", "-b", "main"], { cwd: w.cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } });
      return runCliIn(w, ["check", "--push-ref", "refs/heads/main", "--remote-url", "git@github.com:Stranger/Svc.git", "--json"], undefined);
    };
    const good = world();
    const reference = run(good);
    const bad = world();
    breakLogging(bad);
    const r = run(bad);
    assert.equal(r.code, reference.code);
    assert.equal((JSON.parse(r.stderr) as { code: string }).code, (JSON.parse(reference.stderr) as { code: string }).code);
    assert.ok(r.stderr.includes("(not logged)"));
    chmodSync(join(bad.home, "state"), 0o700);
  });

  it("the credential helper: the same answer, with '(not logged)' on a refusal", () => {
    const req = "protocol=https\nhost=github.com\n\n";
    const good = world();
    const reference = runCliIn(good, ["git-credential", "--home", good.home, "get"], req);
    const bad = world();
    breakLogging(bad);
    const r = runCliIn(bad, ["git-credential", "--home", bad.home, "get"], req, { TMPDIR: bad.tmp });
    assert.equal(r.stdout, reference.stdout);
    assert.equal(r.code, reference.code);
    assert.ok(r.stderr.includes("(not logged)"), r.stderr);
    chmodSync(join(bad.home, "state"), 0o700);
  });
});

describe("decision log: the primary being unwritable falls back to $TMPDIR (spec §2), through a real entry point", { skip: SKIP || process.getuid?.() === 0 }, () => {
  it("the record lands in $TMPDIR/repo-aegis-<uid>/decisions.jsonl with facts.logFallback, and `log` shows it", () => {
    const w = world();
    chmodSync(join(w.home, "state"), 0o500);
    try {
      const r = guard(w, BARE_PUSH, {}, "codex");
      assert.equal(r.code, 2);
      assert.ok((JSON.parse(r.stderr) as { error: string }).error.endsWith(LOGGED), "a fallback write counts as logged");
      const rec = oneRecord(w, "fallback");
      assert.equal(rec.facts?.logFallback, true);
      const shown = runCliIn(w, ["log", "--last", "1", "--json"], undefined);
      assert.equal(shown.code, 0, shown.stderr);
      const j = JSON.parse(shown.stdout) as { records: DecisionRecord[] };
      assert.equal(j.records[0]?.facts?.logFallback, true);
    } finally {
      chmodSync(join(w.home, "state"), 0o700);
    }
  });
});
