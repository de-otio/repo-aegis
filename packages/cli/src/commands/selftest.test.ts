// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// `repo-aegis selftest` (P1-G). The pure parts (output, facts, code extraction) in-process; the layers through the built
// CLI against a throwaway install (temp HOME, temp git config, temp REPO_AEGIS_HOME), with the sandbox's conditions in
// the environment: proxy variables at a dead port, no TTY. The property that matters most is the last describe: a run
// leaves every file of the install exactly as it found it, and every temp directory removed.
import { before, after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, fstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, relative } from "node:path";
import { cliBuilt, cliPath } from "../_subprocess-utils.js";
import { readDropInSettings } from "./doctor-managed-checks.js";
import { checkGuardHook } from "./install-claude-md.js";
import { realFs, resolveManagedEnv } from "./managed-privileged.js";
import { formatSelftest, LAYERS, refusalCodeIn, runSelftest, sandboxFacts, sshCommandFor, type SelftestReport } from "./selftest.js";

// ---------------------------------------------------------------------------
// Pure
// ---------------------------------------------------------------------------

describe("refusalCodeIn", () => {
  const CASES: ReadonlyArray<readonly [string, string | null]> = [
    ["repo-aegis: x: refused. [PUBLIC_PUSH_NEEDS_HUMAN; details: repo-aegis explain PUBLIC_PUSH_NEEDS_HUMAN]", "PUBLIC_PUSH_NEEDS_HUMAN"],
    ["... [AGENT_PUSH_CREDENTIAL_CONFIG]", "AGENT_PUSH_CREDENTIAL_CONFIG"],
    [`{"code":"PUBLIC_EGRESS_NEEDS_HUMAN","error":"x"}`, "PUBLIC_EGRESS_NEEDS_HUMAN"],
    ["fatal: could not read Username", null],
    ["[abc]", null],
    ["", null],
  ];
  for (const [text, code] of CASES) it(`${JSON.stringify(text.slice(0, 50))} -> ${code}`, () => assert.equal(refusalCodeIn(text), code));
});

describe("sandboxFacts", () => {
  it("names the proxy variables that are set and never their values; empty ones do not count", () => {
    const facts = sandboxFacts({
      HTTPS_PROXY: "http://user:secret@127.0.0.1:9",
      DOCKER_HTTPS_PROXY: "http://127.0.0.1:9",
      http_proxy: "http://127.0.0.1:9",
      NO_PROXY: "",
      PATH: "/usr/bin",
      MY_PROXY_NOTES: "x",
    });
    assert.deepEqual(facts.proxyVars, ["DOCKER_HTTPS_PROXY", "HTTPS_PROXY", "http_proxy"]);
    assert.ok(!JSON.stringify(facts).includes("secret"));
    assert.equal(typeof facts.psReadable, "boolean");
  });
  it("reports no proxy variables for a clean environment", () => assert.deepEqual(sandboxFacts({ PATH: "/usr/bin" }).proxyVars, []));
});

describe("sshCommandFor", () => {
  const SANDBOX_SSH = `ssh -o ControlMaster=no -o ControlPath=none -o ProxyCommand="/bin/sh -c 'eval \\"\\\${SRT_SSH_PROXY_COMMAND:?unset}\\"' sh '%h' %p"`;
  const CASES: ReadonlyArray<readonly [string, string | undefined, string]> = [
    ["the sandbox's own command (ssh with a ProxyCommand) is kept", SANDBOX_SSH, SANDBOX_SSH],
    ["bare ssh is kept", "ssh", "ssh"],
    ["unset becomes plain ssh", undefined, "ssh"],
    ["empty becomes plain ssh", "", "ssh"],
    ["another program becomes plain ssh", "/usr/local/bin/my-ssh-wrapper -x", "ssh"],
    ["a word that only starts with ssh becomes plain ssh", "sshpass -p x ssh", "ssh"],
    ["an absolute path to ssh becomes plain ssh (the stub on PATH is what must run)", "/usr/bin/ssh -v", "ssh"],
  ];
  for (const [name, caller, want] of CASES) it(name, () => assert.equal(sshCommandFor(caller), want));
});

describe("runSelftest cleanup", () => {
  it("a setup that throws after the temp directory exists leaves no temp directory behind, and the error propagates", () => {
    const scratch = realpathSync(mkdtempSync(join(tmpdir(), "repo-aegis-selftest-cleanup-")));
    const was = process.env["TMPDIR"];
    process.env["TMPDIR"] = scratch;
    try {
      let seen: string | undefined;
      assert.throws(
        () =>
          runSelftest({
            afterTempDir: root => {
              seen = root;
              assert.ok(readdirSync(scratch).length === 1, "the temp directory exists when the seam runs");
              throw new Error("forced setup failure");
            },
          }),
        /forced setup failure/,
      );
      assert.ok(seen !== undefined && seen.startsWith(scratch), "the seam saw a directory under the run's TMPDIR");
      assert.deepEqual(readdirSync(scratch), [], "the temp directory was removed");
    } finally {
      if (was === undefined) delete process.env["TMPDIR"];
      else process.env["TMPDIR"] = was;
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

describe("formatSelftest", () => {
  const report = (over: Partial<SelftestReport> = {}): SelftestReport => ({
    version: "9.9.9",
    ok: true,
    layers: LAYERS.map(layer => ({ layer, ok: true, status: "ok", detail: null })),
    sandbox: { proxyVars: ["DOCKER_HTTPS_PROXY", "HTTPS_PROXY"], psReadable: false, tty: false },
    ...over,
  });

  it("is one line per layer, then the facts", () => {
    assert.equal(
      formatSelftest(report()),
      [
        "pre-commit ok",
        "pre-push ok",
        "shim ok",
        "credential helper ok",
        "egress hook ok",
        "sandbox: proxy variables set: DOCKER_HTTPS_PROXY, HTTPS_PROXY; ps readable: no; tty: no",
      ].join("\n"),
    );
  });

  it("puts the status after the layer name and the detail under a layer that is not ok", () => {
    const layers = report().layers.map(l =>
      l.layer === "shim"
        ? { ...l, ok: false, status: "not first on PATH", detail: "put the shim's directory first" }
        : l.layer === "credential helper"
          ? { ...l, ok: false, status: "refuses: AGENT_PUSH_CREDENTIAL_CONFIG", detail: "x" }
          : l,
    );
    const lines = formatSelftest(report({ ok: false, layers })).split("\n");
    assert.ok(lines.includes("shim not first on PATH"));
    assert.ok(lines.includes("  put the shim's directory first"));
    assert.ok(lines.includes("credential helper refuses: AGENT_PUSH_CREDENTIAL_CONFIG"));
    assert.ok(lines.includes("egress hook ok"), "the other layers still report");
  });

  it("says none when no proxy variable is set", () => {
    assert.match(formatSelftest(report({ sandbox: { proxyVars: [], psReadable: true, tty: true } })), /proxy variables set: none; ps readable: yes; tty: yes$/);
  });
});

// ---------------------------------------------------------------------------
// Through the built CLI, on a throwaway install
// ---------------------------------------------------------------------------

const DEAD_PROXY = "http://127.0.0.1:9";

interface Install {
  root: string;
  home: string;
  ra: string;
  claude: string;
  tmp: string;
  gitconfig: string;
  shimDir: string;
  env: (extra?: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;
}

let top: string;

before(() => {
  top = realpathSync(mkdtempSync(join(tmpdir(), "repo-aegis-selftest-test-")));
});
after(() => rmSync(top, { recursive: true, force: true }));

let n = 0;

function node(install: Install, args: string[], extra: NodeJS.ProcessEnv = {}, cwd = install.root): { code: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [cliPath, ...args], { cwd, input: "", encoding: "utf8", env: install.env(extra), timeout: 120_000 });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** Which of the layers an install has. `bare` is a machine with nothing installed. */
function makeInstall(opts: { bare?: boolean } = {}): Install {
  n++;
  const root = join(top, `install${n}`);
  const home = join(root, "home");
  const ra = join(root, "repo-aegis-home");
  const claude = join(home, ".claude");
  const tmp = join(root, "tmp");
  const gitconfig = join(home, ".gitconfig");
  for (const d of [home, ra, tmp]) mkdirSync(d, { recursive: true });
  writeFileSync(gitconfig, "[user]\n\tname = T\n\temail = t@example.com\n[init]\n\tdefaultBranch = main\n");
  const stubGh = join(root, "stub-gh");
  mkdirSync(stubGh, { recursive: true });
  writeFileSync(join(stubGh, "gh"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const shimDir = join(ra, "bin");
  const install: Install = {
    root, home, ra, claude, tmp, gitconfig, shimDir,
    env: (extra = {}) => {
      const env: NodeJS.ProcessEnv = {
        PATH: [shimDir, stubGh, dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter),
        HOME: home,
        USER: "t",
        LC_ALL: "C",
        TMPDIR: tmp,
        GIT_CONFIG_GLOBAL: gitconfig,
        GIT_CONFIG_SYSTEM: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        REPO_AEGIS_HOME: ra,
        REPO_AEGIS_VISIBILITY_LOOKUP: "0",
        HTTPS_PROXY: DEAD_PROXY,
        DOCKER_HTTPS_PROXY: DEAD_PROXY,
        ...extra,
      };
      for (const [k, v] of Object.entries(extra)) if (v === undefined) delete env[k];
      return env;
    },
  };
  if (opts.bare === true) return install;
  const setup = join(root, "setup-repo");
  mkdirSync(setup, { recursive: true });
  spawnSync("git", ["init", "-q"], { cwd: setup, env: install.env() });
  const init = node(install, ["init", "--claude-home", claude], {}, setup);
  assert.equal(init.code, 0, init.stderr + init.stdout);
  const shim = node(install, ["install", "shim"], {}, setup);
  assert.equal(shim.code, 0, shim.stderr + shim.stdout);
  return install;
}

/** Every file under `dir` -> sha256, so a run that writes, rewrites, touches content or deletes anything shows. */
function snapshot(dir: string, skip: string[] = []): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string): void => {
    for (const ent of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, ent.name);
      if (skip.includes(p)) continue;
      if (ent.isDirectory()) {
        out.set(`${relative(dir, p)}/`, "dir");
        walk(p);
      } else {
        // one descriptor for the mode and the content, so the file cannot change between the two reads
        const fd = openSync(p, "r");
        try {
          const mode = fstatSync(fd).mode & 0o777;
          out.set(relative(dir, p), createHash("sha256").update(readFileSync(fd)).digest("hex") + `:${mode}`);
        } finally {
          closeSync(fd);
        }
      }
    }
  };
  walk(dir);
  return out;
}

/** One working install for the tests that only change the environment of a run (an install takes seconds). */
let sharedInstall: Install | undefined;
const shared = (): Install => (sharedInstall ??= makeInstall());

const parse = (stdout: string): SelftestReport => JSON.parse(stdout) as SelftestReport;
const statusOf = (r: SelftestReport, layer: string): string => r.layers.find(l => l.layer === layer)?.status ?? "(missing)";

describe("selftest through the built CLI", { skip: !cliBuilt() }, () => {
  it("a working install under proxy variables, no TTY: every layer ok, exit 0, one line each", () => {
    const i = shared();
    const r = node(i, ["selftest"]);
    assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
    const lines = r.stdout.trim().split("\n");
    assert.deepEqual(lines.slice(0, 5), ["pre-commit ok", "pre-push ok", "shim ok", "credential helper ok (not installed in git's global configuration)", "egress hook ok"]);
    assert.match(lines[5]!, /^sandbox: proxy variables set: DOCKER_HTTPS_PROXY, HTTPS_PROXY; ps readable: (yes|no); tty: no$/);
    assert.equal(lines.length, 6);
  });

  it("--json carries the same layers and the facts, and never a proxy value", () => {
    const i = shared();
    const r = node(i, ["selftest", "--json"]);
    assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
    const report = parse(r.stdout);
    assert.deepEqual(report.layers.map(l => l.layer), [...LAYERS]);
    assert.ok(report.ok && report.layers.every(l => l.ok));
    assert.deepEqual(report.sandbox.proxyVars, ["DOCKER_HTTPS_PROXY", "HTTPS_PROXY"]);
    assert.equal(report.sandbox.tty, false);
    assert.ok(!r.stdout.includes(DEAD_PROXY));
  });

  it("the credential helper is run from git's own configuration when one is installed", () => {
    const i = makeInstall();
    const q = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
    const helper = `!${q(process.execPath)} ${q(cliPath)} git-credential --home ${q(i.ra)}`;
    spawnSync("git", ["config", "--global", "--add", "credential.https://github.com.helper", ""], { env: i.env() });
    spawnSync("git", ["config", "--global", "--add", "credential.https://github.com.helper", helper], { env: i.env() });
    const r = node(i, ["selftest", "--json"]);
    assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
    assert.equal(statusOf(parse(r.stdout), "credential helper"), "ok");
  });

  // ---- each layer must be able to say no ----

  it("nothing installed: exit 1, and the hook layers, shim and egress hook each say so", () => {
    const i = makeInstall({ bare: true });
    const r = node(i, ["selftest", "--json"]);
    assert.equal(r.code, 1);
    const report = parse(r.stdout);
    assert.equal(report.ok, false);
    for (const layer of ["pre-commit", "pre-push"]) assert.match(statusOf(report, layer), /FAILED/, layer);
    assert.equal(statusOf(report, "shim"), "not installed");
    // The managed drop-in is system-wide and not under HOME: a machine that has the guard there reports it registered in any home.
    // (`resolveManagedEnv` hands a test an empty file system, so the real one is asked for explicitly.)
    const machineHasGuard = checkGuardHook(join(i.root, "no-claude-home"), readDropInSettings(resolveManagedEnv({ fs: realFs("") }))).every(c => c.ok);
    assert.equal(statusOf(report, "egress hook"), machineHasGuard ? "ok" : "not registered");
    assert.ok(report.layers.find(l => l.layer === "pre-commit")!.detail!.includes("core.hooksPath"));
  });

  it("the shim is installed but another gh comes first on PATH: 'not first on PATH', exit 1, the rest still ok", () => {
    const i = shared();
    const path = [join(i.root, "stub-gh"), i.shimDir, dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter);
    const r = node(i, ["selftest", "--json"], { PATH: path });
    assert.equal(r.code, 1, `${r.stdout}\n${r.stderr}`);
    const report = parse(r.stdout);
    assert.equal(statusOf(report, "shim"), "not first on PATH");
    assert.deepEqual(report.layers.filter(l => !l.ok).map(l => l.layer), ["shim"]);
  });

  it("an environment that would capture the helper's token: 'credential helper refuses: <code>', exit 1", () => {
    const i = shared();
    const r = node(i, ["selftest", "--json"], { GIT_TRACE_CURL: "1" });
    assert.equal(r.code, 1, `${r.stdout}\n${r.stderr}`);
    const report = parse(r.stdout);
    assert.equal(statusOf(report, "credential helper"), "refuses: AGENT_PUSH_CREDENTIAL_CONFIG");
    assert.deepEqual(report.layers.filter(l => !l.ok).map(l => l.layer), ["credential helper"]);
  });

  it("a hooks directory that is not repo-aegis's: the pre-commit and pre-push layers fail", () => {
    const i = makeInstall();
    const empty = join(i.root, "other-hooks");
    mkdirSync(empty, { recursive: true });
    spawnSync("git", ["config", "--global", "core.hooksPath", empty], { env: i.env() });
    const r = node(i, ["selftest", "--json"]);
    assert.equal(r.code, 1);
    const report = parse(r.stdout);
    assert.deepEqual(report.layers.filter(l => !l.ok).map(l => l.layer), ["pre-commit", "pre-push"]);
  });

  it("a person's REPO_AEGIS_EGRESS_HUMAN in the environment does not turn a refusal into a pass", () => {
    const i = shared();
    const r = node(i, ["selftest", "--json"], { REPO_AEGIS_EGRESS_HUMAN: "1", REPO_AEGIS_ASSUME_PUBLIC: undefined });
    assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
  });

  // ---- what a run leaves behind ----

  it("writes nothing outside its temp directory: every file of the install is unchanged, and the temp directory is empty again", () => {
    const i = makeInstall();
    // A registry the person already has, an audit log switched on and an approval on disk: all of them must survive untouched.
    writeFileSync(join(i.ra, "state-marker.txt"), "keep\n");
    node(i, ["audit-log", "on"]);
    const before = snapshot(i.root, [i.tmp]);
    assert.ok(before.size > 10, "the fixture has files to protect");
    const r = node(i, ["selftest"]);
    assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
    const after = snapshot(i.root, [i.tmp]);
    assert.deepEqual([...after], [...before], "no file under the home, HOME, the claude home or the git config changed");
    assert.deepEqual(readdirSync(i.tmp), [], "the run's temp directory was removed");
  });

  it("the same, for a run that fails (the cleanup is not on the happy path only)", () => {
    const i = makeInstall({ bare: true });
    const before = snapshot(i.root, [i.tmp]);
    const r = node(i, ["selftest"]);
    assert.equal(r.code, 1);
    assert.deepEqual([...snapshot(i.root, [i.tmp])], [...before]);
    assert.deepEqual(readdirSync(i.tmp), []);
  });
});
