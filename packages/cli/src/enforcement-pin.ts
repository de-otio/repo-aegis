// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// The absolute paths the generated git hooks and the `gh` shim run instead of
// resolving `repo-aegis` and `node` by name (doc/plan-pin-enforcement-binary.md).
// A name is looked up on the caller's PATH, so whatever sits first on it
// decides what enforces; a path is the file this install actually is.
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { EnforcementPin } from "@de-otio/repo-aegis-core";

/** Canonical path, or the absolute input when it cannot be resolved. */
function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/**
 * The pin for THIS process: the Node executable it runs on and the CLI entry
 * (`dist/index.js`, next to this module) it was started from, both
 * canonicalised so a symlink farm on PATH cannot be swapped under them.
 * `install hooks` and `install shim` write it; `doctor`, `status` and `audit`
 * compare installed scripts against it.
 */
export function currentEnforcementPin(): EnforcementPin {
  return {
    node: canonical(process.execPath),
    cli: canonical(fileURLToPath(new URL("./index.js", import.meta.url))),
  };
}
