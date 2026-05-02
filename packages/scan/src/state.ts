import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
} from "node:fs";
import type { ScanState } from "./types.js";

export const CURRENT_STATE_SCHEMA_VERSION = 1;
export const MAX_SUPPORTED_STATE_SCHEMA_VERSION = 1;

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
  const seen: Record<string, true> = {};
  if (root.seen && typeof root.seen === "object") {
    for (const k of Object.keys(root.seen)) seen[k] = true;
  }
  return {
    schemaVersion,
    seen,
    lastRunIso: typeof root.lastRunIso === "string" ? root.lastRunIso : undefined,
  };
}

export function saveStateAtomic(path: string, state: ScanState): void {
  const tmp = path + ".tmp";
  const fd = openSync(tmp, "w", 0o600);
  try {
    const toWrite: ScanState = {
      ...state,
      schemaVersion: CURRENT_STATE_SCHEMA_VERSION,
    };
    const body = JSON.stringify(toWrite, null, 2) + "\n";
    writeSync(fd, body);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

// hitKey is prefixed with "v1|" so a future hitKey-format change can detect
// old keys (no v1| prefix, or different version prefix) and skip them rather
// than re-fire previously-seen hits as new.
export function hitKey(query: string, repo: string, path: string, line: number | null): string {
  return ["v1", query, repo, path, line === null ? "" : String(line)].join("|");
}
