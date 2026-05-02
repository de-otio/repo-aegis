// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runScan, type SearchClient, type SearchClientResult } from "./run.js";

function fakeClient(scenarios: Record<string, SearchClientResult[]>): SearchClient {
  return {
    async searchCode(query, page): Promise<SearchClientResult> {
      const pages = scenarios[query];
      if (!pages) return { items: [], total_count: 0 };
      const result = pages[page - 1] ?? { items: [], total_count: 0 };
      return result;
    },
  };
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
    seen[`v1|"foo" org:de-otio|org/repo1|a.txt|`] = true;
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

  it("sets degraded=true when any query fails", async () => {
    const client: SearchClient = {
      async searchCode(query) {
        if (query.includes("fail")) throw new Error("rate limit");
        return { items: [], total_count: 0 };
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
    assert.equal(result.summary.degraded, true);
  });

  it("sets degraded=false when all queries succeed", async () => {
    const client: SearchClient = {
      async searchCode() {
        return { items: [], total_count: 0 };
      },
    };
    const result = await runScan({
      queries: [{ name: "q", query: '"foo" org:de-otio' }],
      state: { seen: {} },
      client,
      sleep: noSleep,
    });
    assert.equal(result.summary.degraded, false);
  });
});

describe("runScan — previousRunIso", () => {
  it("threads previousRunIso=null when state has no prior run", async () => {
    const client: SearchClient = {
      async searchCode() {
        return { items: [], total_count: 0 };
      },
    };
    const result = await runScan({
      queries: [{ name: "q", query: '"foo" org:de-otio' }],
      state: { seen: {} },
      client,
      sleep: noSleep,
    });
    assert.equal(result.summary.previousRunIso, null);
  });

  it("threads previousRunIso from state.lastRunIso", async () => {
    const client: SearchClient = {
      async searchCode() {
        return { items: [], total_count: 0 };
      },
    };
    const result = await runScan({
      queries: [{ name: "q", query: '"foo" org:de-otio' }],
      state: { seen: {}, lastRunIso: "2026-04-30T12:00:00Z" },
      client,
      sleep: noSleep,
    });
    assert.equal(result.summary.previousRunIso, "2026-04-30T12:00:00Z");
    // The new endedIso is written into updatedState.lastRunIso, but the
    // summary's previousRunIso must reflect the prior value, not the new
    // one.
    assert.notEqual(result.summary.previousRunIso, result.summary.endedIso);
    assert.equal(result.updatedState.lastRunIso, result.summary.endedIso);
  });
});

describe("runScan — secondary rate-limit retry", () => {
  it("retries once after a 429 with Retry-After, then records the result", async () => {
    let attempt = 0;
    const sleeps: number[] = [];
    const client: SearchClient = {
      async searchCode(_query, _page) {
        attempt++;
        if (attempt === 1) {
          // Mimic the shape `octokit-client.HttpClientError` propagates.
          const err = Object.assign(new Error("API rate limit exceeded"), {
            status: 429,
            retryAfterSeconds: 3,
          });
          throw err;
        }
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
      queries: [{ name: "q", query: '"foo" org:de-otio' }],
      state: { seen: {} },
      client,
      sleep: async ms => {
        sleeps.push(ms);
      },
    });
    // Two attempts: first throws, second succeeds.
    assert.equal(attempt, 2);
    // We slept for the Retry-After (3s = 3000ms) — distinguishable from
    // the inter-page sleep, which only fires when there's a next page.
    assert.ok(sleeps.includes(3000), `expected sleep for 3000ms, got ${JSON.stringify(sleeps)}`);
    // The retry result was recorded.
    assert.equal(result.hits.length, 1);
    const status = result.summary.queries[0]!;
    assert.equal(status.ok, true);
    assert.equal(status.totalResults, 1);
    assert.equal(status.throttled, undefined, "successful retry must not set throttled");
  });

  it("treats 403 with Retry-After as a secondary rate-limit (sleeps and retries once)", async () => {
    let attempt = 0;
    const sleeps: number[] = [];
    const client: SearchClient = {
      async searchCode() {
        attempt++;
        if (attempt === 1) {
          const err = Object.assign(new Error("secondary rate limit"), {
            status: 403,
            retryAfterSeconds: 5,
          });
          throw err;
        }
        return { items: [], total_count: 0 };
      },
    };
    const result = await runScan({
      queries: [{ name: "q", query: '"foo" org:de-otio' }],
      state: { seen: {} },
      client,
      sleep: async ms => {
        sleeps.push(ms);
      },
    });
    assert.equal(attempt, 2);
    assert.ok(sleeps.includes(5000));
    assert.equal(result.summary.queries[0]!.ok, true);
  });

  it("does NOT retry on 403 without Retry-After (treated as auth/perms, not rate-limit)", async () => {
    let attempt = 0;
    const client: SearchClient = {
      async searchCode() {
        attempt++;
        const err = Object.assign(new Error("forbidden"), {
          status: 403,
          retryAfterSeconds: null,
        });
        throw err;
      },
    };
    const result = await runScan({
      queries: [{ name: "q", query: '"foo" org:de-otio' }],
      state: { seen: {} },
      client,
      sleep: noSleep,
    });
    assert.equal(attempt, 1, "must not retry a non-rate-limited 403");
    const status = result.summary.queries[0]!;
    assert.equal(status.ok, false);
    assert.equal(status.throttled, undefined);
  });

  it("caps Retry-After at maxRetryAfterSeconds (default 60s)", async () => {
    let attempt = 0;
    const sleeps: number[] = [];
    const client: SearchClient = {
      async searchCode() {
        attempt++;
        if (attempt === 1) {
          const err = Object.assign(new Error("rate limit"), {
            status: 429,
            retryAfterSeconds: 600, // 10 minutes — far above the default cap
          });
          throw err;
        }
        return { items: [], total_count: 0 };
      },
    };
    await runScan({
      queries: [{ name: "q", query: '"foo" org:de-otio' }],
      state: { seen: {} },
      client,
      sleep: async ms => {
        sleeps.push(ms);
      },
    });
    // Default cap is 60s = 60000ms.
    assert.ok(sleeps.includes(60000), `expected sleep capped at 60s, got ${JSON.stringify(sleeps)}`);
  });

  it("when retry also rate-limits, marks query throttled and continues with the next query", async () => {
    let badAttempts = 0;
    let goodAttempts = 0;
    const client: SearchClient = {
      async searchCode(query) {
        if (query.includes("bad")) {
          badAttempts++;
          const err = Object.assign(new Error("rate limit"), {
            status: 429,
            retryAfterSeconds: 1,
          });
          throw err;
        }
        goodAttempts++;
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
        { name: "bad", query: '"bad" org:de-otio' },
        { name: "good", query: '"good" org:de-otio' },
      ],
      state: { seen: {} },
      client,
      sleep: noSleep,
    });
    // Two attempts on the rate-limited query (initial + 1 retry), then move on.
    assert.equal(badAttempts, 2);
    // The good query still ran.
    assert.equal(goodAttempts, 1);
    const badStatus = result.summary.queries.find(q => q.name === "bad")!;
    const goodStatus = result.summary.queries.find(q => q.name === "good")!;
    assert.equal(badStatus.ok, false);
    assert.equal(badStatus.throttled, true);
    assert.equal(goodStatus.ok, true);
    assert.equal(goodStatus.totalResults, 1);
    // degraded surfaces the partial failure.
    assert.equal(result.summary.degraded, true);
  });
});

describe("runScan — seenIso date stamping (schema v2)", () => {
  it("records new seen entries with today's UTC date string", async () => {
    const fixedNow = new Date("2026-04-15T12:00:00Z");
    const client: SearchClient = {
      async searchCode() {
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
      queries: [{ name: "q", query: '"foo" org:de-otio' }],
      state: { seen: {} },
      client,
      sleep: noSleep,
      now: () => fixedNow,
    });
    const keys = Object.keys(result.updatedState.seen);
    assert.equal(keys.length, 1);
    assert.equal(result.updatedState.seen[keys[0]!], "2026-04-15");
  });

  it("does not overwrite existing v1 (true) seen entries", async () => {
    const fixedNow = new Date("2026-04-15T12:00:00Z");
    const client: SearchClient = {
      async searchCode() {
        return {
          items: [
            {
              path: "a.txt",
              repository: { full_name: "org/repo1" },
              html_url: "https://x",
            },
          ],
          total_count: 1,
        };
      },
    };
    const seen: Record<string, true | string> = {};
    seen[`v1|"foo" org:de-otio|org/repo1|a.txt|`] = true;
    const result = await runScan({
      queries: [{ name: "q", query: '"foo" org:de-otio' }],
      state: { seen },
      client,
      sleep: noSleep,
      now: () => fixedNow,
    });
    // The previously-seen entry is preserved as `true`; nothing is re-fired.
    assert.equal(result.hits.length, 0);
    assert.equal(result.updatedState.seen[`v1|"foo" org:de-otio|org/repo1|a.txt|`], true);
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
