import { readFileSync, existsSync } from "node:fs";
import { parse } from "yaml";
import { registryPath } from "./paths.js";
import {
  RegistryNotFoundError,
  RegistryParseError,
} from "./exceptions.js";

export interface Engagement {
  id: string;
  name: string;
  started?: string | null;
  ended?: string | null;
  reposActive?: string[];
  markers: string[];
  notes?: string;
}

export interface Registry {
  engagements: Engagement[];
  alwaysBlock: string[];
  /**
   * Schema version of the on-disk registry. Defaults to 1 when the YAML has
   * no `schemaVersion:` field (legacy / current). Readers refuse versions
   * greater than {@link MAX_SUPPORTED_REGISTRY_SCHEMA_VERSION}. Optional in
   * the type so callers constructing Registry literals (tests, fixtures)
   * don't have to specify; loadRegistry always populates it.
   */
  schemaVersion?: number;
}

export const ALWAYS_BLOCK_RESERVED_ID = "_always";

/**
 * Highest registry `schemaVersion` this build of repo-aegis can read. A
 * registry written by a newer repo-aegis with a higher version will be
 * rejected at load time with a `RegistryParseError` instructing the user
 * to upgrade. The reader-policy (per design B14) is:
 *   - missing field => treat as version 1 (legacy);
 *   - version <= MAX => accept (unknown sibling fields are ignored);
 *   - version  > MAX => refuse.
 * Writers must never lower the version.
 */
export const MAX_SUPPORTED_REGISTRY_SCHEMA_VERSION = 1;

export function loadRegistry(path: string = registryPath()): Registry {
  if (!existsSync(path)) {
    throw new RegistryNotFoundError(path);
  }
  let parsed: unknown;
  try {
    parsed = parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new RegistryParseError(path, err);
  }
  if (!parsed || typeof parsed !== "object") {
    throw new RegistryParseError(path, new Error("registry must be a YAML mapping"));
  }
  if (!("engagements" in parsed)) {
    throw new RegistryParseError(path, new Error("missing 'engagements:' top-level key"));
  }
  const root = parsed as {
    engagements: unknown;
    always_block?: unknown;
    schemaVersion?: unknown;
  };

  // Schema-version gate. Absent => 1 (legacy). Present-but-non-number =>
  // parse error. Higher than this build supports => "please upgrade".
  let schemaVersion = 1;
  if (root.schemaVersion !== undefined) {
    if (typeof root.schemaVersion !== "number" || !Number.isFinite(root.schemaVersion)) {
      throw new RegistryParseError(
        path,
        new Error("'schemaVersion' must be a number"),
      );
    }
    schemaVersion = root.schemaVersion;
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
  }

  if (!Array.isArray(root.engagements)) {
    throw new RegistryParseError(path, new Error("'engagements' must be a list"));
  }
  for (const e of root.engagements) {
    if (!e || typeof e !== "object") {
      throw new RegistryParseError(path, new Error(`engagement entry is not an object`));
    }
    const obj = e as Partial<Engagement>;
    if (typeof obj.id !== "string" || obj.id.length === 0) {
      throw new RegistryParseError(path, new Error(`engagement entry missing string 'id'`));
    }
    if (obj.id === ALWAYS_BLOCK_RESERVED_ID) {
      throw new RegistryParseError(
        path,
        new Error(
          `engagement id "${ALWAYS_BLOCK_RESERVED_ID}" is reserved; ` +
            `use the top-level 'always_block:' field for org-wide markers`,
        ),
      );
    }
    if (typeof obj.name !== "string") {
      throw new RegistryParseError(path, new Error(`engagement '${obj.id}' missing string 'name'`));
    }
    if (!Array.isArray(obj.markers)) {
      throw new RegistryParseError(path, new Error(`engagement '${obj.id}' missing 'markers' list`));
    }
  }

  let alwaysBlock: string[] = [];
  if (root.always_block !== undefined) {
    if (!Array.isArray(root.always_block)) {
      throw new RegistryParseError(path, new Error("'always_block' must be a list of patterns"));
    }
    for (const p of root.always_block) {
      if (typeof p !== "string") {
        throw new RegistryParseError(path, new Error("'always_block' entries must be strings"));
      }
    }
    alwaysBlock = root.always_block as string[];
  }

  return {
    engagements: root.engagements as Engagement[],
    alwaysBlock,
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
