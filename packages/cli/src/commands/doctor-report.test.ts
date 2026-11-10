// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// X-9: collapsing repeated per-repository findings, the "Fix these first" list, and how findings are built
// from `doctor`'s results. Pure inputs, no repository.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { collapseFindings, collapsedText, failingSummary, fixFirstLines, renderLines, type Finding } from "./doctor-report.js";
import { reportFindings, type DoctorRepoResult } from "./doctor.js";
import type { DoctorCheck } from "./doctor-checks.js";

const dup = (repo: string): Finding => ({
  label: "INFO",
  code: "HOOKS_PATH_LOCAL_DUPLICATE",
  line: `HOOKS_PATH_LOCAL_DUPLICATE — x  [${repo}]`,
  fix: "git config --local --unset core.hooksPath",
  repo,
});

describe("collapseFindings", () => {
  it("14 findings of one code across repositories become one line with the count", () => {
    const findings = Array.from({ length: 14 }, (_, i) => dup(`/r/${i}`));
    const lines = collapseFindings(findings, false);
    assert.equal(lines.length, 1);
    assert.equal(lines[0]!.text, "HOOKS_PATH_LOCAL_DUPLICATE: 14 repositories (repo-aegis doctor --json lists them)");
    assert.equal(lines[0]!.count, 14);
    assert.equal(collapsedText("X", 2), "X: 2 repositories (repo-aegis doctor --json lists them)");
  });

  it("a single finding is left as it is, repository path included", () => {
    const lines = collapseFindings([dup("/r/only")], false);
    assert.equal(lines.length, 1);
    assert.match(lines[0]!.text, /\[\/r\/only\]/);
    assert.equal(lines[0]!.count, 1);
  });

  it("--verbose keeps every item", () => {
    const findings = Array.from({ length: 3 }, (_, i) => dup(`/r/${i}`));
    assert.equal(collapseFindings(findings, true).length, 3);
  });

  it("the same code at different severities does not merge, and machine findings never collapse", () => {
    const warn: Finding = { ...dup("/r/a"), label: "WARN" };
    const machine = (n: number): Finding => ({ label: "WARN", code: "SKIPPED", line: `SKIPPED ${n}` });
    const lines = collapseFindings([dup("/r/b"), dup("/r/c"), warn, machine(1), machine(2)], false);
    assert.deepEqual(
      lines.map(l => `${l.label}:${l.count}`),
      ["WARN:1", "WARN:1", "WARN:1", "INFO:2"],
    );
  });

  it("orders FAIL before WARN, INFO and SKIP", () => {
    const f = (label: Finding["label"]): Finding => ({ label, code: label, line: label });
    const lines = collapseFindings([f("SKIP"), f("INFO"), f("WARN"), f("FAIL")], false);
    assert.deepEqual(lines.map(l => l.label), ["FAIL", "WARN", "INFO", "SKIP"]);
  });

  it("fix lines are printed only with --verbose", () => {
    const lines = collapseFindings([dup("/r/only")], false);
    assert.equal(renderLines(lines, false).some(l => l.includes("fix:")), false);
    assert.equal(renderLines(lines, true).some(l => l.includes("fix: git config --local --unset core.hooksPath")), true);
  });
});

describe("fixFirstLines", () => {
  const fail = (code: string, fix?: string, repo?: string): Finding => ({
    label: "FAIL",
    code,
    line: code,
    ...(fix !== undefined && { fix }),
    ...(repo !== undefined && { repo }),
  });

  it("lists FAILs only, one fix per code", () => {
    const lines = collapseFindings(
      [fail("SHIM_MISSING", "repo-aegis install shim"), { label: "WARN", code: "W", line: "W", fix: "do not list" }, fail("A", "fix a", "/r/1"), fail("A", "fix a", "/r/2")],
      false,
    );
    const out = fixFirstLines(lines);
    assert.equal(out[0], "Fix these first:");
    assert.equal(out.length, 3);
    assert.ok(out.some(l => l.includes("repo-aegis install shim") && l.includes("[SHIM_MISSING]")));
    assert.ok(!out.some(l => l.includes("do not list")));
  });

  it("is empty when nothing fails", () => {
    assert.deepEqual(fixFirstLines(collapseFindings([{ label: "WARN", code: "W", line: "W", fix: "x" }], false)), []);
  });

  it("stays short: at most five entries, then a line with the rest", () => {
    const many = Array.from({ length: 8 }, (_, i) => fail(`C${i}`, `fix ${i}`));
    const out = fixFirstLines(collapseFindings(many, false));
    assert.ok(out.length <= 6, out.join("\n"));
    assert.match(out[out.length - 1]!, /and 4 more failing code\(s\)/);
  });

  it("a collapsed group with differing fixes says each repository has its own", () => {
    const out = fixFirstLines(collapseFindings([fail("ORG", "add org-a", "/r/1"), fail("ORG", "add org-b", "/r/2")], false));
    assert.match(out[1]!, /the other 1 repositories have their own fix/);
  });
});

describe("reportFindings", () => {
  const check = (code: DoctorCheck["code"], severity?: DoctorCheck["severity"]): DoctorCheck => ({
    code,
    ok: false,
    ...(severity !== undefined && { severity }),
    detail: "d",
    fix: "f",
  });
  const result = (wt: string, over: Partial<DoctorRepoResult> = {}): DoctorRepoResult => ({
    workingTree: wt,
    code: "HOOKS_OK",
    ok: true,
    effectivePath: null,
    shadowedRepoHooks: [],
    bypassedRepoHooks: [],
    fix: "",
    fixed: false,
    checks: [],
    ...over,
  });

  it("a hook-healthy repo contributes only its checks; a failing one also its hook state, with a fix", () => {
    const f = reportFindings(
      [],
      [
        result("/r/healthy", { checks: [check("HOOKS_PATH_LOCAL_DUPLICATE", "info")] }),
        result("/r/broken", { ok: false, code: "HOOKS_PATH_UNSET", fix: "repo-aegis install hooks" }),
      ],
      { showWouldFix: false },
    );
    assert.deepEqual(f.map(x => `${x.label} ${x.code}`), ["INFO HOOKS_PATH_LOCAL_DUPLICATE", "FAIL HOOKS_PATH_UNSET"]);
    assert.equal(f[1]!.fix, "repo-aegis install hooks");
  });

  it("a hook-state failure with no stock fix falls back to doctor --fix", () => {
    const f = reportFindings([], [result("/r/b", { bypassedRepoHooks: ["commit-msg"] })], { showWouldFix: true });
    assert.equal(f[0]!.label, "FAIL");
    assert.equal(f[0]!.fix, "repo-aegis doctor --fix --yes");
    assert.match(f[0]!.line, /\[would fix\]/);
    assert.deepEqual(f[0]!.notes, ["repo-local hooks that never run: commit-msg"]);
  });

  it("many repositories with the same hook-state failure collapse like any other code", () => {
    const rs = Array.from({ length: 5 }, (_, i) => result(`/r/${i}`, { ok: false, code: "HOOKS_PATH_UNSET", fix: "repo-aegis install hooks" }));
    const lines = collapseFindings(reportFindings([], rs, { showWouldFix: false }), false);
    assert.equal(lines.length, 1);
    assert.match(lines[0]!.text, /^HOOKS_PATH_UNSET: 5 repositories/);
  });
});

describe("failingSummary: counts the FAIL lines printed, not the repositories inside them", () => {
  const repoFail = (repo: string, code = "HOOKS_PATH_UNSET"): Finding => ({ label: "FAIL", code, line: `${repo} ${code}`, fix: "f", repo });
  const machineFail = (code: string): Finding => ({ label: "FAIL", code, line: code, fix: "f" });

  it("a collapsed per-repository FAIL over 219 repositories counts once and names the total", () => {
    const findings = [machineFail("SHIM_MISSING"), ...Array.from({ length: 219 }, (_, i) => repoFail(`/r/${i}`))];
    const lines = collapseFindings(findings, false);
    assert.equal(lines.filter(l => l.label === "FAIL").length, 2);
    assert.equal(failingSummary(findings, lines), "2 failing (1 machine, 1 across 219 repositories)");
  });

  it("repositories failing for two codes are counted once in the total", () => {
    const findings = [repoFail("/r/1"), repoFail("/r/2"), repoFail("/r/1", "OTHER"), repoFail("/r/2", "OTHER")];
    assert.equal(failingSummary(findings, collapseFindings(findings, false)), "2 failing (2 across 2 repositories)");
  });

  it("one repository reads in the singular; nothing failing has no parenthesis; warnings are not counted", () => {
    const one = [repoFail("/r/only")];
    assert.equal(failingSummary(one, collapseFindings(one, false)), "1 failing (1 across 1 repository)");
    const warn: Finding[] = [{ label: "WARN", code: "W", line: "W", repo: "/r/1" }];
    assert.equal(failingSummary(warn, collapseFindings(warn, false)), "0 failing");
  });
});

describe("collapseFindings: SKIPs that share a reason", () => {
  const skip = (code: string, account: string | undefined, reason: string): Finding => ({
    label: "SKIP",
    code,
    line: `${code} — skipped: ${reason}`,
    skip: { key: `${account ?? ""}\u0000${reason}`, ...(account !== undefined && { subject: `gh account ${account}` }), reason },
  });
  const why = "reading another account's token needs a y/N at a terminal (run doctor from your terminal to check it)";

  it("two codes skipped for the same account and reason become one line", () => {
    const lines = collapseFindings([skip("GH_LOGIN_UNREGISTERED", "bob", why), skip("GH_MEMBER_ORG_UNREGISTERED", "bob", why)], false);
    assert.equal(lines.length, 1);
    assert.equal(lines[0]!.label, "SKIP");
    assert.equal(lines[0]!.text, `2 checks for gh account bob: ${why}`);
  });

  it("a different account or a different reason stays separate; a lone skip keeps its own line; --verbose keeps all", () => {
    const findings = [
      skip("GH_LOGIN_UNREGISTERED", "bob", why),
      skip("GH_MEMBER_ORG_UNREGISTERED", "bob", why),
      skip("GH_LOGIN_UNREGISTERED", "carol", why),
      skip("GH_LOGIN_UNREGISTERED", "dave", "its token is invalid"),
    ];
    const lines = collapseFindings(findings, false);
    assert.equal(lines.length, 3);
    assert.ok(lines.some(l => l.count === 2));
    assert.ok(lines.some(l => l.text.startsWith("GH_LOGIN_UNREGISTERED — skipped: ")));
    assert.equal(collapseFindings(findings, true).length, 4);
  });

  it("skips with no account that share a reason (gh absent) collapse as well", () => {
    const lines = collapseFindings([skip("A", undefined, "`gh` is not installed"), skip("B", undefined, "`gh` is not installed"), skip("C", undefined, "`gh` is not installed")], false);
    assert.equal(lines.length, 1);
    assert.equal(lines[0]!.text, "3 checks: `gh` is not installed");
  });
});

describe("reportFindings: skipped checks carry their reason", () => {
  it("two skips of one account share one collapsed line end to end", () => {
    const skipped = (code: DoctorCheck["code"]): DoctorCheck => ({
      code,
      ok: true,
      skipped: true,
      account: "bob",
      skipReason: "reading another account's token needs a y/N at a terminal",
      detail: "skipped: gh account bob was not checked: reading another account's token needs a y/N at a terminal",
    });
    const lines = collapseFindings(
      reportFindings([skipped("GH_LOGIN_UNREGISTERED"), skipped("GH_MEMBER_ORG_UNREGISTERED")], [], { showWouldFix: false }),
      false,
    );
    assert.deepEqual(renderLines(lines, false), ["  SKIP 2 checks for gh account bob: reading another account's token needs a y/N at a terminal"]);
  });
});
