// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// EGRESS_PTY_WRAPPER (issue #151, PR 2b): an egress segment that runs under
// something that hands its child a pty is refused, with no registry and no
// approval able to lift it. A pty reads as "a person" to the shim and the
// pre-push hook, so an agent must not be able to manufacture one.
//
// The word backstop is gone (P1-C): the hook labels a pty only on an intent the parser recognised. A pty
// wrapper whose command word is a variable or a substitution of the wrapper, with a `gh <group>` /
// `git push` after it, is still an (unresolved) intent and still refused. A wrapper the parser does not
// model (`script -q /dev/null gh …`, a multiplexer, `ssh -t`, an interpreter's pty module) yields no
// intent at the hook at all; the pty text rules themselves are removed in P4-A.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { scrubGitEnv } from "./_test-git-env.js";
import { parseEgressIntents } from "./egress-intent.js";
import { decideEgress, SHAPE_RULE_CODES, type DecideEgressOptions, type EgressDecision } from "./egress-policy.js";
import type { Registry } from "./registry.js";
import type { EgressApproval } from "./egress-approval.js";

let restoreGitEnv: () => void;
before(() => {
  restoreGitEnv = scrubGitEnv();
});
after(() => {
  restoreGitEnv();
});

const REGISTRY = {
  engagements: [],
  alwaysBlock: [],
  personalOrgs: ["acme"],
  schemaVersion: 2,
} as unknown as Registry;

const STAR_APPROVAL: EgressApproval = {
  id: "ap-1",
  org: "*",
  repo: "*",
  expiresAt: "2999-01-01T00:00:00.000Z",
  by: "test",
} as unknown as EgressApproval;

function decide(command: string, over: Partial<DecideEgressOptions> = {}): EgressDecision {
  return decideEgress({
    intents: parseEgressIntents(command),
    cwd: "/work/svc",
    registry: REGISTRY,
    registryState: "loaded",
    humanPresent: false,
    capabilities: { ask: true },
    resolveDestination: () => ({
      org: "acme",
      repo: "svc",
      class: "private-strict",
      visibility: "private",
      publicFacing: false,
      classKnown: true,
    }),
    scanPayload: () => 0,
    findApproval: () => STAR_APPROVAL,
    ...over,
  });
}

/** The forms that still yield an intent at the hook (the wrapper is a command word the parser cannot read), so are still refused. */
const PTY_FORMS: ReadonlyArray<readonly [label: string, command: string, wrapper: RegExp]> = [
  ["variable holding script", "S=script; $S -q /dev/null git push origin main", /script/],
  ["braced variable", "S=script; ${S} -q /dev/null git push origin main", /script/],
  ["variable holding unbuffer, gh", "U=unbuffer; $U gh issue create --repo acme/svc --title x", /unbuffer/],
  ["$(which script)", "$(which script) -q /dev/null git push origin main", /script/],
  ["ssh -tt localhost", "ssh -tt localhost gh issue create --repo acme/svc", /ssh -t/],
  ["ssh -t host", "ssh -t localhost 'git push origin main'", /ssh -t/],
  ["backtick which", "`which unbuffer` gh issue create --repo acme/svc", /unbuffer/],
];

/**
 * Pty forms that run gh or git push with the wrapper as the command word (or a runner's argument, or an
 * interpreter's text). The hook no longer reads their text, so they are NOT egress at the hook: the `gh` shim
 * and the pre-push hook judge the call they end up making.
 */
const NOT_RECOGNISED_AT_THE_HOOK: ReadonlyArray<readonly [label: string, command: string]> = [
  ["script (BSD)", "script -q /dev/null gh issue create --repo acme/svc --title x"],
  ["script (util-linux -c)", "script -qc 'gh issue create --repo acme/svc --title x' /dev/null"],
  ["script under sudo", "sudo script -q /dev/null git push origin main"],
  ["unbuffer", "unbuffer gh issue create --repo acme/svc --title x"],
  ["expect -c", "expect -c 'spawn gh issue create --repo acme/svc; interact'"],
  ["faketty", "faketty gh issue create --repo acme/svc --title x"],
  ["socat pty", "socat - EXEC:'gh issue create --repo acme/svc',pty"],
  ["multiplexer, new session", "tmux new-session -d 'gh issue create --repo acme/svc --title x'"],
  ["multiplexer, send-keys", "tmux send-keys -t 0 'gh issue create --repo acme/svc' Enter"],
  ["screen -dm", "screen -dm gh issue create --repo acme/svc --title x"],
  ["python pty.spawn", `python3 -c 'import pty; pty.spawn(["gh","issue","create","--repo","acme/svc"])'`],
  ["python -m pty", "python3 -m pty gh issue create --repo acme/svc"],
  ["perl IO::Pty", "perl -MIO::Pty -e 'system(q(gh issue create --repo acme/svc))'"],
  ["ruby PTY.spawn", `ruby -rpty -e 'PTY.spawn("gh issue create --repo acme/svc")'`],
  ["python heredoc", "python3 <<EOF\nimport pty\npty.spawn(['gh','issue','create','--repo','acme/svc'])\nEOF"],
  ["inside bash -c", `bash -c "script -q /dev/null gh issue create --repo acme/svc"`],
  ["find -exec", "find . -exec script -q /dev/null gh issue create --repo acme/svc \\;"],
  ["sshpass", "sshpass -p x gh issue create --repo acme/svc --title x"],
  ["rlwrap", "rlwrap gh issue create --repo acme/svc --title x"],
  ["zsh zpty", `zsh -c 'zpty p gh issue create --repo acme/svc --title x'`],
  ["command script", "command script -q /dev/null git push origin main"],
  ["exec script", "exec script -q /dev/null git push origin main"],
  ["absolute path", "/usr/bin/script -q /dev/null git push origin main"],
];

describe("EGRESS_PTY_WRAPPER — a pty form that yields an intent is refused", () => {
  for (const [label, command, wrapper] of PTY_FORMS) {
    it(label, () => {
      const d = decide(command);
      assert.equal(d.action, "deny", `expected a deny for: ${command}`);
      if (d.action !== "deny") return;
      assert.equal(d.code, "EGRESS_PTY_WRAPPER");
      assert.match(d.reason, wrapper);
    });
  }
});

describe("EGRESS_PTY_WRAPPER — a pty wrapper the parser does not model is no intent at the hook (P1-C; the shim judges it)", () => {
  for (const [label, command] of NOT_RECOGNISED_AT_THE_HOOK) {
    it(label, () => {
      assert.deepEqual(parseEgressIntents(command), [], command);
      assert.equal(decide(command).action, "allow", command);
    });
  }
});

describe("EGRESS_PTY_WRAPPER — nothing lifts it", () => {
  const command = "S=script; $S -q /dev/null gh issue create --repo acme/svc --title x";

  it("needs no registry (missing, encrypted, unparseable, newer-schema)", () => {
    for (const registryState of ["missing", "encrypted", "unparseable", "newer-schema"] as const) {
      const d = decide(command, { registryState, registry: { ...REGISTRY, personalOrgs: [] } as Registry });
      assert.equal(d.action === "deny" && d.code, "EGRESS_PTY_WRAPPER", registryState);
    }
  });

  it("a live approval (even '*/*') does not lift it, and the finder is never consulted", () => {
    let consulted = 0;
    const d = decide(command, {
      findApproval: () => {
        consulted++;
        return STAR_APPROVAL;
      },
    });
    assert.equal(d.action === "deny" && d.code, "EGRESS_PTY_WRAPPER");
    assert.equal(consulted, 0);
  });

  it("a person being present does not lift it", () => {
    const d = decide(command, { humanPresent: true });
    assert.equal(d.action === "deny" && d.code, "EGRESS_PTY_WRAPPER");
  });

  it("is a shape rule (unconditional)", () => {
    assert.ok(SHAPE_RULE_CODES.has("EGRESS_PTY_WRAPPER"));
  });

  it("fires before any other rule: a bare git push under script is the pty refusal", () => {
    const d = decide("S=script; $S -q /dev/null git push", { humanPresent: true });
    assert.equal(d.action === "deny" && d.code, "EGRESS_PTY_WRAPPER");
  });
});

describe("EGRESS_PTY_WRAPPER — the refusal answers the five questions (§3.9)", () => {
  it("names the verb, says no approval helps, gives the agent re-issue and the person's step, and the code", () => {
    const d = decide("S=script; $S -q /dev/null gh issue create --repo acme/svc --title x");
    assert.equal(d.action, "deny");
    if (d.action !== "deny") return;
    assert.match(d.reason, /refused\./);
    assert.match(d.reason, /gives it a terminal, and repo-aegis treats a terminal as a person/);
    assert.match(d.reason, /No approval covers this/);
    assert.match(d.reason, /Re-issue as: the same command run directly/);
    assert.match(d.reason, /a person runs it, or mints the approval, from their own terminal/);
    assert.match(d.reason, /Agents: do not run that yourself/);
    assert.match(d.reason, /\[EGRESS_PTY_WRAPPER; details: repo-aegis explain EGRESS_PTY_WRAPPER\]/);
  });

  it("never carries the command line (title, repo, payload)", () => {
    const d = decide("S=script; $S -q /dev/null gh issue create --repo acme/svc --title SECRETTITLE-123");
    assert.equal(d.action, "deny");
    if (d.action !== "deny") return;
    assert.doesNotMatch(d.reason, /SECRETTITLE|acme|svc/);
  });
});

describe("EGRESS_PTY_WRAPPER — no false positives", () => {
  const NEGATIVES = [
    "gh issue create --repo acme/svc --title script",
    "gh issue create --repo acme/svc --title tmux --body 'how screen works'",
    "git push origin main",
    "echo script && gh issue create --repo acme/svc",
    "python3 -c 'print(1)' && gh issue create --repo acme/svc",
    "tmux ls && gh issue create --repo acme/svc",
  ];
  for (const command of NEGATIVES) {
    it(command, () => {
      const intents = parseEgressIntents(command);
      assert.ok(intents.length > 0 || !/gh|push/.test(command), "the command has an intent");
      for (const i of intents) assert.equal(i.ptyWrapper, undefined, `${command} → ${i.ptyWrapper}`);
    });
  }

  it("only the wrapped segment of a && chain is flagged", () => {
    const intents = parseEgressIntents("gh issue create --repo acme/svc --title a && S=script; $S -q /dev/null gh issue create --repo acme/svc --title b");
    assert.equal(intents.length, 2);
    assert.equal(intents[0]!.ptyWrapper, undefined);
    assert.equal(intents[1]!.ptyWrapper, "script");
  });

  it("an ordinary non-pty ssh is not flagged", () => {
    for (const i of parseEgressIntents("ssh localhost 'gh issue create --repo acme/svc'")) {
      assert.equal(i.ptyWrapper, undefined);
    }
  });
});
