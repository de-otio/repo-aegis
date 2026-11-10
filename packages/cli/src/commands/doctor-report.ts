// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// How `doctor` turns its findings into text (X-9). Pure: findings in, lines out, so the rules
// below are unit-tested without a repository, a registry or a `gh`.
//
//   - Findings with the same label and code across repositories collapse into ONE line with a
//     count (`HOOKS_PATH_LOCAL_DUPLICATE: 14 repositories (repo-aegis doctor --json lists them)`).
//     `--verbose` keeps every item; `--json` never collapses.
//   - A fix line under every finding is `--verbose` only. By default the text ends with a short
//     "Fix these first" list instead: the FAILs, one fix command each.
//   - FAIL sorts before WARN, INFO and SKIP, so the lines that change the exit code come first.

export type FindingLabel = "FAIL" | "WARN" | "INFO" | "SKIP";

export interface Finding {
  label: FindingLabel;
  /** Check code, or a hook-state code for a repository whose hooks are not live. */
  code: string;
  /** What is printed after the label when this finding stands alone. */
  line: string;
  /** Extra detail lines under it, kept in every mode. */
  notes?: string[];
  fix?: string;
  /** Present for per-repository findings only. Machine-level findings never collapse. */
  repo?: string;
  /** Appended to a collapsed line (for example ` [would fix]`). */
  suffix?: string;
}

export interface ReportLine {
  label: FindingLabel;
  code: string;
  text: string;
  notes: string[];
  fix?: string;
  /** How many findings this line stands for. */
  count: number;
  /** True when the collapsed findings carry different fixes (each names its own repository or owner). */
  fixesDiffer: boolean;
}

const RANK: Record<FindingLabel, number> = { FAIL: 0, WARN: 1, INFO: 2, SKIP: 3 };

/** How the collapsed line reads. The rule's own example is this exact shape. */
export function collapsedText(code: string, count: number): string {
  return `${code}: ${count} repositories (repo-aegis doctor --json lists them)`;
}

/**
 * Collapse repeated per-repository findings. A group is the same label and code; one item stays as it is,
 * two or more become one line with a count. `verbose` keeps every item. Order: FAIL, WARN, INFO, SKIP,
 * and within a label the order each group first appeared in.
 */
export function collapseFindings(findings: readonly Finding[], verbose: boolean): ReportLine[] {
  const lines: ReportLine[] = [];
  const groups = new Map<string, Finding[]>();
  const order: Array<Finding | string> = [];
  for (const f of findings) {
    if (verbose || f.repo === undefined) {
      order.push(f);
      continue;
    }
    const key = `${f.label}\u0000${f.code}`;
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, [f]);
      order.push(key);
    } else {
      group.push(f);
    }
  }
  for (const entry of order) {
    const members = typeof entry === "string" ? groups.get(entry)! : [entry];
    const first = members[0]!;
    if (members.length === 1) {
      lines.push({
        label: first.label,
        code: first.code,
        text: first.line,
        notes: first.notes ?? [],
        ...(first.fix !== undefined && { fix: first.fix }),
        count: 1,
        fixesDiffer: false,
      });
      continue;
    }
    const fixes = new Set(members.map(m => m.fix).filter((x): x is string => x !== undefined));
    const suffix = new Set(members.map(m => m.suffix ?? ""));
    lines.push({
      label: first.label,
      code: first.code,
      text: collapsedText(first.code, members.length) + (suffix.size === 1 ? [...suffix][0]! : ""),
      notes: [],
      ...(first.fix !== undefined && { fix: first.fix }),
      count: members.length,
      fixesDiffer: fixes.size > 1,
    });
  }
  return lines
    .map((l, i) => ({ l, i }))
    .sort((a, b) => RANK[a.l.label] - RANK[b.l.label] || a.i - b.i)
    .map(x => x.l);
}

/** The text lines for the collapsed findings; fix lines only under `verbose`. */
export function renderLines(lines: readonly ReportLine[], verbose: boolean): string[] {
  const out: string[] = [];
  for (const l of lines) {
    out.push(`  ${l.label} ${l.text}`);
    for (const n of l.notes) out.push(`       ${n}`);
    if (verbose && l.fix !== undefined) out.push(`       fix: ${l.fix}`);
  }
  return out;
}

/** Past this many distinct FAIL codes the list is cut and says how many more there are. */
const FIX_FIRST_MAX = 5;

/**
 * "Fix these first": the FAILs, one fix command per code. At most five entries; beyond that the first four
 * and a line saying how many more (`--verbose` lists them). Empty when there is no FAIL with a fix.
 */
export function fixFirstLines(lines: readonly ReportLine[]): string[] {
  const seen = new Set<string>();
  const entries: string[] = [];
  for (const l of lines) {
    if (l.label !== "FAIL" || l.fix === undefined || seen.has(l.code)) continue;
    seen.add(l.code);
    const more = l.count > 1 && l.fixesDiffer ? `   (the other ${l.count - 1} repositories have their own fix: repo-aegis doctor --verbose)` : "";
    entries.push(`  ${l.fix}   [${l.code}]${more}`);
  }
  if (entries.length === 0) return [];
  const shown = entries.length > FIX_FIRST_MAX ? entries.slice(0, FIX_FIRST_MAX - 1) : entries;
  const rest = entries.length - shown.length;
  return [
    "Fix these first:",
    ...shown,
    ...(rest > 0 ? [`  ... and ${rest} more failing code(s): repo-aegis doctor --verbose lists each fix`] : []),
  ];
}
