// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// The process-ancestry walk (issue #151, PR 2b): classification of the chain,
// the bounded reader, the parsers, and the human-presence policy for rules g/h.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  classifyAncestor,
  judgeAncestry,
  MAX_ANCESTRY_DEPTH,
  parseProcEntry,
  parsePsLine,
  readProcessAncestry,
  type AncestorInfo,
  type ProcessLookup,
} from "./process-ancestry.js";
import { EGRESS_HUMAN_ENV, humanPresence, isHumanPresent } from "./egress-policy.js";

function proc(pid: number, ppid: number, comm: string, argv: string[] = [comm]): AncestorInfo {
  return { pid, ppid, comm, argv };
}

/** A lookup over a fixed table; an absent pid is unreadable. */
function table(...procs: AncestorInfo[]): ProcessLookup {
  const byPid = new Map(procs.map(p => [p.pid, p]));
  return pid => byPid.get(pid) ?? null;
}

describe("classifyAncestor", () => {
  it("agent hosts by process name", () => {
    assert.equal(classifyAncestor(proc(2, 1, "claude")), "claude");
    assert.equal(classifyAncestor(proc(2, 1, "codex")), "codex");
    assert.equal(classifyAncestor(proc(2, 1, "gemini")), "gemini");
    assert.equal(classifyAncestor(proc(2, 1, "x", ["/Users/me/.local/bin/claude", "--resume"])), "claude");
  });

  it("an npm-installed host runs under node", () => {
    assert.equal(
      classifyAncestor(proc(2, 1, "node", ["node", "/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js"])),
      "claude",
    );
    assert.equal(classifyAncestor(proc(2, 1, "node", ["node", "/x/node_modules/@openai/codex/bin/codex.js"])), "codex");
    assert.equal(classifyAncestor(proc(2, 1, "node", ["node", "/x/node_modules/@google/gemini-cli/dist/index.js"])), "gemini");
  });

  it("pty wrappers", () => {
    for (const name of ["script", "unbuffer", "expect", "faketty", "socat"]) {
      assert.equal(classifyAncestor(proc(2, 1, name)), name);
    }
    assert.equal(classifyAncestor(proc(2, 1, "/usr/bin/script", ["/usr/bin/script", "-q", "/dev/null"])), "script");
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

  it("tmux and screen are NOT blockers by themselves: a person works inside them", () => {
    assert.equal(classifyAncestor(proc(2, 1, "tmux: server", ["tmux"])), null);
    assert.equal(classifyAncestor(proc(2, 1, "tmux")), null);
    assert.equal(classifyAncestor(proc(2, 1, "screen")), null);
  });
});

describe("judgeAncestry", () => {
  it("a plain shell chain is clear", () => {
    const chain = [proc(3, 2, "zsh"), proc(2, 1, "login")];
    assert.deepEqual(judgeAncestry(chain), { kind: "clear" });
  });

  it("an agent host anywhere in the chain is an agent", () => {
    const chain = [proc(4, 3, "zsh"), proc(3, 2, "claude"), proc(2, 1, "zsh")];
    assert.deepEqual(judgeAncestry(chain), { kind: "agent", ancestor: "claude" });
  });

  it("a pty wrapper in the chain is an agent verdict", () => {
    assert.deepEqual(judgeAncestry([proc(3, 2, "zsh"), proc(2, 1, "script")]), { kind: "agent", ancestor: "script" });
  });

  it("tmux under a person's shell is clear; tmux under claude is refused because of claude", () => {
    assert.deepEqual(judgeAncestry([proc(4, 3, "zsh"), proc(3, 2, "tmux: server", ["tmux"])]), { kind: "clear" });
    assert.deepEqual(
      judgeAncestry([proc(4, 3, "zsh"), proc(3, 2, "tmux: server", ["tmux"]), proc(2, 1, "claude")]),
      { kind: "agent", ancestor: "claude" },
    );
  });

  it("an unreadable chain is undeterminable", () => {
    assert.equal(judgeAncestry(null).kind, "undeterminable");
  });
});

describe("readProcessAncestry — bounded, offline, never throws", () => {
  it("walks to init and returns the chain nearest parent first, excluding the start and init", () => {
    const lookup = table(proc(10, 9, "node"), proc(9, 8, "zsh"), proc(8, 7, "claude"), proc(7, 1, "zsh"));
    const chain = readProcessAncestry(10, lookup);
    assert.deepEqual(chain?.map(p => p.pid), [9, 8, 7]);
  });

  it("a process whose parent is init has an empty chain", () => {
    assert.deepEqual(readProcessAncestry(10, table(proc(10, 1, "zsh"))), []);
  });

  it("an unreadable hop makes the whole chain undeterminable (null)", () => {
    const lookup = table(proc(10, 9, "node"), proc(9, 8, "zsh") /* 8 is missing */);
    assert.equal(readProcessAncestry(10, lookup), null);
  });

  it("an unreadable start is null", () => {
    assert.equal(readProcessAncestry(10, table()), null);
  });

  it("a loop is null, not an endless walk", () => {
    assert.equal(readProcessAncestry(10, table(proc(10, 9, "a"), proc(9, 10, "b"))), null);
  });

  it(`a chain longer than ${MAX_ANCESTRY_DEPTH} hops is null`, () => {
    const procs: AncestorInfo[] = [];
    for (let i = 0; i < MAX_ANCESTRY_DEPTH + 10; i++) procs.push(proc(1000 + i, 1001 + i, "sh"));
    let calls = 0;
    const base = table(...procs);
    const lookup: ProcessLookup = pid => (calls++, base(pid));
    assert.equal(readProcessAncestry(1000, lookup), null);
    assert.ok(calls <= MAX_ANCESTRY_DEPTH + 2, `bounded: ${calls} lookups`);
  });

  it("the real reader returns a chain or null for this very process, and does not throw", () => {
    const real = readProcessAncestry();
    assert.ok(real === null || Array.isArray(real));
  });
});

describe("parsers", () => {
  it("parsePsLine reads ppid, comm and the first argv words", () => {
    const p = parsePsLine(42, "  1234 /bin/zsh  /bin/zsh -l -c something\n");
    assert.deepEqual(p, { pid: 42, ppid: 1234, comm: "/bin/zsh", argv: ["/bin/zsh", "-l", "-c", "something"] });
    assert.equal(parsePsLine(42, ""), null);
    assert.equal(parsePsLine(42, "not a line"), null);
  });

  it("parseProcEntry survives a comm with spaces and parentheses", () => {
    const stat = "77 (tmux: server (x)) S 5 77 77 0 -1 4194560";
    const p = parseProcEntry(77, stat, "tmux\0new\0-d\0");
    assert.deepEqual(p, { pid: 77, ppid: 5, comm: "tmux: server (x)", argv: ["tmux", "new", "-d"] });
    assert.equal(parseProcEntry(77, "garbage", ""), null);
  });
});

describe("humanPresence — the policy for rules g and h", () => {
  const claudeAbove = (): AncestorInfo[] => [proc(3, 2, "zsh"), proc(2, 1, "claude")];
  const plainShell = (): AncestorInfo[] => [proc(3, 2, "zsh"), proc(2, 1, "login")];

  it("a TTY with a claude ancestor is NOT a person", () => {
    const p = humanPresence({}, true, claudeAbove);
    assert.equal(p.present, false);
    assert.equal(p.ancestry, "agent");
    assert.equal(p.ancestor, "claude");
  });

  it("a TTY under a pty wrapper is NOT a person", () => {
    assert.equal(isHumanPresent({}, true, () => [proc(2, 1, "script")]), false);
  });

  it("a TTY with a plain shell chain is a person", () => {
    const p = humanPresence({}, true, plainShell);
    assert.equal(p.present, true);
    assert.equal(p.ancestry, "clear");
  });

  it("an undeterminable ancestry keeps today's TTY result and reports it", () => {
    const p = humanPresence({}, true, () => null);
    assert.equal(p.present, true);
    assert.equal(p.ancestry, "undeterminable");
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

  it("an injected TTY answer is the whole answer unless an ancestry is injected too", () => {
    assert.equal(isHumanPresent({}, true), true);
  });
});
