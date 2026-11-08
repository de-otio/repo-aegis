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
import { mintAppToken, MintError } from "./taaad-mint.js";

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
});
