// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// `repo-aegis explain <CODE|topic> [--json]` and `repo-aegis explain --list`.
//
// Every refusal ends with `[CODE; details: repo-aegis explain CODE]`, and a refusal can reach an agent working
// in ANY repository, where doc/agent-guide.md does not exist. So the guide ships inside the npm package
// (`dist/docs/`, copied at build time by scripts/copy-cli-docs.mjs) and this command prints the part of it
// that documents the code.
//
// Read-only on purpose: it reads two files that ship next to this module and nothing else. No registry, no
// network, no git, no cwd, never a user's repo. That is also why an agent may run it (it is not on the
// human-only list in core/human-commands.ts).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { emitJson, emitText, emitError, type OutputOptions } from "../format.js";

/** One row of the guide's error table. */
export interface ErrorRow {
  /** Every code the first cell names (`A / B` rows name two). Upper case. */
  readonly codes: readonly string[];
  /** The row's `<a id="…">` anchor, if it has one. Lower case. */
  readonly anchor: string | null;
  readonly meaning: string;
  readonly recovery: string;
  /** Slugs of the `](#…)` links the row carries. */
  readonly links: readonly string[];
}

/** A heading and the text under it, up to the next heading of the same or a higher level. */
export interface Section {
  readonly heading: string;
  readonly slug: string;
  readonly level: number;
  readonly markdown: string;
}

export interface Explanation {
  readonly code: string;
  readonly codes: readonly string[];
  readonly anchor: string | null;
  readonly meaning: string;
  readonly recovery: string;
  readonly section: { readonly heading: string; readonly markdown: string } | null;
}

const CODE_TOKEN = /^[A-Z][A-Z0-9_]*$/;

/** GitHub's heading slug: lower case, punctuation dropped, spaces to hyphens. */
export function slugify(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^a-z0-9_\s-]/g, "")
    .trim()
    .replace(/\s/g, "-");
}

/** Split a table row on its unescaped pipes. */
function cells(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (c === "\\" && line[i + 1] === "|") {
      cur += "|";
      i++;
    } else if (c === "|") {
      out.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  out.push(cur);
  // a row starts and ends with a pipe: drop the empty edges
  return out.slice(1, -1).map(s => s.trim());
}

/** The headings of a markdown document, with the section under each. Fenced code is not scanned for headings. */
export function sections(md: string): Section[] {
  const lines = md.split("\n");
  const heads: { idx: number; level: number; heading: string }[] = [];
  let fence = false;
  lines.forEach((line, idx) => {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    if (fence) return;
    const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (m !== null) heads.push({ idx, level: m[1]!.length, heading: m[2]! });
  });
  return heads.map((h, i) => {
    const next = heads.slice(i + 1).find(n => n.level <= h.level);
    const end = next === undefined ? lines.length : next.idx;
    return {
      heading: h.heading,
      slug: slugify(h.heading),
      level: h.level,
      markdown: lines.slice(h.idx, end).join("\n").trimEnd(),
    };
  });
}

/** The rows of the guide's `## Error codes` table. */
export function errorRows(md: string): ErrorRow[] {
  const lines = md.split("\n");
  const start = lines.findIndex(l => /^##\s+Error codes\s*$/.test(l));
  if (start === -1) return [];
  const rows: ErrorRow[] = [];
  let fence = false;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    if (fence) continue;
    if (/^##\s/.test(line)) break;
    if (!line.startsWith("|")) continue;
    const c = cells(line);
    if (c.length < 3 || /^-+$/.test(c[0]!.replace(/[:\s]/g, "")) || c[0] === "Code") continue;
    const first = c[0]!;
    const anchor = /<a id="([^"]+)"><\/a>/.exec(first)?.[1]?.toLowerCase() ?? null;
    const codes: string[] = [];
    for (const m of first.matchAll(/`([^`]+)`/g)) {
      if (CODE_TOKEN.test(m[1]!)) codes.push(m[1]!);
    }
    if (codes.length === 0 && anchor === null) continue;
    const meaning = c[1]!;
    const recovery = c.slice(2).join(" | ");
    const links = [...`${meaning} ${recovery}`.matchAll(/\]\(#([a-z0-9_-]+)\)/g)].map(m => m[1]!);
    rows.push({ codes, anchor, meaning, recovery, links });
  }
  return rows;
}

/** `GH_X`, `gh_x`, `gh-x` and `[GH_X]` all name the same code. */
function normalize(query: string): string {
  return query.trim().replace(/^\[|\]$/g, "").replace(/-/g, "_").toUpperCase();
}

/** Edit distance, for "did you mean". Inputs are short. */
function distance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length]!;
}

/** Up to five known names closest to `query`: containment first, then by edit distance. */
export function nearest(query: string, known: readonly string[]): string[] {
  const q = normalize(query);
  if (q === "") return [];
  const scored = known.map(k => {
    const contains = k.includes(q) || (q.length >= 4 && q.includes(k));
    return { k, score: contains ? 0 : distance(q, k) };
  });
  const limit = Math.max(3, Math.floor(q.length / 3));
  return scored
    .filter(s => s.score <= limit)
    .sort((a, b) => a.score - b.score || a.k.localeCompare(b.k))
    .slice(0, 5)
    .map(s => s.k);
}

export interface Docs {
  readonly guide: string;
  readonly sandbox: string | null;
}

/** The shipped docs: `dist/docs/` next to `dist/commands/`. Null when they are not there (an unbuilt checkout). */
export function loadDocs(dir?: string): Docs | null {
  const base = dir ?? join(dirname(fileURLToPath(import.meta.url)), "..", "docs");
  try {
    const guide = readFileSync(join(base, "agent-guide.md"), "utf8");
    let sandbox: string | null = null;
    try {
      sandbox = readFileSync(join(base, "agent-sandbox.md"), "utf8");
    } catch {
      /* optional */
    }
    return { guide, sandbox };
  } catch {
    return null;
  }
}

/** Every code the guide documents, sorted. */
export function knownCodes(docs: Docs): string[] {
  const out = new Set<string>();
  for (const r of errorRows(docs.guide)) {
    for (const c of r.codes) out.add(c);
    if (r.anchor !== null) out.add(r.anchor.toUpperCase());
  }
  return [...out].sort();
}

/** Find the row for a code: by anchor first, then by any code its first cell names. */
export function findRow(docs: Docs, query: string): ErrorRow | null {
  const q = normalize(query);
  const rows = errorRows(docs.guide);
  return rows.find(r => r.anchor === q.toLowerCase()) ?? rows.find(r => r.codes.includes(q)) ?? null;
}

/** The `### ` section a row links to, if any. */
function linkedSection(docs: Docs, row: ErrorRow): Section | null {
  const all = sections(docs.guide);
  for (const slug of row.links) {
    const s = all.find(x => x.level === 3 && x.slug === slug);
    if (s !== undefined) return s;
  }
  return null;
}

export function explanationFor(docs: Docs, query: string): Explanation | null {
  const row = findRow(docs, query);
  if (row === null) return null;
  const sec = linkedSection(docs, row);
  const q = normalize(query);
  return {
    code: row.codes.includes(q) ? q : (row.codes[0] ?? q),
    codes: row.codes,
    anchor: row.anchor,
    meaning: row.meaning,
    recovery: row.recovery,
    section: sec === null ? null : { heading: sec.heading, markdown: sec.markdown },
  };
}

/** A topic that is not a code: `sandbox` (the shipped agent-sandbox.md), or the slug of a `##` / `###` heading of the guide. */
function topicText(docs: Docs, query: string): { topic: string; markdown: string } | null {
  const q = query.trim().toLowerCase();
  if (q === "sandbox" && docs.sandbox !== null) return { topic: "sandbox", markdown: docs.sandbox.trimEnd() };
  const s = sections(docs.guide).find(x => (x.level === 2 || x.level === 3) && x.slug === q);
  return s === undefined ? null : { topic: s.slug, markdown: s.markdown };
}

export interface ExplainOptions extends OutputOptions {
  list?: boolean;
  /** Test seam: read the docs from here instead of `dist/docs`. */
  docsDir?: string;
}

export function explain(query: string | undefined, opts: ExplainOptions): void {
  const docs = loadDocs(opts.docsDir);
  if (docs === null) {
    emitError(
      {
        code: "EXPLAIN_DOCS_MISSING",
        error: "the agent guide is not installed next to this command (dist/docs/agent-guide.md); reinstall @de-otio/repo-aegis or run `npm run build` in a checkout",
      },
      opts,
    );
  }
  if (opts.list === true) {
    const codes = knownCodes(docs);
    const topics = docs.sandbox === null ? [] : ["sandbox"];
    if (opts.json) emitJson({ codes, topics });
    else {
      for (const c of codes) emitText(c);
      for (const t of topics) emitText(`${t} (topic)`);
    }
    return;
  }
  if (query === undefined || query.trim() === "") {
    emitError({ code: "USAGE", error: "explain needs a <CODE> or a topic (or --list); the code is the word in `[CODE; details: …]` at the end of a refusal" }, opts);
  }
  const found = explanationFor(docs, query);
  if (found !== null) {
    if (opts.json) {
      emitJson({ ...found, source: "agent-guide.md" });
      return;
    }
    emitText(found.codes.length > 1 ? `${found.codes.join(" / ")}` : found.code);
    emitText("");
    emitText(`Meaning: ${found.meaning}`);
    emitText("");
    emitText(`Recovery: ${found.recovery}`);
    if (found.section !== null) {
      emitText("");
      emitText(found.section.markdown);
    }
    return;
  }
  const topic = topicText(docs, query);
  if (topic !== null) {
    if (opts.json) emitJson({ topic: topic.topic, markdown: topic.markdown, source: topic.topic === "sandbox" ? "agent-sandbox.md" : "agent-guide.md" });
    else emitText(topic.markdown);
    return;
  }
  const near = nearest(query, [...knownCodes(docs), ...(docs.sandbox === null ? [] : ["SANDBOX"])]);
  emitError(
    {
      code: "UNKNOWN_CODE",
      error: `no explanation for "${query.trim().slice(0, 80)}"${!opts.json && near.length > 0 ? `; nearest: ${near.join(", ")}` : ""}. \`repo-aegis explain --list\` prints every known code.`,
      ...(opts.json ? { details: { nearest: near } } : {}),
    },
    opts,
  );
}
