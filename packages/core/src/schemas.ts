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

/**
 * Allowed shape for a GitHub org name, used in `personalOrgs` and
 * `engagements[*].githubOrgs`. Mirrors GitHub's own org-name constraint:
 * lowercase alphanumerics and hyphens, starting with an alphanumeric.
 *
 * Schema rejects uppercase. Callers writing into the registry (e.g.
 * `engagements add --github-org`) must lowercase input before persisting;
 * the gate-time read path trusts the schema (no runtime case-folding).
 */
export const ORG_NAME_REGEX = /^[a-z0-9][a-z0-9-]*$/;

const orgNameSchema = z
  .string()
  .min(1, "org name must be non-empty")
  .regex(ORG_NAME_REGEX, {
    message:
      "org name must be lowercase, start with [a-z0-9], and contain only [a-z0-9-]",
  });

/**
 * A bare package-registry host, as it would appear in `URL.host` — optionally
 * with a port, never with a scheme, path, credentials, or wildcard.
 *
 * Matching in `isHostAllowed` is exact string equality against `URL.host`, so
 * anything richer than a host silently never matches. Rejecting those shapes
 * at parse time turns a silently-inert allowlist entry into a loud config
 * error. Validation round-trips through the WHATWG URL parser so it agrees
 * with the host extraction in `egress.ts` by construction; `*` is rejected
 * separately because the URL parser accepts it as an ordinary host character.
 */
const registryHostSchema = z
  .string()
  .min(1, "registry host must be non-empty")
  .refine(
    v => {
      if (/\s/.test(v) || v.includes("*")) return false;
      try {
        const u = new URL(`https://${v}`);
        return u.host === v.toLowerCase() && u.username === "" && u.password === "";
      } catch {
        return false;
      }
    },
    {
      message:
        "must be a bare host such as 'registry.example.com' (optionally ':port') — " +
        "no scheme, path, credentials, or '*' wildcard",
    },
  );

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
    /**
     * GitHub orgs that map to this engagement. Phase 1 of the zero-config
     * onboarding work: a repo whose origin's org appears here is auto-
     * classified as `customer-coupled` with this engagement attached.
     * Schema-level constraints: each entry must match {@link ORG_NAME_REGEX};
     * cross-engagement uniqueness and disjointness with `personalOrgs` are
     * enforced by the registry-level superRefine.
     */
    githubOrgs: z.array(orgNameSchema).optional(),
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
    /**
     * Top-level orgs the user owns / treats as public. A repo whose
     * origin's org is here is auto-classified as `public-eligible`.
     * Disjoint from any engagement's `githubOrgs`.
     */
    personalOrgs: z.array(orgNameSchema).optional(),
    /**
     * Extra package-registry hosts treated as public by the egress-hygiene
     * check, in ADDITION to the always-allowed defaults (npmjs, yarnpkg,
     * `*.github.com`). For a team that runs a legitimate public mirror.
     *
     * Org-wide, so it lives here rather than in a per-repo
     * `.repo-aegis.yml`: "our org runs this mirror" is a machine-level
     * fact, and a per-repo file could otherwise allow a private host into
     * a public repo — exactly the leak this check exists to stop.
     */
    publicRegistries: z.array(registryHostSchema).optional(),
    engagements: z.array(engagementSchema, { message: "'engagements' must be a list" }),
  })
  .passthrough()
  // Cross-field validation: org names must be unique across the
  // (personalOrgs ∪ Σ engagements[*].githubOrgs) union, and within
  // personalOrgs itself. Same-string overlap is a fail-closed parse error.
  .superRefine((data, ctx) => {
    const personalOrgs = data.personalOrgs ?? [];
    // 1. personalOrgs internal duplicates.
    const personalSeen = new Map<string, number>();
    for (let i = 0; i < personalOrgs.length; i++) {
      const org = personalOrgs[i];
      if (org === undefined) continue;
      const prev = personalSeen.get(org);
      if (prev !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["personalOrgs", i],
          message: `duplicate org "${org}" (also at personalOrgs[${prev}])`,
        });
      } else {
        personalSeen.set(org, i);
      }
    }
    const personalSet = new Set(personalOrgs);
    // 2. cross-engagement uniqueness + disjointness with personalOrgs.
    const orgToEng = new Map<
      string,
      { engIdx: number; engId: string; orgIdx: number }
    >();
    for (let i = 0; i < data.engagements.length; i++) {
      const eng = data.engagements[i];
      if (eng === undefined) continue;
      const orgs = eng.githubOrgs ?? [];
      for (let j = 0; j < orgs.length; j++) {
        const org = orgs[j];
        if (org === undefined) continue;
        if (personalSet.has(org)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["engagements", i, "githubOrgs", j],
            message:
              `org "${org}" appears in personalOrgs and ` +
              `engagements[${i}=${eng.id}].githubOrgs; ` +
              `the two are mutually exclusive`,
          });
        }
        const prev = orgToEng.get(org);
        if (prev !== undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["engagements", i, "githubOrgs", j],
            message:
              `org "${org}" is also in ` +
              `engagements[${prev.engIdx}=${prev.engId}].githubOrgs; ` +
              `an org maps to at most one engagement`,
          });
        } else {
          orgToEng.set(org, { engIdx: i, engId: eng.id, orgIdx: j });
        }
      }
    }
  });

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
