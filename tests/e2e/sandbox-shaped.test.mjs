// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// The sandbox-shaped end-to-end release gate (P1-G). Run it with `npm run test:e2e` before `gh release create`
// (CONTRIBUTING.md, "Release checklist"); CI runs it on every PR.
//
// It installs the PACKED tarballs into a temp prefix (see world.mjs), runs the real CLI's installers against a temp
// HOME and REPO_AEGIS_HOME, and drives real `git` and the real `gh` shim against local bare repos, under the
// conditions of an agent sandbox: the sandbox's own environment (the proxy family pointing at a dead localhost port,
// GIT_SSH_COMMAND with its ProxyCommand, GIT_CONFIG_PARAMETERS, GIT_CONFIG_COUNT/KEY/VALUE, SANDBOX_RUNTIME,
// CLAUDECODE: `sandboxEnv` in world.mjs), a failing `ps` first on PATH, no TTY on any stream, and no route to GitHub.
//
// WHERE IT MEANS SOMETHING. The condition that broke 0.13.1 and 0.13.2 is an UNREADABLE PROCESS LIST. Linux always has
// /proc, so on an ubuntu runner the chain is readable and the gate cannot see that class. The "process list is unreadable"
// test below therefore FAILS wherever the installed core can read its ancestors, unless E2E_PS_READABLE_OK=1 (set on
// the ubuntu CI job, where that is known and accepted). The macOS CI job runs this file under `sandbox-exec` with
// `/bin/ps` and `/usr/bin/ps` denied; locally, run it inside the Claude Code sandbox.
//
// THE FLOWS ARE A TABLE (FLOWS below): one row per flow, with the outcome and the code it must end in. A new flow is
// one row. The honest mistake the file covers: shipping a release that blocks the main path for every sandboxed agent.
// 0.13.1 refused every sandboxed fetch and 0.13.2 refused every sandboxed push, and the unit tests passed both times.
//
// REPLAYING A PUBLISHED RELEASE (the regression check): `npm pack` the four packages of a published version into a
// directory and set E2E_TARBALL_DIR to it, e.g.
//   npm pack --pack-destination "$TMPDIR/ra-0.13.2" @de-otio/repo-aegis@0.13.2 @de-otio/repo-aegis-core@0.13.2 \
//     @de-otio/repo-aegis-llm@0.13.2 @de-otio/repo-aegis-scan@0.13.2
//   E2E_TARBALL_DIR="$TMPDIR/ra-0.13.2" npm run test:e2e
//
// LIMITS, stated rather than hidden:
//   - The credential helper answers github.com over HTTPS only, and no HTTPS server can be reached here. So the
//     credential rows run a real `git push|fetch https://github.com/...` whose `git-remote-https` is a stub (found
//     first through GIT_EXEC_PATH) that asks the installed helper, as a child of a process named git-remote-https
//     under `git push|fetch`, the way git does, and stops there. The ssh pushes and the `gh` call are real; their
//     "GitHub" is an `ssh` stub on PATH that serves the local bare repos.
//   - A PERSON-mapped owner's token comes from a `gh` that repo-aegis trusts, and it trusts none in a temp directory
//     (there is no seam in the shipped CLI, deliberately). So the person-mapped credential row proves the request got
//     PAST every sandbox check (proxy variables, process list, no TTY) and stopped at the token step; the answered
//     credential rows use an App-mapped owner and a stub taaad.
//   - repo-aegis runs `ps` by absolute path, which a PATH stub cannot replace (world.mjs says more).
//   - One packed install serves the whole file (the world is built once), to keep the process count down.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { APP_TOKEN, DEAD_PROXY, MARKER_TEXT, handWrittenHelperLine, makeReadOnly, makeWorld, sandboxEnv, writeStub } from "./world.mjs";

// ---------------------------------------------------------------------------
// The world, built once
// ---------------------------------------------------------------------------

/** @type {ReturnType<typeof makeWorld>} */
let w;
let shimDir;
let ctx;
let pushes = 0;

/** A repository whose origin is a GitHub ssh URL (served by the `ssh` stub) and whose visibility is declared. */
function makeRepo(name, owner, visibility) {
  const dir = join(w.root, name);
  mkdirSync(dir, { recursive: true });
  w.git(dir, ["init", "-q"]);
  w.git(dir, ["remote", "add", "origin", `git@github.com:${owner}/svc.git`]);
  w.git(dir, ["config", "repo-aegis.visibility", visibility]);
  w.git(dir, ["config", "repo-aegis.class", visibility === "private" ? "private-strict" : "public-eligible"]);
  return dir;
}

function commit(dir, file, text, message) {
  writeFileSync(join(dir, file), text);
  const a = w.git(dir, ["add", "--", file]);
  assert.equal(a.code, 0, a.stderr);
  return w.git(dir, ["commit", "-q", "-m", message]);
}

before(() => {
  w = makeWorld();
  shimDir = join(w.ra, "bin");
  // `ssh` for git: serves `git-receive-pack|git-upload-pack '<owner>/<repo>.git'` from the local bare repos. Plain
  // `ssh` on PATH is no "override" to repo-aegis (GIT_SSH_COMMAND would be), so the guard sees a real github.com URL.
  writeStub(
    w.stubs,
    "ssh",
    `for a; do last="$a"; done
svc="\${last%% *}"
path="\${last#* }"
path="\${path#\\'}"
path="\${path%\\'}"
exec git "\${svc#git-}" "${w.bare}/$path"`,
  );
  // The `gh` the shim finds after itself: records its argv and prints a PR URL.
  writeStub(w.ghStubs, "gh", `echo "gh argv: $*" >> "${w.root}/gh.log"\necho "https://github.com/org-private/svc/pull/1"`);

  for (const p of ["org-private/svc.git", "org-public/svc.git"]) {
    const d = join(w.bare, p);
    mkdirSync(d, { recursive: true });
    assert.equal(w.git(d, ["init", "-q", "--bare"]).code, 0);
  }
  const priv = makeRepo("private-repo", "org-private", "private");
  const pub = makeRepo("public-repo", "org-public", "public");
  const marker = makeRepo("marker-repo", "org-private", "private");
  // Seed the private origin by path (a non-GitHub destination), so a fetch has something to fetch.
  assert.equal(commit(priv, "a.txt", "one\n", "first").code, 0);
  assert.equal(w.git(priv, ["push", "-q", join(w.bare, "org-private/svc.git"), "main"]).code, 0);
  assert.equal(commit(pub, "a.txt", "one\n", "first").code, 0);
  assert.equal(commit(marker, "a.txt", "one\n", "first").code, 0);
  ctx = { priv, pub, marker };
});

after(() => {
  if (w !== undefined) w.cleanup();
});

const bareHead = (path) => {
  const r = w.git(join(w.bare, path), ["rev-parse", "--verify", "-q", "refs/heads/main"]);
  return r.code === 0 ? r.stdout.trim() : null;
};

/** The refusal codes a sandbox's conditions caused in 0.13.x, as a refusal names them (`[CODE; details: ...]`): never prose. */
const SANDBOX_REFUSAL = /\[(?:AGENT_PUSH_[A-Z_]+|AGENT_CREDENTIAL_DIRECT_FILL)[;\]]/;

/**
 * A real `git push|fetch https://github.com/<owner>/svc.git`, whose `git-remote-https` is the stub (world.mjs) that asks
 * the installed credential helper. The row's result is the helper's: exit 0 and its stdout when it answered; exit 1 and
 * its stderr when it refused or gave no answer. (git itself exits non-zero either way: there is no server.)
 */
function httpsHelper(op, owner) {
  const out = join(w.https.outDir, "result.json");
  rmSync(out, { force: true });
  const url = `https://github.com/${owner}/svc.git`;
  const args = op === "push" ? ["push", url, "HEAD:refs/heads/main"] : ["fetch", url];
  const r = w.git(ctx.priv, args, { env: { GIT_EXEC_PATH: w.https.execDir } });
  assert.ok(existsSync(out), `the helper was never asked (git exit ${r.code}): ${r.stderr}`);
  const helper = JSON.parse(readFileSync(out, "utf8"));
  return { code: helper.answered ? 0 : 1, stdout: helper.stdout, stderr: helper.stderr, error: r.error };
}

// ---------------------------------------------------------------------------
// The flows. One row each. `outcome` is what the person sees; `code` is the refusal code it must name (refused rows),
// `prove` adds the row's own evidence. Every row also asserts, in `check` below, that no token reached stderr.
// ---------------------------------------------------------------------------

const FLOWS = [
  {
    name: "fetch from a private origin is answered (nothing in repo-aegis stands in front of a read)",
    outcome: "answered",
    drive: () => w.git(ctx.priv, ["fetch", "origin"]),
    prove: (r) => {
      assert.equal(w.git(ctx.priv, ["rev-parse", "--verify", "-q", "refs/remotes/origin/main"]).code, 0, "the remote-tracking ref exists");
      assert.ok(!/repo-aegis/.test(r.stderr), `no repo-aegis output on a fetch: ${r.stderr}`);
    },
  },
  {
    name: "pull from a private origin is answered",
    outcome: "answered",
    drive: () => w.git(ctx.priv, ["pull", "--ff-only", "origin", "main"]),
    prove: (r) => assert.ok(!/repo-aegis/.test(r.stderr), `no repo-aegis output on a pull: ${r.stderr}`),
  },
  {
    name: "fetch over HTTPS, App-mapped owner: the credential helper answers under proxy variables, no process list, no TTY",
    outcome: "answered",
    drive: () => httpsHelper("fetch", "org-app"),
    tokenOnStdout: true,
    prove: (r) => {
      assert.match(r.stdout, /^username=x-access-token$/m);
      assert.ok(r.stdout.includes(`password=${APP_TOKEN}`), "the token goes to git on stdout");
    },
  },
  {
    // The 0.13.2 regression: every sandboxed push died here with AGENT_PUSH_CREDENTIAL_CONFIG, because the proxy
    // variables in the environment counted as something that could capture the token.
    name: "push over HTTPS, App-mapped owner: the credential helper answers under proxy variables, no process list, no TTY",
    outcome: "answered",
    drive: () => httpsHelper("push", "org-app"),
    tokenOnStdout: true,
    prove: (r) => {
      assert.ok(r.stdout.includes(`password=${APP_TOKEN}`), "the token goes to git on stdout");
      assert.doesNotMatch(r.stderr, SANDBOX_REFUSAL, "no sandbox refusal");
    },
  },
  {
    name: "fetch over HTTPS, person-mapped owner: gets past every sandbox check and stops only at the token step",
    outcome: "refused",
    // No gh that repo-aegis trusts can exist in a temp directory (see LIMITS), so the end of the road is the token step.
    // Either code means "the sandbox's conditions were not what refused it"; AGENT_PUSH_* would be the bug.
    code: /GH_BINARY_UNTRUSTED|GH_IDENTITY_UNAVAILABLE/,
    drive: () => httpsHelper("fetch", "org-person"),
    prove: (r) => assert.doesNotMatch(r.stderr, SANDBOX_REFUSAL, "refused by a sandbox condition"),
  },
  {
    name: "push over HTTPS, person-mapped owner: gets past every sandbox check and stops only at the token step",
    outcome: "refused",
    code: /GH_BINARY_UNTRUSTED|GH_IDENTITY_UNAVAILABLE/,
    drive: () => httpsHelper("push", "org-person"),
    prove: (r) => assert.doesNotMatch(r.stderr, SANDBOX_REFUSAL, "refused by a sandbox condition"),
  },
  {
    name: "push to a private destination is answered (real git, real pre-push)",
    outcome: "answered",
    drive: () => {
      // A new file each time: the read-only variant below runs this row a second time.
      commit(ctx.priv, `b-${++pushes}.txt`, "two\n", "second");
      return w.git(ctx.priv, ["push", "origin", "main"]);
    },
    prove: (r) => {
      assert.match(r.stderr, /pushing [0-9a-f]+\.\.[0-9a-f]+ → org-private\/svc \(private\)/);
      assert.equal(bareHead("org-private/svc.git"), w.git(ctx.priv, ["rev-parse", "HEAD"]).stdout.trim(), "the bare repo received the commit");
    },
  },
  {
    name: "push to a public destination is refused by rule g (PUBLIC_PUSH_NEEDS_HUMAN) and nothing is sent",
    outcome: "refused",
    code: /PUBLIC_PUSH_NEEDS_HUMAN/,
    drive: () => w.git(ctx.pub, ["push", "origin", "main"]),
    prove: () => assert.equal(bareHead("org-public/svc.git"), null, "the public bare repo received nothing"),
  },
  {
    name: "gh pr create through the shim to a private destination is judged and allowed (stub gh runs)",
    outcome: "answered",
    drive: () =>
      w.run("gh", ["pr", "create", "--repo", "org-private/svc", "--title", "t", "--body", "b"], {
        cwd: ctx.priv,
        env: { PATH: w.pathWith(shimDir, w.ghStubs) },
      }),
    prove: (r) => {
      assert.match(r.stderr, /PUBLISHED → org-private\/svc/, "the receipt names the destination");
      assert.match(readFileSync(join(w.root, "gh.log"), "utf8"), /gh argv: pr create --repo org-private\/svc/);
    },
  },
  {
    name: "gh pr create through the shim to a public destination is judged and refused (PUBLIC_EGRESS_NEEDS_HUMAN), stub gh never runs",
    outcome: "refused",
    code: /PUBLIC_EGRESS_NEEDS_HUMAN/,
    drive: () => {
      writeFileSync(join(w.root, "gh.log"), "");
      return w.run("gh", ["pr", "create", "--repo", "org-public/svc", "--title", "t", "--body", "b"], {
        cwd: ctx.pub,
        env: { PATH: w.pathWith(shimDir, w.ghStubs) },
      });
    },
    prove: () => assert.equal(readFileSync(join(w.root, "gh.log"), "utf8"), "", "the real gh never ran"),
  },
  {
    name: "commit with a marker hit is refused by the global pre-commit hook, and the marker is not echoed",
    outcome: "refused",
    code: /marker hit/,
    drive: () => commit(ctx.marker, "leak.txt", `see ${MARKER_TEXT}\n`, "leak"),
    prove: (r) => {
      assert.ok(!r.stderr.includes(MARKER_TEXT) && !r.stdout.includes(MARKER_TEXT), "the literal marker is never printed");
      assert.notEqual(w.git(ctx.marker, ["log", "-1", "--format=%s"]).stdout.trim(), "leak", "no commit was made");
    },
  },
];

/** Rows for tasks that are not built yet. They name the task and say what they will assert; they do not count as failures. */
const TODO_FLOWS = [
  { name: "the same push to a public destination with an active pause is allowed with a notice", task: "P1-E (pause)" },
  { name: "the decision log holds one record per refusal above, with the facts P1-I names (proxy variable names, ps readable, tty)", task: "P1-I (decision log)" },
];

// ---------------------------------------------------------------------------

describe("the world is sandbox-shaped", () => {
  it("nothing is a TTY, and the installed CLI is the packed one", () => {
    const probe = w.run(w.node, [
      "-e",
      "console.log(JSON.stringify({ in: process.stdin.isTTY === true, out: process.stdout.isTTY === true, err: process.stderr.isTTY === true }))",
    ]);
    assert.deepEqual(JSON.parse(probe.stdout), { in: false, out: false, err: false });
    assert.ok(w.cli.includes(`${w.prefix}`), "the CLI under test lives in the temp prefix, not in the workspace");
    assert.ok(existsSync(join(w.prefix, "node_modules", "@de-otio", "repo-aegis", "dist", "docs", "agent-guide.md")), "the package carries its docs");
  });

  it("the sandbox's environment is set verbatim in shape, and every proxy points at the dead port", () => {
    const probe = w.run(w.node, ["-e", "console.log(JSON.stringify(process.env))"]);
    const env = JSON.parse(probe.stdout);
    const want = sandboxEnv(w.root);
    for (const [name, value] of Object.entries(want)) assert.equal(env[name], value, name);
    for (const name of ["HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "https_proxy", "http_proxy", "all_proxy", "GRPC_PROXY", "NO_PROXY", "DOCKER_HTTPS_PROXY"]) {
      assert.ok(env[name] !== undefined && env[name] !== "", `${name} is set`);
    }
    for (const name of ["HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "GRPC_PROXY", "DOCKER_HTTPS_PROXY"]) {
      assert.equal(new URL(env[name]).host, new URL(DEAD_PROXY).host, `${name} points at the dead proxy`);
    }
    assert.match(env["GIT_SSH_COMMAND"], /^ssh .*-o ProxyCommand="\/bin\/sh -c 'eval .*SRT_SSH_PROXY_COMMAND/, "GIT_SSH_COMMAND carries the quoted ProxyCommand");
    assert.match(env["GIT_CONFIG_PARAMETERS"], /'http\.proxyAuthMethod=basic' 'credential\.http:\/\/127\.0\.0\.1:9\.helper='/);
    assert.equal(env["SANDBOX_RUNTIME"], "1");
    assert.equal(env["CLAUDECODE"], "1");
  });

  it("the process list is unreadable to the installed core (the condition that broke 0.13.1), or this run says why it is not", (t) => {
    // Asks the INSTALLED core, in a child with the world's conditions: the same lookup the guard, the shim and the credential
    // helper make. An empty chain is what an unreadable process list gives. (`ps` is run by absolute path, so a PATH stub
    // cannot stand in; the real thing is the Claude Code sandbox, or `sandbox-exec` with /bin/ps denied on macOS.)
    const core = pathToFileURL(join(w.prefix, "node_modules", "@de-otio", "repo-aegis-core", "dist", "index.js")).href;
    const probe = w.run(w.node, [
      "--input-type=module",
      "-e",
      `import(${JSON.stringify(core)}).then((m) => process.stdout.write(JSON.stringify(m.readProcessAncestry())))`,
    ]);
    assert.equal(probe.code, 0, `the probe could not run: ${probe.stderr}`);
    const chain = JSON.parse(probe.stdout);
    if (chain.ancestors.length === 0) return;
    const message =
      `the installed core read ${chain.ancestors.length} ancestor process(es), so this run does NOT exercise an unreadable process list, ` +
      "the condition that made 0.13.1 refuse every sandboxed fetch and 0.13.2 every sandboxed push. Run it inside the Claude Code sandbox, " +
      "or under `sandbox-exec -p '(version 1)(allow default)(deny process-exec (literal \"/bin/ps\") (literal \"/usr/bin/ps\"))'` on macOS.";
    if (process.env["E2E_PS_READABLE_OK"] === "1") {
      console.error(`E2E WARNING (E2E_PS_READABLE_OK=1): ${message}`);
      t.skip(`process list is readable here (Linux /proc), accepted by E2E_PS_READABLE_OK=1: the unreadable-ps class is covered by the macOS sandbox-exec leg only`);
      return;
    }
    assert.fail(`${message} (Set E2E_PS_READABLE_OK=1 only where /proc makes the chain readable and another job covers the class, as the ubuntu CI job does.)`);
  });

  it("the credential helper line is the installer's own rendering", () => {
    const want = handWrittenHelperLine(w.node, w.cli, w.ra);
    // Meaningful when the line came from the installer (`helperLineSource === "installer"`): any drift in either fails here.
    assert.equal(w.helperLine, want, `the hand-written shape and the ${w.helperLineSource} line agree`);
    const installed = w.git(w.home, ["config", "--global", "--get-all", "credential.https://github.com.helper"]).stdout.split("\n");
    assert.deepEqual(installed.slice(0, 2), ["", w.helperLine]);
  });
});

describe("a setup that fails part-way leaves no temp directory behind", () => {
  it("makeWorld removes its root and re-throws (forced: a tarball directory with no CLI in it)", () => {
    const scratch = realpathSync(mkdtempSync(join(tmpdir(), "repo-aegis-e2e-cleanup-probe-")));
    const emptyTarballs = join(scratch, "no-tarballs");
    mkdirSync(emptyTarballs);
    const was = process.env["TMPDIR"];
    process.env["TMPDIR"] = scratch;
    try {
      assert.throws(() => makeWorld({ tarballDir: emptyTarballs }), /no @de-otio\/repo-aegis tarball/);
      assert.deepEqual(readdirSync(scratch), ["no-tarballs"], "the failed world's root (repo-aegis-e2e-world-*) was removed");
    } finally {
      if (was === undefined) delete process.env["TMPDIR"];
      else process.env["TMPDIR"] = was;
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

/** Any GitHub token shape (`ghp_`, `gho_`, `ghs_`, `ghu_`): none may reach a person's or agent's screen. */
const TOKEN_SHAPE = /gh[opsu]_[A-Za-z0-9]{20,}/;

function runRow(row) {
  const r = row.drive();
  assert.equal(r.error, undefined, `could not run: ${String(r.error)}`);
  assert.doesNotMatch(r.stderr, TOKEN_SHAPE, "no token on stderr");
  // The two answered HTTPS rows hand the token to git on stdout BY DESIGN (that is what a credential helper does).
  if (row.tokenOnStdout !== true) assert.doesNotMatch(r.stdout, TOKEN_SHAPE, "no token on stdout");
  if (row.outcome === "answered") {
    assert.equal(r.code, 0, `expected the flow to be answered, got exit ${r.code}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
  } else {
    assert.notEqual(r.code, 0, `expected a refusal, got exit 0\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.match(r.stderr + r.stdout, row.code, `expected ${row.code}, got exit ${r.code}`);
  }
  row.prove?.(r);
}

describe(`sandbox-shaped flows (table: ${FLOWS.length} rows)`, () => {
  for (const row of FLOWS) it(row.name, () => runRow(row));
});

/**
 * M4: the same table with the whole REPO_AEGIS_HOME read-only (a sandbox that leaves the configuration directory outside
 * its write list). A row that fails closed there is a finding, not fixed in P1-G: it is listed in READ_ONLY_FAILS with the
 * entry point and code it ends in, and runs as a `todo` until someone decides what a read-only home should do.
 */
const READ_ONLY_FAILS = new Map([]);

describe(`the same flows with REPO_AEGIS_HOME read-only (table: ${FLOWS.length} rows)`, () => {
  let restore;
  before(() => {
    restore = makeReadOnly(w.ra);
  });
  after(() => {
    restore?.();
  });
  for (const row of FLOWS) {
    const note = READ_ONLY_FAILS.get(row.name);
    if (note !== undefined) it.todo(`${row.name} [read-only home: ${note}]`);
    else it(row.name, () => runRow(row));
  }
});

describe("`repo-aegis selftest` on this install", () => {
  it("reports every layer ok under the same conditions (skipped for a release that predates it)", (t) => {
    const r = w.cliRun(["selftest", "--json"], { env: { PATH: w.pathWith(shimDir, w.ghStubs) }, cwd: w.root });
    if (/unknown command 'selftest'/.test(r.stderr)) {
      t.skip("this build has no selftest");
      return;
    }
    assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
    const report = JSON.parse(r.stdout);
    assert.deepEqual(
      report.layers.map((l) => [l.layer, l.ok]),
      [
        ["pre-commit", true],
        ["pre-push", true],
        ["shim", true],
        ["credential helper", true],
        ["egress hook", true],
      ],
    );
    assert.ok(report.sandbox.proxyVars.includes("HTTPS_PROXY") && report.sandbox.proxyVars.includes("DOCKER_HTTPS_PROXY"));
    assert.equal(report.sandbox.tty, false);
  });
});

describe("flows for tasks not built yet", () => {
  for (const f of TODO_FLOWS) {
    it.todo(`${f.name} [${f.task}]`);
  }
});
