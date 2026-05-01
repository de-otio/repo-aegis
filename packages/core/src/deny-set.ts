import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { markersDir as defaultMarkersDir } from "./paths.js";
import type { RepoConfig } from "./repo.js";

export const ALWAYS_FILE_STEM = "_always";

export interface DenySetFile {
  stem: string;
  path: string;
}

export interface DenySet {
  files: DenySetFile[];
  patterns: string[];
  combinedRegex: string;
  warnings: string[];
}

export interface DenySetOptions {
  markersDir?: string;
}

/**
 * Compute the per-repo deny set. Class-aware:
 *
 * - `public-eligible` / `private-strict`: full union (every marker file).
 *   Engagement field on the repo is ignored; if set, a warning is emitted.
 * - `customer-coupled`: union of `_always.txt` + every per-engagement file
 *   whose stem is NOT in this repo's `engagements` list.
 * - `scratch`: same set as `customer-coupled`, but the caller (the CLI's
 *   `check`) treats hits as advisory and exits 0.
 */
export function computeDenySet(repo: RepoConfig, opts: DenySetOptions = {}): DenySet {
  const dir = opts.markersDir ?? defaultMarkersDir();
  const warnings: string[] = [];

  if ((repo.class === "public-eligible" || repo.class === "private-strict") &&
      repo.engagements.length > 0) {
    warnings.push(
      `repo class is ${repo.class} but ${repo.engagements.length} engagement(s) are set; ` +
        `engagement field is ignored for non-customer-coupled classes`,
    );
  }

  if (!existsSync(dir)) {
    return { files: [], patterns: [], combinedRegex: "", warnings };
  }

  const own = new Set(repo.engagements);
  const useScoping = repo.class === "customer-coupled" || repo.class === "scratch";

  const files: DenySetFile[] = readdirSync(dir)
    .filter(f => f.endsWith(".txt"))
    .map(f => ({ stem: f.replace(/\.txt$/, ""), path: join(dir, f) }))
    .filter(({ stem }) => {
      if (stem === ALWAYS_FILE_STEM) return true;
      if (!useScoping) return true;
      return !own.has(stem);
    });

  const patterns: string[] = [];
  for (const f of files) {
    const lines = readFileSync(f.path, "utf8").split("\n");
    for (const raw of lines) {
      const stripped = raw.replace(/[ \t]*;.*$/, "").trim();
      if (stripped) patterns.push(stripped);
    }
  }
  return {
    files,
    patterns,
    combinedRegex: patterns.join("|"),
    warnings,
  };
}
