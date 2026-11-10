// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// One semver comparator for the once-per-version notice and for `upgrade`'s rollback check, so the two cannot
// disagree about which of two versions is newer (a prerelease is below its release).

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** Semver precedence of two prerelease strings (`rc.2` against `rc.10`): numeric identifiers by value and below alphanumeric ones, a shorter list below a longer one it prefixes. */
function comparePrerelease(a: string, b: string): number {
  const x = a.split(".");
  const y = b.split(".");
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const p = x[i];
    const q = y[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn) {
      const d = Number(p) - Number(q);
      if (d !== 0) return d < 0 ? -1 : 1;
    } else if (pn !== qn) {
      return pn ? -1 : 1;
    } else if (p !== q) {
      return p < q ? -1 : 1;
    }
  }
  return 0;
}

/**
 * Order two versions like semver: `MAJOR.MINOR.PATCH` numerically, a prerelease below its release (`0.14.0-rc.1` <
 * `0.14.0`), prereleases among themselves numerically (`rc.2` < `rc.10`), build metadata ignored. Returns -1, 0 or 1,
 * or null when either is not semver at all (a dev tree): callers decide what an unorderable pair means.
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 | null {
  const x = SEMVER.exec(a);
  const y = SEMVER.exec(b);
  if (x === null || y === null) return null;
  for (let i = 1; i <= 3; i++) {
    const d = Number(x[i]) - Number(y[i]);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  const pa = x[4];
  const pb = y[4];
  if (pa === undefined && pb === undefined) return 0;
  if (pa === undefined) return 1; // a release is newer than its own prerelease
  if (pb === undefined) return -1;
  const c = comparePrerelease(pa, pb);
  return c < 0 ? -1 : c > 0 ? 1 : 0;
}
