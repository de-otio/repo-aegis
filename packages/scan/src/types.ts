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

export interface ScanState {
  schemaVersion?: number;
  seen: Record<string, true>;
  lastRunIso?: string;
}

export interface QueryRunStatus {
  name: string;
  ok: boolean;
  error?: string;
  totalResults: number;
  newResults: number;
  truncated: boolean;
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
