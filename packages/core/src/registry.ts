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
  RegistrySchemaTooNewError,
} from "./exceptions.js";
import {
  registryFileSchema,
  formatZodError,
  personalOrgName,
  IDENTITY_NAME_REGEX,
  type IdentityDefinition,
} from "./schemas.js";

/** A resolved GitHub identity: its registry name plus its kind-specific fields. */
export type Identity = IdentityDefinition & { readonly name: string };

/** The identities that apply to one owner: the `person` column and the `agent` column. */
export interface OwnerIdentities {
  readonly person?: Identity;
  readonly agent?: Identity;
}

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
  /** Identity names (schemaVersion 3) for every org in `githubOrgs`. */
  person?: string;
  agent?: string;
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
   * Exact `owner/repo` upstreams registered for rule h (issue #151, D6):
   * PR/issue/comment verbs only, never the owner as a whole. Always
   * populated by `loadRegistry` (`[]` when absent).
   */
  allowedUpstreams?: string[];
  /**
   * Extra registry hosts the egress-hygiene check treats as public, on top of
   * the built-in defaults. Lower-cased by `loadRegistry` so callers can
   * compare directly against `URL.host`. Optional in the type so fixtures
   * need not specify it; `loadRegistry` always populates it (`[]` when absent).
   */
  publicRegistries?: string[];
  /**
   * Private-infrastructure marker patterns, blocked only in public-facing
   * repos. See the schema for why these are neither `alwaysBlock` nor
   * engagement-scoped. Always populated by `loadRegistry` (`[]` when absent).
   */
  privateInfra?: string[];
  /**
   * Operator-identity marker patterns, blocked only in `customer-coupled`
   * repos (and, via the egress guard, at `customer-coupled` destinations).
   * The mirror of {@link Registry.privateInfra}; see the schema for why the
   * two gates point in opposite directions. Always populated by
   * `loadRegistry` (`[]` when absent).
   */
  selfIdentity?: string[];
  /**
   * Path globs inside which the `_always` marker class is not enforced.
   * Engagement markers and `_private_infra` are never exempted — see the
   * schema comment for why that asymmetry is load-bearing.
   *
   * Unlike every other optional list on this interface, this one is NOT
   * defaulted to `[]` by `loadRegistry`: absent means "use the built-in
   * default list", `[]` means "exempt nothing", and collapsing the two would
   * silently turn an explicit opt-out into the default set (or vice versa).
   * {@link computeDenySet} resolves the distinction.
   */
  alwaysBlockExemptPaths?: string[];
  /**
   * Schema version of the on-disk registry. Defaults to 1 when the YAML has
   * no `schemaVersion:` field (legacy). Readers refuse versions
   * greater than {@link MAX_SUPPORTED_REGISTRY_SCHEMA_VERSION}. Optional in
   * the type so callers constructing Registry literals (tests, fixtures)
   * don't have to specify; loadRegistry always populates it.
   */
  schemaVersion?: number;
  /**
   * The registry's `identities` by name (schemaVersion 3). Always populated by
   * `loadRegistry` (empty when absent). Nothing chooses or injects a token from
   * them yet.
   */
  identities?: ReadonlyMap<string, Identity>;
  /**
   * Identities per owner, keyed by the LOWER-CASED owner (a `personalOrgs`
   * object entry's name, or each of a mapped engagement's `githubOrgs`).
   * Owners with no identity are absent. Separate from {@link Registry.personalOrgs}
   * (which stays a list of names) so no existing consumer changes shape.
   */
  identityMap?: ReadonlyMap<string, OwnerIdentities>;
  /** Set by the first `set-identity`: an agent write to an owner with no identity entry is refused (§12.2 Q4). */
  requireIdentity?: boolean;
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
 * - v3 (owner identities): adds `identities`, object-form `personalOrgs`
 *   entries, an engagement's `person`/`agent`, and `requireIdentity`. Written
 *   only when the first identity is set; an older build refuses it by version.
 *
 * Reader policy:
 *   - missing field => treat as version 1 (legacy);
 *   - version <= MAX => accept (unknown sibling fields are ignored);
 *   - version  > MAX => refuse with "upgrade required".
 * Writers must never lower the version.
 */
export const MAX_SUPPORTED_REGISTRY_SCHEMA_VERSION = 3;

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
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    throw new RegistryParseError(path, err);
  }
  return parseRegistryText(text, path);
}

/** What {@link loadRegistryState} found. The `state` strings are {@link RegistryState}'s. */
export type RegistryLoad =
  | { state: "loaded"; registry: Registry }
  | { state: "missing" }
  | { state: "encrypted" }
  | { state: "unparseable" }
  | { state: "newer-schema"; found: number; max: number };

/**
 * {@link loadRegistry} that never throws: the one place the failure modes are
 * told apart, so callers stop re-deriving the state from exceptions.
 * NotFound is `missing`, Encrypted is `encrypted`, SchemaTooNew is
 * `newer-schema`, and ANY other throw is `unparseable` (fail closed: an error
 * this function does not recognise must never read as "no registry").
 */
export function loadRegistryState(
  path: string = registryPath(),
  /** Test seam: the loader whose throws are classified. */
  load: (path: string) => Registry = loadRegistry,
): RegistryLoad {
  try {
    return { state: "loaded", registry: load(path) };
  } catch (err) {
    if (err instanceof RegistryNotFoundError) return { state: "missing" };
    if (err instanceof RegistryEncryptedError) return { state: "encrypted" };
    if (err instanceof RegistrySchemaTooNewError) return { state: "newer-schema", found: err.found, max: err.max };
    return { state: "unparseable" };
  }
}

/**
 * Parse and validate registry text exactly as `loadRegistry` does (YAML,
 * schema, schemaVersion policy), without touching the filesystem. Mutators use
 * it to prove a candidate document is a valid registry BEFORE writing it, so a
 * failed edit never leaves an unreadable registry behind. `path` only labels
 * errors; callers that must not echo registry contents (zod messages can name
 * orgs and engagement ids) must not print the error's message.
 */
export function parseRegistryText(text: string, path: string = "<in-memory>"): Registry {
  let parsed: unknown;
  try {
    parsed = parse(text);
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

  // Identity names are checked on the RAW keys: zod's record parsing never sees a `__proto__` key (it is
  // dropped), so a name that fails the shape would otherwise pass unnoticed.
  const rawIdentities = (parsed as Record<string, unknown>)["identities"];
  if (rawIdentities !== null && typeof rawIdentities === "object" && !Array.isArray(rawIdentities)) {
    for (const key of Object.keys(rawIdentities)) {
      if (!IDENTITY_NAME_REGEX.test(key)) {
        throw new RegistryParseError(
          path,
          new Error(
            `identities.${key}: identity name must match ^[a-z0-9][a-z0-9-]{0,62}$ (lowercase, digits, hyphens; no leading hyphen)`,
          ),
        );
      }
    }
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
    throw new RegistrySchemaTooNewError(path, schemaVersion, MAX_SUPPORTED_REGISTRY_SCHEMA_VERSION);
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
    ...(e.person !== undefined && { person: e.person }),
    ...(e.agent !== undefined && { agent: e.agent }),
  }));

  const identities = new Map<string, Identity>(
    Object.entries(validated.identities ?? {}).map(([name, def]) => [name, { ...def, name }]),
  );
  const identityMap = new Map<string, OwnerIdentities>();
  const mapOwner = (owner: string, personName: string | undefined, agentName: string | undefined): void => {
    const person = personName === undefined ? undefined : identities.get(personName);
    const agent = agentName === undefined ? undefined : identities.get(agentName);
    if (person === undefined && agent === undefined) return;
    identityMap.set(owner.toLowerCase(), {
      ...(person !== undefined && { person }),
      ...(agent !== undefined && { agent }),
    });
  };
  for (const entry of validated.personalOrgs ?? []) {
    if (typeof entry !== "string") mapOwner(entry.name, entry.person, entry.agent);
  }
  for (const e of validated.engagements) {
    for (const org of e.githubOrgs ?? []) mapOwner(org, e.person, e.agent);
  }

  return {
    engagements,
    alwaysBlock: validated.always_block ?? [],
    personalOrgs: (validated.personalOrgs ?? []).map(personalOrgName),
    allowedUpstreams: validated.allowedUpstreams ?? [],
    // Lower-cased at the boundary: `URL.host` is always lower-case, and
    // `isHostAllowed` compares by exact equality.
    publicRegistries: (validated.publicRegistries ?? []).map(h => h.toLowerCase()),
    privateInfra: validated.privateInfra ?? [],
    selfIdentity: validated.selfIdentity ?? [],
    // Conditional spread, not `?? []`: the absent/empty distinction decides
    // between "built-in default exemptions" and "no exemptions at all".
    ...(validated.alwaysBlockExemptPaths !== undefined && {
      alwaysBlockExemptPaths: validated.alwaysBlockExemptPaths,
    }),
    schemaVersion,
    identities,
    identityMap,
    requireIdentity: validated.requireIdentity ?? false,
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
