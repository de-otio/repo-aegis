import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import type { ScanState } from "./types.js";

export const CURRENT_STATE_SCHEMA_VERSION = 2;
export const MAX_SUPPORTED_STATE_SCHEMA_VERSION = 2;

export function loadState(path: string): ScanState {
  if (!existsSync(path)) return { schemaVersion: CURRENT_STATE_SCHEMA_VERSION, seen: {} };
  const raw = readFileSync(path, "utf8");
  if (raw.trim() === "") return { schemaVersion: CURRENT_STATE_SCHEMA_VERSION, seen: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`failed to parse state file ${path}: ${(err as Error).message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`state file ${path} must be a JSON object`);
  }
  const root = parsed as { schemaVersion?: unknown; seen?: unknown; lastRunIso?: unknown };
  // Legacy files without schemaVersion are treated as v1.
  const schemaVersion =
    typeof root.schemaVersion === "number" ? root.schemaVersion : 1;
  if (schemaVersion > MAX_SUPPORTED_STATE_SCHEMA_VERSION) {
    throw new Error(
      `state file ${path} has schemaVersion ${schemaVersion} but this binary only supports up to ${MAX_SUPPORTED_STATE_SCHEMA_VERSION}; upgrade repo-aegis-scan`,
    );
  }
  const seen: Record<string, true | string> = {};
  if (root.seen && typeof root.seen === "object") {
    const seenSrc = root.seen as Record<string, unknown>;
    for (const k of Object.keys(seenSrc)) {
      const v = seenSrc[k];
      if (typeof v === "string") {
        // v2-shape entry: ISO date.
        seen[k] = v;
      } else {
        // v1-shape entry (true) — or any other truthy legacy value.
        // Upgrading to v2 preserves these as `true` (unknown first-seen
        // date); TTL prune keeps them conservatively.
        seen[k] = true;
      }
    }
  }
  return {
    schemaVersion,
    seen,
    lastRunIso: typeof root.lastRunIso === "string" ? root.lastRunIso : undefined,
  };
}

export function saveStateAtomic(path: string, state: ScanState): void {
  const tmp = path + ".tmp";
  let fd: number;
  try {
    fd = openSync(tmp, "w", 0o600);
  } catch (err) {
    // Open itself failed; nothing to clean up.
    throw err;
  }
  let writeOk = false;
  try {
    const toWrite: ScanState = {
      ...state,
      schemaVersion: CURRENT_STATE_SCHEMA_VERSION,
    };
    const body = JSON.stringify(toWrite, null, 2) + "\n";
    writeSync(fd, body);
    fsyncSync(fd);
    writeOk = true;
  } finally {
    closeSync(fd);
    if (!writeOk) {
      try {
        unlinkSync(tmp);
      } catch {
        // best-effort cleanup
      }
    }
  }
  renameSync(tmp, path);
}

// hitKey is prefixed with "v1|" so a future hitKey-format change can detect
// old keys (no v1| prefix, or different version prefix) and skip them rather
// than re-fire previously-seen hits as new.
export function hitKey(query: string, repo: string, path: string, line: number | null): string {
  return ["v1", query, repo, path, line === null ? "" : String(line)].join("|");
}

/**
 * Returns today's date as an ISO-8601 calendar date (YYYY-MM-DD), in UTC.
 * Used as the value for new `seen` entries under schema v2.
 *
 * @internal Implementation detail of `runScan`'s state-stamping. Not part
 * of the supported public API surface re-exported from `lib.ts`.
 */
export function todayIsoDate(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Returns a new ScanState with `seen` entries older than `olderThanDays` days
 * (relative to `now`) dropped. Entries whose value is `true` (unknown
 * first-seen date — typically v1-upgraded entries) are kept conservatively:
 * we cannot know when they were first seen, so we cannot safely TTL them.
 *
 * Returns the same state shape (no version bump). `olderThanDays` must be a
 * non-negative integer; values <= 0 prune everything dated, which is rarely
 * what the operator wants but is a no-op for unknown-date entries.
 *
 * @internal Currently driven only by `repo-aegis-scan run --prune-state-older-than`.
 * Not part of the supported public API surface re-exported from `lib.ts`.
 */
export function pruneSeenOlderThan(
  state: ScanState,
  olderThanDays: number,
  now: Date = new Date(),
): { state: ScanState; pruned: number } {
  if (!Number.isFinite(olderThanDays) || olderThanDays < 0) {
    throw new Error(`pruneSeenOlderThan: olderThanDays must be a non-negative number (got ${olderThanDays})`);
  }
  const cutoffMs = now.getTime() - olderThanDays * 24 * 60 * 60 * 1000;
  const next: Record<string, true | string> = {};
  let pruned = 0;
  for (const [k, v] of Object.entries(state.seen)) {
    if (v === true) {
      // Unknown first-seen date — keep.
      next[k] = true;
      continue;
    }
    // v is an ISO date string. Parse as UTC midnight.
    const t = Date.parse(v);
    if (Number.isNaN(t)) {
      // Malformed date — keep conservatively rather than silently drop.
      next[k] = v;
      continue;
    }
    if (t >= cutoffMs) {
      next[k] = v;
    } else {
      pruned++;
    }
  }
  return {
    state: { ...state, seen: next },
    pruned,
  };
}
