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
import { realpathSync } from "node:fs";
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
 * BUT the template is only half of the trust: its ProxyCommand does
 * `eval "$SRT_SSH_PROXY_COMMAND"`, and that variable is plain environment that
 * ONE agent command can set (`SRT_SSH_PROXY_COMMAND='…github.com…' git push
 * git@zz:stranger/r.git main`): the guard would judge `zz` as another host
 * while ssh lands on github.com. So the template is trusted only together with
 * an `SRT_SSH_PROXY_COMMAND` of the sandbox's fixed shape
 * ({@link isSandboxProxyCommand}), in the same environment. This is not a
 * startup-file (R8) case; it is a one-command bypass, and it is closed here.
 *
 * Residual: a variable of the right shape cannot redirect (host and port come
 * only from the positional arguments ssh passes), so what remains is the
 * sandbox's own integrity: the proxy it points at (`127.0.0.1:<port>`) is
 * trusted to connect to the host it is asked for.
 */
export const SANDBOX_GIT_SSH_COMMAND =
  "ssh -o ControlMaster=no -o ControlPath=none -o ProxyCommand=\"/bin/sh -c 'eval \\\"\\${SRT_SSH_PROXY_COMMAND:?unset, but GIT_SSH_COMMAND needs it}\\\"' sh '%h' %p\"";

/** Is `command` exactly {@link SANDBOX_GIT_SSH_COMMAND}, modulo runs of whitespace? */
export function isSandboxSshCommand(command: string): boolean {
  return command.trim().replace(/\s+/g, " ") === SANDBOX_GIT_SSH_COMMAND;
}

/**
 * The shape of the `SRT_SSH_PROXY_COMMAND` the Claude Code sandbox exports,
 * written from its structure. Everything is fixed text except two values, which
 * match only their own character classes: the per-session proxy credential
 * (base64) and the proxy's port (digits). The host and port the connection
 * goes to come ONLY from the positional arguments (`$1`, `$2`, formatted as
 * `$1:$2` into a `CONNECT`), validated by the script itself, and the connection
 * goes to `127.0.0.1:<port>` through `/usr/bin/nc`.
 *
 * Any other text, a hard-coded host, a different address, another binary, an
 * extra command, fails the match. No credential value appears in this file or
 * in any test: tests build a fake one from the same pieces.
 */
const SANDBOX_PROXY_TEMPLATE_PARTS: readonly [string, string, string] = [
  String.raw`LC_ALL=C; no() { printf "sandbox proxy: %s\n" "$*" >&2; exit 1; }; case $1 in ""|*[!A-Za-z0-9._:-]*) no bad host;; *:*) set -- "[$1]" "$2";; esac; case $2 in ""|*[!0-9]*) no bad port;; esac; exec 3<&0; { printf "CONNECT %s HTTP/1.1\r\nHost: %s\r\nProxy-Authorization: Basic `,
  String.raw`\r\n\r\n" "$1:$2" "$1:$2"; exec /bin/cat <&3; } | /usr/bin/nc 127.0.0.1 `,
  String.raw` | { read -r v why; while read -r v; do case $v in ""|?) break;; esac; done; case $why in "200 "*) exec /bin/cat;; esac; why=@@{why%?}; no "$1:$2: @@{why:-no answer}"; } & exec >&-; wait $!`,
].map(p => p.replaceAll("@@{", "$" + "{")) as unknown as readonly [string, string, string];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const SANDBOX_PROXY_RE = new RegExp(
  `^${escapeRegExp(SANDBOX_PROXY_TEMPLATE_PARTS[0])}[A-Za-z0-9+/=]{8,2048}` +
    `${escapeRegExp(SANDBOX_PROXY_TEMPLATE_PARTS[1])}[0-9]{1,5}${escapeRegExp(SANDBOX_PROXY_TEMPLATE_PARTS[2])}$`,
);

/** Is `value` an `SRT_SSH_PROXY_COMMAND` of the sandbox's fixed shape (any credential, any port)? */
export function isSandboxProxyCommand(value: string | undefined): boolean {
  return value !== undefined && SANDBOX_PROXY_RE.test(value);
}

/**
 * Build a well-shaped proxy command around a given credential and port. Test
 * support: lets tests use a FAKE credential, so no real one is ever a fixture.
 */
export function sandboxProxyCommandFor(credential: string, port: number): string {
  const [a, b, c] = SANDBOX_PROXY_TEMPLATE_PARTS;
  return `${a}${credential}${b}${port}${c}`;
}

/**
 * Everything the shell that runs the trusted proxy script reads from the
 * environment, and why each is checked (ssh runs a ProxyCommand as
 * `$SHELL -c <command>`, and the command `eval`s the script):
 *
 *  - `SHELL`: names the program that runs the command. An arbitrary path IS
 *    the proxy. Allowed: unset (ssh then uses /bin/sh), or exactly
 *    /bin/{sh,bash,zsh,dash,ksh} or /usr/bin/ of those. A realpath is used only
 *    to reject a symlink that leaves that set.
 *  - `BASH_FUNC_<name>%%`: bash (macOS /bin/sh is bash 3.2) imports exported
 *    functions from these variables, so a function named `printf` or `read`
 *    hijacks a builtin the script calls. Any such name is untrusted.
 *  - `SHELLOPTS`, `BASHOPTS`: bash applies them at startup (`xtrace`,
 *    `posix`, …), changing how the script runs; with `PS4` they can also run
 *    command substitutions on trace output.
 *  - `BASH_ENV`, `ENV`: a startup file the non-interactive shell sources before
 *    the script runs.
 *
 * Not checked here because they are the script's own inputs, fixed by its
 * shape: its arguments (`%h`, `%p`) and `SRT_SSH_PROXY_COMMAND` itself.
 * `PATH` is not consulted: the script calls `/bin/cat` and `/usr/bin/nc` by
 * absolute path and uses only shell builtins besides.
 */
const PROXY_SHELLS: ReadonlySet<string> = new Set(
  ["sh", "bash", "zsh", "dash", "ksh"].flatMap(n => [`/bin/${n}`, `/usr/bin/${n}`]),
);

/** Whether the environment leaves the trusted proxy script running as the sandbox wrote it. */
export function proxyShellEnvIsClean(env: NodeJS.ProcessEnv): boolean {
  const shell = env["SHELL"];
  if (shell !== undefined && shell !== "") {
    if (!PROXY_SHELLS.has(shell)) return false;
    try {
      if (!PROXY_SHELLS.has(realpathSync(shell))) return false;
    } catch {
      return false;
    }
  }
  if (Object.keys(env).some(k => k.startsWith("BASH_FUNC_"))) return false;
  for (const k of ["SHELLOPTS", "BASHOPTS", "PS4", "BASH_ENV", "ENV"]) if (env[k] !== undefined) return false;
  return true;
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
  // template, taken from the ENVIRONMENT only, AND only together with a
  // sandbox-shaped `SRT_SSH_PROXY_COMMAND` in the same environment (the
  // template `eval`s it) and a clean shell environment (`proxyShellEnvIsClean`).
  // `GIT_SSH_VARIANT` and `GIT_SSH` alongside are not trusted.
  if (command !== "" && isSandboxSshCommand(command)) {
    if (
      isSandboxProxyCommand(env["SRT_SSH_PROXY_COMMAND"]) &&
      proxyShellEnvIsClean(env) &&
      program === "" &&
      variant === ""
    ) {
      return { present: false, mayRedirect: false };
    }
    // The template with a missing or foreign proxy command can send the
    // connection anywhere: an override that may redirect.
    return { present: true, mayRedirect: true };
  }
  const configured = (gitOut(cwd, ["config", "--get", "core.sshCommand"]) ?? "").trim();
  const present = command !== "" || program !== "" || variant !== "" || configured !== "";
  // A GIT_SSH program is opaque, so it may redirect; a command line can be read.
  const mayRedirect =
    program !== "" || REDIRECTING_SSH_OPTION_RE.test(command) || REDIRECTING_SSH_OPTION_RE.test(configured);
  return { present, mayRedirect: present && mayRedirect };
}
