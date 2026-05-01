import { execFileSync } from "node:child_process";
import { NotAGitRepoError } from "./exceptions.js";

export type RepoClass = "public-eligible" | "private-strict" | "customer-coupled" | "scratch";

export const REPO_CLASSES: readonly RepoClass[] = [
  "public-eligible",
  "private-strict",
  "customer-coupled",
  "scratch",
];

export interface RepoConfig {
  cwd: string;
  isGitRepo: boolean;
  class: RepoClass;
  classExplicit: boolean;
  engagements: string[];
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
  if (!isGitRepo) {
    return {
      cwd,
      isGitRepo: false,
      class: "private-strict",
      classExplicit: false,
      engagements: [],
    };
  }
  const cls = git(cwd, ["config", "--get", "repo-aegis.class"]);
  const eng = git(cwd, ["config", "--get-all", "repo-aegis.engagement"]);
  const classExplicit = cls.ok && cls.stdout !== "";
  const classValue: RepoClass =
    classExplicit && isValidClass(cls.stdout) ? cls.stdout : "private-strict";
  const engagements = eng.ok && eng.stdout ? eng.stdout.split("\n").filter(Boolean) : [];
  return {
    cwd,
    isGitRepo: true,
    class: classValue,
    classExplicit,
    engagements,
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
