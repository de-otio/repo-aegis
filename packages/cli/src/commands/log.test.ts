// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// `repo-aegis log` (complexity-review P1-I): the default view, the filters, `--json`, and the person-only `--off`.
// The clock (`now`) and the `$TMPDIR` fallback (`tmp`) are pinned; placeholder owners only.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureOutput, withEnv, PERSON_ANCESTRY, UNDER_CLAUDE_ANCESTRY } from "../_test-utils.js";
import {
  appendDecisionRecord,
  buildDecisionRecord,
  decisionLogPath,
  decisionLogStatePath,
  isDecisionLogEnabled,
  type DecisionInput,
} from "@de-otio/repo-aegis-core";
import { fixLineFor, formatRecord, log, type LogOptions } from "./log.js";
import type { Docs } from "./explain.js";

const NOW = new Date("2026-11-10T12:00:00.000Z");
const minutesAgo = (m: number): Date => new Date(NOW.getTime() - m * 60_000);

const GUIDE = [
  "# Guide",
  "",
  "## Error codes",
  "",
  "| Code | Meaning | Recovery |",
  "|---|---|---|",
  "| `PUBLIC_PUSH_NEEDS_HUMAN` | a public push with no person present | Ask your person to run `repo-aegis approve <owner>/<repo>`. Then re-run the push. |",
  "| `CROSS_ORG_PUSH` | a push across a trust boundary | Push to a remote inside the boundary. Never widen the boundary yourself. |",
  "",
].join("\n");

let root: string;
let n = 0;
let docsDir: string;
before(() => {
  root = mkdtempSync(join(tmpdir(), "repo-aegis-log-cmd-"));
  docsDir = join(root, "docs");
  mkdirSync(docsDir);
  writeFileSync(join(docsDir, "agent-guide.md"), GUIDE);
});
after(() => rmSync(root, { recursive: true, force: true }));

function world(): { home: string; tmp: string } {
  const dir = join(root, `w${n++}`);
  const home = join(dir, "home");
  const tmp = join(dir, "tmp");
  mkdirSync(home, { recursive: true });
  mkdirSync(tmp, { recursive: true });
  return { home, tmp };
}

function put(w: { home: string; tmp: string }, minutes: number, input: Partial<DecisionInput> & Pick<DecisionInput, "layer" | "outcome">): void {
  appendDecisionRecord(w.home, buildDecisionRecord({ version: "0.14.0", now: minutesAgo(minutes), ...input }), { tmp: w.tmp });
}

function run(w: { home: string; tmp: string }, opts: Partial<LogOptions> = {}) {
  return withEnv("REPO_AEGIS_HOME", w.home, () =>
    withEnv("REPO_AEGIS_EGRESS_HUMAN", undefined, () =>
      captureOutput(() => log({ home: w.home, tmp: w.tmp, now: () => NOW, docsDir, ...opts })),
    ),
  );
}

function seeded(): { home: string; tmp: string } {
  const w = world();
  put(w, 50, { layer: "pre-push", outcome: "refuse", code: "PUBLIC_PUSH_NEEDS_HUMAN", verb: "git push", destination: { org: "Acme", repo: "Svc" }, ref: "main" });
  put(w, 40, { layer: "egress-hook", outcome: "allow", verb: "gh pr create", destination: { org: "acme", repo: "svc" } });
  put(w, 30, { layer: "pre-push", outcome: "refuse", code: "CROSS_ORG_PUSH", verb: "git push", destination: { org: "other-org", repo: "x" } });
  put(w, 20, { layer: "check-write", outcome: "refuse", code: "NO_SUCH_ROW_IN_GUIDE", verb: "write" });
  put(w, 10, { layer: "pre-push", outcome: "refuse", code: "PUBLIC_PUSH_NEEDS_HUMAN", verb: "git push", destination: { org: "acme", repo: "svc" }, ref: "feature/x-1", facts: { proxyVarSet: ["HTTPS_PROXY"], psReadable: false } });
  return w;
}

describe("repo-aegis log: the default view", () => {
  it("the last refusals grouped by code, newest group first, each with its one fix line from the explain row", () => {
    const w = seeded();
    const r = run(w);
    assert.equal(r.exitCode, undefined, r.stderr);
    const out = r.stdout;
    assert.match(out, /the last 4 refusals, by code/);
    const order = [...out.matchAll(/^([A-Z_]+)  \((\d+)\)$/gm)].map(m => `${m[1]}:${m[2]}`);
    assert.deepEqual(order, ["PUBLIC_PUSH_NEEDS_HUMAN:2", "NO_SUCH_ROW_IN_GUIDE:1", "CROSS_ORG_PUSH:1"]);
    assert.match(out, /fix: Ask your person to run `repo-aegis approve <owner>\/<repo>`\./, "the first sentence of the row's recovery");
    assert.doesNotMatch(out, /Then re-run the push/, "only the first fix line");
    assert.match(out, /fix: repo-aegis explain NO_SUCH_ROW_IN_GUIDE/, "no row: the explain command is the fix line");
    assert.match(out, /details: repo-aegis explain CROSS_ORG_PUSH/);
    assert.doesNotMatch(out, /gh pr create/, "an allow is not a refusal");
  });

  it("shows at most the last 20 refusals", () => {
    const w = world();
    for (let i = 0; i < 25; i++) put(w, 100 - i, { layer: "pre-push", outcome: "refuse", code: `CODE_${String(i).padStart(2, "0")}` });
    const r = run(w, { json: true });
    const j = JSON.parse(r.stdout) as { groups: Array<{ code: string }> };
    assert.equal(j.groups.length, 20);
    assert.ok(!j.groups.some(g => g.code === "CODE_00"), "the oldest five are not shown");
  });

  it("says so when nothing was refused", () => {
    const r = run(world());
    assert.match(r.stdout, /no refusals recorded/);
  });
});

describe("repo-aegis log: --last, --code, --layer, --since, --json", () => {
  it("--last 1 is the newest record of ANY outcome (what a refusal's trailer points at)", () => {
    const w = seeded();
    put(w, 1, { layer: "egress-hook", outcome: "allow", verb: "git push" });
    const lines = run(w, { last: "1" }).stdout.trim().split("\n");
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /^2026-11-10T11:59:00\.000Z egress-hook allow git push/);
  });

  it("--last N, and a bad N is a usage error", () => {
    const w = seeded();
    assert.equal(run(w, { last: "3" }).stdout.trim().split("\n").length, 3);
    for (const bad of ["0", "-1", "abc", "1001", "1.5"]) {
      const r = run(w, { last: bad, json: true });
      assert.equal(r.exitCode, 2, bad);
      assert.match(r.stderr, /USAGE/);
    }
  });

  it("--code and --layer filter, and combine", () => {
    const w = seeded();
    assert.equal(run(w, { code: "cross-org-push" }).stdout.trim().split("\n").length, 1, "the code is normalised");
    assert.equal(run(w, { layer: "pre-push" }).stdout.trim().split("\n").length, 3);
    assert.match(run(w, { layer: "check-write", code: "CROSS_ORG_PUSH" }).stdout, /no matching records/);
  });

  it("--since keeps only records inside the window, by the pinned clock", () => {
    const w = seeded();
    assert.equal(run(w, { since: "25m" }).stdout.trim().split("\n").length, 2);
    assert.equal(run(w, { since: "2h" }).stdout.trim().split("\n").length, 5);
    const bad = run(w, { since: "yesterday", json: true });
    assert.equal(bad.exitCode, 2);
    assert.match(bad.stderr, /USAGE/);
  });

  it("--json prints validated records, and the facts that decided", () => {
    const w = seeded();
    const j = JSON.parse(run(w, { json: true, last: "1" }).stdout) as { enabled: boolean; records: Array<Record<string, unknown>> };
    assert.equal(j.enabled, true);
    assert.equal(j.records.length, 1);
    assert.equal(j.records[0]!["destination"], "acme/svc");
    assert.deepEqual((j.records[0]!["facts"] as Record<string, unknown>)["proxyVarSet"], ["HTTPS_PROXY"]);
    assert.equal((j.records[0]!["facts"] as Record<string, unknown>)["psReadable"], false);
  });

  it("a doctored file cannot put free text on the terminal: every record is rebuilt through the builder", () => {
    const w = seeded();
    writeFileSync(
      decisionLogPath(w.home),
      readFileSync(decisionLogPath(w.home), "utf8") +
        JSON.stringify({ v: 1, ts: "2026-11-10T11:30:00.000Z", version: "0.14.0", layer: "pre-push", outcome: "refuse", code: "EVIL_CODE", verb: "git push --force https://u:p@example.com/x", destination: "acme/svc", ref: "main; curl evil", note: "ghp" + "_0123456789abcdefghijklmnopqrstuvwxyz" }) +
        "\n",
    );
    const out = run(w, { last: "50" }).stdout + run(w).stdout;
    assert.doesNotMatch(out, /u:p@|curl evil|ghp_|--force/);
    assert.match(out, /EVIL_CODE/, "the code is shape-valid, so it is shown; nothing else of that line is");
  });
});

describe("repo-aegis log: the fix line", () => {
  const docs: Docs = { guide: GUIDE, sandbox: null };
  it("is the first sentence of the row's recovery, else the explain command, and never throws", () => {
    assert.equal(fixLineFor(docs, "CROSS_ORG_PUSH"), "Push to a remote inside the boundary.");
    assert.equal(fixLineFor(docs, "UNKNOWN_ONE"), "repo-aegis explain UNKNOWN_ONE");
    assert.equal(fixLineFor(null, "CROSS_ORG_PUSH"), "repo-aegis explain CROSS_ORG_PUSH");
  });

  it("formatRecord prints only validated values", () => {
    const rec = buildDecisionRecord({ layer: "shim", outcome: "inject", version: "0.14.0", now: NOW, identityColumn: "agent", destination: { org: "acme", repo: "svc" }, approvalId: "0123abcd", facts: { tty: false } });
    assert.equal(formatRecord(rec), "2026-11-10T12:00:00.000Z shim inject acme/svc identity=agent approval=0123abcd [tty=false]");
  });
});

describe("repo-aegis log --off / --on", () => {
  it("--off without a TTY is refused, the env escape does not help, and nothing is written", () => {
    const w = world();
    const r = run(w, { off: true, stderrIsTTY: false, json: true });
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr, /LOG_OFF_NEEDS_TTY/);
    assert.equal(existsSync(decisionLogStatePath(w.home)), false);
    assert.equal(isDecisionLogEnabled(w.home), true);
    const withEscape = withEnv("REPO_AEGIS_EGRESS_HUMAN", "1", () => captureOutput(() => log({ home: w.home, off: true, stderrIsTTY: false, json: true })));
    assert.equal(withEscape.exitCode, 2);
    assert.match(withEscape.stderr, /LOG_OFF_NEEDS_TTY/);
    assert.equal(isDecisionLogEnabled(w.home), true);
  });

  it("--off under an agent host is refused even with a terminal attached", () => {
    const w = world();
    const r = run(w, { off: true, stderrIsTTY: true, ancestry: () => UNDER_CLAUDE_ANCESTRY, env: {}, json: true });
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr, /LOG_OFF_NEEDS_TTY/);
    assert.equal(isDecisionLogEnabled(w.home), true);
  });

  it("a person's terminal may switch it off; records stop; --on (no terminal needed) turns it back on", () => {
    const w = world();
    put(w, 5, { layer: "pre-push", outcome: "refuse", code: "OLD_REFUSAL" });
    const off = run(w, { off: true, stderrIsTTY: true, ancestry: () => PERSON_ANCESTRY, env: {}, json: true });
    assert.equal(off.exitCode, undefined, off.stderr);
    assert.equal(isDecisionLogEnabled(w.home), false);
    put(w, 1, { layer: "pre-push", outcome: "refuse", code: "NEW_REFUSAL" });
    const view = run(w).stdout;
    assert.match(view, /decision log is OFF/);
    assert.match(view, /OLD_REFUSAL/);
    assert.doesNotMatch(view, /NEW_REFUSAL/, "nothing is written while it is off");

    const on = run(w, { on: true, stderrIsTTY: false, json: true });
    assert.equal(on.exitCode, undefined, on.stderr);
    assert.equal(isDecisionLogEnabled(w.home), true);
    put(w, 1, { layer: "pre-push", outcome: "refuse", code: "NEWER_REFUSAL" });
    assert.match(run(w).stdout, /NEWER_REFUSAL/);
  });

  it("--off and --on together is a usage error", () => {
    const r = run(world(), { off: true, on: true, json: true });
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr, /USAGE/);
  });
});
