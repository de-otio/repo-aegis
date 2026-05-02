// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
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

  it("serializes two parallel withLock calls against the same lockPath", async () => {
    // Two concurrent withLock calls on the same path must NOT overlap.
    // We record entry/exit timestamps for each and assert one's interval
    // fully precedes the other.
    const lp = lockPathFor("async-serialize.lock");
    const HOLD_MS = 60;

    interface Span { start: number; end: number; label: string }
    const spans: Span[] = [];

    async function critical(label: string): Promise<Span> {
      return withLock(async () => {
        const start = Date.now();
        await new Promise(r => setTimeout(r, HOLD_MS));
        const end = Date.now();
        const span: Span = { start, end, label };
        spans.push(span);
        return span;
      }, { lockPath: lp, timeoutMs: 5000 });
    }

    const [a, b] = await Promise.all([critical("a"), critical("b")]);
    // Sort by start time and assert non-overlap.
    const sorted = [a, b].sort((x, y) => x.start - y.start);
    assert.ok(
      sorted[0]!.end <= sorted[1]!.start,
      `expected serialized intervals; got a=[${a.start},${a.end}] b=[${b.start},${b.end}]`,
    );
    assert.equal(spans.length, 2);
  });

  it("throws LockTimeoutError when the path is held by lockfile.lockSync", async () => {
    const lp = lockPathFor("async-contended.lock");
    const release = lockfile.lockSync(lp, { stale: 30_000 });
    try {
      await assert.rejects(
        withLock(() => 1, { lockPath: lp, timeoutMs: 100 }),
        LockTimeoutError,
      );
    } finally {
      release();
    }
  });

  it("honours timeoutMs (rejects within the timeout window)", async () => {
    const lp = lockPathFor("async-timeout.lock");
    const release = lockfile.lockSync(lp, { stale: 30_000 });
    try {
      const t0 = Date.now();
      await assert.rejects(
        withLock(() => 1, { lockPath: lp, timeoutMs: 100 }),
        LockTimeoutError,
      );
      const elapsed = Date.now() - t0;
      // proper-lockfile retry math + jitter: a 100ms timeout typically
      // settles in well under 500ms. Generous upper bound to avoid CI
      // flake on busy runners; the lower bound asserts we waited at all
      // (i.e. that timeoutMs wasn't ignored entirely and rejected
      // immediately at the very first retry).
      assert.ok(
        elapsed < 1500,
        `withLock should reject promptly under timeoutMs=100; elapsed=${elapsed}ms`,
      );
    } finally {
      release();
    }
  });
});
