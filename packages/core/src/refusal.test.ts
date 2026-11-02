// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { agentGuideAnchor, refusal } from "./refusal.js";

describe("refusal", () => {
  const base = {
    code: "SOME_CODE",
    what: "gh issue create → owner/repo",
    why: "The owner is not registered",
    approval: "No approval covers this",
  } as const;

  it("builds what, why, approval, fixes, code, in that order", () => {
    const text = refusal({
      ...base,
      fixes: [{ by: "person", when: "If it is yours", command: "do-a-thing --x", note: "or --y" }],
    });
    assert.equal(
      text,
      "gh issue create → owner/repo: refused. The owner is not registered. No approval covers this. " +
        "If it is yours, a person runs, from a terminal: do-a-thing --x (or --y). " +
        "Agents: do not run that yourself, retry or reroute; report this to your human. " +
        "[SOME_CODE, see doc/agent-guide.md#some_code]",
    );
  });

  it("an agent re-issue is marked as such and adds no 'do not run that yourself' trailer", () => {
    const text = refusal({ ...base, fixes: [{ by: "agent", command: "gh pr create --repo o/r" }] });
    assert.match(text, /Re-issue as: gh pr create --repo o\/r\./);
    assert.ok(!text.includes("Agents: do not"));
  });

  it("a person's step without a command means 'run the original command yourself'", () => {
    const text = refusal({ ...base, fixes: [{ by: "person" }] });
    assert.match(text, /A person runs the original command, from a terminal\./);
  });

  it("does not double a sentence's full stop", () => {
    const text = refusal({ ...base, why: "Because.", approval: "No approval covers this.", fixes: [] });
    assert.ok(!text.includes(".."), text);
  });

  it("agentGuideAnchor lower-cases the code", () => {
    assert.equal(agentGuideAnchor("UNREGISTERED_OWNER_EGRESS"), "doc/agent-guide.md#unregistered_owner_egress");
  });
});
