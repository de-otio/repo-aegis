import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { withLock, withLockSync } from "./lock.js";
import { LockTimeoutError } from "./exceptions.js";

let tmp: string;

before(() => {
  tmp = mkdtempSync(join(tmpdir(), "repo-aegis-lock-test-"));
});

after(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function lockPathFor(name: string): string {
  const p = join(tmp, name);
  writeFileSync(p, "");
  return p;
}

describe("withLockSync", () => {
  it("runs fn while holding the lock and returns its result", () => {
    const lp = lockPathFor("happy.lock");
    const result = withLockSync(() => 42, { lockPath: lp });
    assert.equal(result, 42);
  });

  it("releases the lock even when fn throws", () => {
    const lp = lockPathFor("throw.lock");
    assert.throws(() => withLockSync(() => { throw new Error("boom"); }, { lockPath: lp }), /boom/);
    // Should be able to acquire it again immediately.
    const r = withLockSync(() => "ok", { lockPath: lp });
    assert.equal(r, "ok");
  });

  it("creates the lock file if missing", () => {
    const lp = join(tmp, "auto-create.lock");
    assert.equal(existsSync(lp), false);
    withLockSync(() => 1, { lockPath: lp });
    assert.ok(existsSync(lp));
  });

  it("throws LockTimeoutError when another process holds the lock", () => {
    const lp = lockPathFor("contended.lock");
    const release = lockfile.lockSync(lp, { stale: 30_000 });
    try {
      assert.throws(() => withLockSync(() => 1, { lockPath: lp }), LockTimeoutError);
    } finally {
      release();
    }
  });
});

describe("withLock (async)", () => {
  it("runs fn and returns its result", async () => {
    const lp = lockPathFor("async-happy.lock");
    const result = await withLock(() => 99, { lockPath: lp });
    assert.equal(result, 99);
  });

  it("supports async fn", async () => {
    const lp = lockPathFor("async-fn.lock");
    const result = await withLock(async () => {
      await new Promise(r => setTimeout(r, 5));
      return "done";
    }, { lockPath: lp });
    assert.equal(result, "done");
  });

  it("releases the lock when fn rejects", async () => {
    const lp = lockPathFor("async-reject.lock");
    await assert.rejects(withLock(async () => { throw new Error("x"); }, { lockPath: lp }), /x/);
    const r = await withLock(() => "ok", { lockPath: lp });
    assert.equal(r, "ok");
  });
});
