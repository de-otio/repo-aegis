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
import { looksLikeRemoteUrl, type SshOverride } from "./remote-url.js";

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
 * The `GIT_SSH_COMMAND` Claude Code's own sandbox sets for every agent Bash
 * command, byte for byte. It is trusted as HOST-PRESERVING: the options only
 * disable connection sharing and route the connection through the sandbox's
 * network proxy, which receives the host (`%h`) and port (`%p`) unchanged. It
 * sets no HostName, `-F`, `-J`, identity or user. So ssh aliases resolve
 * through the ssh config exactly as they would with no override, which matters
 * because an operator's own remotes are usually aliases.
 *
 * Trust is by EXACT match of this string (whitespace runs collapsed, nothing
 * else): no pattern, no parsing of options, so any added or changed option
 * (`-o HostName=x`, `-F f`, `-J h`, a changed `%h`) is a different command and
 * stays fail-closed. It is accepted only from the process environment
 * (`GIT_SSH_COMMAND`), NEVER from `core.sshCommand`, which is git config an
 * agent can write.
 *
 * Residual: the proxy command comes from `SRT_SSH_PROXY_COMMAND`, which the
 * sandbox sets. An agent that can write shell startup files could export its
 * own `SRT_SSH_PROXY_COMMAND` and redirect the connection (the R8 class, plan
 * §8.2: the environment a hook or hook-guarded command gets is not fully
 * under the guard's eye).
 */
export const SANDBOX_GIT_SSH_COMMAND =
  "ssh -o ControlMaster=no -o ControlPath=none -o ProxyCommand=\"/bin/sh -c 'eval \\\"\\${SRT_SSH_PROXY_COMMAND:?unset, but GIT_SSH_COMMAND needs it}\\\"' sh '%h' %p\"";

/** Is `command` exactly {@link SANDBOX_GIT_SSH_COMMAND}, modulo runs of whitespace? */
export function isSandboxSshCommand(command: string): boolean {
  return command.trim().replace(/\s+/g, " ") === SANDBOX_GIT_SSH_COMMAND;
}

/** `-o HostName=…`, a proxy, `-J` (jump host) or `-F` (another config): ways an ssh command moves a connection. */
const REDIRECTING_SSH_OPTION_RE = /host\s*name|proxy|(^|\s)-[JF]/i;

/**
 * The ssh override in effect where a push runs (see `SshOverride`):
 * `GIT_SSH_COMMAND`, `GIT_SSH`, `GIT_SSH_VARIANT` in `env`, or `core.sshCommand`
 * in the git config seen from `cwd` (which includes `git -c`, passed down to
 * hooks). Callers pass the environment the push will run with: the pre-push
 * hook and the agent hook both see it as git does.
 */
export function detectSshOverride(cwd: string, env: NodeJS.ProcessEnv = process.env): SshOverride {
  const command = (env["GIT_SSH_COMMAND"] ?? "").trim();
  const program = (env["GIT_SSH"] ?? "").trim();
  const variant = (env["GIT_SSH_VARIANT"] ?? "").trim();
  // The one override we recognise as host-preserving: Claude Code's sandbox
  // template, taken from the ENVIRONMENT only. With it, git ignores
  // `core.sshCommand` and `GIT_SSH` (`GIT_SSH_COMMAND` wins over both), so
  // they cannot change anything; `GIT_SSH_VARIANT` alone is not trusted here.
  if (command !== "" && isSandboxSshCommand(command) && program === "" && variant === "") {
    return { present: false, mayRedirect: false };
  }
  const configured = (gitOut(cwd, ["config", "--get", "core.sshCommand"]) ?? "").trim();
  const present = command !== "" || program !== "" || variant !== "" || configured !== "";
  // A GIT_SSH program is opaque, so it may redirect; a command line can be read.
  const mayRedirect =
    program !== "" || REDIRECTING_SSH_OPTION_RE.test(command) || REDIRECTING_SSH_OPTION_RE.test(configured);
  return { present, mayRedirect: present && mayRedirect };
}
