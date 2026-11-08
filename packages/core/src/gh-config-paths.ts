// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// Which files are gh's own configuration (`config.yml`, `hosts.yml`), for the write hook (L6 of the identity
// review, doc/plan-owner-identity.md §12.1). They choose gh's pager, editor, aliases and the account it acts as,
// so an agent that can write them can redirect the credential the identity layer injects. The write hook refuses
// an agent's Edit / Write to them (`GH_CONFIG_WRITE_REFUSED`). Pure apart from the optional realpath lookup.

import { realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

/** The files in gh's config directory an agent must not write. */
export const GH_CONFIG_FILES: ReadonlySet<string> = new Set(["config.yml", "hosts.yml"]);

export interface GhConfigPathContext {
  env: NodeJS.ProcessEnv;
  home: string;
  /** The directory a relative path is resolved against. */
  cwd: string;
}

/**
 * Every directory gh could read its config from on this machine: `$GH_CONFIG_DIR`, `$XDG_CONFIG_HOME/gh`, and
 * `~/.config/gh`. All of them count, whichever gh would pick, so changing the environment later does not move
 * the protection.
 */
export function ghConfigDirs(ctx: GhConfigPathContext): string[] {
  const dirs = [join(ctx.home, ".config", "gh")];
  const explicit = ctx.env["GH_CONFIG_DIR"];
  if (explicit !== undefined && explicit !== "") dirs.push(resolve(ctx.cwd, explicit));
  const xdg = ctx.env["XDG_CONFIG_HOME"];
  if (xdg !== undefined && xdg !== "") dirs.push(join(resolve(ctx.cwd, xdg), "gh"));
  return dirs;
}

function expandHome(path: string, home: string): string {
  if (path === "~") return home;
  return path.startsWith("~/") ? join(home, path.slice(2)) : path;
}

function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * Whether `filePath` (as the write tool was given it: absolute, relative to `cwd`, or `~/…`) is `config.yml` or
 * `hosts.yml` in one of {@link ghConfigDirs}. A symlinked directory is compared by its real path as well.
 */
export function isGhConfigFile(filePath: string, ctx: GhConfigPathContext): boolean {
  const abs = resolve(ctx.cwd, expandHome(filePath, ctx.home));
  if (!GH_CONFIG_FILES.has(basename(abs))) return false;
  const dir = dirname(abs);
  const dirReal = real(dir);
  return ghConfigDirs(ctx).some(d => d === dir || real(d) === dirReal);
}
