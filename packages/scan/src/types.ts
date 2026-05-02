export interface QueryEntry {
  name: string;
  query: string;
  excludeOrg?: string[];
  excludeRepo?: string[];
}

export interface QueryFile {
  queries: QueryEntry[];
}

export interface CodeSearchHit {
  query: string;
  repo: string;
  path: string;
  line: number | null;
  url: string;
  snippet?: string;
}

/**
 * `seen` map. Schema v1 entries are `true` (no known first-seen date).
 * Schema v2 entries are an ISO-8601 date string `YYYY-MM-DD` capturing the
 * day the hit was first recorded. The two coexist: v1 entries upgraded
 * forward retain `true` (we don't know when they were first seen, so
 * conservative TTL pruning leaves them in place).
 */
export interface ScanState {
  schemaVersion?: number;
  seen: Record<string, true | string>;
  lastRunIso?: string;
}

export interface QueryRunStatus {
  name: string;
  ok: boolean;
  error?: string;
  totalResults: number;
  newResults: number;
  truncated: boolean;
  /**
   * True when the query hit a GitHub secondary-rate-limit (429 / 403 with
   * Retry-After) that the in-process retry could not recover from.
   * The query is reported as failed (`ok: false`) AND `throttled: true`
   * so operators can distinguish "GitHub asked us to back off" from
   * other failure shapes.
   */
  throttled?: boolean;
}

export interface RunSummary {
  queries: QueryRunStatus[];
  totalNew: number;
  totalSeen: number;
  startedIso: string;
  endedIso: string;
  /**
   * ISO of the previous successful run, or null if this is the first run.
   * Optional in the type to keep old test fixtures compiling, but
   * `runScan` always populates this field.
   */
  previousRunIso?: string | null;
  /**
   * True when at least one query failed (but not necessarily all).
   * Optional in the type to keep old test fixtures compiling, but
   * `runScan` always populates this field.
   */
  degraded?: boolean;
}
