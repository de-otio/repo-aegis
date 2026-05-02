// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
import { existsSync, readFileSync } from "node:fs";
import { parse } from "yaml";
import { z } from "zod";
import { formatZodError } from "@de-otio/repo-aegis-core";
import type { QueryEntry, QueryFile } from "./types.js";

export interface QueryValidationIssue {
  index: number;
  name?: string;
  reason: string;
}

export interface QueryValidationResult {
  ok: boolean;
  queries: QueryEntry[];
  issues: QueryValidationIssue[];
}

const ORG_FILTER = /\borg:[^\s]+/i;

// Schema for the on-disk queries YAML. parse-and-validate splits cleanly
// here: zod handles structural validation (right shape, right types,
// required fields), and the second pass (validateQueryFile) handles
// cross-field rules that aren't expressible structurally — name-uniqueness
// and the org:-filter mandate.
const queryEntrySchema = z
  .object({
    name: z.string().min(1, "missing or empty 'name'"),
    query: z.string().min(1, "missing or empty 'query'"),
    excludeOrg: z.array(z.string()).optional(),
    excludeRepo: z.array(z.string()).optional(),
  })
  .passthrough();

const queryFileSchema = z
  .object({
    queries: z.array(queryEntrySchema, { message: "'queries' must be a list" }),
  })
  .passthrough();

export function parseQueryFile(path: string): QueryFile {
  if (!existsSync(path)) {
    throw new Error(`query file not found: ${path}`);
  }
  const raw = readFileSync(path, "utf8");
  let parsed: unknown;
  try {
    parsed = parse(raw);
  } catch (err) {
    throw new Error(`failed to parse ${path}: ${(err as Error).message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !("queries" in (parsed as object))) {
    throw new Error(`${path}: missing top-level 'queries:' list`);
  }
  let validated;
  try {
    validated = queryFileSchema.parse(parsed);
  } catch (err) {
    if (err instanceof z.ZodError) {
      throw new Error(`${path}: ${formatZodError(err, "queries")}`);
    }
    throw err;
  }
  return { queries: validated.queries as QueryEntry[] };
}

export function validateQueryFile(file: QueryFile): QueryValidationResult {
  const issues: QueryValidationIssue[] = [];
  const seenNames = new Set<string>();
  const valid: QueryEntry[] = [];

  for (let i = 0; i < file.queries.length; i++) {
    const q = file.queries[i] as Partial<QueryEntry> | undefined | null;
    if (!q || typeof q !== "object") {
      issues.push({ index: i, reason: "entry is not an object" });
      continue;
    }
    if (typeof q.name !== "string" || q.name.length === 0) {
      issues.push({ index: i, reason: "missing or empty 'name'" });
      continue;
    }
    if (seenNames.has(q.name)) {
      issues.push({ index: i, name: q.name, reason: "duplicate 'name'" });
      continue;
    }
    seenNames.add(q.name);
    if (typeof q.query !== "string" || q.query.length === 0) {
      issues.push({ index: i, name: q.name, reason: "missing or empty 'query'" });
      continue;
    }
    if (!ORG_FILTER.test(q.query)) {
      issues.push({
        index: i,
        name: q.name,
        reason: "query is missing an org: filter (refusing un-scoped global search)",
      });
      continue;
    }
    if (/["']/.test(q.query) === false && /\s/.test(q.query)) {
      const beforeOrg = q.query.replace(ORG_FILTER, "").trim();
      if (beforeOrg.length > 0 && /\s/.test(beforeOrg)) {
        issues.push({
          index: i,
          name: q.name,
          reason: "query has un-quoted whitespace; wrap multi-word phrases in quotes",
        });
        continue;
      }
    }
    valid.push({
      name: q.name,
      query: q.query,
      excludeOrg: Array.isArray(q.excludeOrg) ? (q.excludeOrg as string[]) : undefined,
      excludeRepo: Array.isArray(q.excludeRepo) ? (q.excludeRepo as string[]) : undefined,
    });
  }

  return {
    ok: issues.length === 0,
    queries: valid,
    issues,
  };
}
