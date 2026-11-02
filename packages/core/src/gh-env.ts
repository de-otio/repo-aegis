// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// The I/O edge of egress-intent parsing (issue #151, §3.3 item 1 and S11): the
// facts about the environment `gh` and `git` will run in that change where a
// write lands — `GH_REPO`, the user's `gh` aliases and their git aliases.
// `parseEgressIntents` itself is pure and takes them as `ParseEgressOptions`;
// this module reads them.

import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
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

/**
 * A YAML file as an object: `"absent"` when the file does not exist (it defines nothing); `null` when it
 * exists but cannot be used (too large, unparseable, an alias bomb, not a mapping), in which case what is
 * in it is UNKNOWN, which is not the same as empty.
 */
function readYamlObject(path: string): Record<string, unknown> | null | "absent" {
  let size: number;
  try {
    size = statSync(path).size;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : null;
  }
  try {
    if (size > GH_CONFIG_MAX) return null;
    const doc: unknown = parseYaml(readFileSync(path, "utf8"));
    if (doc === null || doc === undefined) return {}; // an empty file
    return typeof doc === "object" && !Array.isArray(doc) ? (doc as Record<string, unknown>) : null;
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
 * A file that does not exist defines nothing. A file that exists but cannot
 * be used (oversized, unparseable, hitting the YAML alias limit) makes the
 * aliases UNKNOWN: `null`, which the parser reads as "any word that is not a
 * built-in may be an alias". Never throws.
 */
export function loadGhAliases(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): ReadonlyMap<string, string> | null {
  const dir = ghConfigDir(env, home);
  const out = new Map<string, string>();
  const legacy = readYamlObject(join(dir, "aliases.yml"));
  if (legacy === null) return null;
  if (legacy !== "absent") {
    for (const [k, v] of stringEntries(legacy["aliases"] ?? legacy)) out.set(k, v);
  }
  const config = readYamlObject(join(dir, "config.yml"));
  if (config === null) return null;
  if (config !== "absent") {
    for (const [k, v] of stringEntries(config["aliases"])) out.set(k, v);
  }
  return out;
}

/** Upper bound on the answer of `git config`, and the time it may take. */
const GIT_ALIAS_MAX_BYTES = 256 * 1024;
const GIT_ALIAS_TIMEOUT_MS = 2000;

/**
 * Parse the output of `git config -z --get-regexp '^alias\.'`: entries end with NUL, and inside an entry the
 * key and the value are separated by the FIRST newline. A newline inside an alias VALUE therefore stays in
 * that value; with newline-separated output it could forge a second alias.
 */
export function parseGitAliasEntries(text: string): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  for (const entry of text.split("\0")) {
    if (entry === "") continue;
    const nl = entry.indexOf("\n");
    const key = nl === -1 ? entry : entry.slice(0, nl);
    const value = nl === -1 ? "" : entry.slice(nl + 1);
    const m = /^alias\.(.+)$/.exec(key);
    if (m !== null) out.set(m[1]!.toLowerCase(), value);
  }
  return out;
}

/**
 * The git aliases in effect from `cwd` (name lower-cased → expansion), read the way git reads them:
 * `git config -z --get-regexp '^alias\.'`, which applies system, global, local and environment config. No
 * alias defined is an empty map (git exits 1); git missing, a timeout, an oversized answer or any other
 * failure is `null` (unknown). Bounded; never throws.
 */
export function loadGitAliases(
  cwd: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): ReadonlyMap<string, string> | null {
  try {
    const text = execFileSync("git", ["config", "-z", "--get-regexp", "^alias\\."], {
      cwd,
      env,
      encoding: "utf8",
      timeout: GIT_ALIAS_TIMEOUT_MS,
      maxBuffer: GIT_ALIAS_MAX_BYTES,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return parseGitAliasEntries(text);
  } catch (err) {
    // `git config --get-regexp` exits 1 when nothing matches.
    if ((err as { status?: number }).status === 1) return new Map();
    return null;
  }
}

/**
 * `ParseEgressOptions` for a command that will run in `env` from `cwd`: `GH_REPO` as the real `gh` will
 * see it, and the gh and git aliases, each loaded lazily (only when a command line needs them).
 */
export function egressParseOptions(env: NodeJS.ProcessEnv = process.env, cwd?: string): ParseEgressOptions {
  const envRepo = env["GH_REPO"];
  return {
    ...(envRepo !== undefined && envRepo !== "" && { envRepo }),
    ghAliases: () => loadGhAliases(env),
    // `dir` is where git will look (`-C`, `--git-dir`, `GIT_DIR`), relative to the command's cwd.
    gitAliases: (dir?: string) => loadGitAliases(dir === undefined ? cwd : resolve(cwd ?? process.cwd(), dir), env),
  };
}
