// Central type re-export. Every module in core defines its own types, but
// downstream consumers (cli, scan) should import from `@de-otio/repo-aegis-core`
// (which re-exports everything via index.ts). This file just makes sure the
// canonical TypeScript types are aggregated in one place for ease of review.

export type { Engagement, Registry, ResolveResult } from "./registry.js";
export type { RepoClass, RepoConfig } from "./repo.js";
export type { DenySet, DenySetFile, DenySetOptions } from "./deny-set.js";
export type { ScanHit, SkippedFile, ScanOptions } from "./scan.js";
export type { RenderOptions, RenderedFile, RenderResult } from "./render.js";
export type { PatternValidationResult } from "./regex-safety.js";
export type { RedactionMode } from "./redaction.js";

/**
 * Canonical JSON shape for a repo across every CLI subcommand's output.
 * Consumers of repo-aegis (other tools, AI agents) parse this once and
 * reuse across allow/deny/status/check.
 */
export interface RepoJson {
  cwd: string;
  isGitRepo: boolean;
  class: import("./repo.js").RepoClass;
  classExplicit: boolean;
  engagements: string[];
}

/**
 * Canonical JSON shape for an engagement reference in CLI output.
 * Includes only the fields needed to identify and act on the engagement;
 * full Engagement bodies (with markers) are never emitted to JSON outputs
 * that flow through hook context.
 */
export interface EngagementJson {
  id: string;
  name: string;
  active: boolean;
}
