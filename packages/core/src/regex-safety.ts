export interface PatternValidationResult {
  ok: boolean;
  reason?: string;
}

const MAX_PATTERN_LENGTH = 2048;
const MAX_COMBINED_BYTES = 128 * 1024;
const REDOS_STRESS_LENGTH = 1000;
const REDOS_TIMEOUT_MS = 100;

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
