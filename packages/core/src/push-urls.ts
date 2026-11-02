// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// The URL(s) `git push <remote>` will actually write to
// (doc/plan-unregistered-owner-egress.md §3.3 item 5, §8.4 F7).
//
// `remote.<name>.url` is not where a push goes. `remote.<name>.pushurl`,
// `url.<base>.insteadOf` and `url.<base>.pushInsteadOf` all rewrite it, and a
// remote may have several push URLs. `git remote get-url --push --all` applies
// every one of those and prints each URL. (`git ls-remote --get-url` ignores
// `pushInsteadOf` and `pushurl`, which is why it is not used.)
//
// `git push <url>` names a URL directly. git applies the rewrites to that too,
// but `git remote get-url` only answers for a configured remote, so a URL given
// directly is rewritten here, following git's own rule: a matching
// `pushInsteadOf` (longest prefix) wins; otherwise the longest matching
// `insteadOf`.
//
// The pre-push hook needs none of this: git hands it the URL after all
// rewriting, once per push URL.
import { execFileSync } from "node:child_process";
import { looksLikeRemoteUrl, type SshOverrideKind } from "./remote-url.js";

function gitOut(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

interface Rewrite {
  base: string;
  prefix: string;
}

/** Parse `git config --get-regexp` output for `url.<base>.<key>` entries. */
function parseRewrites(out: string | null, key: "insteadof" | "pushinsteadof"): Rewrite[] {
  if (out === null) return [];
  const re = new RegExp(`^url\\.(.*)\\.${key} (.*)$`);
  const rewrites: Rewrite[] = [];
  for (const line of out.split("\n")) {
    const m = re.exec(line);
    if (m !== null) rewrites.push({ base: m[1]!, prefix: m[2]! });
  }
  return rewrites;
}

function applyLongest(url: string, rewrites: readonly Rewrite[]): string | null {
  let best: Rewrite | null = null;
  for (const r of rewrites) {
    if (r.prefix === "" || !url.startsWith(r.prefix)) continue;
    if (best === null || r.prefix.length > best.prefix.length) best = r;
  }
  return best === null ? null : best.base + url.slice(best.prefix.length);
}

/** `url` after git's push-time rewriting (`pushInsteadOf`, else `insteadOf`). */
function rewriteForPush(cwd: string, url: string): string {
  const out = gitOut(cwd, ["config", "--get-regexp", "^url\\..*\\.(push)?insteadof$"]);
  const viaPush = applyLongest(url, parseRewrites(out, "pushinsteadof"));
  if (viaPush !== null) return viaPush;
  return applyLongest(url, parseRewrites(out, "insteadof")) ?? url;
}

/**
 * Every URL `git push <remote>` writes to, run from `cwd`. `remote` is a
 * configured remote's name (which wins, as in git) or a URL. Returns `null`
 * when it is neither: a local path, or nothing git can read. Never throws.
 */
export function resolvePushUrls(cwd: string, remote: string): string[] | null {
  const configured = gitOut(cwd, ["remote", "get-url", "--push", "--all", "--", remote]);
  if (configured !== null) {
    const urls = configured
      .split("\n")
      .map(u => u.trim())
      .filter(u => u !== "");
    if (urls.length > 0) return urls;
  }
  if (!looksLikeRemoteUrl(remote.trim())) return null;
  return [rewriteForPush(cwd, remote.trim())];
}

/**
 * Tokenise `cmd` the way the shell git runs it through would, far enough to
 * answer one question: is it plain `ssh ...` (first word `ssh` or `/usr/bin/ssh`)
 * with nothing that runs a second command? Quotes and backslash escapes are
 * honoured, so a `;` or `$(` inside a quoted `-o ProxyCommand="..."` value (the
 * shape of Claude Code's own sandbox template) is inert, but an unquoted
 * `; | & < > ( )`, backtick, newline, `$(` or `${` (also inside double quotes
 * unless escaped) is not. An unterminated quote is not plain ssh.
 */
function isPlainSshCommand(cmd: string): boolean {
  let word = "";
  let started = false;
  let done = false;
  let mode: "u" | "s" | "d" = "u";
  const add = (s: string): void => {
    started = true;
    if (!done) word += s;
  };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]!;
    const next = cmd[i + 1];
    if (mode === "s") {
      if (c === "'") mode = "u";
      else add(c);
    } else if (mode === "d") {
      if (c === "\\" && next !== undefined && "$`\"\\\n".includes(next)) {
        add(next);
        i++;
      } else if (c === '"') {
        mode = "u";
      } else if (c === "`" || (c === "$" && (next === "(" || next === "{"))) {
        return false;
      } else {
        add(c);
      }
    } else if (c === "\\") {
      if (next === undefined) return false;
      if (next !== "\n") add(next);
      i++;
    } else if (c === "'") {
      mode = "s";
      started = true;
    } else if (c === '"') {
      mode = "d";
      started = true;
    } else if (";|&<>`()\n\r".includes(c) || (c === "$" && (next === "(" || next === "{"))) {
      return false;
    } else if (c === " " || c === "\t") {
      if (started) done = true;
    } else {
      add(c);
    }
  }
  return mode === "u" && (word === "ssh" || word === "/usr/bin/ssh");
}

/** `RemoteCommand` anywhere (`-o RemoteCommand=...`, `-oRemoteCommand ...`): rejected to be safe. */
const REMOTE_COMMAND_RE = /remote\s*command/i;

/** A `GIT_SSH_COMMAND` / `core.sshCommand` value that is plain ssh and leaves the command git sends alone. */
export function isSshPreservingCommand(cmd: string): boolean {
  return isPlainSshCommand(cmd) && !REMOTE_COMMAND_RE.test(cmd);
}

/**
 * Which ssh override, if any, is in effect where a push runs, in three classes
 * (`SshOverrideKind`):
 *
 *   - `none`: no override.
 *   - `preserving`: an override that can only move the CONNECTION, never change
 *     what git sends. `GIT_SSH` is unset, `GIT_SSH_VARIANT` is unset or `ssh`,
 *     and every `GIT_SSH_COMMAND` / `core.sshCommand` value is plain `ssh ...`
 *     ({@link isSshPreservingCommand}: first word `ssh` or `/usr/bin/ssh`, no
 *     unquoted shell metacharacters, no RemoteCommand). A name-resolution
 *     override in the environment (`HOSTALIASES`, `LOCALDOMAIN`, `RES_OPTIONS`)
 *     also counts: it redirects a host name, nothing more.
 *   - `other`: anything else (`GIT_SSH` set, a program that is not `ssh`, shell
 *     metacharacters). git runs the override as `<override> user@host
 *     "git-receive-pack '<path>'"`, so such a program can send a DIFFERENT
 *     repository path than the URL names.
 *
 * Callers pass the environment the push will run with; `core.sshCommand` is
 * read from the git config seen from `cwd` (which includes `git -c`).
 *
 * Why no list of "harmless" overrides, and no trust in Claude Code's own
 * sandbox `GIT_SSH_COMMAND` (its metacharacters sit inside a quoted
 * `-o ProxyCommand` value, so it classifies as `preserving` like any ssh): an
 * ssh redirect or proxy changes which SERVER receives the push, never the
 * repository path, which travels inside the ssh channel. So:
 *
 *   - under `preserving`, a host the guard resolves to GitHub (literal
 *     github.com / ssh.github.com, or an alias whose ssh-config HostName is one
 *     of those) is judged by the owner in the path. If the override actually
 *     sends the bytes to another server, they leave GitHub's world, which is
 *     outside the guard's model. Any OTHER host is only believed to be "not
 *     GitHub" with no override; under one it is unresolved (`resolveRemoteUrl`);
 *   - under `other`, EVERY ssh URL is unresolved, literal github.com included.
 *
 * The sandbox template's proxy script, the shell that runs it (SHELL,
 * BASH_FUNC_*, ZDOTDIR, loader variables...) are all irrelevant to this.
 */
export function detectSshOverride(cwd: string, env: NodeJS.ProcessEnv = process.env): SshOverrideKind {
  const val = (name: string): string => (env[name] ?? "").trim();
  if (val("GIT_SSH") !== "") return "other";
  const variant = val("GIT_SSH_VARIANT");
  if (variant !== "" && variant !== "ssh") return "other";
  const commands = [val("GIT_SSH_COMMAND"), (gitOut(cwd, ["config", "--get", "core.sshCommand"]) ?? "").trim()].filter(
    c => c !== "",
  );
  if (commands.some(c => !isSshPreservingCommand(c))) return "other";
  if (variant !== "" || commands.length > 0) return "preserving";
  // These change how a host NAME resolves, so a non-GitHub-looking host may be GitHub.
  if (["HOSTALIASES", "LOCALDOMAIN", "RES_OPTIONS"].some(n => val(n) !== "")) return "preserving";
  return "none";
}
