// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// X-10 refusal lint. A refusal that tells a developer nothing blocks them completely, so every refusal code in
// the source must (1) have an entry in core's REFUSAL_GUIDE (the one next step and the person-only flag the
// shared formatter prints, with the version) and (2) have a row in doc/agent-guide.md's error table, which is
// what `repo-aegis explain <CODE>` prints.
//
// The list of codes is DERIVED from the source (not copied here), so a new refusal code with no table entry or
// no guide row fails this test the day it is added. The scan is regex-based and errs towards including a code.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { REFUSAL_GUIDE, refusalGuideLine, refusalTrailer, repoAegisVersion, withRefusalTrailer } from "@de-otio/repo-aegis-core";
import { errorRows, knownCodes, type Docs } from "./commands/explain.js";

const here = dirname(fileURLToPath(import.meta.url)); // packages/cli/dist
const PACKAGES = resolve(here, "..", "..");
const GUIDE_PATH = resolve(PACKAGES, "..", "doc", "agent-guide.md");

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name === "__fixtures__") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.endsWith(".d.ts")) out.push(p);
  }
}

/** Every non-test TypeScript source file of every package. */
function sourceFiles(): { path: string; text: string }[] {
  const files: string[] = [];
  for (const pkg of readdirSync(PACKAGES)) {
    const src = join(PACKAGES, pkg, "src");
    try {
      if (statSync(src).isDirectory()) walk(src, files);
    } catch {
      /* a package without src */
    }
  }
  return files.map(path => ({ path, text: readFileSync(path, "utf8") }));
}

const CODE = "[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+";
/** Union types named `…Code` that are doctor findings or hook state, not refusals. */
const NOT_REFUSAL_UNIONS = new Set(["DoctorCheckCode", "HookStateCode"]);

/**
 * The refusal codes the source can print, with a file that names each one. Sources of a code:
 *  A. a string-literal union type named `…Code` (EgressCode, IdentityRefusalCode, …);
 *  B. the first argument of `refusalTrailer(` / `withRefusalTrailer(` / `requireTerminal(` / `refuse(`, as a literal
 *     or as a `const NAME = "NAME"` constant;
 *  C. `refusal({ code: …` as a literal or constant;
 *  D. a hand-written `[CODE; details: repo-aegis explain` trailer;
 *  E. the first argument of `deny(` (egress shape rules);
 *  F. any code-shaped literal ending `_NEEDS_TTY`, `_NEEDS_HUMAN`, `_NEEDS_APP`, `_REFUSED`;
 *  G. a `code: "X"` literal followed within 400 characters by a `reason`, `why` or `fixes` key (a refusal object);
 *  H. the first argument of `auditRefusal(` / `pushRefusal(`;
 *  I. `action: "refuse"` followed closely by `code: "X"` (hook-policy's refuse decision).
 */
export function deriveRefusalCodes(files: { path: string; text: string }[]): Map<string, string> {
  const found = new Map<string, string>();
  const add = (code: string | undefined, path: string): void => {
    if (code !== undefined && !found.has(code)) found.set(code, path);
  };
  const consts = new Map<string, string>();
  for (const f of files) {
    for (const m of f.text.matchAll(new RegExp(`\\bconst\\s+(${CODE})\\s*(?::\\s*string)?\\s*=\\s*"(${CODE})"`, "g"))) {
      consts.set(m[1]!, m[2]!);
    }
  }
  const resolveToken = (tok: string): string | undefined => {
    const lit = new RegExp(`^"(${CODE})"$`).exec(tok);
    if (lit !== null) return lit[1];
    return consts.get(tok);
  };
  for (const f of files) {
    const t = f.text;
    // A
    for (const m of t.matchAll(/\btype\s+(\w*Code\w*)\s*=\s*([^;]+);/g)) {
      if (NOT_REFUSAL_UNIONS.has(m[1]!)) continue;
      for (const s of m[2]!.matchAll(new RegExp(`"(${CODE})"`, "g"))) add(s[1], f.path);
    }
    // B
    for (const m of t.matchAll(/\b(?:refusalTrailer|withRefusalTrailer|requireTerminal|refuse)\(\s*([A-Za-z_"][A-Za-z0-9_"]*)/g)) {
      add(resolveToken(m[1]!), f.path);
    }
    // C
    for (const m of t.matchAll(/\brefusal\(\{[^}]{0,300}?\bcode:\s*([A-Za-z_"][A-Za-z0-9_"]*)/g)) add(resolveToken(m[1]!), f.path);
    // D
    for (const m of t.matchAll(new RegExp(`\\[(${CODE}); details: repo-aegis explain`, "g"))) add(m[1], f.path);
    // E
    for (const m of t.matchAll(/\bdeny\(\s*"([A-Z][A-Z0-9_]+)"/g)) add(m[1], f.path);
    // F
    for (const m of t.matchAll(new RegExp(`"(${CODE})"`, "g"))) {
      if (/_(?:NEEDS_TTY|NEEDS_HUMAN|NEEDS_APP|REFUSED)$/.test(m[1]!)) add(m[1], f.path);
    }
    // G
    for (const m of t.matchAll(new RegExp(`\\bcode:\\s*"(${CODE})"[^]{0,400}?\\b(?:reason|why|fixes)\\b`, "g"))) add(m[1], f.path);
    // H: audit and push-refusal helpers take the code first
    for (const m of t.matchAll(new RegExp(`\\b(?:auditRefusal|pushRefusal)\\(\\s*"(${CODE})"`, "g"))) add(m[1], f.path);
    // I: a refuse decision object
    for (const m of t.matchAll(new RegExp(`action:\\s*"refuse"[^]{0,80}?code:\\s*"(${CODE})"`, "g"))) add(m[1], f.path);
  }
  return found;
}

const files = sourceFiles();
const derived = deriveRefusalCodes(files);
const guide: Docs = { guide: readFileSync(GUIDE_PATH, "utf8"), sandbox: null };
const guideCodes = new Set(knownCodes(guide));

describe("refusal lint (X-10)", () => {
  it("the scan finds the refusal codes (guards against a scan that silently finds nothing)", () => {
    for (const known of ["UNREGISTERED_OWNER_EGRESS", "AGENT_RAN_HUMAN_COMMAND", "APPROVE_NEEDS_TTY", "PUSH_IMPLICIT_TARGET", "GH_IDENTITY_UNAVAILABLE", "CROSS_ORG_PUSH", "HOOK_INPUT_TOO_LARGE"]) {
      assert.ok(derived.has(known), `the scan should find ${known}; found ${derived.size} codes`);
    }
    assert.ok(derived.size >= 60, `expected at least 60 refusal codes, found ${derived.size}`);
  });

  it("every refusal code in the source has an entry in REFUSAL_GUIDE (next step and person-only)", () => {
    const missing = [...derived].filter(([c]) => !Object.prototype.hasOwnProperty.call(REFUSAL_GUIDE, c)).map(([c, p]) => `${c} (${p.slice(PACKAGES.length + 1)})`);
    assert.deepEqual(missing, [], `refusal codes with no REFUSAL_GUIDE entry (packages/core/src/refusal-guide.ts):\n${missing.join("\n")}`);
  });

  it("every refusal code in the source has a row in doc/agent-guide.md's error table (what `explain` prints)", () => {
    const missing = [...derived].filter(([c]) => !guideCodes.has(c)).map(([c, p]) => `${c} (${p.slice(PACKAGES.length + 1)})`);
    assert.deepEqual(missing, [], `refusal codes with no row in doc/agent-guide.md:\n${missing.join("\n")}`);
  });

  it("every REFUSAL_GUIDE entry also has a guide row, and no entry is empty", () => {
    for (const [code, e] of Object.entries(REFUSAL_GUIDE)) {
      assert.ok(guideCodes.has(code), `${code} has a REFUSAL_GUIDE entry but no row in doc/agent-guide.md`);
      assert.ok(e.next.trim().length >= 12 && /[.!?]$/.test(e.next), `${code}: next must be one sentence ending in a full stop: ${JSON.stringify(e.next)}`);
      assert.ok(!/\n/.test(e.next), `${code}: next must be one line`);
    }
  });

  it("every REFUSAL_GUIDE entry names a code the source can print (no stale entries)", () => {
    const stale = Object.keys(REFUSAL_GUIDE).filter(c => !derived.has(c));
    assert.deepEqual(stale, [], `REFUSAL_GUIDE entries no source emits: ${stale.join(", ")}`);
  });

  it("the guide's error-table parser sees the rows (the lint reads the same rows `explain` does)", () => {
    assert.ok(errorRows(guide.guide).length > 50);
  });

  it("the trailer of every code carries the version, exactly one next step and the person-only answer, then the unchanged token", () => {
    for (const code of Object.keys(REFUSAL_GUIDE)) {
      const t = refusalTrailer(code);
      const e = REFUSAL_GUIDE[code]!;
      assert.ok(t.startsWith(`repo-aegis ${repoAegisVersion()}. Next step: ${e.next} Only a person can run it: ${e.personOnly ? "yes" : "no"}. `), t);
      assert.ok(t.endsWith(`[${code}; details: repo-aegis explain ${code}]`), t);
      assert.equal(t.match(/Next step:/g)?.length, 1, "exactly one next step");
    }
    assert.match(repoAegisVersion(), /^\d+\.\d+\.\d+/);
  });

  it("a code with no table entry still renders a generic line rather than throwing", () => {
    assert.match(refusalGuideLine("NO_SUCH_CODE_XYZ"), /^repo-aegis \S+\. Next step: .*explain.* Only a person can run it: no\.$/);
  });

  it("withRefusalTrailer appends once and never doubles a trailer", () => {
    const once = withRefusalTrailer("PUSH_IMPLICIT_TARGET", "a bare push was refused.");
    assert.ok(once.endsWith("[PUSH_IMPLICIT_TARGET; details: repo-aegis explain PUSH_IMPLICIT_TARGET]"));
    assert.equal(withRefusalTrailer("PUSH_IMPLICIT_TARGET", once), once);
  });

  it("the scan itself flags a code that has no entry (mutation check on the derivation)", () => {
    const fake = [{ path: "x.ts", text: 'export type FakeCode = "BRAND_NEW_REFUSAL";\nfoo(refusalTrailer("ANOTHER_NEW_ONE"));\nconst NEEDS = "SOME_NEEDS_TTY";\nrefusal({ code: "THIRD_NEW", what: "" })' }];
    const got = deriveRefusalCodes(fake);
    assert.deepEqual([...got.keys()].sort(), ["ANOTHER_NEW_ONE", "BRAND_NEW_REFUSAL", "SOME_NEEDS_TTY", "THIRD_NEW"]);
  });
});
