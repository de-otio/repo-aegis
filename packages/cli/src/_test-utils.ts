// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
// Test-only helpers shared across command test files.
// Filename underscore-prefixed so it's clearly not a runtime module.
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { setAncestryReaderForTests, type AncestorInfo } from "@de-otio/repo-aegis-core";

/**
 * What `ps` shows for a person's own terminal session: zsh <- -zsh <- login <- Terminal. It reaches a
 * positive root (login), which `approve` and the owner adds now require. Names only; no agent above it.
 */
export const PERSON_ANCESTRY: readonly AncestorInfo[] = [
  { pid: 14, ppid: 13, comm: "zsh", argv: ["/bin/zsh"], exe: "/bin/zsh" },
  { pid: 13, ppid: 12, comm: "-zsh", argv: ["-zsh"], exe: "-zsh" },
  { pid: 12, ppid: 11, comm: "login", argv: ["login", "-pf", "me"], exe: "/usr/bin/login", uid: 0 },
  {
    pid: 11,
    ppid: 1,
    comm: "Terminal",
    argv: ["/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal"],
    exe: "/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal",
    uid: 501,
  },
];

/** What `ps` shows under a Claude Code session: the same shell shape with `claude` between the shell and the login. */
export const UNDER_CLAUDE_ANCESTRY: readonly AncestorInfo[] = [
  { pid: 15, ppid: 14, comm: "zsh", argv: ["/bin/zsh"], exe: "/bin/zsh" },
  { pid: 14, ppid: 13, comm: "claude", argv: ["claude"], exe: "/Users/me/.local/" },
  ...PERSON_ANCESTRY,
];

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
 * Pin `stream.isTTY` for the duration of `fn`. Whether the test runner's own
 * stderr/stdin is a terminal depends on how a developer invoked it; pinning it
 * makes both sides of a human-presence gate assertable WITHOUT the
 * `stderrIsTTY` seam, so the default (`process.stderr.isTTY`) path is tested.
 *
 * A pinned stderr TTY is also pinned "no agent above this process": the real
 * process-ancestry walk would otherwise make these tests depend on whether the
 * developer ran them under an agent host (issue #151, PR 2b).
 */
export function withStreamTty<T>(stream: "stderr" | "stdin", isTty: boolean, fn: () => T): T {
  const target = process[stream];
  const desc = Object.getOwnPropertyDescriptor(target, "isTTY");
  Object.defineProperty(target, "isTTY", { value: isTty, configurable: true, writable: true });
  if (stream === "stderr") setAncestryReaderForTests(() => PERSON_ANCESTRY);
  try {
    return fn();
  } finally {
    if (stream === "stderr") setAncestryReaderForTests(undefined);
    if (desc) Object.defineProperty(target, "isTTY", desc);
    else delete (target as { isTTY?: boolean }).isTTY;
  }
}

/** Async variant of {@link withStreamTty}. */
export async function withStreamTtyAsync<T>(
  stream: "stderr" | "stdin",
  isTty: boolean,
  fn: () => Promise<T>,
): Promise<T> {
  const target = process[stream];
  const desc = Object.getOwnPropertyDescriptor(target, "isTTY");
  Object.defineProperty(target, "isTTY", { value: isTty, configurable: true, writable: true });
  if (stream === "stderr") setAncestryReaderForTests(() => PERSON_ANCESTRY);
  try {
    return await fn();
  } finally {
    if (stream === "stderr") setAncestryReaderForTests(undefined);
    if (desc) Object.defineProperty(target, "isTTY", desc);
    else delete (target as { isTTY?: boolean }).isTTY;
  }
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

const GIT_SCRUBBED =
  /^(GIT_SSH.*|GIT_CONFIG_(COUNT|PARAMETERS|KEY_\d+|VALUE_\d+)|GIT_DIR|GIT_WORK_TREE|REPO_AEGIS_EGRESS_HUMAN|SRT_SSH_PROXY_COMMAND)$/;

/**
 * Make the process's git environment hermetic: no outer `GIT_SSH_COMMAND`,
 * `GIT_CONFIG_*` (a sandbox or CI wrapper often sets them; the ssh override
 * check reads exactly these), global and system git config off. Returns the undo.
 */
export function scrubGitEnv(): () => void {
  const saved: Record<string, string | undefined> = {};
  const touch = (name: string, value: string | undefined): void => {
    if (!(name in saved)) saved[name] = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };
  for (const name of Object.keys(process.env)) if (GIT_SCRUBBED.test(name)) touch(name, undefined);
  touch("GIT_CONFIG_GLOBAL", "/dev/null");
  touch("GIT_CONFIG_NOSYSTEM", "1");
  return () => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}

/** An environment for a child `git`: the current one, scrubbed of ssh/config overrides, plus `extra`. */
export function hermeticGitEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!GIT_SCRUBBED.test(k)) env[k] = v;
  env["GIT_CONFIG_GLOBAL"] = "/dev/null";
  env["GIT_CONFIG_NOSYSTEM"] = "1";
  return { ...env, ...extra };
}

/**
 * Point `$TMPDIR` at a fresh empty directory (the decision log's fallback lives under it: a suite that runs `doctor` must
 * not read a fallback some other test left in the real one). Returns the restore-and-clean-up function.
 */
export function isolateTmpdir(): () => void {
  const saved = process.env["TMPDIR"];
  const dir = mkdtempSync(join(tmpdir(), "repo-aegis-isolated-tmp-"));
  process.env["TMPDIR"] = dir;
  return () => {
    if (saved === undefined) delete process.env["TMPDIR"];
    else process.env["TMPDIR"] = saved;
    rmSync(dir, { recursive: true, force: true });
  };
}
