// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
// Single source of truth for on-disk schema definitions.
//
// All YAML configuration files repo-aegis reads at runtime — the
// engagement registry, the per-repo `.repo-aegis.yml` override, the
// classify rules file, the scanner queries file — flow through one of
// the schemas below. The `parse-and-narrow` helpers wrap zod's parse
// with the canonical CLI error type (RegistryParseError /
// RepoOverrideError / ad-hoc) so callers don't have to translate
// ZodError shape themselves.
//
// Why centralise here: previously each callsite hand-rolled a series of
// `typeof obj.foo !== "string"` checks. Adding a field meant editing
// the parser, the type, and the validator separately and hoping they
// stayed in sync. With zod, the schema *is* the type *is* the
// validator.

import { z } from "zod";

/**
 * Format a ZodError into the multi-line "human-readable" string we used
 * to build by hand in the per-callsite validators. The output preserves
 * the substrings that existing tests pin on (e.g. "must be", "missing",
 * "reserved").
 *
 * For deeply nested issues we render `engagements[3].markers: ...`
 * style paths — matches what the previous bespoke loops emitted.
 */
export function formatZodError(err: z.ZodError, kind: string): string {
  const lines: string[] = [];
  for (const issue of err.issues) {
    const path = issue.path
      .map((seg, i) => {
        if (typeof seg === "number") return `[${seg}]`;
        return i === 0 ? String(seg) : `.${String(seg)}`;
      })
      .join("");
    const where = path === "" ? kind : path;
    lines.push(`${where}: ${issue.message}`);
  }
  return lines.length === 1 ? lines[0]! : lines.join("; ");
}

// ---------------------------------------------------------------------------
// Engagement registry (~/.config/repo-aegis/engagements.yaml)
// ---------------------------------------------------------------------------

const ALWAYS_BLOCK_RESERVED_ID_LITERAL = "_always" as const;

const engagementSchema = z
  .object({
    id: z
      .string()
      .min(1, "missing or empty 'id'")
      .refine(v => v !== ALWAYS_BLOCK_RESERVED_ID_LITERAL, {
        message:
          `engagement id "${ALWAYS_BLOCK_RESERVED_ID_LITERAL}" is reserved; ` +
          `use the top-level 'always_block:' field for org-wide markers`,
      }),
    name: z.string({ message: "missing string 'name'" }),
    started: z.string().nullable().optional(),
    ended: z.string().nullable().optional(),
    reposActive: z.array(z.string()).optional(),
    markers: z.array(z.string(), { message: "missing 'markers' list" }),
    notes: z.string().optional(),
  })
  .passthrough(); // Forward-compat: unknown sibling fields are kept, not rejected.

export const registryFileSchema = z
  .object({
    schemaVersion: z
      .number({ message: "'schemaVersion' must be a number" })
      .optional(),
    always_block: z
      .array(z.string({ message: "'always_block' entries must be strings" }), {
        message: "'always_block' must be a list of patterns",
      })
      .optional(),
    engagements: z.array(engagementSchema, { message: "'engagements' must be a list" }),
  })
  .passthrough();

export type RegistryFile = z.infer<typeof registryFileSchema>;

// ---------------------------------------------------------------------------
// Per-repo override (.repo-aegis.yml)
// ---------------------------------------------------------------------------

export const REPO_CLASSES = [
  "public-eligible",
  "private-strict",
  "customer-coupled",
  "scratch",
] as const;
export type RepoClassLiteral = (typeof REPO_CLASSES)[number];

export const repoOverrideSchema = z
  .object({
    class: z.enum(REPO_CLASSES).optional(),
    engagements: z
      .array(z.string().min(1, "'engagements' entries must be non-empty strings"))
      .optional(),
  })
  .passthrough();

export type RepoOverrideFile = z.infer<typeof repoOverrideSchema>;

// Note: schemas for files only loaded by `cli` (classify rules) or
// `scan` (query files) live in those packages, not here. They use the
// shared `formatZodError` helper exported above for consistent error
// rendering, but the schemas themselves are package-private — moving
// them here would inflate core's public surface for no gain.
