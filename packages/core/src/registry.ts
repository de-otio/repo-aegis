// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
import { readFileSync, existsSync } from "node:fs";
import { parse } from "yaml";
import { z } from "zod";
import { registryPath } from "./paths.js";
import {
  RegistryNotFoundError,
  RegistryParseError,
  RegistryEncryptedError,
} from "./exceptions.js";
import { registryFileSchema, formatZodError } from "./schemas.js";

export interface Engagement {
  id: string;
  name: string;
  started?: string | null;
  ended?: string | null;
  reposActive?: string[];
  markers: string[];
  notes?: string;
  /**
   * GitHub orgs that map to this engagement (Phase 1, schemaVersion 2+).
   * A repo whose origin's org appears here is auto-classified
   * `customer-coupled` with this engagement. Lowercased, GitHub
   * org-name shape; cross-validated for uniqueness across all
   * engagements and disjointness with {@link Registry.personalOrgs}.
   */
  githubOrgs?: string[];
}

export interface Registry {
  engagements: Engagement[];
  alwaysBlock: string[];
  /**
   * GitHub orgs the user owns / treats as public (schemaVersion 2+).
   * A repo whose origin's org is in this list is auto-classified
   * `public-eligible`. Disjoint from any engagement's `githubOrgs`.
   * Optional in the type so callers constructing Registry literals
   * (tests, fixtures) don't have to specify; `loadRegistry` always
   * populates it (defaults to `[]` for v1 registries that don't
   * declare the field).
   */
  personalOrgs?: string[];
  /**
   * Extra registry hosts the egress-hygiene check treats as public, on top of
   * the built-in defaults. Lower-cased by `loadRegistry` so callers can
   * compare directly against `URL.host`. Optional in the type so fixtures
   * need not specify it; `loadRegistry` always populates it (`[]` when absent).
   */
  publicRegistries?: string[];
  /**
   * Schema version of the on-disk registry. Defaults to 1 when the YAML has
   * no `schemaVersion:` field (legacy). Readers refuse versions
   * greater than {@link MAX_SUPPORTED_REGISTRY_SCHEMA_VERSION}. Optional in
   * the type so callers constructing Registry literals (tests, fixtures)
   * don't have to specify; loadRegistry always populates it.
   */
  schemaVersion?: number;
}

export const ALWAYS_BLOCK_RESERVED_ID = "_always";

/**
 * Highest registry `schemaVersion` this build of repo-aegis can read.
 *
 * - v1 (legacy): no `schemaVersion`, no `personalOrgs`, no
 *   `engagements[*].githubOrgs`. Loaded with `personalOrgs: []` and every
 *   engagement's `githubOrgs` undefined.
 * - v2 (Phase 1 onboarding): adds `personalOrgs` and
 *   `engagements[*].githubOrgs` for org-keyed JIT classification.
 *
 * Reader policy:
 *   - missing field => treat as version 1 (legacy);
 *   - version <= MAX => accept (unknown sibling fields are ignored);
 *   - version  > MAX => refuse with "upgrade required".
 * Writers must never lower the version.
 */
export const MAX_SUPPORTED_REGISTRY_SCHEMA_VERSION = 2;

export function loadRegistry(path: string = registryPath()): Registry {
  // If the plaintext registry is absent but a sibling `<path>.age`
  // ciphertext exists, the registry is in its encrypted-at-rest state.
  // We deliberately do NOT auto-decrypt: the whole point of the
  // encryption is that the registry only goes plaintext when the user
  // explicitly opts in with `repo-aegis registry decrypt --identity
  // <path>`. Auto-decrypt would defeat the purpose.
  if (!existsSync(path)) {
    const ciphertextPath = `${path}.age`;
    if (existsSync(ciphertextPath)) {
      throw new RegistryEncryptedError(path, ciphertextPath);
    }
    throw new RegistryNotFoundError(path);
  }
  let parsed: unknown;
  try {
    parsed = parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new RegistryParseError(path, err);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new RegistryParseError(path, new Error("registry must be a YAML mapping"));
  }
  // The "missing 'engagements:'" failure used to be a separate check
  // ahead of structural validation. Surfacing it explicitly makes the
  // common-case error message punchier than zod's generic
  // "Required" — and several tests pin on this wording.
  if (!("engagements" in parsed)) {
    throw new RegistryParseError(path, new Error("missing 'engagements:' top-level key"));
  }

  let validated;
  try {
    validated = registryFileSchema.parse(parsed);
  } catch (err) {
    if (err instanceof z.ZodError) {
      throw new RegistryParseError(path, new Error(formatZodError(err, "registry")));
    }
    throw err;
  }

  // Schema-version gate (per design B14). Zod has accepted any number;
  // the policy decision (reject newer-than-supported with an upgrade
  // hint) is encoded here rather than as a refine() so the error
  // wording is exactly what the user-facing tests assert on.
  const schemaVersion = validated.schemaVersion ?? 1;
  if (schemaVersion > MAX_SUPPORTED_REGISTRY_SCHEMA_VERSION) {
    throw new RegistryParseError(
      path,
      new Error(
        `registry schemaVersion ${schemaVersion} is newer than this build supports ` +
          `(max ${MAX_SUPPORTED_REGISTRY_SCHEMA_VERSION}); ` +
          `registry written by a newer repo-aegis — please upgrade`,
      ),
    );
  }

  // Map zod's struct shape back to the domain types. The `passthrough()`
  // on the schema preserves unknown sibling fields, but those are not
  // part of the public Registry interface — drop them at the boundary.
  const engagements: Engagement[] = validated.engagements.map(e => ({
    id: e.id,
    name: e.name,
    ...(e.started !== undefined && { started: e.started }),
    ...(e.ended !== undefined && { ended: e.ended }),
    ...(e.reposActive !== undefined && { reposActive: e.reposActive }),
    markers: e.markers,
    ...(e.notes !== undefined && { notes: e.notes }),
    ...(e.githubOrgs !== undefined && { githubOrgs: e.githubOrgs }),
  }));

  return {
    engagements,
    alwaysBlock: validated.always_block ?? [],
    personalOrgs: validated.personalOrgs ?? [],
    // Lower-cased at the boundary: `URL.host` is always lower-case, and
    // `isHostAllowed` compares by exact equality.
    publicRegistries: (validated.publicRegistries ?? []).map(h => h.toLowerCase()),
    schemaVersion,
  };
}

export function isActive(e: Engagement, retentionMonths = 12): boolean {
  if (!e.ended) return true;
  const endedDate = new Date(e.ended);
  if (Number.isNaN(endedDate.getTime())) return true;
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - retentionMonths);
  return endedDate > cutoff;
}

export interface ResolveResult {
  match: Engagement | null;
  candidates: Engagement[];
}

export function resolveEngagement(reg: Registry, query: string): ResolveResult {
  const q = query.toLowerCase();
  const exactId = reg.engagements.find(e => e.id.toLowerCase() === q);
  if (exactId) return { match: exactId, candidates: [exactId] };
  const exactName = reg.engagements.find(e => e.name.toLowerCase() === q);
  if (exactName) return { match: exactName, candidates: [exactName] };
  const fuzzy = reg.engagements.filter(
    e => e.id.toLowerCase().includes(q) || e.name.toLowerCase().includes(q),
  );
  if (fuzzy.length === 1) return { match: fuzzy[0]!, candidates: fuzzy };
  return { match: null, candidates: fuzzy };
}
