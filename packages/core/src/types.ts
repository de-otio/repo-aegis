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
 *
 * `engagements` is **deliberately a list of bare ids** (`string[]`), not
 * a list of {@link EngagementJson}. RepoJson describes the per-repo
 * configured membership recorded by `git config --get-all
 * repo-aegis.engagement` — it is the *reference set*, not a hydrated view
 * of registry state. Resolving an id to its registry entry (name, active
 * flag) is the consumer's responsibility, and the canonical hydrated
 * shape is {@link EngagementJson}, which appears as a sibling field on
 * commands that perform that resolution (allow, deny, status). The two
 * are intentionally distinct and must not be conflated.
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
 * full {@link Engagement} bodies (with markers) are never emitted to JSON
 * outputs that flow through hook context.
 *
 * Relationship to {@link RepoJson}: `RepoJson.engagements` is `string[]`
 * (the per-repo membership of bare ids); commands that hydrate those ids
 * against the registry (e.g. `allow`, `deny`, `status`) emit a separate
 * sibling field of type `EngagementJson` (or `EngagementJson[]`) with the
 * resolved name + active flag. The shapes are not interchangeable.
 */
export interface EngagementJson {
  id: string;
  name: string;
  active: boolean;
}
