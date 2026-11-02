// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// The process-ancestry walk (issue #151, PR 2b): classification of the chain,
// positive roots, the bounded reader, the parsers, the real `ps` snapshot (by
// absolute path, never PATH), and the human-presence policy for rules g/h.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  agentEnvSignal,
  checkTerminal,
  classifyAncestor,
  judgeAncestry,
  MAX_ANCESTRY_DEPTH,
  parseProcEntry,
  isTrustedAppPath,
  parseLsofTxt,
  realExeOf,
  parsePsSnapshotLine,
  positiveRoot,
  trustedLsofPath,
  readProcessAncestry,
  snapshotViaPs,
  trustedPsPath,
  type AncestorInfo,
  type ExeResolver,
  type MultiplexerProbe,
  type ProcessLookup,
} from "./process-ancestry.js";
import { EGRESS_HUMAN_ENV, humanPresence, isHumanPresent } from "./egress-policy.js";

function proc(pid: number, ppid: number, comm: string, argv: string[] = [comm], exe?: string, uid?: number): AncestorInfo {
  return { pid, ppid, comm, argv, ...(exe !== undefined && { exe }), ...(uid !== undefined && { uid }) };
}

/** A resolver that trusts the fixture's own `exe` when it is an absolute path (the real one asks lsof or /proc). */
const FIXTURE_EXE: ExeResolver = info => (info.exe !== undefined && info.exe.startsWith("/") ? info.exe : null);

/** A lookup over a fixed table; an absent pid is unreadable. */
function table(...procs: AncestorInfo[]): ProcessLookup {
  const byPid = new Map(procs.map(p => [p.pid, p]));
  return pid => byPid.get(pid) ?? null;
}

const NO_CLIENT: MultiplexerProbe = () => false;
const HAS_CLIENT: MultiplexerProbe = () => true;
const ROOTED = { requireRoot: true, probe: HAS_CLIENT, resolveExe: FIXTURE_EXE } as const;

describe("classifyAncestor", () => {
  it("agent hosts by process name", () => {
    assert.equal(classifyAncestor(proc(2, 1, "claude")), "claude");
    assert.equal(classifyAncestor(proc(2, 1, "codex")), "codex");
    assert.equal(classifyAncestor(proc(2, 1, "gemini")), "gemini");
    assert.equal(classifyAncestor(proc(2, 1, "x", ["/Users/me/.local/bin/claude", "--resume"])), "claude");
  });

  it("an npm-installed host runs under node, bun or deno (M2: path, basename of argv[1], realpath)", () => {
    for (const [argv, label] of [
      [["node", "/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js"], "claude"],
      [["node", "/x/node_modules/@openai/codex/bin/codex.js"], "codex"],
      [["node", "/x/node_modules/@google/gemini-cli/dist/index.js"], "gemini"],
      [["node", "/opt/homebrew/bin/claude"], "claude"],
      [["node", "/opt/homebrew/bin/gemini"], "gemini"],
      [["node", "/opt/homebrew/bin/codex"], "codex"],
      [["bun", "/usr/local/bin/claude"], "claude"],
      [["deno", "run", "-A", "/usr/local/bin/gemini"], "gemini"],
      [["node", "--no-warnings", "/opt/homebrew/bin/codex.js"], "codex"],
    ] as const) {
      assert.equal(classifyAncestor(proc(2, 1, argv[0], [...argv])), label, argv.join(" "));
    }
  });

  it("a node script that is merely called server.js is not an agent", () => {
    assert.equal(classifyAncestor(proc(2, 1, "node", ["node", "server.js"])), null);
    assert.equal(classifyAncestor(proc(2, 1, "node", ["node", "/x/proj/codex/index.js"])), null);
  });

  it("the native binary by its real path (M2)", () => {
    const real = "/Users/x/.local/share/claude/versions/2.1.316";
    assert.equal(classifyAncestor(proc(2, 1, "2.1.316", [real], real)), "claude");
    assert.equal(
      classifyAncestor(proc(2, 1, "cc", ["/Users/x/.vscode/extensions/anthropic.claude-code-2.1.314-darwin-arm64/resources/native-binary/claude"])),
      "claude",
    );
  });

  it("pty wrappers (including sshpass and rlwrap)", () => {
    for (const name of ["script", "unbuffer", "expect", "faketty", "socat", "sshpass", "rlwrap"]) {
      assert.equal(classifyAncestor(proc(2, 1, name)), name);
    }
    assert.equal(classifyAncestor(proc(2, 1, "x", ["/usr/bin/script", "-q", "/dev/null"], "/usr/bin/script")), "script");
  });

  it("an interpreter with a pty argument", () => {
    assert.equal(classifyAncestor(proc(2, 1, "python3", ["python3", "-c", "import pty; pty.spawn(['sh'])"])), "an interpreter with a pty");
    assert.equal(classifyAncestor(proc(2, 1, "python3", ["python3", "-m", "pty"])), "an interpreter with a pty");
  });

  it("ordinary processes are not agents", () => {
    for (const p of [
      proc(2, 1, "zsh"),
      proc(2, 1, "-zsh"),
      proc(2, 1, "bash"),
      proc(2, 1, "login", ["login", "-pf", "me"]),
      proc(2, 1, "Terminal", ["/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal"]),
      proc(2, 1, "sshd"),
      proc(2, 1, "python3", ["python3", "build.py"]),
      proc(2, 1, "python3", ["python3", "-c", "print('empty')"]),
      proc(2, 1, "node", ["node", "server.js"]),
    ]) {
      assert.equal(classifyAncestor(p), null, p.comm);
    }
  });

  it("tmux and screen are NOT agents by themselves: a person works inside them", () => {
    assert.equal(classifyAncestor(proc(2, 1, "tmux: server", ["tmux"])), null);
    assert.equal(classifyAncestor(proc(2, 1, "tmux")), null);
    assert.equal(classifyAncestor(proc(2, 1, "screen")), null);
  });
});

describe("agentEnvSignal (M2)", () => {
  it("CLAUDECODE=1 and CLAUDE_CODE_ENTRYPOINT are positive agent signals", () => {
    assert.equal(agentEnvSignal({ CLAUDECODE: "1" }), "claude");
    assert.equal(agentEnvSignal({ CLAUDE_CODE_ENTRYPOINT: "cli" }), "claude");
  });
  it("their absence says nothing", () => {
    assert.equal(agentEnvSignal({}), null);
    assert.equal(agentEnvSignal({ CLAUDECODE: "0", CLAUDE_CODE_ENTRYPOINT: "" }), null);
  });
});

describe("positive roots (H2a)", () => {
  const root = (info: AncestorInfo, probe: MultiplexerProbe = NO_CLIENT, resolveExe: ExeResolver = FIXTURE_EXE) =>
    positiveRoot(info, { probe, resolveExe });

  it("login, with the real executable path", () => {
    assert.equal(root(proc(2, 1, "login", ["login", "-pf", "me"], "/usr/bin/login", 0)), "login");
  });

  it("a `login` whose path ps could not read (the bare name macOS shows for a setuid process) is judged by name", () => {
    assert.equal(root(proc(2, 1, "login", ["login", "-pf", "me"], "login", 0)), "login");
  });

  it("a `login` that lives under /tmp or $HOME is not a root", () => {
    assert.equal(root(proc(2, 1, "login", ["login"], "/private/tmp/clau", 0)), null);
    assert.equal(root(proc(2, 1, "login", ["login"], "/Users/me/.local/", 0)), null);
  });

  it("sshd and its per-session children", () => {
    assert.equal(root(proc(2, 1, "sshd", ["sshd"], "/usr/sbin/sshd", 0)), "sshd");
    assert.equal(root(proc(2, 1, "sshd-session", ["sshd-session"], "/usr/libexec/ssh", 0)), "sshd");
  });

  const EMULATORS: ReadonlyArray<readonly [label: string, info: AncestorInfo]> = [
    ["Terminal", proc(2, 1, "Terminal", ["/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal"], "/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal")],
    ["iTerm2", proc(2, 1, "iTerm2", ["/Applications/iTerm.app/Contents/MacOS/iTerm2"], "/Applications/iTerm.app/Contents/MacOS/iTerm2")],
    ["VS Code", proc(2, 1, "Code Helper (Plu", ["/Applications/Visual", "Studio", "Code.app/x/Code", "Helper", "(Plugin)"], "/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin)")],
    ["VS Code", proc(2, 1, "Electron", ["/Applications/Visual"], "/Applications/Visual Studio Code.app/Contents/MacOS/Electron")],
    ["WezTerm", proc(2, 1, "wezterm-gui", ["wezterm-gui"], "/Applications/WezTerm.app/Contents/MacOS/wezterm-gui")],
    ["Alacritty", proc(2, 1, "alacritty", ["alacritty"], "/Applications/Alacritty.app/Contents/MacOS/alacritty")],
    ["kitty", proc(2, 1, "kitty", ["kitty"], "/Applications/kitty.app/Contents/MacOS/kitty")],
    ["Ghostty", proc(2, 1, "ghostty", ["ghostty"], "/Applications/Ghostty.app/Contents/MacOS/ghostty")],
    ["Warp", proc(2, 1, "stable", ["/Applications/Warp.app/Contents/MacOS/stable"], "/Applications/Warp.app/Contents/MacOS/stable")],
    ["gnome-terminal", proc(2, 1, "gnome-terminal-", ["/usr/libexec/gnome-terminal-server"], "/usr/libexec/gnome-terminal-server")],
    ["konsole", proc(2, 1, "konsole", ["konsole"], "/usr/bin/konsole")],
    ["xterm", proc(2, 1, "xterm", ["xterm"], "/usr/bin/xterm")],
  ];
  for (const [label, info] of EMULATORS) {
    it(`terminal emulator: ${label} (${info.comm})`, () => {
      assert.equal(root(info), label);
    });
  }

  it("an emulator-named binary in an untrusted place is not a root", () => {
    assert.equal(root(proc(2, 1, "kitty", ["kitty"], "/private/tmp/clau")), null);
  });

  it("a tmux server is a root only with an attached client", () => {
    const server = proc(2, 1, "tmux", ["tmux:", "server", "(/private/tmp/tmux-501/default)"], "/opt/homebrew/bin");
    assert.equal(root(server, HAS_CLIENT), "tmux");
    assert.equal(root(server, NO_CLIENT), null);
    const linux = proc(2, 1, "tmux: server", ["tmux: server"], "/usr/bin/tmux");
    assert.equal(root(linux, HAS_CLIENT), "tmux");
  });

  it("a tmux CLIENT is not a server, and a screen server needs a client too", () => {
    assert.equal(root(proc(2, 1, "tmux", ["tmux", "attach"], "/opt/homebrew/bin"), HAS_CLIENT), null);
    assert.equal(root(proc(2, 1, "SCREEN", ["SCREEN"], "/usr/bin/screen"), HAS_CLIENT), "screen");
    assert.equal(root(proc(2, 1, "SCREEN", ["SCREEN"], "/usr/bin/screen"), NO_CLIENT), null);
  });
});

describe("judgeAncestry", () => {
  it("a plain shell chain is clear when no root is required", () => {
    assert.deepEqual(judgeAncestry([proc(3, 2, "zsh"), proc(2, 1, "login")]), { kind: "clear" });
  });

  it("this session's own shape: zsh <- -zsh <- login <- Terminal is rooted (login, then Terminal)", () => {
    const chain = [
      proc(5, 4, "zsh", ["/bin/zsh"], "/bin/zsh"),
      proc(4, 3, "-zsh", ["-zsh"], "-zsh"),
      proc(3, 2, "login", ["login", "-pf", "me"], "/usr/bin/login", 0),
      proc(2, 1, "Terminal", ["/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal"], "/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal"),
    ];
    assert.deepEqual(judgeAncestry(chain, ROOTED), { kind: "clear", root: "login" });
    assert.deepEqual(judgeAncestry(chain.slice(0, 2), ROOTED).kind, "unrooted");
    assert.deepEqual(judgeAncestry(chain.slice(3), ROOTED), { kind: "clear", root: "Terminal" });
  });

  it("an agent host anywhere in the chain is an agent, rooted or not", () => {
    const chain = [proc(4, 3, "zsh"), proc(3, 2, "claude"), proc(2, 1, "login", ["login"], "/usr/bin/login", 0)];
    assert.deepEqual(judgeAncestry(chain, ROOTED), { kind: "agent", ancestor: "claude" });
    assert.deepEqual(judgeAncestry(chain), { kind: "agent", ancestor: "claude" });
  });

  it("a pty wrapper in the chain is an agent verdict", () => {
    assert.deepEqual(judgeAncestry([proc(3, 2, "zsh"), proc(2, 1, "script")]), { kind: "agent", ancestor: "script" });
  });

  it("H2: a pty re-parented to launchd through a bare interpreter has no positive root", () => {
    const reparented = [proc(4, 3, "zsh"), proc(3, 2, "python3", ["python3", "detach.py"], "/opt/homebrew/Ce")];
    assert.deepEqual(judgeAncestry(reparented, ROOTED), { kind: "unrooted" });
  });

  it("an empty complete chain (a child of init) is unrooted when a root is required", () => {
    assert.deepEqual(judgeAncestry([], ROOTED), { kind: "unrooted" });
  });

  it("M1: an agent found in the part that WAS read wins over an unreadable later hop", () => {
    assert.deepEqual(
      judgeAncestry({ ancestors: [proc(4, 3, "zsh"), proc(3, 2, "claude")], complete: false }, ROOTED),
      { kind: "agent", ancestor: "claude" },
    );
  });

  it("M1: an unreadable chain with no hit is undeterminable; so is nothing at all", () => {
    assert.equal(judgeAncestry({ ancestors: [proc(4, 3, "zsh")], complete: false }, ROOTED).kind, "undeterminable");
    assert.equal(judgeAncestry(null).kind, "undeterminable");
  });

  it("tmux under a person's login is rooted by the login; a lone tmux server needs a client", () => {
    const server = proc(3, 1, "tmux", ["tmux:", "server", "(/private/tmp/tmux-501/default)"], "/opt/homebrew/bin");
    const pane = proc(4, 3, "zsh");
    assert.deepEqual(judgeAncestry([pane, server], { ...ROOTED, probe: HAS_CLIENT }), { kind: "clear", root: "tmux" });
    assert.deepEqual(judgeAncestry([pane, server], { ...ROOTED, probe: NO_CLIENT }), { kind: "unrooted" });
    assert.deepEqual(
      judgeAncestry([pane, server, proc(2, 1, "claude")], { ...ROOTED, probe: HAS_CLIENT }),
      { kind: "agent", ancestor: "claude" },
    );
  });
});

describe("readProcessAncestry — bounded, offline, never throws", () => {
  it("walks to init and returns the chain nearest parent first, excluding the start and init", () => {
    const lookup = table(proc(10, 9, "node"), proc(9, 8, "zsh"), proc(8, 7, "claude"), proc(7, 1, "zsh"));
    const r = readProcessAncestry(10, lookup);
    assert.equal(r.complete, true);
    assert.deepEqual(r.ancestors.map(p => p.pid), [9, 8, 7]);
  });

  it("a process whose parent is init has an empty, complete chain", () => {
    assert.deepEqual(readProcessAncestry(10, table(proc(10, 1, "zsh"))), { ancestors: [], complete: true });
  });

  it("an unreadable hop keeps what WAS read (M1) and is incomplete", () => {
    const lookup = table(proc(10, 9, "node"), proc(9, 8, "zsh") /* 8 is missing */);
    const r = readProcessAncestry(10, lookup);
    assert.equal(r.complete, false);
    assert.deepEqual(r.ancestors.map(p => p.pid), [9]);
  });

  it("an unreadable start is incomplete and empty", () => {
    assert.deepEqual(readProcessAncestry(10, table()), { ancestors: [], complete: false });
  });

  it("a loop is incomplete, not an endless walk", () => {
    assert.equal(readProcessAncestry(10, table(proc(10, 9, "a"), proc(9, 10, "b"))).complete, false);
  });

  it(`a chain longer than ${MAX_ANCESTRY_DEPTH} hops is incomplete and bounded`, () => {
    const procs: AncestorInfo[] = [];
    for (let i = 0; i < MAX_ANCESTRY_DEPTH + 10; i++) procs.push(proc(1000 + i, 1001 + i, "sh"));
    let calls = 0;
    const base = table(...procs);
    const lookup: ProcessLookup = pid => (calls++, base(pid));
    assert.equal(readProcessAncestry(1000, lookup).complete, false);
    assert.ok(calls <= MAX_ANCESTRY_DEPTH + 2, `bounded: ${calls} lookups`);
  });

  it("a lookup that throws is an unreadable hop", () => {
    const r = readProcessAncestry(10, () => {
      throw new Error("boom");
    });
    assert.deepEqual(r, { ancestors: [], complete: false });
  });

  it("the real reader returns a chain for this very process and does not throw", () => {
    const real = readProcessAncestry();
    assert.ok(Array.isArray(real.ancestors) && typeof real.complete === "boolean");
  });
});

describe("parsers", () => {
  it("parsePsSnapshotLine reads the macOS ucomm/comm/args layout", () => {
    const line = "  624     1   501 logind           /System/Library/ /System/Library/CoreServices/logind";
    assert.deepEqual(parsePsSnapshotLine(line), {
      pid: 624,
      ppid: 1,
      uid: 501,
      comm: "logind",
      argv: ["/System/Library/CoreServices/logind"],
      exe: "/System/Library/",
    });
    assert.equal(parsePsSnapshotLine(" 1692  1535     0 login            login            login -pf me")?.uid, 0);
    const helper = "15270 11442   501 Code Helper (Plu /Applications/Vi /Applications/Visual Studio Code.app/x --type=utility";
    const p = parsePsSnapshotLine(helper);
    assert.equal(p?.comm, "Code Helper (Plu");
    assert.equal(p?.exe, "/Applications/Vi");
    assert.equal(parsePsSnapshotLine(""), null);
    assert.equal(parsePsSnapshotLine("not a line"), null);
  });

  it("parseProcEntry survives a comm with spaces and parentheses", () => {
    const stat = "77 (tmux: server (x)) S 5 77 77 0 -1 4194560";
    const p = parseProcEntry(77, stat, "tmux\0new\0-d\0", "/usr/bin/tmux", "Name:\ttmux\nUid:\t501\t0\t501\t501\n");
    assert.deepEqual(p, { pid: 77, ppid: 5, comm: "tmux: server (x)", argv: ["tmux", "new", "-d"], exe: "/usr/bin/tmux", uid: 0 });
    assert.equal(parseProcEntry(77, "garbage", ""), null);
  });
});

describe("the real ps snapshot (H1, L5, L6)", () => {
  it("trustedPsPath is an absolute /bin or /usr/bin path, or null; never found through PATH", () => {
    const p = trustedPsPath();
    assert.ok(p === null || p === "/bin/ps" || p === "/usr/bin/ps", String(p));
    assert.equal(trustedPsPath(["ps", "./ps"]), null);
    assert.equal(trustedPsPath(["/nonexistent/ps"]), null);
  });

  const table = snapshotViaPs();
  it("one snapshot contains this process and a parent chain that ends at init", { skip: table === null && "ps is blocked here" }, () => {
    assert.ok(table!.has(process.pid));
    const r = readProcessAncestry(process.pid, pid => table!.get(pid) ?? null);
    assert.equal(r.complete, true);
    assert.equal(table!.get(process.pid)?.ppid, process.ppid);
  });

  it("a fake `ps` first on PATH is ignored", () => {
    const dir = mkdtempSync(join(tmpdir(), "repo-aegis-fake-ps-"));
    try {
      const marker = join(dir, "ran");
      mkdirSync(join(dir, "bin"));
      writeFileSync(join(dir, "bin", "ps"), `#!/bin/sh\ntouch ${JSON.stringify(marker)}\necho "    1     0 launchd          /sbin/launchd    /sbin/launchd"\n`);
      chmodSync(join(dir, "bin", "ps"), 0o755);
      const url = pathToFileURL(join(import.meta.dirname, "process-ancestry.js")).href;
      const code = `import { snapshotViaPs, trustedPsPath } from ${JSON.stringify(url)}; const t = snapshotViaPs(); console.log(JSON.stringify({ ps: trustedPsPath(), size: t === null ? null : t.size, hasFake: t !== null && t.size === 1 }));`;
      const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
        encoding: "utf8",
        env: { ...process.env, PATH: `${join(dir, "bin")}:${process.env["PATH"] ?? ""}` },
      });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(existsSync(marker), false, "the fake ps on PATH must never run");
      const out = JSON.parse(r.stdout) as { ps: string | null; hasFake: boolean };
      assert.ok(out.ps === null || out.ps.startsWith("/"));
      assert.equal(out.hasFake, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a parent whose title is `claude` is seen as an agent by the real reader (M3)", { skip: table === null && "ps is blocked here" }, () => {
    const url = pathToFileURL(join(import.meta.dirname, "process-ancestry.js")).href;
    const child = `import { readProcessAncestry, classifyAncestor } from ${JSON.stringify(url)}; const r = readProcessAncestry(); console.log(JSON.stringify({ complete: r.complete, first: r.ancestors[0] ? classifyAncestor(r.ancestors[0]) : null }));`;
    const parent = `process.title = "claude"; const { spawnSync } = require("node:child_process"); const r = spawnSync(process.execPath, ["--input-type=module", "-e", ${JSON.stringify(child)}], { encoding: "utf8" }); process.stdout.write(r.stdout);`;
    const r = spawnSync(process.execPath, ["-e", parent], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout) as { first: string | null };
    assert.equal(out.first, "claude");
  });
});

describe("checkTerminal — the entry point both gates use", () => {
  const PERSON = [proc(4, 3, "-zsh"), proc(3, 2, "login", ["login"], "/usr/bin/login", 0)];
  const run = (over: Parameters<typeof checkTerminal>[0]) => checkTerminal({ stderrIsTTY: true, ...over });

  it("no TTY: the chain is never read", () => {
    let read = 0;
    assert.deepEqual(run({ stderrIsTTY: false, ancestry: () => (read++, PERSON) }), { kind: "no-tty" });
    assert.equal(read, 0);
  });

  it("a rooted person chain is clear", () => {
    assert.deepEqual(run({ ancestry: () => PERSON }), { kind: "clear", root: "login" });
  });

  it("the Claude Code environment is an agent signal, even over a person-looking chain", () => {
    assert.deepEqual(run({ ancestry: () => PERSON, env: { CLAUDECODE: "1" } }), { kind: "agent", ancestor: "claude", via: "env" });
  });

  it("a person-looking environment never makes an agent chain clear", () => {
    assert.equal(run({ ancestry: () => [proc(3, 2, "claude")], env: {} }).kind, "agent");
  });

  it("unrooted and undeterminable are reported as such", () => {
    assert.equal(run({ ancestry: () => [proc(3, 2, "python3")] }).kind, "unrooted");
    assert.equal(run({ ancestry: () => null }).kind, "undeterminable");
    assert.equal(
      run({
        ancestry: () => {
          throw new Error("x");
        },
      }).kind,
      "undeterminable",
    );
  });

  it("an injected TTY answer alone is the explicit TEST-ONLY skip", () => {
    assert.deepEqual(checkTerminal({ stderrIsTTY: true }), { kind: "skipped" });
  });
});

describe("humanPresence — the policy for rules g and h", () => {
  const claudeAbove = (): AncestorInfo[] => [proc(3, 2, "zsh"), proc(2, 1, "claude")];
  const plainShell = (): AncestorInfo[] => [proc(3, 2, "zsh"), proc(2, 1, "login", ["login"], "/usr/bin/login", 0)];

  it("a TTY with a claude ancestor is NOT a person", () => {
    const p = humanPresence({}, true, claudeAbove);
    assert.equal(p.present, false);
    assert.equal(p.ancestry, "agent");
    assert.equal(p.ancestor, "claude");
  });

  it("a TTY under a pty wrapper is NOT a person", () => {
    assert.equal(isHumanPresent({}, true, () => [proc(2, 1, "script")]), false);
  });

  it("the Claude Code environment makes a TTY not a person", () => {
    assert.equal(isHumanPresent({ CLAUDECODE: "1" }, true, plainShell), false);
  });

  it("a TTY with a rooted plain shell chain is a person", () => {
    const p = humanPresence({}, true, plainShell);
    assert.equal(p.present, true);
    assert.equal(p.ancestry, "clear");
  });

  it("a missing positive root keeps the TTY result and reports it (rules g/h)", () => {
    const p = humanPresence({}, true, () => [proc(3, 2, "python3")]);
    assert.equal(p.present, true);
    assert.equal(p.ancestry, "undeterminable");
  });

  it("an undeterminable ancestry keeps today's TTY result and reports it", () => {
    const p = humanPresence({}, true, () => null);
    assert.equal(p.present, true);
    assert.equal(p.ancestry, "undeterminable");
  });

  it("an agent found before an unreadable hop is still an agent (M1)", () => {
    const p = humanPresence({}, true, () => ({ ancestors: [proc(2, 1, "claude")], complete: false }));
    assert.deepEqual([p.present, p.ancestry], [false, "agent"]);
  });

  it("a reader that throws is undeterminable too", () => {
    const p = humanPresence({}, true, () => {
      throw new Error("boom");
    });
    assert.deepEqual([p.present, p.ancestry], [true, "undeterminable"]);
  });

  it("no TTY is never a person, and the ancestry is not read", () => {
    let read = 0;
    const p = humanPresence({}, false, () => (read++, []));
    assert.deepEqual([p.present, p.ancestry, read], [false, "skipped", 0]);
  });

  it("the human-only env override still decides, with no ancestry read", () => {
    let read = 0;
    const p = humanPresence({ [EGRESS_HUMAN_ENV]: "1" }, false, () => (read++, claudeAbove()));
    assert.deepEqual([p.present, p.ancestry, read], [true, "skipped", 0]);
  });

  it("L4: an explicit TTY with an injected ancestry is judged; without one it is the labelled test-only skip", () => {
    assert.equal(isHumanPresent({}, true, claudeAbove), false);
    assert.deepEqual(humanPresence({}, true), { present: true, ancestry: "skipped" });
  });
});

describe("roots cannot be forged by name (final review: uid 0 and a verified real path)", () => {
  const root = (info: AncestorInfo, resolveExe: ExeResolver = FIXTURE_EXE, probe: MultiplexerProbe = NO_CLIENT) =>
    positiveRoot(info, { probe, resolveExe });

  it("1: login and sshd need effective uid 0; a same-user process called `login` is not a root", () => {
    assert.equal(root(proc(2, 1, "login", ["login", "-pf", "me"], "login", 0)), "login");
    assert.equal(root(proc(2, 1, "login", ["login", "-pf", "me"], "login", 501)), null);
    assert.equal(root(proc(2, 1, "login", ["login"], "login")), null); // uid unknown: cannot be vouched for
    assert.equal(root(proc(2, 1, "sshd", ["sshd"], "/usr/sbin/sshd", 501)), null);
    assert.equal(root(proc(2, 1, "sshd-session", ["sshd-session"], "/usr/libexec/ssh", 0)), "sshd");
  });

  it("1: a real login at uid 0 whose path is somewhere untrusted still fails", () => {
    assert.equal(root(proc(2, 1, "login", ["login"], "/private/tmp/x/login", 0)), null);
    assert.equal(root(proc(2, 1, "login", ["login"], "/Users/me/x/login", 0)), null);
  });

  it("1: a short or empty path prefix cannot stand in for a trusted one", () => {
    for (const exe of ["/", "/u", "/s", "/A", "/Applications", "/usr", "/opt"]) {
      assert.equal(root(proc(2, 1, "login", ["login"], exe, 0)), null, exe);
    }
  });

  it("2: an emulator root needs a trusted REAL executable path, not its name", () => {
    const forged = proc(2, 1, "kitty", ["kitty"], "/Applications/ki");
    assert.equal(root(forged, () => "/Users/me/.nvm/versions/node/v22/bin/node"), null);
    assert.equal(root(forged, () => "/private/tmp/claude-501/x/code"), null);
    assert.equal(root(forged, () => "/Applications/kitty.app/Contents/MacOS/kitty"), "kitty");
  });

  it("2: if the real path cannot be established (no lsof, a sandbox), an emulator does not count", () => {
    const term = proc(2, 1, "Terminal", ["/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal"], "/System/Applicat");
    assert.equal(root(term, () => null), null);
    assert.equal(
      root(term, () => {
        throw new Error("lsof failed");
      }),
      null,
    );
    assert.equal(root(term, () => "/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal"), "Terminal");
  });

  it("2: the trusted application paths", () => {
    for (const ok of [
      "/Applications/iTerm.app/Contents/MacOS/iTerm2",
      "/Applications/Visual Studio Code.app/Contents/MacOS/Electron",
      "/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal",
      "/usr/bin/xterm",
      "/usr/libexec/gnome-terminal-server",
      "/opt/homebrew/Caskroom/ghostty/1.0/Ghostty.app/Contents/MacOS/ghostty",
      "/opt/kitty/bin/kitty",
      "/snap/kitty/current/bin/kitty",
    ]) {
      assert.equal(isTrustedAppPath(ok), true, ok);
    }
    for (const bad of [
      "",
      "/",
      "/A",
      "/Applications",
      "/Applications/x/y",
      "/Applications/../tmp/x.app/y",
      "/Users/me/Applications/kitty.app/Contents/MacOS/kitty",
      "/private/tmp/claude-501/x/login",
      "/tmp/x/code",
      "/usr/local/bin/kitty",
      "/opt/homebrew/bin/kitty",
      "/opt/homebrew/Cellar/kitty/1/bin/kitty",
      "relative/Applications/x.app/y",
    ]) {
      assert.equal(isTrustedAppPath(bad), false, bad);
    }
  });

  it("3: a tmux server's socket comes from its own title, never from $TMUX", () => {
    let seen: string | null | undefined;
    const probe: MultiplexerProbe = (_kind, socket) => ((seen = socket), true);
    const server = proc(2, 1, "tmux", ["tmux:", "server", "(/private/tmp/tmux-501/default)"], "/opt/homebrew/bin");
    assert.equal(root(server, FIXTURE_EXE, probe), "tmux");
    assert.equal(seen, "/private/tmp/tmux-501/default");
    seen = undefined;
    const untitled = proc(2, 1, "tmux", ["tmux:", "server"], "/opt/homebrew/bin");
    assert.equal(root(untitled, FIXTURE_EXE, probe), "tmux"); // the probe decides; real probes refuse a null socket
    assert.equal(seen, null);
  });

  it("parseLsofTxt takes the first text mapping, the executable", () => {
    const out = "p1535\nftxt\nn/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal\nftxt\nn/usr/lib/dyld\n";
    assert.equal(parseLsofTxt(out), "/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal");
    assert.equal(parseLsofTxt("p1\n"), null);
    assert.equal(parseLsofTxt(""), null);
  });

  it("trustedLsofPath refuses a missing path and a non-root-owned file", () => {
    assert.equal(trustedLsofPath("/nonexistent/lsof"), null);
    assert.equal(trustedLsofPath(process.execPath) === null || process.getuid?.() === 0, true); // node is not root-owned
  });

  it("5: the env override is test-only: outside the test runner it is ignored", () => {
    const savedCtx = process.env["NODE_TEST_CONTEXT"];
    const savedClaude = process.env["CLAUDECODE"];
    const ttyDesc = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");
    try {
      delete process.env["NODE_TEST_CONTEXT"];
      process.env["CLAUDECODE"] = "1";
      Object.defineProperty(process.stderr, "isTTY", { value: true, configurable: true, writable: true });
      // An agent-supplied empty env must not hide the real CLAUDECODE=1.
      assert.deepEqual(checkTerminal({ env: {} }), { kind: "agent", ancestor: "claude", via: "env" });
    } finally {
      if (savedCtx !== undefined) process.env["NODE_TEST_CONTEXT"] = savedCtx;
      if (savedClaude === undefined) delete process.env["CLAUDECODE"];
      else process.env["CLAUDECODE"] = savedClaude;
      if (ttyDesc) Object.defineProperty(process.stderr, "isTTY", ttyDesc);
      else delete (process.stderr as { isTTY?: boolean }).isTTY;
    }
  });

  it("4: the env verdict is marked as coming from the environment", () => {
    assert.deepEqual(checkTerminal({ stderrIsTTY: true, ancestry: () => [], env: { CLAUDECODE: "1" } }), {
      kind: "agent",
      ancestor: "claude",
      via: "env",
    });
  });
});

describe("forged roots, for real (the reviewer's probe shape: x/login, x/code, x/run.js)", () => {
  const snapshot = snapshotViaPs();
  const lsofWorks = realExeOfSelf() !== null;
  const reason = snapshot === null ? "ps is blocked here" : !lsofWorks ? "lsof is blocked here" : false;

  /** Run a fake `<name>` (a symlink to node, started with that argv[0]) whose child reads the chain and judges its first ancestor. */
  function forged(name: string): { first: string | null; root: string | null; uid: number | null } {
    const dir = mkdtempSync(join(tmpdir(), "repo-aegis-forged-root-"));
    try {
      mkdirSync(join(dir, "x"));
      const fake = join(dir, "x", name);
      symlinkSync(process.execPath, fake);
      const url = pathToFileURL(join(import.meta.dirname, "process-ancestry.js")).href;
      const child = `import { readProcessAncestry, positiveRoot, realExeOf, realMultiplexerProbe } from ${JSON.stringify(url)};
        const r = readProcessAncestry(); const a = r.ancestors[0];
        console.log(JSON.stringify({ first: a ? a.comm : null, uid: a && a.uid !== undefined ? a.uid : null,
          root: a ? positiveRoot(a, { probe: () => false, resolveExe: realExeOf }) : null }));`;
      const parent = `const { spawnSync } = require("node:child_process");
        const r = spawnSync(process.execPath, ["--input-type=module", "-e", ${JSON.stringify(child)}], { encoding: "utf8" });
        process.stdout.write(r.stdout);`;
      const r = spawnSync(fake, ["-e", parent], { encoding: "utf8", argv0: name });
      assert.equal(r.status, 0, r.stderr);
      return JSON.parse(r.stdout) as { first: string | null; root: string | null; uid: number | null };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("a copy of node called `login` (and `exec -a login`) runs as the user, so it is no root", { skip: reason }, () => {
    const r = forged("login");
    assert.notEqual(r.uid, 0);
    assert.equal(r.root, null);
  });

  it("a copy of node called `code` is no root: its real path is not under a root-owned application directory", { skip: reason }, () => {
    assert.equal(forged("code").root, null);
  });

  it("a node script run as `run.js` under a forged `Terminal` is no root either", { skip: reason }, () => {
    assert.equal(forged("Terminal").root, null);
  });
});

function realExeOfSelf(): string | null {
  return snapshotViaPs() === null ? null : realExeOf({ pid: process.pid, ppid: process.ppid, comm: "node", argv: [] });
}

describe("L4: test seams are inert outside the test runner", () => {
  it("an injected TTY and chain are ignored when NODE_TEST_CONTEXT is absent (the real terminal and tree decide)", () => {
    const url = pathToFileURL(join(import.meta.dirname, "process-ancestry.js")).href;
    const policyUrl = pathToFileURL(join(import.meta.dirname, "egress-policy.js")).href;
    const code = `import { checkTerminal } from ${JSON.stringify(url)};
      import { humanPresence } from ${JSON.stringify(policyUrl)};
      const a = checkTerminal({ stderrIsTTY: true, ancestry: () => [] });
      const b = humanPresence({}, true);
      console.log(JSON.stringify({ a: a.kind, bAncestry: b.ancestry }));`;
    const env = { ...process.env };
    delete env["NODE_TEST_CONTEXT"];
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout) as { a: string; bAncestry: string };
    // stderr is a pipe here, so the REAL answer is "no TTY"; the injected `true` was not honoured.
    assert.equal(out.a, "no-tty");
    assert.equal(out.bAncestry, "skipped");
    const present = JSON.parse(r.stdout) as unknown;
    assert.ok(present !== null);
  });
});
