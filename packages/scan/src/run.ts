import type {
  CodeSearchHit,
  QueryEntry,
  QueryRunStatus,
  RunSummary,
  ScanState,
} from "./types.js";
import { hitKey } from "./state.js";

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
}

export interface RunResult {
  hits: CodeSearchHit[];
  summary: RunSummary;
  updatedState: ScanState;
}

const DEFAULT_PAGE_SIZE = 100;

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

export async function runScan(opts: RunOptions): Promise<RunResult> {
  const interSleep = opts.interRequestSleepMs ?? 2500;
  const maxPages = opts.maxPagesPerQuery ?? 10;
  const cap = opts.capResultsPerQuery ?? 1000;
  const sleep = opts.sleep ?? defaultSleep;
  const reveal = !!opts.revealMatches;

  const startedIso = new Date().toISOString();
  const previousRunIso = opts.state.lastRunIso ?? null;
  const queriesStatus: QueryRunStatus[] = [];
  const newHits: CodeSearchHit[] = [];

  const updatedState: ScanState = {
    schemaVersion: opts.state.schemaVersion,
    seen: { ...opts.state.seen },
    lastRunIso: opts.state.lastRunIso,
  };

  for (const q of opts.queries) {
    const fullQuery = buildExcludedQuery(q, opts.excludeOrg ?? [], opts.excludeRepo ?? []);
    let page = 1;
    let totalForQuery = 0;
    let newForQuery = 0;
    let truncated = false;
    let queryError: string | undefined;

    while (page <= maxPages && totalForQuery < cap) {
      let res: SearchClientResult;
      try {
        res = await opts.client.searchCode(fullQuery, page, DEFAULT_PAGE_SIZE);
      } catch (err) {
        queryError = (err as Error).message;
        break;
      }

      for (const item of res.items) {
        const repo = item.repository?.full_name ?? "<unknown>";
        const path = item.path ?? item.name ?? "<unknown>";
        const url = item.html_url ?? "";
        const fragment = item.text_matches?.[0]?.fragment;
        const line: number | null = null;

        const key = hitKey(q.query, repo, path, line);
        if (updatedState.seen[key]) continue;
        updatedState.seen[key] = true;

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
      totalResults: totalForQuery,
      newResults: newForQuery,
      truncated,
    });
  }

  const endedIso = new Date().toISOString();
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
