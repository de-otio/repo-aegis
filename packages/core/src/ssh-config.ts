// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// A small, PURE reader of the user's ssh config: which real host does an ssh
// alias point at? (doc/plan-unregistered-owner-egress.md §3.3 item 5.)
//
// `git@gh-work:acme/r.git` pushes to whatever `Host gh-work` / `HostName`
// says, which is usually github.com, sometimes not. Rule h needs to know which
// owner a push lands on, so it needs to know whether the alias is GitHub at all.
//
// Why not `ssh -G <host>`: it EVALUATES the config, including `Match exec
// <command>`, and the config file is something an agent can write while the
// hook that would run `ssh -G` runs outside the agent's sandbox. This module
// only reads text. It understands `Host` (patterns with `*`, `?`, `!`),
// `HostName`, `Include` (bounded depth, relative to ~/.ssh), and treats
// anything it cannot evaluate purely as UNRESOLVED, never as "probably fine":
//
//   - a `Match` block that sets `HostName` before any `Host` block has decided
//     (its condition may be `exec …`, which this never runs);
//   - a config or include file that exists but cannot be read, or is huge;
//   - an `Include` it cannot expand (env vars, `%` tokens, a glob in a
//     directory component), or one nested too deeply;
//   - a `HostName` containing `%` tokens.
//
// A missing `~/.ssh/config` is not an error: there are simply no aliases.
//
// ssh takes the FIRST value it obtains for a keyword, so the first applicable
// `HostName` in file order wins, and that is what this returns.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";

/** What the ssh config says about a host. */
export type SshHostLookup =
  /** No `HostName` applies: the name is the real host. */
  | { kind: "none" }
  /** The first applicable `HostName` (lower-cased, one trailing dot removed). */
  | { kind: "hostname"; hostName: string }
  /** The config cannot be evaluated purely. Callers must fail closed. */
  | { kind: "unresolved"; why: string };

export interface SshConfigOptions {
  /** Directory holding `config` and the base for relative `Include`s. Default `~/.ssh`. */
  sshDir?: string;
}

/** `Include` nesting bound. ssh itself allows 16; a sane config needs 1 or 2. */
export const SSH_INCLUDE_MAX_DEPTH = 5;
/** Total files read for one lookup, so a fan-out of includes cannot be used to stall the hook. */
const MAX_FILES = 64;
/** A config file bigger than this is not a config file. */
const MAX_FILE_BYTES = 1024 * 1024;

type Block = "applies" | "skips" | "match";

interface Walk {
  host: string;
  sshDir: string;
  files: number;
}

/** `*` and `?` globs, anchored, case-insensitive. */
function globToRegExp(glob: string): RegExp {
  const body = glob
    .split("")
    .map(ch => (ch === "*" ? ".*" : ch === "?" ? "." : ch.replace(/[.+^${}()|[\]\\]/g, "\\$&")))
    .join("");
  return new RegExp(`^${body}$`, "i");
}

/** ssh's rule: a negated pattern that matches excludes the line; otherwise any positive match applies. */
function hostPatternsApply(patterns: readonly string[], host: string): boolean {
  let positive = false;
  for (const p of patterns) {
    if (p.startsWith("!")) {
      if (globToRegExp(p.slice(1)).test(host)) return false;
    } else if (globToRegExp(p).test(host)) {
      positive = true;
    }
  }
  return positive;
}

/** Split a config line's value into tokens, honouring double quotes. `#` starts a comment outside quotes. */
function tokenize(value: string): string[] {
  const tokens: string[] = [];
  let cur = "";
  let inQuote = false;
  let has = false;
  for (const ch of value) {
    if (inQuote) {
      if (ch === '"') inQuote = false;
      else cur += ch;
    } else if (ch === '"') {
      inQuote = true;
      has = true;
    } else if (ch === "#") {
      break;
    } else if (/\s/.test(ch)) {
      if (has || cur.length > 0) tokens.push(cur);
      cur = "";
      has = false;
    } else {
      cur += ch;
      has = true;
    }
  }
  if (has || cur.length > 0) tokens.push(cur);
  return tokens;
}

/** `Keyword value…` or `Keyword=value…`; null for blanks and comments. */
function parseLine(line: string): { keyword: string; args: string[] } | null {
  const m = /^\s*([A-Za-z][A-Za-z0-9]*)\s*(?:=\s*|\s+)(.*)$/.exec(line);
  if (m === null) return null;
  return { keyword: m[1]!.toLowerCase(), args: tokenize(m[2]!) };
}

type StepResult = SshHostLookup | null; // null: keep looking

function unresolved(why: string): SshHostLookup {
  return { kind: "unresolved", why };
}

/** Read a config file: null when absent, a lookup failure when unreadable. */
function readConfig(path: string, w: Walk): string | null | SshHostLookup {
  if (++w.files > MAX_FILES) return unresolved("too many included ssh config files");
  try {
    const st = statSync(path);
    if (!st.isFile()) return null;
    if (st.size > MAX_FILE_BYTES) return unresolved("an ssh config file is too large to read");
    return readFileSync(path, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    return unresolved("an ssh config file exists but cannot be read");
  }
}

/** The files one `Include` argument names, in the order ssh reads them, or a failure. */
function expandInclude(arg: string, w: Walk): string[] | SshHostLookup {
  if (/[$%]/.test(arg)) return unresolved("an Include uses an environment variable or % token");
  let path = arg;
  if (path === "~" || path.startsWith("~/")) path = join(homedir(), path.slice(1));
  else if (path.startsWith("~")) return unresolved("an Include names another user's home directory");
  if (!isAbsolute(path)) path = join(w.sshDir, path);
  const base = basename(path);
  const dir = dirname(path);
  if (/[*?[]/.test(dir)) return unresolved("an Include has a glob in a directory component");
  if (!/[*?[]/.test(base)) return [path];
  if (base.includes("[")) return unresolved("an Include uses a character class");
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return [];
    return unresolved("an Include directory cannot be read");
  }
  const re = globToRegExp(base);
  return names
    .filter(n => re.test(n))
    .sort()
    .map(n => join(dir, n));
}

function walkFile(path: string, depth: number, initial: Block, w: Walk): StepResult {
  if (depth > SSH_INCLUDE_MAX_DEPTH) return unresolved("ssh config Includes are nested too deeply");
  const text = readConfig(path, w);
  if (text === null) return null;
  if (typeof text !== "string") return text;
  let block: Block = initial;
  for (const line of text.split(/\r?\n/)) {
    const parsed = parseLine(line);
    if (parsed === null) continue;
    switch (parsed.keyword) {
      case "host":
        block = hostPatternsApply(parsed.args, w.host) ? "applies" : "skips";
        break;
      case "match":
        block = "match";
        break;
      case "hostname": {
        if (block === "skips") break;
        const value = parsed.args[0];
        if (value === undefined || value === "") break;
        if (block === "match") return unresolved("a Match block sets HostName and cannot be evaluated offline");
        if (value.includes("%")) return unresolved("HostName uses a % token");
        return { kind: "hostname", hostName: value.toLowerCase().replace(/\.$/, "") };
      }
      case "include": {
        if (block === "skips") break;
        for (const arg of parsed.args) {
          const files = expandInclude(arg, w);
          if (!Array.isArray(files)) return files;
          for (const f of files) {
            const r = walkFile(f, depth + 1, block, w);
            if (r !== null) return r;
          }
        }
        break;
      }
      default:
        break;
    }
  }
  return null;
}

/**
 * Which real host does `host` (an ssh alias, or a real name) resolve to
 * through the user's ssh config? Total: never throws, never runs a command.
 */
export function lookupSshHost(host: string, opts: SshConfigOptions = {}): SshHostLookup {
  try {
    const sshDir = opts.sshDir ?? join(homedir(), ".ssh");
    const w: Walk = { host: host.toLowerCase(), sshDir, files: 0 };
    return walkFile(join(sshDir, "config"), 0, "applies", w) ?? { kind: "none" };
  } catch {
    return unresolved("the ssh config could not be evaluated");
  }
}
