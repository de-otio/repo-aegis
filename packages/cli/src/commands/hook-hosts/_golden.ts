// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// Test-only: golden-output recorder for `hook guard-egress` (plan T1a,
// doc/plan-landscape-recommendations.md §5). Underscore-prefixed: not a
// runtime module.
//
// Why it exists: the host-adapter refactor must not change a single byte the
// hook prints. The proof is a behaviour comparison: run every existing
// guard-egress test input and every host fixture against the OLD code with
// `REPO_AEGIS_GUARD_GOLDEN=record`, commit what it printed, then run the same
// tests against the NEW code with `REPO_AEGIS_GUARD_GOLDEN=compare`, which
// asserts byte-identical stdout, stderr and exit code per invocation.
//
// It is opt-in (unset → does nothing) on purpose. Always-on golden files fail
// on every intended wording change and teach people to re-record without
// looking; the semantic assertions in the test files are the standing net.
// Re-record only when the output is MEANT to change, and say so in the PR.
//
// Invocations are keyed by their normalised input (payload, agent, flags,
// cwd) plus an occurrence counter, not by order, so a test added later simply
// has no golden entry and is not compared.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
/** `src/commands/__fixtures__/hosts`, reached from `dist/commands/hook-hosts`. */
export const HOST_FIXTURES_DIR = resolve(here, "..", "..", "..", "src", "commands", "__fixtures__", "hosts");
const GOLDEN_DIR = resolve(HOST_FIXTURES_DIR, "golden");

export interface GoldenResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

type Mode = "record" | "compare" | undefined;

function mode(): Mode {
  const m = process.env["REPO_AEGIS_GUARD_GOLDEN"];
  return m === "record" || m === "compare" ? m : undefined;
}

/**
 * Replace what legitimately differs between two runs: the per-run temp root,
 * approval ids (random 8 hex) and ISO timestamps. Applied to keys and values
 * alike, identically for old and new code, so it cannot hide a difference the
 * refactor introduced.
 */
function normalise(s: string, tmpRoots: readonly string[]): string {
  let out = s;
  for (const root of tmpRoots) out = out.split(root).join("<TMP>");
  return out
    .replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/g, "<TS>")
    .replace(/\b[0-9a-f]{8}\b/g, "<ID>");
}

interface Suite {
  file: string;
  entries: Record<string, GoldenResult>;
  seen: Map<string, number>;
  compared: Set<string>;
}

const suites = new Map<string, Suite>();

function suite(name: string): Suite {
  let s = suites.get(name);
  if (s === undefined) {
    const file = resolve(GOLDEN_DIR, `${name}.json`);
    const entries =
      mode() === "compare" && existsSync(file)
        ? (JSON.parse(readFileSync(file, "utf8")) as Record<string, GoldenResult>)
        : {};
    s = { file, entries, seen: new Map(), compared: new Set() };
    suites.set(name, s);
  }
  return s;
}

/**
 * Record or compare one hook invocation. No-op unless
 * `REPO_AEGIS_GUARD_GOLDEN` is `record` or `compare`.
 *
 * @param suiteName one golden file per test file
 * @param key       everything that determines the output: payload, agent, flags, cwd
 * @param tmpRoots  per-run temp directories to normalise away
 */
export function golden(suiteName: string, key: Record<string, unknown>, result: GoldenResult, tmpRoots: readonly string[]): void {
  const m = mode();
  if (m === undefined) return;
  const s = suite(suiteName);
  const full = normalise(JSON.stringify(key), tmpRoots);
  // The 1 MiB-cap tests feed megabyte payloads; keep keys readable and the file small.
  const base = full.length <= 400 ? full : `${full.slice(0, 300)}…sha256:${createHash("sha256").update(full).digest("hex")}`;
  const n = (s.seen.get(base) ?? 0) + 1;
  s.seen.set(base, n);
  const k = `${base}#${n}`;
  const value: GoldenResult = {
    stdout: normalise(result.stdout, tmpRoots),
    stderr: normalise(result.stderr, tmpRoots),
    code: result.code,
  };
  if (m === "record") {
    s.entries[k] = value;
    mkdirSync(GOLDEN_DIR, { recursive: true });
    // Rewritten whole on each call: the test process may end at any point.
    writeFileSync(s.file, JSON.stringify(s.entries, null, 2) + "\n");
    return;
  }
  const want = s.entries[k];
  if (want === undefined) return; // added after the recording: not compared
  s.compared.add(k);
  assert.deepEqual(value, want, `guard-egress output changed for golden key ${k}`);
}

/**
 * In compare mode, assert every recorded entry was replayed. Without this, a
 * key that drifted (say, a normalisation slip) would leave every entry
 * unmatched and the comparison would pass having compared nothing. Call from
 * the suite's `after`.
 */
export function assertGoldenComplete(suiteName: string): void {
  if (mode() !== "compare") return;
  const s = suite(suiteName);
  const missing = Object.keys(s.entries).filter(k => !s.compared.has(k));
  assert.deepEqual(missing, [], `golden entries recorded but not replayed in ${suiteName}`);
  assert.ok(s.compared.size > 0, `compare mode replayed nothing for ${suiteName}`);
}
