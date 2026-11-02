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
  /**
   * A `gh` shell alias (`gh alias set --shell …`). Its body is an arbitrary
   * script, so what it publishes cannot be read offline; always carries
   * `unresolved: "gh-alias"`.
   */
  | "gh-alias-shell"
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
 *   intent names more than one distinct repository.
 */
export type IntentUnresolved = "env-override" | "gh-alias" | "opaque-repo" | "unknown-shape" | "ambiguous-target";

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

/** A `NAME=value` assignment in the prefix of a command. */
interface Assignment {
  name: string;
  value: string;
}

/**
 * Skip leading `NAME=value` assignments and transparent wrappers so the
 * real command name surfaces. `sudo -u user git push` still resolves to
 * `git`; the flags between wrapper and command are skipped. Every
 * assignment passed over (before the wrapper, or after `env`) is appended to
 * `assigns`, in order, so the caller can see `GH_REPO=o/r gh …`.
 */
function commandStart(tokens: string[], assigns: Assignment[] = []): number {
  let i = 0;
  for (;;) {
    for (;;) {
      const m = i < tokens.length ? /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/.exec(tokens[i]!) : null;
      if (m === null) break;
      assigns.push({ name: m[1]!, value: m[2]! });
      i++;
    }
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
 * Classify a `gh api` endpoint. The query string is split off FIRST, and only
 * the owner and repo segments of `repos/<o>/<r>/…` (or the owner of
 * `orgs/<o>/…`) decide the result: a placeholder later in the path or in the
 * query (`repos/o/r/git/refs/heads/{branch}`, `…/issues?ref={branch}`) is
 * filled in by gh but still addressed to the literal `o/r`, so it must not
 * send the guard back to the cwd. Pure; never throws.
 */
export function analyseApiEndpoint(endpoint: string): ApiEndpointTarget {
  let path = endpoint;
  if (/^https?:\/\//i.test(path)) {
    try {
      // `new URL` percent-encodes braces in a path; undo that for the two placeholder characters.
      path = new URL(path).pathname.replace(/%7B/gi, "{").replace(/%7D/gi, "}");
    } catch {
      return { kind: "none" };
    }
  }
  path = path.replace(/^\/+/, "").replace(/^api\/v3\//, "");
  const parts = path.split(/[?#]/)[0]!.split("/").filter(Boolean);
  // `repos/<o>/<r>` needs both segments; `orgs/<o>` needs the first.
  let segments: string[] | null = null;
  if (parts[0] === "repos" && parts.length >= 3) segments = [parts[1]!, parts[2]!];
  else if (parts[0] === "orgs" && parts.length >= 2) segments = [parts[1]!];
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

// Long flags whose value is the next token (or attached with `=`). A long flag
// missing from here is treated as boolean, which is the safe direction: its
// value then surfaces as a spare positional, which can only add a candidate
// repository, never hide one.
const GH_LONG_VALUE_FLAGS = new Set([
  "--add-assignee",
  "--add-label",
  "--add-project",
  "--add-reviewer",
  "--add-topic",
  "--app",
  "--assignee",
  "--author",
  "--author-email",
  "--base",
  "--body",
  "--body-file",
  "--branch",
  "--branch-repo",
  "--cache",
  "--color",
  "--comment",
  "--default-branch",
  "--description",
  "--discussion-category",
  "--env",
  "--env-file",
  "--field",
  "--fork-name",
  "--gitignore",
  "--head",
  "--header",
  "--homepage",
  "--hostname",
  "--input",
  "--job",
  "--jq",
  "--json",
  "--label",
  "--license",
  "--limit",
  "--match-head-commit",
  "--method",
  "--milestone",
  "--name",
  "--new-name",
  "--notes",
  "--notes-file",
  "--notes-start-tag",
  "--org",
  "--preview",
  "--project",
  "--raw-field",
  "--reason",
  "--ref",
  "--remote",
  "--remove-assignee",
  "--remove-label",
  "--remove-project",
  "--remove-reviewer",
  "--remove-topic",
  "--repo",
  "--repos",
  "--reviewer",
  "--search",
  "--source",
  "--state",
  "--subject",
  "--tag",
  "--target",
  "--team",
  "--template",
  "--title",
  "--visibility",
]);

// Short flags that take a value in EVERY gh write command this parser looks at.
const GH_SHORT_VALUE_BASE = "RXFbHqtBlnTA";

// Short flags that take a value only for some verbs, keyed by `group` or
// `group sub`; a key is added to the base set, never subtracted from it. A
// letter wrongly treated as a value flag would swallow the next token, which
// might be the very positional that names the repository, so a letter is
// listed here only when gh is known to treat it as a value in that verb
// (`gh pr create -f` is `--fill`, `gh pr review -a` is `--approve`, `gh label
// create -f` is `--force`, `gh pr merge -d|-m|-r|-s` are booleans).
const GH_SHORT_VALUE_EXTRA = new Map<string, string>([
  ["api", "fp"],
  ["pr create", "amrp"],
  ["pr edit", "amrp"],
  ["pr close", "c"],
  ["pr reopen", "c"],
  ["issue create", "amp"],
  ["issue edit", "amp"],
  ["issue close", "cr"],
  ["issue reopen", "c"],
  ["repo create", "dghsr"],
  ["repo edit", "dgh"],
  ["repo sync", "s"],
  ["gist create", "adf"],
  ["gist edit", "adf"],
  ["secret set", "aeorvf"],
  ["secret delete", "eor"],
  ["variable set", "aeorvf"],
  ["variable delete", "eor"],
  ["workflow run", "rf"],
  ["run rerun", "j"],
  ["label create", "cd"],
  ["label edit", "cd"],
]);

function shortValueLetters(group: string, sub: string | undefined): ReadonlySet<string> {
  const letters = new Set(GH_SHORT_VALUE_BASE);
  const extra = GH_SHORT_VALUE_EXTRA.get(group === "api" ? "api" : `${group} ${sub ?? ""}`);
  if (extra !== undefined) for (const c of extra) letters.add(c);
  return letters;
}

/**
 * Where cobra would find the command: the group (`pr`) and subcommand
 * (`create`). cobra's `stripFlags` treats every `--flag` without `=` that it
 * does not know as BOOLEAN-FREE — it swallows the next token as the flag's
 * value — and so does a two-character `-X`. That is why `gh issue --repo
 * stranger/r create` and `gh --repo stranger/r issue create` both run `issue
 * create` against `stranger/r`, and why "the first two non-flag tokens" (the
 * previous heuristic) found no verb at all for them. Null when no command
 * word is found. `api` is a leaf: it has no subcommand.
 */
function findGhCommand(args: string[]): { groupIdx: number; subIdx?: number } | null {
  let groupIdx = -1;
  let i = 0;
  while (i < args.length) {
    const s = args[i]!;
    if (s === "--") return null;
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
 * allowed anywhere among the positionals. `skip` holds the indexes of the
 * command words. A repeated flag yields one event per occurrence; callers
 * take the last, as pflag does for a string flag.
 */
function scanGhArgs(
  args: string[],
  skip: ReadonlySet<number>,
  shortValue: ReadonlySet<string>,
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
      } else if (GH_LONG_VALUE_FLAGS.has(a)) {
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
      if (!shortValue.has(ch)) {
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
  ["label clone", { repoPositional: 0, keepsBase: true }],
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
    for (const p of positionals) if (/^https?:\/\//i.test(p)) addRepo(p);
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

/** gh's `shlex.Split`: whitespace separates, quotes group, `\` escapes. Never throws. */
function shlexSplit(text: string): string[] {
  const out: string[] = [];
  let word = "";
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === "'") {
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

/**
 * gh expands an alias only when the FIRST argument names one (and is not a
 * built-in command): `gh ic --repo stranger/r` with `ic = issue create` runs
 * `gh issue create --repo stranger/r`. A `!` expansion is a shell script.
 * The expansion mirrors gh's own: `$1`… are replaced textually, and when the
 * expansion has no `$` the remaining arguments are appended. Returns the
 * argument vector to classify, `"shell"` for a shell alias, or null when gh
 * itself would refuse to run (a `$N` left over).
 */
function expandGhAlias(args: string[], ctx: GhContext): string[] | "shell" | null {
  const first = args[0];
  if (first === undefined || first.startsWith("-") || GH_BUILTIN_COMMANDS.has(first)) return args;
  const aliases = ctx.aliases?.();
  const expansion = aliases?.get(first);
  if (expansion === undefined) return args;
  if (expansion.startsWith("!")) return "shell";
  let text = expansion;
  const extra: string[] = [];
  args.slice(1).forEach((a, i) => {
    if (!expansion.includes("$")) extra.push(a);
    else text = text.split(`$${i + 1}`).join(a);
  });
  if (/\$\d/.test(text)) return null;
  return [...shlexSplit(text), ...extra];
}

// ---------------------------------------------------------------------------
// classifyGh
// ---------------------------------------------------------------------------

/** What the caller knows about the environment `gh` will run in. */
interface GhContext {
  /** `GH_REPO` for this command: a prefix assignment, else the caller's environment. Raw. */
  envRepo: string | undefined;
  /** True when an earlier segment exports or assigns `GH_REPO`. */
  envOverridden: boolean;
  /** Lazily loaded `gh` aliases; absent when the caller supplied none. */
  aliases: (() => ReadonlyMap<string, string>) | undefined;
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

function classifyGh(
  rawArgs: string[],
  base: Omit<EgressIntent, "verb" | "payloadFiles">,
  ctx: GhContext,
): EgressIntent | null {
  const expanded = expandGhAlias(rawArgs, ctx);
  if (expanded === null) return null;
  if (expanded === "shell") {
    return { ...base, verb: "gh-alias-shell", payloadFiles: [], unresolved: "gh-alias" };
  }
  const args = expanded;

  const found = findGhCommand(args);
  if (found === null) return null;
  const { groupIdx, subIdx } = found;
  const group = args[groupIdx]!;
  const sub = subIdx === undefined ? undefined : args[subIdx];

  let verb: EgressVerb;
  let unresolved: IntentUnresolved | undefined;
  if (group === "api") {
    verb = "gh-api-mutating"; // provisional; confirmed below
  } else {
    const verbs = ownEntry(GH_VERBS, group);
    if (verbs === undefined || sub === undefined) return null;
    const known = ownEntry(verbs, sub);
    if (known !== undefined) {
      verb = known;
    } else if (GH_READ_SUBS[group]?.has(sub)) {
      return null;
    } else {
      verb = GH_UNKNOWN_SUB_VERB[group] ?? "gh-repo-edit";
      unresolved = "unknown-shape";
    }
  }

  const skip = new Set<number>([groupIdx]);
  if (subIdx !== undefined) skip.add(subIdx);
  const { events, positionals } = scanGhArgs(args, skip, shortValueLetters(group, sub));

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

  // --- the repository this command names ---------------------------------------
  const targets = collectRepoTargets(group, sub, events, positionals);
  let opaque = targets.opaque;
  if (repoFlag !== undefined && parseRepoRef(repoFlag) === null) opaque = true;

  // `GH_REPO` applies only when nothing more specific names the repository:
  // `--repo` beats it, a URL / `o/r` positional replaces the base repo, and
  // `gh api` consults it only to fill `{owner}`/`{repo}` placeholders in the
  // endpoint (a spelled-out `repos/<o>/<r>/…`, `graphql` and the like never do).
  const apiTarget = group === "api" && apiEndpoint !== undefined ? analyseApiEndpoint(apiEndpoint) : null;
  // A placeholder in the owner/repo segment that is not `{owner}`/`{repo}` cannot be named offline.
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
 * Tokenise (quote-aware), split on shell operators, classify each segment.
 * Pure; never throws. Non-egress commands yield an empty list.
 */
export function parseEgressIntents(command: string, opts: ParseEgressOptions = {}): EgressIntent[] {
  try {
    return parseUnsafe(command, opts);
  } catch {
    return [];
  }
}

/**
 * What the caller knows about the environment the command will run in. Both
 * fields are optional, and the parser stays pure: the caller reads the
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
   * loads them, called at most once and only when a `gh` command's first
   * argument is not a built-in — so the common path does no I/O.
   */
  ghAliases?: ReadonlyMap<string, string> | (() => ReadonlyMap<string, string>) | undefined;
}

// `export GH_REPO=…`-style builtins: they change the environment of every later segment.
const ENV_MUTATING_BUILTINS = new Set(["export", "declare", "typeset", "readonly", "local"]);

/** True when this segment changes `GH_REPO` for the segments after it. */
function setsGhRepoForLaterSegments(tokens: string[], start: number, assigns: Assignment[]): boolean {
  if (start >= tokens.length) return assigns.some(a => a.name === "GH_REPO"); // `GH_REPO=o/r` on its own
  if (!ENV_MUTATING_BUILTINS.has(tokens[start]!)) return false;
  return tokens.slice(start + 1).some(t => t === "GH_REPO" || t.startsWith("GH_REPO="));
}

function parseUnsafe(command: string, opts: ParseEgressOptions): EgressIntent[] {
  if (typeof command !== "string" || command.length === 0) return [];
  const segments = tokenise(command);
  const intents: EgressIntent[] = [];
  let precededByCd = false;
  let envOverridden = false;

  let aliasMap: ReadonlyMap<string, string> | undefined;
  const aliases = opts.ghAliases;
  const loadAliases =
    aliases === undefined
      ? undefined
      : (): ReadonlyMap<string, string> => {
          if (aliasMap === undefined) {
            try {
              aliasMap = typeof aliases === "function" ? aliases() : aliases;
            } catch {
              aliasMap = new Map();
            }
          }
          return aliasMap;
        };

  segments.forEach((seg, segmentIndex) => {
    const tokens = stripRedirections(seg.tokens);
    const assigns: Assignment[] = [];
    const start = commandStart(tokens, assigns);
    if (setsGhRepoForLaterSegments(tokens, start, assigns)) envOverridden = true;
    if (start >= tokens.length) return;
    const cmd = baseName(tokens[start]!);
    const args = tokens.slice(start + 1);
    const base = { precededByCd, joinedBy: seg.joinedBy, segmentIndex };

    let intent: EgressIntent | null = null;
    if (cmd === "git") intent = classifyGit(args, base);
    else if (cmd === "gh") {
      // The command's own prefix beats the inherited environment; an empty
      // value unsets it, as it does for gh.
      const prefixed = assigns.filter(a => a.name === "GH_REPO").pop();
      const raw = prefixed !== undefined ? prefixed.value : opts.envRepo;
      intent = classifyGh(args, base, {
        envRepo: raw === undefined || raw === "" ? undefined : raw,
        envOverridden,
        aliases: loadAliases,
      });
    } else if (cmd === "npm" || cmd === "pnpm" || cmd === "yarn") intent = classifyNpm(cmd, args, base);

    if (intent !== null) intents.push(intent);

    // A `cd` anywhere earlier in the line taints every later segment: the
    // directory change may not have happened (failed `cd` under `;`), and
    // in an agent's tool call it never persists past the call anyway.
    if (cmd === "cd" || cmd === "pushd") precededByCd = true;
  });

  return intents;
}
