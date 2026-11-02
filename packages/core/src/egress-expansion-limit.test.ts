// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// Issue #151, final review F1/F3: `sh -c TEXT ARG0 ARGS…` positional expansion was unbounded. A flat
// `"$@" "$@" …` body is quadratic in its argument count; nested `bash -c '"$@"; "$@"; …' _ bash -c …` is
// exponential in its depth, so ~1 KB of input exhausted the heap. A dead guard process does not block, so
// that was a fail-open. Each case below ran out of memory (or took many seconds) before the fix.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ExpansionLimitError,
  MAX_INTENTS_PER_LINE,
  POSITIONAL_MAX_BYTES,
  parseEgressIntents,
  simpleCommands,
  substitutePositionals,
} from "./egress-intent.js";
import { checkNetworkRules } from "./egress-network-rules.js";

/** `sh -c '"$@" "$@" … (n)' sh <target> a a … (n)`. */
function flat(n: number, target: string): string {
  return `sh -c '${Array(n).fill('"$@"').join(" ")}' sh ${target} ${Array(n).fill("a").join(" ")}`;
}

/** `bash -c '"$@"; … (k)' _ ` wrapped `levels` times around `target`: k^levels copies of it. */
function nested(k: number, levels: number, target: string): string {
  let cmd = target;
  for (let i = 0; i < levels; i++) cmd = `bash -c '${Array(k).fill('"$@"').join("; ")}' _ ${cmd}`;
  return cmd;
}

/** Wall-clock bound generous enough for a loaded CI runner; the pre-fix code took tens of seconds or died. */
const FAST_MS = 5_000;

function timed<T>(f: () => T): { value: T; ms: number } {
  const t = performance.now();
  const value = f();
  return { value, ms: performance.now() - t };
}

describe("positional expansion is bounded (F1)", () => {
  it("substitutePositionals refuses to build more than POSITIONAL_MAX_BYTES", () => {
    const args = ["sh", ...Array(1000).fill("x".repeat(30))];
    assert.throws(() => substitutePositionals(Array(10).fill('"$@"').join(" "), args), ExpansionLimitError);
    // Just under the bound still expands.
    const small = substitutePositionals('"$@"', ["sh", "a".repeat(POSITIONAL_MAX_BYTES - 10)]);
    assert.ok(small !== null && small.length <= POSITIONAL_MAX_BYTES);
  });

  it("a flat expansion past the bound fails closed, quickly", () => {
    const { value, ms } = timed(() => parseEgressIntents(flat(8000, "gh issue create --repo stranger/x")));
    assert.ok(ms < FAST_MS, `${ms} ms`);
    assert.ok(value.length >= 1);
    assert.ok(value.some(i => i.unresolved !== undefined), "an unresolved (fail-closed) intent");
  });

  it("a nested, multiplying expansion fails closed with a bounded intent list", () => {
    const cmd = nested(40, 4, "gh issue create --repo stranger/x");
    assert.ok(cmd.length < 2048, "the attack input is small");
    const { value, ms } = timed(() => parseEgressIntents(cmd));
    assert.ok(ms < FAST_MS, `${ms} ms`);
    assert.ok(value.length <= 2 * MAX_INTENTS_PER_LINE + 1, `${value.length} intents`);
    assert.ok(value.some(i => i.unresolved !== undefined), "the cut-off remainder is fail-closed");
  });

  it("a capped line keeps an unconditional shape-rule label (pty wrapper)", () => {
    // 12^3 plain intents first, the pty-wrapped one LAST: a plain "first N" cut would drop it.
    const value = parseEgressIntents(`${nested(12, 3, "gh issue create --repo acme/x")}; script -q /dev/null gh issue create --repo acme/y`);
    assert.ok(value.length > MAX_INTENTS_PER_LINE, "the cap was reached");
    assert.ok(value.length <= 2 * MAX_INTENTS_PER_LINE + 1);
    assert.ok(value.some(i => i.ptyWrapper !== undefined), "EGRESS_PTY_WRAPPER still fires");
  });

  it("simpleCommands (R6) is bounded too, and still sees a curl spliced in past the bound", () => {
    const post = "curl -X POST https://api.github.com/repos/o/r/issues";
    for (const cmd of [flat(8000, post), nested(40, 4, post)]) {
      const { value, ms } = timed(() => simpleCommands(cmd));
      assert.ok(ms < FAST_MS, `${ms} ms`);
      assert.ok(value.some(c => c.cmd === "curl"));
      assert.equal(checkNetworkRules(cmd)?.code, "GITHUB_API_VIA_HTTP_CLIENT");
    }
  });

  it("everyday nested shells are unchanged", () => {
    const ok = parseEgressIntents(`bash -c '"$@"' _ gh issue create --repo acme/x --body hi`);
    assert.equal(ok.length, 1);
    assert.equal(ok[0]!.repoFlag, "acme/x");
    assert.equal(ok[0]!.unresolved, undefined);
    const two = parseEgressIntents(nested(2, 2, "gh issue create --repo acme/x"));
    assert.equal(two.length, 4, "2×2 copies, each judged");
    assert.ok(two.every(i => i.repoFlag === "acme/x" && i.unresolved === undefined));
  });
});
