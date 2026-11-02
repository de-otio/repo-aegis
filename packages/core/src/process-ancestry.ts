// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// Who is behind this terminal? (issue #151, PR 2b; plan §8.1 S10)
//
// "stderr is a TTY" is a speed bump, not proof of a person: `script -q
// /dev/null <cmd>`, `unbuffer`, `expect`, `python -c 'import pty…'`, `socat …
// pty` and `ssh -tt localhost` give an agent's child a pty. This module walks
// the parent-process chain and says whether an AGENT HOST (Claude Code, Codex,
// Gemini CLI) or a PTY WRAPPER sits above this process. If one does, the
// terminal is not a person's.
//
// Offline and bounded: at most {@link MAX_ANCESTRY_DEPTH} hops; each hop reads
// `/proc` (Linux) or runs one `ps -o ppid=,comm=,args= -p <pid>` (macOS and the
// BSDs) with a short timeout. No network. Only process NAMES are classified,
// and only names ever leave this module (in a refusal or a note): argument
// vectors may hold credentials and are never printed or stored.
//
// RESIDUAL (stated, not solved): this is a heuristic about the process tree.
//   - An agent with code execution can type into the user's real terminal
//     (`osascript` / AppleScript `do script`, `tmux send-keys` to a pane the
//     person owns, writing to `/dev/ttys00N`), or start a process outside its
//     own tree (`launchctl submit`, `at`, `cron`, a login item) that then owns
//     a pty. Neither has an agent ancestor.
//   - `tmux new -d '…'` / `screen -dm` reparent under a server whose parent is
//     init, so the walk sees no agent host. Those are caught at the TEXT level
//     by the agent hook (`EGRESS_PTY_WRAPPER`, `AGENT_RAN_HUMAN_COMMAND`).
//   - `tmux` and `screen` are deliberately NOT ancestor blockers: a person
//     legitimately works inside them. An agent host above them is what counts,
//     and that is already refused.
//   The durable fix is a presence signal an agent cannot forge (a Keychain item
//   with a user-presence ACL / Touch ID); tracked separately.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename } from "node:path";

/** One process in the chain. Nothing here is ever printed except {@link AncestorInfo.name}-derived labels. */
export interface AncestorInfo {
  pid: number;
  ppid: number;
  /** The kernel's short name for the process (`comm`), possibly truncated to 16 characters. */
  comm: string;
  /** The first few argv words, used only for classification (never printed). */
  argv: readonly string[];
}

/** Reads the chain above this process, nearest parent first; `null` when it cannot be read completely. */
export type AncestryReader = () => readonly AncestorInfo[] | null;

export type AncestryVerdict =
  | { kind: "clear" }
  | { kind: "agent"; /** A fixed, content-free label such as `claude` or `script`. */ ancestor: string }
  | { kind: "undeterminable"; why: string };

/** How far up the walk goes before giving up (and reporting `undeterminable`). */
export const MAX_ANCESTRY_DEPTH = 32;

/** Per-hop `ps` timeout. A hung `ps` must not hang `approve` or a push. */
const PS_TIMEOUT_MS = 2000;

// ---------------------------------------------------------------------------
// Classification (pure)
// ---------------------------------------------------------------------------

/** Agent hosts, matched on the process name or argv[0]. */
const AGENT_HOST_NAMES = new Set(["claude", "claude-code", "codex", "gemini", "gemini-cli"]);

/** Interpreters a JavaScript agent host (npm install) runs under. */
const JS_RUNTIMES = new Set(["node", "nodejs", "bun", "deno"]);

/** A path segment that names an agent host's package or entry point. */
const AGENT_HOST_PATH_RE =
  /(?:^|\/)(?:@anthropic-ai\/claude-code|claude-code|@openai\/codex|codex-cli|@google\/gemini-cli|gemini-cli)(?:\/|$)/;

/** Commands that exist to give another command a pty. */
const PTY_WRAPPER_NAMES = new Set(["script", "unbuffer", "expect", "faketty", "socat", "ttyrec", "winpty", "autoexpect"]);

/** Interpreters whose command line can open a pty (`python -c 'import pty…'`, `python -m pty`). */
const PTY_INTERPRETER_RE = /^(?:python[\d.]*|perl|ruby|node|nodejs|php|lua|tclsh|bun|deno)$/;
const PTY_ARG_RE = /(?:^|[^A-Za-z])-?r?(?:pty|pexpect|ptyprocess)(?![A-Za-z])|openpty|forkpty|node-pty|IO::Pty/;

function nameOf(info: AncestorInfo): string[] {
  const names = [basename(info.comm).toLowerCase()];
  const a0 = info.argv[0];
  if (a0 !== undefined && a0 !== "") names.push(basename(a0).toLowerCase());
  return names;
}

/** A fixed label when this process is an agent host or a pty wrapper, else `null`. */
export function classifyAncestor(info: AncestorInfo): string | null {
  const names = nameOf(info);
  for (const n of names) {
    if (AGENT_HOST_NAMES.has(n)) return n.startsWith("gemini") ? "gemini" : n.startsWith("claude") ? "claude" : n;
  }
  for (const n of names) {
    if (PTY_WRAPPER_NAMES.has(n)) return n;
  }
  const isJsRuntime = names.some(n => JS_RUNTIMES.has(n));
  if (isJsRuntime) {
    // `node /…/@anthropic-ai/claude-code/cli.js`: the host is the script, not the runtime.
    for (const a of info.argv.slice(1, 4)) {
      const m = AGENT_HOST_PATH_RE.exec(a);
      if (m !== null) {
        return m[0].includes("codex") ? "codex" : m[0].includes("gemini") ? "gemini" : "claude";
      }
    }
  }
  if (names.some(n => PTY_INTERPRETER_RE.test(n)) && info.argv.slice(1, 6).some(a => PTY_ARG_RE.test(a))) {
    return "an interpreter with a pty";
  }
  return null;
}

/** Judge a chain. `null` (unreadable) is `undeterminable`; the policy for that case belongs to the caller. */
export function judgeAncestry(chain: readonly AncestorInfo[] | null): AncestryVerdict {
  if (chain === null) return { kind: "undeterminable", why: "the process chain could not be read" };
  for (const info of chain) {
    const label = classifyAncestor(info);
    if (label !== null) return { kind: "agent", ancestor: label };
  }
  return { kind: "clear" };
}

// ---------------------------------------------------------------------------
// Reading (macOS / Linux)
// ---------------------------------------------------------------------------

/**
 * Parse `ps -o ppid=,comm=,args= -p <pid>` output (one line). `comm` may be a
 * path on macOS (`/bin/zsh`) and is kept whole; `args` starts with argv[0].
 */
export function parsePsLine(pid: number, line: string): AncestorInfo | null {
  const m = /^\s*(\d+)\s+(\S+)\s*(.*)$/.exec(line.trim());
  if (m === null) return null;
  const ppid = Number(m[1]);
  if (!Number.isSafeInteger(ppid) || ppid < 0) return null;
  const argv = (m[3] ?? "").split(/\s+/).filter(w => w !== "").slice(0, 6);
  return { pid, ppid, comm: m[2]!, argv };
}

/**
 * Parse `/proc/<pid>/stat` (`pid (comm) S ppid …`; comm may contain spaces and
 * parentheses, so split on the LAST `)`) and `/proc/<pid>/cmdline` (NUL-separated).
 */
export function parseProcEntry(pid: number, stat: string, cmdline: string): AncestorInfo | null {
  const close = stat.lastIndexOf(")");
  const open = stat.indexOf("(");
  if (open === -1 || close === -1 || close < open) return null;
  const comm = stat.slice(open + 1, close);
  const rest = stat.slice(close + 1).trim().split(/\s+/);
  const ppid = Number(rest[1]);
  if (!Number.isSafeInteger(ppid) || ppid < 0) return null;
  const argv = cmdline.split("\0").filter(w => w !== "").slice(0, 6);
  return { pid, ppid, comm, argv };
}

/** Looks one process up; `null` when it cannot be read. Injectable for tests. */
export type ProcessLookup = (pid: number) => AncestorInfo | null;

function lookupViaProc(pid: number): AncestorInfo | null {
  try {
    return parseProcEntry(pid, readFileSync(`/proc/${pid}/stat`, "utf8"), readFileSync(`/proc/${pid}/cmdline`, "utf8"));
  } catch {
    return null;
  }
}

function lookupViaPs(pid: number): AncestorInfo | null {
  try {
    const out = execFileSync("ps", ["-o", "ppid=,comm=,args=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: PS_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return parsePsLine(pid, out);
  } catch {
    return null;
  }
}

/** `/proc` where it exists, else `ps`. */
export const defaultProcessLookup: ProcessLookup = pid => lookupViaProc(pid) ?? lookupViaPs(pid);

/**
 * The chain above `startPid` (default: this process), nearest parent first, up
 * to and excluding pid 1. `null` when any hop cannot be read or the chain is
 * longer than {@link MAX_ANCESTRY_DEPTH} (a loop, or something the walk should
 * not trust): the caller decides what "unknown" means.
 */
export function readProcessAncestry(
  startPid: number = process.pid,
  lookup: ProcessLookup = defaultProcessLookup,
): readonly AncestorInfo[] | null {
  const chain: AncestorInfo[] = [];
  const seen = new Set<number>([startPid]);
  let current = lookup(startPid);
  if (current === null) return null;
  for (let hops = 0; hops < MAX_ANCESTRY_DEPTH; hops++) {
    const ppid = current.ppid;
    if (ppid <= 1) return chain; // reached init/launchd: complete
    if (seen.has(ppid)) return null;
    seen.add(ppid);
    const parent = lookup(ppid);
    if (parent === null) return null;
    chain.push(parent);
    current = parent;
  }
  return null;
}

// ---------------------------------------------------------------------------
// The test seam for the default reader
// ---------------------------------------------------------------------------

let readerOverride: AncestryReader | undefined;

/**
 * Test seam: make the DEFAULT reader return a fixed chain, for tests that pin
 * `process.stderr.isTTY` and call a function that reads the real process. A
 * developer running the suite under Claude Code would otherwise fail them. Pass
 * `undefined` to restore the real reader.
 */
export function setAncestryReaderForTests(reader: AncestryReader | undefined): void {
  readerOverride = reader;
}

/** The reader used when the caller injects none: the real process tree, or the test override. */
export const defaultAncestryReader: AncestryReader = () =>
  readerOverride !== undefined ? readerOverride() : readProcessAncestry();
