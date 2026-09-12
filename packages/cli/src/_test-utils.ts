// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
// Test-only helpers shared across command test files.
// Filename underscore-prefixed so it's clearly not a runtime module.
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";

export class ExitError extends Error {
  constructor(public code: number) {
    super(`process.exit(${code})`);
  }
}

export interface CaptureResult {
  stdout: string;
  stderr: string;
  exitCode?: number;
}

export async function captureOutputAsync(fn: () => Promise<unknown> | unknown): Promise<CaptureResult> {
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  let exitCode: number | undefined;

  const origStdoutWrite = process.stdout.write.bind(process.stdout);
  const origStderrWrite = process.stderr.write.bind(process.stderr);
  const origExit = process.exit.bind(process);

  const restore = (): void => {
    process.stdout.write = origStdoutWrite;
    process.stderr.write = origStderrWrite;
    process.exit = origExit;
  };

  const patchedExit = (code?: number): never => {
    exitCode = code ?? 0;
    restore();
    throw new ExitError(code ?? 0);
  };

  process.stdout.write = (chunk: unknown): boolean => {
    stdoutChunks.push(Buffer.from(chunk as string));
    return true;
  };
  process.stderr.write = (chunk: unknown): boolean => {
    stderrChunks.push(Buffer.from(chunk as string));
    return true;
  };
  (process as NodeJS.Process).exit = patchedExit as typeof process.exit;

  try {
    await fn();
  } catch (e) {
    if (!(e instanceof ExitError)) {
      restore();
      throw e;
    }
  } finally {
    restore();
  }

  return {
    stdout: Buffer.concat(stdoutChunks).toString("utf8"),
    stderr: Buffer.concat(stderrChunks).toString("utf8"),
    exitCode,
  };
}

export function captureOutput(fn: () => void): CaptureResult {
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  let exitCode: number | undefined;

  const origStdoutWrite = process.stdout.write.bind(process.stdout);
  const origStderrWrite = process.stderr.write.bind(process.stderr);
  const origExit = process.exit.bind(process);

  const restore = (): void => {
    process.stdout.write = origStdoutWrite;
    process.stderr.write = origStderrWrite;
    process.exit = origExit;
  };

  const patchedExit = (code?: number): never => {
    exitCode = code ?? 0;
    restore();
    throw new ExitError(code ?? 0);
  };

  process.stdout.write = (chunk: unknown): boolean => {
    stdoutChunks.push(Buffer.from(chunk as string));
    return true;
  };
  process.stderr.write = (chunk: unknown): boolean => {
    stderrChunks.push(Buffer.from(chunk as string));
    return true;
  };
  (process as NodeJS.Process).exit = patchedExit as typeof process.exit;

  try {
    fn();
  } catch (e) {
    if (!(e instanceof ExitError)) {
      restore();
      throw e;
    }
  } finally {
    restore();
  }

  return {
    stdout: Buffer.concat(stdoutChunks).toString("utf8"),
    stderr: Buffer.concat(stderrChunks).toString("utf8"),
    exitCode,
  };
}

export async function withEnvAsync<T>(
  name: string,
  value: string | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = process.env[name];
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
  try {
    return await fn();
  } finally {
    if (prev === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = prev;
    }
  }
}

export function withEnv<T>(name: string, value: string | undefined, fn: () => T): T {
  const prev = process.env[name];
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
  try {
    return fn();
  } finally {
    if (prev === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = prev;
    }
  }
}

/**
 * Install an executable `gh` stub in `dir` and return `dir`.
 *
 * The GitHub visibility probe shells out to whatever `gh` is on PATH, so a
 * test that does not pin it is testing the developer's real GitHub account
 * over the network — nondeterministic, and on a machine with two `gh`
 * accounts it is precisely the failure this suite exists to pin down.
 * Pair with {@link withFakeGh}.
 *
 * `body` is the shell body of the stub, e.g. `echo PUBLIC` or
 * `echo "..." >&2; exit 1`.
 */
export function fakeGh(dir: string, body: string): string {
  mkdirSync(dir, { recursive: true });
  const stub = join(dir, "gh");
  writeFileSync(stub, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  // writeFileSync's `mode` is masked by the process umask on some systems;
  // chmod unconditionally so the stub is always executable.
  chmodSync(stub, 0o755);
  return dir;
}

/** Run `fn` with `dir` prepended to PATH (see {@link fakeGh}). */
export function withFakeGh<T>(dir: string, fn: () => T): T {
  return withEnv("PATH", `${dir}${delimiter}${process.env["PATH"] ?? ""}`, fn);
}

/**
 * Populate `dir` as a PATH that has NO `gh` on it but still reaches `git`,
 * and return it. Simply emptying PATH would also hide `git`, which every
 * command under test shells out to — the run would then fail for the wrong
 * reason and the test would pass vacuously. Pair with {@link withoutGh}.
 */
export function ghFreePath(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const gitBin = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  const link = join(dir, "git");
  if (!existsSync(link)) symlinkSync(gitBin, link);
  return dir;
}

/** Run `fn` with a PATH that reaches `git` but not `gh`. */
export function withoutGh<T>(dir: string, fn: () => T): T {
  return withEnv("PATH", ghFreePath(dir), fn);
}

/**
 * Parse the last non-empty line of a stream as JSON.
 *
 * `emitError` writes its JSON payload to stderr, but stderr may already
 * carry `warning:` lines from the same run — so parsing the whole buffer
 * fails. The payload is always the final line.
 */
export function lastJsonLine<T>(stream: string): T {
  const lines = stream.trim().split("\n").filter(l => l.trim() !== "");
  const last = lines[lines.length - 1];
  assertDefined(last, "expected at least one line of output");
  return JSON.parse(last) as T;
}

function assertDefined(v: unknown, msg: string): asserts v is NonNullable<unknown> {
  if (v === undefined || v === null) throw new Error(msg);
}
