import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { NotAGitRepoError } from "./exceptions.js";
import {
  repoOverrideSchema,
  REPO_CLASSES as REPO_CLASSES_SCHEMA,
  formatZodError,
  type RepoClassLiteral,
} from "./schemas.js";

export type RepoClass = RepoClassLiteral;

export const REPO_CLASSES: readonly RepoClass[] = REPO_CLASSES_SCHEMA;

export interface RepoConfig {
  cwd: string;
  isGitRepo: boolean;
  class: RepoClass;
  classExplicit: boolean;
  engagements: string[];
  /** True when class came from a checked-in `.repo-aegis.yml`. */
  classFromOverride?: boolean;
  /** True when engagements came from a checked-in `.repo-aegis.yml`. */
  engagementsFromOverride?: boolean;
}

export interface RepoOverride {
  class?: RepoClass;
  engagements?: string[];
}

export const OVERRIDE_FILENAME = ".repo-aegis.yml";

export class RepoOverrideError extends Error {
  readonly code = "REPO_OVERRIDE_PARSE_ERROR";
  constructor(public readonly path: string, message: string) {
    super(`${path}: ${message}`);
  }
}

function loadOverride(cwd: string): { override: RepoOverride; path: string } | null {
  // Look for `.repo-aegis.yml` at git toplevel; fall back to cwd if not in a
  // git repo (so the override still works in scratch dirs).
  let root = cwd;
  try {
    const top = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (top) root = top;
  } catch {
    /* not a git repo; use cwd as root */
  }
  const path = join(root, OVERRIDE_FILENAME);
  if (!existsSync(path)) return null;

  let parsed: unknown;
  try {
    parsed = parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new RepoOverrideError(path, `failed to parse YAML: ${(err as Error).message}`);
  }
  if (parsed === null || parsed === undefined) {
    return { override: {}, path };
  }
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new RepoOverrideError(path, "must be a YAML mapping");
  }

  let validated;
  try {
    validated = repoOverrideSchema.parse(parsed);
  } catch (err) {
    if (err instanceof z.ZodError) {
      throw new RepoOverrideError(path, formatZodError(err, "override"));
    }
    throw err;
  }

  const out: RepoOverride = {};
  if (validated.class !== undefined) out.class = validated.class;
  if (validated.engagements !== undefined) out.engagements = validated.engagements;
  return { override: out, path };
}

interface GitResult {
  ok: boolean;
  stdout: string;
}

function git(cwd: string, args: string[]): GitResult {
  try {
    const stdout = execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return { ok: true, stdout };
  } catch {
    return { ok: false, stdout: "" };
  }
}

function isValidClass(s: string): s is RepoClass {
  return (REPO_CLASSES as readonly string[]).includes(s);
}

export function readRepoConfig(cwd: string = process.cwd()): RepoConfig {
  const inside = git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  const isGitRepo = inside.ok && inside.stdout === "true";

  // .repo-aegis.yml may exist even outside a git repo (scratch dir);
  // load it either way. Throws RepoOverrideError on malformed YAML.
  const overrideResult = loadOverride(cwd);
  const override = overrideResult?.override ?? {};

  if (!isGitRepo) {
    return {
      cwd,
      isGitRepo: false,
      class: override.class ?? "private-strict",
      classExplicit: override.class !== undefined,
      engagements: override.engagements ?? [],
      ...(override.class !== undefined && { classFromOverride: true }),
      ...(override.engagements !== undefined && { engagementsFromOverride: true }),
    };
  }

  // Precedence: git config wins where set, .repo-aegis.yml provides
  // the project-default fallback. This matches the .editorconfig
  // model: the file in the repo declares intent; per-clone git
  // config can override locally without changing the file.
  const cls = git(cwd, ["config", "--get", "repo-aegis.class"]);
  const eng = git(cwd, ["config", "--get-all", "repo-aegis.engagement"]);
  const cfgClassSet = cls.ok && cls.stdout !== "";
  const cfgEngagements = eng.ok && eng.stdout ? eng.stdout.split("\n").filter(Boolean) : [];

  let classValue: RepoClass;
  let classExplicit = false;
  let classFromOverride = false;
  if (cfgClassSet && isValidClass(cls.stdout)) {
    classValue = cls.stdout;
    classExplicit = true;
  } else if (override.class !== undefined) {
    classValue = override.class;
    classExplicit = true;
    classFromOverride = true;
  } else {
    classValue = "private-strict";
  }

  let engagements: string[];
  let engagementsFromOverride = false;
  if (cfgEngagements.length > 0) {
    engagements = cfgEngagements;
  } else if (override.engagements !== undefined) {
    engagements = override.engagements;
    engagementsFromOverride = true;
  } else {
    engagements = [];
  }

  return {
    cwd,
    isGitRepo: true,
    class: classValue,
    classExplicit,
    engagements,
    ...(classFromOverride && { classFromOverride: true }),
    ...(engagementsFromOverride && { engagementsFromOverride: true }),
  };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Idempotent add. Returns true if added, false if already present.
 */
export function addEngagement(id: string, cwd: string = process.cwd()): boolean {
  const cfg = readRepoConfig(cwd);
  if (!cfg.isGitRepo) throw new NotAGitRepoError();
  if (cfg.engagements.includes(id)) return false;
  execFileSync("git", ["config", "--add", "repo-aegis.engagement", id], { cwd });
  return true;
}

/**
 * Idempotent multi-add. Returns the list of ids that were newly added.
 */
export function addEngagements(ids: string[], cwd: string = process.cwd()): string[] {
  const cfg = readRepoConfig(cwd);
  if (!cfg.isGitRepo) throw new NotAGitRepoError();
  const existing = new Set(cfg.engagements);
  const added: string[] = [];
  for (const id of ids) {
    if (existing.has(id)) continue;
    execFileSync("git", ["config", "--add", "repo-aegis.engagement", id], { cwd });
    existing.add(id);
    added.push(id);
  }
  return added;
}

/**
 * Returns true if removed, false if not present.
 */
export function removeEngagement(id: string, cwd: string = process.cwd()): boolean {
  const cfg = readRepoConfig(cwd);
  if (!cfg.isGitRepo) throw new NotAGitRepoError();
  if (!cfg.engagements.includes(id)) return false;
  execFileSync(
    "git",
    ["config", "--unset-all", "repo-aegis.engagement", `^${escapeRegex(id)}$`],
    { cwd },
  );
  return true;
}

export function setClass(cls: RepoClass, cwd: string = process.cwd()): void {
  const cfg = readRepoConfig(cwd);
  if (!cfg.isGitRepo) throw new NotAGitRepoError();
  execFileSync("git", ["config", "repo-aegis.class", cls], { cwd });
}

export function unsetClass(cwd: string = process.cwd()): void {
  const cfg = readRepoConfig(cwd);
  if (!cfg.isGitRepo) throw new NotAGitRepoError();
  // --unset is idempotent enough; ignore "no value found" errors.
  try {
    execFileSync("git", ["config", "--unset", "repo-aegis.class"], {
      cwd,
      stdio: ["ignore", "ignore", "ignore"],
    });
  } catch {
    /* not set; nothing to do */
  }
}
