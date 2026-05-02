// Local mirror of the JSON shapes emitted by repo-aegis CLI commands the
// extension consumes. We import the canonical types from the core
// package so we stay in sync with the contract; this file just narrows
// to the command-output shapes the CLI produces (which are not all
// exported from core directly).
//
// If a future core release re-exports these we'll switch over.

import type { RepoJson, ScanHit, SkippedFile } from "@de-otio/repo-aegis-core";

export type { RepoJson, ScanHit, SkippedFile };

export interface CheckJson {
  mode: "staged" | "path" | "range" | "history";
  hits: ScanHit[];
  skipped: SkippedFile[];
  repo: RepoJson;
  denySet: { files: string[]; patternCount: number };
  advisory: boolean;
  warnings: string[];
}

export interface StatusJson {
  repo: RepoJson;
  allowedEngagements: { id: string; name: string; active: boolean }[];
  denySet: { files: string[]; patternCount: number };
  alwaysBlock: { patternCount: number };
  warnings: string[];
}

export interface MarkersTestJson {
  action: "markers-test";
  // `input` is redacted by default. We do NOT pass --verbose from the
  // extension, so this should always be a redacted preview.
  input: string;
  hits: { fileStem: string; index: number; preview?: string }[];
  repo: { class: string; engagements: string[] };
  warnings: string[];
}
