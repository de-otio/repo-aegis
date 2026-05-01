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
}

export const ALWAYS_BLOCK_RESERVED_ID = "_always";

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
  const root = parsed as { engagements: unknown; always_block?: unknown };
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
