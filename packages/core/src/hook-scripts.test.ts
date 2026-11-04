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

    it(`${name} has no command-position \`repo-aegis\` and no \`command -v repo-aegis\``, () => {
      const code = codeLines(renderHookScript(name, pin)).join("\n");
      assert.ok(!/command -v repo-aegis/.test(code), "still resolves repo-aegis by name");
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
