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
//   - a symlinked FILE is followed (the write lands on its target), and the target's name is judged too.
// The directory comparison is case-insensitive as well: a false refusal of a differently-cased sibling directory
// costs a re-worded path, a missed one costs the guard.
import { realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { APPROVALS_FILE, PAUSE_FILE, repoAegisHome } from "@de-otio/repo-aegis-core";

export type ProtectedStateFile = "pause" | "approvals";

const NAMES: ReadonlyArray<readonly [prefix: string, kind: ProtectedStateFile]> = [
  [PAUSE_FILE, "pause"],
  [APPROVALS_FILE, "approvals"],
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

function kindOfName(name: string): ProtectedStateFile | null {
  const lower = name.toLowerCase();
  for (const [prefix, kind] of NAMES) if (lower.startsWith(prefix)) return kind;
  return null;
}

/** The protected state file `filePath` (resolved against `cwd`) would write, or null. */
export function protectedStateFile(filePath: string, cwd: string, home: string = repoAegisHome()): ProtectedStateFile | null {
  const homeReal = realpathLoose(resolve(home)).toLowerCase();
  const target = resolve(cwd, filePath);
  // The path as spelled, with its directory resolved; then the file itself, if it is a link to somewhere else.
  const candidates = [join(realpathLoose(dirname(target)), basename(target)), realpathLoose(target)];
  for (const c of candidates) {
    const kind = kindOfName(basename(c));
    if (kind !== null && dirname(c).toLowerCase() === homeReal) return kind;
  }
  return null;
}
