// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

export interface PatternValidationResult {
  ok: boolean;
  reason?: string;
}

export type RegexBackend = "re2" | "in-process" | "subprocess";

// Probe `re2` once at module load via `createRequire` so we keep
// validatePattern fully sync. `re2` is an optionalDependency: install
// failures (no native build toolchain) leave us on the in-process
// fallback, which still provides best-effort ReDoS detection.
const _require = createRequire(import.meta.url);
interface Re2Constructor {
  new (pattern: string, flags?: string): { test(s: string): boolean };
}
let re2Ctor: Re2Constructor | null = null;
let re2Probed = false;
function probeRe2(): Re2Constructor | null {
  if (re2Probed) return re2Ctor;
  re2Probed = true;
  try {
    const mod = _require("re2") as Re2Constructor | { default: Re2Constructor };
    re2Ctor =
      typeof mod === "function"
        ? mod
        : "default" in mod
        ? mod.default
        : (mod as unknown as Re2Constructor);
  } catch {
    re2Ctor = null;
  }
  return re2Ctor;
}

let forcedBackend: RegexBackend | null = null;

/**
 * Test-only override. Forces {@link getRegexBackend} and
 * {@link validatePattern} to use a specific backend regardless of which
 * backends are installed. Pass `null` to clear. Production callers must
 * not use this.
 *
 * @internal
 */
export function setRegexBackendForTesting(backend: RegexBackend | null): void {
  forcedBackend = backend;
}

/**
 * Report which regex backend repo-aegis is using for *additional*
 * pattern-safety validation:
 *
 * - `"re2"`: the optional `re2` dependency is installed. Patterns that
 *   compile cleanly in re2 are provably safe from catastrophic
 *   backtracking (re2's hybrid NFA/DFA evaluator is linear-time by
 *   construction). For patterns that re2 can't parse (lookahead /
 *   look-behind / backreferences are unsupported in re2), validation
 *   falls back to the `"in-process"` time-budget heuristic.
 * - `"in-process"`: re2 is unavailable; the in-process timer fires
 *   after the test completes (best-effort, may exceed budget).
 *   {@link validatePatterns} `{ strict: true }` upgrades to
 *   `"subprocess"` for the duration of that call.
 * - `"subprocess"`: only returned by {@link getRegexBackend} when set
 *   via {@link setRegexBackendForTesting}; otherwise an internal
 *   detail of {@link validatePatterns}.
 *
 * Note: re2 affects *validation*, not the scanner's regex engine. The
 * scanner still uses Node's native RegExp because the marker patterns
 * may legitimately use lookahead constructs that re2 doesn't support.
 */
export function getRegexBackend(): RegexBackend {
  if (forcedBackend !== null) return forcedBackend;
  return probeRe2() !== null ? "re2" : "in-process";
}

const MAX_PATTERN_LENGTH = 2048;
const MAX_COMBINED_BYTES = 128 * 1024;
const REDOS_STRESS_LENGTH = 1000;
const REDOS_TIMEOUT_MS = 100;
/** CPU a single pattern may use on the stress input: 10x the nominal budget, for noisy machines. */
const STRICT_PER_PATTERN_BUDGET_MS = REDOS_TIMEOUT_MS * 10;
/** Node start-up and JSON parse in the child, before the first pattern. Generous: a loaded machine is slow here. */
const STRICT_STARTUP_ALLOWANCE_MS = 5000;

/**
 * Validate a single regex pattern for use as a marker.
 *
 * Checks:
 * 1. Compiles as a JavaScript RegExp without throwing.
 * 2. Length <= 2048 chars.
 * 3. Backtracking-bound test against `'a'.repeat(1000)` completes within 100ms.
 *    Catastrophic-backtracking patterns (e.g., `(a+)+$`) hang here and are
 *    rejected as ReDoS-suspected.
 *
 * Run at `render` time; bad patterns must not reach the hot path of `check`.
 *
 * @internal Prefer {@link validatePatterns} (which can run strict,
 * subprocess-backed validation that is preemptable on catastrophic
 * backtracking). This single-pattern, in-process helper is exposed for
 * intra-repo callers that already pre-validate adversary-trust boundaries
 * but is not part of the supported public API.
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
  // Backend-dependent ReDoS check.
  const backend = getRegexBackend();
  if (backend === "re2") {
    const Re2 = probeRe2();
    if (Re2 !== null) {
      try {
        new Re2(pattern, "i");
        // re2 compile succeeded → linear-time evaluation guaranteed.
        return { ok: true };
      } catch {
        // re2 rejected (typically: pattern uses lookahead/lookbehind/
        // backreferences which re2 doesn't support). Fall through to
        // the in-process timer — the pattern is still valid for the
        // scanner's RegExp engine, just not provably safe under re2.
      }
    }
  }
  // Synchronous in-process timing check. Best-effort: see SECURITY
  // WARNING on isInTimeBudget. Worker-based watchdog adds startup
  // overhead disproportionate to per-pattern cost; for marker-list sizes
  // we expect (tens to low hundreds of patterns) the in-process check
  // is fine for trusted-by-policy operator input.
  if (!isInTimeBudget(pattern, REDOS_STRESS_LENGTH, REDOS_TIMEOUT_MS)) {
    return {
      ok: false,
      reason:
        `pattern took >${REDOS_TIMEOUT_MS}ms on stress input ` +
        `(possible catastrophic backtracking; consider re-anchoring)`,
    };
  }
  return { ok: true };
}

export interface ValidatePatternsOptions {
  /**
   * If true, run the backtracking-bound test in a subprocess that can be
   * preemptively killed on timeout. Catches catastrophic-backtracking
   * patterns that the in-process timer can only detect after-the-fact.
   * Adds ~50-200ms of process-spawn overhead for the whole batch.
   * Default: false (use the in-process timer).
   */
  strict?: boolean;
}

/**
 * Validate a list of patterns. Returns split valid/invalid.
 *
 * With `strict: true`, runs the backtracking-bound check in a subprocess
 * that can be preemptively killed if any pattern hangs the regex engine.
 * Recommended for `render` and other one-time-cost paths; not for the
 * per-scan hot path.
 */
export function validatePatterns(
  patterns: string[],
  opts: ValidatePatternsOptions = {},
): { valid: string[]; invalid: { pattern: string; reason: string }[] } {
  if (opts.strict) {
    return validatePatternsStrict(patterns);
  }
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
 * Subprocess-backed strict validation. Spawns a child node process that
 * runs each pattern's stress test sequentially, streaming a one-line
 * JSON result per pattern. If the parent kills the child by timeout,
 * the partial output identifies which pattern was in flight.
 */
function validatePatternsStrict(
  patterns: string[],
): { valid: string[]; invalid: { pattern: string; reason: string }[] } {
  if (patterns.length === 0) return { valid: [], invalid: [] };

  // First pass: catch syntax + length errors in-process so we don't
  // pay process-spawn cost for them.
  const valid: string[] = [];
  const invalid: { pattern: string; reason: string }[] = [];
  const toCheckRedos: string[] = [];
  for (const p of patterns) {
    if (typeof p !== "string" || p.length === 0) {
      invalid.push({ pattern: p, reason: "empty pattern" });
      continue;
    }
    if (p.length > MAX_PATTERN_LENGTH) {
      invalid.push({
        pattern: p,
        reason: `pattern exceeds ${MAX_PATTERN_LENGTH} characters`,
      });
      continue;
    }
    try {
      new RegExp(p, "i");
    } catch (err) {
      invalid.push({ pattern: p, reason: `invalid regex: ${(err as Error).message}` });
      continue;
    }
    toCheckRedos.push(p);
  }

  if (toCheckRedos.length === 0) {
    return { valid, invalid };
  }

  // Attempt 1 runs everything. If the child hangs, the pattern that was
  // IN FLIGHT (it announced itself with a start marker and never reported) is
  // rejected, and the rest, which it never reached or which were queued behind
  // it, get ONE more try in a fresh child. A second hang rejects its in-flight
  // pattern too, and whatever is still unresolved is rejected as unfinished:
  // the property to keep is that a catastrophic regex is never accepted, so
  // anything unproven stays out.
  const results = new Map<number, PatternValidationResult>();
  let pending = toCheckRedos.map((_, i) => i);
  for (let attempt = 0; attempt < 2 && pending.length > 0; attempt++) {
    // The retry gets twice the start-up allowance: if the first child's start-up was
    // starved, a second identical allowance would likely starve again.
    const run = runStrictChild(pending.map(i => toCheckRedos[i]!), STRICT_STARTUP_ALLOWANCE_MS * (attempt + 1));
    const next: number[] = [];
    pending.forEach((globalIdx, localIdx) => {
      const r = run.results.get(localIdx);
      if (r) results.set(globalIdx, r);
      else if (run.timedOut && run.inFlight === localIdx) {
        // The in-flight pattern is the likeliest culprit, but on a starved
        // machine it can be a harmless one that was merely descheduled. Give it
        // one test ALONE in a fresh child before rejecting it. A catastrophic
        // pattern hangs again and is rejected; the cost is one more bounded wait.
        const solo = runStrictChild([toCheckRedos[globalIdx]!], STRICT_STARTUP_ALLOWANCE_MS / 2);
        results.set(
          globalIdx,
          solo.results.get(0) ?? {
            ok: false,
            reason: "strict validation timed out on this pattern (likely catastrophic backtracking)",
          },
        );
      } else next.push(globalIdx);
    });
    if (!run.timedOut && next.length > 0) {
      // The child exited without a result for these (crash or truncated output):
      // nothing to retry on, and nothing proven.
      for (const g of next) results.set(g, { ok: false, reason: "strict validation produced no result" });
      next.length = 0;
    }
    pending = next;
  }
  for (const g of pending) {
    results.set(g, { ok: false, reason: "strict validation did not complete (the validator timed out twice)" });
  }

  for (let i = 0; i < toCheckRedos.length; i++) {
    const p = toCheckRedos[i]!;
    const r = results.get(i)!;
    if (r.ok) valid.push(p);
    else invalid.push({ pattern: p, reason: r.reason ?? "unknown" });
  }
  return { valid, invalid };
}

interface StrictChildRun {
  /** Verdicts by index into the batch handed to the child. */
  results: Map<number, PatternValidationResult>;
  timedOut: boolean;
  /** Index announced by a start marker that never got a verdict; null when none. */
  inFlight: number | null;
}

/**
 * One child process over `patterns`. Each pattern is timed in the child with
 * CPU time (`process.cpuUsage`, user + system), not wall-clock: on a loaded
 * machine a harmless pattern's wall time balloons while its CPU time does not,
 * and a wall-clock budget rejected valid markers there. A catastrophic pattern
 * still burns CPU without bound, so it is still caught, either by exceeding the
 * CPU budget when it returns or by the parent's kill timeout when it does not.
 *
 * The child writes a start marker before each pattern (synchronously, so it is
 * in the pipe even if the next instruction never returns) and a verdict after.
 */
function runStrictChild(patterns: string[], startupAllowanceMs: number): StrictChildRun {
  const script = `
const fs = require('fs');
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
const { patterns, stressLength, cpuBudgetMs } = input;
const stress = 'a'.repeat(stressLength);
for (let i = 0; i < patterns.length; i++) {
  fs.writeSync(1, JSON.stringify({ s: i }) + '\\n');
  let outcome;
  try {
    const re = new RegExp(patterns[i], 'i');
    const before = process.cpuUsage();
    re.test(stress);
    const used = process.cpuUsage(before);
    const cpuMs = (used.user + used.system) / 1000;
    if (cpuMs > cpuBudgetMs) {
      outcome = { i, ok: false, reason:
        'pattern used >' + (cpuBudgetMs / 10) + 'ms of CPU on stress input ' +
        '(possible catastrophic backtracking; consider re-anchoring)' };
    } else {
      outcome = { i, ok: true };
    }
  } catch (err) {
    outcome = { i, ok: false, reason: 'invalid regex: ' + err.message };
  }
  fs.writeSync(1, JSON.stringify(outcome) + '\\n');
}
`;
  const result = spawnSync(process.execPath, ["-e", script], {
    input: JSON.stringify({
      patterns,
      stressLength: REDOS_STRESS_LENGTH,
      cpuBudgetMs: STRICT_PER_PATTERN_BUDGET_MS,
    }),
    encoding: "utf8",
    // A startup allowance plus a per-pattern allowance, so the ceiling scales
    // with the batch instead of one fixed number that a long list on a busy
    // machine can exceed with no pattern misbehaving.
    timeout: startupAllowanceMs + patterns.length * STRICT_PER_PATTERN_BUDGET_MS,
    maxBuffer: 16 * 1024 * 1024,
  });

  const results = new Map<number, PatternValidationResult>();
  let started: number | null = null;
  for (const line of (result.stdout ?? "").split("\n")) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line) as { s?: number; i?: number; ok?: boolean; reason?: string };
      if (typeof obj.s === "number") started = obj.s;
      else if (typeof obj.i === "number") {
        results.set(obj.i, { ok: obj.ok === true, reason: obj.reason });
        if (started === obj.i) started = null;
      }
    } catch {
      /* skip malformed line */
    }
  }
  const timedOut = result.signal === "SIGTERM" || result.signal === "SIGKILL";
  return { results, timedOut, inFlight: started !== null && !results.has(started) ? started : null };
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
 * SECURITY WARNING — adversary input.
 *
 * `isInTimeBudget` (and therefore the non-strict {@link validatePattern}
 * default that calls it) is **not** a preemptive ReDoS guard. Node's
 * regex engine has no timeout; this function runs the pattern in-process
 * against a stress input and measures wall-clock elapsed time *after* it
 * returns. A genuinely catastrophic pattern can hang the event loop for
 * seconds-to-minutes before the timer reading even runs, during which
 * nothing else in the process makes progress.
 *
 * As a consequence, the non-strict {@link validatePattern} **must not**
 * be called on adversary-controlled input. Use it only for marker
 * patterns the operator has authored (registry / `engagements.yaml`),
 * which are trusted-by-policy.
 *
 * For any path that takes pattern strings from outside that trust
 * boundary — third-party config, network input, future MCP tool input —
 * use the strict mode of {@link validatePatterns} (`{ strict: true }`),
 * which spawns a subprocess that the parent can preemptively kill on
 * timeout via `SIGTERM`/`SIGKILL`.
 */
function isInTimeBudget(pattern: string, stressLength: number, budgetMs: number): boolean {
  // Best-effort time-bounded check. Node has no preemptive regex timeout, so
  // we rely on the regex engine being well-behaved enough that 'a'-fuzzing
  // against a pathological pattern still returns within seconds (not hours).
  // For genuinely catastrophic patterns this may exceed the budget by a
  // small multiple, which is still survivable. The check exists to flag
  // patterns that show signs of being problematic; it does not guarantee
  // safety against an adversary who controls pattern input.
  const re = new RegExp(pattern, "i");
  const stress = "a".repeat(stressLength);
  // CPU time (user + system), not wall-clock: a descheduled process on a busy
  // machine accrues wall time without doing work, which rejected valid markers.
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
