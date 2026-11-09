// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// Script-level tests for the generated pre-push hook.
//
// The digest test in `hooks-state.test.ts` proves an installed copy matches
// the template; nothing proved the template's ARGUMENT LIST was right. That
// gap is exactly the defect the egress guard exists to close: git hands the
// destination URL to `pre-push` as `$2`, and for the whole life of this hook
// it was read and discarded. So these tests run the real script under bash
// with a fake `repo-aegis` first on PATH and assert on the argv it received.
//
// The scripts run the CLI by absolute path (the "pin", see
// doc/plan-pin-enforcement-binary.md), so the fake CLI here is a JS file the
// pin points at, not a `repo-aegis` on PATH.
//
// Placeholder orgs only (`acme`) — this repository is public.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderHookScript, type EnforcementPin, type HookName } from "./hook-scripts.js";

let tmp: string;

before(() => {
  tmp = mkdtempSync(join(tmpdir(), "repo-aegis-hook-scripts-"));
});

after(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const ZERO = "0".repeat(40);
const LOCAL_SHA = "1".repeat(40);
const REMOTE_SHA = "2".repeat(40);

/**
 * A CLI entry for the pin to point at: appends its argv (space-joined) to
 * `$ARGV_LOG` and exits with `rc`. Node runs it, so the shebang is irrelevant.
 */
function writeFakeCli(path: string, rc = 0): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(
    path,
    `require("node:fs").appendFileSync(process.env.ARGV_LOG, process.argv.slice(2).join(" ") + "\\n");\nprocess.exit(${rc});\n`,
  );
}

function pinTo(cli: string): EnforcementPin {
  return { node: process.execPath, cli };
}

/**
 * Run the pre-push script with `args` as its positional arguments and `stdin` as
 * git's ref list, and return one line per `repo-aegis` invocation: the argv it
 * was called with, space-joined.
 */
function runPrePush(name: string, args: string[], stdin: string): string[] {
  const dir = join(tmp, name);
  mkdirSync(dir, { recursive: true });

  const fakeCli = join(dir, "fake-cli.cjs");
  writeFakeCli(fakeCli);
  const script = join(dir, "pre-push");
  writeFileSync(script, renderHookScript("pre-push", pinTo(fakeCli)), { mode: 0o755 });
  chmodSync(script, 0o755);

  const log = join(dir, "argv.log");

  execFileSync("bash", [script, ...args], {
    cwd: dir,
    input: stdin,
    env: {
      ...process.env,
      ARGV_LOG: log,
      REPO_AEGIS_HOME: join(dir, "home"),
    },
    encoding: "utf8",
  });

  let body = "";
  try {
    body = readFileSync(log, "utf8");
  } catch {
    /* no invocation recorded */
  }
  return body.split("\n").filter(l => l.trim() !== "");
}

describe("pre-push script — remote URL pass-through", () => {
  it("passes git's $2 through to `check --push-ref` as --remote-url (new ref)", () => {
    const calls = runPrePush(
      "new-ref",
      ["origin", "git@github.com:acme/svc.git"],
      `refs/heads/main ${LOCAL_SHA} refs/heads/main ${ZERO}\n`,
    );

    assert.equal(calls.length, 1);
    const argv = calls[0]!;
    assert.match(argv, /check --push-ref refs\/heads\/main --remote origin/);
    assert.match(argv, /--remote-url git@github\.com:acme\/svc\.git/);
  });

  it("passes git's $2 through to `check --range` as --remote-url (existing ref)", () => {
    const calls = runPrePush(
      "existing-ref",
      ["origin", "git@github.com:acme/svc.git"],
      `refs/heads/main ${LOCAL_SHA} refs/heads/main ${REMOTE_SHA}\n`,
    );

    assert.equal(calls.length, 1);
    const argv = calls[0]!;
    assert.match(argv, new RegExp(`check --range ${REMOTE_SHA}\\.\\.${LOCAL_SHA}`));
    assert.match(argv, /--remote-url git@github\.com:acme\/svc\.git/);
  });

  it("omits --remote-url entirely when git gives no $2", () => {
    const calls = runPrePush(
      "no-url",
      ["origin"],
      `refs/heads/main ${LOCAL_SHA} refs/heads/main ${ZERO}\n`,
    );

    assert.equal(calls.length, 1);
    // Not "--remote-url ''": an empty value would make `check` look at a
    // destination it cannot resolve, where absence means "unchanged
    // behaviour" — the property that keeps every pre-existing caller working.
    assert.doesNotMatch(calls[0]!, /--remote-url/);
  });

  it("does not blow up under `set -u` with no $2 and several refs", () => {
    const calls = runPrePush(
      "multi-ref",
      [],
      `refs/heads/main ${LOCAL_SHA} refs/heads/main ${ZERO}\n` +
        `refs/tags/v1 ${LOCAL_SHA} refs/tags/v1 ${REMOTE_SHA}\n`,
    );

    assert.equal(calls.length, 2);
    assert.ok(calls.every(c => !/--remote-url/.test(c)));
  });

  it("skips branch deletions (zero local sha) and still passes the URL for the rest", () => {
    const calls = runPrePush(
      "deletion",
      ["origin", "https://github.com/acme/svc.git"],
      `(delete) ${ZERO} refs/heads/gone ${REMOTE_SHA}\n` +
        `refs/heads/main ${LOCAL_SHA} refs/heads/main ${ZERO}\n`,
    );

    assert.equal(calls.length, 1);
    assert.match(calls[0]!, /--remote-url https:\/\/github\.com\/acme\/svc\.git/);
  });
});

describe("pre-push script — chaining to the repo's own pre-push", () => {
  it("replays git's ref list to a chained .git/hooks/pre-push (BSD mktemp needs a template)", () => {
    // Before the template fix, `mktemp` with no argument printed nothing on
    // macOS, `|| true` hid the usage error, and the chained hook was never
    // exec'd. This test runs the real script in a real repo with a chained
    // hook that records what it received.
    const dir = join(tmp, "chain");
    mkdirSync(dir, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: dir, stdio: "ignore" });

    const fakeCli = join(dir, "fake-cli.cjs");
    writeFileSync(fakeCli, "process.exit(0);\n");

    const received = join(dir, "chained.log");
    const chained = join(dir, ".git", "hooks", "pre-push");
    mkdirSync(join(dir, ".git", "hooks"), { recursive: true });
    writeFileSync(
      chained,
      `#!/bin/sh\nprintf 'args=%s\\n' "$*" > "${received}"\ncat >> "${received}"\nexit 0\n`,
      { mode: 0o755 },
    );
    chmodSync(chained, 0o755);

    // Install our script somewhere that is NOT .git/hooks, as core.hooksPath does.
    const script = join(dir, "ours", "pre-push");
    mkdirSync(join(dir, "ours"), { recursive: true });
    writeFileSync(script, renderHookScript("pre-push", pinTo(fakeCli)), { mode: 0o755 });
    chmodSync(script, 0o755);

    const stdin = `refs/heads/main ${LOCAL_SHA} refs/heads/main ${REMOTE_SHA}\n`;
    execFileSync("bash", [script, "origin", "git@github.com:acme/svc.git"], {
      cwd: dir,
      input: stdin,
      env: { ...process.env, REPO_AEGIS_HOME: join(dir, "home") },
      encoding: "utf8",
    });

    const body = readFileSync(received, "utf8");
    assert.ok(body.startsWith("args=origin git@github.com:acme/svc.git\n"), body);
    assert.ok(body.includes(`refs/heads/main ${LOCAL_SHA} refs/heads/main ${REMOTE_SHA}`), body);
  });
});

// ---------------------------------------------------------------------------
// The pin (doc/plan-pin-enforcement-binary.md): T1, T6, T12
// ---------------------------------------------------------------------------

const HOOKS: readonly HookName[] = ["pre-commit", "pre-push"];

/** The non-comment lines of a rendered script. */
function codeLines(text: string): string[] {
  return text.split("\n").filter(l => !/^\s*#/.test(l));
}

describe("rendered hook scripts — T1: the pin is in, the bare name is out", () => {
  const pin: EnforcementPin = { node: "/opt/node/bin/node", cli: "/opt/ra/dist/index.js" };

  for (const name of HOOKS) {
    it(`${name} contains the pinned node and CLI paths`, () => {
      const text = renderHookScript(name, pin);
      assert.ok(text.includes("/opt/node/bin/node"), "pinned node path missing");
      assert.ok(text.includes("/opt/ra/dist/index.js"), "pinned CLI path missing");
      assert.ok(text.includes('"$__ra_node" "$__ra_cli"'), "calls do not go through the pin");
    });

    it(`${name} has no command-position \`repo-aegis\`; \`command -v repo-aegis\` appears once, only inside the pin-gone fallback`, () => {
      const code = codeLines(renderHookScript(name, pin)).join("\n");
      assert.equal(code.split("command -v repo-aegis").length - 1, 1, "resolves repo-aegis by name outside the fallback");
      assert.ok(
        code.indexOf("command -v repo-aegis") > code.indexOf('if [ -n "$__ra_missing" ]; then'),
        "the PATH lookup runs before the pin is known to be unusable",
      );
      // A command position: line start, after `!`, `then`, `;`, `&&`, `||`, `$(` or a backtick.
      assert.ok(
        !/(^|[;&|(!`]|\bthen\b|\bdo\b|\$\()\s*repo-aegis(\s|$)/m.test(code),
        "still calls repo-aegis by name",
      );
    });

    it(`${name} differs for a different pin (the digest input is the rendered script)`, () => {
      assert.notEqual(
        renderHookScript(name, pin),
        renderHookScript(name, { ...pin, cli: "/opt/other/dist/index.js" }),
      );
    });
  }
});

/** Runs a rendered hook in `dir` (no git repo needed for the fail-closed path). */
function runHook(dir: string, name: HookName, pin: EnforcementPin, stdin = "") {
  const script = join(dir, name);
  writeFileSync(script, renderHookScript(name, pin), { mode: 0o755 });
  chmodSync(script, 0o755);
  return spawnSync("bash", [script, "origin", "git@github.com:acme/svc.git"], {
    cwd: dir,
    input: stdin,
    encoding: "utf8",
    env: { ...process.env, ARGV_LOG: join(dir, "argv.log"), REPO_AEGIS_HOME: join(dir, "home") },
  });
}

describe("rendered hook scripts — T6: a missing pinned binary fails closed", () => {
  for (const name of HOOKS) {
    it(`${name} exits 1 naming the missing CLI path and the installer when the CLI is gone`, () => {
      const dir = join(tmp, `gone-cli-${name}`);
      mkdirSync(dir, { recursive: true });
      const missing = join(dir, "dist", "index.js");
      const r = runHook(dir, name, pinTo(missing), `refs/heads/main ${LOCAL_SHA} refs/heads/main ${ZERO}\n`);
      assert.equal(r.status, 1, `stdout=${r.stdout} stderr=${r.stderr}`);
      assert.ok(r.stderr.includes(missing), r.stderr);
      assert.ok(r.stderr.includes("repo-aegis install hooks"), r.stderr);
    });

    it(`${name} exits 1 naming the missing node path when node is gone`, () => {
      const dir = join(tmp, `gone-node-${name}`);
      mkdirSync(dir, { recursive: true });
      const cli = join(dir, "fake-cli.cjs");
      writeFakeCli(cli);
      const missingNode = join(dir, "no-such-node");
      const r = runHook(dir, name, { node: missingNode, cli });
      assert.equal(r.status, 1, `stdout=${r.stdout} stderr=${r.stderr}`);
      assert.ok(r.stderr.includes(missingNode), r.stderr);
      assert.ok(r.stderr.includes("repo-aegis install hooks"), r.stderr);
    });
  }

  it("pre-commit still runs the pinned CLI (and passes) when the pin is intact", () => {
    const dir = join(tmp, "intact");
    mkdirSync(dir, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: dir, stdio: "ignore" });
    const cli = join(dir, "fake-cli.cjs");
    writeFakeCli(cli);
    const r = runHook(dir, "pre-commit", pinTo(cli));
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readFileSync(join(dir, "argv.log"), "utf8"), "check --staged\n");
  });
});

describe("rendered hook scripts — T12: quoting", () => {
  it("round-trips a pin whose paths hold spaces and quotes", () => {
    const dir = join(tmp, "quoting");
    const odd = join(dir, `a b'c "d" $HOME \`x\``);
    mkdirSync(odd, { recursive: true });
    const cli = join(odd, "cli file.cjs");
    writeFakeCli(cli);
    const node = join(odd, "n o'de");
    symlinkSync(process.execPath, node);

    for (const name of HOOKS) {
      const r = runHook(dir, name, { node, cli }, `refs/heads/main ${LOCAL_SHA} refs/heads/main ${REMOTE_SHA}\n`);
      assert.equal(r.status, 0, `${name}: ${r.stderr}`);
    }
    const lines = readFileSync(join(dir, "argv.log"), "utf8").split("\n").filter(l => l !== "");
    assert.equal(lines[0], "check --staged");
    assert.match(lines[1]!, /^check --range /);
  });

  it("refuses to render a pin whose path holds a newline or a NUL", () => {
    for (const bad of ["/opt/a\nb/node", "/opt/a\0b/node"]) {
      for (const name of HOOKS) {
        assert.throws(() => renderHookScript(name, { node: bad, cli: "/opt/ra/dist/index.js" }), /newline|NUL/i);
        assert.throws(() => renderHookScript(name, { node: "/opt/node", cli: bad }), /newline|NUL/i);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// The PATH fallback (P1-D): a gone pin is replaced only by a repo-aegis on PATH that is at least as new
// ---------------------------------------------------------------------------

interface FallbackRun {
  status: number | null;
  stderr: string;
  /** What the PATH stub was asked to do (one line per call that was not `--version`). */
  argv: string[];
  /** Whether the stub ran at all, `--version` included. */
  stubCalled: boolean;
}

/**
 * Runs the rendered `name` script under bash. The pin points at files that do not exist (unless `cli` is given),
 * and PATH holds a stub `repo-aegis` (when `stubVersion` is not null) that prints `stubVersion` for `--version` and
 * otherwise logs its argv and exits 0.
 */
function runFallback(
  label: string,
  name: HookName,
  pin: EnforcementPin,
  stubVersion: string | null,
  stdin = `refs/heads/main ${LOCAL_SHA} refs/heads/main ${ZERO}\n`,
): FallbackRun {
  const dir = join(tmp, `fb-${label}`);
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  const log = join(dir, "argv.log");
  const called = join(dir, "stub-called");
  if (stubVersion !== null) {
    const stub = join(bin, "repo-aegis");
    writeFileSync(
      stub,
      `#!/bin/sh\n: > "$STUB_CALLED"\nif [ "$1" = "--version" ]; then printf '%s\\n' "$VER"; exit 0; fi\necho "$*" >> "$ARGV_LOG"\nexit 0\n`,
      { mode: 0o755 },
    );
    chmodSync(stub, 0o755);
  }
  const script = join(dir, name);
  writeFileSync(script, renderHookScript(name, pin), { mode: 0o755 });
  chmodSync(script, 0o755);
  const r = spawnSync("bash", [script, "origin", "git@github.com:acme/svc.git"], {
    cwd: dir,
    input: stdin,
    encoding: "utf8",
    env: {
      PATH: `${bin}:/usr/bin:/bin`,
      HOME: dir,
      ARGV_LOG: log,
      STUB_CALLED: called,
      VER: stubVersion ?? "",
      REPO_AEGIS_HOME: join(dir, "home"),
    },
  });
  let argv: string[] = [];
  try {
    argv = readFileSync(log, "utf8").split("\n").filter(l => l !== "");
  } catch {
    /* no call recorded */
  }
  let stubCalled = false;
  try {
    stubCalled = readFileSync(called, "utf8") === "";
  } catch {
    /* never ran */
  }
  return { status: r.status, stderr: r.stderr, argv, stubCalled };
}

const gonePin = (label: string): EnforcementPin => ({
  node: join(tmp, `fb-${label}`, "no-node"),
  cli: join(tmp, `fb-${label}`, "no-cli.js"),
  version: "0.14.0",
});

describe("pre-push script: pin gone, PATH fallback", () => {
  for (const have of ["0.14.0", "0.14.1", "1.0.0", "0.100.0"]) {
    it(`a PATH repo-aegis ${have} (not older than the pinned 0.14.0) runs the push check, with a WARNING naming both`, () => {
      const label = `ok-${have}`;
      const r = runFallback(label, "pre-push", gonePin(label), have);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.argv.length, 1, JSON.stringify(r.argv));
      assert.match(r.argv[0]!, /^check --push-ref refs\/heads\/main --remote origin --remote-url git@github\.com:acme\/svc\.git$/);
      assert.match(r.stderr, /repo-aegis: WARNING: the pinned enforcement binary is missing or not usable \(.*no-node.*no-cli\.js\)/);
      assert.ok(r.stderr.includes(`(${have}, pinned 0.14.0) instead`), r.stderr);
      assert.ok(r.stderr.includes("/bin/repo-aegis"), "names the path it ran");
      assert.ok(r.stderr.includes("Re-pin it by running: repo-aegis install hooks"), r.stderr);
    });
  }

  it("an existing-ref push goes through the fallback too (check --range)", () => {
    const r = runFallback("range", "pre-push", gonePin("range"), "0.14.0", `refs/heads/main ${LOCAL_SHA} refs/heads/main ${REMOTE_SHA}\n`);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.argv[0]!, /^check --range 2{40}\.\.1{40} --remote-url /);
  });

  for (const have of ["0.13.9", "0.9.0"]) {
    it(`an older PATH repo-aegis ${have} is refused (exit 1): both versions named, no check run`, () => {
      const label = `older-${have}`;
      const r = runFallback(label, "pre-push", gonePin(label), have);
      assert.equal(r.status, 1, r.stderr);
      assert.ok(r.stderr.includes(`is ${have}, older than the pinned 0.14.0`), r.stderr);
      assert.ok(r.stderr.includes("Install 0.14.0 or later, then run: repo-aegis install hooks"), r.stderr);
      assert.deepEqual(r.argv, [], "the stub never got `check`");
    });
  }

  it("no repo-aegis on PATH is refused (exit 1) and says so", () => {
    const r = runFallback("none", "pre-push", gonePin("none"), null);
    assert.equal(r.status, 1, r.stderr);
    assert.ok(r.stderr.includes("no repo-aegis is on PATH"), r.stderr);
    assert.ok(r.stderr.includes("Re-pin it by running: repo-aegis install hooks"), r.stderr);
    assert.ok(!r.stderr.includes("WARNING"));
  });

  for (const [i, version] of ["0.14.0-rc.1", "v0.14.0", "0.14", "", "1234567890.0.0", "9.9.9-secret-token"].entries()) {
    it(`a PATH repo-aegis that prints ${JSON.stringify(version)} is refused as not a plain version, and never echoed`, () => {
      const label = `unparsable-${i}`;
      const r = runFallback(label, "pre-push", gonePin(label), version);
      assert.equal(r.status, 1, r.stderr);
      assert.ok(r.stderr.includes("did not report a plain MAJOR.MINOR.PATCH version (pinned 0.14.0)"), r.stderr);
      assert.ok(!r.stderr.includes("secret-token"), "the --version output must not be echoed");
      assert.deepEqual(r.argv, []);
    });
  }

  it("a pin without a recorded version never falls back, however new the PATH repo-aegis is", () => {
    const { version: _dropped, ...noVersion } = gonePin("noversion");
    const r = runFallback("noversion", "pre-push", noVersion, "99.0.0");
    assert.equal(r.status, 1, r.stderr);
    assert.ok(r.stderr.includes("installed without a recorded version"), r.stderr);
    assert.deepEqual(r.argv, []);
    assert.equal(r.stubCalled, false, "no version, so PATH is not even asked");
  });

  it("a valid pin never looks at PATH: the stub is not called, not even with --version", () => {
    const dir = join(tmp, "fb-valid");
    mkdirSync(dir, { recursive: true });
    const cli = join(dir, "fake-cli.cjs");
    writeFakeCli(cli);
    const r = runFallback("valid", "pre-push", { node: process.execPath, cli, version: "0.14.0" }, "99.0.0");
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stubCalled, false, "the PATH stub ran");
    assert.ok(!r.stderr.includes("WARNING"), r.stderr);
  });

  it("the fallback does not eat git's ref list: --version runs with stdin closed", () => {
    const stdin = `refs/heads/a ${LOCAL_SHA} refs/heads/a ${ZERO}\nrefs/heads/b ${LOCAL_SHA} refs/heads/b ${ZERO}\n`;
    const r = runFallback("stdin", "pre-push", gonePin("stdin"), "0.14.0", stdin);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.argv.length, 2, "both refs were checked");
  });

  it("a PATH repo-aegis that is not an absolute path (a relative PATH entry) is not used", () => {
    const dir = join(tmp, "fb-relative");
    mkdirSync(join(dir, "rel"), { recursive: true });
    const stub = join(dir, "rel", "repo-aegis");
    writeFileSync(stub, "#!/bin/sh\necho 99.0.0\n", { mode: 0o755 });
    chmodSync(stub, 0o755);
    const script = join(dir, "pre-push");
    writeFileSync(script, renderHookScript("pre-push", { node: join(dir, "n"), cli: join(dir, "c"), version: "0.14.0" }), { mode: 0o755 });
    const r = spawnSync("bash", [script], {
      cwd: dir,
      input: `refs/heads/main ${LOCAL_SHA} refs/heads/main ${ZERO}\n`,
      encoding: "utf8",
      env: { PATH: "rel:/usr/bin:/bin", HOME: dir },
    });
    assert.equal(r.status, 1, r.stderr);
    assert.ok(r.stderr.includes("no repo-aegis is on PATH"), r.stderr);
  });
});

describe("pre-commit script: pin gone, PATH fallback", () => {
  it("runs `check --staged` on a PATH repo-aegis that is at least as new, with a WARNING", () => {
    const r = runFallback("pc-ok", "pre-commit", gonePin("pc-ok"), "0.14.2", "");
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.argv, ["check --staged"]);
    assert.ok(r.stderr.includes("WARNING"), r.stderr);
  });

  it("refuses (exit 1) on an older one, and the stub never got check", () => {
    const r = runFallback("pc-older", "pre-commit", gonePin("pc-older"), "0.13.0", "");
    assert.equal(r.status, 1, r.stderr);
    assert.ok(r.stderr.includes("pre-commit blocked"), r.stderr);
    assert.deepEqual(r.argv, []);
  });

  it("a hit on the fallback blocks the commit (its exit status is not swallowed)", () => {
    const dir = join(tmp, "fb-pc-hit");
    const bin = join(dir, "bin");
    mkdirSync(bin, { recursive: true });
    const stub = join(bin, "repo-aegis");
    writeFileSync(stub, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 0.14.0; exit 0; fi\nexit 1\n`, { mode: 0o755 });
    chmodSync(stub, 0o755);
    const script = join(dir, "pre-commit");
    writeFileSync(script, renderHookScript("pre-commit", gonePin("pc-hit")), { mode: 0o755 });
    const r = spawnSync("bash", [script], { cwd: dir, encoding: "utf8", env: { PATH: `${bin}:/usr/bin:/bin`, HOME: dir } });
    assert.equal(r.status, 1, r.stderr);
  });
});
