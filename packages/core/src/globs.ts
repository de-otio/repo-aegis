// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// A small `*`/`?`/`**` glob compiler, purpose-built for path-scoped
// exemptions (deny-set item B). No dependency: the tree already carries
// `yaml`, `zod`, `commander`, `proper-lockfile`; pulling in picomatch or
// minimatch for nine built-in globs is not worth the supply-chain surface
// in a security tool. This module owns the *matching* primitive only —
// deny-set wiring (which patterns get exempted, config plumbing) is a
// separate lane.
//
// ---------------------------------------------------------------------
// CONTRACT (relied on by callers outside this file — do not change
// silently; a behaviour change here changes what a security exemption
// covers):
//
//   - Paths and globs are POSIX-style, repo-relative, `/`-separated, with
//     no leading `./`. Matching is anchored (whole-path, not substring)
//     and case-sensitive.
//   - `*` matches zero or more characters WITHIN one path segment; it
//     never crosses `/`.
//   - `?` matches exactly one character that is not `/`.
//   - `**` occupies a whole path segment (i.e. appears between `/`s, or
//     at the start/end of the glob) and matches ZERO OR MORE ENTIRE PATH
//     SEGMENTS. Concretely:
//       * leading `**/x`  matches `x`, `a/x`, `a/b/x`, ...
//       * trailing `x/**` matches `x`, `x/a`, `x/a/b`, ...
//       * middle   `a/**/b` matches `a/b`, `a/x/b`, `a/x/y/b`, ...
//     These three rules compose, so `**/test/**` matches `test/a.ts`
//     (leading `**` matches zero segments, trailing `**` matches the one
//     segment `a.ts`). A `**` NEVER partially matches within a segment —
//     `**/test/**` does not match `src/contest/a.ts` or `testing/a.ts`
//     because `test` must be a whole segment, not a substring.
//   - A literal segment (anything that isn't `*`, `?`, or a lone `**`) is
//     matched exactly; every regex metacharacter in it is escaped.
//
// A glob that reduces to "match everything" is a config error, not a
// preference: it would silently disable the exemptible pattern class
// everywhere in the repo. `compileGlob` throws `GlobTooBroadError` for
// the empty string, whitespace-only strings, and the literal forms `*`,
// `**`, `**/*`.

/** Thrown by {@link compileGlob} for a glob that matches every path. */
export class GlobTooBroadError extends Error {
  readonly code = "GLOB_TOO_BROAD" as const;
  constructor(public glob: string) {
    super(
      `glob ${JSON.stringify(glob)} matches every path; ` +
        `path-scoped exemptions must be scoped to something narrower ` +
        `than the whole repo`,
    );
    this.name = "GlobTooBroadError";
  }
}

// Exact (post-trim) forms that match every possible path. Checked by
// literal-string comparison rather than by asking "does this glob match
// everything" in general — that general question is not decidable for
// arbitrary regexes, but these specific forms are exactly what a
// copy-pasted `**` config mistake looks like, and the task at hand does
// not need broader detection than that.
const BROAD_GLOBS = new Set(["*", "**", "**/*"]);

function assertNotTooBroad(glob: string): string {
  const trimmed = glob.trim();
  if (trimmed === "" || BROAD_GLOBS.has(trimmed)) {
    throw new GlobTooBroadError(glob);
  }
  return trimmed;
}

// Regex metacharacters that can appear as literal characters inside a
// glob segment (i.e. everything except `*` and `?`, which are handled as
// wildcards before this branch is reached, and `/`, which never appears
// within a segment because the glob is split on it first).
const REGEX_SPECIAL = /[.+^${}()|[\]\\]/;

/** Translate one `/`-free glob segment into the body of a regex that matches exactly that segment. */
function literalSegmentRegex(segment: string): string {
  let out = "";
  for (const ch of segment) {
    if (ch === "*") {
      out += "[^/]*";
    } else if (ch === "?") {
      out += "[^/]";
    } else if (REGEX_SPECIAL.test(ch)) {
      out += "\\" + ch;
    } else {
      out += ch;
    }
  }
  return out;
}

type Token = { readonly kind: "globstar" } | { readonly kind: "literal"; readonly regex: string };

/**
 * Compile a glob into an anchored, case-sensitive `RegExp` matching whole
 * repo-relative POSIX paths. See the module-level contract comment for
 * exact `*`/`?`/`**` semantics.
 *
 * Compiles once — callers that scan many paths against a fixed glob list
 * should precompile with {@link compileGlobs} rather than calling this
 * per path.
 *
 * @throws {GlobTooBroadError} if the glob matches every path.
 */
export function compileGlob(glob: string): RegExp {
  const trimmed = assertNotTooBroad(glob);

  const tokens: Token[] = trimmed
    .split("/")
    .map(seg => (seg === "**" ? { kind: "globstar" as const } : { kind: "literal" as const, regex: literalSegmentRegex(seg) }));

  const literalIdxs: number[] = [];
  tokens.forEach((t, i) => {
    if (t.kind === "literal") literalIdxs.push(i);
  });

  if (literalIdxs.length === 0) {
    // Every token is `**` (e.g. `**/**`) — matches any nonempty sequence
    // of segments, or none. Not one of the exact forms rejected above,
    // but semantically the same "matches everything"; we don't special-
    // case-reject it (out of scope for this lane) but it must still
    // compile to something internally consistent.
    return new RegExp("^(?:[^/]+(?:/[^/]+)*)?$");
  }

  const firstLiteralIdx = literalIdxs[0]!;
  const lastLiteralIdx = literalIdxs[literalIdxs.length - 1]!;

  // Any run of tokens strictly between two literal indices (or before the
  // first / after the last) consists entirely of `**` tokens by
  // construction — literalIdxs lists every literal token in order, so a
  // gap between consecutive entries can only be filled with globstars.
  // A gap of any size (one `**` or several in a row) matches the same
  // set as a single `**` — "zero or more segments" composed with itself
  // is still "zero or more segments" — so we only need a boolean.
  let out = "^";
  out += firstLiteralIdx > 0 ? "(?:[^/]+/)*" : "";

  for (let j = 0; j < literalIdxs.length; j++) {
    const idx = literalIdxs[j]!;
    const tok = tokens[idx]!;
    out += (tok as { kind: "literal"; regex: string }).regex;
    if (j < literalIdxs.length - 1) {
      const nextIdx = literalIdxs[j + 1]!;
      out += nextIdx - idx > 1 ? "/(?:[^/]+/)*" : "/";
    }
  }

  out += lastLiteralIdx < tokens.length - 1 ? "(?:/[^/]+)*" : "";
  out += "$";

  return new RegExp(out);
}

/**
 * Precompile a list of globs once, for reuse across many `matchesCompiled`
 * calls (e.g. scanning every file in a repo against a fixed exemption
 * list). Order is preserved; throws `GlobTooBroadError` on the first
 * too-broad entry.
 */
export function compileGlobs(globs: readonly string[]): readonly RegExp[] {
  return globs.map(compileGlob);
}

/** Test a path against a list of precompiled globs (see {@link compileGlobs}). */
export function matchesCompiled(path: string, compiled: readonly RegExp[]): boolean {
  return compiled.some(re => re.test(path));
}

/**
 * Convenience wrapper: compiles `globs` and tests `path` against them.
 * Recompiles on every call — prefer {@link compileGlobs} +
 * {@link matchesCompiled} in a loop over many paths against a fixed list.
 *
 * @throws {GlobTooBroadError} if any glob in the list is too broad.
 */
export function matchesAnyGlob(path: string, globs: readonly string[]): boolean {
  return matchesCompiled(path, compileGlobs(globs));
}
