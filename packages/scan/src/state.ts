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

export function loadState(path: string): ScanState {
  if (!existsSync(path)) return { seen: {} };
  const raw = readFileSync(path, "utf8");
  if (raw.trim() === "") return { seen: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`failed to parse state file ${path}: ${(err as Error).message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`state file ${path} must be a JSON object`);
  }
  const root = parsed as { seen?: unknown; lastRunIso?: unknown };
  const seen: Record<string, true> = {};
  if (root.seen && typeof root.seen === "object") {
    for (const k of Object.keys(root.seen)) seen[k] = true;
  }
  return {
    seen,
    lastRunIso: typeof root.lastRunIso === "string" ? root.lastRunIso : undefined,
  };
}

export function saveStateAtomic(path: string, state: ScanState): void {
  const tmp = path + ".tmp";
  const fd = openSync(tmp, "w", 0o600);
  try {
    const body = JSON.stringify(state, null, 2) + "\n";
    writeSync(fd, body);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

export function hitKey(query: string, repo: string, path: string, line: number | null): string {
  return [query, repo, path, line === null ? "" : String(line)].join("|");
}
