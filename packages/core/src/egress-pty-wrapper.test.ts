// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// EGRESS_PTY_WRAPPER (issue #151, PR 2b): an egress segment that runs under
// something that hands its child a pty is refused, with no registry and no
// approval able to lift it. A pty reads as "a person" to the shim and the
// pre-push hook, so an agent must not be able to manufacture one.
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

/** Every form the plan names, plus the multiplexer and interpreter shapes. */
const PTY_FORMS: ReadonlyArray<readonly [label: string, command: string, wrapper: RegExp]> = [
  ["script (BSD)", "script -q /dev/null gh issue create --repo acme/svc --title x", /script/],
  ["script (util-linux -c)", "script -qc 'gh issue create --repo acme/svc --title x' /dev/null", /script/],
  ["script under sudo", "sudo script -q /dev/null git push origin main", /script/],
  ["unbuffer", "unbuffer gh issue create --repo acme/svc --title x", /unbuffer/],
  ["expect -c", "expect -c 'spawn gh issue create --repo acme/svc; interact'", /expect/],
  ["faketty", "faketty gh issue create --repo acme/svc --title x", /faketty/],
  ["socat pty", "socat - EXEC:'gh issue create --repo acme/svc',pty", /socat/],
  ["ssh -tt localhost", "ssh -tt localhost gh issue create --repo acme/svc", /ssh -t/],
  ["ssh -t host", "ssh -t localhost 'git push origin main'", /ssh -t/],
  ["tmux new-session", "tmux new-session -d 'gh issue create --repo acme/svc --title x'", /tmux/],
  ["tmux send-keys", "tmux send-keys -t 0 'gh issue create --repo acme/svc' Enter", /tmux/],
  ["screen -dm", "screen -dm gh issue create --repo acme/svc --title x", /screen/],
  ["python pty.spawn", `python3 -c 'import pty; pty.spawn(["gh","issue","create","--repo","acme/svc"])'`, /pty module/],
  ["python -m pty", "python3 -m pty gh issue create --repo acme/svc", /pty module/],
  ["perl IO::Pty", "perl -MIO::Pty -e 'system(q(gh issue create --repo acme/svc))'", /pty module/],
  ["ruby PTY.spawn", `ruby -rpty -e 'PTY.spawn("gh issue create --repo acme/svc")'`, /pty module/],
  ["python heredoc", "python3 <<EOF\nimport pty\npty.spawn(['gh','issue','create','--repo','acme/svc'])\nEOF", /pty module/],
  ["inside bash -c", `bash -c "script -q /dev/null gh issue create --repo acme/svc"`, /script/],
  ["find -exec", "find . -exec script -q /dev/null gh issue create --repo acme/svc \\;", /script/],
  // L1: the alias / function / variable / substitution resolution, and three more wrappers
  ["sshpass", "sshpass -p x gh issue create --repo acme/svc --title x", /sshpass/],
  ["rlwrap", "rlwrap gh issue create --repo acme/svc --title x", /rlwrap/],
  ["zsh zpty", `zsh -c 'zpty p gh issue create --repo acme/svc --title x'`, /zpty/],
  ["alias to script", "alias s=script; s -q /dev/null git push origin main", /script/],
  ["function around script", `s() { script "$@"; }; s -q /dev/null git push origin main`, /script/],
  ["variable holding script", "S=script; $S -q /dev/null git push origin main", /script/],
  ["braced variable", "S=script; ${S} -q /dev/null git push origin main", /script/],
  ["$(which script)", "$(which script) -q /dev/null git push origin main", /script/],
  ["backtick which", "`which unbuffer` gh issue create --repo acme/svc", /unbuffer/],
  ["command script", "command script -q /dev/null git push origin main", /script/],
  ["exec script", "exec script -q /dev/null git push origin main", /script/],
  ["quoted name", `"scr"ipt -q /dev/null git push origin main`, /script/],
  ["backslashed name", "\\script -q /dev/null git push origin main", /script/],
  ["absolute path", "/usr/bin/script -q /dev/null git push origin main", /script/],
  ["copied binary", "cp /usr/bin/script /tmp/s; /tmp/s -q /dev/null git push origin main", /script/],
  ["alias to unbuffer path", "alias u=/usr/bin/unbuffer; u gh issue create --repo acme/svc", /unbuffer/],
  ["alias inside bash -c", `bash -c "alias s=script; s -q /dev/null git push origin main"`, /script/],
];

describe("EGRESS_PTY_WRAPPER — every pty form is refused", () => {
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

describe("EGRESS_PTY_WRAPPER — nothing lifts it", () => {
  const command = "script -q /dev/null gh issue create --repo acme/svc --title x";

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
    const d = decide("script -q /dev/null git push", { humanPresent: true });
    assert.equal(d.action === "deny" && d.code, "EGRESS_PTY_WRAPPER");
  });
});

describe("EGRESS_PTY_WRAPPER — the refusal answers the five questions (§3.9)", () => {
  it("names the verb, says no approval helps, gives the agent re-issue and the person's step, and the code", () => {
    const d = decide("script -q /dev/null gh issue create --repo acme/svc --title x");
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
    const d = decide("script -q /dev/null gh issue create --repo acme/svc --title SECRETTITLE-123");
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
    const intents = parseEgressIntents("gh issue create --repo acme/svc --title a && script -q /dev/null gh issue create --repo acme/svc --title b");
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
