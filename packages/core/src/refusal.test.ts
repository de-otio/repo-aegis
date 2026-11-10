// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { refusalTrailer, refusal, safeDestination } from "./refusal.js";
import { refusalGuideLine, repoAegisVersion } from "./refusal-guide.js";

describe("safeDestination", () => {
  it("accepts GitHub names, lower-cased", () => {
    assert.deepEqual(safeDestination("Acme-1", "Foo.js_x"), { org: "acme-1", repo: "foo.js_x" });
    assert.deepEqual(safeDestination("acme", "*"), { org: "acme", repo: "*" });
    assert.deepEqual(safeDestination("a".repeat(39), "r".repeat(100)), { org: "a".repeat(39), repo: "r".repeat(100) });
  });

  it("rejects what could be shell syntax, a line break, a non-ASCII look-alike or an over-long name", () => {
    for (const bad of ["x$(id)", "x`id`", "x;y", "x y", "x\ny", "x\ry", "x'y", 'x"y', "x|y", "x&y", "x/y", "", "-x", "a".repeat(40)]) {
      assert.equal(safeDestination(bad, "r"), null, JSON.stringify(bad));
    }
    // U+212A KELVIN SIGN lower-cases to ASCII `k`: the check must run BEFORE lower-casing.
    assert.equal("K".toLowerCase(), "k");
    assert.equal(safeDestination("Kelvin", "r"), null);
    assert.equal(safeDestination("аcme", "r"), null); // Cyrillic a
    for (const bad of ["r$(id)", "r y", "r\n", "", ".", "..", "r/s", "r".repeat(101), "K"]) {
      assert.equal(safeDestination("acme", bad), null, JSON.stringify(bad));
    }
  });
});

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
        `${refusalGuideLine("SOME_CODE")} ` +
        "[SOME_CODE; details: repo-aegis explain SOME_CODE]",
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

  it("a person's `step` renders as prose, not as a command", () => {
    const text = refusal({
      ...base,
      fixes: [{ by: "person", when: "If it is damaged", step: "repairs the file (`repo-aegis status` says why)" }],
    });
    assert.match(text, /If it is damaged, a person repairs the file \(`repo-aegis status` says why\)\./);
    assert.match(text, /Agents: do not run that yourself/);
  });

  it("an unsafe destination discards what, why and every fix: the name and any command never appear", () => {
    const text = refusal({
      ...base,
      destination: { verb: "gh issue create", org: "x$(id)", repo: "r" },
      what: "gh issue create → x$(id)/r",
      fixes: [{ by: "person", command: "repo-aegis engagements add --personal-org x$(id)" }],
    });
    assert.ok(text.startsWith("gh issue create: refused. The destination name is not a valid GitHub owner/repo"), text);
    assert.ok(!text.includes("$(id)") && !text.includes("engagements add"), text);
    assert.match(text, /\[SOME_CODE; details: repo-aegis explain SOME_CODE\]$/);
  });

  it("a safe destination leaves the message as built", () => {
    const text = refusal({
      ...base,
      destination: { verb: "gh issue create", org: "acme", repo: "svc" },
      fixes: [{ by: "agent", command: "x" }],
    });
    assert.match(text, /^gh issue create → owner\/repo: refused\./);
  });

  it("refusalTrailer names the code first and the command that explains it", () => {
    const t = refusalTrailer("UNREGISTERED_OWNER_EGRESS");
    assert.ok(t.endsWith("[UNREGISTERED_OWNER_EGRESS; details: repo-aegis explain UNREGISTERED_OWNER_EGRESS]"), t);
    assert.ok(t.startsWith(`repo-aegis ${repoAegisVersion()}. Next step: `), t);
    assert.match(t, /Only a person can run it: yes\. \[/);
    // an agent-fixable code says no
    assert.match(refusalTrailer("PUSH_IMPLICIT_TARGET"), /Only a person can run it: no\. \[PUSH_IMPLICIT_TARGET;/);
  });
});
