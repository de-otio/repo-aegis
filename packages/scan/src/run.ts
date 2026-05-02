// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
import type {
  CodeSearchHit,
  QueryEntry,
  QueryRunStatus,
  RunSummary,
  ScanState,
} from "./types.js";
import { hitKey, todayIsoDate } from "./state.js";

export interface SearchClientResult {
  items: {
    name?: string;
    path?: string;
    repository: { full_name?: string };
    html_url?: string;
    text_matches?: { fragment?: string }[];
  }[];
  total_count: number;
  incomplete_results?: boolean;
}

export interface SearchClient {
  searchCode(query: string, page: number, perPage: number): Promise<SearchClientResult>;
}

export interface RunOptions {
  queries: QueryEntry[];
  state: ScanState;
  client: SearchClient;
  excludeOrg?: string[];
  excludeRepo?: string[];
  interRequestSleepMs?: number;
  maxPagesPerQuery?: number;
  capResultsPerQuery?: number;
  revealMatches?: boolean;
  sleep?: (ms: number) => Promise<void>;
  /**
   * Override the clock used to date-stamp new `seen` entries. Tests inject
   * a fixed date so the assertions don't flake across UTC midnight.
   */
  now?: () => Date;
  /**
   * Upper bound on the number of seconds the run will honour from a 429 /
   * secondary-rate-limit `Retry-After` header before giving up on a query.
   * Defaults to 60.
   */
  maxRetryAfterSeconds?: number;
}

export interface RunResult {
  hits: CodeSearchHit[];
  summary: RunSummary;
  updatedState: ScanState;
}

const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_MAX_RETRY_AFTER_SECONDS = 60;

function defaultSleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function buildExcludedQuery(q: QueryEntry, extraExcludeOrg: string[], extraExcludeRepo: string[]): string {
  const parts = [q.query];
  for (const o of [...(q.excludeOrg ?? []), ...extraExcludeOrg]) {
    parts.push(`-org:${o}`);
  }
  for (const r of [...(q.excludeRepo ?? []), ...extraExcludeRepo]) {
    parts.push(`-repo:${r}`);
  }
  return parts.join(" ");
}

interface RateLimitedErrorShape {
  status: number;
  retryAfterSeconds: number | null;
}

/**
 * Detect a GitHub secondary-rate-limit error. `octokit-client` wraps
 * `RequestError` into `HttpClientError` carrying `status` and
 * `retryAfterSeconds`; we type-check structurally so this module does
 * not need to import the wrapper class directly (which keeps run.ts
 * easy to test against a hand-rolled fake client).
 */
function asRateLimited(err: unknown): RateLimitedErrorShape | null {
  if (!err || typeof err !== "object") return null;
  const e = err as { status?: unknown; retryAfterSeconds?: unknown };
  if (typeof e.status !== "number") return null;
  if (e.status !== 429 && e.status !== 403) return null;
  const retry =
    typeof e.retryAfterSeconds === "number" && Number.isFinite(e.retryAfterSeconds)
      ? e.retryAfterSeconds
      : null;
  // 403 without a Retry-After is probably auth/perms, not a rate-limit.
  if (e.status === 403 && retry === null) return null;
  return { status: e.status, retryAfterSeconds: retry };
}

export async function runScan(opts: RunOptions): Promise<RunResult> {
  const interSleep = opts.interRequestSleepMs ?? 2500;
  const maxPages = opts.maxPagesPerQuery ?? 10;
  const cap = opts.capResultsPerQuery ?? 1000;
  const sleep = opts.sleep ?? defaultSleep;
  const reveal = !!opts.revealMatches;
  const nowFn = opts.now ?? (() => new Date());
  const maxRetryAfterSeconds =
    opts.maxRetryAfterSeconds ?? DEFAULT_MAX_RETRY_AFTER_SECONDS;

  const startedIso = nowFn().toISOString();
  const previousRunIso = opts.state.lastRunIso ?? null;
  const queriesStatus: QueryRunStatus[] = [];
  const newHits: CodeSearchHit[] = [];

  const updatedState: ScanState = {
    schemaVersion: opts.state.schemaVersion,
    seen: { ...opts.state.seen },
    lastRunIso: opts.state.lastRunIso,
  };

  // Date-stamp for any new `seen` entries recorded during this run.
  // Captured once at run start so a long sweep doesn't straddle UTC
  // midnight and produce inconsistent values within one run.
  const seenIsoForNewEntries = todayIsoDate(nowFn());

  /**
   * Fetch one page with one retry on 429/secondary-rate-limit. Returns the
   * response on success, throws on hard failure. The `throttled` flag in
   * the returned object is true iff the SECOND attempt also rate-limited;
   * callers use it to record `throttled: true` on the QueryRunStatus.
   */
  async function fetchPageWithRetry(
    fullQuery: string,
    page: number,
  ): Promise<{ result: SearchClientResult } | { error: Error; throttled: boolean }> {
    try {
      const result = await opts.client.searchCode(fullQuery, page, DEFAULT_PAGE_SIZE);
      return { result };
    } catch (err) {
      const rl = asRateLimited(err);
      if (!rl) {
        return { error: err as Error, throttled: false };
      }
      // Rate-limited. Sleep for min(retry-after, cap) seconds, then retry once.
      const waitSec = Math.min(
        rl.retryAfterSeconds ?? maxRetryAfterSeconds,
        maxRetryAfterSeconds,
      );
      await sleep(Math.max(0, waitSec) * 1000);
      try {
        const result = await opts.client.searchCode(fullQuery, page, DEFAULT_PAGE_SIZE);
        return { result };
      } catch (err2) {
        const rl2 = asRateLimited(err2);
        return {
          error: err2 as Error,
          throttled: rl2 !== null,
        };
      }
    }
  }

  for (const q of opts.queries) {
    const fullQuery = buildExcludedQuery(q, opts.excludeOrg ?? [], opts.excludeRepo ?? []);
    let page = 1;
    let totalForQuery = 0;
    let newForQuery = 0;
    let truncated = false;
    let queryError: string | undefined;
    let queryThrottled = false;

    while (page <= maxPages && totalForQuery < cap) {
      const fetched = await fetchPageWithRetry(fullQuery, page);
      if ("error" in fetched) {
        queryError = fetched.error.message;
        queryThrottled = fetched.throttled;
        break;
      }
      const res = fetched.result;

      for (const item of res.items) {
        const repo = item.repository?.full_name ?? "<unknown>";
        const path = item.path ?? item.name ?? "<unknown>";
        const url = item.html_url ?? "";
        const fragment = item.text_matches?.[0]?.fragment;
        const line: number | null = null;

        const key = hitKey(q.query, repo, path, line);
        if (updatedState.seen[key]) continue;
        // Schema v2: record the date this hit was first seen, so that
        // `pruneSeenOlderThan` can TTL old entries. v1-upgraded entries
        // remain `true` (unknown date) and are kept conservatively.
        updatedState.seen[key] = seenIsoForNewEntries;

        const hit: CodeSearchHit = {
          query: q.name,
          repo,
          path,
          line,
          url,
          ...(reveal && fragment ? { snippet: fragment } : {}),
        };
        newHits.push(hit);
        newForQuery++;
        totalForQuery++;
        if (totalForQuery >= cap) {
          truncated = true;
          break;
        }
      }

      if (totalForQuery >= res.total_count) break;
      if (res.items.length === 0) break;
      if (totalForQuery >= cap) {
        truncated = true;
        break;
      }
      page++;
      if (page <= maxPages && totalForQuery < cap) {
        await sleep(interSleep);
      }
    }

    if (totalForQuery >= cap) truncated = true;
    if (page > maxPages) truncated = true;

    queriesStatus.push({
      name: q.name,
      ok: queryError === undefined,
      ...(queryError !== undefined ? { error: queryError } : {}),
      ...(queryThrottled ? { throttled: true } : {}),
      totalResults: totalForQuery,
      newResults: newForQuery,
      truncated,
    });
  }

  const endedIso = nowFn().toISOString();
  updatedState.lastRunIso = endedIso;

  const degraded = queriesStatus.some(q => !q.ok);

  return {
    hits: newHits,
    summary: {
      queries: queriesStatus,
      totalNew: newHits.length,
      totalSeen: Object.keys(updatedState.seen).length,
      startedIso,
      endedIso,
      previousRunIso,
      degraded,
    },
    updatedState,
  };
}
