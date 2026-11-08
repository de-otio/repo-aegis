// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// R6 (doc/plan-unregistered-owner-egress.md §8.2): the cheap hook rules for paths that bypass the `git` /
// `gh` verb model entirely.
//
//   - GITHUB_API_VIA_HTTP_CLIENT: `curl` / `wget` against `api.github.com` or `uploads.github.com` with a
//     write method (`-X POST|PUT|PATCH|DELETE`) or a data flag. A raw HTTP client reaches any owner and the
//     guard cannot name it.
//   - GH_AUTH_TOKEN_NETWORK: `gh auth token` in a command line that also makes a network call. The token
//     goes to whatever receives it. A `git` subcommand that only works on the local repository (`tag`,
//     `log`, `status`, …) is not a network call; every other git invocation is.
//
// Both are shape rules: they read the command text only, need no registry, and no approval lifts them. This
// is a speed bump, not a proof (an interpreter's `-c` text or a script can still do both); the plan names it
// so nobody assumes coverage. The functions are pure, total and return a ready-made five-part refusal.

import { ghCommandWords, simpleCommands, type SimpleCommand } from "./egress-intent.js";
import { refusal } from "./refusal.js";

export type NetworkRuleCode = "GITHUB_API_VIA_HTTP_CLIENT" | "GH_AUTH_TOKEN_NETWORK";

export interface NetworkRuleHit {
  code: NetworkRuleCode;
  reason: string;
}

/** `api.github.com` / `uploads.github.com` as a host inside an argument (a URL, `--url=…`, a bare host). */
const GITHUB_API_HOST_RE = /(?:^|[^\w.-])(?:api|uploads)\.github\.com(?![\w-]|\.[\w-])/i;

const WRITE_METHODS: ReadonlySet<string> = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** curl long options that send a body. */
const CURL_DATA_LONG: readonly string[] = [
  "--data",
  "--data-raw",
  "--data-binary",
  "--data-urlencode",
  "--data-ascii",
  "--json",
  "--form",
  "--form-string",
  "--upload-file",
];
/** curl short options that send a body: `-d`, `-F`, `-T`. */
const CURL_DATA_SHORT = new Set(["d", "F", "T"]);
/** curl short options that take a value (so the rest of the token, or the next one, is that value). */
const CURL_VALUE_SHORT = new Set("oHuAebcmwxKEUyYzCDPQrt".split(""));

const WGET_DATA_LONG: readonly string[] = ["--post-data", "--post-file", "--body-data", "--body-file"];

function longFlagValue(args: readonly string[], i: number, flag: string): string | undefined {
  const a = args[i]!;
  if (a === flag) return args[i + 1];
  if (a.startsWith(`${flag}=`)) return a.slice(flag.length + 1);
  return undefined;
}

/** Whether a curl invocation writes: a write method or a data flag. */
function curlWrites(args: readonly string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (!a.startsWith("-") || a === "-") continue;
    if (a.startsWith("--")) {
      if (CURL_DATA_LONG.some(f => a === f || a.startsWith(`${f}=`))) return true;
      const m = longFlagValue(args, i, "--request");
      if (m !== undefined && WRITE_METHODS.has(m.toUpperCase())) return true;
      continue;
    }
    // A group of short options: `-sSX POST`, `-XPOST`, `-d@file`, `-sd body`.
    for (let j = 1; j < a.length; j++) {
      const ch = a[j]!;
      if (CURL_DATA_SHORT.has(ch)) return true;
      if (ch === "X") {
        const rest = a.slice(j + 1);
        const value = rest !== "" ? rest.replace(/^=/, "") : args[i + 1];
        if (value !== undefined && WRITE_METHODS.has(value.toUpperCase())) return true;
        break;
      }
      if (CURL_VALUE_SHORT.has(ch)) break; // the rest of the token (or the next one) is this option's value
    }
  }
  return false;
}

/** Whether a wget invocation writes: `--method=<write method>` or a body option. */
function wgetWrites(args: readonly string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (WGET_DATA_LONG.some(f => a === f || a.startsWith(`${f}=`))) return true;
    const m = longFlagValue(args, i, "--method");
    if (m !== undefined && WRITE_METHODS.has(m.toUpperCase())) return true;
  }
  return false;
}

/** curl reads URLs and options from a config file: `-K file`, `--config file`, `-K -`. */
function curlUsesConfig(args: readonly string[]): boolean {
  return args.some(a => a === "--config" || a.startsWith("--config=") || (/^-[A-Za-z]*K/.test(a) && !a.startsWith("--")));
}

const HTTPIE_COMMANDS: ReadonlySet<string> = new Set(["http", "https", "xh", "xhs"]);

/**
 * Whether an httpie / xh invocation writes: a method word (`POST`, `PUT`, `PATCH`, `DELETE`) or a data item
 * (`key=value`, `key:=json`, `key=@file`, `key@file`), but not a query item (`key==value`) or a header
 * (`Key:Value`), or a body option (`--raw`, `--form`, `--json`, `--multipart`).
 */
function httpieWrites(args: readonly string[]): boolean {
  for (const a of args) {
    if (WRITE_METHODS.has(a.toUpperCase()) && /^[A-Za-z]+$/.test(a)) return true;
    if (a === "--raw" || a.startsWith("--raw=") || a === "--form" || a === "--json" || a === "--multipart") return true;
    if (/^-[A-Za-z]*[fj]/.test(a) && !a.startsWith("--") && a.length <= 3) return true;
    if (/^[A-Za-z0-9_.\-\[\]]+(?::=|=(?!=)|=@|@)/.test(a) && !/^[a-z][a-z0-9+.-]*:\/\//i.test(a)) return true;
  }
  return false;
}

function writesGithubApi(c: SimpleCommand): boolean {
  const hostPresent = c.args.some(a => GITHUB_API_HOST_RE.test(a));
  if (c.cmd === "curl") {
    // A config file can carry the URL and the body: with no URL on the command line it may be this API.
    if (curlUsesConfig(c.args) && (hostPresent || !c.args.some(a => /^[a-z][a-z0-9+.-]*:\/\//i.test(a)))) return true;
    return hostPresent && curlWrites(c.args);
  }
  if (!hostPresent) return false;
  if (c.cmd === "wget") return wgetWrites(c.args);
  if (HTTPIE_COMMANDS.has(c.cmd)) return httpieWrites(c.args);
  return false;
}

/** Programs that open a network connection of their own. `git` is judged by its subcommand instead. */
const NETWORK_COMMANDS: ReadonlySet<string> = new Set([
  "curl", "wget", "http", "https", "xh", "xhs", "nc", "ncat", "netcat", "socat", "telnet", "ssh", "scp", "sftp", "ftp",
  // interpreters can open a connection of their own
  "node", "perl", "ruby",
]);

/**
 * Built-in git subcommands that work on the local repository only. A positive list: anything else (`push`,
 * `fetch`, `pull`, `clone`, `ls-remote`, `remote`, `submodule`, `send-email`, `archive --remote`,
 * `maintenance` prefetch, an alias, an external `git-<name>`) counts as a network call. Accepted limit: in a
 * partial clone some of these lazily fetch missing objects from the configured remote.
 */
const GIT_LOCAL_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "add", "annotate", "blame", "branch", "cat-file", "check-attr", "check-ignore", "checkout", "cherry", "commit",
  "config", "count-objects", "describe", "diff", "diff-files", "diff-index", "diff-tree", "for-each-ref", "grep",
  "hash-object", "help", "init", "log", "ls-files", "ls-tree", "merge-base", "mv", "name-rev", "reflog", "restore",
  "rev-list", "rev-parse", "rm", "shortlog", "show", "show-branch", "show-ref", "stash", "status", "switch",
  "symbolic-ref", "tag", "var", "version", "whatchanged",
]);

/** git global options that take the next word as their value and cannot change what runs or where it goes. */
const GIT_SAFE_GLOBALS_WITH_VALUE: ReadonlySet<string> = new Set(["-C", "--git-dir", "--work-tree", "--namespace"]);
/** git global options with no value that cannot change what runs or where it goes. */
const GIT_SAFE_GLOBAL_FLAGS: ReadonlySet<string> = new Set([
  "-p", "--paginate", "-P", "--no-pager", "--bare", "--no-replace-objects", "--literal-pathspecs",
  "--glob-pathspecs", "--noglob-pathspecs", "--icase-pathspecs", "--no-optional-locks",
]);

/**
 * Whether a `git` invocation may open a network connection. Fails closed: any global option not known to be
 * harmless (`-c`, `--config-env` and `--exec-path` can turn a local subcommand into anything), a subcommand
 * with a shell expansion, a missing subcommand, or one not on {@link GIT_LOCAL_SUBCOMMANDS} counts as one.
 */
function gitMayReachNetwork(args: readonly string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (!a.startsWith("-")) return /[$`]/.test(a) || !GIT_LOCAL_SUBCOMMANDS.has(a);
    const name = a.includes("=") ? a.slice(0, a.indexOf("=")) : a;
    if (GIT_SAFE_GLOBALS_WITH_VALUE.has(name)) {
      if (name === a) i++; // the value is the next word
      continue;
    }
    if (GIT_SAFE_GLOBAL_FLAGS.has(a)) continue;
    return true;
  }
  return true;
}

function isNetworkCommand(c: SimpleCommand): boolean {
  if (c.cmd === "git") return gitMayReachNetwork(c.args);
  return NETWORK_COMMANDS.has(c.cmd) || /^python[\d.]*$/.test(c.cmd);
}

/** `gh auth token`, and `gh auth status --show-token` / `-t`, which prints the same credential. */
function readsGhToken(c: SimpleCommand): boolean {
  if (c.cmd !== "gh") return false;
  const words = ghCommandWords(c.args);
  if (words === null || words.group !== "auth") return false;
  if (words.sub === "token") return true;
  return words.sub === "status" && c.args.some(a => a === "--show-token" || /^-[A-Za-z]*t[A-Za-z]*$/.test(a));
}

/**
 * R6: the refusal for a command line that sends a write to the GitHub API with a raw HTTP client, or reads
 * the gh token in a line that also makes a network call; null when it does neither. Pure; never throws.
 */
export function checkNetworkRules(command: string): NetworkRuleHit | null {
  // Cheap exit: almost every command mentions neither.
  if (!/github\.com|auth|(?:^|\s)-[A-Za-z]*K|--config/i.test(command)) return null;
  const commands = simpleCommands(command);

  const writer = commands.find(writesGithubApi);
  if (writer !== undefined) {
    return {
      code: "GITHUB_API_VIA_HTTP_CLIENT",
      reason: refusal({
        code: "GITHUB_API_VIA_HTTP_CLIENT",
        what: `${writer.cmd} → the GitHub API (write)`,
        why:
          "Writing to the GitHub API with a raw HTTP client reaches any owner and carries a token that repo-aegis " +
          "does not scope, so it cannot tell where the bytes go or check the owner the way it does for gh",
        approval: "No approval covers this",
        fixes: [
          {
            by: "agent",
            when: "To write to a repository",
            command: "gh api -X <METHOD> repos/<owner>/<repo>/… (or a gh verb with --repo <owner>/<repo>)",
            note: "gh writes are checked like any other publish",
          },
          { by: "person" },
        ],
      }),
    };
  }

  const tokenReader = commands.some(readsGhToken);
  if (tokenReader && commands.some(isNetworkCommand)) {
    return {
      code: "GH_AUTH_TOKEN_NETWORK",
      reason: refusal({
        code: "GH_AUTH_TOKEN_NETWORK",
        what: "gh auth token (in a command that makes a network call)",
        why:
          "The gh token would be handed to whatever the network call reaches, outside every owner check, so repo-aegis " +
          "cannot tell who receives the credential",
        approval: "No approval covers this",
        fixes: [
          {
            by: "agent",
            when: "To call the GitHub API",
            command: "gh api … (gh uses its own credential and the call is checked)",
          },
          { by: "person" },
        ],
      }),
    };
  }
  return null;
}
