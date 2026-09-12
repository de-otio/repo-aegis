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
// Placeholder orgs only (`acme`) — this repository is public.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { PRE_PUSH_SCRIPT } from "./hook-scripts.js";

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
 * Run PRE_PUSH_SCRIPT with `args` as its positional arguments and `stdin` as
 * git's ref list, and return one line per `repo-aegis` invocation: the argv it
 * was called with, space-joined.
 */
function runPrePush(name: string, args: string[], stdin: string): string[] {
  const dir = join(tmp, name);
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });

  const script = join(dir, "pre-push");
  writeFileSync(script, PRE_PUSH_SCRIPT, { mode: 0o755 });
  chmodSync(script, 0o755);

  const log = join(dir, "argv.log");
  const fake = join(bin, "repo-aegis");
  writeFileSync(fake, `#!/bin/sh\nprintf '%s\\n' "$*" >> "$ARGV_LOG"\nexit 0\n`, { mode: 0o755 });
  chmodSync(fake, 0o755);

  execFileSync("bash", [script, ...args], {
    cwd: dir,
    input: stdin,
    env: {
      ...process.env,
      PATH: `${bin}${delimiter}${process.env["PATH"] ?? ""}`,
      ARGV_LOG: log,
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

describe("PRE_PUSH_SCRIPT — remote URL pass-through", () => {
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

describe("PRE_PUSH_SCRIPT — chaining to the repo's own pre-push", () => {
  it("replays git's ref list to a chained .git/hooks/pre-push (BSD mktemp needs a template)", () => {
    // Before the template fix, `mktemp` with no argument printed nothing on
    // macOS, `|| true` hid the usage error, and the chained hook was never
    // exec'd. This test runs the real script in a real repo with a chained
    // hook that records what it received.
    const dir = join(tmp, "chain");
    const bin = join(dir, "bin");
    mkdirSync(bin, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: dir, stdio: "ignore" });

    const fake = join(bin, "repo-aegis");
    writeFileSync(fake, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    chmodSync(fake, 0o755);

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
    writeFileSync(script, PRE_PUSH_SCRIPT, { mode: 0o755 });
    chmodSync(script, 0o755);

    const stdin = `refs/heads/main ${LOCAL_SHA} refs/heads/main ${REMOTE_SHA}\n`;
    execFileSync("bash", [script, "origin", "git@github.com:acme/svc.git"], {
      cwd: dir,
      input: stdin,
      env: { ...process.env, PATH: `${bin}${delimiter}${process.env["PATH"] ?? ""}` },
      encoding: "utf8",
    });

    const body = readFileSync(received, "utf8");
    assert.ok(body.startsWith("args=origin git@github.com:acme/svc.git\n"), body);
    assert.ok(body.includes(`refs/heads/main ${LOCAL_SHA} refs/heads/main ${REMOTE_SHA}`), body);
  });
});
