// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// The I/O edge of egress-intent parsing (issue #151, §3.3 item 1 and S11): the
// two facts about the environment `gh` will run in that change where a write
// lands — `GH_REPO` and the user's `gh` aliases. `parseEgressIntents` itself
// is pure and takes them as `ParseEgressOptions`; this module reads them.

import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { ParseEgressOptions } from "./egress-intent.js";

/** Upper bound on a `gh` config file read for its aliases. */
const GH_CONFIG_MAX = 1024 * 1024;

/**
 * gh's configuration directory, by gh's own precedence: `GH_CONFIG_DIR`, then
 * `$XDG_CONFIG_HOME/gh`, then `~/.config/gh`.
 */
export function ghConfigDir(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const explicit = env["GH_CONFIG_DIR"];
  if (explicit !== undefined && explicit !== "") return explicit;
  const xdg = env["XDG_CONFIG_HOME"];
  if (xdg !== undefined && xdg !== "") return join(xdg, "gh");
  return join(home, ".config", "gh");
}

function readYamlObject(path: string): Record<string, unknown> | null {
  try {
    if (statSync(path).size > GH_CONFIG_MAX) return null;
    const doc: unknown = parseYaml(readFileSync(path, "utf8"));
    return doc !== null && typeof doc === "object" && !Array.isArray(doc) ? (doc as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function stringEntries(obj: unknown): Array<[string, string]> {
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) return [];
  return Object.entries(obj).filter((e): e is [string, string] => typeof e[1] === "string");
}

/**
 * The user's `gh` aliases (alias name → expansion): the `aliases:` map of
 * `config.yml`, plus the legacy `aliases.yml`, which `config.yml` wins over.
 * A missing, oversized or unparseable file contributes nothing — gh itself
 * fails on a broken config, so there is nothing to expand. Never throws.
 */
export function loadGhAliases(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): ReadonlyMap<string, string> {
  const dir = ghConfigDir(env, home);
  const out = new Map<string, string>();
  const legacy = readYamlObject(join(dir, "aliases.yml"));
  if (legacy !== null) {
    for (const [k, v] of stringEntries(legacy["aliases"] ?? legacy)) out.set(k, v);
  }
  const config = readYamlObject(join(dir, "config.yml"));
  if (config !== null) {
    for (const [k, v] of stringEntries(config["aliases"])) out.set(k, v);
  }
  return out;
}

/**
 * `ParseEgressOptions` for a command that will run in `env`: `GH_REPO` as the
 * real `gh` will see it, and the aliases, loaded lazily (only when a command
 * line has a `gh` call whose first argument is not a built-in).
 */
export function egressParseOptions(env: NodeJS.ProcessEnv = process.env): ParseEgressOptions {
  const envRepo = env["GH_REPO"];
  return {
    ...(envRepo !== undefined && envRepo !== "" && { envRepo }),
    ghAliases: () => loadGhAliases(env),
  };
}
