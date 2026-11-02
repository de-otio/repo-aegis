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
//     goes to whatever receives it.
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

function writesGithubApi(c: SimpleCommand): boolean {
  if (!c.args.some(a => GITHUB_API_HOST_RE.test(a))) return false;
  if (c.cmd === "curl") return curlWrites(c.args);
  if (c.cmd === "wget") return wgetWrites(c.args);
  return false;
}

/** Programs that open a network connection of their own. */
const NETWORK_COMMANDS: ReadonlySet<string> = new Set([
  "curl", "wget", "http", "https", "xh", "xhs", "nc", "ncat", "netcat", "socat", "telnet", "ssh", "scp", "sftp", "ftp",
]);

/**
 * R6: the refusal for a command line that sends a write to the GitHub API with a raw HTTP client, or reads
 * the gh token in a line that also makes a network call; null when it does neither. Pure; never throws.
 */
export function checkNetworkRules(command: string): NetworkRuleHit | null {
  // Cheap exit: almost every command mentions neither.
  if (!/github\.com|auth/i.test(command)) return null;
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

  const tokenReader = commands.some(c => {
    if (c.cmd !== "gh") return false;
    const words = ghCommandWords(c.args);
    return words !== null && words.group === "auth" && words.sub === "token";
  });
  if (tokenReader && commands.some(c => NETWORK_COMMANDS.has(c.cmd))) {
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
