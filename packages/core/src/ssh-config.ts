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
// PRINCIPLE: this is not an ssh emulator. It answers "positively this alias is
// host X" only when it is sure, and says UNRESOLVED for everything doubtful.
// Rule h refuses an unresolved push when it is active and nobody is present,
// so a doubt costs a refusal, never a leak.
//
// Why not `ssh -G <host>`: it EVALUATES the config, including `Match exec
// <command>`, and the config file is something an agent can write while the
// hook that would run `ssh -G` runs outside the agent's sandbox. This module
// only reads text. It understands `Host` (patterns with `*`, `?`, `!`),
// `HostName`, and `Include` (bounded, relative to ~/.ssh). Lines are split the
// way OpenSSH's argv_split does (quotes, backslash escapes, and `#` starting a
// comment only at the beginning of a token). It returns UNRESOLVED for:
//
//   - a `Match` block that sets `HostName`, or any other directive that can
//     move the connection (its condition may be `exec …`, never run here);
//   - `ProxyCommand`, `ProxyJump`, `CanonicalizeHostname` or `CanonicalDomains`
//     in a block that applies (or may apply) to the alias: the host named in
//     the URL is then not necessarily where the bytes go;
//   - a `HostName` that is not a plain host name (quotes, `%` tokens, spaces,
//     anything outside letters, digits, `.`, `-`, `_`);
//   - a config or include file that exists but cannot be read, is huge, is not
//     a regular file (a fifo would hang the hook), or has an unterminated quote;
//   - an `Include` it cannot expand (env vars, `%` tokens, a glob in a
//     directory component, a character class), or one nested too deeply.
//
// A missing `~/.ssh/config` is not an error: there are simply no aliases.
//
// ssh takes the FIRST value it obtains for a keyword, so the first applicable
// `HostName` in file order wins, and that is what this returns. The whole
// config is still walked afterwards, because a later block can add a proxy.
//
// Known limit (TOCTOU): a file can change between the check that it is a
// regular file and the read. The file is opened with O_NONBLOCK and its type is
// checked on the open descriptor, so a swapped-in fifo cannot hang the reader,
// but the content read is whatever is there at that moment.
import { constants, closeSync, fstatSync, openSync, readFileSync, readdirSync, statSync } from "node:fs";
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
/** Files opened plus directories listed for one lookup, so a fan-out of includes cannot stall the hook. */
const MAX_FILES = 64;
/** A config file bigger than this is not a config file. */
const MAX_FILE_BYTES = 1024 * 1024;
/** A `HostName` this parser will believe: a plain DNS name or address. */
const PLAIN_HOSTNAME_RE = /^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$/;

type Block = "applies" | "skips" | "match";

interface Walk {
  host: string;
  sshDir: string;
  /** Files opened plus directories listed so far. */
  files: number;
  /** The first applicable HostName, once seen. */
  hostName?: string;
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

/**
 * Split a config line the way OpenSSH's `argv_split` does: whitespace
 * separates tokens; single and double quotes group; a backslash escapes a
 * quote, a backslash or a space; and `#` starts a comment ONLY at the
 * beginning of a token (`Host foo#x gh` has two patterns). Returns null for an
 * unterminated quote, which makes ssh itself refuse the config.
 */
export function splitSshLine(line: string): string[] | null {
  const tokens: string[] = [];
  let i = 0;
  const n = line.length;
  for (;;) {
    while (i < n && /\s/.test(line[i]!)) i++;
    if (i >= n || line[i] === "#") break;
    let cur = "";
    while (i < n) {
      const ch = line[i]!;
      if (ch === "\\" && i + 1 < n && "'\"\\ ".includes(line[i + 1]!)) {
        cur += line[i + 1]!;
        i += 2;
      } else if (ch === '"' || ch === "'") {
        i++;
        let closed = false;
        while (i < n) {
          const c = line[i]!;
          if (c === "\\" && i + 1 < n && "'\"\\".includes(line[i + 1]!)) {
            cur += line[i + 1]!;
            i += 2;
          } else if (c === ch) {
            closed = true;
            i++;
            break;
          } else {
            cur += c;
            i++;
          }
        }
        if (!closed) return null;
      } else if (/\s/.test(ch)) {
        break;
      } else {
        cur += ch;
        i++;
      }
    }
    tokens.push(cur);
  }
  return tokens;
}

/** `Keyword value…` or `Keyword=value…` (or `Keyword = value`); null for blanks and comments. */
function parseLine(line: string): { keyword: string; args: string[] } | "bad" | null {
  const tokens = splitSshLine(line);
  if (tokens === null) return "bad";
  if (tokens.length === 0) return null;
  let first = tokens[0]!;
  const rest = tokens.slice(1);
  const eq = first.indexOf("=");
  if (eq !== -1) {
    const after = first.slice(eq + 1);
    first = first.slice(0, eq);
    if (after !== "") rest.unshift(after);
  } else if (rest[0] === "=") {
    rest.shift();
  } else if (rest[0]?.startsWith("=")) {
    rest[0] = rest[0].slice(1);
  }
  if (!/^[A-Za-z][A-Za-z0-9]*$/.test(first)) return null;
  return { keyword: first.toLowerCase(), args: rest };
}

function unresolved(why: string): SshHostLookup {
  return { kind: "unresolved", why };
}

/** Read a config file: null when absent or a directory, a lookup failure when unusable. */
function readConfig(path: string, w: Walk): string | null | SshHostLookup {
  if (++w.files > MAX_FILES) return unresolved("too many included ssh config files");
  let fd: number | undefined;
  try {
    // A fifo or device must not be opened blocking. Check the type on the open
    // descriptor (not on the path, which could change in between).
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    const st = fstatSync(fd);
    if (st.isDirectory()) return null;
    if (!st.isFile()) return unresolved("an ssh config file is not a regular file");
    if (st.size > MAX_FILE_BYTES) return unresolved("an ssh config file is too large to read");
    return readFileSync(fd, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    return unresolved("an ssh config file exists but cannot be read");
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* nothing to do */
      }
    }
  }
}

/** glob(3): a leading `.` in a name is matched only by a pattern that itself starts with `.`. */
function globMatchesName(pattern: string, name: string): boolean {
  if (name.startsWith(".") && !pattern.startsWith(".")) return false;
  return globToRegExp(pattern).test(name);
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
  // A directory listing counts against the same bound as a file read.
  if (++w.files > MAX_FILES) return unresolved("too many included ssh config files");
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return [];
    return unresolved("an Include directory cannot be read");
  }
  return names
    .filter(n => globMatchesName(base, n))
    .sort()
    .map(n => join(dir, n));
}

/** Directives that can move where an ssh connection really goes. */
const REDIRECTING = new Set(["proxycommand", "proxyjump", "canonicalizehostname", "canonicaldomains"]);

function isNoOp(keyword: string, arg: string | undefined): boolean {
  const a = (arg ?? "").toLowerCase();
  if (keyword === "proxycommand" || keyword === "proxyjump") return a === "none";
  if (keyword === "canonicalizehostname") return a === "no";
  return false;
}

function walkFile(path: string, depth: number, initial: Block, w: Walk): SshHostLookup | null {
  if (depth > SSH_INCLUDE_MAX_DEPTH) return unresolved("ssh config Includes are nested too deeply");
  const text = readConfig(path, w);
  if (text === null) return null;
  if (typeof text !== "string") return text;
  let block: Block = initial;
  for (const line of text.split(/\r?\n/)) {
    const parsed = parseLine(line);
    if (parsed === null) continue;
    if (parsed === "bad") return unresolved("an ssh config line has an unterminated quote");
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
        if (block === "match") {
          if (w.hostName === undefined) return unresolved("an ssh Match block sets HostName and cannot be evaluated offline");
          break; // an earlier Host block already decided; first value wins
        }
        if (w.hostName !== undefined) break;
        const hostName = value.toLowerCase().replace(/\.$/, "");
        if (!PLAIN_HOSTNAME_RE.test(hostName)) return unresolved("HostName is not a plain host name");
        w.hostName = hostName;
        break;
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
        if (REDIRECTING.has(parsed.keyword) && block !== "skips" && !isNoOp(parsed.keyword, parsed.args[0])) {
          return unresolved(
            block === "match"
              ? "an ssh Match block sets a connection redirect and cannot be evaluated offline"
              : `the ssh config sets ${parsed.keyword} for this host, so the named host is not necessarily where the connection goes`,
          );
        }
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
    const r = walkFile(join(sshDir, "config"), 0, "applies", w);
    if (r !== null) return r;
    return w.hostName !== undefined ? { kind: "hostname", hostName: w.hostName } : { kind: "none" };
  } catch {
    return unresolved("the ssh config could not be evaluated");
  }
}
