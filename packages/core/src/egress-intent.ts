// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// Egress-intent extraction: turn a shell command line into the list of
// *publishing* operations it would perform, with the facts the egress
// policy needs about each one (doc/design/egress-guard.md §1).
//
// This is the parser half of "one decision function, several enforcement
// points". It is pure — text in, intents out — and total: it never throws,
// because it runs inside pre-command hooks where an exception would surface
// to the agent as a tool failure instead of a decision. It fails CLOSED: a
// segment that runs `gh` or `git push` — directly or through a wrapper,
// interpreter, alias or substitution — and whose verb or target it cannot
// determine yields an intent with `unresolved` set, never "no intent". Only a
// command that is positively something else (or a known read) yields nothing.
//
// What it recognises today: `git push`, the mutating `gh` verbs, and
// `npm|pnpm|yarn publish`. What it deliberately does not attempt: a full
// POSIX shell grammar. Quotes, backslash escapes, `$(...)` / backtick
// substitution, `${...}`, redirections, heredocs, comments and the segment
// operators (`;`, `&&`, `||`, `|`, `&`, newline) are handled well enough
// that the two incident commands and their obvious variants classify
// correctly; exotic constructs degrade to a fail-closed `unresolved` intent
// when they involve `gh` or `git push`, and to "no intent" otherwise — never
// to a crash.

import { posix } from "node:path";
import { GH_COMMAND_FLAGS } from "./gh-flags.js";

/** The publishing operations the policy knows how to judge. */
export type EgressVerb =
  | "git-push"
  | "gh-pr-create"
  | "gh-pr-edit"
  | "gh-pr-merge"
  | "gh-pr-comment"
  | "gh-pr-review"
  | "gh-issue-create"
  | "gh-issue-edit"
  | "gh-issue-comment"
  | "gh-release-create"
  | "gh-release-edit"
  | "gh-release-upload"
  | "gh-repo-create"
  | "gh-repo-edit"
  | "gh-gist-create"
  | "gh-workflow-run"
  /**
   * A `gh` shell alias (`gh alias set --shell …`). Its body is an arbitrary
   * script, so what it publishes cannot be read offline; always carries
   * `unresolved: "gh-alias"`.
   */
  | "gh-alias-shell"
  /**
   * A `gh` invocation whose verb the parser cannot determine: an unknown first
   * word (an alias it cannot read, an extension, a brace expansion), a built-in
   * group with no shape here (`project`, `codespace`, …), or a line it could not
   * parse. Always carries `unresolved`.
   */
  | "gh-unknown"
  /** `gh api` with `-X POST|PATCH|PUT|DELETE`, or with fields and no explicit method (gh then POSTs). */
  | "gh-api-mutating"
  | "npm-publish";

/**
 * Why an intent's destination cannot be named offline (issue #151, §3.3). The
 * parser never turns an unresolvable target into "no intent": the intent is
 * emitted with one of these, and the policy treats the destination as unknown.
 *
 * - `env-override`: an earlier segment of the same command line exports or
 *   assigns `GH_REPO`, so the value gh will see is not the one the hook sees;
 * - `gh-alias`: a `gh` shell alias, whose script is opaque;
 * - `opaque-repo`: a repository slot (`--repo`, `GH_REPO`, a URL or `o/r`
 *   positional, `--org`, …) holds something that is not a literal repository
 *   (`$REPO`, `$(…)`, a bare word);
 * - `unknown-shape`: a `gh` subcommand of a write group that is neither a
 *   known write verb nor a known read verb;
 * - `ambiguous-target`: produced by the resolver (not the parser) when an
 *   intent names more than one distinct repository;
 * - `unparsed-shape`: the command line could not be taken apart (a parse
 *   failure, nesting deeper than the parser follows, `xargs`-fed arguments, a
 *   brace-expanded command word, a `-C`/`--git-dir` the parser cannot name).
 *
 * `gh-alias` also covers any first word that is not a built-in `gh` command
 * and not an alias the parser can resolve: an extension, a typo, an alias
 * invoked after leading flags, or an alias file it could not read.
 */
export type IntentUnresolved =
  | "env-override"
  | "gh-alias"
  | "opaque-repo"
  | "unknown-shape"
  | "ambiguous-target"
  | "unparsed-shape";

/** The shell operator that joined a segment to its predecessor. */
export type SegmentJoin = ";" | "&&" | "||" | "|" | "&" | "\n" | null;

export interface EgressIntent {
  verb: EgressVerb;
  /** `git push`: the remote (name or URL) if given as a positional. */
  remote?: string;
  /** `git push`: the first refspec if given as a positional. */
  refspec?: string;
  /** `gh … --repo o/r` (or `-R`), verbatim, when present. */
  repoFlag?: string;
  /**
   * `GH_REPO` as the real `gh` will see it, normalised to `owner/repo`: from a
   * command-prefix assignment (`GH_REPO=o/r gh …`, `env GH_REPO=o/r gh …`),
   * else from the caller's environment ({@link ParseEgressOptions.envRepo}).
   * Present only when it APPLIES to this intent — gh's own precedence is
   * `--repo` over `GH_REPO`, and a repository named by a URL/`o/r` positional
   * or an explicit `repos/<o>/<r>/…` endpoint beats both.
   */
  envRepo?: string;
  /**
   * The first repository this verb names positionally or through a
   * verb-specific flag (`gh pr comment <url>`, `gh repo edit <o>/<r>`,
   * `gh issue transfer <n> <o>/<r>`, `gh issue develop --branch-repo`,
   * `gh secret set --org`, …), normalised and lower-cased: `owner/repo`, or a
   * bare `owner` for an org-level target. See {@link intentRepoTargets}.
   */
  positionalRepo?: string;
  /** Every further target of the kind {@link positionalRepo} describes. */
  extraRepos?: string[];
  /** Set when the destination cannot be named offline; see {@link IntentUnresolved}. */
  unresolved?: IntentUnresolved;
  /**
   * `gh api`: the endpoint positional, verbatim (`repos/o/r/pulls/12/merge`,
   * `orgs/o/repos`, `graphql`, a full URL). For a REST call the destination
   * is *in the path* — see {@link parseApiEndpoint} — and must be judged from
   * there, not from the cwd: `gh api -X PUT repos/o/r/pulls/N/merge` run from
   * a private checkout reaches `o/r` whatever the cwd is. `{owner}/{repo}`
   * placeholders are the one case where gh itself resolves from the cwd.
   */
  apiEndpoint?: string;
  /**
   * `gh api graphql` only: where the GraphQL document comes from, so the
   * policy can tell a mutation from a read. A GraphQL mutation names its
   * target by node id (`pullRequestId`, `repositoryId`, …), which carries no
   * `<org>/<repo>` this guard can read offline — so, unlike a REST path, the
   * cwd is NOT a valid fallback for it (issue #113). Exactly one source is
   * normally set: `query` (`-f query=…` / `-F query=…`, verbatim),
   * `queryFile` (`-F query=@path`; `-` is stdin) or `inputFile` (`--input
   * path`, a JSON body with a `query` member; `-` is stdin). Reading the
   * files is the policy's job — this module stays pure.
   */
  graphql?: { query?: string; queryFile?: string; inputFile?: string };
  /**
   * `--body-file`, `-F`, `--notes-file`, `--input`, `--body @path`,
   * `-F key=@path` (gh api). `-` means stdin and is kept verbatim so the
   * policy can exempt it.
   */
  payloadFiles: string[];
  /** True when an earlier segment of the same command line is a `cd` / `pushd`. */
  precededByCd: boolean;
  /** The operator joining this segment to its predecessor; null for the first segment. */
  joinedBy: SegmentJoin;
  /**
   * A directory the command explicitly runs against (`git -C <dir>`), so the
   * policy resolves the destination from there rather than from the hook's
   * cwd. Absent when the command relies on the cwd — which is exactly the
   * implicit-destination shape the design exists to catch.
   */
  cwdOverride?: string;
  /** Zero-based index of the segment this intent came from. */
  segmentIndex: number;
}

// ---------------------------------------------------------------------------
// Tokeniser
// ---------------------------------------------------------------------------

interface Segment {
  tokens: string[];
  joinedBy: SegmentJoin;
  /** Bodies of heredocs (`<<WORD`) opened on this segment's line, which the tokeniser otherwise skips. */
  heredocs: string[];
  /** The segment is a function definition (`name() {` …): its first token is the function's name, not a command. */
  funcDef: boolean;
}

/**
 * One backslash escape inside `$'…'`, starting at `text[at]` (the backslash).
 * Returns the decoded text and how many characters it consumed. An escape bash
 * does not define stays as written. Never throws.
 */
function decodeAnsiCEscape(text: string, at: number): [string, number] {
  const e = text[at + 1]!;
  const simple: Record<string, string> = {
    a: "\x07",
    b: "\b",
    e: "\x1b",
    E: "\x1b",
    f: "\f",
    n: "\n",
    r: "\r",
    t: "\t",
    v: "\v",
    "\\": "\\",
    "'": "'",
    '"': '"',
    "?": "?",
  };
  if (Object.hasOwn(simple, e)) return [simple[e]!, 2];
  const hex = (re: RegExp): [string, number] | null => {
    const m = re.exec(text.slice(at + 2, at + 12));
    if (m === null) return null;
    return [String.fromCodePoint(parseInt(m[1]!, 16)), 2 + m[1]!.length];
  };
  if (e === "x") return hex(/^([0-9A-Fa-f]{1,2})/) ?? ["\\x", 2];
  if (e === "u") return hex(/^([0-9A-Fa-f]{1,4})/) ?? ["\\u", 2];
  if (e === "U") {
    const m = /^([0-9A-Fa-f]{1,8})/.exec(text.slice(at + 2, at + 12));
    if (m !== null && parseInt(m[1]!, 16) <= 0x10ffff) return [String.fromCodePoint(parseInt(m[1]!, 16)), 2 + m[1]!.length];
    return ["\\U", 2];
  }
  const oct = /^([0-7]{1,3})/.exec(text.slice(at + 1, at + 4));
  if (oct !== null) return [String.fromCharCode(parseInt(oct[1]!, 8) & 0xff), 1 + oct[1]!.length];
  return ["\\" + e, 2];
}

/**
 * Quote-aware split of a command line into operator-delimited segments.
 * Never throws: a malformed line (unterminated quote, dangling operator)
 * yields whatever segments were complete before the problem.
 */
function tokenise(command: string): Segment[] {
  const segments: Segment[] = [];
  let cur: Segment = { tokens: [], joinedBy: null, heredocs: [], funcDef: false };
  let word = "";
  let inWord = false;
  // Heredoc bodies must not be parsed as commands. When `<<WORD` is seen,
  // the delimiter is queued with the segment that opened it; at the next
  // newline the body is skipped up to (and including) the line that equals
  // the delimiter, and kept on that segment for callers that feed it to a shell.
  const pendingHeredocs: Array<{ delim: string; owner: Segment }> = [];
  // `(` nesting, so the `)` that closes a process substitution `<(…)` / `>(…)` ends its command.
  const parens: Array<"proc" | "sub"> = [];

  const pushWord = (): void => {
    if (inWord) {
      cur.tokens.push(word);
      word = "";
      inWord = false;
    }
  };
  const endSegment = (nextJoin: SegmentJoin): void => {
    pushWord();
    if (cur.tokens.length > 0) segments.push(cur);
    cur = { tokens: [], joinedBy: nextJoin, heredocs: [], funcDef: false };
  };

  const n = command.length;
  let i = 0;
  while (i < n) {
    const c = command[i]!;

    // --- quoting -----------------------------------------------------------
    if (c === "'") {
      inWord = true;
      const end = command.indexOf("'", i + 1);
      if (end === -1) {
        word += command.slice(i + 1);
        i = n;
      } else {
        word += command.slice(i + 1, end);
        i = end + 1;
      }
      continue;
    }
    if (c === '"') {
      inWord = true;
      i++;
      while (i < n && command[i] !== '"') {
        if (command[i] === "\\" && i + 1 < n && '"$`\\\n'.includes(command[i + 1]!)) {
          word += command[i + 1];
          i += 2;
        } else {
          word += command[i];
          i++;
        }
      }
      i++; // closing quote (or past end)
      continue;
    }
    if (c === "\\") {
      if (i + 1 < n) {
        if (command[i + 1] === "\n") {
          // line continuation
          i += 2;
          continue;
        }
        inWord = true;
        word += command[i + 1];
        i += 2;
      } else {
        i++;
      }
      continue;
    }
    // `$'…'` (ANSI-C quoting) and `$"…"` (locale quoting) are quoted words: bash
    // drops the `$` and the quotes, so `gh $'issue' create` runs `gh issue create`.
    if (c === "$" && command[i + 1] === "'") {
      inWord = true;
      let j = i + 2;
      let text = "";
      while (j < n && command[j] !== "'") {
        if (command[j] === "\\" && j + 1 < n) {
          const [decoded, used] = decodeAnsiCEscape(command, j);
          text += decoded;
          j += used;
        } else {
          text += command[j];
          j++;
        }
      }
      word += text;
      i = j + 1; // closing quote (or past end)
      continue;
    }
    if (c === "$" && command[i + 1] === '"') {
      i++; // the double-quote branch above takes it from here
      continue;
    }
    // Command / parameter substitution: keep opaque, inside the current word.
    if (c === "$" && command[i + 1] === "(") {
      inWord = true;
      let depth = 0;
      let j = i;
      while (j < n) {
        if (command[j] === "(") depth++;
        else if (command[j] === ")") {
          depth--;
          if (depth === 0) {
            j++;
            break;
          }
        }
        j++;
      }
      word += command.slice(i, j);
      i = j;
      continue;
    }
    if (c === "$" && command[i + 1] === "{") {
      inWord = true;
      const end = command.indexOf("}", i + 2);
      const j = end === -1 ? n : end + 1;
      word += command.slice(i, j);
      i = j;
      continue;
    }
    if (c === "`") {
      inWord = true;
      const end = command.indexOf("`", i + 1);
      const j = end === -1 ? n : end + 1;
      word += command.slice(i, j);
      i = j;
      continue;
    }

    // --- comments ------------------------------------------------------------
    if (c === "#" && !inWord) {
      const nl = command.indexOf("\n", i);
      i = nl === -1 ? n : nl; // the newline itself is handled below
      continue;
    }

    // --- operators -----------------------------------------------------------
    if (c === "\n") {
      endSegment("\n");
      i++;
      if (pendingHeredocs.length > 0) {
        // Skip heredoc bodies, one per queued delimiter, in order.
        while (pendingHeredocs.length > 0) {
          const { delim, owner } = pendingHeredocs.shift()!;
          const bodyStart = i;
          let bodyEnd = i;
          for (;;) {
            const nl = command.indexOf("\n", i);
            const line = nl === -1 ? command.slice(i) : command.slice(i, nl);
            const lineStart = i;
            i = nl === -1 ? n : nl + 1;
            if (line.replace(/^\t+/, "") === delim || nl === -1) {
              // The body is the lines before the terminator (all of it when there is none).
              bodyEnd = line.replace(/^\t+/, "") === delim ? lineStart : i;
              break;
            }
          }
          owner.heredocs.push(command.slice(bodyStart, Math.max(bodyStart, bodyEnd)));
        }
      }
      continue;
    }
    if (c === "&" && command[i + 1] === "&") {
      endSegment("&&");
      i += 2;
      continue;
    }
    if (c === "|" && command[i + 1] === "|") {
      endSegment("||");
      i += 2;
      continue;
    }
    if (c === "|") {
      endSegment("|");
      i += command[i + 1] === "&" ? 2 : 1;
      continue;
    }
    if (c === ";") {
      endSegment(";");
      i++;
      continue;
    }
    if (c === "&") {
      // `>&2` / `2>&1` are handled as part of a redirection word below;
      // a bare `&` outside a word is the background operator.
      if (inWord && /[<>]$/.test(word)) {
        word += c;
        i++;
        continue;
      }
      endSegment("&");
      i++;
      continue;
    }
    // Process substitution `<(cmd)` / `>(cmd)`: `cmd` runs as a command of its own, like a pipe stage.
    if ((c === "<" || c === ">") && command[i + 1] === "(") {
      endSegment("|");
      parens.push("proc");
      i += 2;
      continue;
    }
    if (c === "(" || c === ")") {
      // Subshell / group delimiters: word boundaries, otherwise ignored — except `name()`, a function
      // definition, whose name must not be mistaken for the command that follows.
      if (c === "(" && command[i + 1] === ")") {
        const nameFirst = inWord && cur.tokens.length === 0 && /^[A-Za-z_][\w.:-]*$/.test(word);
        const nameDone = !inWord && cur.tokens.length === 1;
        if (nameFirst || nameDone) {
          pushWord();
          cur.funcDef = true;
          i += 2;
          continue;
        }
      }
      pushWord();
      if (c === "(") parens.push("sub");
      else if (parens.pop() === "proc") endSegment("|");
      i++;
      continue;
    }

    // --- here-string `<<<` (its text is the next word; callers read it from the tokens) -----------
    if (c === "<" && command[i + 1] === "<" && command[i + 2] === "<") {
      pushWord();
      word = "<<<";
      inWord = true;
      i += 3;
      continue;
    }

    // --- heredoc -------------------------------------------------------------
    if (c === "<" && command[i + 1] === "<" && command[i + 2] !== "<") {
      pushWord();
      let j = i + 2;
      if (command[j] === "-") j++;
      while (j < n && (command[j] === " " || command[j] === "\t")) j++;
      let delim = "";
      let quoted = false;
      if (command[j] === "'" || command[j] === '"') {
        const q = command[j]!;
        const end = command.indexOf(q, j + 1);
        delim = end === -1 ? command.slice(j + 1) : command.slice(j + 1, end);
        j = end === -1 ? n : end + 1;
        quoted = true;
      } else {
        while (j < n && !/[\s;&|<>]/.test(command[j]!)) {
          delim += command[j];
          j++;
        }
      }
      if (!quoted) delim = delim.replace(/\\/g, "");
      if (delim.length > 0) pendingHeredocs.push({ delim, owner: cur });
      i = j;
      continue;
    }

    // --- whitespace ------------------------------------------------------------
    if (c === " " || c === "\t" || c === "\r") {
      pushWord();
      i++;
      continue;
    }

    inWord = true;
    word += c;
    i++;
  }
  endSegment(null);
  return segments;
}

// A token that is purely a redirection operator, possibly with an fd prefix
// and an attached target: `>`, `>>`, `2>&1`, `>/dev/null`, `2>/dev/null`,
// `<file`, `&>`, `>|`. Standalone operators consume the following token as
// their target.
const REDIRECT_RE = /^(?:\d+|&)?(?:>>|>\||&>>?|>|<<<|<)(?:&\d+|\S+)?$/;
const REDIRECT_STANDALONE_RE = /^(?:\d+|&)?(?:>>|>\||&>>?|>|<<<|<)$/;

/** Drop redirections (and their targets) and stray group braces. */
function stripRedirections(tokens: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t === "{" || t === "}") continue;
    // A here-string `<<<text`: the text is read from the tokens by the caller, not run as an argument.
    if (t.startsWith("<<<")) {
      if (t === "<<<") i++;
      continue;
    }
    if (REDIRECT_RE.test(t)) {
      if (REDIRECT_STANDALONE_RE.test(t)) i++; // skip the target too
      continue;
    }
    out.push(t);
  }
  return out;
}

/** Wrapper commands that run another command: which of their flags take a value, and how many positionals precede the command. */
interface WrapperSpec {
  value: ReadonlySet<string>;
  positionals?: number;
}

const NO_VALUE_FLAGS: ReadonlySet<string> = new Set();
const WRAPPER_SPECS = new Map<string, WrapperSpec>([
  ["env", { value: new Set(["-u", "-C", "-a", "--unset", "--chdir", "--argv0"]) }],
  ["command", { value: NO_VALUE_FLAGS }],
  ["builtin", { value: NO_VALUE_FLAGS }],
  ["nohup", { value: NO_VALUE_FLAGS }],
  ["setsid", { value: NO_VALUE_FLAGS }],
  ["time", { value: new Set(["-f", "-o", "--format", "--output"]) }],
  ["exec", { value: new Set(["-a"]) }],
  [
    "sudo",
    {
      value: new Set([
        "-u", "-g", "-h", "-p", "-C", "-D", "-r", "-t", "-T", "-U",
        "--user", "--group", "--host", "--prompt", "--close-from", "--chdir", "--role", "--type",
      ]),
    },
  ],
  ["doas", { value: new Set(["-u", "-C"]) }],
  ["nice", { value: new Set(["-n", "--adjustment"]) }],
  ["timeout", { value: new Set(["-s", "-k", "--signal", "--kill-after"]), positionals: 1 }],
  ["stdbuf", { value: new Set(["-i", "-o", "-e", "--input", "--output", "--error"]) }],
  ["ionice", { value: new Set(["-c", "-n", "-p", "-P", "-u", "--class", "--classdata", "--pid", "--pgid", "--uid"]) }],
  ["caffeinate", { value: new Set(["-t", "-w"]) }],
  // `busybox sh -c …`: the applet name follows.
  ["busybox", { value: NO_VALUE_FLAGS }],
  ["watch", { value: new Set(["-n", "--interval", "-p"]) }],
  ["flock", { value: new Set(["-w", "-E", "--timeout", "--wait", "--conflict-exit-code"]), positionals: 1 }],
  [
    "xargs",
    {
      value: new Set([
        "-I", "-n", "-P", "-L", "-s", "-d", "-E", "-a", "-l",
        "--arg-file", "--delimiter", "--max-args", "--max-procs", "--max-lines", "--max-chars", "--eof",
      ]),
    },
  ],
]);

const SHELL_INTERPRETERS = new Set(["sh", "bash", "zsh", "dash", "ksh", "ash", "fish"]);

/** A `NAME=value` (or `NAME+=value`) assignment in the prefix of a command. */
interface Assignment {
  name: string;
  value: string;
  /** `NAME+=value`: the value is appended to whatever the variable already holds. */
  append: boolean;
}

/** What {@link resolveCommand} found. */
interface ResolvedCommand {
  /** The tokens, with `env -S 'string'` expanded in place. */
  tokens: string[];
  /** Index of the real command word (`tokens.length` when there is none). */
  start: number;
  /** The command is fed by `xargs`: arguments arrive on stdin and are not visible here. */
  viaXargs: boolean;
  /**
   * Command text the real command word runs: `sh -c '<text>'`, or the arguments
   * of `eval`. The caller parses it as a command line of its own.
   */
  nestedText?: string;
  /** Index (in `tokens`) of the first token that is part of `nestedText`; those tokens are parsed as text, not scanned. */
  nestedFrom?: number;
  /** The nested text comes from `eval`: it runs in THIS shell, so it can change its variables. */
  isEval: boolean;
  /** The wrapper loop ran out of iterations: what follows is unknowable. */
  exhausted: boolean;
}

/**
 * Shell reserved words that may open a command: `if gh … ; then gh … ; fi`, `! gh …`, `while`, `until`,
 * `coproc`. They run the command that follows, so they are transparent.
 */
const RESERVED_WORDS = new Set(["if", "then", "elif", "else", "do", "while", "until", "!", "coproc", "{", "}"]);

/**
 * Skip leading `NAME=value` / `NAME+=value` assignments and transparent
 * wrappers (`env`, `sudo`, `nice`, `timeout`, `xargs`, …) so the real command
 * name surfaces; `sudo -u user git push` still resolves to `git`. Every
 * assignment passed over is appended to `assigns`, in order, so the caller can
 * see `GH_REPO=o/r gh …`. `env -S 'string'` is split and run in place. A shell
 * interpreter's `-c` text and the arguments of `eval` are returned as
 * `nestedText` for the caller to parse.
 */
function resolveCommand(input: string[], assigns: Assignment[] = []): ResolvedCommand {
  let tokens = input;
  let i = 0;
  let viaXargs = false;
  let settled = false;
  for (let guard = 0; guard < 256; guard++) {
    for (;;) {
      const m = i < tokens.length ? /^([A-Za-z_][A-Za-z0-9_]*)(\+?)=([\s\S]*)$/.exec(tokens[i]!) : null;
      if (m === null) break;
      assigns.push({ name: m[1]!, value: m[3]!, append: m[2] === "+" });
      i++;
    }
    if (i >= tokens.length) return { tokens, start: i, viaXargs, isEval: false, exhausted: false };
    if (RESERVED_WORDS.has(tokens[i]!)) {
      i++;
      continue;
    }
    if (tokens[i] === "function") {
      i += 2; // `function name { … }`: the name is not a command
      continue;
    }
    const word = baseName(tokens[i]!);
    const spec = WRAPPER_SPECS.get(word);
    if (spec === undefined) {
      settled = true;
      break;
    }
    if (word === "xargs") viaXargs = true;
    i++;
    let restart = false;
    while (i < tokens.length && tokens[i]!.startsWith("-") && tokens[i] !== "-") {
      const t = tokens[i]!;
      if (t === "--") {
        i++;
        break;
      }
      if (word === "env") {
        // `env -S 'gh issue create …'`: the string is split into words and run.
        let text: string | undefined;
        let used = 1;
        if (t === "-S" || t === "--split-string") {
          text = tokens[i + 1] ?? "";
          used = 2;
        } else if (t.startsWith("--split-string=")) {
          text = t.slice("--split-string=".length);
        } else if (t.startsWith("-S") && t.length > 2) {
          text = t.slice(2);
        }
        if (text !== undefined) {
          tokens = [...tokens.slice(0, i), ...shlexSplit(text), ...tokens.slice(i + used)];
          restart = true;
          break;
        }
      }
      i += spec.value.has(t) ? 2 : 1;
    }
    if (restart) continue;
    i += spec.positionals ?? 0;
  }
  if (!settled) return { tokens, start: tokens.length, viaXargs, isEval: false, exhausted: true };
  const word = i < tokens.length ? baseName(tokens[i]!) : "";
  if (word === "eval") {
    return { tokens, start: i, viaXargs, nestedText: tokens.slice(i + 1).join(" "), nestedFrom: i + 1, isEval: true, exhausted: false };
  }
  if (SHELL_INTERPRETERS.has(word)) {
    for (let j = i + 1; j < tokens.length; j++) {
      const t = tokens[j]!;
      if (t === "--" || !t.startsWith("-")) break;
      if (/^-[A-Za-z]+$/.test(t) && t.includes("c")) {
        const text = tokens[j + 1];
        if (text !== undefined) {
          return { tokens, start: i, viaXargs, nestedText: text, nestedFrom: j + 1, isEval: false, exhausted: false };
        }
        break;
      }
    }
  }
  return { tokens, start: i, viaXargs, isEval: false, exhausted: false };
}

function baseName(token: string): string {
  const slash = token.lastIndexOf("/");
  return slash === -1 ? token : token.slice(slash + 1);
}

// ---------------------------------------------------------------------------
// Per-tool classifiers
// ---------------------------------------------------------------------------

// `git` global options that take a value as the next token.
const GIT_GLOBAL_WITH_VALUE = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--exec-path",
  "--super-prefix",
  "--config-env",
  "--list-cmds",
  "--attr-source",
]);

// `git push` options that take a value as the next token.
const GIT_PUSH_WITH_VALUE = new Set([
  "--repo",
  "--receive-pack",
  "--exec",
  "-o",
  "--push-option",
]);

/** True when a word carries a shell expansion this parser cannot evaluate. */
function hasExpansion(word: string): boolean {
  return word.includes("$") || word.includes("`");
}

/** `git -C a -C b` is `a/b`; an absolute path starts over; an empty one is ignored (git semantics). */
function joinGitDir(current: string | undefined, next: string): string | undefined {
  if (next === "") return current;
  if (current === undefined || posix.isAbsolute(next)) return next;
  return posix.join(current, next);
}

/**
 * git subcommands that publish: `push`, and the two plumbing commands underneath it. `send-pack`
 * does NOT run the pre-push hook, so for it the hook layer is the only check there is.
 */
const GIT_PUSH_LIKE = new Set(["push", "send-pack", "http-push"]);

// Built-in git commands. git ignores an alias that shadows one, so a subcommand on this list is never an
// alias and needs no config lookup; any OTHER word may be an alias (or an external `git-<name>`).
const GIT_BUILTINS = new Set([
  "add", "am", "annotate", "apply", "archive", "bisect", "blame", "branch", "bundle", "cat-file", "check-attr",
  "check-ignore", "checkout", "cherry", "cherry-pick", "clean", "clone", "column", "commit", "commit-graph",
  "commit-tree", "config", "count-objects", "credential", "describe", "diff", "diff-files", "diff-index",
  "diff-tree", "difftool", "fast-export", "fast-import", "fetch", "filter-branch", "fmt-merge-msg",
  "for-each-ref", "format-patch", "fsck", "gc", "grep", "gui", "hash-object", "help", "init",
  "interpret-trailers", "log", "ls-files", "ls-remote", "ls-tree", "maintenance", "mailinfo", "merge",
  "merge-base", "mergetool", "mktree", "mv", "name-rev", "notes", "pack-objects", "prune", "pull", "push",
  "range-diff", "read-tree", "rebase", "reflog", "remote", "repack", "replace", "request-pull", "reset",
  "restore", "rev-list", "rev-parse", "revert", "rm", "send-email", "send-pack", "http-push", "shortlog", "show",
  "show-branch", "show-ref", "sparse-checkout", "stash", "status", "submodule", "subtree", "switch",
  "symbolic-ref", "tag", "update-index", "update-ref", "var", "verify-commit", "verify-pack", "verify-tag",
  "version", "whatchanged", "worktree", "write-tree",
]);

/** The fail-closed git intent: a placeholder remote and refspec keep the implicit-target shape rule out of the way, so rule h judges it. */
function unresolvedGitIntent(base: Omit<EgressIntent, "verb" | "payloadFiles">, cwdOverride?: string): EgressIntent {
  return {
    ...base,
    verb: "git-push",
    payloadFiles: [],
    remote: "<unparsed>",
    refspec: "<unparsed>",
    ...(cwdOverride !== undefined && { cwdOverride }),
    unresolved: "unparsed-shape",
  };
}

/** What `classifyGit` needs from the environment. */
interface GitContext {
  /**
   * Configured git aliases, as seen from `dir` (the `-C` / `--git-dir` / `GIT_DIR` directory; undefined: the
   * caller's cwd): null when they could not be read; the function is absent when the caller supplied no loader.
   */
  aliases: ((dir?: string) => ReadonlyMap<string, string> | null) | undefined;
}

function classifyGit(
  args: string[],
  base: Omit<EgressIntent, "verb" | "payloadFiles">,
  assigns: Assignment[],
  gitCtx: GitContext,
): EgressIntent | null {
  let i = 0;
  let cwdOverride: string | undefined;
  let gitDir: string | undefined;
  let opaque = false;
  // `git -c alias.NAME=… NAME` defines an alias for this one command, invisible in any config file.
  const cliAliases = new Map<string, string>();
  // Global options precede the subcommand.
  while (i < args.length) {
    const a = args[i]!;
    if (!a.startsWith("-")) break;
    if (a === "-C") {
      const v = args[i + 1];
      if (v !== undefined) {
        if (hasExpansion(v)) opaque = true;
        cwdOverride = joinGitDir(cwdOverride, v);
      }
      i += 2;
      continue;
    }
    if (a === "--git-dir") {
      const v = args[i + 1];
      if (v !== undefined) {
        if (hasExpansion(v)) opaque = true;
        gitDir = v;
      }
      i += 2;
      continue;
    }
    if (a.startsWith("--git-dir=")) {
      gitDir = a.slice("--git-dir=".length);
      if (hasExpansion(gitDir)) opaque = true;
      i++;
      continue;
    }
    if (a === "-c" || a === "--config-env") {
      const kv = args[i + 1];
      const m = kv === undefined ? null : /^alias\.([^=]+)=([\s\S]*)$/i.exec(kv);
      // `--config-env` takes the value from an environment variable: unknowable, so a shell-style alias.
      if (m !== null) cliAliases.set(m[1]!.toLowerCase(), a === "-c" ? m[2]! : "!");
      i += 2;
      continue;
    }
    if (a.startsWith("--config-env=")) {
      const m = /^--config-env=alias\.([^=]+)=/i.exec(a);
      if (m !== null) cliAliases.set(m[1]!.toLowerCase(), "!");
      i++;
      continue;
    }
    if (GIT_GLOBAL_WITH_VALUE.has(a)) {
      i += 2;
      continue;
    }
    if (a.startsWith("-C") && a.length > 2) {
      const v = a.slice(2);
      if (hasExpansion(v)) opaque = true;
      cwdOverride = joinGitDir(cwdOverride, v);
    }
    i++; // `--no-pager`, `-p`, `--work-tree=…`, inline forms, …
  }

  // `GIT_DIR=` in the command prefix is `--git-dir` (the flag wins, as in git).
  if (gitDir === undefined) {
    const prefixed = assigns.filter(a => a.name === "GIT_DIR").pop();
    if (prefixed !== undefined && prefixed.value !== "") {
      gitDir = prefixed.value;
      if (prefixed.append || hasExpansion(gitDir)) opaque = true;
    }
  }
  // The repository's config — and so its remotes — comes from the git dir, relative to `-C`. A dir
  // the parser cannot name (`$DIR`) is unresolved, never silently the cwd.
  if (gitDir !== undefined) cwdOverride = joinGitDir(cwdOverride, gitDir);

  // The subcommand, after any alias (`-c alias.X=…`, or one in the git config). An alias that
  // expands to a push is a push; a shell alias, a chain too deep, or an unreadable config is unresolved.
  let sub = args[i];
  let rest = args.slice(i + 1);
  for (let depth = 0; ; depth++) {
    if (sub === undefined) return null;
    if (GIT_PUSH_LIKE.has(sub)) break;
    const key = sub.toLowerCase();
    let value = cliAliases.get(key);
    if (value === undefined && !GIT_BUILTINS.has(sub)) {
      if (gitCtx.aliases === undefined) return null; // no alias information was supplied
      // The aliases in effect are those of the repository git will use: `-C`, `--git-dir` and `GIT_DIR`
      // move it. A directory the parser cannot name has aliases it cannot read.
      if (opaque) return unresolvedGitIntent(base, cwdOverride);
      const map = gitCtx.aliases(cwdOverride);
      if (map === null) return unresolvedGitIntent(base, cwdOverride); // aliases exist but cannot be read
      value = map.get(key);
    }
    if (value === undefined) return null;
    if (depth >= ALIAS_MAX_DEPTH || value.length > ALIAS_MAX_BYTES || value.startsWith("!")) {
      return unresolvedGitIntent(base, cwdOverride);
    }
    const words = shlexSplit(value);
    sub = words[0];
    rest = [...words.slice(1), ...rest];
  }

  const positionals: string[] = [];
  for (let k = 0; k < rest.length; k++) {
    const a = rest[k]!;
    if (a === "--") {
      positionals.push(...rest.slice(k + 1));
      break;
    }
    if (a.startsWith("-")) {
      if (GIT_PUSH_WITH_VALUE.has(a)) k++;
      continue;
    }
    positionals.push(a);
  }

  // `git send-pack <url> <ref>…` and `git http-push <url> <ref>…` name their target URL first, like push.
  const remote = positionals[0];
  const refspec = positionals[1];
  // Arguments forwarded from a function or script (`"$@"`) can carry a different target.
  const forwarded = rest.some(a => /\$[@*]|\$\{[@*]/.test(a));
  return {
    ...base,
    verb: "git-push",
    payloadFiles: [],
    ...(remote !== undefined && { remote }),
    ...(refspec !== undefined && { refspec }),
    ...(cwdOverride !== undefined && { cwdOverride }),
    ...((opaque || forwarded) && { unresolved: "unparsed-shape" as const }),
  };
}

interface GhVerbMap {
  [group: string]: { [sub: string]: EgressVerb };
}

const GH_VERBS: GhVerbMap = {
  pr: {
    create: "gh-pr-create",
    edit: "gh-pr-edit",
    merge: "gh-pr-merge",
    comment: "gh-pr-comment",
    review: "gh-pr-review",
    close: "gh-pr-edit",
    reopen: "gh-pr-edit",
    ready: "gh-pr-edit",
    lock: "gh-pr-edit",
    unlock: "gh-pr-edit",
    "update-branch": "gh-pr-edit",
  },
  issue: {
    create: "gh-issue-create",
    edit: "gh-issue-edit",
    comment: "gh-issue-comment",
    close: "gh-issue-edit",
    reopen: "gh-issue-edit",
    lock: "gh-issue-edit",
    unlock: "gh-issue-edit",
    pin: "gh-issue-edit",
    unpin: "gh-issue-edit",
    transfer: "gh-issue-edit",
    delete: "gh-issue-edit",
    develop: "gh-issue-edit",
  },
  release: {
    create: "gh-release-create",
    edit: "gh-release-edit",
    upload: "gh-release-upload",
    delete: "gh-release-edit",
    "delete-asset": "gh-release-edit",
  },
  repo: {
    create: "gh-repo-create",
    fork: "gh-repo-create",
    edit: "gh-repo-edit",
    delete: "gh-repo-edit",
    archive: "gh-repo-edit",
    unarchive: "gh-repo-edit",
    rename: "gh-repo-edit",
    sync: "gh-repo-edit",
    "deploy-key": "gh-repo-edit",
  },
  gist: {
    create: "gh-gist-create",
    edit: "gh-gist-create",
  },
  workflow: {
    run: "gh-workflow-run",
    enable: "gh-workflow-run",
    disable: "gh-workflow-run",
  },
  run: {
    rerun: "gh-workflow-run",
    cancel: "gh-workflow-run",
  },
  secret: { set: "gh-repo-edit", delete: "gh-repo-edit" },
  variable: { set: "gh-repo-edit", delete: "gh-repo-edit" },
  label: { create: "gh-repo-edit", edit: "gh-repo-edit", delete: "gh-repo-edit", clone: "gh-repo-edit" },
  ruleset: { check: "gh-repo-edit" },
};

const MUTATING_METHODS = new Set(["POST", "PATCH", "PUT", "DELETE"]);

/** How a `gh api` endpoint relates to a repository; see {@link analyseApiEndpoint}. */
export type ApiEndpointTarget =
  | { kind: "named"; org: string; repo: string | null }
  /** The owner or repo segment is literally `{owner}` / `{repo}`: gh fills it from the base repository. */
  | { kind: "cwd" }
  /** The owner or repo segment carries some other placeholder (`{branch}`, `a{b}`): not a name this guard can read. */
  | { kind: "opaque" }
  /** No repository in the path: `graphql`, `user/…`, `gists`, `search/…`. */
  | { kind: "none" };

/**
 * Classify the endpoint of a MUTATING `gh api` request. The query string is
 * split off FIRST. Then:
 *
 * - a shell expansion anywhere in the PATH (`$P` can carry `../..`), a `.` or
 *   `..` or empty segment, or a percent-encoded dot or slash (`%2e`, `%2f`, any
 *   case) is `opaque`: the request may land in another repository;
 * - only the owner and repo segments of `repos/<o>/<r>/…` (or the owner of
 *   `orgs/<o>/…`) decide the rest: a `{placeholder}` later in the path, or
 *   anything in the query (`…/git/refs/heads/{branch}`, `…/issues?ref={branch}`),
 *   is still addressed to the literal `o/r`, so it must not send the guard back
 *   to the cwd; `{owner}` / `{repo}` there is `cwd`; any other placeholder is
 *   `opaque`.
 *
 * A read keeps its leniency: callers analyse mutating requests only.
 * Pure; never throws.
 */
export function analyseApiEndpoint(endpoint: string): ApiEndpointTarget {
  let path = endpoint;
  if (/^https?:\/\//i.test(path)) {
    // A shell expansion in the host (`https://$HOST/…`) is a host this guard cannot name.
    if (/^https?:\/\/[^/]*[$`]/i.test(path)) return { kind: "opaque" };
    try {
      // `new URL` percent-encodes braces in a path; undo that for the two placeholder characters.
      path = new URL(path).pathname.replace(/%7B/gi, "{").replace(/%7D/gi, "}");
    } catch {
      return { kind: "none" };
    }
  }
  path = path.replace(/^\/+/, "").replace(/^api\/v3\//i, "");
  const parts = path.split(/[?#]/)[0]!.split("/").filter(Boolean);
  // The endpoint of a MUTATING request is judged by its whole path: an expansion anywhere in it (`$P` can
  // carry `../..`), a `.` / `..` / empty segment, or a percent-encoded dot or slash can move the request to
  // another repository. (Only mutating requests are analysed; a read keeps its leniency.)
  const pathOnly = path.split(/[?#]/)[0]!;
  if (hasExpansion(pathOnly) || /%2[ef]/i.test(pathOnly) || /(^|\/)\.{1,2}(\/|$)/.test(pathOnly) || /\/\//.test(pathOnly)) {
    return { kind: "opaque" };
  }
  // `repos/<o>/<r>` needs both segments; `orgs/<o>` needs the first. It is matched
  // case-insensitively (`Repos/o/r`): if GitHub routes that spelling it must not be missed, and
  // if it does not the request fails, so nothing is lost by treating every case variant alike.
  const first = parts[0]?.toLowerCase();
  let segments: string[] | null = null;
  if (first === "repos" && parts.length >= 3) segments = [parts[1]!, parts[2]!];
  else if (first === "orgs" && parts.length >= 2) segments = [parts[1]!];
  if (segments === null) return { kind: "none" };
  let cwd = false;
  for (const [i, seg] of segments.entries()) {
    if (!seg.includes("{")) continue;
    if (seg === (i === 0 ? "{owner}" : "{repo}")) cwd = true;
    else return { kind: "opaque" };
  }
  if (cwd) return { kind: "cwd" };
  return {
    kind: "named",
    org: segments[0]!.toLowerCase(),
    repo: segments[1] === undefined ? null : segments[1].replace(/\.git$/, "").toLowerCase(),
  };
}

/**
 * The org and repo a `gh api` endpoint addresses, when the path says so:
 * `repos/<o>/<r>[/…]` → both; `orgs/<o>[/…]` → the org only (`repo: null`,
 * an org-level write such as `orgs/<o>/repos`). A full URL is reduced to
 * its path; a GitHub Enterprise `/api/v3/` prefix is dropped. Null for
 * anything else — `graphql`, `user/repos`, `gists`, `search/…` — for an
 * owner or repo segment that is `{owner}` / `{repo}`, which gh fills in from
 * the cwd's repository (so the cwd is then the correct fallback), and for
 * any other placeholder in those segments (see {@link analyseApiEndpoint},
 * which tells these apart). Placeholders elsewhere in the path or in the query
 * do not matter. Pure; never throws.
 */
export function parseApiEndpoint(endpoint: string): { org: string; repo: string | null } | null {
  const t = analyseApiEndpoint(endpoint);
  return t.kind === "named" ? { org: t.org, repo: t.repo } : null;
}

/**
 * True when a `gh api` endpoint is the GraphQL endpoint: `graphql`, or a
 * full URL whose path is `/graphql` (github.com) or `/api/graphql` (GitHub
 * Enterprise). Pure; never throws.
 */
export function isGraphqlEndpoint(endpoint: string): boolean {
  let path = endpoint;
  if (/^https?:\/\//i.test(path)) {
    try {
      path = new URL(path).pathname;
    } catch {
      return false;
    }
  }
  // Slashes trimmed by index, not `/\/+$/`: that pattern backtracks
  // quadratically on a long run of slashes (js/polynomial-redos), and the
  // endpoint is copied straight from an agent's command line.
  path = path.split("?")[0]!;
  let start = 0;
  let end = path.length;
  while (start < end && path[start] === "/") start++;
  while (end > start && path[end - 1] === "/") end--;
  path = path.slice(start, end);
  return path === "graphql" || path === "api/graphql";
}

/** See {@link graphqlOperationKind}. */
export type GraphqlOperationKind = "mutation" | "query" | "opaque";

/**
 * What a GraphQL document would do, as far as the egress policy cares:
 *
 * - `mutation` — it contains a top-level `mutation` operation;
 * - `query` — it contains none (queries, subscriptions, fragments, or text
 *   the server would reject as unparseable — none of which can write);
 * - `opaque` — the text is not the document: an unexpanded shell
 *   substitution (`$(cat q.graphql)`, backticks, `${VAR}`, a lone `$VAR`) as
 *   the hook sees it before the shell runs, or an unterminated string. The
 *   caller must treat this like a mutation — it cannot rule one out.
 *
 * A small GraphQL lexer, not a regex: `#` comments, `"…"` strings and
 * `"""…"""` block strings are skipped, so the word `mutation` inside
 * any of them — or nested inside a selection set, argument list or variable
 * default — is not an operation keyword. Only a `mutation` name at nesting
 * depth 0 is. Leading whitespace, commas and a BOM are insignificant, as the
 * GraphQL grammar says. Pure; never throws.
 */
export function graphqlOperationKind(text: string): GraphqlOperationKind {
  try {
    const n = text.length;
    let depth = 0;
    let i = 0;
    while (i < n) {
      const c = text[i]!;
      if (c === "#") {
        while (i < n && text[i] !== "\n" && text[i] !== "\r") i++;
        continue;
      }
      if (c === '"') {
        if (text.startsWith('"""', i)) {
          // Block string: the only escape is \""".
          let j = text.indexOf('"""', i + 3);
          while (j !== -1 && text[j - 1] === "\\") j = text.indexOf('"""', j + 3);
          if (j === -1) return "opaque";
          i = j + 3;
          continue;
        }
        let j = i + 1;
        while (j < n && text[j] !== '"' && text[j] !== "\n") j += text[j] === "\\" ? 2 : 1;
        if (j >= n || text[j] !== '"') return "opaque";
        i = j + 1;
        continue;
      }
      if (c === "{" || c === "(" || c === "[") {
        depth++;
        i++;
        continue;
      }
      if (c === "}" || c === ")" || c === "]") {
        if (depth > 0) depth--;
        i++;
        continue;
      }
      if (/[_A-Za-z]/.test(c)) {
        let j = i + 1;
        while (j < n && /[_A-Za-z0-9]/.test(text[j]!)) j++;
        const name = text.slice(i, j);
        // `$mutation` is a variable, not a keyword.
        const isVariable = i > 0 && text[i - 1] === "$";
        if (depth === 0 && !isVariable && name === "mutation") return "mutation";
        i = j;
        continue;
      }
      i++;
    }
    // No mutation in the text as given. If the text is really a shell
    // expression the hook saw before expansion, the document is elsewhere.
    if (/\$\(|`|\$\{/.test(text) || /^\s*\$[A-Za-z_][A-Za-z0-9_]*\s*$/.test(text)) return "opaque";
    return "query";
  } catch {
    return "opaque";
  }
}

// ---------------------------------------------------------------------------
// gh argument scanning (issue #151, §3.3 items 7–8)
// ---------------------------------------------------------------------------

/** `gh` is a cobra/pflag program; this section mirrors the parts of its argument handling that decide where a write lands. */
const GH_BUILTIN_COMMANDS = new Set([
  "accessibility",
  "actions",
  "agent-task",
  "alias",
  "api",
  "attestation",
  "auth",
  "browse",
  "cache",
  "codespace",
  "completion",
  "config",
  "copilot",
  "extension",
  "gist",
  "gpg-key",
  "help",
  "issue",
  "label",
  "licenses",
  "org",
  "pr",
  "preview",
  "project",
  "release",
  "repo",
  "ruleset",
  "run",
  "search",
  "secret",
  "ssh-key",
  "status",
  "variable",
  "workflow",
]);

// Built-in groups with no write verb to an owner's repositories: their subcommands read, or change only
// local gh state. Each lists its subcommands, so that when the user's aliases are UNKNOWN a subcommand that
// is not on the list (it might be an alias such as `search ic`) is unresolved. "any": the group's words are
// arguments (`gh browse 5`), not subcommands.
const GH_READ_GROUP_SUBS: Readonly<Record<string, ReadonlySet<string> | "any">> = {
  accessibility: "any",
  actions: "any",
  browse: "any",
  completion: "any",
  help: "any",
  licenses: "any",
  preview: "any",
  status: "any",
  alias: new Set(["delete", "import", "list", "set"]),
  attestation: new Set(["download", "inspect", "trusted-root", "verify", "verify-asset"]),
  auth: new Set(["login", "logout", "refresh", "setup-git", "status", "switch", "token"]),
  config: new Set(["clear-cache", "get", "list", "set"]),
  org: new Set(["list"]),
  search: new Set(["code", "commits", "issues", "prs", "repos"]),
};

// Every OTHER built-in group that has no entry in GH_VERBS (`project`, `agent-task`, `codespace`, `cache`,
// `ssh-key`, `gpg-key`, `copilot`, `extension`) is a write this parser has no shape for, and is reported
// unresolved ("unknown-shape") — except for these subcommands, which only read.
const GH_UNMODELLED_READ_SUBS: Readonly<Record<string, ReadonlySet<string>>> = {
  codespace: new Set(["list", "view", "logs", "status", "watch"]),
  extension: new Set(["list", "search", "browse", "status", "view", "watch"]),
  cache: new Set(["list", "view", "status", "watch"]),
  project: new Set(["list", "view", "field-list", "item-list", "status", "watch"]),
  "ssh-key": new Set(["list", "view", "status", "watch"]),
  "gpg-key": new Set(["list", "view", "status", "watch"]),
  copilot: new Set(["explain", "suggest", "list", "view", "status", "watch"]),
  "agent-task": new Set(["list", "view", "status", "watch"]),
};

/** Flags that take a value, for one command: long names (with `--`) and short letters. */
interface FlagSpec {
  long: ReadonlySet<string>;
  short: ReadonlySet<string>;
}

const FLAG_SPEC_CACHE = new Map<string, FlagSpec>();

/**
 * The value-taking flags of `gh <group> <sub>`, from the manual-derived table in
 * `gh-flags.ts`. `-R/--repo` is always a value flag. A command with no table entry gets only
 * that: the parser reports such a command `unresolved` anyway.
 */
function flagSpec(group: string, sub: string | undefined): FlagSpec {
  const key = group === "api" ? "api" : `${group} ${sub ?? ""}`;
  const cached = FLAG_SPEC_CACHE.get(key);
  if (cached !== undefined) return cached;
  const long = new Set<string>(["--repo"]);
  const short = new Set<string>(["R"]);
  const entry = Object.hasOwn(GH_COMMAND_FLAGS, key) ? GH_COMMAND_FLAGS[key] : undefined;
  if (entry !== undefined) {
    for (const l of entry.value) long.add(l);
    for (const c of entry.valueShort) short.add(c);
  }
  const spec: FlagSpec = { long, short };
  FLAG_SPEC_CACHE.set(key, spec);
  return spec;
}

/**
 * Where cobra would find the command: the group (`pr`) and subcommand
 * (`create`). cobra's `stripFlags` treats every `--flag` without `=` that it
 * does not know as taking a value — it swallows the next token — and so does a
 * two-character `-X`. That is why `gh issue --repo stranger/r create` and `gh
 * --repo stranger/r issue create` both run `issue create` against
 * `stranger/r`, and why "the first two non-flag tokens" (the previous
 * heuristic) found no verb at all for them. Null when no command word is
 * found. `api` is a leaf: it has no subcommand.
 */
function findGhCommand(args: string[]): { groupIdx: number; subIdx?: number } | null {
  let groupIdx = -1;
  let i = 0;
  while (i < args.length) {
    const s = args[i]!;
    if (s === "--") return groupIdx === -1 ? null : { groupIdx };
    if (s.startsWith("--") && !s.includes("=")) {
      i += s === "--help" || s === "--version" ? 1 : 2;
      continue;
    }
    if (s.length === 2 && s.startsWith("-") && s !== "-h") {
      i += 2;
      continue;
    }
    if (s.startsWith("-")) {
      i++;
      continue;
    }
    if (groupIdx === -1) {
      groupIdx = i;
      if (s === "api") return { groupIdx };
      i++;
      continue;
    }
    return { groupIdx, subIdx: i };
  }
  return groupIdx === -1 ? null : { groupIdx };
}

interface GhFlagEvent {
  /** `-R` or `--repo`: the canonical spelling, whatever form the token took. */
  flag: string;
  value: string | undefined;
}

/**
 * pflag's argument grammar, for the flags that matter here: `--name value`,
 * `--name=value`, `-X value`, `-Xvalue`, `-X=value` (one leading `=` is
 * stripped), grouped booleans (`-dw`), `--` ending flag parsing, and flags
 * allowed anywhere among the positionals. A value flag takes the NEXT token
 * whatever it looks like (pflag does not check for a leading `-`). `skip`
 * holds the indexes of the command words. A repeated flag yields one event per
 * occurrence; callers take the last, as pflag does for a string flag.
 */
function scanGhArgs(
  args: string[],
  skip: ReadonlySet<number>,
  spec: FlagSpec,
): { events: GhFlagEvent[]; positionals: string[] } {
  const events: GhFlagEvent[] = [];
  const positionals: string[] = [];
  let afterTerminator = false;
  let i = 0;
  while (i < args.length) {
    if (skip.has(i)) {
      i++;
      continue;
    }
    const a = args[i]!;
    if (afterTerminator || a === "-" || !a.startsWith("-")) {
      positionals.push(a);
      i++;
      continue;
    }
    if (a === "--") {
      afterTerminator = true;
      i++;
      continue;
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq !== -1) {
        events.push({ flag: a.slice(0, eq), value: a.slice(eq + 1) });
        i++;
      } else if (spec.long.has(a)) {
        events.push({ flag: a, value: args[i + 1] });
        i += 2;
      } else {
        events.push({ flag: a, value: undefined });
        i++;
      }
      continue;
    }
    // A group of short flags: `-R`, `-Rvalue`, `-R=value`, `-dw`, `-wRvalue`.
    let consumedNext = false;
    for (let j = 1; j < a.length; j++) {
      const ch = a[j]!;
      if (!spec.short.has(ch)) {
        events.push({ flag: `-${ch}`, value: undefined });
        continue;
      }
      const rest = a.slice(j + 1);
      let value: string | undefined;
      if (rest.startsWith("=")) value = rest.slice(1);
      else if (rest.length > 0) value = rest;
      else {
        value = args[i + 1];
        consumedNext = true;
      }
      events.push({ flag: `-${ch}`, value });
      break;
    }
    i += consumedNext ? 2 : 1;
  }
  return { events, positionals };
}

/** The last value given for any of `flags` (pflag: the last occurrence of a string flag wins). */
function lastValue(events: GhFlagEvent[], ...flags: string[]): string | undefined {
  let out: string | undefined;
  for (const e of events) if (flags.includes(e.flag) && e.value !== undefined) out = e.value;
  return out;
}

// ---------------------------------------------------------------------------
// Naming a repository (issue #151, §3.3 items 1, 2, 8)
// ---------------------------------------------------------------------------

const NAME_RE = /^[A-Za-z0-9_.-]+$/;

/**
 * A repository reference as gh accepts it — `OWNER/REPO`, `HOST/OWNER/REPO`,
 * an `https://`/`ssh://` URL (a PR or issue URL names its repository), or an
 * scp-style `git@host:OWNER/REPO` — as lower-cased `{ org, repo }`; null for
 * anything else (`$REPO`, `$(…)`, `{owner}`, a bare word, `a/b/c/d`).
 * Pure; never throws.
 */
export function parseRepoRef(ref: string): { org: string; repo: string } | null {
  const t = ref.trim();
  if (t.length === 0) return null;
  let parts: string[];
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) {
    try {
      parts = new URL(t).pathname.split("/").filter(Boolean);
    } catch {
      return null;
    }
    if (parts.length < 2) return null;
  } else {
    const scp = /^[^@/\s]+@[^:/\s]+:(.+)$/.exec(t);
    parts = (scp !== null ? scp[1]! : t).split("/").filter(Boolean);
    if (parts.length === 3 && scp === null && parts[0]!.includes(".")) parts = parts.slice(1);
    if (parts.length !== 2) return null;
  }
  const org = parts[0]!;
  const repo = parts[1]!.replace(/\.git$/, "");
  if (!NAME_RE.test(org) || !NAME_RE.test(repo) || org === "." || org === ".." || repo === "." || repo === "..") {
    return null;
  }
  return { org: org.toLowerCase(), repo: repo.toLowerCase() };
}

/** A repository the intent names, as the resolver needs it: `repo` is null for an org-level target. */
export interface RepoTarget {
  org: string;
  repo: string | null;
}

/**
 * Every repository (or org) a `gh` intent names explicitly, deduplicated, in
 * this order: positional and verb-specific targets, then `--repo`, or — only
 * when there is no `--repo` — `GH_REPO` (gh's own precedence). Empty when the
 * command relies on the cwd. Distinct entries mean the command can reach
 * several repositories, and every one must be judged. `gh api` endpoints and
 * `git push` remotes are not covered here (see {@link parseApiEndpoint}).
 */
export function intentRepoTargets(intent: EgressIntent): RepoTarget[] {
  const out: RepoTarget[] = [];
  const seen = new Set<string>();
  const add = (ref: string | undefined): void => {
    if (ref === undefined) return;
    const parsed = parseRepoRef(ref);
    const t: RepoTarget | null =
      parsed !== null ? parsed : NAME_RE.test(ref) ? { org: ref.toLowerCase(), repo: null } : null;
    if (t === null) return;
    const key = `${t.org}/${t.repo ?? "*"}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(t);
  };
  add(intent.positionalRepo);
  for (const r of intent.extraRepos ?? []) add(r);
  add(intent.repoFlag ?? intent.envRepo);
  return out;
}

/** Which positionals and flags of a verb name a repository (§3.3.8, §8.4 F9). */
interface RepoShape {
  /** Every positional that is an `http(s)://` URL names that repository (PR / issue selectors). */
  selectors?: true;
  /** The positional at this index is `OWNER/REPO` (or a URL). */
  repoPositional?: number;
  /** …and a bare name there is fine: it is created under the authenticated account. */
  bareOk?: true;
  /** Flags whose value is `OWNER/REPO`. */
  repoFlags?: readonly string[];
  /** Flags whose value is an owner. */
  orgFlags?: readonly string[];
  /** The target is in ADDITION to the base repository (`--repo` / `GH_REPO` / cwd), not instead of it. */
  keepsBase?: true;
}

// `gh label clone <source>` is deliberately absent: it copies labels FROM the source INTO the base
// repository (`-R`, `GH_REPO` or the cwd). The write goes to the base; the source is only read.
const REPO_SHAPES = new Map<string, RepoShape>([
  // Every `gh pr …` and `gh issue …` takes a number, a branch or a URL; a URL names its repository.
  ["pr", { selectors: true }],
  ["issue", { selectors: true }],
  ["issue transfer", { selectors: true, repoPositional: 1, keepsBase: true }],
  ["issue develop", { selectors: true, repoFlags: ["--branch-repo"], keepsBase: true }],
  ["repo create", { repoPositional: 0, bareOk: true }],
  ["repo edit", { repoPositional: 0 }],
  ["repo delete", { repoPositional: 0 }],
  ["repo archive", { repoPositional: 0 }],
  ["repo unarchive", { repoPositional: 0 }],
  ["repo sync", { repoPositional: 0 }],
  ["repo fork", { orgFlags: ["--org"] }],
  ["secret set", { orgFlags: ["--org", "-o"] }],
  ["secret delete", { orgFlags: ["--org", "-o"] }],
  ["variable set", { orgFlags: ["--org", "-o"] }],
  ["variable delete", { orgFlags: ["--org", "-o"] }],
]);

interface CollectedTargets {
  repos: string[];
  opaque: boolean;
  /** True when a target found here replaces the base repository (so `GH_REPO` does not apply). */
  replacesBase: boolean;
}

function collectRepoTargets(
  group: string,
  sub: string | undefined,
  events: GhFlagEvent[],
  positionals: string[],
): CollectedTargets {
  const shape = REPO_SHAPES.get(`${group} ${sub ?? ""}`) ?? REPO_SHAPES.get(group);
  const repos: string[] = [];
  let opaque = false;
  if (shape === undefined) return { repos, opaque, replacesBase: false };

  const addRepo = (ref: string): void => {
    const p = parseRepoRef(ref);
    if (p === null) opaque = true;
    else repos.push(`${p.org}/${p.repo}`);
  };

  if (shape.selectors === true) {
    for (const p of positionals) {
      // A selector holding a shell expansion (`"$URL"`) may be a URL to anywhere: unknowable.
      if (hasExpansion(p)) opaque = true;
      else if (/^https?:\/\//i.test(p)) addRepo(p);
    }
  }
  if (shape.repoPositional !== undefined) {
    const p = positionals[shape.repoPositional];
    if (p !== undefined) {
      if (parseRepoRef(p) !== null) addRepo(p);
      else if (!(NAME_RE.test(p) && !p.includes("/"))) opaque = true;
      // else a bare name: `gh repo create name` is the authenticated account's; gh rejects it elsewhere.
    }
  }
  for (const e of events) {
    if (e.value === undefined) continue;
    if (shape.repoFlags?.includes(e.flag)) addRepo(e.value);
    if (shape.orgFlags?.includes(e.flag)) {
      if (NAME_RE.test(e.value)) repos.push(e.value.toLowerCase());
      else opaque = true;
    }
  }
  return { repos: [...new Set(repos)], opaque, replacesBase: repos.length > 0 && shape.keepsBase !== true };
}

// ---------------------------------------------------------------------------
// gh aliases (issue #151, S11)
// ---------------------------------------------------------------------------

/** Longest alias expansion (bytes of text) and deepest alias-of-alias chain the parser follows. */
const ALIAS_MAX_BYTES = 64 * 1024;
const ALIAS_MAX_DEPTH = 5;
/** `$N` placeholders are substituted for at most this many arguments. */
const ALIAS_MAX_ARGS = 64;

/**
 * gh's `shlex.Split` (github.com/google/shlex, POSIX mode): whitespace
 * separates, quotes group, `\` escapes, and a `#` that starts a word begins a
 * comment that runs to the end of the line. Never throws.
 */
function shlexSplit(text: string): string[] {
  const out: string[] = [];
  let word = "";
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === "#" && !inWord) {
      const nl = text.indexOf("\n", i);
      i = nl === -1 ? text.length : nl;
    } else if (c === "'") {
      inWord = true;
      const end = text.indexOf("'", i + 1);
      word += text.slice(i + 1, end === -1 ? text.length : end);
      i = end === -1 ? text.length : end;
    } else if (c === '"') {
      inWord = true;
      i++;
      while (i < text.length && text[i] !== '"') {
        if (text[i] === "\\" && i + 1 < text.length) i++;
        word += text[i];
        i++;
      }
    } else if (c === "\\" && i + 1 < text.length) {
      inWord = true;
      word += text[i + 1];
      i++;
    } else if (/\s/.test(c)) {
      if (inWord) out.push(word);
      word = "";
      inWord = false;
    } else {
      inWord = true;
      word += c;
    }
  }
  if (inWord) out.push(word);
  return out;
}

type AliasResult =
  | { kind: "args"; args: string[] }
  /** `!script`: arbitrary code. */
  | { kind: "shell" }
  /** The first word is neither a built-in nor a resolvable alias (an extension, a typo, an alias this parser cannot read, a cap exceeded). */
  | { kind: "unresolved" }
  /** gh itself refuses to run (a `$N` left over): nothing is published. */
  | { kind: "refused" };

/**
 * gh expands an alias only when the FIRST argument names one (and is not a
 * built-in command): `gh ic --repo stranger/r` with `ic = issue create` runs
 * `gh issue create --repo stranger/r`. A `!` expansion is a shell script. The
 * expansion mirrors gh's own: `$1`… are replaced textually, and when the
 * expansion has no `$` the remaining arguments are appended. gh expands once;
 * this parser follows an alias of an alias too (to {@link ALIAS_MAX_DEPTH}),
 * the safe superset. An expansion larger than {@link ALIAS_MAX_BYTES}, or a
 * chain deeper than the cap, is unresolved.
 */
function resolveGhAlias(input: string[], ctx: GhContext): AliasResult {
  let args = input;
  for (let depth = 0; depth <= ALIAS_MAX_DEPTH; depth++) {
    const first = args[0];
    if (first === undefined || first.startsWith("-") || GH_BUILTIN_COMMANDS.has(first)) return { kind: "args", args };
    if (depth === ALIAS_MAX_DEPTH) return { kind: "unresolved" }; // five expansions done and still not a built-in
    const expansion = ctx.aliases?.()?.get(first);
    if (expansion === undefined || expansion.length > ALIAS_MAX_BYTES) return { kind: "unresolved" };
    if (expansion.startsWith("!")) return { kind: "shell" };
    const given = args.slice(1);
    let text = expansion;
    const extra: string[] = [];
    if (!expansion.includes("$")) {
      extra.push(...given);
    } else {
      if (given.length > ALIAS_MAX_ARGS) return { kind: "unresolved" };
      for (const [i, a] of given.entries()) {
        text = text.split(`$${i + 1}`).join(a);
        if (text.length > ALIAS_MAX_BYTES) return { kind: "unresolved" };
      }
    }
    if (/\$\d/.test(text)) return { kind: "refused" };
    args = [...shlexSplit(text), ...extra];
  }
  return { kind: "unresolved" };
}

// ---------------------------------------------------------------------------
// classifyGh
// ---------------------------------------------------------------------------

/** What the caller knows about the environment `gh` will run in. */
interface GhContext {
  /** `GH_REPO` for this command: a prefix assignment, else the caller's environment. Raw. */
  envRepo: string | undefined;
  /** True when an earlier segment (or an enclosing `eval`) exports, assigns or unsets `GH_REPO`. */
  envOverridden: boolean;
  /** Lazily loaded `gh` aliases: a map, null when they could not be read; absent when the caller supplied none. */
  aliases: (() => ReadonlyMap<string, string> | null) | undefined;
}

// Subcommands of the write groups that only read. A subcommand of a write
// group that is in neither this table nor GH_VERBS is a write verb this
// parser has no shape for, and is reported `unresolved: "unknown-shape"`.
const GH_READ_SUBS: Readonly<Record<string, ReadonlySet<string>>> = {
  pr: new Set(["checkout", "checks", "diff", "list", "status", "view"]),
  issue: new Set(["list", "status", "view"]),
  release: new Set(["list", "view", "download", "verify", "verify-asset"]),
  repo: new Set(["clone", "list", "view", "set-default", "gitignore", "license", "credits", "garden"]),
  gist: new Set(["clone", "list", "view"]),
  workflow: new Set(["list", "view"]),
  run: new Set(["list", "view", "watch", "download"]),
  secret: new Set(["list"]),
  variable: new Set(["list", "get"]),
  label: new Set(["list"]),
  ruleset: new Set(["list", "view"]),
};

// The verb an unrecognised write subcommand of each group is reported as.
const GH_UNKNOWN_SUB_VERB: Readonly<Record<string, EgressVerb>> = {
  pr: "gh-pr-edit",
  issue: "gh-issue-edit",
  release: "gh-release-edit",
  repo: "gh-repo-edit",
  gist: "gh-gist-create",
  workflow: "gh-workflow-run",
  run: "gh-workflow-run",
  secret: "gh-repo-edit",
  variable: "gh-repo-edit",
  label: "gh-repo-edit",
  ruleset: "gh-repo-edit",
};

function ownEntry<T>(table: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

/** An intent for a command whose verb or target the parser cannot determine: it fails CLOSED. */
function unresolvedIntent(
  base: Omit<EgressIntent, "verb" | "payloadFiles">,
  verb: EgressVerb,
  unresolved: IntentUnresolved,
): EgressIntent {
  return { ...base, verb, payloadFiles: [], unresolved };
}

function classifyGh(
  rawArgs: string[],
  base: Omit<EgressIntent, "verb" | "payloadFiles">,
  ctx: GhContext,
  aliasDepth = 0,
): EgressIntent | null {
  const aliased = resolveGhAlias(rawArgs, ctx);
  if (aliased.kind === "refused") return null;
  if (aliased.kind === "shell") return unresolvedIntent(base, "gh-alias-shell", "gh-alias");
  if (aliased.kind === "unresolved") return unresolvedIntent(base, "gh-unknown", "gh-alias");
  const args = aliased.args;

  const found = findGhCommand(args);
  if (found === null) return null;
  const { groupIdx, subIdx } = found;
  const group = args[groupIdx]!;
  const sub = subIdx === undefined ? undefined : args[subIdx];
  // Not a built-in: an alias after leading flags, an extension, a brace expansion, `$CMD`. Unknown fails closed.
  if (!GH_BUILTIN_COMMANDS.has(group)) return unresolvedIntent(base, "gh-unknown", "gh-alias");

  // An alias can be keyed on a group and subcommand (`"pr co"`, `"search ic"`): it expands in place. gh never
  // lets one shadow a built-in subcommand, so the aliases are only consulted for a subcommand this parser
  // does not already know — which keeps the common path free of any file read.
  const keyedAlias = (): { intent: EgressIntent | null } | undefined => {
    if (sub === undefined) return undefined;
    const expansion = ctx.aliases?.()?.get(`${group} ${sub}`);
    if (expansion === undefined) return undefined;
    if (expansion.startsWith("!")) return { intent: unresolvedIntent(base, "gh-alias-shell", "gh-alias") };
    if (aliasDepth >= ALIAS_MAX_DEPTH || expansion.length > ALIAS_MAX_BYTES) {
      return { intent: unresolvedIntent(base, "gh-unknown", "gh-alias") };
    }
    const others = args.filter((_, idx) => idx !== groupIdx && idx !== subIdx);
    return { intent: classifyGh([...shlexSplit(expansion), ...others], base, ctx, aliasDepth + 1) };
  };

  let verb: EgressVerb;
  let unresolved: IntentUnresolved | undefined;
  if (group === "api") {
    verb = "gh-api-mutating"; // provisional; confirmed below
  } else {
    const verbs = ownEntry(GH_VERBS, group);
    if (verbs === undefined) {
      const readSubs = ownEntry(GH_READ_GROUP_SUBS, group);
      if (readSubs !== undefined) {
        if (readSubs === "any" || sub === undefined || readSubs.has(sub)) return null;
        // Not a known subcommand of this read group: an alias it may be. With the aliases known and none
        // matching it is an error in gh (nothing is published); with them unknown it may be an alias this
        // parser cannot expand.
        const keyed = keyedAlias();
        if (keyed !== undefined) return keyed.intent;
        return ctx.aliases?.() ? null : unresolvedIntent(base, "gh-unknown", "gh-alias");
      }
      // A built-in group with no shape here: its reads are no intent, the rest are writes we cannot name.
      if (sub === undefined || GH_UNMODELLED_READ_SUBS[group]?.has(sub)) return null;
      const keyed = keyedAlias();
      return keyed !== undefined ? keyed.intent : unresolvedIntent(base, "gh-unknown", "unknown-shape");
    }
    if (sub === undefined) return null;
    const known = ownEntry(verbs, sub);
    if (known !== undefined) {
      verb = known;
    } else if (GH_READ_SUBS[group]?.has(sub)) {
      return null;
    } else {
      const keyed = keyedAlias();
      if (keyed !== undefined) return keyed.intent;
      verb = GH_UNKNOWN_SUB_VERB[group] ?? "gh-repo-edit";
      unresolved = "unknown-shape";
    }
  }

  const skip = new Set<number>([groupIdx]);
  if (subIdx !== undefined) skip.add(subIdx);
  const { events, positionals } = scanGhArgs(args, skip, flagSpec(group, sub));

  const payloadFiles: string[] = [];
  const repoFlag = lastValue(events, "-R", "--repo");
  let method: string | undefined;
  let hasFields = false;
  // `gh api graphql` document sources; only attached to the intent when the
  // endpoint turns out to be the GraphQL one (it may come after the flags).
  let gqlQuery: string | undefined;
  let gqlQueryFile: string | undefined;
  let gqlInputFile: string | undefined;

  for (const { flag, value } of events) {
    if (flag === "--body-file" || flag === "--notes-file" || flag === "--input") {
      if (value !== undefined) {
        payloadFiles.push(value);
        if (group === "api" && flag === "--input") gqlInputFile = value;
      }
      continue;
    }
    if (flag === "-F" || flag === "--field" || flag === "-f" || flag === "--raw-field") {
      if (group === "api") {
        // `-F key=@path` reads the value from a file; `-f` never does.
        hasFields = true;
        const typed = flag === "-F" || flag === "--field";
        if (typed && value !== undefined) {
          const at = value.indexOf("=@");
          if (at !== -1) payloadFiles.push(value.slice(at + 2));
        }
        if (value !== undefined && value.startsWith("query=")) {
          const v = value.slice("query=".length);
          if (typed && v.startsWith("@")) gqlQueryFile = v.slice(1);
          else gqlQuery = v;
        }
      } else if (flag === "-F" && value !== undefined) {
        // `-F` is `--body-file` on pr/issue/release commands.
        payloadFiles.push(value);
      }
      continue;
    }
    if (flag === "--body" || flag === "-b") {
      if (value !== undefined && value.startsWith("@") && value.length > 1) payloadFiles.push(value.slice(1));
      continue;
    }
    if (flag === "-X" || flag === "--method") {
      if (value !== undefined) method = value.toUpperCase();
      continue;
    }
  }

  const apiEndpoint = group === "api" ? positionals[0] : undefined;
  if (group === "api") {
    const mutating =
      method !== undefined ? MUTATING_METHODS.has(method) : hasFields || payloadFiles.length > 0;
    if (!mutating) return null;
  }

  const graphql =
    group === "api" && apiEndpoint !== undefined && isGraphqlEndpoint(apiEndpoint)
      ? {
          ...(gqlQuery !== undefined && { query: gqlQuery }),
          ...(gqlQueryFile !== undefined && { queryFile: gqlQueryFile }),
          ...(gqlInputFile !== undefined && { inputFile: gqlInputFile }),
        }
      : undefined;

  // Arguments forwarded from a function or script (`"$@"`) or left to a shell expansion in a positional can
  // carry a repository this parser never sees.
  if (
    unresolved === undefined &&
    (args.some(a => /\$[@*]|\$\{[@*]/.test(a)) || positionals.some((p, idx) => hasExpansion(p) && !(group === "api" && idx === 0)))
  ) {
    unresolved = "unparsed-shape";
  }

  // --- the repository this command names ---------------------------------------
  const targets = collectRepoTargets(group, sub, events, positionals);
  let opaque = targets.opaque;
  if (repoFlag !== undefined && parseRepoRef(repoFlag) === null) opaque = true;

  // `GH_REPO` applies only when nothing more specific names the repository:
  // `--repo` beats it, a URL / `o/r` positional replaces the base repo, and
  // `gh api` consults it only to fill `{owner}`/`{repo}` placeholders in the
  // endpoint (a spelled-out `repos/<o>/<r>/…`, `graphql` and the like never do).
  const apiTarget = group === "api" && apiEndpoint !== undefined ? analyseApiEndpoint(apiEndpoint) : null;
  // A placeholder in the owner/repo segment that is not `{owner}`/`{repo}`, or a shell expansion there, cannot be named offline.
  if (apiTarget?.kind === "opaque") opaque = true;
  const apiIgnoresEnv = group === "api" && apiTarget?.kind !== "cwd";
  const envApplies = repoFlag === undefined && !targets.replacesBase && !apiIgnoresEnv;
  let envRepo: string | undefined;
  if (envApplies && ctx.envRepo !== undefined) {
    const parsed = parseRepoRef(ctx.envRepo);
    if (parsed === null) opaque = true;
    else envRepo = `${parsed.org}/${parsed.repo}`;
  }
  // Precedence of the reasons: an opaque slot, then an overridden environment, then an unknown shape.
  if (envApplies && ctx.envOverridden) unresolved = "env-override";
  if (opaque) unresolved = "opaque-repo";

  const [positionalRepo, ...extraRepos] = targets.repos;
  return {
    ...base,
    verb,
    payloadFiles,
    ...(repoFlag !== undefined && { repoFlag }),
    ...(envRepo !== undefined && { envRepo }),
    ...(positionalRepo !== undefined && { positionalRepo }),
    ...(extraRepos.length > 0 && { extraRepos }),
    ...(apiEndpoint !== undefined && { apiEndpoint }),
    ...(graphql !== undefined && { graphql }),
    ...(unresolved !== undefined && { unresolved }),
  };
}

function classifyNpm(
  tool: string,
  args: string[],
  base: Omit<EgressIntent, "verb" | "payloadFiles">,
): EgressIntent | null {
  // `npm publish`, `pnpm publish`, `yarn publish`, `yarn npm publish`.
  let i = 0;
  while (i < args.length && args[i]!.startsWith("-")) i++;
  if (tool === "yarn" && args[i] === "npm") i++;
  if (args[i] !== "publish") return null;
  return { ...base, verb: "npm-publish", payloadFiles: [] };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * What the caller knows about the environment the command will run in. Every
 * field is optional, and the parser stays pure: the caller reads the
 * environment and the filesystem (see `egressParseOptions`), the parser only
 * uses what it is handed.
 */
export interface ParseEgressOptions {
  /**
   * `GH_REPO` in the environment `gh` will inherit — `process.env.GH_REPO`
   * in the shim, whose environment IS the real `gh`'s. A command-prefix
   * assignment (`GH_REPO=o/r gh …`) takes precedence over it.
   */
  envRepo?: string | undefined;
  /**
   * The user's `gh` aliases (alias name → expansion), or a function that
   * loads them, called at most once and only when a `gh` command needs them.
   * `null` (or a loader that returns null or throws) means the aliases could
   * NOT be read: a `gh` word that is not a built-in is then unresolved, as it is
   * without this option (it may be an alias, an extension, or a typo).
   */
  ghAliases?:
    | ReadonlyMap<string, string>
    | null
    | (() => ReadonlyMap<string, string> | null)
    | undefined;
  /**
   * The git aliases in effect (`git config -z --get-regexp '^alias\.'`, name → expansion), or a loader that
   * is given the directory git will use (`-C`, `--git-dir`, `GIT_DIR`; undefined: the cwd). Called only for a
   * git subcommand that is not a built-in, once per directory. `null` means they could not be read. Without
   * this option a non-built-in subcommand is treated as not a push.
   */
  gitAliases?:
    | ReadonlyMap<string, string>
    | null
    | ((dir?: string) => ReadonlyMap<string, string> | null)
    | undefined;
}

/** How deep `sh -c '…'`, `eval`, `$(…)` and backtick text is followed. Deeper text that mentions gh/git is unresolved. */
const MAX_NEST_DEPTH = 5;

/** An alias the command line defined (`alias gh2='gh …'`): later uses of the name cannot be read. */
interface TaintedAlias {
  kind: "gh" | "git";
  /** The definition itself names a push, so every use of the alias is a push. */
  push: boolean;
}

interface ParseCtx {
  opts: ParseEgressOptions;
  aliases: (() => ReadonlyMap<string, string> | null) | undefined;
  gitAliases: ((dir?: string) => ReadonlyMap<string, string> | null) | undefined;
  depth: number;
  /** An earlier segment (of this or an enclosing command line) changed `GH_REPO` for the ones after it. */
  envOverridden: boolean;
  /** `GH_REPO` as the enclosing command line set it for this text; falls back to `opts.envRepo`. */
  inheritedEnvRepo: string | undefined;
  /** Shell aliases defined earlier on this line that mention gh or git; shared by every nested parse. */
  tainted: Map<string, TaintedAlias>;
  /**
   * This text is the RESULT of a command substitution that becomes a command word or `eval` / `sh -c` text
   * (`eval "$(cat <<'EOF' … EOF)"`): a heredoc inside it is a program, not data.
   */
  heredocsAreCode: boolean;
}

/** A lazy, memoised, never-throwing loader: a failed load is `null` ("could not be read"). */
function memoLoader(
  source: ReadonlyMap<string, string> | null | (() => ReadonlyMap<string, string> | null) | undefined,
): (() => ReadonlyMap<string, string> | null) | undefined {
  if (source === undefined) return undefined;
  let loaded = false;
  let value: ReadonlyMap<string, string> | null = null;
  return () => {
    if (!loaded) {
      loaded = true;
      try {
        value = typeof source === "function" ? source() : source;
      } catch {
        value = null;
      }
    }
    return value;
  };
}

/** Like {@link memoLoader}, for a loader that takes a directory: memoised per directory. */
function memoDirLoader(
  source: ReadonlyMap<string, string> | null | ((dir?: string) => ReadonlyMap<string, string> | null) | undefined,
): ((dir?: string) => ReadonlyMap<string, string> | null) | undefined {
  if (source === undefined) return undefined;
  if (typeof source !== "function") return () => source;
  const cache = new Map<string | undefined, ReadonlyMap<string, string> | null>();
  return dir => {
    if (!cache.has(dir)) {
      let value: ReadonlyMap<string, string> | null;
      try {
        value = source(dir);
      } catch {
        value = null;
      }
      cache.set(dir, value);
    }
    return cache.get(dir) ?? null;
  };
}

/**
 * Tokenise (quote-aware), split on shell operators, classify each segment.
 * Pure. Non-egress commands yield an empty list.
 *
 * This parser FAILS CLOSED, in two layers.
 *
 * 1. Every segment that runs `gh`, or `git push` (also `send-pack`, `http-push`), directly or through a
 *    wrapper, reserved word, interpreter, alias or substitution, and whose verb or target cannot be fully
 *    determined, yields an intent with `unresolved` set — never an empty list. An exception while parsing a
 *    line that mentions `gh` or `git push` yields such an intent too.
 * 2. A BACKSTOP then reads the command's text again. Every mention of `gh <group>` (a built-in gh command
 *    word within a few words of a `gh` word, however it is spelled: `gh`, `"gh"`, `g\h`, `/usr/bin/gh`) or
 *    `git push|send-pack|http-push`, wherever it sits — an interpreter's `-c`/`-e` text, a `find -exec`
 *    or `parallel` argument, a `case` pattern body, a function body, a heredoc fed to a shell or an
 *    interpreter, a `<(…)` process substitution — that no intent accounts for becomes an `unparsed-shape`
 *    intent at that position.
 *
 * The accepted false positive: a LITERAL mention in a quoted argument, such as `echo "gh issue create"`,
 * `printf '%s' 'git push'` or `python3 -c "print('gh pr list')"`, is reported too. (Searches such as
 * `grep "git push" docs/`, the message of a `git commit -m`, and the value of any flag of a command that
 * the parser understood (`gh pr create --body "… git push …"`) are not mentioned: those words are data.)
 * Aliases and functions defined in the user's shell profile are invisible to a pre-command hook; the `gh`
 * shim, which sees the real argument vector, covers them.
 */
export function parseEgressIntents(command: string, opts: ParseEgressOptions = {}): EgressIntent[] {
  try {
    return parseUnsafe(command, {
      opts,
      aliases: memoLoader(opts.ghAliases),
      gitAliases: memoDirLoader(opts.gitAliases),
      depth: 0,
      envOverridden: false,
      inheritedEnvRepo: undefined,
      tainted: new Map(),
      heredocsAreCode: false,
    });
  } catch {
    const s = typeof command === "string" ? sentinelFor(command, { precededByCd: false, joinedBy: null, segmentIndex: 0 }) : null;
    return s === null ? [] : [s];
  }
}

/** `gh` as a word (not `ghost`, not `my-gh`), or `git` with `push` as a word. */
function mentionedEgress(text: string): "gh" | "git" | null {
  if (/(?:^|[^\w-])gh(?![\w-])/.test(text)) return "gh";
  if (/(?:^|[^\w-])git(?![\w-])/.test(text) && /(?:^|[^\w-])push(?![\w-])/.test(text)) return "git";
  return null;
}

/** The fail-closed intent for text the parser could not work through, or null when it does not mention gh / git push. */
function sentinelFor(text: string, base: Omit<EgressIntent, "verb" | "payloadFiles">): EgressIntent | null {
  const which = mentionedEgress(text);
  if (which === null) return null;
  return which === "gh" ? unresolvedIntent(base, "gh-unknown", "unparsed-shape") : unresolvedGitIntent(base);
}

/**
 * The command texts of `$(…)` and `` `…` `` substitutions inside one word (at most 32), and the word with
 * those spans cut out (their text is parsed on its own, so it must not be scanned twice).
 */
function splitSubstitutions(word: string): { texts: string[]; rest: string } {
  if (!word.includes("$(") && !word.includes("`")) return { texts: [], rest: word };
  const texts: string[] = [];
  let rest = "";
  let i = 0;
  while (i < word.length) {
    if (texts.length < 32 && word[i] === "$" && word[i + 1] === "(") {
      let depth = 0;
      let j = i + 1;
      for (; j < word.length; j++) {
        if (word[j] === "(") depth++;
        else if (word[j] === ")" && --depth === 0) break;
      }
      texts.push(word.slice(i + 2, j));
      rest += " ";
      i = j + 1;
    } else if (texts.length < 32 && word[i] === "`") {
      const end = word.indexOf("`", i + 1);
      const j = end === -1 ? word.length : end;
      texts.push(word.slice(i + 1, j));
      rest += " ";
      i = j + 1;
    } else {
      rest += word[i];
      i++;
    }
  }
  return { texts, rest };
}

/** The command texts of `$(…)` and `` `…` `` substitutions inside one word (at most 32). */
function substitutionTexts(word: string): string[] {
  return splitSubstitutions(word).texts;
}

/** Bash brace expansion of the first `{a,b}` group, recursively, at most 64 results. */
function braceCandidates(word: string): string[] {
  const m = /^([^{]*)\{([^{}]*)\}([\s\S]*)$/.exec(word);
  if (m === null || !m[2]!.includes(",")) return [word];
  const out: string[] = [];
  for (const alt of m[2]!.split(",")) {
    for (const c of braceCandidates(`${m[1]}${alt}${m[3]}`)) {
      out.push(c);
      if (out.length >= 64) return out;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The backstop: read the text again
// ---------------------------------------------------------------------------

/**
 * How many ordinary words after a `gh` / `git` word a group or `push` may sit and still be one mention. Flag
 * words (starting with `-`) and the one word after each (its value) are free, so `gh -R a/b -R a/b … issue
 * create` is found however many flags come between; the whole look-ahead is also capped at
 * {@link MENTION_MAX_WORDS} words, which keeps the scan linear.
 */
const MENTION_WINDOW = 8;
const MENTION_MAX_WORDS = 64;
// `!` so that `credential.helper=!gh auth git-credential` exposes its `gh`.
const WORD_SPLIT = /[\s'"`(){}<>;&|,=!\\[\]]+/;

const isGhWord = (w: string): boolean => w === "gh" || w.endsWith("/gh");
const isGitWord = (w: string): boolean => w === "git" || w.endsWith("/git");

/** Whether `hit` matches a word after `words[from]` within the mention window (flags and their values are free). */
function findAfter(words: readonly string[], from: number, hit: (w: string) => boolean): boolean {
  let counted = 0;
  let afterFlag = false;
  for (let j = from + 1; j < words.length && j <= from + MENTION_MAX_WORDS; j++) {
    const w = words[j]!;
    if (hit(w)) return true;
    if (w.startsWith("-")) {
      afterFlag = true;
    } else if (afterFlag) {
      afterFlag = false;
    } else if (++counted >= MENTION_WINDOW) {
      return false;
    }
  }
  return false;
}

/**
 * The words of some tokens, split the way a shell and a script's string literals would split them, with
 * command substitutions cut out. Linear in the text.
 */
function flattenWords(tokens: readonly string[]): string[] {
  const words: string[] = [];
  for (const t of tokens) {
    const { rest } = splitSubstitutions(t);
    for (const w of rest.split(WORD_SPLIT)) {
      if (w === "") continue;
      words.push(w);
      // `-Ogh` / `-xgh`: a short flag with its value attached; the value is a word of its own too.
      if (w.length > 2 && w[0] === "-" && w[1] !== "-") words.push(w.slice(2));
    }
  }
  return words;
}

/** The `gh <group>` and `git push` mentions in a word list. Linear: each word looks at a bounded window. */
function countMentions(words: readonly string[]): { gh: number; git: number } {
  let gh = 0;
  let git = 0;
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    if (isGhWord(w)) {
      if (findAfter(words, i, x => GH_BUILTIN_COMMANDS.has(x))) gh++;
    } else if (isGitWord(w)) {
      if (findAfter(words, i, x => GIT_PUSH_LIKE.has(x))) git++;
    }
  }
  return { gh, git };
}

/** Commands whose arguments are text to search, never to run. */
const SEARCH_COMMANDS = new Set(["grep", "egrep", "fgrep", "rg", "ag", "ack"]);

/** Interpreters that read a program from stdin: a heredoc fed to one is scanned, not skipped. */
const SCRIPT_INTERPRETER_RE = /^(?:python[\d.]*|perl|ruby|node|nodejs|php|lua|Rscript|osascript|tclsh|expect|awk|gawk)$/;

/**
 * Flags whose value is a message or a posted field — text, never a command. `git -c`, `--exec`, `-x`,
 * `--upload-pack`, `--receive-pack`, `-O`, `--extcmd` and the like are NOT here: those values run.
 */
const GH_DATA_FLAGS = new Set([
  "-b", "--body", "-t", "--title", "-n", "--notes", "-d", "--description", "--subject", "--comment",
  "--message", "-m", "-f", "-F", "--field", "--raw-field",
]);
// (`--grep`, `-S`, `-G` and the like take a search pattern; `git log --grep='git push'` is a search.)
const GIT_DATA_FLAGS = new Set(["-m", "--message", "--grep", "-S", "-G", "--author", "--committer", "--since", "--until"]);

/** How a token relates to a message flag of `cmd`: its value is the NEXT token, is ATTACHED to it, or it is no message flag. */
function messageFlag(cmd: "gh" | "git", t: string): "next" | "attached" | null {
  const flags = cmd === "gh" ? GH_DATA_FLAGS : GIT_DATA_FLAGS;
  if (flags.has(t)) return "next";
  const eq = t.indexOf("=");
  if (t.startsWith("--") && eq > 0 && flags.has(t.slice(0, eq))) return "attached";
  if (!t.startsWith("--") && t.length > 2) {
    // `-mTEXT` (attached); and for git a group ending in `m` (`-am TEXT`).
    if (flags.has(t.slice(0, 2)) && t[1] !== undefined) return "attached";
    if (cmd === "git" && /^-[A-Za-z]+m$/.test(t)) return "next";
  }
  return null;
}

/** Search commands: only these flags can run something, and only these values. */
const SEARCH_RUN_FLAGS = new Set(["--pager", "--pre"]);

/**
 * The tokens of a segment the backstop reads. Everything is read, except:
 *
 * - for `gh` and `git`, the value of a MESSAGE flag (`-m`, `--message`, `--body`, `--title`, …), which is
 *   text; the value of `-c`, `--config-env`, `--exec`, `-x`, `-O`, `--extcmd`, `--upload-pack`, … is a command
 *   in disguise and is read;
 * - for a search (`grep`, `rg`, `ag`, `ack`), the positional pattern and path arguments, but not the flags
 *   or the values of `--pager` / `--pre`, which run a command.
 *
 * `nestedFrom` onwards is parsed as a command line of its own.
 */
function scanTokens(tokens: readonly string[], start: number, cmd: string, nestedFrom: number | undefined): string[] {
  const end = nestedFrom ?? tokens.length;
  if (SEARCH_COMMANDS.has(cmd)) {
    const out = tokens.slice(0, Math.min(start + 1, end));
    for (let k = start + 1; k < end; k++) {
      const t = tokens[k]!;
      if (!t.startsWith("-")) continue;
      out.push(t);
      if (SEARCH_RUN_FLAGS.has(t) && k + 1 < end) out.push(tokens[++k]!);
    }
    return out;
  }
  if (cmd !== "gh" && cmd !== "git") return tokens.slice(0, end);
  const out = tokens.slice(0, start + 1);
  for (let k = start + 1; k < end; k++) {
    const t = tokens[k]!;
    const kind = t.startsWith("-") ? messageFlag(cmd, t) : null;
    if (kind === "attached") continue;
    if (kind === "next") {
      k++;
      continue;
    }
    out.push(t);
  }
  return out;
}

/** True when this segment changes — or may change — `GH_REPO` for the segments after it. */
function mutatesGhRepo(original: string[], resolved: ResolvedCommand, assigns: Assignment[]): boolean {
  if (original.some((t, i) => (t === "GH_REPO" && (original[i - 1] === "-u" || original[i - 1] === "--unset")) || t === "--unset=GH_REPO" || t === "-uGH_REPO")) {
    return true; // `env -u GH_REPO`
  }
  const { tokens, start } = resolved;
  if (start >= tokens.length) return assigns.some(a => a.name === "GH_REPO"); // `GH_REPO=o/r` on its own
  const cmd = baseName(tokens[start]!);
  const args = tokens.slice(start + 1);
  const names = (a: string): boolean => a === "GH_REPO" || a.startsWith("GH_REPO=") || a.startsWith("GH_REPO+=");
  switch (cmd) {
    case "export":
    case "declare":
    case "typeset":
    case "readonly":
    case "local":
    case "unset":
    case "read":
      return args.some(names);
    case "printf":
      return args.some((a, i) => a === "-v" && args[i + 1] === "GH_REPO");
    case "set":
      // `set -a` / `set -o allexport`: every later assignment is exported.
      return args.some(a => /^-[A-Za-z]*a[A-Za-z]*$/.test(a) || a === "allexport");
    case "eval":
    case "source":
    case ".":
      return true; // runs text or a file this parser cannot see, in THIS shell
    default:
      return false;
  }
}

/** `$GH issue create`, `"${GH}" pr comment 5`, `$(which gh) push`: a command word the parser cannot read, then a gh group or a push. */
function hiddenCommandKind(args: readonly string[]): "gh" | "git" | null {
  const words = ["", ...args];
  if (findAfter(words, 0, a => GH_BUILTIN_COMMANDS.has(a))) return "gh";
  if (findAfter(words, 0, a => GIT_PUSH_LIKE.has(a))) return "git";
  return null;
}

/** True when the whole token is one command substitution (`$(…)` or `` `…` ``), so its result IS the word. */
function isWholeSubstitution(word: string): boolean {
  const { texts, rest } = splitSubstitutions(word);
  return texts.length > 0 && rest.trim() === "";
}

/** Commands that run a program read from stdin, whatever fed it. */
const STDIN_RUNNERS = new Set(["source", ".", "make", "gmake", "at", "batch"]);

/** A shell invoked with no `-c` and no script argument reads its commands from stdin. */
function readsCommandsFromStdin(args: readonly string[]): boolean {
  if (args.some(a => /^-[A-Za-z]*s[A-Za-z]*$/.test(a) && !a.startsWith("--"))) return true; // `sh -s`
  return !args.some(a => !a.startsWith("-")); // `-` alone is stdin, not a script
}

/** Text a shell command line is fed on stdin by `<<<` here-strings (the tokeniser leaves them in the tokens). */
function hereStrings(tokens: readonly string[]): string[] {
  const out: string[] = [];
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k]!;
    if (t === "<<<") {
      const next = tokens[k + 1];
      if (next !== undefined) out.push(next);
    } else if (t.startsWith("<<<")) {
      out.push(t.slice(3));
    }
  }
  return out;
}

function parseUnsafe(command: string, ctx: ParseCtx): EgressIntent[] {
  if (typeof command !== "string" || command.length === 0) return [];
  const segments = tokenise(command);
  const intents: EgressIntent[] = [];
  let precededByCd = false;
  let envOverridden = ctx.envOverridden;

  segments.forEach((seg, segmentIndex) => {
    const base = { precededByCd, joinedBy: seg.joinedBy, segmentIndex };
    // A function definition's first token is the function's name, not a command.
    const rawTokens = seg.funcDef ? seg.tokens.slice(1) : seg.tokens;
    const strings = hereStrings(rawTokens);
    const tokens = stripRedirections(rawTokens);
    /** This segment's command word already got a fail-closed intent for what it hides. */
    let hidden = false;

    /** Parse `text` as a command line of its own; its intents take this segment's place in the chain. */
    const nest = (text: string, envRepo: string | undefined, code = false): void => {
      if (ctx.depth >= MAX_NEST_DEPTH) {
        const s = sentinelFor(text, base);
        if (s !== null) intents.push(s);
        return;
      }
      const child: ParseCtx = { ...ctx, depth: ctx.depth + 1, envOverridden, inheritedEnvRepo: envRepo, heredocsAreCode: code };
      for (const i of parseUnsafe(text, child)) {
        intents.push({ ...i, segmentIndex, joinedBy: i.joinedBy ?? seg.joinedBy, precededByCd: i.precededByCd || precededByCd });
      }
    };
    /** Emit a fail-closed intent for what this segment hides. */
    const sentinel = (kind: "gh" | "git"): void => {
      hidden = true;
      intents.push(kind === "gh" ? unresolvedIntent(base, "gh-unknown", "unparsed-shape") : unresolvedGitIntent(base));
    };

    try {
      const assigns: Assignment[] = [];
      const resolved = resolveCommand(tokens, assigns);
      const toks = resolved.tokens;

      // `GH_REPO` as gh will see it: the command's own prefix over the enclosing environment.
      let envRaw = ctx.inheritedEnvRepo ?? ctx.opts.envRepo;
      for (const a of assigns) if (a.name === "GH_REPO") envRaw = a.append ? `${envRaw ?? ""}${a.value}` : a.value;
      if (envRaw === "") envRaw = undefined;

      // Command substitutions run whatever their text says, wherever they sit in the line. (The text
      // of `bash -c` / `eval` is parsed whole below, substitutions included.)
      if (resolved.nestedText === undefined) {
        for (const w of tokens) {
          // A substitution that IS the command word runs its output: a heredoc inside it is a program.
          const code = isWholeSubstitution(w) && w === toks[resolved.start];
          for (const inner of substitutionTexts(w)) nest(inner, envRaw, code);
        }
      }

      if (resolved.exhausted) {
        const s = sentinelFor(tokens.join(" "), base);
        if (s !== null) intents.push(s);
        return;
      }
      if (resolved.start >= toks.length) {
        if (mutatesGhRepo(tokens, resolved, assigns)) envOverridden = true;
        return;
      }
      const word = toks[resolved.start]!;
      const cmd = baseName(word);
      const args = toks.slice(resolved.start + 1);

      if (resolved.nestedText !== undefined) {
        nest(resolved.nestedText, envRaw);
      } else if (cmd === "alias") {
        // `alias gh2='gh issue create'`: later uses of the name cannot be read. (Aliases from the user's
        // profile are invisible here; the shim covers them.)
        for (const a of args) {
          const eq = a.indexOf("=");
          if (eq <= 0) continue;
          const value = a.slice(eq + 1);
          const words = flattenWords([value]);
          const kind = words.some(isGhWord) ? "gh" : words.some(isGitWord) ? "git" : null;
          if (kind !== null) {
            ctx.tainted.set(a.slice(0, eq), { kind, push: words.some(w => GIT_PUSH_LIKE.has(w)) });
          }
        }
        return;
      } else {
        let intent: EgressIntent | null = null;
        const taint = ctx.tainted.get(word);
        if (taint !== undefined) {
          if (taint.kind === "gh" || taint.push || hiddenCommandKind(args) === "git") sentinel(taint.kind);
        } else if (cmd === "git") intent = classifyGit(args, base, assigns, { aliases: ctx.gitAliases });
        else if (cmd === "gh") {
          intent = classifyGh(args, base, { envRepo: envRaw, envOverridden, aliases: ctx.aliases });
        } else if (cmd === "npm" || cmd === "pnpm" || cmd === "yarn") intent = classifyNpm(cmd, args, base);
        else if (hasExpansion(word)) {
          // `$GH issue create`, `$(which gh) pr comment 5`: the command is whatever the expansion yields.
          const kind = hiddenCommandKind(args);
          if (kind !== null) sentinel(kind);
        } else if (word.includes("{")) {
          // `{gh,} issue create` / `g{h,} …` is brace-expanded by the shell into the command that actually runs.
          const candidates = braceCandidates(word).map(baseName);
          if (candidates.includes("gh")) sentinel("gh");
          else if (candidates.includes("git") && args.some(a => GIT_PUSH_LIKE.has(a))) sentinel("git");
        }
        if (intent !== null) {
          // Arguments arriving on stdin are invisible here: the target cannot be named.
          if (resolved.viaXargs && intent.unresolved === undefined) intent = { ...intent, unresolved: "unparsed-shape" };
          intents.push(intent);
        }
      }

      // Text fed to this command on stdin. A shell runs it as commands. It is also read (for mentions) when
      // the command is a script interpreter or a runner of stdin (`source`, `make`, `at`, `batch`), when the
      // segment pipes onward (`cat <<EOF | sh`, `tee >(sh) <<EOF`), or when this whole text is a command
      // substitution's result that becomes a command word or `eval` / `sh -c` text. Otherwise a heredoc is data
      // (`cat <<EOF > notes.md`, `git commit -F - <<EOF`, `git commit -m "$(cat <<EOF … EOF)"`).
      const stdinTexts = [...seg.heredocs, ...strings];
      const scriptTexts: string[] = [];
      if (stdinTexts.length > 0 && resolved.nestedText === undefined) {
        const pipesOnward = segments[segmentIndex + 1]?.joinedBy === "|";
        if (SHELL_INTERPRETERS.has(cmd)) for (const t of stdinTexts) nest(t, envRaw);
        else if (ctx.heredocsAreCode || pipesOnward || STDIN_RUNNERS.has(cmd) || SCRIPT_INTERPRETER_RE.test(cmd)) {
          scriptTexts.push(...stdinTexts);
        }
      }
      // A shell that reads its commands from a pipe: whatever feeds it can be anything.
      if (
        seg.joinedBy === "|" &&
        SHELL_INTERPRETERS.has(cmd) &&
        resolved.nestedText === undefined &&
        stdinTexts.length === 0 &&
        readsCommandsFromStdin(args)
      ) {
        sentinel("gh");
      }

      // --- the backstop ---------------------------------------------------------------------------
      // Re-read this segment's text. A mention of `gh <group>` / `git push` that the parser did not turn
      // into an intent of its own (the command word's own mention is the one it did) is reported.
      if (!hidden) {
        // `GIT_PAGER='gh …' git log`: a variable assigned for this command can name a program too.
        const found = countMentions(
          flattenWords([...scanTokens(toks, resolved.start, cmd, resolved.nestedFrom), ...assigns.map(a => a.value), ...scriptTexts]),
        );
        if (found.gh > (cmd === "gh" ? 1 : 0)) sentinel("gh");
        if (found.git > (cmd === "git" ? 1 : 0)) sentinel("git");
      }

      if (mutatesGhRepo(tokens, resolved, assigns)) envOverridden = true;
      // A `cd` anywhere earlier in the line taints every later segment: the
      // directory change may not have happened (failed `cd` under `;`), and
      // in an agent's tool call it never persists past the call anyway.
      if (cmd === "cd" || cmd === "pushd") precededByCd = true;
    } catch {
      const s = sentinelFor(tokens.join(" "), base);
      if (s !== null) intents.push(s);
    }
  });

  return intents;
}
