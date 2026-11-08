// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// `scanAssignments` and `scanFunctions` replaced two regexes that CodeQL flagged as
// polynomial-time (js/polynomial-redos). The old regexes stay HERE, as the oracle: the scans must
// return exactly their matches (same captures, same order), and must stay linear on hostile input.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { scanAssignments, scanFunctions } from "./human-commands.js";

const ASSIGN_ORACLE = /(?:^|[\s;&|(])([A-Za-z_][\w.-]*)=((?:'[^']*'|"[^"]*"|[^\s;&|]*))/g;
const FN_ORACLE = /(?:function\s+([A-Za-z_][\w.-]*)|([A-Za-z_][\w.-]*)\s*\(\s*\))\s*\{([^}]*)\}/g;

function oracleAssignments(text: string): Array<{ name: string; value: string }> {
  const re = new RegExp(ASSIGN_ORACLE.source, "g");
  const out: Array<{ name: string; value: string }> = [];
  for (let m = re.exec(text); m !== null; m = re.exec(text)) out.push({ name: m[1]!, value: m[2]! });
  return out;
}

function oracleFunctions(text: string): Array<{ name: string; body: string }> {
  const re = new RegExp(FN_ORACLE.source, "g");
  const out: Array<{ name: string; body: string }> = [];
  for (let m = re.exec(text); m !== null; m = re.exec(text)) out.push({ name: (m[1] ?? m[2])!, body: m[3]! });
  return out;
}

const TRICKY: readonly string[] = [
  "",
  "a=b",
  "a=b=c",
  "a=",
  "a= b=c",
  "=a",
  "1a=b",
  "_x.y-z=1",
  "x;a=b|c=d&e=f(g=h",
  "a='x y' b=\"p q\" c=plain",
  "a='unterminated b=c",
  'a="unterminated b=c',
  "a='x'y z='1'",
  "a=''",
  'a=""',
  "a='x\ny'",
  "RA=repo-aegis; ra() { RA \"$@\"; }",
  "alias ra='repo-aegis'",
  "f(){",
  "f(){}",
  "f() {x}",
  "f ( ) { x }",
  "f( ){x}",
  "function f {",
  "function f {x}",
  "function f{x}",
  "function  f.g-h \n {x y}",
  "functionf {x}",
  "xfunction f {x}",
  "function function {x}",
  "function f() {x}",
  "function (){x}",
  "f(g(){a}){b}",
  "f() { a() { b } }",
  "f(){a}g(){b}",
  "f(){ } }",
  "a(){x} b ( ) {y} function c {z}",
  "1.a(){x}",
  "9f(){x}",
  "a.b-c(){x}",
  "(){x}",
  "{}",
  "function",
  "function ",
  "f(",
  "f()",
  "f() ",
  "f(){ unterminated",
  "f(){ f(){ f(){",
];

/** A fixed-seed LCG: deterministic, so a failure reproduces. */
function lcg(seed: number): (n: number) => number {
  let s = seed >>> 0;
  return n => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return (s >>> 8) % n;
  };
}

const ALPHABET = ["a", "b", "f", "_", ".", "-", "=", "'", '"', ";", "&", "|", "(", ")", "{", "}", " ", "\n", "function ", "()", "{}", "a="];

function randomStrings(seed: number, count: number): string[] {
  const next = lcg(seed);
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const len = next(40);
    let t = "";
    for (let k = 0; k < len; k++) t += ALPHABET[next(ALPHABET.length)]!;
    out.push(t);
  }
  return out;
}

describe("scanAssignments", () => {
  it("matches the old regex on tricky inputs", () => {
    for (const t of TRICKY) assert.deepEqual(scanAssignments(t), oracleAssignments(t), JSON.stringify(t));
  });
  it("finds the documented bindings", () => {
    assert.deepEqual(scanAssignments("a=b=c"), [{ name: "a", value: "b=c" }]);
    assert.deepEqual(scanAssignments("a='x y' b=2"), [
      { name: "a", value: "'x y'" },
      { name: "b", value: "2" },
    ]);
  });
  it("matches the old regex on 6000 deterministic pseudo-random strings", () => {
    for (const t of randomStrings(0x2f6e2b1, 6000)) {
      assert.deepEqual(scanAssignments(t), oracleAssignments(t), JSON.stringify(t));
    }
  });
  it("stays linear on hostile 200 KB inputs", () => {
    const hostile = ["a=".repeat(100_000), " a".repeat(100_000), "a='".repeat(70_000), "a=\"x ".repeat(40_000), "a".repeat(200_000), ";a".repeat(100_000) + "-"];
    for (const t of hostile) {
      const t0 = performance.now();
      scanAssignments(t);
      assert.ok(performance.now() - t0 < 200, `slow on ${t.slice(0, 8)}`);
    }
  });
});

describe("scanFunctions", () => {
  it("matches the old regex on tricky inputs", () => {
    for (const t of TRICKY) assert.deepEqual(scanFunctions(t), oracleFunctions(t), JSON.stringify(t));
  });
  it("finds the documented definitions", () => {
    assert.deepEqual(scanFunctions("ra() { repo-aegis \"$@\"; }"), [{ name: "ra", body: ' repo-aegis "$@"; ' }]);
    assert.deepEqual(scanFunctions("function ra { x }"), [{ name: "ra", body: " x " }]);
  });
  it("matches the old regex on 6000 deterministic pseudo-random strings", () => {
    for (const t of randomStrings(0x1badb02, 6000)) {
      assert.deepEqual(scanFunctions(t), oracleFunctions(t), JSON.stringify(t));
    }
  });
  it("stays linear on hostile 200 KB inputs", () => {
    const hostile = ["a".repeat(200_000), "a(){".repeat(50_000), "f ( ".repeat(50_000), "function ".repeat(22_000), "a ".repeat(100_000) + "(", "function " + " ".repeat(200_000), "a" + " ".repeat(200_000) + "(", "f(){" + "x".repeat(200_000)];
    for (const t of hostile) {
      const t0 = performance.now();
      scanFunctions(t);
      assert.ok(performance.now() - t0 < 200, `slow on ${t.slice(0, 8)}`);
    }
  });
});
