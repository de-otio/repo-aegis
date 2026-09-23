// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import lockfile from "proper-lockfile";
import { lockFilePath } from "./paths.js";
import { LockTimeoutError } from "./exceptions.js";

export interface LockOptions {
  /** ms to wait for the lock before throwing LockTimeoutError. Default 5000. */
  timeoutMs?: number;
  /** Override the lock target file. Default: lockFilePath() under the repo-aegis home. */
  lockPath?: string;
}

/**
 * proper-lockfile locks the *file*, so it must exist. Create it without a
 * check-then-write: `recursive` mkdir is idempotent, and append mode creates
 * the file when missing but never truncates one another process just made.
 */
function ensureLockTarget(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "", { flag: "a" });
}

/**
 * Run `fn` while holding the registry lock. Synchronous-friendly: `fn`
 * may be sync or async; returns the function's return value. The lock
 * is released even if `fn` throws.
 *
 * Stale locks (process died) are auto-cleared by proper-lockfile after
 * 30s.
 */
export async function withLock<T>(fn: () => T | Promise<T>, opts: LockOptions = {}): Promise<T> {
  const path = opts.lockPath ?? lockFilePath();
  ensureLockTarget(path);

  const timeout = opts.timeoutMs ?? 5000;
  let release: () => Promise<void>;
  try {
    release = await lockfile.lock(path, {
      stale: 30_000,
      retries: { retries: 10, factor: 1.5, minTimeout: 50, maxTimeout: timeout, randomize: true },
    });
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "ELOCKED" || code === "ENOTACQUIRED") {
      throw new LockTimeoutError(path);
    }
    throw err;
  }

  try {
    return await fn();
  } finally {
    try {
      await release();
    } catch {
      /* lock already released or compromised; nothing useful to do here */
    }
  }
}

/**
 * Synchronous variant. Used by code paths that can't easily go async
 * (e.g. existing CLI commands). proper-lockfile's lockSync exists for
 * this case.
 */
export function withLockSync<T>(fn: () => T, opts: LockOptions = {}): T {
  const path = opts.lockPath ?? lockFilePath();
  ensureLockTarget(path);

  let release: () => void;
  try {
    release = lockfile.lockSync(path, { stale: 30_000 });
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "ELOCKED" || code === "ENOTACQUIRED") {
      throw new LockTimeoutError(path);
    }
    throw err;
  }

  try {
    return fn();
  } finally {
    try {
      release();
    } catch {
      /* lock already released or compromised */
    }
  }
}
