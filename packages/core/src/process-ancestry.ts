// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// Who is behind this terminal? (issue #151, PR 2b; plan §8.1 S10)
//
// "stderr is a TTY" is a speed bump, not proof of a person: `script -q
// /dev/null <cmd>`, `unbuffer`, `expect`, `python -c 'import pty…'`, `socat …
// pty` and `ssh -tt localhost` give an agent's child a pty. This module reads
// the parent-process chain and says whether
//   - an AGENT HOST (Claude Code, Codex, Gemini CLI) or a PTY WRAPPER sits above
//     this process (the terminal is not a person's), and
//   - the chain reaches a POSITIVE ROOT: a login session, sshd, a terminal
//     emulator, or a tmux/screen server with an attached client. A chain that
//     ends at launchd/init through a bare interpreter is what a double-fork +
//     `setsid` + `pty.spawn` produces, and it is not a person's terminal either.
//
// Reading the table (the reviewer's H1, L5, L6, M1):
//   - `ps` is run by ABSOLUTE path (`/bin/ps` or `/usr/bin/ps`, a root-owned
//     regular file, nothing else) with a minimal environment, never through
//     `PATH`: an agent can put a fake `ps` first on its own PATH.
//   - ONE snapshot (`ps -A -o pid=,ppid=,ucomm=,comm=,args=`) is parsed once and
//     walked in memory: no per-hop spawns, no PID-reuse race, no stall. On Linux
//     `/proc` is read instead.
//   - The process NAME is `ucomm` (the kernel's `p_comm`); `comm` (the
//     executable path) is kept to check where a root really lives; `args` gives
//     argv for the JS-runtime and interpreter checks.
//   - Each hop is classified as it is read: an agent found anywhere is "agent"
//     even when a later hop could not be read. Only an unreadable chain with no
//     hit is "undeterminable".
// Offline: no network. Only fixed labels (`claude`, `script`, …) ever leave this
// module; argument vectors may hold credentials and are never printed or stored.
//
// RESIDUAL (stated, not solved): this is a heuristic about the process tree.
//   - An agent with code execution can type into the user's real terminal
//     (`osascript` / AppleScript `do script`, `tmux send-keys` to a pane the
//     person owns, writing to `/dev/ttys00N`), or start a process outside its
//     own tree (`launchctl submit`, `at`, `cron`, a login item) that then owns
//     a pty. Neither has an agent ancestor.
//   - `ssh -tt localhost` has an `sshd` ancestor, which is a positive root: a
//     person logging in remotely is legitimate. Only the agent hook's text rules
//     cover it.
//   - A root is recognised by name and by where the executable lives (macOS
//     `ps` truncates the path to 16 characters, so only its prefix is checked).
//     An agent that can write under /Applications could forge one.
//   - `tmux new -d` / `screen -dm` / `setsid` / double-fork reparent under init;
//     the agent hook refuses those starts in the text of any command
//     (`AGENT_DETACHED_SESSION`), and a chain that ends there has no positive
//     root. A tmux/screen server counts as a root only with an attached client.
//   The durable fix is a presence signal an agent cannot forge (a Keychain item
//   with a user-presence ACL / Touch ID); tracked separately.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { basename } from "node:path";

/** One process in the chain. Nothing here is ever printed except fixed labels. */
export interface AncestorInfo {
  pid: number;
  ppid: number;
  /** The kernel's short process name (`ucomm`; `/proc/<pid>/comm`). A path in old fixtures; its basename is used. */
  comm: string;
  /** The first few argv words, used only for classification (never printed). */
  argv: readonly string[];
  /** The executable's path as the OS reports it (truncated to 16 characters by macOS `ps`). Absent in fixtures. */
  exe?: string;
}

/** What was read of the chain: the ancestors that WERE read, nearest parent first, and whether it reached init. */
export interface AncestryChain {
  ancestors: readonly AncestorInfo[];
  /** True when the walk reached pid 1 (or 0) without an unreadable hop. */
  complete: boolean;
}

/** Reads the chain above this process. A bare array is a complete chain; `null` is nothing readable. */
export type AncestryReader = () => AncestryChain | readonly AncestorInfo[] | null;

export type AncestryVerdict =
  | { kind: "clear"; /** The positive root that was found; absent when no root was required. */ root?: string }
  | { kind: "agent"; /** A fixed, content-free label such as `claude` or `script`. */ ancestor: string }
  /** A complete chain that reaches init without a login session, terminal emulator or attached multiplexer. */
  | { kind: "unrooted" }
  | { kind: "undeterminable"; why: string };

/** How far up the walk goes before giving up (and reporting `undeterminable`). */
export const MAX_ANCESTRY_DEPTH = 32;

const PS_TIMEOUT_MS = 5000;
const PS_MAX_BUFFER = 32 * 1024 * 1024;

function normalise(read: ReturnType<AncestryReader>): AncestryChain {
  if (read === null) return { ancestors: [], complete: false };
  if (Array.isArray(read)) return { ancestors: read as readonly AncestorInfo[], complete: true };
  return read as AncestryChain;
}

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

/** The native Claude Code binary lives under `…/claude/versions/<n>` (or the VS Code extension's `native-binary/claude`). */
const NATIVE_CLAUDE_RE = /(?:^|\/)claude\/versions\/|\/anthropic\.claude-code[^/]*\/resources\/native-binary\/claude$/;

/** Commands that exist to give another command a pty. */
const PTY_WRAPPER_NAMES = new Set([
  "script", "unbuffer", "expect", "faketty", "socat", "ttyrec", "winpty", "autoexpect", "sshpass", "rlwrap",
]);

/** Interpreters whose command line can open a pty (`python -c 'import pty…'`, `python -m pty`). */
const PTY_INTERPRETER_RE = /^(?:python[\d.]*|perl|ruby|node|nodejs|php|lua|tclsh|bun|deno)$/;
const PTY_ARG_RE = /(?:^|[^A-Za-z])-?r?(?:pty|pexpect|ptyprocess)(?![A-Za-z])|openpty|forkpty|node-pty|IO::Pty/;

function lowerBase(s: string | undefined): string {
  return s === undefined || s === "" ? "" : basename(s).toLowerCase();
}

function namesOf(info: AncestorInfo): string[] {
  const out = [lowerBase(info.comm), lowerBase(info.argv[0]), lowerBase(info.exe)];
  return out.filter(n => n !== "");
}

function realBase(path: string | undefined): string {
  if (path === undefined || path === "" || !path.startsWith("/")) return "";
  try {
    return realpathSync(path);
  } catch {
    return "";
  }
}

function hostFromScript(arg: string): string | null {
  const m = AGENT_HOST_PATH_RE.exec(arg);
  if (m !== null) return m[0].includes("codex") ? "codex" : m[0].includes("gemini") ? "gemini" : "claude";
  const b = lowerBase(arg).replace(/\.(?:m?js|cjs)$/, "");
  if (AGENT_HOST_NAMES.has(b)) return b.startsWith("gemini") ? "gemini" : b.startsWith("claude") ? "claude" : b;
  return null;
}

/** A fixed label when this process is an agent host or a pty wrapper, else `null`. */
export function classifyAncestor(info: AncestorInfo): string | null {
  const names = namesOf(info);
  for (const n of names) {
    if (AGENT_HOST_NAMES.has(n)) return n.startsWith("gemini") ? "gemini" : n.startsWith("claude") ? "claude" : n;
  }
  for (const n of names) {
    if (PTY_WRAPPER_NAMES.has(n)) return n;
  }
  // The native binary, however it is named: its real path is `…/claude/versions/<n>` (M2).
  for (const p of [info.argv[0], info.exe]) {
    if (p === undefined || !p.startsWith("/")) continue;
    if (NATIVE_CLAUDE_RE.test(p)) return "claude";
    const real = realBase(p);
    if (real !== "" && NATIVE_CLAUDE_RE.test(real)) return "claude";
  }
  if (names.some(n => JS_RUNTIMES.has(n))) {
    // `node /…/@anthropic-ai/claude-code/cli.js`, `node /opt/homebrew/bin/gemini`: the host is the
    // script, not the runtime. Match the path, the basename of argv[1..3] and the basename of its realpath.
    for (const a of info.argv.slice(1, 4)) {
      if (a.startsWith("-")) continue;
      const direct = hostFromScript(a);
      if (direct !== null) return direct;
      const real = realBase(a);
      if (real !== "") {
        const viaReal = hostFromScript(real);
        if (viaReal !== null) return viaReal;
      }
    }
  }
  if (names.some(n => PTY_INTERPRETER_RE.test(n)) && info.argv.slice(1, 6).some(a => PTY_ARG_RE.test(a))) {
    return "an interpreter with a pty";
  }
  return null;
}

/** `CLAUDECODE=1` / `CLAUDE_CODE_ENTRYPOINT`: the environment Claude Code gives its commands. A positive agent signal only; never evidence of a person. */
export function agentEnvSignal(env: NodeJS.ProcessEnv): string | null {
  if (env["CLAUDECODE"] === "1") return "claude";
  const entry = env["CLAUDE_CODE_ENTRYPOINT"];
  if (entry !== undefined && entry !== "") return "claude";
  return null;
}

// ---------------------------------------------------------------------------
// Positive roots (pure)
// ---------------------------------------------------------------------------

/** Where a root's executable may live. A binary in /tmp or $HOME named `login` is not one. */
const TRUSTED_EXE_PREFIXES = ["/Applications/", "/System/", "/usr/", "/bin/", "/sbin/", "/opt/", "/snap/", "/nix/", "/Library/"];

function exeTrusted(info: AncestorInfo): boolean {
  const e = info.exe;
  // Not reported, or not an absolute path: macOS `ps` falls back to the argv[0]-style name (`login`, `-zsh`)
  // for a setuid or foreign-user process whose path it cannot read. Judged by name then.
  if (e === undefined || !e.startsWith("/")) return true;
  return TRUSTED_EXE_PREFIXES.some(p => e.startsWith(p) || p.startsWith(e));
}

/** Terminal emulators by process name (lower-case, `ucomm`). */
const TERMINAL_EMULATORS: ReadonlyArray<readonly [name: RegExp, label: string]> = [
  [/^terminal$/, "Terminal"],
  [/^iterm/, "iTerm2"],
  [/^(?:code|electron|code helper.*|cursor.*|code - insiders.*)$/, "VS Code"],
  [/^wezterm/, "WezTerm"],
  [/^alacritty$/, "Alacritty"],
  [/^kitty$/, "kitty"],
  [/^ghostty$/, "Ghostty"],
  [/^warp$/, "Warp"],
  [/^gnome-terminal/, "gnome-terminal"],
  [/^konsole$/, "konsole"],
  [/^xterm$/, "xterm"],
  [/^(?:tilix|terminator|foot|xfce4-terminal|lxterminal|mate-terminal|kgx|ptyxis|urxvt|rxvt|hyper|tabby)$/, "terminal emulator"],
];

/** Probe: does the tmux / screen server this process belongs to have an attached client? Injectable. */
export type MultiplexerProbe = (kind: "tmux" | "screen", env: NodeJS.ProcessEnv) => boolean;

/** The positive root `info` is, or null. A multiplexer server is a root only when `probe` finds a client. */
export function positiveRoot(info: AncestorInfo, probe: MultiplexerProbe, env: NodeJS.ProcessEnv): string | null {
  const name = lowerBase(info.comm);
  const argv = info.argv.join(" ");
  const trusted = exeTrusted(info);
  if (name === "login" && trusted) return "login";
  if (name.startsWith("sshd") && trusted) return "sshd";
  if (trusted) {
    for (const [re, label] of TERMINAL_EMULATORS) if (re.test(name)) return label;
    if (/\/Warp\.app\//.test(argv)) return "Warp";
  }
  const lowerArgv = argv.toLowerCase();
  if (name.startsWith("tmux") && (lowerArgv.startsWith("tmux: server") || name === "tmux: server")) {
    return probe("tmux", env) ? "tmux" : null;
  }
  if (name === "screen" && !lowerArgv.includes(" -")) return probe("screen", env) ? "screen" : null;
  return null;
}

/**
 * Judge a chain. `null` (unreadable) is `undeterminable`; the policy for that
 * case belongs to the caller. An agent found in the part that WAS read wins over
 * an unreadable later hop (M1).
 */
export function judgeAncestry(
  read: ReturnType<AncestryReader>,
  opts: { requireRoot?: boolean; probe?: MultiplexerProbe; env?: NodeJS.ProcessEnv } = {},
): AncestryVerdict {
  const chain = normalise(read);
  for (const info of chain.ancestors) {
    const label = classifyAncestor(info);
    if (label !== null) return { kind: "agent", ancestor: label };
  }
  if (!chain.complete) return { kind: "undeterminable", why: "the process chain could not be read to its end" };
  if (opts.requireRoot !== true) return { kind: "clear" };
  const probe = opts.probe ?? realMultiplexerProbe;
  const env = opts.env ?? process.env;
  for (const info of chain.ancestors) {
    const root = positiveRoot(info, probe, env);
    if (root !== null) return { kind: "clear", root };
  }
  return { kind: "unrooted" };
}

// ---------------------------------------------------------------------------
// Reading (macOS / Linux)
// ---------------------------------------------------------------------------

/**
 * Parse one line of `ps -A -ww -o pid=,ppid=,ucomm=,comm=,args=` (macOS layout:
 * `ucomm` and `comm` are 16-character columns, each followed by one space).
 * Returns null for a line that does not fit.
 */
export function parsePsSnapshotLine(line: string): AncestorInfo | null {
  const m = /^\s*(\d+)\s+(\d+) (.{16}) (.{16}) ?(.*)$/.exec(line);
  if (m === null) return null;
  const pid = Number(m[1]);
  const ppid = Number(m[2]);
  if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(ppid)) return null;
  const argv = (m[5] ?? "").split(/\s+/).filter(w => w !== "").slice(0, 6);
  return { pid, ppid, comm: m[3]!.trim(), argv, exe: m[4]!.trim() };
}

/**
 * Parse `/proc/<pid>/stat` (`pid (comm) S ppid …`; comm may contain spaces and
 * parentheses, so split on the LAST `)`) and `/proc/<pid>/cmdline` (NUL-separated).
 */
export function parseProcEntry(pid: number, stat: string, cmdline: string, exe?: string): AncestorInfo | null {
  const close = stat.lastIndexOf(")");
  const open = stat.indexOf("(");
  if (open === -1 || close === -1 || close < open) return null;
  const comm = stat.slice(open + 1, close);
  const rest = stat.slice(close + 1).trim().split(/\s+/);
  const ppid = Number(rest[1]);
  if (!Number.isSafeInteger(ppid) || ppid < 0) return null;
  const argv = cmdline.split("\0").filter(w => w !== "").slice(0, 6);
  return { pid, ppid, comm, argv, ...(exe !== undefined && exe !== "" && { exe }) };
}

/** Looks one process up; `null` when it cannot be read. Injectable for tests. */
export type ProcessLookup = (pid: number) => AncestorInfo | null;

function lookupViaProc(pid: number): AncestorInfo | null {
  try {
    let exe: string | undefined;
    try {
      exe = readlinkSync(`/proc/${pid}/exe`);
    } catch {
      /* a foreign process: judged by name */
    }
    return parseProcEntry(pid, readFileSync(`/proc/${pid}/stat`, "utf8"), readFileSync(`/proc/${pid}/cmdline`, "utf8"), exe);
  } catch {
    return null;
  }
}

/** `ps` candidates. Never found through `PATH`. */
const PS_CANDIDATES = ["/bin/ps", "/usr/bin/ps"];

/** The first candidate that is a root-owned regular file, else null (refuse anything else). */
export function trustedPsPath(candidates: readonly string[] = PS_CANDIDATES): string | null {
  for (const p of candidates) {
    try {
      const st = statSync(p);
      if (st.isFile() && st.uid === 0) return p;
    } catch {
      /* try the next */
    }
  }
  return null;
}

/** ONE snapshot of the process table via `ps`, or null when it cannot be taken. */
export function snapshotViaPs(psPath: string | null = trustedPsPath()): Map<number, AncestorInfo> | null {
  if (psPath === null) return null;
  try {
    const out = execFileSync(psPath, ["-A", "-ww", "-o", "pid=,ppid=,ucomm=,comm=,args="], {
      encoding: "utf8",
      timeout: PS_TIMEOUT_MS,
      maxBuffer: PS_MAX_BUFFER,
      stdio: ["ignore", "pipe", "ignore"],
      env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
    });
    const table = new Map<number, AncestorInfo>();
    for (const line of out.split("\n")) {
      const info = parsePsSnapshotLine(line);
      if (info !== null) table.set(info.pid, info);
    }
    return table.size > 0 ? table : null;
  } catch {
    return null;
  }
}

/** `/proc` where it exists, else a single `ps` snapshot taken on first use. */
export function makeDefaultLookup(): ProcessLookup {
  if (existsSync("/proc/self/stat")) return lookupViaProc;
  let table: Map<number, AncestorInfo> | null | undefined;
  return pid => {
    if (table === undefined) table = snapshotViaPs();
    return table?.get(pid) ?? null;
  };
}

/**
 * The chain above `startPid` (default: this process), nearest parent first, up
 * to and excluding pid 1. The ancestors that were read are returned even when
 * the walk stops early (`complete: false`): an unreadable hop, a loop, or more
 * than {@link MAX_ANCESTRY_DEPTH} hops. Never throws.
 */
export function readProcessAncestry(
  startPid: number = process.pid,
  lookup: ProcessLookup = makeDefaultLookup(),
): AncestryChain {
  const ancestors: AncestorInfo[] = [];
  const seen = new Set<number>([startPid]);
  let current: AncestorInfo | null;
  try {
    current = lookup(startPid);
  } catch {
    current = null;
  }
  if (current === null) return { ancestors, complete: false };
  for (let hops = 0; hops < MAX_ANCESTRY_DEPTH; hops++) {
    const ppid = current.ppid;
    if (ppid <= 1) return { ancestors, complete: true }; // reached init/launchd
    if (seen.has(ppid)) return { ancestors, complete: false };
    seen.add(ppid);
    let parent: AncestorInfo | null;
    try {
      parent = lookup(ppid);
    } catch {
      parent = null;
    }
    if (parent === null) return { ancestors, complete: false };
    ancestors.push(parent);
    current = parent;
  }
  return { ancestors, complete: false };
}

// ---------------------------------------------------------------------------
// Multiplexer probe (real)
// ---------------------------------------------------------------------------

function firstExisting(paths: readonly string[]): string | null {
  for (const p of paths) {
    try {
      if (statSync(p).isFile()) return p;
    } catch {
      /* next */
    }
  }
  return null;
}

/** Does the tmux server (socket from `$TMUX`) or any screen session have an attached client? Absolute paths, minimal env. */
export const realMultiplexerProbe: MultiplexerProbe = (kind, env) => {
  try {
    if (kind === "tmux") {
      const socket = (env["TMUX"] ?? "").split(",")[0] ?? "";
      const bin = firstExisting(["/opt/homebrew/bin/tmux", "/usr/local/bin/tmux", "/usr/bin/tmux", "/bin/tmux"]);
      if (bin === null || !socket.startsWith("/")) return false;
      const out = execFileSync(bin, ["-S", socket, "list-clients", "-F", "#{client_pid}"], {
        encoding: "utf8",
        timeout: 2000,
        stdio: ["ignore", "pipe", "ignore"],
        env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
      });
      return out.trim() !== "";
    }
    const bin = firstExisting(["/usr/bin/screen", "/opt/homebrew/bin/screen", "/usr/local/bin/screen"]);
    if (bin === null) return false;
    const out = execFileSync(bin, ["-ls"], {
      encoding: "utf8",
      timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"],
      env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
    });
    return out.includes("(Attached)");
  } catch {
    return false;
  }
};

// ---------------------------------------------------------------------------
// The test seams, and the one entry point both gates use
// ---------------------------------------------------------------------------

let readerOverride: AncestryReader | undefined;

/**
 * Test seams exist only under the Node test runner (which sets
 * `NODE_TEST_CONTEXT` in the process that runs a test file). Outside it an
 * injected TTY answer or ancestry reader is IGNORED and the real terminal and
 * process tree are used, so no production call path can skip the check (L4).
 */
export function testSeamsEnabled(): boolean {
  return process.env["NODE_TEST_CONTEXT"] !== undefined;
}

/**
 * TEST-ONLY: make the DEFAULT reader return a fixed chain, for tests that pin
 * `process.stderr.isTTY` and call a function that reads the real process. A
 * developer running the suite under Claude Code would otherwise fail them. Pass
 * `undefined` to restore the real reader. Inert outside the test runner.
 */
export function setAncestryReaderForTests(reader: AncestryReader | undefined): void {
  readerOverride = reader;
}

export interface TerminalCheckOptions {
  /** TEST-ONLY: the TTY answer. Ignored outside the test runner. */
  stderrIsTTY?: boolean;
  /** TEST-ONLY: a synthetic process chain. Ignored outside the test runner. */
  ancestry?: AncestryReader;
  /** Environment for the agent-env signal and the tmux probe. Default `process.env`, or `{}` for a synthetic chain. */
  env?: NodeJS.ProcessEnv;
  /** TEST-ONLY: the multiplexer probe. Synthetic chains default to "has a client". */
  probe?: MultiplexerProbe;
}

export type TerminalCheck =
  | { kind: "no-tty" }
  /** TEST-ONLY: the caller injected the TTY answer and no chain, so none was read. Never produced outside the test runner. */
  | { kind: "skipped" }
  | AncestryVerdict;

/**
 * Is stderr a TTY that belongs to a person? The TTY, then (with a TTY) the
 * environment signal and the process chain, which must reach a positive root.
 * The policy for `unrooted` / `undeterminable` is the caller's: `approve` and
 * the owner adds refuse, rules g/h keep the TTY result and say so.
 */
export function checkTerminal(opts: TerminalCheckOptions = {}): TerminalCheck {
  const test = testSeamsEnabled();
  const injected = test && opts.stderrIsTTY !== undefined;
  const tty = injected ? opts.stderrIsTTY === true : !!process.stderr.isTTY;
  if (!tty) return { kind: "no-tty" };
  const synthetic = test ? (opts.ancestry ?? readerOverride) : undefined;
  if (injected && synthetic === undefined) return { kind: "skipped" };
  const env = opts.env ?? (synthetic !== undefined ? {} : process.env);
  const fromEnv = agentEnvSignal(env);
  if (fromEnv !== null) return { kind: "agent", ancestor: fromEnv };
  let read: ReturnType<AncestryReader>;
  try {
    read = synthetic !== undefined ? synthetic() : readProcessAncestry();
  } catch {
    return { kind: "undeterminable", why: "the ancestry reader failed" };
  }
  return judgeAncestry(read, {
    requireRoot: true,
    env,
    ...(test && opts.probe !== undefined
      ? { probe: opts.probe }
      : synthetic !== undefined
        ? { probe: () => true }
        : {}),
  });
}
