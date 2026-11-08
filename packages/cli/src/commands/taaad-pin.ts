// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// The taaad pin (doc/plan-owner-identity.md N4, A4, §13.3): the realpaths of the taaad launcher, the
// interpreter its shebang names and its package directory, recorded by `install shim` and read back by
// `repo-aegis gh` (which mints App tokens through it) and `doctor`.
//
// A token minted by an agent-writable taaad is a token the agent can capture, so github-app injection is
// refused (`TAAAD_AGENT_WRITABLE`) unless all three, and every directory above them, are owned by root and
// not writable by group or others. The check is LIVE (made on each call and each `doctor` run), not a
// flag recorded at install: a flag an agent could outlive is worth less than an `lstat`.
import { closeSync, constants, lstatSync, openSync, readSync, readdirSync, realpathSync, statSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join } from "node:path";

export interface TaaadPin {
  /** Realpath of the `taaad` launcher script or binary. */
  launcher: string;
  /** Realpath of the interpreter its shebang names (the launcher itself when it has no shebang). */
  interpreter: string;
  /** The package directory: the venv root when the launcher sits in `<root>/bin`, else the launcher's directory. */
  packageDir: string;
}

function canonical(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

function isExecutableFile(path: string): boolean {
  try {
    const st = statSync(path);
    return st.isFile() && (st.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

/** First executable `name` on the ABSOLUTE entries of `pathValue`, skipping `skipDir` (the shim's own directory). */
function firstOnPath(name: string, pathValue: string | undefined, skipDir?: string): string | null {
  if (pathValue === undefined || pathValue === "") return null;
  const skip = skipDir === undefined ? null : canonical(skipDir);
  for (const entry of pathValue.split(delimiter)) {
    if (entry === "" || !isAbsolute(entry)) continue;
    const candidate = join(entry, name);
    if (!isExecutableFile(candidate)) continue;
    if (skip !== null && canonical(entry) === skip) continue;
    return candidate;
  }
  return null;
}

/** The first line of `path` when it starts with `#!`, read through one descriptor; null otherwise. */
function shebangLine(path: string): string | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    const buf = Buffer.alloc(512);
    const n = readSync(fd, buf, 0, buf.length, 0);
    const text = buf.subarray(0, n).toString("latin1");
    if (!text.startsWith("#!")) return null;
    const line = text.slice(2).split("\n", 1)[0] ?? "";
    return line.trim();
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* nothing to do */
      }
    }
  }
}

/**
 * The interpreter a launcher's shebang names, as a realpath: `#!/path/python3 [arg]` directly, or
 * `#!/usr/bin/env python3` through the first `python3` on `pathValue`. The launcher itself when it has no shebang.
 */
function interpreterOf(launcher: string, pathValue: string | undefined): string | null {
  const line = shebangLine(launcher);
  if (line === null) return launcher;
  const words = line.split(/\s+/).filter(w => w !== "");
  const first = words[0];
  if (first === undefined) return null;
  if (first === "/usr/bin/env" || first.endsWith("/env")) {
    const name = words.slice(1).find(w => !w.startsWith("-"));
    if (name === undefined) return null;
    const found = isAbsolute(name) ? name : firstOnPath(name, pathValue);
    return found === null ? null : canonical(found);
  }
  return isAbsolute(first) ? canonical(first) : null;
}

/**
 * The pin for the `taaad` a person would run now: the first executable `taaad` on `pathValue` (absolute
 * entries only, not the shim's directory), resolved through every symlink. Null when there is none, or its
 * interpreter cannot be resolved.
 */
export function resolveTaaadPin(pathValue: string | undefined, shimDir?: string): TaaadPin | null {
  const found = firstOnPath("taaad", pathValue, shimDir);
  if (found === null) return null;
  const launcher = canonical(found);
  if (launcher === null) return null;
  const interpreter = interpreterOf(launcher, pathValue);
  if (interpreter === null) return null;
  const dir = dirname(launcher);
  const packageDir = dir.endsWith("/bin") ? dirname(dir) : dir;
  return { launcher, interpreter, packageDir };
}

/** Why `path` and the directories above it are not root-only-writable, or null. `path` is already a realpath. */
function rootOnlyProblem(label: string, path: string): string | null {
  let current = path;
  for (let i = 0; i < 64; i++) {
    let st;
    try {
      st = lstatSync(current);
    } catch {
      return `${label}: ${current} could not be inspected`;
    }
    if (st.uid !== 0) return `${label}: ${current} is not owned by root`;
    if ((st.mode & 0o022) !== 0) return `${label}: ${current} is writable by group or others`;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return `${label}: ${path} is nested too deeply to check`;
}

/** The directories of a tree to `depth` levels (files are not listed: the launcher and interpreter are checked on their own). */
function directoriesUnder(root: string, depth: number): string[] {
  const out: string[] = [];
  const walk = (dir: string, left: number): void => {
    if (left < 0) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const child = join(dir, e.name);
      out.push(child);
      walk(child, left - 1);
    }
  };
  walk(root, depth);
  return out;
}

/**
 * Why `pin` may not mint a token, or null when the launcher, the interpreter and the package directory (and
 * the directories of the package tree to depth 3, `lib/pythonX.Y/site-packages` included) are all owned by
 * root and writable by nobody else. Only the first problem is reported.
 */
export function taaadTrustProblem(pin: TaaadPin): string | null {
  const own =
    rootOnlyProblem("the taaad launcher", pin.launcher) ??
    rootOnlyProblem("the taaad interpreter", pin.interpreter) ??
    rootOnlyProblem("the taaad package directory", pin.packageDir);
  if (own !== null) return own;
  for (const dir of directoriesUnder(pin.packageDir, 3)) {
    const st = (() => {
      try {
        return lstatSync(dir);
      } catch {
        return null;
      }
    })();
    if (st === null) continue;
    if (st.uid !== 0) return `the taaad package directory: ${dir} is not owned by root`;
    if ((st.mode & 0o022) !== 0) return `the taaad package directory: ${dir} is writable by group or others`;
  }
  return null;
}
