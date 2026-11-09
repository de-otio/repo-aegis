// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// taaad's documented `mint` exit codes (agreed for its presence-prompt release): 3 = prompt budget spent,
// 4 = the person declined the prompt. Each gets its own fixed message; taaad's stderr is never passed on.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyMintFailure, mintAppToken, MintError, SPAWN_TIMEOUT_MS, spawnFailure, type MintFailureReason } from "./taaad-mint.js";

let tmp: string;
before(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "taaad-mint-test-")));
});
after(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function stub(name: string, exit: number): string {
  const p = join(tmp, name);
  writeFileSync(p, `#!/bin/sh\necho "secret-looking stderr ghs_${"A".repeat(36)}" >&2\nexit ${exit}\n`);
  chmodSync(p, 0o755);
  return p;
}

function mintWith(path: string): MintError {
  try {
    mintAppToken({ taaadPath: path, slug: "example-bot", owner: "example-org", repo: "svc", scope: "read" });
  } catch (err) {
    assert.ok(err instanceof MintError);
    return err;
  }
  assert.fail("mint should have refused");
}

describe("mintAppToken: taaad's refusal exit codes", () => {
  it("3 says the prompt limit is reached", () => {
    assert.match(mintWith(stub("t3", 3)).message, /prompt limit/);
  });
  it("4 says the human declined the prompt", () => {
    assert.match(mintWith(stub("t4", 4)).message, /declined/);
  });
  it("any other non-zero is the generic failure", () => {
    assert.match(mintWith(stub("t1", 1)).message, /exited with a failure/);
  });
  it("taaad's stderr never appears in the message", () => {
    for (const code of [1, 3, 4]) assert.ok(!mintWith(stub(`s${code}`, code)).message.includes("ghs_"));
  });
  it("2 says taaad refused a terminal", () => {
    assert.equal(mintWith(stub("t2", 2)).reason, "tty");
  });
});

describe("classifyMintFailure: taaad's exit-1 texts become a fixed reason (stderr matched, never copied)", () => {
  // taaad v0.6 `taaad mint` stderr lines, with a customer-like owner and a token-like string in them.
  const cases: ReadonlyArray<readonly [string, MintFailureReason]> = [
    ["error: taaad mint: taaad-signer: User interaction is not allowed.", "screen-locked"],
    ["error: taaad mint: taaad-signer: taaad-signer sign timed out after 240s", "timeout"],
    ["error: taaad mint: taaad-signer: taaad-signer exited 7", "signer"],
    ["error: taaad mint: app example-bot has no install_id yet", "not-installed"],
    ["error: taaad mint: repository owner 'customer-a-org' is not the installation account 'example-org'; refusing", "installation-mismatch"],
    ["error: taaad mint: contents:write is not granted to the installation", "permission-not-granted"],
    ["error: taaad mint: GitHub 422: There is at least one repository that does not exist or is not accessible to the parent installation.", "repo-not-covered"],
    ["error: taaad mint: something new", "failed"],
    ["", "failed"],
  ];
  for (const [stderr, reason] of cases) {
    it(`${reason}: ${stderr.slice(19, 70) || "(empty stderr)"}`, () => {
      const e = classifyMintFailure(1, `${stderr} ghs_${"A".repeat(36)}`);
      assert.equal(e.reason, reason);
      assert.equal(e.kind, reason === "installation-mismatch" ? "installation-mismatch" : "unavailable");
      for (const leak of ["customer-a-org", "ghs_", "example-bot"]) assert.ok(!e.message.includes(leak), leak);
    });
  }
  it("a taaad `error=<code>` line names the signer step verbatim, allowlisted codes only", () => {
    const coded = classifyMintFailure(1, "error: taaad mint: customer-a-org\ntaaad: error=keychain status=-25308\n", false);
    assert.equal(coded.reason, "signer");
    assert.match(coded.message, /step error=keychain status=-25308/);
    assert.ok(!coded.message.includes("customer-a-org"), "only the code is copied");
    assert.equal(classifyMintFailure(1, "taaad: error=presence-denied", false).reason, "denied");
    assert.equal(classifyMintFailure(1, "taaad: error=rate-limited", false).reason, "rate-limited");
    assert.equal(classifyMintFailure(1, "taaad: error=app-mismatch", false).kind, "installation-mismatch");
    // An unknown code, or free text after it, is not trusted: the line is ignored.
    const unknown = classifyMintFailure(1, "taaad: error=customer-a-org", false);
    assert.equal(unknown.reason, "failed");
    assert.ok(!unknown.message.includes("customer-a-org"));
    assert.equal(classifyMintFailure(1, "taaad: error=keychain and more text", false).reason, "failed");
  });

  it("inside the agent sandbox, signer and generic failures say the sandbox is the likely cause; outside, they don't", () => {
    for (const stderr of ["taaad-signer exited 7", "something new", "taaad: error=keychain", "taaad: error=github"]) {
      assert.match(classifyMintFailure(1, stderr, true).message, /inside the agent's sandbox/, stderr);
      assert.doesNotMatch(classifyMintFailure(1, stderr, false).message, /sandbox/, stderr);
    }
    // Not for failures a sandbox cannot explain.
    assert.doesNotMatch(classifyMintFailure(1, "taaad: error=widened", true).message, /sandbox/);
    assert.doesNotMatch(classifyMintFailure(1, "app example-bot has no install_id yet", true).message, /sandbox/);
    assert.match(classifyMintFailure(1, "something new", false).message, /exit status 1/);
  });

  it("the exit code wins over stderr for 3 and 4", () => {
    assert.equal(classifyMintFailure(3, "taaad-signer: User interaction is not allowed").reason, "rate-limited");
    assert.equal(classifyMintFailure(4, "taaad-signer: User interaction is not allowed").reason, "denied");
  });
  it("end to end: a stub taaad that prints the locked-screen text", () => {
    const p = join(tmp, "locked");
    writeFileSync(p, `#!/bin/sh\necho "error: taaad mint: taaad-signer: User interaction is not allowed." >&2\nexit 1\n`);
    chmodSync(p, 0o755);
    assert.equal(mintWith(p).reason, "screen-locked");
  });
});

describe("the spawn: a timeout is reported as a timeout, and outlasts taaad-signer's 240 s prompt", () => {
  it("SPAWN_TIMEOUT_MS is longer than the signer's presence-prompt wait plus its GitHub calls", () => {
    assert.ok(SPAWN_TIMEOUT_MS >= 240_000 + 30_000, String(SPAWN_TIMEOUT_MS));
  });
  it("ETIMEDOUT is a timeout, not 'could not be run'", () => {
    const e = spawnFailure(Object.assign(new Error("spawnSync taaad ETIMEDOUT"), { code: "ETIMEDOUT" }));
    assert.equal(e.reason, "timeout");
    assert.match(e.message, /did not finish within 300 s/);
  });
  it("a launcher that is gone is not-runnable", () => {
    assert.equal(mintWith(join(tmp, "does-not-exist")).reason, "not-runnable");
  });
});
