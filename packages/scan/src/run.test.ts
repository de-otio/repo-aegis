import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runScan, type SearchClient, type SearchClientResult } from "./run.js";

function fakeClient(scenarios: Record<string, SearchClientResult[]>): SearchClient {
  const calls: { query: string; page: number }[] = [];
  return {
    async searchCode(query, page): Promise<SearchClientResult> {
      calls.push({ query, page });
      const pages = scenarios[query];
      if (!pages) return { items: [], total_count: 0 };
      const result = pages[page - 1] ?? { items: [], total_count: 0 };
      return result;
    },
    // expose calls via property (cast at use site)
  } as SearchClient;
}

function noSleep(_: number): Promise<void> {
  return Promise.resolve();
}

describe("runScan — happy path", () => {
  it("returns hits for each query", async () => {
    const client = fakeClient({
      '"foo" org:de-otio': [
        {
          items: [
            {
              path: "a.txt",
              repository: { full_name: "org/repo1" },
              html_url: "https://github.com/org/repo1/blob/main/a.txt",
            },
          ],
          total_count: 1,
        },
      ],
    });
    const result = await runScan({
      queries: [{ name: "q1", query: '"foo" org:de-otio' }],
      state: { seen: {} },
      client,
      sleep: noSleep,
    });
    assert.equal(result.hits.length, 1);
    assert.equal(result.hits[0]!.repo, "org/repo1");
    assert.equal(result.summary.totalNew, 1);
    assert.equal(result.summary.queries.length, 1);
    assert.equal(result.summary.queries[0]!.ok, true);
  });

  it("filters out previously-seen hits", async () => {
    const client = fakeClient({
      '"foo" org:de-otio': [
        {
          items: [
            {
              path: "a.txt",
              repository: { full_name: "org/repo1" },
              html_url: "https://github.com/org/repo1/blob/main/a.txt",
            },
          ],
          total_count: 1,
        },
      ],
    });
    const seen: Record<string, true> = {};
    seen[`"foo" org:de-otio|org/repo1|a.txt|`] = true;
    const result = await runScan({
      queries: [{ name: "q1", query: '"foo" org:de-otio' }],
      state: { seen },
      client,
      sleep: noSleep,
    });
    assert.equal(result.hits.length, 0);
    assert.equal(result.summary.totalNew, 0);
  });

  it("redacts snippet by default", async () => {
    const client = fakeClient({
      '"foo" org:de-otio': [
        {
          items: [
            {
              path: "a.txt",
              repository: { full_name: "org/repo1" },
              html_url: "https://x",
              text_matches: [{ fragment: "literal-marker-text-here" }],
            },
          ],
          total_count: 1,
        },
      ],
    });
    const result = await runScan({
      queries: [{ name: "q1", query: '"foo" org:de-otio' }],
      state: { seen: {} },
      client,
      sleep: noSleep,
    });
    assert.equal(result.hits[0]!.snippet, undefined, "default must omit snippet");
  });

  it("includes snippet when revealMatches=true", async () => {
    const client = fakeClient({
      '"foo" org:de-otio': [
        {
          items: [
            {
              path: "a.txt",
              repository: { full_name: "org/repo1" },
              html_url: "https://x",
              text_matches: [{ fragment: "literal-marker-text-here" }],
            },
          ],
          total_count: 1,
        },
      ],
    });
    const result = await runScan({
      queries: [{ name: "q1", query: '"foo" org:de-otio' }],
      state: { seen: {} },
      client,
      revealMatches: true,
      sleep: noSleep,
    });
    assert.equal(result.hits[0]!.snippet, "literal-marker-text-here");
  });
});

describe("runScan — exclusions", () => {
  it("appends -org and -repo filters from CLI options", async () => {
    let observed = "";
    const client: SearchClient = {
      async searchCode(query) {
        observed = query;
        return { items: [], total_count: 0 };
      },
    };
    await runScan({
      queries: [{ name: "q", query: '"foo" org:de-otio' }],
      state: { seen: {} },
      client,
      excludeOrg: ["bots"],
      excludeRepo: ["de-otio/dot-notes"],
      sleep: noSleep,
    });
    assert.ok(observed.includes("-org:bots"));
    assert.ok(observed.includes("-repo:de-otio/dot-notes"));
  });

  it("appends per-query excludeOrg/excludeRepo too", async () => {
    let observed = "";
    const client: SearchClient = {
      async searchCode(query) {
        observed = query;
        return { items: [], total_count: 0 };
      },
    };
    await runScan({
      queries: [
        {
          name: "q",
          query: '"foo" org:de-otio',
          excludeOrg: ["per-q-org"],
          excludeRepo: ["per-q/repo"],
        },
      ],
      state: { seen: {} },
      client,
      sleep: noSleep,
    });
    assert.ok(observed.includes("-org:per-q-org"));
    assert.ok(observed.includes("-repo:per-q/repo"));
  });
});

describe("runScan — partial failure", () => {
  it("reports per-query error and continues with others", async () => {
    const client: SearchClient = {
      async searchCode(query) {
        if (query.includes("fail")) throw new Error("rate limit");
        return {
          items: [
            {
              path: "a.txt",
              repository: { full_name: "org/repo" },
              html_url: "https://x",
            },
          ],
          total_count: 1,
        };
      },
    };
    const result = await runScan({
      queries: [
        { name: "good", query: '"foo" org:de-otio' },
        { name: "bad", query: '"fail" org:de-otio' },
      ],
      state: { seen: {} },
      client,
      sleep: noSleep,
    });
    const goodStatus = result.summary.queries.find(q => q.name === "good");
    const badStatus = result.summary.queries.find(q => q.name === "bad");
    assert.equal(goodStatus!.ok, true);
    assert.equal(goodStatus!.totalResults, 1);
    assert.equal(badStatus!.ok, false);
    assert.ok(badStatus!.error?.includes("rate limit"));
  });
});

describe("runScan — pagination", () => {
  it("stops at maxPagesPerQuery", async () => {
    let pageCalls = 0;
    const client: SearchClient = {
      async searchCode(_query, _page) {
        pageCalls++;
        return {
          items: [
            {
              path: `p${pageCalls}.txt`,
              repository: { full_name: "org/repo" },
              html_url: "https://x",
            },
          ],
          total_count: 9999,
        };
      },
    };
    const result = await runScan({
      queries: [{ name: "q", query: '"foo" org:de-otio' }],
      state: { seen: {} },
      client,
      maxPagesPerQuery: 3,
      sleep: noSleep,
    });
    assert.equal(pageCalls, 3);
    assert.equal(result.summary.queries[0]!.truncated, true);
  });

  it("stops at capResultsPerQuery", async () => {
    const client: SearchClient = {
      async searchCode() {
        return {
          items: Array.from({ length: 10 }, (_, i) => ({
            path: `p${i}.txt`,
            repository: { full_name: "org/repo" },
            html_url: "https://x",
          })),
          total_count: 9999,
        };
      },
    };
    const result = await runScan({
      queries: [{ name: "q", query: '"foo" org:de-otio' }],
      state: { seen: {} },
      client,
      capResultsPerQuery: 5,
      sleep: noSleep,
    });
    assert.ok(result.summary.queries[0]!.totalResults <= 5);
    assert.equal(result.summary.queries[0]!.truncated, true);
  });
});
