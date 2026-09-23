// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
import { readFileSync } from "node:fs";

/**
 * Read `path` as UTF-8, or return null when it does not exist.
 *
 * Read-and-catch rather than `existsSync` first: there is no window between
 * the check and the read for the file to appear or vanish, and a caller that
 * later rewrites the file decides from what it actually read. Any error other
 * than ENOENT (permissions, EISDIR) still propagates.
 */
export function readIfExists(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}
