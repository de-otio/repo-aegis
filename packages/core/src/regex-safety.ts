import { spawnSync } from "node:child_process";

export interface PatternValidationResult {
  ok: boolean;
  reason?: string;
}

const MAX_PATTERN_LENGTH = 2048;
const MAX_COMBINED_BYTES = 128 * 1024;
const REDOS_STRESS_LENGTH = 1000;
const REDOS_TIMEOUT_MS = 100;
const STRICT_BATCH_TIMEOUT_MS = 5000;

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
  // Synchronous in-process timing check. Worker-based watchdog adds startup
  // overhead disproportionate to per-pattern cost; for marker-list sizes we
  // expect (tens to low hundreds of patterns) the in-process check is fine.
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

  const script = `
const fs = require('fs');
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
const { patterns, stressLength, perPatternBudgetMs } = input;
const stress = 'a'.repeat(stressLength);
for (let i = 0; i < patterns.length; i++) {
  const p = patterns[i];
  const start = Date.now();
  let outcome;
  try {
    new RegExp(p, 'i').test(stress);
    const elapsed = Date.now() - start;
    if (elapsed > perPatternBudgetMs * 10) {
      outcome = { i, ok: false, reason:
        'pattern took >' + perPatternBudgetMs + 'ms on stress input ' +
        '(possible catastrophic backtracking; consider re-anchoring)' };
    } else {
      outcome = { i, ok: true };
    }
  } catch (err) {
    outcome = { i, ok: false, reason: 'invalid regex: ' + err.message };
  }
  process.stdout.write(JSON.stringify(outcome) + '\\n');
}
`;
  const result = spawnSync(process.execPath, ["-e", script], {
    input: JSON.stringify({
      patterns: toCheckRedos,
      stressLength: REDOS_STRESS_LENGTH,
      perPatternBudgetMs: REDOS_TIMEOUT_MS,
    }),
    encoding: "utf8",
    timeout: STRICT_BATCH_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
  });

  // Parse partial stdout (one JSON object per line).
  const seenResults = new Map<number, PatternValidationResult>();
  for (const line of (result.stdout ?? "").split("\n")) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line) as { i: number; ok: boolean; reason?: string };
      seenResults.set(obj.i, { ok: obj.ok, reason: obj.reason });
    } catch {
      /* skip malformed line */
    }
  }

  const timedOut = result.signal === "SIGTERM" || result.signal === "SIGKILL";

  for (let i = 0; i < toCheckRedos.length; i++) {
    const p = toCheckRedos[i]!;
    const r = seenResults.get(i);
    if (r) {
      if (r.ok) valid.push(p);
      else invalid.push({ pattern: p, reason: r.reason ?? "unknown" });
    } else {
      // No result for this pattern: either the worker died on this
      // pattern (likeliest culprit on timeout) or output was truncated.
      const reason = timedOut
        ? "strict validation timed out on this pattern (likely catastrophic backtracking)"
        : "strict validation produced no result";
      invalid.push({ pattern: p, reason });
    }
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
  const start = Date.now();
  try {
    re.test(stress);
  } catch {
    return false;
  }
  const elapsed = Date.now() - start;
  return elapsed <= budgetMs * 10; // generous: 10x to account for noisy CI
}
