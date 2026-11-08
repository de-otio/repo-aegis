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

import { commandFacts, ghCommandWords, simpleCommands, type CommandFact, type SimpleCommand } from "./egress-intent.js";
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

// ---------------------------------------------------------------------------
// Identity hook rules (doc/plan-owner-identity.md §13.2: A1, A10, N9)
// ---------------------------------------------------------------------------
//
// Shape rules over the command text, like the R6 rules above, but they run on EVERY agent command, egress
// or not (the `intents.length === 0` exit in the hook no longer comes first for them):
//
//   - A1: a command that runs `gh`, `git`, `taaad` or `security` with a `REPO_AEGIS_*` variable set
//     (EGRESS_ENV_OVERRIDE), or under a terminal-providing wrapper (EGRESS_PTY_WRAPPER). No presence, approval
//     or environment variable lifts it: text is how an agent steers the next layer's idea of "a person".
//   - A10: `gh auth <anything but a plain status>`, `gh config set|clear-cache`, `gh alias set|import|delete`,
//     `gh extension install|upgrade|exec` (GH_AUTH_NEEDS_HUMAN): they read or change which account gh acts as.
//   - N9: `taaad env|agent|credential-helper|mint`, the keychain readers of `security`, and an interpreter
//     one-liner that imports `keyring` or names `SecItemCopyMatching` (TOKEN_MINT_NEEDS_HUMAN).
//
// A10 and N9 are lifted when a person is present; A1 never is. A10 and N9 are speed bumps, not proofs (a
// script file, an obfuscated string or another interpreter still gets through); the keychain ACLs are the
// control. Pure, total, no registry.

export type IdentityHookRuleCode = "EGRESS_ENV_OVERRIDE" | "EGRESS_PTY_WRAPPER" | "GH_AUTH_NEEDS_HUMAN" | "TOKEN_MINT_NEEDS_HUMAN";

export interface IdentityHookHit {
  code: IdentityHookRuleCode;
  reason: string;
  /** True when a person at the keyboard lifts the rule (A10, N9). A1 hits are never lifted. */
  personLifts: boolean;
}

/** Programs whose run under a `REPO_AEGIS_*` variable or a terminal wrapper A1 refuses. */
const A1_PROGRAMS: ReadonlySet<string> = new Set(["gh", "git", "taaad", "security"]);

/** Whether `word` (a path or bare name) is one of the A1 programs. */
function isA1Program(word: string): boolean {
  const base = word.slice(word.lastIndexOf("/") + 1);
  return A1_PROGRAMS.has(base);
}

/** Whether a free text (a wrapper's arguments, a heredoc) names an A1 program as a word. */
function mentionsA1Program(text: string): boolean {
  return text.split(/[^A-Za-z0-9_./~-]+/).some(w => w !== "" && isA1Program(w));
}

function a1Env(c: CommandFact): boolean {
  if (c.repoAegisEnv.length === 0) return false;
  if (isA1Program(c.cmd)) return true;
  // `dot gh …` runs gh with the caller's environment.
  return c.cmd === "dot" && c.args.includes("gh");
}

/** `gh auth …` other than a plain `status`, `gh config set|clear-cache`, `gh alias set|import|delete`, `gh extension install|upgrade|exec`. */
export function ghVerbChangesIdentityState(args: readonly string[]): boolean {
  const words = ghCommandWords(args);
  if (words === null) return false;
  const { group, sub } = words;
  switch (group) {
    case "auth":
      if (sub === "status") return args.some(a => a === "--show-token" || /^-[A-Za-z]*t[A-Za-z]*$/.test(a));
      return true;
    case "config":
      return sub === "set" || sub === "clear-cache";
    case "alias":
      return sub === "set" || sub === "import" || sub === "delete";
    case "extension":
    case "extensions":
    case "ext":
      return sub === "install" || sub === "upgrade" || sub === "exec";
    default:
      return false;
  }
}

const TAAAD_TOKEN_SUBCOMMANDS: ReadonlySet<string> = new Set(["env", "agent", "credential-helper", "mint"]);
const SECURITY_KEYCHAIN_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "find-generic-password", "find-internet-password", "dump-keychain", "export", "unlock-keychain",
]);
const KEYCHAIN_INTERPRETER_RE = /^(?:python[\d.]*|node(?:js)?|perl|ruby|osascript)$/;
const KEYCHAIN_TEXT_RE = /\bkeyring\b|SecItemCopyMatching/;

/** The program text an interpreter would run: the value of `-c` / `-e` / `-m` style options, text-like words, and stdin texts. */
function interpreterTexts(c: CommandFact): string[] {
  const out: string[] = [];
  for (let i = 0; i < c.args.length; i++) {
    const a = c.args[i]!;
    if (/^-[A-Za-z]*[ceEpm]$/.test(a) || a === "--eval" || a === "--print") {
      if (c.args[i + 1] !== undefined) out.push(c.args[i + 1]!);
    } else if (/^--(?:eval|print)=/.test(a) || /^-[ceEp].+/.test(a)) {
      out.push(a);
    } else if (/[\s;(]/.test(a)) {
      out.push(a);
    }
  }
  if (c.text !== undefined) out.push(c.text);
  return out;
}

function readsKeychainSecret(c: CommandFact): boolean {
  if (c.cmd === "taaad") return c.args.some(a => TAAAD_TOKEN_SUBCOMMANDS.has(a));
  if (c.cmd === "security") return c.args.some(a => SECURITY_KEYCHAIN_SUBCOMMANDS.has(a));
  if (KEYCHAIN_INTERPRETER_RE.test(c.cmd)) return interpreterTexts(c).some(t => KEYCHAIN_TEXT_RE.test(t));
  return false;
}

function a1Reason(code: "EGRESS_ENV_OVERRIDE" | "EGRESS_PTY_WRAPPER", what: string): string {
  if (code === "EGRESS_ENV_OVERRIDE") {
    return refusal({
      code,
      what,
      why:
        "The command sets a REPO_AEGIS_* variable for a program that acts as an account (gh, git, taaad or security), " +
        "which can make repo-aegis read a different registry or treat the caller as a person, whatever the command " +
        "publishes",
      approval: "No approval covers this",
      fixes: [{ by: "agent", command: `${what} …`, note: "with no REPO_AEGIS_* assignment or export" }],
    });
  }
  return refusal({
    code,
    what,
    why:
      "Running gh, git, taaad or security under a terminal wrapper gives it a terminal, and repo-aegis treats a " +
      "terminal as a person, so the wrapper could stand in for the human whose presence changes what is allowed",
    approval: "No approval covers this",
    fixes: [
      { by: "agent", command: `${what} run directly`, note: "without script, unbuffer, expect, tmux, screen, socat, ssh -t or a pty module" },
      { by: "person", when: "If it needs a person", step: "runs it from their own terminal" },
    ],
  });
}

function ghAuthReason(): string {
  return refusal({
    code: "GH_AUTH_NEEDS_HUMAN",
    what: "gh auth, config, alias or extension change",
    why:
      "These gh commands read a token or change which account, alias or extension gh runs as, and with no person " +
      "present repo-aegis cannot tell whose credential would be read or replaced",
    approval: "No approval covers this",
    fixes: [
      { by: "agent", when: "To act on a repository", command: "gh <verb> --repo <owner>/<repo> …", note: "plain gh; repo-aegis chooses the identity" },
      { by: "person", when: "If the account setup itself must change", step: "runs the command from their own terminal" },
    ],
  });
}

function tokenMintReason(): string {
  return refusal({
    code: "TOKEN_MINT_NEEDS_HUMAN",
    what: "reading or minting a credential (taaad, security or a keychain call)",
    why:
      "These commands hand out an App token or read a stored secret, and with no person present repo-aegis cannot " +
      "tell who receives it",
    approval: "No approval covers this",
    fixes: [
      { by: "agent", when: "To act on a repository", command: "gh <verb> --repo <owner>/<repo> …", note: "plain gh; repo-aegis chooses the identity" },
      { by: "person", when: "If a credential must be read or minted", step: "runs the command from their own terminal" },
    ],
  });
}

/**
 * Every identity hook rule the command line trips, in the order A1 (never lifted), A10, N9 (lifted when a
 * person is present). Empty for almost every command. Pure; never throws.
 */
export function checkIdentityHookRules(command: string): IdentityHookHit[] {
  const hits: IdentityHookHit[] = [];
  let facts: CommandFact[];
  try {
    facts = commandFacts(command);
  } catch {
    return hits;
  }
  for (const c of facts) {
    if (c.ptyWrapper !== undefined && (isA1Program(c.cmd) || mentionsA1Program(c.text ?? "") || mentionsA1Program(c.args.join(" ")))) {
      hits.push({ code: "EGRESS_PTY_WRAPPER", reason: a1Reason("EGRESS_PTY_WRAPPER", `${c.ptyWrapper} around gh/git/taaad/security`), personLifts: false });
    }
  }
  for (const c of facts) {
    if (a1Env(c)) {
      hits.push({ code: "EGRESS_ENV_OVERRIDE", reason: a1Reason("EGRESS_ENV_OVERRIDE", `${c.cmd} with a REPO_AEGIS_* variable`), personLifts: false });
    }
  }
  if (facts.some(c => c.cmd === "gh" && ghVerbChangesIdentityState(c.args))) {
    hits.push({ code: "GH_AUTH_NEEDS_HUMAN", reason: ghAuthReason(), personLifts: true });
  }
  if (facts.some(readsKeychainSecret)) {
    hits.push({ code: "TOKEN_MINT_NEEDS_HUMAN", reason: tokenMintReason(), personLifts: true });
  }
  return hits;
}

/**
 * The refusal to apply, or null: the first A1 hit, else the first A10 / N9 hit unless `humanPresent()` says a
 * person is there. `humanPresent` is called at most once, and only when a liftable rule is the only hit.
 */
export function decideIdentityHookRules(command: string, humanPresent: () => boolean): IdentityHookHit | null {
  const hits = checkIdentityHookRules(command);
  const always = hits.find(h => !h.personLifts);
  if (always !== undefined) return always;
  if (hits.length === 0) return null;
  return humanPresent() ? null : hits[0]!;
}
