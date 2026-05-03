// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderMarkdown } from "./output.js";
import type { CodeSearchHit, RunSummary } from "./types.js";

const baseSummary: RunSummary = {
  queries: [
    { name: "q1", ok: true, totalResults: 2, newResults: 1, truncated: false },
    { name: "q2", ok: false, error: "rate limit", totalResults: 0, newResults: 0, truncated: false },
  ],
  totalNew: 1,
  totalSeen: 5,
  startedIso: "2026-05-01T00:00:00Z",
  endedIso: "2026-05-01T00:00:30Z",
  previousRunIso: "2026-04-30T00:00:00Z",
  degraded: true,
};

describe("renderMarkdown", () => {
  it("includes headers, summary, and per-query status table", () => {
    const md = renderMarkdown(baseSummary, []);
    assert.match(md, /# repo-aegis-scan report/);
    assert.match(md, /Started: 2026-05-01/);
    assert.match(md, /Ended: {3}2026-05-01/);
    assert.match(md, /New hits: \*\*1\*\*/);
    assert.match(md, /\| q1 \| ✅ \| 1 \| 2 \| {2}\| {2}\|/);
    assert.match(md, /\| q2 \| ❌ \|/);
    assert.match(md, /rate limit/);
  });

  it("renders 'no new hits' when hits empty", () => {
    const md = renderMarkdown(baseSummary, []);
    assert.match(md, /_No new hits._/);
  });

  it("groups hits by query and links each", () => {
    const hits: CodeSearchHit[] = [
      {
        query: "q1",
        repo: "owner/repo",
        path: "src/foo.ts",
        line: 12,
        url: "https://github.com/owner/repo/blob/main/src/foo.ts#L12",
      },
      {
        query: "q1",
        repo: "owner/repo2",
        path: "README",
        line: null,
        url: "https://github.com/owner/repo2",
      },
    ];
    const md = renderMarkdown(baseSummary, hits);
    assert.match(md, /### q1/);
    assert.match(md, /\[owner\/repo:src\/foo\.ts\]\(https:\/\/github\.com[^)]+\):12/);
    assert.match(md, /\[owner\/repo2:README\]\(https:\/\/github\.com[^)]+\)/);
  });

  it("includes snippet block when snippet field is present", () => {
    const hits: CodeSearchHit[] = [
      {
        query: "q1",
        repo: "owner/repo",
        path: "p",
        line: null,
        url: "https://x",
        snippet: "leaked-marker-string",
      },
    ];
    const md = renderMarkdown(baseSummary, hits);
    assert.match(md, /```\n {2}leaked-marker-string\n {2}```/);
  });

  it("escapes pipe characters that would break the table", () => {
    const summary: RunSummary = {
      ...baseSummary,
      queries: [{ name: "with|pipe", ok: true, totalResults: 0, newResults: 0, truncated: false }],
    };
    const md = renderMarkdown(summary, []);
    assert.match(md, /with\\\|pipe/);
  });

  it("renders Previous run line with the prior ISO when present", () => {
    const md = renderMarkdown(baseSummary, []);
    assert.match(md, /Previous run: 2026-04-30T00:00:00Z/);
  });

  it("renders Previous run line as 'never' when previousRunIso is null", () => {
    const summary: RunSummary = { ...baseSummary, previousRunIso: null };
    const md = renderMarkdown(summary, []);
    assert.match(md, /Previous run: never/);
  });

  it("renders semantic section with no hits when sweep ran but found nothing", () => {
    const md = renderMarkdown(baseSummary, [], {
      hits: [],
      embedded: 3,
      embedErrors: 0,
      candidates: 3,
    });
    assert.match(md, /## Semantic hits/);
    assert.match(md, /Embedded 3\/3 candidates\./);
    assert.match(md, /_No semantic hits over threshold._/);
  });

  it("renders semantic hit table with engagement, similarity, threshold, candidate", () => {
    const md = renderMarkdown(baseSummary, [], {
      hits: [
        {
          engagementId: "customer-a",
          similarity: 0.876,
          threshold: 0.78,
          repo: "owner/repo",
          path: "src/leak.md",
          url: "https://github.com/owner/repo/blob/main/src/leak.md",
          query: "q1",
        },
      ],
      embedded: 1,
      embedErrors: 0,
      candidates: 1,
    });
    assert.match(md, /\| customer-a \| 0\.876 \| 0\.780 \|/);
    assert.match(md, /\[owner\/repo:src\/leak\.md\]\(https:\/\/github/);
  });

  it("notes embed errors in the semantic section header", () => {
    const md = renderMarkdown(baseSummary, [], {
      hits: [],
      embedded: 1,
      embedErrors: 2,
      candidates: 3,
    });
    assert.match(md, /Embedded 1\/3 candidates \(2 embed errors\)\./);
  });
});
