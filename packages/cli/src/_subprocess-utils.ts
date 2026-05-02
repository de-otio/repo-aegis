// Test-only helpers for subprocess-based CLI tests.
// Filename underscore-prefixed so it's clearly not a runtime module.
//
// Sibling of _test-utils.ts. Lives separately because subprocess tests
// need a built `dist/index.js` and can therefore be skipped when only
// the TS source is present (e.g. ad-hoc `node --test` against `*.ts`).

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Resolved path to the built CLI entry point. */
export const cliPath = resolve(__dirname, "..", "dist", "index.js");

/** True iff a built CLI bundle is available next to this file. */
export function cliBuilt(): boolean {
  return existsSync(cliPath);
}

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number | null;
  json?: unknown;
}

/**
 * Spawn the built CLI as a subprocess.
 *
 * Auto-parses JSON output when --json is passed, ignoring parse failures.
 * Tests that depend on this helper should guard their suite with
 * {@link cliBuilt} so a bare `node --test` against TS source skips
 * gracefully instead of exploding with ENOENT.
 */
export function runCli(home: string, cwd: string, args: string[]): RunResult {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    env: {
      ...process.env,
      REPO_AEGIS_HOME: home,
    },
    encoding: "utf8",
  });
  let json: unknown;
  if (args.includes("--json") && result.stdout.trim().length > 0) {
    try {
      json = JSON.parse(result.stdout);
    } catch {
      /* not JSON */
    }
  }
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    code: result.status,
    json,
  };
}
