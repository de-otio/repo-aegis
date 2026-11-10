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
import {
  REFUSAL_GUIDE,
  refusalGuideLine,
  refusalTrailer,
  repoAegisVersion,
  USAGE_AFTER_TERMINAL_GATE,
  withRefusalTrailer,
} from "@de-otio/repo-aegis-core";
import { errorRows, explanationFor, knownCodes, type Docs } from "./commands/explain.js";

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

/** The text of the first argument of a call whose `(` is at `open - 1`: up to the top-level `,` or closing `)`. */
function firstArgument(t: string, open: number): string {
  let depth = 0;
  let quote: string | null = null;
  let i = open;
  for (; i < t.length; i++) {
    const c = t[i]!;
    if (quote !== null) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "{" || c === "(" || c === "[") depth++;
    else if (c === "}" || c === ")" || c === "]") {
      if (depth === 0) break;
      depth--;
    } else if (c === "," && depth === 0) break;
  }
  return t.slice(open, i);
}

/** Split `s` at its top-level commas (not inside brackets or strings). */
function splitTopLevel(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quote !== null) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "{" || c === "(" || c === "[") depth++;
    else if (c === "}" || c === ")" || c === "]") depth--;
    else if (c === "," && depth === 0) {
      parts.push(s.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(s.slice(start));
  return parts;
}

type EmitErrorCall =
  | { kind: "code"; code: string }
  | { kind: "const"; name: string }
  /** `err.code` and the like: the code is declared where the error class is (rules K and L) or in a `…Code` union (A). */
  | { kind: "declared-elsewhere" }
  /** no `code` at all (a bare message): nothing to document. */
  | { kind: "none" }
  /** a code the scan cannot read: a variable, a shorthand, a spread, a ternary, or a payload passed in whole. */
  | { kind: "opaque"; expr: string };

/** Every `emitError(` call in `t`, classified by what its first argument says about the code. */
function emitErrorCalls(t: string): EmitErrorCall[] {
  const out: EmitErrorCall[] = [];
  for (const m of t.matchAll(/\bemitError\(/g)) {
    if (/\bfunction\s+$/.test(t.slice(0, m.index!))) continue; // the definition, not a call
    const arg = firstArgument(t, m.index! + m[0].length).trim();
    if (/^["'`]/.test(arg)) {
      out.push({ kind: "none" });
      continue;
    }
    if (!arg.startsWith("{")) {
      // `cond ? { code: "A", … } : { code: "B", … }`: readable when every `code:` in it is a literal
      const props = [...arg.matchAll(/\bcode\s*:\s*([^,}\n]+)/g)].map(p => p[1]!.trim());
      const lits = props.map(p => /^"([A-Z][A-Z0-9_]+)"$/.exec(p)?.[1]);
      if (props.length > 0 && lits.every(l => l !== undefined)) {
        for (const l of lits) out.push({ kind: "code", code: l! });
      } else out.push({ kind: "opaque", expr: arg.slice(0, 40).replace(/\s+/g, " ") });
      continue;
    }
    const segments = splitTopLevel(arg.slice(1, arg.lastIndexOf("}"))).map(s => s.trim());
    let value: string | null = null;
    for (const s of segments) {
      const prop = /^code\s*:\s*([^]*)$/.exec(s);
      if (prop !== null) value = prop[1]!.trim();
      else if (s === "code") value = "code"; // shorthand
    }
    if (value === null) {
      const spreads = segments.filter(s => s.startsWith("..."));
      // `...(err.code !== undefined && { code: err.code })`: a declared code, added only when there is one
      if (spreads.length === 0) out.push({ kind: "none" });
      else if (spreads.some(s => /\b[A-Za-z_$][\w$]*\.code\b/.test(s))) out.push({ kind: "declared-elsewhere" });
      else out.push({ kind: "opaque", expr: "...spread" });
      continue;
    }
    const lit = /^"([A-Z][A-Z0-9_]+)"$/.exec(value);
    if (lit !== null) out.push({ kind: "code", code: lit[1]! });
    else if (/^[A-Z][A-Z0-9_]+$/.test(value)) out.push({ kind: "const", name: value });
    else if (/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\.code$/.test(value)) out.push({ kind: "declared-elsewhere" });
    else out.push({ kind: "opaque", expr: value.slice(0, 40) });
  }
  return out;
}

/**
 * Files that may pass a code to `emitError` through a parameter (`emitError({ code, … })`): the helper's callers
 * name the code, and the scan reads those callers (`requireTerminal(`, `refuse(` — rule B). Any other `emitError`
 * whose code is not a literal, a constant or a declared `….code` is reported, so a new wrapper (`fail(code, msg)`)
 * cannot hide a code from this lint.
 */
const OPAQUE_EMIT_ERROR_ALLOWED = new Set(["require-terminal.ts", "install-claude-md-managed.ts"]);

/** `path: emitError(<expr>)` for every `emitError` call whose code the scan cannot read, outside the short allowlist. */
export function findOpaqueEmitErrors(files: { path: string; text: string }[]): string[] {
  const out: string[] = [];
  for (const f of files) {
    if (OPAQUE_EMIT_ERROR_ALLOWED.has(f.path.slice(f.path.lastIndexOf("/") + 1))) continue;
    for (const call of emitErrorCalls(f.text)) {
      if (call.kind === "opaque") out.push(`${f.path}: emitError code is "${call.expr}"`);
    }
  }
  return out;
}
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
 *  I. `action: "refuse"` followed closely by `code: "X"` (hook-policy's refuse decision);
 *  J. the `code:` of every `emitError(` call, K. an error class's own `readonly code`, L. a code given to an
 *     error class constructor: the plain CLI errors (`PAUSE_TOO_LONG`, `LOCK_TIMEOUT`, `MIGRATION_NOT_CONFIRMED`, …).
 *     They stop a person as hard as a guard refusal, so they get a next step and a guide row too.
 *
 * NOT covered, on purpose: `repo-aegis doctor` findings (`DoctorCheckCode` and the `doctor-*-checks` files). A
 * finding is not a refusal: nothing is blocked, and each carries its own `fix` line (printed by `doctor`, and
 * documented in the same guide table for `explain`). Hook state codes (`HookStateCode`) are likewise status, not
 * refusals. `audit` finding codes (`detail.code`) are findings too, except `PUBLISHED_ARCHIVE_ESCAPE`, whose
 * refusal to scan is covered by rule G.
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
    // J: every code an `emitError(` call can print (the plain CLI errors: exit 2 with `{ code, error }`), read from the
    //    call's own object argument: a literal (`USAGE` too: a single word) or a constant. A call whose code is
    //    `err.code` is covered by K and L, where that code is declared; any other shape is reported by
    //    {@link findOpaqueEmitErrors}, so a new helper cannot hide a code from this scan.
    for (const call of emitErrorCalls(t)) {
      if (call.kind === "code") add(call.code, f.path);
      else if (call.kind === "const") add(consts.get(call.name), f.path);
    }
    // K: an error class that declares its own code (`readonly code = "X"`), which `emitError({ code: err.code })` prints.
    for (const m of t.matchAll(/\breadonly code(?:: [^=;]+)? = "([A-Z][A-Z0-9_]+)"/g)) add(m[1], f.path);
    for (const m of t.matchAll(/this\.code = "([A-Z][A-Z0-9_]+)"/g)) add(m[1], f.path);
    // L: a code handed to an error class constructor (`new RegistryCliError("X", …)`, `new GitCredentialInstallError(X, …)`).
    for (const m of t.matchAll(/\bnew \w*Error\(\s*([A-Z_"][A-Z0-9_"]*)\s*,/g)) add(resolveToken(m[1]!), f.path);
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

  it("withRefusalTrailer decides 'already done' by the guide line: an older hand-written token does not hide the new fields (M1)", () => {
    const code = "PUSH_IMPLICIT_TARGET";
    for (const old of [`[${code}; details: repo-aegis explain ${code}]`, `[${code}]`]) {
      const got = withRefusalTrailer(code, `a bare push was refused. ${old}`);
      assert.ok(got.includes(refusalGuideLine(code)), `the version and next step are added: ${got}`);
      assert.equal(got.split(`[${code}`).length - 1, 1, `the token appears once: ${got}`);
      assert.ok(got.endsWith(`[${code}; details: repo-aegis explain ${code}]`), got);
    }
    // a different code's token is left alone and the trailer for THIS code is added
    assert.ok(withRefusalTrailer(code, "x [OTHER_CODE]").includes("[OTHER_CODE]"));
    // an override changes the line, so a text that carries the table's line gets the overridden one too
    const table = withRefusalTrailer("USAGE", "bad flag.");
    const overridden = withRefusalTrailer("USAGE", table, USAGE_AFTER_TERMINAL_GATE);
    assert.match(overridden, /Only a person can run it: yes\. \[USAGE; details: repo-aegis explain USAGE\]$/);
    assert.equal(overridden.split("[USAGE;").length - 1, 1);
  });

  it("no source file outside core/src/refusal.ts hand-writes a `[CODE; details: repo-aegis explain …]` trailer (M1)", () => {
    // `[CODE; …]` in prose or comments names the placeholder `CODE`, which has no underscore and is not matched.
    const hand = new RegExp(`\\[${CODE}; details: repo-aegis explain`);
    const bad = files.filter(f => !f.path.endsWith("/core/src/refusal.ts") && hand.test(f.text)).map(f => f.path.slice(PACKAGES.length + 1));
    assert.deepEqual(bad, [], `build the trailer with refusalTrailer() / withRefusalTrailer(): ${bad.join(", ")}`);
    // and the detector itself sees one
    assert.ok(hand.test("x [SOME_CODE; details: repo-aegis explain SOME_CODE]"));
    assert.ok(!hand.test("`[CODE; details: repo-aegis explain CODE]`"));
  });

  it("every emitError code is a literal, a constant or a declared `….code`, or its file is on the short allowlist (M2)", () => {
    assert.deepEqual(findOpaqueEmitErrors(files), []);
    // mutation check: a wrapper that hides its code is reported
    const fake = [
      {
        path: "/x/src/fail.ts",
        text:
          'function fail(code: string, m: string): never { return emitError({ code, error: m }, {}); }\n' +
          'emitError({ code: cond ? "A_ONE" : "A_TWO", error: "x" }, opts);\n' +
          'emitError(payload, opts);\n' +
          'emitError({ ...base, error: "x" }, opts);\n' +
          'emitError({ code: err.code, error: "fine" }, opts);\n' +
          'emitError({ code: "FINE_LITERAL", error: "fine" }, opts);\n' +
          'emitError("a bare message", opts);',
      },
    ];
    const reported = findOpaqueEmitErrors(fake);
    assert.equal(reported.length, 4, reported.join("\n"));
    assert.match(reported.join("\n"), /"code"/);
    // an allowlisted helper file may pass a code through
    assert.deepEqual(findOpaqueEmitErrors([{ path: "/x/src/require-terminal.ts", text: fake[0]!.text }]), []);
  });

  it("`explain` shows the table's next step and person-only answer, so a drift from the guide row is visible (M3)", () => {
    const e = explanationFor(guide, "PAUSE_TOO_LONG");
    assert.ok(e !== null);
    assert.equal(e.nextStep, REFUSAL_GUIDE["PAUSE_TOO_LONG"]!.next);
    assert.equal(e.personOnly, true);
    const agentFix = explanationFor(guide, "PUSH_IMPLICIT_TARGET");
    assert.equal(agentFix?.personOnly, false);
    // a code the guide documents but that is not a refusal (a doctor finding) has no table entry
    const finding = explanationFor(guide, "SHIM_STALE");
    assert.ok(finding !== null);
    assert.equal(finding.nextStep, null);
    assert.equal(finding.personOnly, null);
    // for every table code, explain agrees with the table
    for (const [code, entry] of Object.entries(REFUSAL_GUIDE)) {
      const x = explanationFor(guide, code);
      assert.ok(x !== null, code);
      assert.equal(x.nextStep, entry.next, code);
      assert.equal(x.personOnly, entry.personOnly, code);
    }
  });

  it("the scan reads plain CLI errors: an emitError code, a single-word code, an error class's own code, a constructor argument", () => {
    const fake = [
      {
        path: "y.ts",
        text:
          'emitError({ code: "FRESH_CLI_ERROR", error: "x" }, opts);\n' +
          'emitError({ code: "USAGE", error: "y" }, opts);\n' +
          'class E extends Error { readonly code = "CLASS_OWN_CODE" as const; }\n' +
          'throw new RegistryCliError("CTOR_CODE", "z");\n' +
          // a doctor finding is not a refusal: it is never reached by these rules
          'const finding = { code: "DOCTOR_ONLY_FINDING", severity: "warn", fix: "x" };',
      },
    ];
    assert.deepEqual([...deriveRefusalCodes(fake).keys()].sort(), ["CLASS_OWN_CODE", "CTOR_CODE", "FRESH_CLI_ERROR", "USAGE"]);
  });

  it("a plain CLI error through the CLI's emitError ends with the shared trailer, and a code outside the table is left alone", async () => {
    const { emitError } = await import("./format.js");
    const realWrite = process.stderr.write.bind(process.stderr);
    const realExit = process.exit;
    let out = "";
    // test seam: capture stderr and turn process.exit into a throw
    process.stderr.write = ((s: string | Uint8Array) => ((out += String(s)), true)) as typeof process.stderr.write;
    process.exit = ((c?: number) => {
      throw new Error(`exit ${c}`);
    }) as typeof process.exit;
    try {
      assert.throws(() => emitError({ code: "PAUSE_TOO_LONG", error: "too long" }, { json: true }), /exit 2/);
      const shown = JSON.parse(out) as { code: string; error: string };
      assert.ok(shown.error.startsWith("too long repo-aegis "), shown.error);
      assert.ok(shown.error.endsWith("[PAUSE_TOO_LONG; details: repo-aegis explain PAUSE_TOO_LONG]"), shown.error);
      assert.match(shown.error, /Only a person can run it: yes\. \[/);
      // H2: USAGE is agent-fixable by default, but a person's step after a terminal gate (the code stays USAGE)
      out = "";
      assert.throws(() => emitError({ code: "USAGE", error: "bad flag" }, { json: true }), /exit 2/);
      assert.match((JSON.parse(out) as { error: string }).error, /Only a person can run it: no\. \[USAGE; details: repo-aegis explain USAGE\]$/);
      out = "";
      assert.throws(() => emitError({ code: "USAGE", error: "bad flag" }, { json: true }, USAGE_AFTER_TERMINAL_GATE), /exit 2/);
      const gated = JSON.parse(out) as { code: string; error: string };
      assert.equal(gated.code, "USAGE");
      assert.match(gated.error, /Next step: A person corrects the command's flags/);
      assert.match(gated.error, /Only a person can run it: yes\. \[USAGE; details: repo-aegis explain USAGE\]$/);
      out = "";
      assert.throws(() => emitError({ code: "NOT_A_CODE_IN_THE_TABLE", error: "plain" }, { json: true }), /exit 2/);
      assert.equal((JSON.parse(out) as { error: string }).error, "plain");
    } finally {
      process.stderr.write = realWrite;
      process.exit = realExit;
    }
  });

  it("the scan itself flags a code that has no entry (mutation check on the derivation)", () => {
    const fake = [{ path: "x.ts", text: 'export type FakeCode = "BRAND_NEW_REFUSAL";\nfoo(refusalTrailer("ANOTHER_NEW_ONE"));\nconst NEEDS = "SOME_NEEDS_TTY";\nrefusal({ code: "THIRD_NEW", what: "" })' }];
    const got = deriveRefusalCodes(fake);
    assert.deepEqual([...got.keys()].sort(), ["ANOTHER_NEW_ONE", "BRAND_NEW_REFUSAL", "SOME_NEEDS_TTY", "THIRD_NEW"]);
  });
});
