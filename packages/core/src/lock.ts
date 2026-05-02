// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
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
 * Run `fn` while holding the registry lock. Synchronous-friendly: `fn`
 * may be sync or async; returns the function's return value. The lock
 * is released even if `fn` throws.
 *
 * Stale locks (process died) are auto-cleared by proper-lockfile after
 * 30s.
 */
export async function withLock<T>(fn: () => T | Promise<T>, opts: LockOptions = {}): Promise<T> {
  const path = opts.lockPath ?? lockFilePath();
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  // proper-lockfile locks the *file* — needs to exist.
  if (!existsSync(path)) writeFileSync(path, "");

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
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  if (!existsSync(path)) writeFileSync(path, "");

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
