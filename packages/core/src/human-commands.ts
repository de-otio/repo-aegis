// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// Commands only a person may run (issue #151, PR 2b; plan §8.1 S10, §8.4 F5).
//
// `repo-aegis approve`, `engagements add --personal-org|--github-org`,
// `upstreams add` and `init --migrate-classify|--force` are how a person tells
// repo-aegis "this publish / this owner is fine". They are gated on a terminal,
// but a terminal is not proof of a person (a pty wrapper fakes it). So the agent
// hook also refuses any Bash command whose TEXT runs one of them, whatever the
// terminal situation: an agent never mints its own go-ahead, even with a real
// TTY. Refusal code: `AGENT_RAN_HUMAN_COMMAND`.
//
// This is a text-level check (the egress parser no longer reads text this way). It
// finds the repo-aegis program word (`repo-aegis`, a path to it, `npx
// @de-otio/repo-aegis`, `dist/index.js`, or a name this command line defines as
// an alias, function or variable holding one of those) and then looks at the
// words that follow it in the same unquoted command region. Because it reads
// words rather than modelling the shell, it sees through `bash -c '…'`, `eval`,
// `sudo`, `env`, `tmux new -d '…'`, `script -c '…'`, heredocs and interpreter
// text alike. Quotes and backslashes are removed first, so `"repo-""aegis"` and
// `app\rove` read as the plain words.
//
// What it cannot see: a program word built at run time (`$(printf
// 'repo-%s' aegis)`), an alias defined in the user's profile, a script written
// by an earlier call. Those fall to the terminal and ancestry gates behind it.
// The accepted false positive: a quoted MENTION of one of these commands next to
// a repo-aegis word (`echo "repo-aegis approve"`). It is refused, and the agent
// re-words it.
//
// Reading help is not running the command: a person-only verb whose ONLY arguments are `--help` / `-h`
// (or `repo-aegis help <verb>`) is allowed, so an agent can tell its person the exact flags (P1-F).
// Any other word next to it keeps the refusal. See {@link isHelpTokens}.
import { refusal } from "./refusal.js";

export const AGENT_RAN_HUMAN_COMMAND = "AGENT_RAN_HUMAN_COMMAND";

export type HumanOnlyKind =
  | "approve"
  | "owner-add"
  | "upstream-add"
  | "init-migrate"
  | "init-force"
  // Registry identities (doc/plan-owner-identity.md §5.1): `identity add|remove|require`, `engagements set-identity`.
  | "identity-change"
  // The managed drop-in (doc/plan-pin-enforcement-binary.md P7): removing it, or writing its directory as root.
  | "claude-md-uninstall"
  // The internal entry points `repo-aegis gh` and `repo-aegis git-credential` (doc/plan-owner-identity.md §13.3).
  | "internal-entry"
  | "managed-settings-write";

export interface HumanOnlyHit {
  kind: HumanOnlyKind;
}

/** Words split the way a shell and a script's string literals would split them. */
const WORD_SPLIT = /[\s'"`(){}<>;&|,=!\\[\]]+/;

/** Characters that end a command region when they are not quoted. */
const BARRIERS = new Set([";", "&", "|", "\n", "\r", "(", ")", "`"]);

/**
 * Flags of `git` / `gh` whose value is a message or posted field: text, not a
 * command. A mention of a repo-aegis command in a commit message or an issue
 * body is data, unless the value runs a command substitution.
 */
const MESSAGE_FLAGS = new Set([
  "-m", "--message", "-F", "--file", "-b", "--body", "-t", "--title", "-n", "--notes", "-d", "--description",
  "--comment", "--subject", "-f", "--field", "--raw-field",
]);

function messageFlagKind(tok: string): "next" | "attached" | null {
  if (MESSAGE_FLAGS.has(tok)) return "next";
  const eq = tok.indexOf("=");
  if (tok.startsWith("--") && eq > 0 && MESSAGE_FLAGS.has(tok.slice(0, eq))) return "attached";
  if (!tok.startsWith("--") && /^-[A-Za-z]*m$/.test(tok)) return "next"; // `-am TEXT`
  if (!tok.startsWith("--") && tok.length > 2 && MESSAGE_FLAGS.has(tok.slice(0, 2))) return "attached"; // `-mTEXT`
  return null;
}

/**
 * `$(cat <<'EOF' … EOF)`: the standard way to pass a multi-line message. The
 * delimiter is quoted, so the body is literal, and nothing else may run inside
 * the substitution: the first line equal to the delimiter must be followed by
 * just the closing parenthesis.
 */
function isQuotedHeredocMessage(tok: string): boolean {
  const m = /^\$\(\s*cat\s+<<-?\s*'(\w+)'[ \t]*\n/.exec(tok);
  if (m === null) return false;
  const lines = tok.slice(m[0].length).split("\n");
  const end = lines.findIndex(l => l.replace(/^\t+/, "") === m[1]);
  if (end === -1) return false;
  return lines.slice(end + 1).join("\n").trim() === ")";
}

function isDataToken(tok: string): boolean {
  if (isQuotedHeredocMessage(tok)) return true;
  return !tok.includes("$(") && !tok.includes("`");
}

function tokenBase(t: string): string {
  return t.slice(t.lastIndexOf("/") + 1).toLowerCase();
}

/** Search commands: the pattern and the paths are text to look for, never a command. */
const SEARCH_COMMANDS = new Set(["grep", "egrep", "fgrep", "rg", "ag", "ack"]);
/** Search flags whose value runs a command. */
const SEARCH_RUN_FLAGS = new Set(["--pager", "--pre"]);
/** Commands whose arguments are only text or paths to look at, never a program. */
const LOOKUP_COMMANDS = new Set(["man", "apropos"]);
/**
 * Commands that only LOOK UP a name or a process (`which setsid`, `type tmux`, `command -v screen`, `pkill setsid`,
 * `pgrep tmux`). Their arguments are exempt for the detached-session check only. The human-command check keeps
 * them, because `$(which repo-aegis) approve` runs the program `which` printed.
 */
const DETACH_LOOKUP_COMMANDS = new Set(["which", "whereis", "type", "pkill", "pgrep", "pidof"]);
/** `git` options whose value is a directory. */
const GIT_DIR_FLAGS = new Set(["-C", "--git-dir", "--work-tree", "--namespace"]);
/** `gh` options whose value is a repository. */
const GH_REPO_FLAGS = new Set(["-R", "--repo"]);

/**
 * The words of one region's tokens, leaving out what is data and not a program:
 *   - the message values of a `git` / `gh` command;
 *   - the value of `git -C <dir>` / `--git-dir` / `--work-tree` and of `gh -R` / `--repo`
 *     (a directory or repository that may be named `repo-aegis`);
 *   - everything after `cd` / `pushd` (a directory), and the pattern and paths of a search
 *     (`grep -rn "repo-aegis approve" doc/`).
 * A flag that RUNS something (`grep --pager`, `git -c`, `--exec`) is still read.
 */
function regionWords(tokens: readonly string[], forDetached = false): { words: string[]; wordTok: number[] } {
  const bases = tokens.map(tokenBase);
  const first = bases[0] ?? "";
  const isGit = bases.includes("git");
  const isGh = bases.includes("gh");
  const isGitOrGh = isGit || isGh;
  const words: string[] = [];
  /** For each word, the index in `tokens` of the token it was split out of (the help check reads whole tokens). */
  const wordTok: number[] = [];
  const add = (tok: string, k: number): void => {
    for (const w of tok.split(WORD_SPLIT)) {
      if (w !== "") {
        words.push(w);
        wordTok.push(k);
      }
    }
  };
  const lookup =
    forDetached &&
    (DETACH_LOOKUP_COMMANDS.has(first) || (first === "command" && (tokens[1] === "-v" || tokens[1] === "-V")));
  if (first === "cd" || first === "pushd" || first === "popd" || LOOKUP_COMMANDS.has(first) || lookup) {
    add(tokens[0]!, 0);
    return { words, wordTok };
  }
  const searching = SEARCH_COMMANDS.has(first);
  for (let k = 0; k < tokens.length; k++) {
    const tok = tokens[k]!;
    if (searching) {
      if (k === 0) {
        add(tok, k);
      } else if (tok.startsWith("-")) {
        add(tok, k);
        if (SEARCH_RUN_FLAGS.has(tok) && tokens[k + 1] !== undefined) {
          add(tokens[++k]!, k);
        }
      }
      continue;
    }
    if (isGit && (GIT_DIR_FLAGS.has(tok) || /^(?:-C.|--git-dir=|--work-tree=|--namespace=)/.test(tok))) {
      if (GIT_DIR_FLAGS.has(tok)) k++; // the value is the next token
      continue;
    }
    if (isGh && (GH_REPO_FLAGS.has(tok) || /^(?:-R.|--repo=)/.test(tok))) {
      if (GH_REPO_FLAGS.has(tok)) k++;
      continue;
    }
    if (isGitOrGh && tok.startsWith("-")) {
      const kind = messageFlagKind(tok);
      if (kind === "attached" && isDataToken(tok)) continue;
      if (kind === "next") {
        const value = tokens[k + 1];
        if (value !== undefined && isDataToken(value)) {
          k++;
          continue;
        }
      }
    }
    add(tok, k);
  }
  return { words, wordTok };
}

/**
 * Split a command line into regions of words. Quotes and backslashes are
 * removed (adjacent pieces join, as in a shell); an UNQUOTED `; & | ( ) `` and
 * newline ends a region. Text inside quotes never ends one, so an interpreter's
 * or `bash -c`'s program text is one region.
 */
export function commandRegions(text: string): string[][] {
  return splitRegions(text)
    .map(r => r.words)
    .filter(w => w.length > 0);
}

interface Region {
  words: string[];
  /** The region's quote-stripped shell tokens (what a command receives as arguments, plus redirections). */
  tokens: string[];
  /** For each word, the index in `tokens` of the token it came from. */
  wordTok: number[];
  /** The unquoted character that ended the region (`)` / a backtick close a substitution), or "" at the end. */
  endedBy: string;
}

function splitRegions(text: string, forDetached = false): Region[] {
  const regions: Region[] = [];
  let tokens: string[] = [];
  let buf = "";
  let quote: "'" | '"' | null = null;
  const endToken = (): void => {
    if (buf !== "") tokens.push(buf);
    buf = "";
  };
  const flush = (endedBy = ""): void => {
    endToken();
    const { words, wordTok } = regionWords(tokens, forDetached);
    // An empty region is kept: it separates `$(…)` from whatever follows the next `;`.
    if (words.length > 0 || endedBy !== "") regions.push({ words, tokens, wordTok, endedBy });
    tokens = [];
  };
  // True right after an unquoted `>` or `<`: an `&` there belongs to the redirection (`2>&1`, `>&2`), not to a `&` separator.
  let redirect = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    const afterRedirect = redirect;
    redirect = false;
    if (quote === "'") {
      if (c === "'") quote = null;
      else buf += c;
      continue;
    }
    if (c === "\\") {
      const next = text[i + 1];
      if (next === undefined) continue;
      // Inside double quotes a backslash only escapes a few characters.
      if (quote === '"' && !'"\\$`\n'.includes(next)) buf += c;
      i++;
      if (next !== "\n") buf += next;
      continue;
    }
    if (quote === '"') {
      if (c === '"') quote = null;
      else buf += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      continue;
    }
    if (c === "&" && afterRedirect) {
      buf += c;
      continue;
    }
    if (BARRIERS.has(c)) {
      flush(c);
      continue;
    }
    if (c === " " || c === "\t") {
      endToken();
      continue;
    }
    // `$'…'` ANSI-C quoting: the `$` is dropped when it opens a quote.
    if (c === "$" && text[i + 1] === "'") continue;
    if (c === ">" || c === "<") redirect = true;
    buf += c;
  }
  flush();
  return regions;
}

/** How many ordinary words after the program word a subcommand may sit; flags and their values are free. */
const WINDOW = 8;
const MAX_WORDS = 64;

/** True for a word that names the repo-aegis program, given the aliases this command line defines. */
function isProgramWord(w: string, names: ReadonlySet<string>): boolean {
  // The LAST path component is the program: `/opt/bin/repo-aegis`, `@de-otio/repo-aegis`,
  // `repo-aegis@0.11.0`, `repo-aegis.js`. A directory (`…/repo-aegis/docs/x.md`) is not.
  const last = w.slice(Math.max(w.lastIndexOf("/"), w.lastIndexOf(":")) + 1); // `EXEC:repo-aegis` (socat), `a/b/repo-aegis`
  if (/^repo-aegis(?:@[\w.-]+)?(?:\.[cm]?js)?$/i.test(last)) return true;
  if (/(?:^|\/)dist\/index\.js$/i.test(w)) return true;
  return names.has(w) || (w.startsWith("$") && names.has(w.slice(1)));
}

/** True when a definition's text holds a repo-aegis program word. */
function mentionsProgram(text: string): boolean {
  return text
    .split(WORD_SPLIT)
    .some(w => w !== "" && isProgramWord(w, new Set()));
}

/**
 * Names this command line binds to something that holds a repo-aegis word:
 * `alias ra='repo-aegis'`, `RA=repo-aegis`, `ra() { repo-aegis "$@"; }`,
 * `function ra { … }`. Used so `ra approve '*'` is read as `repo-aegis approve '*'`.
 */
function definedNames(text: string): Set<string> {
  const names = new Set<string>();
  for (const a of scanAssignments(text)) {
    if (mentionsProgram(a.value)) names.add(a.name);
  }
  for (const f of scanFunctions(text)) {
    if (mentionsProgram(f.body)) names.add(f.name);
  }
  return names;
}

const isSpace = (c: string): boolean => /\s/.test(c);
const isNameStart = (c: string): boolean => /[A-Za-z_]/.test(c);
const isNameChar = (c: string): boolean => /[\w.-]/.test(c);

/** End (exclusive) of the run of name characters (`[\w.-]`) that starts at `from`. */
function nameRunEnd(text: string, from: number): number {
  let j = from;
  while (j < text.length && isNameChar(text[j]!)) j++;
  return j;
}

/** End (exclusive) of the run of whitespace that starts at `from`. */
function spaceRunEnd(text: string, from: number): number {
  let j = from;
  while (j < text.length && isSpace(text[j]!)) j++;
  return j;
}

/**
 * Every `NAME=VALUE` binding in `text`, in order. A linear-time scan with the same matches as
 * `/(?:^|[\s;&|(])([A-Za-z_][\w.-]*)=((?:'[^']*'|"[^"]*"|[^\s;&|]*))/g`: a name starts at the
 * beginning of the text or right after one of `\s ; & | (`; the value is a closed `'…'` or `"…"`
 * if one opens there, else the run up to the next `\s ; & |`. (The old regex was flagged as
 * polynomial-time; the equivalence test keeps it as the oracle.)
 * @internal exported for the equivalence test.
 */
export function scanAssignments(text: string): Array<{ name: string; value: string }> {
  const out: Array<{ name: string; value: string }> = [];
  const n = text.length;
  // A closing quote that is not there stays not there: remember it so a failed search is not repeated.
  const closeAt: Record<string, number> = { "'": -2, '"': -2 };
  const closeOf = (q: string, from: number): number => {
    const c = closeAt[q]!;
    if (c === -1) return -1;
    if (c >= from) return c;
    return (closeAt[q] = text.indexOf(q, from));
  };
  /** `NAME=VALUE` with the name starting at `at`, or null. */
  const matchAt = (at: number): { name: string; value: string; end: number } | null => {
    if (at >= n || !isNameStart(text[at]!)) return null;
    const e = nameRunEnd(text, at);
    if (text[e] !== "=") return null;
    const vs = e + 1;
    let ve = -1;
    const q = text[vs];
    if (q === "'" || q === '"') {
      const close = closeOf(q, vs + 1);
      if (close !== -1) ve = close + 1;
    }
    if (ve === -1) {
      ve = vs;
      while (ve < n && !isSpace(text[ve]!) && !";&|".includes(text[ve]!)) ve++;
    }
    return { name: text.slice(at, e), value: text.slice(vs, ve), end: ve };
  };
  let s = 0;
  while (s < n) {
    // `^` is an alternative only at index 0; elsewhere the name follows a one-character separator.
    let m = s === 0 ? matchAt(0) : null;
    if (m === null && (isSpace(text[s]!) || ";&|(".includes(text[s]!))) m = matchAt(s + 1);
    if (m === null) {
      s++;
    } else {
      out.push({ name: m.name, value: m.value });
      s = m.end; // a global regex resumes at the match end
    }
  }
  return out;
}

/**
 * Every `function NAME {…}` / `NAME() {…}` definition in `text`, in order, with the body up to the
 * first `}`. A linear-time scan with the same matches as
 * `/(?:function\s+([A-Za-z_][\w.-]*)|([A-Za-z_][\w.-]*)\s*\(\s*\))\s*\{([^}]*)\}/g`.
 * @internal exported for the equivalence test.
 */
export function scanFunctions(text: string): Array<{ name: string; body: string }> {
  const out: Array<{ name: string; body: string }> = [];
  const n = text.length;
  let closeAt = -2;
  const nextClose = (from: number): number => {
    if (closeAt === -1) return -1;
    if (closeAt >= from) return closeAt;
    return (closeAt = text.indexOf("}", from));
  };
  /** `\s*\{([^}]*)\}` from `from`: the body and the match end, or null. */
  const tail = (from: number): { body: string; end: number } | null => {
    const b = spaceRunEnd(text, from);
    if (text[b] !== "{") return null;
    const c = nextClose(b + 1);
    return c === -1 ? null : { body: text.slice(b + 1, c), end: c + 1 };
  };
  let runEnd = 0; // alt 2 already failed for the name run that ends here
  let s = 0;
  while (s < n) {
    let hit: { name: string; body: string; end: number } | null = null;
    if (text.startsWith("function", s)) {
      const k = spaceRunEnd(text, s + 8);
      if (k > s + 8 && k < n && isNameStart(text[k]!)) {
        const e = nameRunEnd(text, k);
        const t = tail(e);
        if (t !== null) hit = { name: text.slice(k, e), ...t };
      }
    }
    if (hit === null && s >= runEnd && isNameStart(text[s]!)) {
      // Every start inside one name run reaches the same end, so one try per run is enough.
      const e = nameRunEnd(text, s);
      runEnd = e;
      let p = spaceRunEnd(text, e);
      if (text[p] === "(") {
        p = spaceRunEnd(text, p + 1);
        if (text[p] === ")") {
          const t = tail(p + 1);
          if (t !== null) hit = { name: text.slice(s, e), ...t };
        }
      }
    }
    if (hit !== null) {
      out.push({ name: hit.name, body: hit.body });
      s = hit.end;
    } else {
      s++;
    }
  }
  return out;
}

/** The words after `words[from]`: up to {@link MAX_WORDS}, with at most {@link WINDOW} ordinary (non-flag, non-flag-value) words. */
function followingWords(words: readonly string[], from: number): string[] {
  const out: string[] = [];
  let counted = 0;
  let afterFlag = false;
  for (let j = from + 1; j < words.length && j <= from + MAX_WORDS; j++) {
    const w = words[j]!;
    out.push(w);
    if (w.startsWith("-")) {
      afterFlag = true;
    } else if (afterFlag) {
      afterFlag = false;
    } else if (++counted >= WINDOW) {
      break;
    }
  }
  return out;
}

/**
 * `repo-aegis gh …` and `repo-aegis git-credential …` are internal entry points: the `gh` shim and git reach them,
 * and an agent calling them directly would choose the identity and token source itself. True when the first
 * subcommand word (after global flags and their values) is one of them.
 */
function isInternalEntry(win: readonly string[]): boolean {
  let prev = "";
  for (const w of win) {
    if (w.startsWith("-")) {
      prev = w;
      continue;
    }
    if (w === "gh" || w === "git-credential") return true;
    // a value of the flag before it (`--home /x gh`); anything else is the real subcommand, and it is not one of ours
    if (!(prev.startsWith("-") && !prev.includes("="))) return false;
    prev = w;
  }
  return false;
}

function classify(win: readonly string[]): HumanOnlyKind | null {
  if (isInternalEntry(win)) return "internal-entry";
  // `approve --revoke <id|all>` only removes approvals: it tightens, so an agent may run it (and revoke
  // never mints). `--list` stays refused: its output names org scopes, which can be customer names.
  const revokeOnly = win.includes("--revoke") && !win.includes("--list");
  if (win.includes("approve") && !revokeOnly) return "approve";
  const at = (word: string): number => win.indexOf(word);
  const eng = at("engagements");
  if (eng !== -1 && win.indexOf("add", eng) !== -1 && (win.includes("--personal-org") || win.includes("--github-org"))) {
    return "owner-add";
  }
  // `set-identity` anywhere after the program word, and the `identity` command word alone: whatever
  // follows it (a subcommand fed by a pipe or a heredoc, a quoted argument vector) is read as human-only.
  // The exceptions: `identity require --on`, which only tightens, and `identity list`, which only reads (it
  // prints names, kinds and the owner mapping, the same facts `status` prints). `list` is excused only when no
  // mutating subcommand word sits in the same window, so `identity list add x` and a fed-in `identity add` stay refused.
  if (win.includes("set-identity")) return "identity-change";
  const idn = at("identity");
  if (idn !== -1) {
    const rest = win.slice(idn + 1);
    const sub = rest.find(w => !w.startsWith("-"));
    const requireOn = sub === "require" && win.includes("--on") && !win.includes("--off");
    const listOnly = sub === "list" && !rest.some(w => w === "add" || w === "remove" || w === "require");
    if (!requireOn && !listOnly) return "identity-change";
  }
  const up = at("upstreams");
  if (up !== -1 && win.indexOf("add", up) !== -1) return "upstream-add";
  if (win.includes("init")) {
    if (win.includes("--migrate-classify")) return "init-migrate";
    if (win.includes("--force")) return "init-force";
  }
  // `install claude-md --uninstall` removes the root-owned drop-in; the full `uninstall --yes` runs it.
  if (win.includes("install") && win.includes("claude-md") && win.includes("--uninstall")) return "claude-md-uninstall";
  if (win.includes("uninstall") && win.includes("--yes")) return "claude-md-uninstall";
  return null;
}

/**
 * The words a person-only verb is spelled with, per kind: the paths `repo-aegis <words…> --help` can name.
 * Typed `Record<HumanOnlyKind, …>` so a new kind cannot be added without saying how its help is asked for;
 * the help exemption and its table test both read it. A kind that is not a repo-aegis verb has no path.
 */
export const HUMAN_VERB_PATHS: Readonly<Record<HumanOnlyKind, ReadonlyArray<readonly string[]>>> = {
  approve: [["approve"]],
  "owner-add": [["engagements", "add"]],
  "upstream-add": [["upstreams", "add"]],
  "init-migrate": [["init"]],
  "init-force": [["init"]],
  "identity-change": [["identity"], ["identity", "add"], ["identity", "remove"], ["identity", "require"], ["engagements", "set-identity"]],
  "claude-md-uninstall": [["install", "claude-md"], ["uninstall"]],
  "internal-entry": [["gh"], ["git-credential"]],
  "managed-settings-write": [],
};

const HELP_FLAGS: ReadonlySet<string> = new Set(["--help", "-h"]);
const HELP_VERB_WORDS: ReadonlySet<string> = new Set(Object.values(HUMAN_VERB_PATHS).flat(2));
/** Verbs with subcommands, which have Commander's implicit `help` subcommand: `identity help add`. */
const HELP_GROUPS: ReadonlySet<string> = new Set(
  Object.values(HUMAN_VERB_PATHS).flatMap(paths => paths.filter(p => p.length > 1).map(p => p[0]!)),
);
/** Root options that take no value; they may sit next to `--help` (`repo-aegis --json approve --help`). */
const GLOBAL_BOOLEAN_FLAGS: ReadonlySet<string> = new Set(["--json", "--no-color"]);
/** A redirection operator alone; its target is the next token: `>`, `2>>`, `<`, `>&`, `&>`. */
const REDIRECT_OP = /^(?:[0-9]*(?:>>?|<|>&|<&)|&>>?)$/;
/** A whole redirection in one token: `>file`, `2>>file`, `<file`, `&>file`, `2>&1`, `>&-`. Never `<<`, `<<<` or `>>>`. */
const REDIRECT_ATTACHED = /^(?:[0-9]*[<>]&(?:[0-9]+-?|-)|(?:[0-9]*>>?|[0-9]*<|&>>?)[^<>&].*)$/;

/** The tokens that are arguments: redirections (and their targets, which are never help) dropped. */
function argumentTokens(tokens: readonly string[]): string[] {
  const out: string[] = [];
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k]!;
    if (REDIRECT_OP.test(t)) {
      k++; // the next token is the target, whatever it says
    } else if (!REDIRECT_ATTACHED.test(t)) {
      out.push(t);
    }
  }
  return out;
}

/**
 * True when the tokens after a repo-aegis program token only ask for help. Commander prints help and runs no
 * action only when `--help` / `-h` is a whole argument, so this reads quote-stripped shell TOKENS, never the
 * words {@link WORD_SPLIT} cuts out of them (`>--help`, `' --help'`, `gh,--help` and `a=--help` are not help).
 * Every token must be exactly a verb word, exactly `--help` / `-h`, a global boolean flag, or a whole
 * redirection (`2>&1`, `>file`, `</dev/null`; a redirection's target never counts), and at least one must be
 * `--help` / `-h`. Or the help command: `help <verb...>`, `<group> help <verb...>`. Anything else (a target such
 * as `x/y`, a flag such as `--ttl`, `--`, a second program word) keeps the refusal.
 */
function isHelpTokens(tokens: readonly string[]): boolean {
  const t = argumentTokens(tokens).filter(w => !GLOBAL_BOOLEAN_FLAGS.has(w));
  const h = t.indexOf("help");
  if (h !== -1) {
    const before = t.slice(0, h);
    const groupOrRoot = before.length === 0 || (before.length === 1 && HELP_GROUPS.has(before[0]!));
    return groupOrRoot && t.slice(h + 1).every(w => HELP_VERB_WORDS.has(w));
  }
  return t.some(w => HELP_FLAGS.has(w)) && t.every(w => HELP_FLAGS.has(w) || HELP_VERB_WORDS.has(w));
}

const MAX_NESTING = 3;

/** Does the program word `region.words[wi]` only ask for help? See {@link isHelpTokens}. */
function isHelpRead(region: Region, wi: number, names: ReadonlySet<string>, depth: number, memo: Map<string, boolean>): boolean {
  const t = region.wordTok[wi]!;
  const tok = region.tokens[t]!;
  const rest = region.tokens.slice(t + 1);
  if (isProgramWord(tok, names)) return isHelpTokens(rest);
  // The program word sits inside a longer token (a quoted `bash -c` argument). Read that text as a command
  // line of its own, with the aliases known so far; nothing but redirections may follow it.
  if (depth < MAX_NESTING && /[\s;&|()`]/.test(tok) && argumentTokens(rest).length === 0) {
    let ok = memo.get(tok);
    if (ok === undefined) {
      ok = scanCommand(tok, names, depth + 1, memo) === null;
      memo.set(tok, ok);
    }
    return ok;
  }
  return false;
}

/**
 * Spell a path the way the file system reads it: `/./` and a trailing `/.` are dropped, `//` is one `/`, and
 * `/x/../` cancels. Only for matching words against the managed-settings location, never to run anything.
 */
function normalizePath(w: string): string {
  let out = w.replace(/\/{2,}/g, "/");
  for (let prev = ""; prev !== out; ) {
    prev = out;
    out = out.replace(/\/\.(?=\/|$)/g, "").replace(/\/(?!\.\.\/)[^/]+\/\.\.(?=\/|$)/g, "");
  }
  return out;
}

/** Words that name the Claude Code managed-settings location: `managed-settings*`, `/etc/claude-code`, `.../Application Support/ClaudeCode`. */
function isManagedSettingsWord(w: string): boolean {
  const l = normalizePath(w).toLowerCase();
  return l.includes("managed-settings") || l.includes("/etc/claude-code") || l.includes("support/claudecode");
}

/**
 * Part of the managed-settings location that a glob can leave standing: `claude`, `etc/cl`, `support/c`,
 * `managed`. A word with one of these next to a glob, under `sudo`, is read as naming the location.
 */
const LOCATION_FRAGMENT = /claude|etc\/cl|support\/c|managed/;
const GLOB = /[*?[]/;

/** Privilege wrappers. */
const PRIVILEGE_WORDS = new Set(["sudo", "doas"]);

/**
 * `sudo` (any verb) on a command line that names the managed-settings location, in any region
 * (so a `cd` before it, a pipe into `tee`, `bash -c`, `script` and `expect` all count). No verb list
 * decides: the directory is `0755` and the drop-in `0644`, so reading them never needs `sudo`, and
 * every verb a list leaves out would be a way past it. The words are the same message-stripped,
 * quote-stripped words the program-word search reads, so a commit message that mentions the path is data.
 *
 * Paths are read after `/./`, `//` and `/x/../` are folded away. A `sudo` region that holds a glob and
 * a fragment of the location (`/etc/cl*`, `Claude*`) counts too. Prompt-adjacent: a script that builds
 * the path at run time is not seen here. The control is the `sudo` password prompt (P7), not this text.
 */
function writesManagedSettings(command: string): boolean {
  const regions = splitRegions(command).map(r => r.words);
  // A `cd` region keeps only its program word (its argument is a directory, not a command), so a `cd` into the
  // directory followed by `sudo rm <relative name>` needs its own look.
  const cdsInto = /(?:^|[;&|(\n])\s*(?:cd|pushd)\s+[^;&|\n)]*(?:managed-settings|\/etc\/claude-code|support\/claudecode)/i.test(normalizePath(command));
  const privileged = regions.filter(words => words.some(w => PRIVILEGE_WORDS.has(tokenBase(w))));
  if (privileged.length === 0) return false;
  if (privileged.some(words => words.some(w => GLOB.test(w)) && words.some(w => LOCATION_FRAGMENT.test(normalizePath(w).toLowerCase())))) return true;
  return cdsInto || regions.flat().some(isManagedSettingsWord);
}

/**
 * The first human-only repo-aegis command this command line runs, or null.
 * Pure and cheap: a line with no repo-aegis word returns at once.
 */
export function findHumanOnlyCommand(command: string): HumanOnlyHit | null {
  if (typeof command !== "string" || command === "") return null;
  try {
    if (writesManagedSettings(command)) return { kind: "managed-settings-write" };
  } catch {
    /* fall through to the program-word search */
  }
  const lower = command.toLowerCase();
  if (!lower.includes("aegis") && !/dist\/index\.js/.test(lower)) return null;
  try {
    return scanCommand(command, new Set(), 0, new Map());
  } catch {
    return null;
  }
}

/**
 * The program-word search over one command line. `inherited` holds the alias names an enclosing line defined, so
 * an alias defined outside a quoted `bash -c` argument is still known inside it.
 */
function scanCommand(command: string, inherited: ReadonlySet<string>, depth: number, memo: Map<string, boolean>): HumanOnlyHit | null {
  const names = new Set([...definedNames(command), ...inherited]);
  let carry = false;
  for (const region of splitRegions(command)) {
    const { words, endedBy } = region;
    // A substitution whose result is the program word: the region after its closing `)` / backtick
    // is read as following one.
    if (carry) {
      const kind = classify(followingWords(["", ...words], 0));
      if (kind !== null && !isHelpTokens(region.tokens)) return { kind };
    }
    let hasProgram = false;
    for (let i = 0; i < words.length; i++) {
      if (!isProgramWord(words[i]!, names)) continue;
      hasProgram = true;
      const kind = classify(followingWords(words, i));
      if (kind !== null && !isHelpRead(region, i, names, depth, memo)) return { kind };
    }
    carry = hasProgram && (endedBy === ")" || endedBy === "`");
  }
  return null;
}

const DESCRIPTION: Readonly<Record<HumanOnlyKind, { what: string; fix: string; why?: string }>> = {
  approve: {
    what: "repo-aegis approve",
    fix: "repo-aegis approve <owner>/<repo>   (or <owner>/*)",
  },
  "owner-add": {
    what: "repo-aegis engagements add --personal-org/--github-org",
    fix: "repo-aegis engagements add --personal-org <owner>   (or <id> --github-org <owner> for a customer)",
  },
  "upstream-add": {
    what: "repo-aegis upstreams add",
    fix: "repo-aegis upstreams add <owner>/<repo>",
  },
  "identity-change": {
    what: "repo-aegis identity (add, remove, require --off), or repo-aegis engagements set-identity",
    fix: "repo-aegis identity add <name> --gh-login <login>   (or --app <slug>); repo-aegis engagements set-identity <id> --person <name>",
    why:
      "These commands decide which GitHub account acts for an owner, so an agent that ran them could choose the identity it " +
      "acts as, with or without a terminal attached",
  },
  "init-migrate": {
    what: "repo-aegis init --migrate-classify",
    fix: "repo-aegis init --migrate-classify",
  },
  "init-force": {
    what: "repo-aegis init --force",
    fix: "repo-aegis init --force",
  },
  "claude-md-uninstall": {
    what: "repo-aegis install claude-md --uninstall (or repo-aegis uninstall --yes)",
    fix: "repo-aegis install claude-md --uninstall",
    why:
      "This command removes the root-owned managed-settings drop-in that keeps repo-aegis's hooks out of an agent's reach, so an " +
      "agent that ran it would be taking the protection off itself, with or without a terminal attached",
  },
  "internal-entry": {
    what: "repo-aegis gh or repo-aegis git-credential",
    fix: "gh <the same arguments> (the gh shim reaches repo-aegis itself); git push and fetch reach the credential helper themselves",
    why:
      "These are internal entry points that the gh shim and git call, and an agent that called them directly would choose the " +
      "identity and token source itself instead of going through the checked path",
  },
  "managed-settings-write": {
    what: "sudo on a command line that names the Claude Code managed-settings directory (reading it needs no sudo)",
    fix: "repo-aegis install claude-md   (or --uninstall; doc/configuration.md has the sudo line that removes the file)",
    why:
      "That directory holds the root-owned drop-in that keeps repo-aegis's hooks out of an agent's reach, so an agent that wrote " +
      "it with sudo would be rewriting or removing its own guard, with or without a terminal attached",
  },
};

/**
 * The five-part refusal (§3.9). Fixed text per kind: nothing from the agent's
 * command line is interpolated, so the message cannot carry an owner, an
 * approval target or a payload.
 */
export function humanCommandRefusal(hit: HumanOnlyHit): string {
  const d = DESCRIPTION[hit.kind];
  return refusal({
    code: AGENT_RAN_HUMAN_COMMAND,
    what: d.what,
    why:
      d.why ??
      "This command is how a person vouches for a publish or an owner, so it counts only when a person decides to " +
        "run it; an agent that ran it would be vouching for itself, with or without a terminal attached",
    approval: "No approval covers this, and a terminal, wrapper or alias does not change who runs it",
    fixes: [{ by: "person", step: `runs it in their own terminal: ${d.fix}` }],
  });
}

// ---------------------------------------------------------------------------
// Detached session starts (issue #151, PR 2b; the reviewer's H2b)
// ---------------------------------------------------------------------------
//
// A process that double-forks, calls `setsid`, or lives in a `tmux`/`screen`
// server started with `-d` outlives the agent's command and is re-parented to
// init. Its process chain then shows NO agent ancestor, and a pty it opens looks
// like a person's terminal to every gate that tests the chain. Refusing the
// START, in any agent command (egress or not), is the other half of the
// positive-root check in process-ancestry.ts. A plain `nohup cmd &` stays
// allowed: dev servers use it. Only `nohup … & disown` (which also drops the job
// from the shell) counts.

export const AGENT_DETACHED_SESSION = "AGENT_DETACHED_SESSION";

export type DetachedKind =
  | "tmux-detached"
  | "tmux-spawn"
  | "screen-detached"
  | "screen-inject"
  | "setsid"
  | "daemonize"
  | "nohup-disown";

export interface DetachedHit {
  kind: DetachedKind;
}

/** tmux subcommands (and their aliases) that start a process in a pane or type into one. */
const TMUX_SPAWN_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "new-window", "neww", "split-window", "splitw", "send-keys", "send", "respawn-pane", "respawnp",
  "respawn-window", "respawnw",
]);

/** The last path component, lower-cased. (Searches and `man`/`which` arguments are already dropped by {@link regionWords}.) */
const detachBase = (w: string): string => w.slice(w.lastIndexOf("/") + 1).toLowerCase();

/** The detached-start kind a region's words contain, or null. `all` is every region's words (for `nohup` + `disown`). */
function detachedKindOf(words: readonly string[]): DetachedKind | null {
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    const b = detachBase(w);
    if (b === "setsid" || b.endsWith(".setsid") || b.endsWith("::setsid")) return "setsid";
    if (b === "daemonize" || b.endsWith(".daemonize")) return "daemonize";
    if (b === "tmux") {
      const win = followingWords(words, i);
      const sub = win.find(x => x === "new" || x === "new-session");
      if (sub !== undefined && win.some(x => /^-[A-Za-z]*d[A-Za-z]*$/.test(x))) return "tmux-detached";
      // Any command that starts a process in, or types into, a pane of a tmux server (whatever the target):
      // the pane's pty belongs to the server, not to this command.
      if (win.some(x => TMUX_SPAWN_SUBCOMMANDS.has(x))) return "tmux-spawn";
    }
    if (b === "screen") {
      const letters = followingWords(words, i)
        .filter(x => /^-[A-Za-z]+$/.test(x))
        .join("");
      if (letters.includes("d") && letters.includes("m")) return "screen-detached";
      // `screen -S x -X stuff 'cmd'` / `-X screen cmd`: run something in, or type into, a session.
      const win = followingWords(words, i);
      const x = win.indexOf("-X");
      if (x !== -1 && (win[x + 1] === "stuff" || win[x + 1] === "screen")) return "screen-inject";
    }
  }
  return null;
}

/**
 * The first detached-session start in this command line, or null: `tmux new -d`,
 * `tmux new-session -d`, `tmux new-window` / `split-window` / `send-keys` /
 * `respawn-pane` / `respawn-window`, `screen -dm` / `-d -m`, `screen -X stuff` /
 * `-X screen`, `setsid` (also `os.setsid()` in interpreter text), `daemonize`, and
 * `nohup` combined with `disown`.
 */
export function findDetachedStart(command: string): DetachedHit | null {
  if (typeof command !== "string" || command === "") return null;
  const lower = command.toLowerCase();
  if (!/tmux|screen|setsid|daemonize|disown/.test(lower)) return null;
  try {
    let nohup = false;
    let disown = false;
    for (const { words } of splitRegions(command, true)) {
      const kind = detachedKindOf(words);
      if (kind !== null) return { kind };
      for (const w of words) {
        const b = detachBase(w);
        if (b === "nohup") nohup = true;
        if (b === "disown") disown = true;
      }
    }
    if (nohup && disown) return { kind: "nohup-disown" };
  } catch {
    return null;
  }
  return null;
}

const DETACHED_WHAT: Readonly<Record<DetachedKind, string>> = {
  "tmux-detached": "tmux new -d (a detached tmux session)",
  "tmux-spawn": "tmux new-window / split-window / send-keys / respawn (a command run in a tmux server's pane)",
  "screen-detached": "screen -dm (a detached screen session)",
  "screen-inject": "screen -X stuff / -X screen (a command run in a screen session)",
  setsid: "setsid (a new session, detached from this command)",
  daemonize: "daemonize (a detached background process)",
  "nohup-disown": "nohup … & disown (a background job dropped from the shell)",
};

/** The five-part refusal (§3.9). Fixed text per kind. */
export function detachedStartRefusal(hit: DetachedHit): string {
  return refusal({
    code: AGENT_DETACHED_SESSION,
    what: DETACHED_WHAT[hit.kind],
    why:
      hit.kind === "tmux-spawn" || hit.kind === "screen-inject"
        ? "A command run in a tmux or screen server's pane belongs to that server, which is re-parented to the system's " +
          "init process, and its terminal would look like a person's to repo-aegis, which is how an agent could approve " +
          "its own publishes"
        : "A detached session outlives this command and is re-parented to the system's init process, and a terminal it " +
          "opens would look like a person's to repo-aegis, which is how an agent could approve its own publishes",
    approval: "No approval covers this",
    fixes: [
      {
        by: "agent",
        command: "run the command in the foreground, or as a plain `nohup <command> &` for a dev server (without disown, setsid, a detached tmux/screen, or tmux/screen commands that run something in a pane)",
      },
      { by: "person", when: "If a long-lived terminal session is really needed", step: "starts it in their own terminal" },
    ],
  });
}
