// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// The human-presence gate's ancestry check (issue #151, PR 2b): a TTY is not
// enough. If an agent host or a pty wrapper sits above the process, the
// terminal is not a person's; if the process chain cannot be read, `approve`
// and the owner adds refuse (fail closed). Rules g/h make the opposite choice
// for an unreadable chain; that is covered in core/process-ancestry.test.ts.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listApprovals, loadRegistry, setAncestryReaderForTests, type AncestorInfo } from "@de-otio/repo-aegis-core";
import { captureOutput, withEnv, withStreamTty } from "./_test-utils.js";
import { isHumanTerminal, requireTerminal, terminalVerdict } from "./require-terminal.js";
import { ANCESTRY_UNDETERMINABLE_NOTE, currentHumanPresent } from "./human-presence.js";
import { approve } from "./commands/approve.js";
import { engagementsAdd } from "./commands/engagements-mutate.js";
import { upstreamsAdd } from "./commands/upstreams.js";

function proc(pid: number, ppid: number, comm: string, argv: string[] = [comm]): AncestorInfo {
  return { pid, ppid, comm, argv };
}

/** What `ps` shows for a person's own terminal, and for a Claude Code session (names only). */
const PERSON = (): AncestorInfo[] => [proc(4, 3, "-zsh"), proc(3, 2, "login"), proc(2, 1, "Terminal")];
const UNDER_CLAUDE = (): AncestorInfo[] => [proc(5, 4, "/bin/zsh"), proc(4, 3, "claude"), proc(3, 2, "-zsh"), proc(2, 1, "login")];
const UNDER_SCRIPT = (): AncestorInfo[] => [proc(4, 3, "zsh"), proc(3, 2, "script"), proc(2, 1, "-zsh")];
const UNREADABLE = (): null => null;

let tmp: string;
before(() => {
  tmp = mkdtempSync(join(tmpdir(), "repo-aegis-require-terminal-"));
});
after(() => rmSync(tmp, { recursive: true, force: true }));

const REGISTRY = "schemaVersion: 2\nalways_block: []\npersonalOrgs:\n  - home-handle\nengagements: []\n";

function setupHome(name: string): { home: string; registryPath: string; approvalsPath: string } {
  const home = join(tmp, name);
  mkdirSync(join(home, "markers"), { recursive: true });
  mkdirSync(join(home, "state"), { recursive: true });
  const registryPath = join(home, "engagements.yaml");
  writeFileSync(registryPath, REGISTRY);
  return { home, registryPath, approvalsPath: join(home, "approvals.json") };
}

describe("terminalVerdict / isHumanTerminal", () => {
  it("a real TTY with no agent ancestor is a person", () => {
    assert.deepEqual(terminalVerdict({ stderrIsTTY: true, ancestry: PERSON }), { human: true });
    assert.equal(isHumanTerminal({ stderrIsTTY: true, ancestry: PERSON }), true);
  });

  it("a TTY under claude is not a person, and names the ancestor", () => {
    assert.deepEqual(terminalVerdict({ stderrIsTTY: true, ancestry: UNDER_CLAUDE }), {
      human: false,
      why: "agent-ancestor",
      ancestor: "claude",
    });
  });

  it("a TTY under a pty wrapper is not a person", () => {
    const v = terminalVerdict({ stderrIsTTY: true, ancestry: UNDER_SCRIPT });
    assert.deepEqual(v, { human: false, why: "agent-ancestor", ancestor: "script" });
  });

  it("an undeterminable ancestry is NOT a person (fail closed for approve and owner adds)", () => {
    assert.deepEqual(terminalVerdict({ stderrIsTTY: true, ancestry: UNREADABLE }), {
      human: false,
      why: "ancestry-undeterminable",
    });
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

  it("an injected stderrIsTTY alone is the whole answer (the existing seam keeps working)", () => {
    assert.equal(isHumanTerminal({ stderrIsTTY: true }), true);
    assert.equal(isHumanTerminal({ stderrIsTTY: false }), false);
  });
});

describe("requireTerminal", () => {
  const run = (opts: Parameters<typeof requireTerminal>[2]) =>
    withEnv("REPO_AEGIS_EGRESS_HUMAN", "1", () =>
      captureOutput(() => requireTerminal("X_NEEDS_TTY", "do it yourself", { json: true, ...opts })),
    );

  it("passes for a real TTY with no agent ancestor", () => {
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

describe("the default (process-level) path reads the real ancestry reader", () => {
  const underTty = <T>(reader: () => AncestorInfo[] | null, fn: () => T): T =>
    withStreamTty("stderr", true, () => {
      setAncestryReaderForTests(reader);
      try {
        return fn();
      } finally {
        setAncestryReaderForTests(() => []);
      }
    });

  it("approve: a person's terminal mints; a claude ancestor, a pty wrapper or an unreadable chain refuse and mint nothing", () => {
    const env = setupHome("approve-default");
    const attempt = (reader: () => AncestorInfo[] | null) =>
      underTty(reader, () =>
        withEnv("REPO_AEGIS_HOME", env.home, () =>
          captureOutput(() => approve("home-handle/svc", { path: env.approvalsPath, json: true, registryPath: env.registryPath })),
        ),
      );
    for (const [label, reader] of [
      ["claude", UNDER_CLAUDE],
      ["script", UNDER_SCRIPT],
      ["unreadable", UNREADABLE],
    ] as const) {
      const r = attempt(reader);
      assert.equal(r.exitCode, 2, label);
      assert.match(r.stderr, /APPROVE_NEEDS_TTY/, label);
      assert.deepEqual(listApprovals(env.approvalsPath, new Date()), [], `${label}: nothing minted`);
    }
    const ok = attempt(PERSON);
    assert.equal(ok.exitCode, undefined, ok.stderr);
    assert.equal(listApprovals(env.approvalsPath, new Date()).length, 1);
  });

  it("engagements add --personal-org: refused under claude, registry byte-identical; allowed for a person", () => {
    const env = setupHome("owner-default");
    const before = readFileSync(env.registryPath);
    const attempt = (reader: () => AncestorInfo[] | null) =>
      underTty(reader, () =>
        withEnv("REPO_AEGIS_HOME", env.home, () =>
          captureOutput(() => engagementsAdd(undefined, { personalOrg: ["new-handle"], registryPath: env.registryPath, json: true })),
        ),
      );
    for (const reader of [UNDER_CLAUDE, UNDER_SCRIPT, UNREADABLE]) {
      const r = attempt(reader);
      assert.equal(r.exitCode, 2);
      assert.match(r.stderr, /OWNER_ADD_NEEDS_TTY/);
      assert.deepEqual(readFileSync(env.registryPath), before);
    }
    assert.equal(attempt(PERSON).exitCode, undefined);
    assert.ok(loadRegistry(env.registryPath).personalOrgs?.includes("new-handle"));
  });

  it("upstreams add: refused under claude; allowed for a person", () => {
    const env = setupHome("upstream-default");
    const before = readFileSync(env.registryPath);
    const attempt = (reader: () => AncestorInfo[] | null) =>
      underTty(reader, () =>
        withEnv("REPO_AEGIS_HOME", env.home, () =>
          captureOutput(() => upstreamsAdd("up-org/lib", { registryPath: env.registryPath, json: true })),
        ),
      );
    assert.equal(attempt(UNDER_CLAUDE).exitCode, 2);
    assert.deepEqual(readFileSync(env.registryPath), before);
    assert.equal(attempt(PERSON).exitCode, undefined);
  });
});

describe("currentHumanPresent (rules g/h)", () => {
  const present = (reader: () => AncestorInfo[] | null, tty = true) => {
    let value = false;
    const out = withStreamTty("stderr", tty, () => {
      setAncestryReaderForTests(reader);
      try {
        return captureOutput(() => {
          value = withEnv("REPO_AEGIS_EGRESS_HUMAN", undefined, () => currentHumanPresent());
        });
      } finally {
        setAncestryReaderForTests(() => []);
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

  it("no TTY is not present and nothing is printed", () => {
    assert.deepEqual(present(UNREADABLE, false), { value: false, stderr: "" });
  });
});
