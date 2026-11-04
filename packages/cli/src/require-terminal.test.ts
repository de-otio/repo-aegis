// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// The human-presence gate's ancestry check (issue #151, PR 2b): a TTY is not
// enough. If an agent host or a pty wrapper sits above the process, or the
// chain has no positive root (a login session, sshd, a terminal emulator, an
// attached multiplexer), or it cannot be read, `approve` and the owner adds
// refuse (fail closed). Rules g/h make the opposite choice for an unreadable or
// unrooted chain; that is covered in core/process-ancestry.test.ts.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listApprovals, loadRegistry, setAncestryReaderForTests, type AncestorInfo } from "@de-otio/repo-aegis-core";
import {
  captureOutput,
  captureOutputAsync,
  PERSON_ANCESTRY,
  UNDER_CLAUDE_ANCESTRY,
  withEnv,
  withEnvAsync,
  withStreamTty,
  withStreamTtyAsync,
} from "./_test-utils.js";
import { isHumanTerminal, readLine, requireTerminal, terminalVerdict } from "./require-terminal.js";
import { ANCESTRY_UNDETERMINABLE_NOTE, currentHumanPresent } from "./human-presence.js";
import { approve } from "./commands/approve.js";
import { engagementsAdd, engagementsRemove } from "./commands/engagements-mutate.js";
import { init } from "./commands/init.js";
import { upstreamsAdd } from "./commands/upstreams.js";

function proc(pid: number, ppid: number, comm: string, argv: string[] = [comm], exe?: string, uid?: number): AncestorInfo {
  return { pid, ppid, comm, argv, ...(exe !== undefined && { exe }), ...(uid !== undefined && { uid }) };
}

/** What `ps` shows for a person's own terminal, and for a Claude Code session (names only). */
const PERSON = (): readonly AncestorInfo[] => PERSON_ANCESTRY;
const UNDER_CLAUDE = (): readonly AncestorInfo[] => UNDER_CLAUDE_ANCESTRY;
const UNDER_SCRIPT = (): AncestorInfo[] => [proc(30, 29, "script", ["script", "-q", "/dev/null"], "/usr/bin/script"), ...PERSON_ANCESTRY];
/** The H2 shape: a pty re-parented to launchd by a double fork + setsid + pty.spawn: python3 <- init. */
const DETACHED_PTY = (): AncestorInfo[] => [
  proc(41, 40, "zsh", ["/bin/zsh"], "/bin/zsh"),
  proc(40, 1, "Python", ["python3", "detach.py"], "/opt/homebrew/Ce"),
];
const UNREADABLE = (): null => null;

let tmp: string;
before(() => {
  tmp = mkdtempSync(join(tmpdir(), "repo-aegis-require-terminal-"));
});
after(() => rmSync(tmp, { recursive: true, force: true }));

const REGISTRY = "schemaVersion: 2\nalways_block: []\npersonalOrgs:\n  - home-handle\nengagements: []\n";
const LAST_OWNER = `\
schemaVersion: 2
always_block: []
engagements:
  - id: only-customer
    name: Only Customer
    started: 2026-01-01
    markers:
      - only-marker
    githubOrgs:
      - only-customer-org
`;

function setupHome(name: string, registry: string = REGISTRY): { home: string; registryPath: string; approvalsPath: string } {
  const home = join(tmp, name);
  mkdirSync(join(home, "markers"), { recursive: true });
  mkdirSync(join(home, "state"), { recursive: true });
  const registryPath = join(home, "engagements.yaml");
  writeFileSync(registryPath, registry);
  return { home, registryPath, approvalsPath: join(home, "approvals.json") };
}

describe("terminalVerdict / isHumanTerminal", () => {
  it("a real TTY with a login-rooted person chain is a person", () => {
    assert.deepEqual(terminalVerdict({ stderrIsTTY: true, ancestry: PERSON }), { human: true });
    assert.equal(isHumanTerminal({ stderrIsTTY: true, ancestry: PERSON }), true);
  });

  it("session chain zsh <- -zsh <- login <- Terminal is a person; so is Terminal alone", () => {
    assert.equal(isHumanTerminal({ stderrIsTTY: true, ancestry: () => PERSON_ANCESTRY.slice(0, 3) }), true);
    assert.equal(isHumanTerminal({ stderrIsTTY: true, ancestry: () => PERSON_ANCESTRY.slice(3) }), true);
  });

  it("a TTY under claude is not a person, and names the ancestor", () => {
    assert.deepEqual(terminalVerdict({ stderrIsTTY: true, ancestry: UNDER_CLAUDE }), {
      human: false,
      why: "agent-ancestor",
      ancestor: "claude",
    });
  });

  it("a TTY under a pty wrapper is not a person", () => {
    assert.deepEqual(terminalVerdict({ stderrIsTTY: true, ancestry: UNDER_SCRIPT }), {
      human: false,
      why: "agent-ancestor",
      ancestor: "script",
    });
  });

  it("H2: a pty re-parented to launchd (no positive root) is not a person", () => {
    assert.deepEqual(terminalVerdict({ stderrIsTTY: true, ancestry: DETACHED_PTY }), { human: false, why: "no-positive-root" });
  });

  it("the Claude Code environment is not a person, even over a clean-looking chain", () => {
    assert.deepEqual(terminalVerdict({ stderrIsTTY: true, ancestry: PERSON, env: { CLAUDECODE: "1" } }), {
      human: false,
      why: "agent-ancestor",
      ancestor: "claude",
      via: "env",
    });
  });

  it("a forged login (not uid 0) or an emulator whose real path is untrusted leaves the chain without a root", () => {
    const forgedLogin = (): AncestorInfo[] => [proc(61, 60, "zsh"), proc(60, 1, "login", ["login"], "login", 501)];
    assert.deepEqual(terminalVerdict({ stderrIsTTY: true, ancestry: forgedLogin }), { human: false, why: "no-positive-root" });
    const forgedEmulator = (): AncestorInfo[] => [proc(71, 70, "zsh"), proc(70, 1, "kitty", ["kitty"], "/Applications/ki", 501)];
    assert.deepEqual(
      terminalVerdict({ stderrIsTTY: true, ancestry: forgedEmulator, resolveExe: () => "/Users/me/.nvm/bin/node" }),
      { human: false, why: "no-positive-root" },
    );
    assert.equal(terminalVerdict({ stderrIsTTY: true, ancestry: forgedEmulator, resolveExe: () => null }).human, false);
    assert.equal(
      terminalVerdict({ stderrIsTTY: true, ancestry: forgedEmulator, resolveExe: () => "/Applications/kitty.app/Contents/MacOS/kitty" }).human,
      true,
    );
  });

  it("a tmux server is a root only with an attached client", () => {
    const tmux = (): AncestorInfo[] => [proc(51, 50, "zsh"), proc(50, 1, "tmux", ["tmux: server"], "/opt/homebrew/bin")];
    assert.equal(isHumanTerminal({ stderrIsTTY: true, ancestry: tmux, probe: () => true }), true);
    assert.deepEqual(terminalVerdict({ stderrIsTTY: true, ancestry: tmux, probe: () => false }), {
      human: false,
      why: "no-positive-root",
    });
  });

  it("an undeterminable ancestry is NOT a person (fail closed for approve and owner adds)", () => {
    assert.deepEqual(terminalVerdict({ stderrIsTTY: true, ancestry: UNREADABLE }), {
      human: false,
      why: "ancestry-undeterminable",
    });
  });

  it("M1: an agent found before an unreadable hop is reported as the agent", () => {
    const v = terminalVerdict({
      stderrIsTTY: true,
      ancestry: () => ({ ancestors: [proc(5, 4, "zsh"), proc(4, 3, "claude")], complete: false }),
    });
    assert.deepEqual(v, { human: false, why: "agent-ancestor", ancestor: "claude" });
  });

  it("a reader that throws is undeterminable", () => {
    const v = terminalVerdict({
      stderrIsTTY: true,
      ancestry: () => {
        throw new Error("boom");
      },
    });
    assert.deepEqual(v, { human: false, why: "ancestry-undeterminable" });
  });

  it("no TTY is not a person and the ancestry is never read", () => {
    let read = 0;
    const v = terminalVerdict({ stderrIsTTY: false, ancestry: () => (read++, PERSON()) });
    assert.deepEqual(v, { human: false, why: "no-tty" });
    assert.equal(read, 0);
  });

  it("an injected stderrIsTTY alone is the labelled test-only answer (the existing seam keeps working)", () => {
    assert.equal(isHumanTerminal({ stderrIsTTY: true }), true);
    assert.equal(isHumanTerminal({ stderrIsTTY: false }), false);
  });
});

describe("requireTerminal", () => {
  const run = (opts: Parameters<typeof requireTerminal>[2]) =>
    withEnv("REPO_AEGIS_EGRESS_HUMAN", "1", () =>
      captureOutput(() => requireTerminal("X_NEEDS_TTY", "do it yourself", { json: true, ...opts })),
    );

  it("passes for a real TTY with a person's chain", () => {
    const r = run({ stderrIsTTY: true, ancestry: PERSON });
    assert.equal(r.exitCode, undefined);
    assert.equal(r.stderr, "");
  });

  it("refuses a TTY under claude, with a sentence saying why (and the env escape does not help)", () => {
    const r = run({ stderrIsTTY: true, ancestry: UNDER_CLAUDE });
    assert.equal(r.exitCode, 2);
    const body = JSON.parse(r.stderr) as { code: string; error: string };
    assert.equal(body.code, "X_NEEDS_TTY");
    assert.match(body.error, /^do it yourself/);
    assert.match(body.error, /runs under claude, an agent host or terminal wrapper/);
    assert.match(body.error, /Run this in your own terminal window/);
  });

  it("4: the CLAUDECODE=1 refusal names the tmux-inherits-it case and the way out", () => {
    const r = run({ stderrIsTTY: true, ancestry: PERSON, env: { CLAUDECODE: "1" } });
    assert.equal(r.exitCode, 2);
    const { error } = JSON.parse(r.stderr) as { error: string };
    assert.match(error, /CLAUDECODE=1 or CLAUDE_CODE_ENTRYPOINT is set/);
    assert.match(error, /tmux server or a shell was started from inside Claude Code/);
    assert.match(error, /open a fresh terminal window/);
  });

  it("refuses a chain with no positive root and says why", () => {
    const r = run({ stderrIsTTY: true, ancestry: DETACHED_PTY });
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr, /ends at the system's init process without passing through a login session/);
  });

  it("refuses when the ancestry cannot be read, saying so", () => {
    const r = run({ stderrIsTTY: true, ancestry: UNREADABLE });
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr, /could not read the process list/);
  });

  it("the no-TTY message is unchanged", () => {
    const r = run({ stderrIsTTY: false });
    assert.deepEqual(JSON.parse(r.stderr), { code: "X_NEEDS_TTY", error: "do it yourself" });
  });
});

describe("the default (process-level) path reads the process chain", () => {
  type Reader = () => AncestorInfo[] | readonly AncestorInfo[] | null;
  const underTty = <T>(reader: Reader, fn: () => T): T =>
    withStreamTty("stderr", true, () => {
      setAncestryReaderForTests(reader);
      try {
        return fn();
      } finally {
        setAncestryReaderForTests(() => PERSON_ANCESTRY);
      }
    });

  const REFUSED: ReadonlyArray<readonly [string, Reader]> = [
    ["claude", UNDER_CLAUDE],
    ["script", UNDER_SCRIPT],
    ["a detached pty", DETACHED_PTY],
    ["unreadable", UNREADABLE],
  ];

  it("approve: a person's terminal mints; claude, a pty wrapper, a detached pty or an unreadable chain refuse and mint nothing", () => {
    const env = setupHome("approve-default");
    const attempt = (reader: Reader) =>
      underTty(reader, () =>
        withEnv("REPO_AEGIS_HOME", env.home, () =>
          captureOutput(() => approve("home-handle/svc", { path: env.approvalsPath, json: true, registryPath: env.registryPath })),
        ),
      );
    for (const [label, reader] of REFUSED) {
      const r = attempt(reader);
      assert.equal(r.exitCode, 2, label);
      assert.match(r.stderr, /APPROVE_NEEDS_TTY/, label);
      assert.deepEqual(listApprovals(env.approvalsPath, new Date()), [], `${label}: nothing minted`);
    }
    const ok = attempt(PERSON);
    assert.equal(ok.exitCode, undefined, ok.stderr);
    assert.equal(listApprovals(env.approvalsPath, new Date()).length, 1);
  });

  it("engagements add --personal-org: refused for every non-person chain, registry byte-identical; allowed for a person", () => {
    const env = setupHome("owner-default");
    const before = readFileSync(env.registryPath);
    const attempt = (reader: Reader) =>
      underTty(reader, () =>
        withEnv("REPO_AEGIS_HOME", env.home, () =>
          captureOutput(() => engagementsAdd(undefined, { personalOrg: ["new-handle"], registryPath: env.registryPath, json: true })),
        ),
      );
    for (const [label, reader] of REFUSED) {
      const r = attempt(reader);
      assert.equal(r.exitCode, 2, label);
      assert.match(r.stderr, /OWNER_ADD_NEEDS_TTY/);
      assert.deepEqual(readFileSync(env.registryPath), before);
    }
    assert.equal(attempt(PERSON).exitCode, undefined);
    assert.ok(loadRegistry(env.registryPath).personalOrgs?.includes("new-handle"));
  });

  it("upstreams add: refused under claude and for a detached pty; allowed for a person", () => {
    const env = setupHome("upstream-default");
    const before = readFileSync(env.registryPath);
    const attempt = (reader: Reader) =>
      underTty(reader, () =>
        withEnv("REPO_AEGIS_HOME", env.home, () =>
          captureOutput(() => upstreamsAdd("up-org/lib", { registryPath: env.registryPath, json: true })),
        ),
      );
    assert.equal(attempt(UNDER_CLAUDE).exitCode, 2);
    assert.equal(attempt(DETACHED_PTY).exitCode, 2);
    assert.deepEqual(readFileSync(env.registryPath), before);
    assert.equal(attempt(PERSON).exitCode, undefined);
  });

  it("registry-mutate (emptying the owner set): refused under claude; allowed for a person", () => {
    const env = setupHome("empty-default", LAST_OWNER);
    const before = readFileSync(env.registryPath);
    const attempt = (reader: Reader) =>
      underTty(reader, () =>
        withEnv("REPO_AEGIS_HOME", env.home, () =>
          captureOutput(() => engagementsRemove("only-customer", { registryPath: env.registryPath, hard: true, json: true })),
        ),
      );
    const refused = attempt(UNDER_CLAUDE);
    assert.equal(refused.exitCode, 2);
    assert.match(refused.stderr, /OWNER_SET_EMPTY_NEEDS_TTY/);
    assert.deepEqual(readFileSync(env.registryPath), before);
    assert.equal(attempt(PERSON).exitCode, undefined);
  });

  it("init --migrate-classify: refused under claude (registry untouched); allowed for a person", async () => {
    const home = join(tmp, "init-default");
    mkdirSync(home, { recursive: true });
    await withEnvAsync("REPO_AEGIS_HOME", home, () => captureOutputAsync(() => init({ withHooks: false, withClaude: false })));
    writeFileSync(join(home, "classify.yml"), `rules:\n  - match: "github\\\\.com[:/]zzq-anc-org/"\n    class: public-eligible\n`);
    const regPath = join(home, "engagements.yaml");
    const before = readFileSync(regPath);
    const run = (reader: Reader) =>
      withStreamTtyAsync("stderr", true, () =>
        withStreamTtyAsync("stdin", true, () => {
          setAncestryReaderForTests(reader);
          return withEnvAsync("REPO_AEGIS_HOME", home, () =>
            captureOutputAsync(() => init({ withHooks: false, withClaude: false, migrateClassify: true, readAnswer: () => "y", json: true })),
          );
        }),
      );
    const refused = await run(UNDER_CLAUDE);
    assert.equal(refused.exitCode, 2);
    assert.match(refused.stderr, /OWNER_ADD_NEEDS_TTY/);
    assert.deepEqual(readFileSync(regPath), before);
    const ok = await run(PERSON);
    assert.equal(ok.exitCode, undefined, ok.stderr);
  });
});

describe("currentHumanPresent (rules g/h)", () => {
  const present = (reader: () => readonly AncestorInfo[] | null, tty = true) => {
    let value = false;
    const out = withStreamTty("stderr", tty, () => {
      setAncestryReaderForTests(reader);
      try {
        return captureOutput(() => {
          value = withEnv("REPO_AEGIS_EGRESS_HUMAN", undefined, () => currentHumanPresent());
        });
      } finally {
        setAncestryReaderForTests(() => PERSON_ANCESTRY);
      }
    });
    return { value, stderr: out.stderr };
  };

  it("a person's terminal is present; silent", () => {
    assert.deepEqual(present(PERSON), { value: true, stderr: "" });
  });

  it("a claude ancestor is not present", () => {
    assert.equal(present(UNDER_CLAUDE).value, false);
  });

  it("an unreadable chain keeps the TTY result and reports it on stderr", () => {
    const r = present(UNREADABLE);
    assert.equal(r.value, true);
    assert.equal(r.stderr.trim(), ANCESTRY_UNDETERMINABLE_NOTE);
  });

  it("an unrooted (detached) chain keeps the TTY result and reports it on stderr", () => {
    const r = present(DETACHED_PTY);
    assert.equal(r.value, true);
    assert.equal(r.stderr.trim(), ANCESTRY_UNDETERMINABLE_NOTE);
  });

  it("no TTY is not present and nothing is printed", () => {
    assert.deepEqual(present(UNREADABLE, false), { value: false, stderr: "" });
  });
});

describe("readLine (the [y/N] answer)", () => {
  /** A reader that serves `steps` in order: an errno code throws, a string yields its bytes one per call. */
  const reader = (steps: readonly string[]) => {
    const queue = steps.flatMap(s => (s === "EAGAIN" || s === "EIO" ? [s] : [...s]));
    return (buf: Buffer): number => {
      const next = queue.shift();
      if (next === undefined) return 0;
      if (next === "EAGAIN" || next === "EIO") throw Object.assign(new Error(next), { code: next });
      buf.write(next);
      return 1;
    };
  };

  it("waits through EAGAIN (a non-blocking terminal before the person types) and reads the answer", () => {
    assert.equal(readLine(reader(["EAGAIN", "EAGAIN", "y\n"])), "y");
  });

  it("stops at the newline and treats any other read error as no answer", () => {
    assert.equal(readLine(reader(["yes\nextra"])), "yes");
    assert.equal(readLine(reader(["y", "EIO"])), "");
  });
});
