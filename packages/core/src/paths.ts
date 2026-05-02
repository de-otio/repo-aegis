import { homedir } from "node:os";
import { join } from "node:path";

export function repoAegisHome(): string {
  return process.env["REPO_AEGIS_HOME"] ?? join(homedir(), ".config", "repo-aegis");
}

export function registryPath(home: string = repoAegisHome()): string {
  return process.env["REPO_AEGIS_REGISTRY"] ?? join(home, "engagements.yaml");
}

export function markersDir(home: string = repoAegisHome()): string {
  return process.env["REPO_AEGIS_MARKERS_DIR"] ?? join(home, "markers");
}

export function flatMarkersPath(home: string = repoAegisHome()): string {
  return join(home, "markers.txt");
}

export function statePath(home: string = repoAegisHome()): string {
  return join(home, "state");
}

export function leakContextFlagPath(home: string = repoAegisHome()): string {
  return join(statePath(home), "leak-context-mode");
}

export function lockFilePath(home: string = repoAegisHome()): string {
  return join(statePath(home), ".lock");
}

export function denySetCachePath(home: string = repoAegisHome()): string {
  return join(statePath(home), "deny-set.cache.json");
}

/**
 * True if `REPO_AEGIS_HOME` is set in the environment, indicating the user
 * (or a parent process) has overridden the default home. CLI uses this to
 * print a stderr warning that the override is in effect.
 */
export function isHomeOverridden(): boolean {
  return process.env["REPO_AEGIS_HOME"] !== undefined;
}
