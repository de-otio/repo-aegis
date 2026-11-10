// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.

export interface PatternValidationResult {
  ok: boolean;
  reason?: string;
}

const MAX_PATTERN_LENGTH = 2048;
const MAX_COMBINED_BYTES = 128 * 1024;
const REDOS_STRESS_LENGTH = 1000;
const REDOS_TIMEOUT_MS = 100;

const REDOS_ADVICE = "(possible catastrophic backtracking; consider re-anchoring)";

/**
 * Validate a single regex pattern for use as a marker.
 *
 * The honest mistake this stops: an operator types (or `scan-env` suggests) a
 * pattern like `(a+)+$` by accident. Every hook would then wedge on it, and a
 * hook timeout is a non-blocking error, so writes would proceed unscanned.
 * This is accident prevention, not a defence against a hostile pattern author.
 *
 * Checks, all in-process:
 * 1. Length <= 2048 chars.
 * 2. Compiles as a JavaScript RegExp without throwing.
 * 3. A static scan for nested unbounded quantifiers (`(a+)+`, `(\w+\s*)*`).
 *    This runs BEFORE any matching, so the classic catastrophic shape is
 *    refused without executing it (a timer cannot interrupt a regex).
 * 4. A CPU-time check against `'a'.repeat(1000)`. It catches slow patterns the
 *    static scan does not recognise, but only after they return.
 *
 * Run at `render` and registry-edit time; bad patterns must not reach the hot
 * path of `check`.
 */
export function validatePattern(pattern: string): PatternValidationResult {
  if (typeof pattern !== "string" || pattern.length === 0) {
    return { ok: false, reason: "empty pattern" };
  }
  if (pattern.length > MAX_PATTERN_LENGTH) {
    return { ok: false, reason: `pattern exceeds ${MAX_PATTERN_LENGTH} characters` };
  }
  try {
    new RegExp(pattern, "i");
  } catch (err) {
    return { ok: false, reason: `invalid regex: ${(err as Error).message}` };
  }
  if (hasNestedUnboundedQuantifier(pattern)) {
    return {
      ok: false,
      reason: `pattern has nested unbounded quantifiers ${REDOS_ADVICE}`,
    };
  }
  if (!isInTimeBudget(pattern, REDOS_STRESS_LENGTH, REDOS_TIMEOUT_MS)) {
    return {
      ok: false,
      reason: `pattern took >${REDOS_TIMEOUT_MS}ms on stress input ${REDOS_ADVICE}`,
    };
  }
  return { ok: true };
}

/**
 * Validate a list of patterns. Returns split valid/invalid.
 */
export function validatePatterns(
  patterns: string[],
): { valid: string[]; invalid: { pattern: string; reason: string }[] } {
  const valid: string[] = [];
  const invalid: { pattern: string; reason: string }[] = [];
  for (const p of patterns) {
    const r = validatePattern(p);
    if (r.ok) valid.push(p);
    else invalid.push({ pattern: p, reason: r.reason ?? "unknown" });
  }
  return { valid, invalid };
}

/**
 * Validate that a combined alternation regex is within the size cap.
 * Used by render and the deny-set computation as a safety net.
 */
export function validateCombinedSize(combined: string): PatternValidationResult {
  if (Buffer.byteLength(combined, "utf8") > MAX_COMBINED_BYTES) {
    return {
      ok: false,
      reason: `combined regex exceeds ${MAX_COMBINED_BYTES} bytes`,
    };
  }
  return { ok: true };
}

/**
 * Static scan for the classic catastrophic shape: a group whose LAST element is
 * itself unboundedly quantified, and which is then unboundedly quantified
 * (`(a+)+`, `(a*)*`, `(\w+\s*)*`, `(x|y+)+`, `((a+))*`). Nested quantifiers
 * where something separates the inner repeat from the group's end
 * (`(\d+\.)+`) are linear and are not flagged, so ordinary markers pass.
 *
 * Deliberately a heuristic: it does not catch overlapping alternations such as
 * `(a|a)+`; the CPU-time check in {@link validatePattern} is the second net.
 * Patterns already compile as RegExp when this runs, so groups are balanced.
 */
function hasNestedUnboundedQuantifier(pattern: string): boolean {
  interface Frame {
    /** The current alternative ends in an unbounded repeat. */
    current: boolean;
    /** Some earlier alternative of this group did. */
    earlier: boolean;
  }
  const stack: Frame[] = [{ current: false, earlier: false }];
  const top = (): Frame => stack[stack.length - 1]!;

  /** Parse an optional quantifier at `i`; returns its end index and whether it is unbounded. */
  const quantifier = (i: number): { end: number; unbounded: boolean } => {
    const c = pattern[i];
    let end = i;
    let unbounded = false;
    if (c === "*" || c === "+") {
      end = i + 1;
      unbounded = true;
    } else if (c === "?") {
      end = i + 1;
    } else if (c === "{") {
      const m = /^\{(\d+)(,(\d*))?\}/.exec(pattern.slice(i));
      if (m === null) return { end: i, unbounded: false };
      end = i + m[0].length;
      unbounded = m[2] !== undefined && m[3] === "";
    } else {
      return { end: i, unbounded: false };
    }
    if (pattern[end] === "?") end += 1; // lazy modifier
    return { end, unbounded };
  };

  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i]!;
    let atomEnd = i + 1;
    let groupTail = false;
    if (c === "\\") {
      atomEnd = i + 2;
    } else if (c === "[") {
      let j = i + 1;
      while (j < pattern.length && pattern[j] !== "]") j += pattern[j] === "\\" ? 2 : 1;
      atomEnd = j + 1;
    } else if (c === "(") {
      stack.push({ current: false, earlier: false });
      i += 1;
      continue;
    } else if (c === ")") {
      if (stack.length === 1) {
        i += 1;
        continue;
      }
      const f = stack.pop()!;
      groupTail = f.current || f.earlier;
    } else if (c === "|") {
      const f = top();
      f.earlier = f.earlier || f.current;
      f.current = false;
      i += 1;
      continue;
    }
    const q = quantifier(atomEnd);
    if (q.unbounded && groupTail) return true;
    top().current = q.unbounded || (c === ")" && groupTail);
    i = q.end;
  }
  return false;
}

/**
 * Time the pattern against a stress input and compare CPU time afterwards.
 *
 * NOT preemptive. Node's regex engine has no timeout, so a pattern that really
 * does not return will hang this call; that is why the static scan runs first.
 * This catches patterns that are merely slow (they return, but over budget).
 * CPU time (user + system), not wall-clock: a descheduled process on a busy
 * machine accrues wall time without doing work, which rejected valid markers.
 */
function isInTimeBudget(pattern: string, stressLength: number, budgetMs: number): boolean {
  const re = new RegExp(pattern, "i");
  const stress = "a".repeat(stressLength);
  const before = process.cpuUsage();
  try {
    re.test(stress);
  } catch {
    return false;
  }
  const used = process.cpuUsage(before);
  const cpuMs = (used.user + used.system) / 1000;
  return cpuMs <= budgetMs * 10; // generous: 10x to account for noisy CI
}
