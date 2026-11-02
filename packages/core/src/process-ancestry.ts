// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// Who is behind this terminal? (issue #151, PR 2b; plan §8.1 S10)
//
// ===========================================================================
// THE BOUNDARY (read this before trusting anything below)
// ===========================================================================
// Outside the agent's sandbox, an agent that runs as the same user can forge
// ANY process-identity signal this module reads: it can name a process
// anything (`exec -a login`, a copied binary called `login`, `process.title`),
// set any environment variable, and write the approvals file or the registry
// directly (plan §8.2 R1). So outside the sandbox these checks are SPEED BUMPS,
// not proof of a person. INSIDE the agent sandbox (no pty, `ps` and `lsof`
// blocked) they fail closed: nothing can be read, so `approve` and the owner
// adds refuse. The sandbox is the real boundary; this code makes the common
// accidental and the cheap deliberate routes fail. The lasting fix is a
// presence signal an agent cannot forge: a Keychain item with a user-presence
// ACL / Touch ID prompt for `approve` and owner adds (tracked as a follow-up
// issue; it predates #151).
// ===========================================================================
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
//   - ONE snapshot (`ps -A -o pid=,ppid=,uid=,ucomm=,comm=,args=`) is parsed once
//     and walked in memory: no per-hop spawns, no PID-reuse race, no stall. On
//     Linux `/proc` is read instead.
//   - The process NAME is `ucomm` (the kernel's `p_comm`). NOTE: on macOS the
//     `comm` column is NOT the executable path: it follows argv[0] (and is cut to
//     16 characters), so `exec -a login x` shows as `login`. It and `args` are
//     therefore hints for classification only, never proof of what is running.
//   - What a root really IS comes from two harder facts: its effective uid (a
//     real `login` / `sshd` runs as uid 0) and its executable's real path (from
//     `lsof -d txt` on macOS, `/proc/<pid>/exe` on Linux), which an emulator must
//     have under a root-owned application directory.
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
//   - A root is recognised by name plus uid 0 (login, sshd) or plus a verified
//     real executable path (emulators). An agent that can write under
//     /Applications, or that can run as root, could still forge one.
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
  /**
   * The `comm` column as `ps` prints it: on macOS argv[0]-style and cut to 16 characters, so NOT proof of the
   * executable. Linux: `readlink /proc/<pid>/exe`. A hint only; roots are verified separately.
   */
  exe?: string;
  /** Effective uid. A real `login` / `sshd` runs as 0. Absent in older fixtures, which then cannot be those roots. */
  uid?: number;
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
  | {
      kind: "agent";
      /** A fixed, content-free label such as `claude` or `script`. */
      ancestor: string;
      /** `env` when the signal was the Claude Code environment (`CLAUDECODE=1`), not a process in the chain. */
      via?: "env";
    }
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

/**
 * Where a login / sshd executable may live, when `ps` could read its path at all. (A bare name, which is what
 * macOS shows for a setuid process, is judged by the uid check instead.) A full prefix: a short one such as
 * "/" or "/A" must not match.
 */
const TRUSTED_EXE_PREFIXES = ["/usr/", "/bin/", "/sbin/", "/System/", "/opt/", "/snap/", "/nix/"];

function exeTrusted(info: AncestorInfo): boolean {
  const e = info.exe;
  if (e === undefined || !e.startsWith("/")) return true; // not a path: judged by uid, not by location
  return TRUSTED_EXE_PREFIXES.some(p => e.startsWith(p));
}

/**
 * The REAL executable path of an emulator may only be under a root-owned application directory: not the user's
 * home, not /tmp, not /usr/local or Homebrew's user-owned prefix (only its Caskroom).
 */
const TRUSTED_APP_PATHS: readonly RegExp[] = [
  /^\/Applications\/[^/]+\.app\//,
  /^\/System\/(?:Applications|Library|Volumes\/Preboot\/Cryptexes)\//,
  /^\/usr\/(?:bin|sbin|libexec|lib|share|lib64)\//,
  /^\/opt\/homebrew\/Caskroom\//,
  /^\/opt\/(?!homebrew(?:\/|$))[^/]+\//,
  /^\/(?:snap|nix\/store|var\/lib\/flatpak)\//,
];

/** True when `path` is a canonical absolute path under a root-owned application directory. */
export function isTrustedAppPath(path: string): boolean {
  if (!path.startsWith("/") || path.split("/").some(seg => seg === ".." || seg === ".")) return false;
  return TRUSTED_APP_PATHS.some(re => re.test(path));
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

/**
 * Probe: does the tmux / screen server have an attached client? For tmux, `socket` is the socket path read from
 * the SERVER process's own title (`tmux: server (/path/to/socket)`), never from `$TMUX`, which the agent controls;
 * null when the title names none. Injectable.
 */
export type MultiplexerProbe = (kind: "tmux" | "screen", socket: string | null) => boolean;

/** The real executable path of a process, or null when it cannot be established. Injectable. */
export type ExeResolver = (info: AncestorInfo) => string | null;

export interface RootContext {
  probe: MultiplexerProbe;
  resolveExe: ExeResolver;
}

/**
 * The positive root `info` is, or null.
 *   - `login` / `sshd`: by name AND effective uid 0. A copied or `exec -a`-renamed binary runs as the user.
 *   - A terminal emulator: by name AND a real executable path under a root-owned application directory
 *     ({@link isTrustedAppPath}). If the path cannot be established (no `lsof`, a sandbox), it does not count.
 *   - A tmux / screen server: only with an attached client.
 */
export function positiveRoot(info: AncestorInfo, ctx: RootContext): string | null {
  const name = lowerBase(info.comm);
  const argv = info.argv.join(" ");
  if (name === "login") return info.uid === 0 && exeTrusted(info) ? "login" : null;
  if (name.startsWith("sshd")) return info.uid === 0 && exeTrusted(info) ? "sshd" : null;
  let label: string | null = null;
  for (const [re, l] of TERMINAL_EMULATORS) {
    if (re.test(name)) {
      label = l;
      break;
    }
  }
  if (label === null && /\/Warp\.app\//.test(argv)) label = "Warp";
  if (label !== null) {
    let real: string | null = null;
    try {
      real = ctx.resolveExe(info);
    } catch {
      real = null;
    }
    return real !== null && isTrustedAppPath(real) ? label : null;
  }
  const lowerArgv = argv.toLowerCase();
  if (name.startsWith("tmux") && (lowerArgv.startsWith("tmux: server") || name === "tmux: server")) {
    const socket = /\((\/[^)]+)\)/.exec(argv)?.[1] ?? null;
    return ctx.probe("tmux", socket) ? "tmux" : null;
  }
  if (name === "screen" && !lowerArgv.includes(" -")) return ctx.probe("screen", null) ? "screen" : null;
  return null;
}

/**
 * Judge a chain. `null` (unreadable) is `undeterminable`; the policy for that
 * case belongs to the caller. An agent found in the part that WAS read wins over
 * an unreadable later hop (M1).
 */
export function judgeAncestry(
  read: ReturnType<AncestryReader>,
  opts: { requireRoot?: boolean; probe?: MultiplexerProbe; resolveExe?: ExeResolver } = {},
): AncestryVerdict {
  const chain = normalise(read);
  for (const info of chain.ancestors) {
    const label = classifyAncestor(info);
    if (label !== null) return { kind: "agent", ancestor: label };
  }
  if (!chain.complete) return { kind: "undeterminable", why: "the process chain could not be read to its end" };
  if (opts.requireRoot !== true) return { kind: "clear" };
  const ctx: RootContext = { probe: opts.probe ?? realMultiplexerProbe, resolveExe: opts.resolveExe ?? realExeOf };
  for (const info of chain.ancestors) {
    const root = positiveRoot(info, ctx);
    if (root !== null) return { kind: "clear", root };
  }
  return { kind: "unrooted" };
}

// ---------------------------------------------------------------------------
// Reading (macOS / Linux)
// ---------------------------------------------------------------------------

/**
 * Parse one line of `ps -A -ww -o pid=,ppid=,uid=,ucomm=,comm=,args=` (macOS
 * layout: `ucomm` and `comm` are 16-character columns, each followed by one
 * space; `uid` is the EFFECTIVE uid). Returns null for a line that does not fit.
 */
export function parsePsSnapshotLine(line: string): AncestorInfo | null {
  const m = /^\s*(\d+)\s+(\d+)\s+(\d+) (.{16}) (.{16}) ?(.*)$/.exec(line);
  if (m === null) return null;
  const pid = Number(m[1]);
  const ppid = Number(m[2]);
  const uid = Number(m[3]);
  if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(ppid) || !Number.isSafeInteger(uid)) return null;
  const argv = (m[6] ?? "").split(/\s+/).filter(w => w !== "").slice(0, 6);
  return { pid, ppid, uid, comm: m[4]!.trim(), argv, exe: m[5]!.trim() };
}

/**
 * Parse `/proc/<pid>/stat` (`pid (comm) S ppid …`; comm may contain spaces and
 * parentheses, so split on the LAST `)`) and `/proc/<pid>/cmdline` (NUL-separated).
 */
export function parseProcEntry(
  pid: number,
  stat: string,
  cmdline: string,
  exe?: string,
  status?: string,
): AncestorInfo | null {
  const close = stat.lastIndexOf(")");
  const open = stat.indexOf("(");
  if (open === -1 || close === -1 || close < open) return null;
  const comm = stat.slice(open + 1, close);
  const rest = stat.slice(close + 1).trim().split(/\s+/);
  const ppid = Number(rest[1]);
  if (!Number.isSafeInteger(ppid) || ppid < 0) return null;
  const argv = cmdline.split("\0").filter(w => w !== "").slice(0, 6);
  // `/proc/<pid>/status`: "Uid:\treal\teffective\tsaved\tfs". The effective uid is the second.
  const uidMatch = status === undefined ? null : /^Uid:\s+\d+\s+(\d+)/m.exec(status);
  const uid = uidMatch === null ? undefined : Number(uidMatch[1]);
  return {
    pid,
    ppid,
    comm,
    argv,
    ...(exe !== undefined && exe !== "" && { exe }),
    ...(uid !== undefined && Number.isSafeInteger(uid) && { uid }),
  };
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
    let status: string | undefined;
    try {
      status = readFileSync(`/proc/${pid}/status`, "utf8");
    } catch {
      /* no uid: such a process cannot be a login / sshd root */
    }
    return parseProcEntry(
      pid,
      readFileSync(`/proc/${pid}/stat`, "utf8"),
      readFileSync(`/proc/${pid}/cmdline`, "utf8"),
      exe,
      status,
    );
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
    const out = execFileSync(psPath, ["-A", "-ww", "-o", "pid=,ppid=,uid=,ucomm=,comm=,args="], {
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

const MINIMAL_ENV = { PATH: "/usr/bin:/bin", LC_ALL: "C" };

/** Does the tmux server on `socket` (taken from the server's own title) or any screen session have an attached client? Absolute paths, minimal env. */
export const realMultiplexerProbe: MultiplexerProbe = (kind, socket) => {
  try {
    if (kind === "tmux") {
      const bin = firstExisting(["/opt/homebrew/bin/tmux", "/usr/local/bin/tmux", "/usr/bin/tmux", "/bin/tmux"]);
      if (bin === null || socket === null || !socket.startsWith("/")) return false;
      const out = execFileSync(bin, ["-S", socket, "list-clients", "-F", "#{client_pid}"], {
        encoding: "utf8",
        timeout: 2000,
        stdio: ["ignore", "pipe", "ignore"],
        env: MINIMAL_ENV,
      });
      return out.trim() !== "";
    }
    const bin = firstExisting(["/usr/bin/screen", "/opt/homebrew/bin/screen", "/usr/local/bin/screen"]);
    if (bin === null) return false;
    const out = execFileSync(bin, ["-ls"], { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"], env: MINIMAL_ENV });
    return out.includes("(Attached)");
  } catch {
    return false;
  }
};

// ---------------------------------------------------------------------------
// The real executable path of a process
// ---------------------------------------------------------------------------

const LSOF_PATH = "/usr/sbin/lsof";

/** `lsof`, by absolute path, only when it is a root-owned regular file. */
export function trustedLsofPath(path: string = LSOF_PATH): string | null {
  try {
    const st = statSync(path);
    return st.isFile() && st.uid === 0 ? path : null;
  } catch {
    return null;
  }
}

/** The first `n<path>` line of `lsof -Fn` output for `-d txt`: the executable's real path. */
export function parseLsofTxt(out: string): string | null {
  for (const line of out.split("\n")) {
    if (line.startsWith("n/")) return line.slice(1);
  }
  return null;
}

/**
 * The REAL executable of a process, which argv[0] and `comm` cannot fake. Linux: `readlink /proc/<pid>/exe`.
 * macOS: `lsof -p <pid> -a -d txt -Fn` (the first text mapping is the executable), by absolute path with a
 * minimal environment. Null when it cannot be established, in which case an emulator root does not count.
 */
export const realExeOf: ExeResolver = info => {
  try {
    if (existsSync("/proc/self/stat")) return readlinkSync(`/proc/${info.pid}/exe`);
    const lsof = trustedLsofPath();
    if (lsof === null) return null;
    const out = execFileSync(lsof, ["-p", String(info.pid), "-a", "-d", "txt", "-Fn"], {
      encoding: "utf8",
      timeout: 3000,
      maxBuffer: 8 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
      env: MINIMAL_ENV,
    });
    return parseLsofTxt(out);
  } catch {
    return null;
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
  /** TEST-ONLY (ignored outside the test runner): the environment for the agent-env signal. Default `{}` for a synthetic chain, else `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** TEST-ONLY: the multiplexer probe. Synthetic chains default to "has a client". */
  probe?: MultiplexerProbe;
  /** TEST-ONLY: the real-executable resolver. Synthetic chains default to the fixture's own `exe`. */
  resolveExe?: ExeResolver;
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
  // Every override is test-only: outside the test runner the real environment, probes and process table decide.
  const env = test && opts.env !== undefined ? opts.env : synthetic !== undefined ? {} : process.env;
  const fromEnv = agentEnvSignal(env);
  if (fromEnv !== null) return { kind: "agent", ancestor: fromEnv, via: "env" };
  let read: ReturnType<AncestryReader>;
  try {
    read = synthetic !== undefined ? synthetic() : readProcessAncestry();
  } catch {
    return { kind: "undeterminable", why: "the ancestry reader failed" };
  }
  const probe: MultiplexerProbe | undefined = test && opts.probe !== undefined ? opts.probe : synthetic !== undefined ? () => true : undefined;
  const resolveExe: ExeResolver | undefined =
    test && opts.resolveExe !== undefined
      ? opts.resolveExe
      : synthetic !== undefined
        ? info => (info.exe !== undefined && info.exe.startsWith("/") ? info.exe : null)
        : undefined;
  return judgeAncestry(read, {
    requireRoot: true,
    ...(probe !== undefined && { probe }),
    ...(resolveExe !== undefined && { resolveExe }),
  });
}
