// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// Test-only: read the host hook fixtures in `src/commands/__fixtures__/hosts/`
// (index.json describes each one). Underscore-prefixed: not a runtime module.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HOST_FIXTURES_DIR } from "./_golden.js";

/** The placeholder cwd every fixture uses; tests replace it with a real directory. */
export const FIXTURE_CWD = "/home/user/work/example-repo";

export interface FixtureEntry {
  file: string;
  host: string;
  agent: string;
  event: string;
  provenance: "observed" | "doc-derived";
  /** Keys to the shell command; `"<json>"` = decode a JSON string here. `null` = no command (observe-only event). */
  commandPath: string[] | null;
}

export function loadFixtureIndex(): FixtureEntry[] {
  const raw = JSON.parse(readFileSync(join(HOST_FIXTURES_DIR, "index.json"), "utf8")) as { fixtures: FixtureEntry[] };
  return raw.fixtures;
}

export function loadFixture(f: FixtureEntry): unknown {
  return JSON.parse(readFileSync(join(HOST_FIXTURES_DIR, f.file), "utf8")) as unknown;
}

/**
 * A copy of `payload` with `command` at `path`, decoding and re-encoding a
 * JSON-string hop (`"<json>"`, Copilot's `toolArgs`) on the way. The input is
 * not modified.
 */
export function withCommand(payload: unknown, path: readonly string[], command: string): unknown {
  const clone = structuredClone(payload) as Record<string, unknown>;
  const set = (obj: Record<string, unknown>, rest: readonly string[]): void => {
    const [key, next, ...tail] = rest;
    if (key === undefined) return;
    if (next === undefined) {
      obj[key] = command;
      return;
    }
    if (next === "<json>") {
      const inner = JSON.parse(obj[key] as string) as Record<string, unknown>;
      set(inner, tail);
      obj[key] = JSON.stringify(inner);
      return;
    }
    set(obj[key] as Record<string, unknown>, [next, ...tail]);
  };
  set(clone, path);
  return clone;
}
