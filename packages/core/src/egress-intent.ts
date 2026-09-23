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
// to the agent as a tool failure instead of a decision. Anything it cannot
// parse yields no intent, which the policy treats as "not egress" — the
// shape rules only ever refuse what they positively recognise.
//
// What it recognises today: `git push`, the mutating `gh` verbs, and
// `npm|pnpm|yarn publish`. What it deliberately does not attempt: a full
// POSIX shell grammar. Quotes, backslash escapes, `$(...)` / backtick
// substitution, `${...}`, redirections, heredocs, comments and the segment
// operators (`;`, `&&`, `||`, `|`, `&`, newline) are handled well enough
// that the two incident commands and their obvious variants classify
// correctly; exotic constructs degrade to "no intent", never to a crash.

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
  /** `gh api` with `-X POST|PATCH|PUT|DELETE`, or with fields and no explicit method (gh then POSTs). */
  | "gh-api-mutating"
  | "npm-publish";

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
}

/**
 * Quote-aware split of a command line into operator-delimited segments.
 * Never throws: a malformed line (unterminated quote, dangling operator)
 * yields whatever segments were complete before the problem.
 */
function tokenise(command: string): Segment[] {
  const segments: Segment[] = [];
  let tokens: string[] = [];
  let word = "";
  let inWord = false;
  let joinedBy: SegmentJoin = null;
  // Heredoc bodies must not be parsed as commands. When `<<WORD` is seen,
  // the delimiter is queued; at the next newline the body is skipped up to
  // (and including) the line that equals the delimiter.
  const pendingHeredocs: string[] = [];

  const pushWord = (): void => {
    if (inWord) {
      tokens.push(word);
      word = "";
      inWord = false;
    }
  };
  const endSegment = (nextJoin: SegmentJoin): void => {
    pushWord();
    if (tokens.length > 0) segments.push({ tokens, joinedBy });
    tokens = [];
    joinedBy = nextJoin;
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
          const delim = pendingHeredocs.shift()!;
          for (;;) {
            const nl = command.indexOf("\n", i);
            const line = nl === -1 ? command.slice(i) : command.slice(i, nl);
            i = nl === -1 ? n : nl + 1;
            if (line.replace(/^\t+/, "") === delim || nl === -1) break;
          }
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
    if (c === "(" || c === ")") {
      // Subshell / group delimiters: word boundaries, otherwise ignored.
      pushWord();
      i++;
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
      if (delim.length > 0) pendingHeredocs.push(delim);
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
    if (REDIRECT_RE.test(t)) {
      if (REDIRECT_STANDALONE_RE.test(t)) i++; // skip the target too
      continue;
    }
    out.push(t);
  }
  return out;
}

const WRAPPERS = new Set(["env", "command", "exec", "nohup", "time", "builtin", "sudo", "doas"]);
// Wrapper flags that take a value as the next token (`sudo -u deploy`,
// `env -u VAR`, `env -C dir`).
const WRAPPER_FLAGS_WITH_VALUE = new Set(["-u", "-g", "-h", "-p", "-C", "-D", "-r", "-t", "-T", "-U", "-S"]);

/**
 * Skip leading `NAME=value` assignments and transparent wrappers so the
 * real command name surfaces. `sudo -u user git push` still resolves to
 * `git`; the flags between wrapper and command are skipped.
 */
function commandStart(tokens: string[]): number {
  let i = 0;
  for (;;) {
    while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]!)) i++;
    if (i >= tokens.length) return i;
    if (WRAPPERS.has(baseName(tokens[i]!))) {
      i++;
      while (i < tokens.length && tokens[i]!.startsWith("-")) {
        i += WRAPPER_FLAGS_WITH_VALUE.has(tokens[i]!) ? 2 : 1;
      }
      continue;
    }
    return i;
  }
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

function classifyGit(
  args: string[],
  base: Omit<EgressIntent, "verb" | "payloadFiles">,
): EgressIntent | null {
  let i = 0;
  let cwdOverride: string | undefined;
  // Global options precede the subcommand.
  while (i < args.length) {
    const a = args[i]!;
    if (!a.startsWith("-")) break;
    if (a === "-C") {
      cwdOverride = args[i + 1];
      i += 2;
      continue;
    }
    if (GIT_GLOBAL_WITH_VALUE.has(a)) {
      i += 2;
      continue;
    }
    if (a.startsWith("-C") && a.length > 2) {
      cwdOverride = a.slice(2);
    }
    i++; // `--no-pager`, `-p`, `--git-dir=…`, `-c k=v`-style inline forms, …
  }
  if (args[i] !== "push") return null;
  i++;

  const positionals: string[] = [];
  for (; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--") {
      positionals.push(...args.slice(i + 1));
      break;
    }
    if (a.startsWith("-")) {
      if (GIT_PUSH_WITH_VALUE.has(a)) i++;
      continue;
    }
    positionals.push(a);
  }

  const remote = positionals[0];
  const refspec = positionals[1];
  return {
    ...base,
    verb: "git-push",
    payloadFiles: [],
    ...(remote !== undefined && { remote }),
    ...(refspec !== undefined && { refspec }),
    ...(cwdOverride !== undefined && { cwdOverride }),
  };
}

// gh flags whose value is the next token (or attached with `=`). Only the
// ones that matter for destination and payload resolution are enumerated;
// everything else is treated as a boolean flag, which is harmless here
// because we only look for specific flags, never for positionals after the
// subcommand.
const GH_REPO_FLAGS = new Set(["-R", "--repo"]);
const GH_BODY_FILE_FLAGS = new Set(["--body-file", "--notes-file", "--input"]);

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

// `gh api` flags that take a value as the next token and are not otherwise
// handled below. Without this list the value of `-H 'Accept: …'` would be
// mistaken for the endpoint positional.
const GH_API_FLAGS_WITH_VALUE = new Set([
  "-H",
  "--header",
  "--hostname",
  "-q",
  "--jq",
  "-t",
  "--template",
  "-p",
  "--preview",
  "--cache",
]);

/**
 * The org and repo a `gh api` endpoint addresses, when the path says so:
 * `repos/<o>/<r>[/…]` → both; `orgs/<o>[/…]` → the org only (`repo: null`,
 * an org-level write such as `orgs/<o>/repos`). A full URL is reduced to
 * its path; a GitHub Enterprise `/api/v3/` prefix is dropped. Null for
 * anything else — `graphql`, `user/repos`, `gists`, `search/…` — and for
 * a path carrying `{owner}` / `{repo}` placeholders, which gh fills in
 * from the cwd's repository, so the cwd is then the correct fallback.
 * Pure; never throws.
 */
export function parseApiEndpoint(endpoint: string): { org: string; repo: string | null } | null {
  let path = endpoint;
  if (/^https?:\/\//i.test(path)) {
    try {
      path = new URL(path).pathname;
    } catch {
      return null;
    }
  }
  path = path.replace(/^\/+/, "").replace(/^api\/v3\//, "");
  if (path.includes("{")) return null;
  const parts = path.split("?")[0]!.split("/").filter(Boolean);
  if (parts[0] === "repos" && parts.length >= 3) {
    return { org: parts[1]!.toLowerCase(), repo: parts[2]!.replace(/\.git$/, "").toLowerCase() };
  }
  if (parts[0] === "orgs" && parts.length >= 2) {
    return { org: parts[1]!.toLowerCase(), repo: null };
  }
  return null;
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

function classifyGh(
  args: string[],
  base: Omit<EgressIntent, "verb" | "payloadFiles">,
): EgressIntent | null {
  // Locate the group and subcommand: the first two non-flag tokens. gh's
  // global flags before the group are all boolean (`--help`, `--version`),
  // so a leading `-` token can simply be skipped.
  const nonFlags: number[] = [];
  for (let i = 0; i < args.length && nonFlags.length < 2; i++) {
    if (!args[i]!.startsWith("-")) nonFlags.push(i);
  }
  const groupIdx = nonFlags[0];
  if (groupIdx === undefined) return null;
  const group = args[groupIdx]!;

  let verb: EgressVerb | null = null;
  const payloadFiles: string[] = [];
  let repoFlag: string | undefined;
  let method: string | undefined;
  let hasFields = false;
  let apiEndpoint: string | undefined;
  // `gh api graphql` document sources; only attached to the intent when the
  // endpoint turns out to be the GraphQL one (it may come after the flags).
  let gqlQuery: string | undefined;
  let gqlQueryFile: string | undefined;
  let gqlInputFile: string | undefined;

  const takeValue = (i: number): { value: string | undefined; next: number } => {
    const a = args[i]!;
    const eq = a.indexOf("=");
    if (eq !== -1 && a.startsWith("--")) return { value: a.slice(eq + 1), next: i + 1 };
    return { value: args[i + 1], next: i + 2 };
  };

  if (group === "api") {
    verb = "gh-api-mutating"; // provisional; confirmed below
  } else {
    const subIdx = nonFlags[1];
    if (subIdx === undefined) return null;
    const sub = args[subIdx]!;
    verb = GH_VERBS[group]?.[sub] ?? null;
    if (verb === null) return null;
  }

  for (let i = groupIdx + 1; i < args.length; ) {
    const a = args[i]!;
    const name = a.startsWith("--") && a.includes("=") ? a.slice(0, a.indexOf("=")) : a;

    if (GH_REPO_FLAGS.has(name)) {
      const { value, next } = takeValue(i);
      if (value !== undefined) repoFlag = value;
      i = next;
      continue;
    }
    if (GH_BODY_FILE_FLAGS.has(name)) {
      const { value, next } = takeValue(i);
      if (value !== undefined) {
        payloadFiles.push(value);
        if (group === "api" && name === "--input") gqlInputFile = value;
      }
      i = next;
      continue;
    }
    if (name === "-F" || name === "--field" || name === "-f" || name === "--raw-field") {
      if (group === "api") {
        // `-F key=@path` reads the value from a file; `-f` never does.
        hasFields = true;
        const { value, next } = takeValue(i);
        const typed = name === "-F" || name === "--field";
        if (typed && value !== undefined) {
          const at = value.indexOf("=@");
          if (at !== -1) payloadFiles.push(value.slice(at + 2));
        }
        if (value !== undefined && value.startsWith("query=")) {
          const v = value.slice("query=".length);
          if (typed && v.startsWith("@")) gqlQueryFile = v.slice(1);
          else gqlQuery = v;
        }
        i = next;
        continue;
      }
      if (name === "-F") {
        // `-F` is `--body-file` on pr/issue/release commands.
        const { value, next } = takeValue(i);
        if (value !== undefined) payloadFiles.push(value);
        i = next;
        continue;
      }
      i++;
      continue;
    }
    if (name === "--body" || name === "-b") {
      const { value, next } = takeValue(i);
      if (value !== undefined && value.startsWith("@") && value.length > 1) {
        payloadFiles.push(value.slice(1));
      }
      i = next;
      continue;
    }
    if (name === "-X" || name === "--method") {
      const { value, next } = takeValue(i);
      if (value !== undefined) method = value.toUpperCase();
      i = next;
      continue;
    }
    if (group === "api") {
      if (GH_API_FLAGS_WITH_VALUE.has(name)) {
        i = takeValue(i).next;
        continue;
      }
      // The first bare positional after `api` is the endpoint.
      if (!a.startsWith("-") && apiEndpoint === undefined) apiEndpoint = a;
    }
    i++;
  }

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

  return {
    ...base,
    verb,
    payloadFiles,
    ...(repoFlag !== undefined && { repoFlag }),
    ...(apiEndpoint !== undefined && { apiEndpoint }),
    ...(graphql !== undefined && { graphql }),
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
 * Tokenise (quote-aware), split on shell operators, classify each segment.
 * Pure; never throws. Non-egress commands yield an empty list.
 */
export function parseEgressIntents(command: string): EgressIntent[] {
  try {
    return parseUnsafe(command);
  } catch {
    return [];
  }
}

function parseUnsafe(command: string): EgressIntent[] {
  if (typeof command !== "string" || command.length === 0) return [];
  const segments = tokenise(command);
  const intents: EgressIntent[] = [];
  let precededByCd = false;

  segments.forEach((seg, segmentIndex) => {
    const tokens = stripRedirections(seg.tokens);
    const start = commandStart(tokens);
    if (start >= tokens.length) return;
    const cmd = baseName(tokens[start]!);
    const args = tokens.slice(start + 1);
    const base = { precededByCd, joinedBy: seg.joinedBy, segmentIndex };

    let intent: EgressIntent | null = null;
    if (cmd === "git") intent = classifyGit(args, base);
    else if (cmd === "gh") intent = classifyGh(args, base);
    else if (cmd === "npm" || cmd === "pnpm" || cmd === "yarn") intent = classifyNpm(cmd, args, base);

    if (intent !== null) intents.push(intent);

    // A `cd` anywhere earlier in the line taints every later segment: the
    // directory change may not have happened (failed `cd` under `;`), and
    // in an agent's tool call it never persists past the call anyway.
    if (cmd === "cd" || cmd === "pushd") precededByCd = true;
  });

  return intents;
}
