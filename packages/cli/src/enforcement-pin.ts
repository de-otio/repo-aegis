// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// The absolute paths the generated git hooks and the `gh` shim run instead of
// resolving `repo-aegis` and `node` by name (doc/plan-pin-enforcement-binary.md).
// A name is looked up on the caller's PATH, so whatever sits first on it
// decides what enforces; a path is the file this install actually is.
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PIN_VERSION_PATTERN, type EnforcementPin } from "@de-otio/repo-aegis-core";

/** Canonical path, or the absolute input when it cannot be resolved. */
function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** The version in the repo-aegis package.json above `entry`, or null; never runs `entry`. */
export function versionOf(entry: string): string | null {
  let dir = dirname(entry);
  for (let i = 0; i < 4; i++) {
    let text: string | null = null;
    try {
      text = readFileSync(join(dir, "package.json"), "utf8");
    } catch {
      /* no package.json here: keep walking */
    }
    if (text !== null) {
      try {
        const pkg = JSON.parse(text) as { name?: unknown; version?: unknown };
        if (pkg.name === "@de-otio/repo-aegis" && typeof pkg.version === "string") return pkg.version;
      } catch {
        /* not JSON: keep walking */
      }
    }
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

/**
 * The pin for THIS process: the Node executable it runs on and the CLI entry
 * (`dist/index.js`, next to this module) it was started from, both
 * canonicalised so a symlink farm on PATH cannot be swapped under them, plus
 * the package version (the floor for the PATH fallback).
 * `install hooks` and `install shim` write it; `doctor`, `status` and `audit`
 * compare installed scripts against it.
 */
export function currentEnforcementPin(): EnforcementPin {
  const cli = canonical(fileURLToPath(new URL("./index.js", import.meta.url)));
  // The version is the floor for the PATH fallback when this pinned install later goes missing. When it cannot be
  // found the pin carries none and the scripts do not fall back at all.
  const version = versionOf(cli);
  return {
    node: canonical(process.execPath),
    cli,
    ...(version !== null && PIN_VERSION_PATTERN.test(version) && { version }),
  };
}
