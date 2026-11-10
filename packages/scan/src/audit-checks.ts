// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// The network / archive checks behind `repo-aegis-scan audit`, moved out of
// `repo-aegis audit` so the deterministic gate (check, hooks, pre-push, the
// local audit) imports nothing that can reach GitHub or run `npm pack`.
//
// Behaviour is deliberately identical to what `repo-aegis audit --org` and
// `--published` did before the move: same check names (`org-scan`,
// `published`), same finding codes, same JSON shapes.
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  type Dirent,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import {
  isActive,
  scanFile,
  scanForSecrets,
  summariseHits,
  type DenySet,
  type Engagement,
} from "@de-otio/repo-aegis-core";
import { runScan, type SearchClient } from "./run.js";
import { makeOctokitClient } from "./octokit-client.js";

export interface Finding {
  message: string;
  detail?: unknown;
  /** Reported but does not fail the check. */
  informational?: boolean;
}

export interface CheckResult {
  name: string;
  ok: boolean;
  findings: Finding[];
  skipped?: boolean;
  skipReason?: string;
}

/** Findings that gate the check's `ok` — i.e. everything not informational. */
export function blocking(findings: readonly Finding[]): Finding[] {
  return findings.filter(f => f.informational !== true);
}

export const DEFAULT_MAX_ORG_QUERIES = 30;

export const ORG_CROSS_BORDER_CONSENT_ENV = "REPO_AEGIS_ACCEPT_ORG_SEED_TRANSFER";

/** Test seams for `checkOrg`; production passes none and gets the real client. */
export interface CheckOrgDeps {
  client?: SearchClient;
  sleep?: (ms: number) => Promise<void>;
}

// Extract literal "seeds" from a regex pattern that GitHub code-search
// can use as substring matches. Splits on regex metacharacters and
// keeps continuous runs of length >= 4. Best-effort; patterns that
// produce no usable seed are silently skipped.
function literalSeeds(pattern: string): string[] {
  const runs = pattern.split(/[\\^$()\[\]{}?+*|.]+/);
  return runs.filter(r => r.length >= 4);
}

export async function checkOrg(
  org: string,
  reg: { engagements: Engagement[]; alwaysBlock: string[] },
  token: string,
  maxQueries: number,
  deps: CheckOrgDeps = {},
): Promise<CheckResult> {
  const seedSet = new Set<string>();
  for (const e of reg.engagements) {
    if (!isActive(e)) continue;
    for (const p of e.markers) for (const s of literalSeeds(p)) seedSet.add(s);
  }
  for (const p of reg.alwaysBlock) for (const s of literalSeeds(p)) seedSet.add(s);

  // Sort alphabetically so the truncation, when it happens, is deterministic
  // across runs and across machines. Stable order also makes the "skipped"
  // finding actionable: the operator sees the same prefix every time.
  const allSeeds = Array.from(seedSet).sort();
  if (allSeeds.length === 0) {
    return {
      name: "org-scan",
      ok: true,
      findings: [],
      skipped: true,
      skipReason: "no usable literal seeds extracted from registry patterns",
    };
  }

  const cap = Math.max(1, maxQueries);
  const seeds = allSeeds.slice(0, cap);
  const skippedCount = allSeeds.length - seeds.length;

  const truncationFinding: Finding | null =
    skippedCount > 0
      ? {
          message: `${skippedCount} seed(s) skipped due to --max-queries budget (cap=${cap}, total=${allSeeds.length})`,
          detail: {
            code: "ORG_SCAN_TRUNCATED",
            cap,
            totalSeeds: allSeeds.length,
            skippedCount,
          },
        }
      : null;

  const queries = seeds.map((s, i) => ({
    name: `audit-seed-${i}`,
    query: `"${s}" org:${org}`,
  }));

  const client = deps.client ?? makeOctokitClient({ token });
  const result = await runScan({
    queries,
    state: { seen: {} },
    client,
    interRequestSleepMs: 1500,
    maxPagesPerQuery: 2,
    capResultsPerQuery: 50,
    ...(deps.sleep ? { sleep: deps.sleep } : {}),
  });

  const findings: Finding[] = [];
  if (truncationFinding) findings.push(truncationFinding);
  for (const h of result.hits) {
    findings.push({
      message: `${h.repo}:${h.path}${h.line !== null ? `:${h.line}` : ""}`,
      detail: { repo: h.repo, path: h.path, line: h.line, url: h.url, query: h.query },
    });
  }

  const allFailed = result.summary.queries.length > 0 && result.summary.queries.every(q => !q.ok);
  if (allFailed) {
    return {
      name: "org-scan",
      ok: false,
      findings: [
        ...(truncationFinding ? [truncationFinding] : []),
        { message: "all org-scan queries failed", detail: { queries: result.summary.queries } },
      ],
    };
  }

  // The result is "ok" only when no real hits and no truncation. A truncated
  // run is strictly worse than a clean clean run because some seeds were not
  // queried at all — surface as a failure so the operator sees it.
  const hitCount = result.hits.length;
  return {
    name: "org-scan",
    ok: hitCount === 0 && skippedCount === 0,
    findings,
  };
}

// After extraction, walk the tree and verify every entry's realpath is
// rooted under the extraction root. Catches zip-slip / tar-slip entries
// (e.g. `../../escape.txt`) and symlinks pointing outside the archive.
// Returns null if the tree is clean, or a string describing the offending
// entry if any escape is detected.
function findArchiveEscape(extractDir: string): string | null {
  let extractReal: string;
  try {
    extractReal = realpathSync(extractDir);
  } catch {
    return `cannot resolve realpath of extraction dir ${extractDir}`;
  }
  const stack: string[] = [extractDir];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      const full = join(dir, name);
      let real: string;
      try {
        real = realpathSync(full);
      } catch {
        // Broken / dangling symlink: treat as escape rather than ignore.
        // Anything we can't realpath cleanly inside the extraction root
        // is suspicious.
        return `entry ${full} has unresolvable realpath`;
      }
      const rel = relative(extractReal, real);
      if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
        // entry is rooted under extractReal; recurse if it's a directory
        // (use lstat so we don't follow symlinks again — realpath already
        // resolved the link's target safely above).
        let st;
        try {
          st = statSync(real);
        } catch {
          continue;
        }
        if (st.isDirectory()) stack.push(full);
        continue;
      }
      return `entry ${full} resolves outside extraction root (-> ${real})`;
    }
  }
  return null;
}

// Probe a binary's presence on PATH by running `<bin> --version`. We use
// the binary itself (not `which`) so the result reflects exactly what
// `spawnSync(bin, ...)` will see later — this guards against shim/PATH
// mismatches where `which` succeeds but spawn fails or vice versa.
// Returns a finding describing the missing binary, or null if the binary
// runs cleanly. Mirrors the AgeNotFoundError pattern from age.ts.
function checkBinaryAvailable(bin: string, code: string): Finding | null {
  const probe = spawnSync(bin, ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (probe.error) {
    const errCode = (probe.error as NodeJS.ErrnoException).code;
    if (errCode === "ENOENT") {
      return {
        message: `\`${bin}\` not found on PATH; install it and retry`,
        detail: { code, binary: bin, reason: "ENOENT" },
      };
    }
    return {
      message: `\`${bin} --version\` probe failed: ${probe.error.message}`,
      detail: { code, binary: bin, reason: probe.error.message },
    };
  }
  // Some tools exit non-zero on `--version` (rare). Treat any spawnable
  // result as "present"; we only care that the binary is on PATH.
  return null;
}

export function checkPublished(
  input: string,
  denySet: DenySet,
  reveal: boolean,
  secretScan: boolean,
): CheckResult {
  const findings: Finding[] = [];

  // An empty deny set is LEGITIMATE here and must not fail the check: the
  // engagement registry is machine-local by design (it holds customer
  // markers, which is precisely what must never reach a public CI runner),
  // so a publish workflow scanning its own tarball will always have zero
  // engagement patterns. But "scanned against nothing" and "scanned clean"
  // must not render identically — that is the exact confusion the
  // deny-set floor exists to prevent, and a gate that reports `ok: true`
  // after matching no patterns is the shape of a green check nobody can
  // trust. Report it, visibly, without gating on it.
  if (denySet.patterns.length === 0) {
    findings.push({
      message:
        "marker scan was inert: the deny set has 0 patterns, so archive contents were not matched against any engagement marker",
      detail: { code: "PUBLISHED_EMPTY_DENY_SET", patternCount: 0, secretScan },
      informational: true,
    });
  }
  const tmp = mkdtempSync(join(tmpdir(), "repo-aegis-published-"));
  let extractDir = tmp;

  try {
    if (input.endsWith(".tgz") || input.endsWith(".tar.gz")) {
      if (!existsSync(input)) {
        return {
          name: "published",
          ok: false,
          findings: [{ message: `tarball not found: ${input}` }],
        };
      }
      const missing = checkBinaryAvailable("tar", "TAR_NOT_FOUND");
      if (missing) {
        return { name: "published", ok: false, findings: [missing] };
      }
      const r = spawnSync("tar", ["-xzf", input, "-C", tmp], { encoding: "utf8" });
      if (r.status !== 0) {
        return {
          name: "published",
          ok: false,
          findings: [{ message: `tar extract failed: ${r.stderr}` }],
        };
      }
    } else if (input.endsWith(".vsix")) {
      if (!existsSync(input)) {
        return {
          name: "published",
          ok: false,
          findings: [{ message: `vsix not found: ${input}` }],
        };
      }
      const missing = checkBinaryAvailable("unzip", "UNZIP_NOT_FOUND");
      if (missing) {
        return { name: "published", ok: false, findings: [missing] };
      }
      const r = spawnSync("unzip", ["-q", input, "-d", tmp], { encoding: "utf8" });
      if (r.status !== 0) {
        return {
          name: "published",
          ok: false,
          findings: [{ message: `unzip failed: ${r.stderr}` }],
        };
      }
    } else {
      // Treat as npm package name; pack first.
      const missingNpm = checkBinaryAvailable("npm", "NPM_NOT_FOUND");
      if (missingNpm) {
        return { name: "published", ok: false, findings: [missingNpm] };
      }
      const missingTar = checkBinaryAvailable("tar", "TAR_NOT_FOUND");
      if (missingTar) {
        return { name: "published", ok: false, findings: [missingTar] };
      }
      const packResult = spawnSync("npm", ["pack", "--silent", input], {
        cwd: tmp,
        encoding: "utf8",
      });
      if (packResult.status !== 0) {
        return {
          name: "published",
          ok: false,
          findings: [{ message: `npm pack failed for ${input}: ${packResult.stderr}` }],
        };
      }
      const tgzs = readdirSync(tmp).filter(f => f.endsWith(".tgz"));
      if (tgzs.length === 0) {
        return {
          name: "published",
          ok: false,
          findings: [{ message: `npm pack produced no .tgz for ${input}` }],
        };
      }
      const tgz = tgzs[0]!;
      const xr = spawnSync("tar", ["-xzf", join(tmp, tgz), "-C", tmp], { encoding: "utf8" });
      if (xr.status !== 0) {
        return {
          name: "published",
          ok: false,
          findings: [{ message: `tar extract failed: ${xr.stderr}` }],
        };
      }
    }

    // Zip-slip / tar-slip defence: after extraction, verify every entry
    // (including symlink targets) resolves within the extraction root.
    // BSD `tar` (default on macOS) and `unzip` do not reliably reject
    // `../../escape.txt` entries on their own.
    const escape = findArchiveEscape(extractDir);
    if (escape !== null) {
      return {
        name: "published",
        ok: false,
        findings: [
          {
            message: "extracted archive contains an entry that escapes the extraction root",
            detail: { code: "PUBLISHED_ARCHIVE_ESCAPE", reason: escape },
          },
        ],
      };
    }

    function recurse(dir: string): void {
      // `withFileTypes` takes the entry kind from the directory read itself.
      // The alternative — `readdirSync` then `statSync(full)` per entry — is a
      // check-then-use on a path we then open and read (CodeQL
      // `js/file-system-race`), and costs an extra syscall per entry for the
      // privilege. Here the kind comes back with the entry and no separate
      // check on the path is ever made.
      let entries: Dirent[];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          recurse(full);
          continue;
        }
        // Symlinks are skipped rather than followed. `findArchiveEscape`
        // above has already rejected the whole archive if any entry — symlink
        // targets included — resolves outside the extraction root, so a
        // symlink that reaches this point necessarily points INSIDE, where
        // the walk visits its target on its own. Following it would only
        // scan the same bytes twice under a second name.
        if (!entry.isFile()) continue;
        // Pass extractDir as the workingTree so scanFile rejects any
        // symlink whose realpath points outside the archive (e.g. a
        // symlink to /etc/passwd that survived the escape check above
        // — it can't, but defence-in-depth).
        let r;
        try {
          // Full pattern set, no path exemptions and no demotion: a
          // published tarball is the last artefact anyone can inspect, and
          // "it was in a fixture directory" is not a reason to let a secret
          // shape ship to a registry.
          r = scanFile(
            full,
            denySet,
            { revealMatches: reveal, ignorePathExemptions: true },
            extractDir,
          );
        } catch {
          // OutsideWorkingTreeError or similar: skip this entry; the
          // archive-escape check above is the authoritative gate.
          continue;
        }
        for (const h of r.hits) {
          const rel = relative(extractDir, full);
          findings.push({
            message: `${rel}:${h.line}:${h.column}`,
            detail: { path: rel, line: h.line, column: h.column, matchPreview: h.matchPreview },
          });
        }

        // Universal secret shapes, independent of the deny set. This is the
        // only part of the published check that still works when the deny
        // set is empty — which, per the note at the top of this function, is
        // the normal case in CI. It covers the threat that actually applies
        // to a registry tarball: a private key, JWT, or forge token that
        // reached the archive via build output or `files` drift rather than
        // via a tracked source file the hooks already cover.
        //
        // `scanForSecrets` returns kind/offset/length and never the matched
        // bytes, so these findings are safe to print in a public job log
        // without the attribution-redaction machinery.
        if (secretScan) {
          // No stat/exists check precedes this read — the entry kind came
          // from the directory read itself — so there is no check-then-use
          // window to race. A read that fails simply skips the entry.
          let text: string;
          try {
            text = readFileSync(full, "utf8");
          } catch {
            continue;
          }
          const secretHits = scanForSecrets(text);
          if (secretHits.length > 0) {
            const rel = relative(extractDir, full);
            const summary = summariseHits(secretHits);
            findings.push({
              message: `${rel}: ${summary.count} secret-shaped match(es) [${summary.kinds.join(", ")}]`,
              detail: {
                code: "PUBLISHED_SECRET_SHAPE",
                path: rel,
                kinds: summary.kinds,
                count: summary.count,
              },
            });
          }
        }
      }
    }

    recurse(extractDir);
  } finally {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }

  return { name: "published", ok: blocking(findings).length === 0, findings };
}
