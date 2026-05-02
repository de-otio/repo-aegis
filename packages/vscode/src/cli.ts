// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
// Thin wrapper around child_process for invoking the repo-aegis CLI.
// Kept in its own module so unit tests can stub `runCli` without booting
// VSCode.
//
// We intentionally do NOT import @de-otio/repo-aegis-core at runtime —
// VSCode extensions run in a node-CJS context, the core package is ESM,
// and bundling it into the extension is brittle compared to shelling
// out to the user-installed CLI. We only import its exported types.

import { execFile } from "node:child_process";

export interface RunCliResult {
  /** Process exit code. 0 = clean, 1 = hit, 2 = error per repo-aegis convention. */
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunCliOptions {
  cli: string;
  args: string[];
  cwd?: string;
  /** Hard wall-clock timeout in ms. Default 15s. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Spawn the repo-aegis CLI and capture stdout/stderr/exit-code.
 *
 * Never rejects on a non-zero exit code — repo-aegis uses exit codes
 * meaningfully (1 = hit), and treating those as exceptions would obscure
 * the JSON payload. Only rejects on spawn failure (CLI not on PATH,
 * timeout, etc.).
 */
export function runCli(opts: RunCliOptions): Promise<RunCliResult> {
  const { cli, args, cwd, timeoutMs = DEFAULT_TIMEOUT_MS } = opts;
  return new Promise((resolve, reject) => {
    execFile(
      cli,
      args,
      {
        cwd,
        timeout: timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
        // Inherit env so REPO_AEGIS_HOME / PATH carry through.
        env: process.env,
      },
      (err, stdout, stderr) => {
        if (err && (err as NodeJS.ErrnoException).code === "ENOENT") {
          reject(err);
          return;
        }
        // execFile sets err.code to the exit code on non-zero. Use it.
        const code =
          err && typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === "number"
            ? ((err as unknown as { code: number }).code)
            : err
              ? 2
              : 0;
        resolve({
          code,
          stdout: stdout.toString(),
          stderr: stderr.toString(),
        });
      },
    );
  });
}

/**
 * Parse the stdout of a repo-aegis `--json` invocation. Returns null if
 * the body is empty or unparseable — callers decide whether that's an
 * error or expected (e.g. a clean scan that the CLI prints as text when
 * --json was forgotten).
 */
export function parseJson<T>(stdout: string): T | null {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return null;
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    return null;
  }
}

/** Probe the CLI for its version. Resolves to null if the CLI is missing. */
export async function probeVersion(cli: string): Promise<string | null> {
  try {
    const r = await runCli({ cli, args: ["--version"], timeoutMs: 5_000 });
    if (r.code !== 0) return null;
    return r.stdout.trim() || null;
  } catch {
    return null;
  }
}
