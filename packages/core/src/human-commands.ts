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
// This is a text-level check, in the spirit of the egress parser's backstop. It
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
import { refusal } from "./refusal.js";

export const AGENT_RAN_HUMAN_COMMAND = "AGENT_RAN_HUMAN_COMMAND";

export type HumanOnlyKind = "approve" | "owner-add" | "upstream-add" | "init-migrate" | "init-force";

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
function regionWords(tokens: readonly string[]): string[] {
  const bases = tokens.map(tokenBase);
  const first = bases[0] ?? "";
  const isGit = bases.includes("git");
  const isGh = bases.includes("gh");
  const isGitOrGh = isGit || isGh;
  const words: string[] = [];
  if (first === "cd" || first === "pushd" || first === "popd" || LOOKUP_COMMANDS.has(first)) {
    return tokens.slice(0, 1).flatMap(t => t.split(WORD_SPLIT).filter(w => w !== ""));
  }
  const searching = SEARCH_COMMANDS.has(first);
  for (let k = 0; k < tokens.length; k++) {
    const tok = tokens[k]!;
    if (searching) {
      if (k === 0) {
        words.push(...tok.split(WORD_SPLIT).filter(w => w !== ""));
      } else if (tok.startsWith("-")) {
        words.push(...tok.split(WORD_SPLIT).filter(w => w !== ""));
        if (SEARCH_RUN_FLAGS.has(tok) && tokens[k + 1] !== undefined) {
          words.push(...tokens[++k]!.split(WORD_SPLIT).filter(w => w !== ""));
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
    for (const w of tok.split(WORD_SPLIT)) if (w !== "") words.push(w);
  }
  return words;
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
  /** The unquoted character that ended the region (`)` / a backtick close a substitution), or "" at the end. */
  endedBy: string;
}

function splitRegions(text: string): Region[] {
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
    const words = regionWords(tokens);
    // An empty region is kept: it separates `$(…)` from whatever follows the next `;`.
    if (words.length > 0 || endedBy !== "") regions.push({ words, endedBy });
    tokens = [];
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
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
  const assign = /(?:^|[\s;&|(])([A-Za-z_][\w.-]*)=((?:'[^']*'|"[^"]*"|[^\s;&|]*))/g;
  for (let m = assign.exec(text); m !== null; m = assign.exec(text)) {
    if (mentionsProgram(m[2]!)) names.add(m[1]!);
  }
  const fn = /(?:function\s+([A-Za-z_][\w.-]*)|([A-Za-z_][\w.-]*)\s*\(\s*\))\s*\{([^}]*)\}/g;
  for (let m = fn.exec(text); m !== null; m = fn.exec(text)) {
    if (mentionsProgram(m[3]!)) names.add((m[1] ?? m[2])!);
  }
  return names;
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

function classify(win: readonly string[]): HumanOnlyKind | null {
  // `approve --revoke <id|all>` only removes approvals: it tightens, so an agent may run it (and revoke
  // never mints). `--list` stays refused: its output names org scopes, which can be customer names.
  const revokeOnly = win.includes("--revoke") && !win.includes("--list");
  if (win.includes("approve") && !revokeOnly) return "approve";
  const at = (word: string): number => win.indexOf(word);
  const eng = at("engagements");
  if (eng !== -1 && win.indexOf("add", eng) !== -1 && (win.includes("--personal-org") || win.includes("--github-org"))) {
    return "owner-add";
  }
  const up = at("upstreams");
  if (up !== -1 && win.indexOf("add", up) !== -1) return "upstream-add";
  if (win.includes("init")) {
    if (win.includes("--migrate-classify")) return "init-migrate";
    if (win.includes("--force")) return "init-force";
  }
  return null;
}

/**
 * The first human-only repo-aegis command this command line runs, or null.
 * Pure and cheap: a line with no repo-aegis word returns at once.
 */
export function findHumanOnlyCommand(command: string): HumanOnlyHit | null {
  if (typeof command !== "string" || command === "") return null;
  const lower = command.toLowerCase();
  if (!lower.includes("aegis") && !/dist\/index\.js/.test(lower)) return null;
  try {
    const names = definedNames(command);
    let carry = false;
    for (const { words, endedBy } of splitRegions(command)) {
      // `$(which repo-aegis) approve '*'`: the substitution's result IS the program word, so the region
      // after its closing `)` / backtick is read as following one.
      if (carry) {
        const kind = classify(followingWords(["", ...words], 0));
        if (kind !== null) return { kind };
      }
      let hasProgram = false;
      for (let i = 0; i < words.length; i++) {
        if (!isProgramWord(words[i]!, names)) continue;
        hasProgram = true;
        const kind = classify(followingWords(words, i));
        if (kind !== null) return { kind };
      }
      carry = hasProgram && (endedBy === ")" || endedBy === "`");
    }
  } catch {
    return null;
  }
  return null;
}

const DESCRIPTION: Readonly<Record<HumanOnlyKind, { what: string; fix: string }>> = {
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
  "init-migrate": {
    what: "repo-aegis init --migrate-classify",
    fix: "repo-aegis init --migrate-classify",
  },
  "init-force": {
    what: "repo-aegis init --force",
    fix: "repo-aegis init --force",
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

export type DetachedKind = "tmux-detached" | "screen-detached" | "setsid" | "daemonize" | "nohup-disown";

export interface DetachedHit {
  kind: DetachedKind;
}

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
    }
    if (b === "screen") {
      const letters = followingWords(words, i)
        .filter(x => /^-[A-Za-z]+$/.test(x))
        .join("");
      if (letters.includes("d") && letters.includes("m")) return "screen-detached";
    }
  }
  return null;
}

/**
 * The first detached-session start in this command line, or null: `tmux new -d`,
 * `tmux new-session -d`, `screen -dm` / `-d -m`, `setsid` (also `os.setsid()` in
 * interpreter text), `daemonize`, and `nohup` combined with `disown`.
 */
export function findDetachedStart(command: string): DetachedHit | null {
  if (typeof command !== "string" || command === "") return null;
  const lower = command.toLowerCase();
  if (!/tmux|screen|setsid|daemonize|disown/.test(lower)) return null;
  try {
    let nohup = false;
    let disown = false;
    for (const { words } of splitRegions(command)) {
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
  "screen-detached": "screen -dm (a detached screen session)",
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
      "A detached session outlives this command and is re-parented to the system's init process, and a terminal it " +
      "opens would look like a person's to repo-aegis, which is how an agent could approve its own publishes",
    approval: "No approval covers this",
    fixes: [
      {
        by: "agent",
        command: "run the command in the foreground, or as a plain `nohup <command> &` for a dev server (without disown, setsid or a detached tmux/screen)",
      },
      { by: "person", when: "If a long-lived terminal session is really needed", step: "starts it in their own terminal" },
    ],
  });
}
