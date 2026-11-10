// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// Which write targets are repo-aegis's own person-only state files: the emergency pause (`pause.json`) and the
// egress approvals (`egress-approvals.json`), both in the repo-aegis home. `hook check-write` refuses an agent's
// write to either (a literal `Edit(<path>)` deny rule only matches the spelling it was written with).
//
// A path is judged by what it IS, not how it is spelled:
//   - the file name is compared case-insensitively and by prefix (`Pause.json`, `PAUSE.JSON`, `pause.json.1.tmp`):
//     on a case-insensitive file system (macOS APFS by default) those open the same file as `pause.json`;
//   - the directory is compared after `realpath` on both sides, from the nearest existing ancestor when the file
//     or its directory does not exist yet, so a symlinked directory (`ln -s ~/.config/repo-aegis $TMPDIR/x`, then a
//     write to `$TMPDIR/x/pause.json`) is the home;
//   - a symlinked FILE is followed (the write lands on its target), and the target's name is judged too. A link
//     whose target does not exist yet (dangling) is followed with `readlink`, because a write through it CREATES the
//     target; up to a few hops, and a chain that loops or runs too long is read as protected.
// The directory comparison is case-insensitive as well: a false refusal of a differently-cased sibling directory
// costs a re-worded path, a missed one costs the guard.
import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { APPROVALS_FILE, DECISION_LOG_FILE, DECISION_LOG_STATE_FILE, PAUSE_FILE, repoAegisHome } from "@de-otio/repo-aegis-core";

export type ProtectedStateFile = "pause" | "approvals" | "decision-log";

/** `dir` is the directory under the home the file lives in ("" for the home itself). The decision log's switch lives in `state/`. */
const NAMES: ReadonlyArray<readonly [prefix: string, kind: ProtectedStateFile, dir: string]> = [
  [PAUSE_FILE, "pause", ""],
  [APPROVALS_FILE, "approvals", ""],
  [DECISION_LOG_STATE_FILE, "decision-log", "state"],
  // the log and its rotations/lock files (prefix match): deleting or truncating it removes the data the next refusal needs
  [DECISION_LOG_FILE, "decision-log", "state"],
];

/** `realpath` of `p`, or, when it does not exist, of its nearest existing ancestor with the rest appended. */
function realpathLoose(p: string): string {
  const rest: string[] = [];
  let d = p;
  for (;;) {
    try {
      return join(realpathSync(d), ...rest.reverse());
    } catch {
      const up = dirname(d);
      if (up === d) return p;
      rest.push(basename(d));
      d = up;
    }
  }
}

/** The kind of state file a name in directory `dir` (already lower-cased, as is `homeReal`) is, or null. */
function kindOfName(name: string, dir: string, homeReal: string): ProtectedStateFile | null {
  const lower = name.toLowerCase();
  for (const [prefix, kind, sub] of NAMES) {
    if (lower.startsWith(prefix) && dir === (sub === "" ? homeReal : `${homeReal}/${sub}`)) return kind;
  }
  return null;
}

/** Most symlink hops followed before a chain is given up on and read as protected. */
const MAX_LINK_HOPS = 8;

/**
 * Every place a write to `target` could land: the path as spelled with its directory resolved, and, while it is a
 * symlink, each link's target in turn (a link's target is read with `readlink` and resolved against the link's own
 * directory, so a DANGLING link, which `realpath` cannot follow, still reveals where a write would create the file).
 * `loop` is true when the chain is longer than {@link MAX_LINK_HOPS} or comes back on itself.
 */
function writeCandidates(target: string): { candidates: string[]; loop: boolean } {
  const candidates: string[] = [];
  const seen = new Set<string>();
  let cur = target;
  for (let hop = 0; hop <= MAX_LINK_HOPS; hop++) {
    const realDir = realpathLoose(dirname(cur));
    const spelled = join(realDir, basename(cur));
    candidates.push(spelled, realpathLoose(cur));
    if (seen.has(spelled)) return { candidates, loop: true };
    seen.add(spelled);
    let link: string;
    try {
      if (!lstatSync(spelled).isSymbolicLink()) return { candidates, loop: false };
      link = readlinkSync(spelled);
    } catch {
      return { candidates, loop: false }; // does not exist (yet), or cannot be read: the write would create it as spelled
    }
    cur = resolve(realDir, link);
  }
  return { candidates, loop: true };
}

/**
 * The protected state file `filePath` (resolved against `cwd`) would write, or null. A symlink chain that loops or
 * runs past {@link MAX_LINK_HOPS} counts as protected (`pause`): no honest write goes through one.
 */
export function protectedStateFile(filePath: string, cwd: string, home: string = repoAegisHome()): ProtectedStateFile | null {
  const homeReal = realpathLoose(resolve(home)).toLowerCase();
  const { candidates, loop } = writeCandidates(resolve(cwd, filePath));
  for (const c of candidates) {
    const kind = kindOfName(basename(c), dirname(c).toLowerCase(), homeReal);
    if (kind !== null) return kind;
  }
  return loop ? "pause" : null;
}
