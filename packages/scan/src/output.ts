// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
import type { CodeSearchHit, RunSummary } from "./types.js";
import type { SemanticSweepResult } from "./semantic-sweep.js";

export function renderMarkdown(
  summary: RunSummary,
  hits: CodeSearchHit[],
  semantic?: SemanticSweepResult,
): string {
  const lines: string[] = [];
  lines.push(`# repo-aegis-scan report`);
  lines.push("");
  lines.push(`Started: ${summary.startedIso}`);
  lines.push(`Ended:   ${summary.endedIso}`);
  lines.push(`Previous run: ${summary.previousRunIso ?? "never"}`);
  lines.push(`New hits: **${summary.totalNew}** (cumulative seen: ${summary.totalSeen})`);
  lines.push("");

  lines.push(`## Per-query status`);
  lines.push("");
  lines.push("| Query | OK | New | Total | Truncated | Error |");
  lines.push("|---|---|---:|---:|---|---|");
  for (const q of summary.queries) {
    const error = q.error ? "`" + q.error.replace(/\|/g, "\\|") + "`" : "";
    lines.push(
      `| ${escapeMd(q.name)} | ${q.ok ? "✅" : "❌"} | ${q.newResults} | ${q.totalResults} | ${q.truncated ? "yes" : ""} | ${error} |`,
    );
  }
  lines.push("");

  if (hits.length === 0) {
    lines.push(`## Hits`);
    lines.push("");
    lines.push("_No new hits._");
    if (semantic) appendSemanticSection(lines, semantic);
    return lines.join("\n") + "\n";
  }

  lines.push(`## New hits`);
  lines.push("");
  const byQuery = new Map<string, CodeSearchHit[]>();
  for (const h of hits) {
    if (!byQuery.has(h.query)) byQuery.set(h.query, []);
    byQuery.get(h.query)!.push(h);
  }
  for (const [query, qhits] of byQuery) {
    lines.push(`### ${escapeMd(query)}`);
    lines.push("");
    for (const h of qhits) {
      const link = h.url ? `[${escapeMd(h.repo)}:${escapeMd(h.path)}](${h.url})` : `${escapeMd(h.repo)}:${escapeMd(h.path)}`;
      const lineRef = h.line !== null ? `:${h.line}` : "";
      lines.push(`- ${link}${lineRef}`);
      if (h.snippet) {
        lines.push("  ```");
        lines.push("  " + h.snippet.replace(/\n/g, "\n  "));
        lines.push("  ```");
      }
    }
    lines.push("");
  }
  if (semantic) appendSemanticSection(lines, semantic);
  return lines.join("\n") + "\n";
}

/**
 * Append a "Semantic hits" section to the rendered markdown. Always
 * called separately from the regex-hit section per design §3.4: the
 * two are reported side by side, never merged.
 *
 * Redaction: never includes the candidate's body or the profile's
 * reference text — only `engagementId`, similarity, threshold, and the
 * candidate's repo+path+url.
 */
function appendSemanticSection(lines: string[], sweep: SemanticSweepResult): void {
  lines.push(`## Semantic hits`);
  lines.push("");
  lines.push(
    `Embedded ${sweep.embedded}/${sweep.candidates} candidates` +
      (sweep.embedErrors > 0 ? ` (${sweep.embedErrors} embed errors)` : "") +
      `.`,
  );
  lines.push("");
  if (sweep.hits.length === 0) {
    lines.push("_No semantic hits over threshold._");
    lines.push("");
    return;
  }
  lines.push("| Engagement | Similarity | Threshold | Candidate |");
  lines.push("|---|---:|---:|---|");
  for (const h of sweep.hits) {
    const sim = h.similarity.toFixed(3);
    const thr = h.threshold.toFixed(3);
    const link = h.url
      ? `[${escapeMd(h.repo)}:${escapeMd(h.path)}](${h.url})`
      : `${escapeMd(h.repo)}:${escapeMd(h.path)}`;
    lines.push(`| ${escapeMd(h.engagementId)} | ${sim} | ${thr} | ${link} |`);
  }
  lines.push("");
}

function escapeMd(s: string): string {
  return s.replace(/([|`*_\[\]\\])/g, "\\$1");
}
