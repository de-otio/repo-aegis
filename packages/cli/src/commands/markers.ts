import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  markersDir as defaultMarkersDir,
  computeDenySet,
  readRepoConfig,
  redactMatch,
  ALWAYS_FILE_STEM,
} from "@de-otio/repo-aegis-core";
import { emitJson, emitText, emitError, shouldRevealMatches, type OutputOptions } from "../format.js";

interface MarkersListOptions extends OutputOptions {
  verbose?: boolean;
}

interface MarkersTestOptions extends OutputOptions {
  verbose?: boolean;
  cwd?: string;
}

interface MarkersFile {
  stem: string;
  path: string;
  patterns: string[];
}

function readMarkerFiles(dir: string): MarkersFile[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(f => f.endsWith(".txt"))
    .sort()
    .map(f => {
      const path = join(dir, f);
      const lines = readFileSync(path, "utf8").split("\n");
      const patterns: string[] = [];
      for (const raw of lines) {
        const trimmed = raw.trim();
        if (trimmed.length === 0 || trimmed.startsWith(";")) continue;
        patterns.push(trimmed);
      }
      return {
        stem: f.replace(/\.txt$/, ""),
        path,
        patterns,
      };
    });
}

export function markersList(opts: MarkersListOptions): void {
  const dir = defaultMarkersDir();
  const files = readMarkerFiles(dir);
  const reveal = shouldRevealMatches(opts);

  if (opts.json) {
    emitJson({
      action: "markers-list",
      markersDir: dir,
      files: files.map(f => ({
        stem: f.stem,
        path: f.path,
        patternCount: f.patterns.length,
        patterns: f.patterns.map((p, i) =>
          reveal ? { index: i, pattern: p } : { index: i, preview: redactMatch(p) },
        ),
      })),
      verbose: reveal,
    });
    return;
  }

  if (files.length === 0) {
    emitText(`no marker files in ${dir}`);
    return;
  }

  for (const f of files) {
    const tag = f.stem === ALWAYS_FILE_STEM ? " (always-block)" : "";
    emitText(`${f.stem}${tag} — ${f.patterns.length} pattern(s)`);
    for (let i = 0; i < f.patterns.length; i++) {
      const p = f.patterns[i]!;
      if (reveal) {
        emitText(`  [${i}] ${p}`);
      } else {
        emitText(`  [${i}] ${redactMatch(p)}`);
      }
    }
  }
}

export function markersTest(input: string, opts: MarkersTestOptions): void {
  if (typeof input !== "string" || input.length === 0) {
    emitError({ code: "USAGE", error: "markers test requires a non-empty <string> argument" }, opts);
  }

  const cwd = opts.cwd ?? process.cwd();
  const repo = readRepoConfig(cwd);
  const denySet = computeDenySet(repo);
  const reveal = shouldRevealMatches(opts);

  if (denySet.combinedRegex === "") {
    if (opts.json) {
      emitJson({
        action: "markers-test",
        input: reveal ? input : redactMatch(input),
        hits: [],
        repo: { class: repo.class, engagements: repo.engagements },
        warnings: denySet.warnings,
      });
      return;
    }
    emitText(`repo-aegis: no deny set in this repo (class=${repo.class})`);
    return;
  }

  const hits: { fileStem: string; index: number; pattern?: string; preview?: string }[] = [];

  for (const f of denySet.files) {
    const lines = readFileSync(f.path, "utf8").split("\n");
    const patterns: string[] = [];
    for (const raw of lines) {
      const trimmed = raw.trim();
      if (trimmed.length === 0 || trimmed.startsWith(";")) continue;
      patterns.push(trimmed);
    }
    for (let i = 0; i < patterns.length; i++) {
      const p = patterns[i]!;
      let re: RegExp;
      try {
        re = new RegExp(p, "i");
      } catch {
        continue;
      }
      if (re.test(input)) {
        hits.push({
          fileStem: f.stem,
          index: i,
          ...(reveal ? { pattern: p } : { preview: redactMatch(p) }),
        });
      }
    }
  }

  if (opts.json) {
    emitJson({
      action: "markers-test",
      input: reveal ? input : redactMatch(input),
      hits,
      repo: { class: repo.class, engagements: repo.engagements },
      warnings: denySet.warnings,
    });
    return;
  }

  if (hits.length === 0) {
    emitText(`no marker matched in this repo's deny set (${denySet.patterns.length} patterns checked)`);
    return;
  }
  emitText(`${hits.length} marker hit${hits.length === 1 ? "" : "s"}:`);
  for (const h of hits) {
    const preview = reveal ? h.pattern! : h.preview!;
    emitText(`  ${h.fileStem}[${h.index}]  ${preview}`);
  }
}
