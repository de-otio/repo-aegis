// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// The decision log (complexity-review P1-I): one JSON Lines file, on by default, that says what every entry point
// decided and the facts it decided on, so an agent (or a person) can debug a refusal without rebuilding those facts
// by hand.
//
// THE DESIGN IS THE TYPE. What may reach the file is not policed by a scrubber; it is fixed by the input of
// {@link buildDecisionRecord}:
//   - `DecisionInput` has no free-form string. Every `string` field is validated by a closed regex or enum, and a value
//     that fails becomes the literal `"invalid"` (never dropped silently, never passed through).
//   - there is no `details` / `extra` / `message` field; adding one is a spec change (spec-P1-I §1);
//   - the writer serialises only what the builder returned, and the reader rebuilds every line it reads through the same
//     validators, so a hand-edited file cannot put free text on a terminal either.
// So the never-logged list (tokens, marker patterns and matched text, file contents, command text, env values, URLs,
// filesystem paths, approval and pause reasons, the gh login, hostnames) holds because nothing here can carry them.
//
// WRITING NEVER CHANGES A DECISION. {@link appendDecisionRecord} never throws and never waits longer than the lock
// timeout; it reports where the record went and the caller prints `(logged: …)` or `(not logged)` from that.
import { appendFileSync, chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LockTimeoutError } from "./exceptions.js";
import { withLockSync } from "./lock.js";
import { repoAegisHome, statePath } from "./paths.js";
import { safeDestination } from "./refusal.js";

export const DECISION_LOG_VERSION = 1;
export const DECISION_LOG_FILE = "decisions.jsonl";
export const DECISION_LOG_STATE_FILE = "decision-log.json";
/** The file `gh` shims wrote before the decision log existed; read once as a legacy source, never written. */
export const LEGACY_GH_DECISIONS_FILE = "gh-decisions.jsonl";
/** Rotate the active file at 10 MiB; keep this many rotated files. */
export const DECISION_LOG_ROTATE_BYTES = 10 * 1024 * 1024;
export const DECISION_LOG_KEEP = 3;
/** The longest a writer waits for the lock: a hook waiting on a lock is worse than an over-size file. */
export const DECISION_LOG_LOCK_TIMEOUT_MS = 200;
/** The most a `durationMs` records. */
export const DECISION_MAX_DURATION_MS = 600_000;

export const INVALID = "invalid" as const;

// ---------------------------------------------------------------------------
// Closed vocabularies
// ---------------------------------------------------------------------------

export const DECISION_LAYERS = [
  "pre-commit",
  "pre-push",
  "egress-hook",
  "check-write",
  "scan-after-write",
  "shim",
  "credential-helper",
  "prompt-submit",
  "prompt-approval",
  "pause",
] as const;
export type DecisionLayer = (typeof DECISION_LAYERS)[number];

export const DECISION_HOSTS = ["claude-code", "copilot", "cursor", "antigravity", "git", "terminal", "unknown"] as const;
export type DecisionHost = (typeof DECISION_HOSTS)[number];

export const DECISION_OUTCOMES = ["allow", "ask", "refuse", "fallback", "step-aside", "notice", "inject"] as const;
export type DecisionOutcome = (typeof DECISION_OUTCOMES)[number];

export const DECISION_REF_KINDS = ["branch", "tag", "delete", "new-branch", "other"] as const;
export type DecisionRefKind = (typeof DECISION_REF_KINDS)[number];

/** The identity-choice column names of core/identity-choice.ts. */
export const DECISION_IDENTITY_COLUMNS = ["person", "agent"] as const;
export type DecisionIdentityColumn = (typeof DECISION_IDENTITY_COLUMNS)[number];

export const DECISION_PAUSED = ["no", "machine", "repo"] as const;
export type DecisionPaused = (typeof DECISION_PAUSED)[number];

export const DECISION_SANDBOX_GUESSES = ["claude-sandbox", "agent-no-sandbox", "none"] as const;
export type DecisionSandboxGuess = (typeof DECISION_SANDBOX_GUESSES)[number];

export const DECISION_REGISTRY_STATES = ["plain", "encrypted-unlocked", "encrypted-locked", "missing", "unreadable"] as const;
export type DecisionRegistryState = (typeof DECISION_REGISTRY_STATES)[number];

export const DECISION_HOOKS_PATH_SCOPES = ["global", "repo", "none", "foreign"] as const;
export type DecisionHooksPathScope = (typeof DECISION_HOOKS_PATH_SCOPES)[number];

/** The Claude Code permission modes the hook input carries; any other value is recorded as `other`. */
export const DECISION_PERMISSION_MODES = ["default", "acceptEdits", "plan", "bypassPermissions", "dontAsk", "auto", "other"] as const;
export type DecisionPermissionMode = (typeof DECISION_PERMISSION_MODES)[number];

/** The proxy variables whose NAMES may be recorded (never a value), in both letter cases. */
export const DECISION_PROXY_VARS = [
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "DOCKER_HTTPS_PROXY",
  "DOCKER_HTTP_PROXY",
  "https_proxy",
  "http_proxy",
  "all_proxy",
  "no_proxy",
  "docker_https_proxy",
  "docker_http_proxy",
] as const;
export type DecisionProxyVar = (typeof DECISION_PROXY_VARS)[number];

/** An outcome that must carry a `code`. */
const CODE_REQUIRED: ReadonlySet<DecisionOutcome> = new Set(["refuse", "ask", "fallback", "step-aside"]);

// ---------------------------------------------------------------------------
// Validators (each returns the value, or null when it fails its rule)
// ---------------------------------------------------------------------------

const VERSION_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.]{1,20})?$/;
const CODE_RE = /^[A-Z][A-Z0-9_]{2,63}$/;
const VERB_WORD_RE = /^[a-z][a-z-]{0,30}$/;
const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;
/** The approval id formats of core/egress-approval.ts: a terminal approval (8 hex) or a prompt approval (`p` + 8 hex). */
const APPROVAL_ID_RE = /^p?[0-9a-f]{8}$/;
const TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function inList<T extends string>(list: readonly T[], v: unknown): T | null {
  return typeof v === "string" && (list as readonly string[]).includes(v) ? (v as T) : null;
}

const okVersion = (v: unknown): string | null => (typeof v === "string" && VERSION_RE.test(v) ? v : null);
const okCode = (v: unknown): string | null => (typeof v === "string" && CODE_RE.test(v) ? v : null);
const okApprovalId = (v: unknown): string | null => (typeof v === "string" && APPROVAL_ID_RE.test(v) ? v : null);

/** One to three words, each `/^[a-z][a-z-]{0,30}$/`, joined by single spaces. */
function okVerb(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const words = v.split(" ");
  return words.length >= 1 && words.length <= 3 && words.every(w => VERB_WORD_RE.test(w)) ? v : null;
}

/** `owner/repo` or `owner/*`, lower-case, through {@link safeDestination}. */
function okDestinationText(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const parts = v.split("/");
  if (parts.length !== 2) return null;
  const safe = safeDestination(parts[0]!, parts[1]!);
  return safe !== null && `${safe.org}/${safe.repo}` === v ? v : null;
}

/**
 * The short ref name: `refs/heads/` or `refs/tags/` stripped, then the closed pattern, no `..`, `//` or `@{`, not
 * ending in `.lock` or `/`. U+202E and every other non-ASCII character fail the pattern.
 */
function okRef(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const short = v.replace(/^refs\/(?:heads|tags)\//, "");
  if (!REF_RE.test(short)) return null;
  if (short.includes("..") || short.includes("//") || short.includes("@{")) return null;
  if (short.endsWith(".lock") || short.endsWith("/")) return null;
  return short;
}

// ---------------------------------------------------------------------------
// The input and the record
// ---------------------------------------------------------------------------

/** The facts an entry point decided on. Every value is a boolean or from a closed list. */
export interface DecisionFactsInput {
  /** Names of proxy variables that were set; a name outside {@link DECISION_PROXY_VARS} is not recorded. */
  readonly proxyVarSet?: readonly string[];
  readonly psReadable?: boolean;
  readonly tty?: boolean;
  readonly sandboxGuess?: DecisionSandboxGuess;
  readonly registryState?: DecisionRegistryState;
  readonly hooksPathScope?: DecisionHooksPathScope;
  readonly shimFirst?: boolean;
  /** The host's `permission_mode`; anything not in {@link DECISION_PERMISSION_MODES} is recorded as `other`. */
  readonly permissionMode?: string;
}

/**
 * What an entry point tells the builder. There is deliberately NO free-form field and no index signature: the type
 * checker rejects an extra one (`decision-log.test.ts` pins that with `@ts-expect-error`).
 *
 * `version`, `code`, `verb`, `ref` and `approvalId` are strings checked against a closed pattern; `destination` goes
 * through `safeDestination`. Enum-typed fields are checked again at run time, because JS callers do not honour types.
 */
export interface DecisionInput {
  readonly layer: DecisionLayer;
  readonly outcome: DecisionOutcome;
  /** The running repo-aegis version. */
  readonly version: string;
  /** The injected clock. */
  readonly now: Date;
  readonly host?: DecisionHost;
  readonly code?: string;
  /** The parsed shape: up to three lower-case words (`git push`, `gh pr create`). Never a flag value or an argument. */
  readonly verb?: string;
  /** The destination as parsed owner and repo; `repo: "*"` is an org-level destination. Omit when unresolved. */
  readonly destination?: { readonly org: string; readonly repo: string };
  readonly refKind?: DecisionRefKind;
  readonly ref?: string;
  readonly identityColumn?: DecisionIdentityColumn;
  readonly approvalId?: string;
  readonly pinFallback?: boolean;
  readonly paused?: DecisionPaused;
  readonly durationMs?: number;
  readonly facts?: DecisionFactsInput;
}

export interface DecisionFacts {
  proxyVarSet?: string[];
  psReadable?: boolean;
  tty?: boolean;
  sandboxGuess?: DecisionSandboxGuess | typeof INVALID;
  registryState?: DecisionRegistryState | typeof INVALID;
  hooksPathScope?: DecisionHooksPathScope | typeof INVALID;
  shimFirst?: boolean;
  permissionMode?: DecisionPermissionMode;
  logFallback?: boolean;
}

/** The serialised record (schema v1). Absent means "not known at this entry point", never "false". */
export interface DecisionRecord {
  v: 1;
  ts: string;
  version: string;
  layer: DecisionLayer | typeof INVALID;
  outcome: DecisionOutcome | typeof INVALID;
  host?: DecisionHost | typeof INVALID;
  code?: string;
  verb?: string;
  destination?: string;
  refKind?: DecisionRefKind | typeof INVALID;
  ref?: string;
  identityColumn?: DecisionIdentityColumn | typeof INVALID;
  approvalId?: string;
  pinFallback?: boolean;
  paused?: DecisionPaused | typeof INVALID;
  durationMs?: number;
  facts?: DecisionFacts;
}

const orInvalid = <T extends string>(v: T | null): T | typeof INVALID => (v === null ? INVALID : v);

function buildFacts(f: DecisionFactsInput): DecisionFacts {
  const out: DecisionFacts = {};
  if (Array.isArray(f.proxyVarSet)) {
    const names: string[] = [];
    for (const n of f.proxyVarSet as readonly unknown[]) {
      const known = inList(DECISION_PROXY_VARS, n);
      if (known !== null && !names.includes(known)) names.push(known);
    }
    out.proxyVarSet = names;
  }
  if (typeof f.psReadable === "boolean") out.psReadable = f.psReadable;
  if (typeof f.tty === "boolean") out.tty = f.tty;
  if (f.sandboxGuess !== undefined) out.sandboxGuess = orInvalid(inList(DECISION_SANDBOX_GUESSES, f.sandboxGuess));
  if (f.registryState !== undefined) out.registryState = orInvalid(inList(DECISION_REGISTRY_STATES, f.registryState));
  if (f.hooksPathScope !== undefined) out.hooksPathScope = orInvalid(inList(DECISION_HOOKS_PATH_SCOPES, f.hooksPathScope));
  if (typeof f.shimFirst === "boolean") out.shimFirst = f.shimFirst;
  if (f.permissionMode !== undefined) out.permissionMode = inList(DECISION_PERMISSION_MODES, f.permissionMode) ?? "other";
  return out;
}

/**
 * The one function that decides what a record may hold. Pure: same input, same record. See the file header.
 *
 * `code` is required for `refuse`, `ask`, `fallback` and `step-aside`: a missing or malformed one is recorded as
 * `"invalid"`, so a record of a refusal never lacks the field `log` groups by.
 */
export function buildDecisionRecord(input: DecisionInput): DecisionRecord {
  const outcome = inList(DECISION_OUTCOMES, input.outcome);
  const time = input.now instanceof Date ? input.now.getTime() : Number.NaN;
  const rec: DecisionRecord = {
    v: 1,
    ts: Number.isFinite(time) ? new Date(time).toISOString() : INVALID,
    version: okVersion(input.version) ?? INVALID,
    layer: orInvalid(inList(DECISION_LAYERS, input.layer)),
    outcome: orInvalid(outcome),
  };
  if (input.host !== undefined) rec.host = orInvalid(inList(DECISION_HOSTS, input.host));
  if (input.code !== undefined || (outcome !== null && CODE_REQUIRED.has(outcome))) rec.code = okCode(input.code) ?? INVALID;
  if (input.verb !== undefined) rec.verb = okVerb(input.verb) ?? INVALID;
  if (input.destination !== undefined) {
    const d = input.destination;
    const safe = d !== null && typeof d === "object" && typeof d.org === "string" && typeof d.repo === "string" ? safeDestination(d.org, d.repo) : null;
    rec.destination = safe === null ? INVALID : `${safe.org}/${safe.repo}`;
  }
  if (input.refKind !== undefined) rec.refKind = orInvalid(inList(DECISION_REF_KINDS, input.refKind));
  if (input.ref !== undefined) rec.ref = okRef(input.ref) ?? INVALID;
  if (input.identityColumn !== undefined) rec.identityColumn = orInvalid(inList(DECISION_IDENTITY_COLUMNS, input.identityColumn));
  if (input.approvalId !== undefined) rec.approvalId = okApprovalId(input.approvalId) ?? INVALID;
  if (typeof input.pinFallback === "boolean") rec.pinFallback = input.pinFallback;
  if (input.paused !== undefined) rec.paused = orInvalid(inList(DECISION_PAUSED, input.paused));
  if (typeof input.durationMs === "number" && Number.isFinite(input.durationMs)) {
    rec.durationMs = Math.min(DECISION_MAX_DURATION_MS, Math.max(0, Math.round(input.durationMs)));
  }
  if (input.facts !== undefined && input.facts !== null && typeof input.facts === "object") rec.facts = buildFacts(input.facts);
  return rec;
}

/** `rec` with `facts.logFallback: true`: the writer's own mark that this record went to the fallback file. */
function markFallback(rec: DecisionRecord): DecisionRecord {
  return { ...rec, facts: { ...(rec.facts ?? {}), logFallback: true } };
}

/**
 * Rebuild a record from parsed JSON through the same validators, or null when it is not a decision record. Used by the
 * reader: a file an agent (or anyone) edited cannot show anything the builder would not have written.
 */
export function parseDecisionRecord(raw: unknown): DecisionRecord | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r["v"] !== 1 || typeof r["ts"] !== "string" || !TS_RE.test(r["ts"])) return null;
  const f = r["facts"];
  const facts = f !== null && typeof f === "object" && !Array.isArray(f) ? (f as Record<string, unknown>) : undefined;
  const dest = r["destination"] === undefined ? undefined : okDestinationText(r["destination"]);
  const built = buildDecisionRecord({
    layer: r["layer"] as DecisionLayer,
    outcome: r["outcome"] as DecisionOutcome,
    version: (r["version"] as string) ?? "",
    now: new Date(r["ts"]),
    ...(r["host"] !== undefined && { host: r["host"] as DecisionHost }),
    ...(r["code"] !== undefined && { code: r["code"] as string }),
    ...(r["verb"] !== undefined && { verb: r["verb"] as string }),
    ...(r["destination"] !== undefined && {
      destination: dest === null || dest === undefined ? { org: "!", repo: "!" } : { org: dest.split("/")[0]!, repo: dest.split("/")[1]! },
    }),
    ...(r["refKind"] !== undefined && { refKind: r["refKind"] as DecisionRefKind }),
    ...(r["ref"] !== undefined && { ref: r["ref"] as string }),
    ...(r["identityColumn"] !== undefined && { identityColumn: r["identityColumn"] as DecisionIdentityColumn }),
    ...(r["approvalId"] !== undefined && { approvalId: r["approvalId"] as string }),
    ...(typeof r["pinFallback"] === "boolean" && { pinFallback: r["pinFallback"] }),
    ...(r["paused"] !== undefined && { paused: r["paused"] as DecisionPaused }),
    ...(typeof r["durationMs"] === "number" && { durationMs: r["durationMs"] }),
    ...(facts !== undefined && { facts: facts as DecisionFactsInput }),
  });
  if (facts !== undefined && facts["logFallback"] === true) built.facts = { ...(built.facts ?? {}), logFallback: true };
  return built;
}

// ---------------------------------------------------------------------------
// Paths and the on/off switch
// ---------------------------------------------------------------------------

export function decisionLogPath(home: string = repoAegisHome()): string {
  return join(statePath(home), DECISION_LOG_FILE);
}

export function decisionLogStatePath(home: string = repoAegisHome()): string {
  return join(statePath(home), DECISION_LOG_STATE_FILE);
}

export function legacyGhDecisionsPath(home: string = repoAegisHome()): string {
  return join(statePath(home), LEGACY_GH_DECISIONS_FILE);
}

function uidText(): string {
  try {
    const uid = process.getuid?.();
    return uid === undefined ? "user" : String(uid);
  } catch {
    return "user";
  }
}

/** `<tmp>/repo-aegis-<uid>`: where the log goes when the home cannot be written. `tmp` defaults to `$TMPDIR`. */
export function fallbackDecisionDir(tmp: string = process.env["TMPDIR"] ?? tmpdir()): string {
  return join(tmp, `repo-aegis-${uidText()}`);
}

export function fallbackDecisionLogPath(tmp?: string): string {
  return join(fallbackDecisionDir(tmp), DECISION_LOG_FILE);
}

/**
 * Whether the log is on. It is ON unless `<home>/state/decision-log.json` says `{"enabled": false}`: a missing,
 * unreadable or unparseable file is "on", so a corrupted switch never turns the log off.
 */
export function isDecisionLogEnabled(home: string = repoAegisHome()): boolean {
  try {
    const parsed = JSON.parse(readFileSync(decisionLogStatePath(home), "utf8")) as unknown;
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) return (parsed as Record<string, unknown>)["enabled"] !== false;
  } catch {
    /* absent or unparseable: on */
  }
  return true;
}

/** Write the switch (mode 0600, directory 0700). Throws on an unwritable home: a person at a terminal must hear it. */
export function setDecisionLogEnabled(enabled: boolean, home: string = repoAegisHome()): void {
  const path = decisionLogStatePath(home);
  mkdirSync(statePath(home), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ enabled }, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, path);
}

// ---------------------------------------------------------------------------
// The writer
// ---------------------------------------------------------------------------

/** The file operations the writer uses, so a test can make every one of them throw. */
export interface DecisionLogOps {
  mkdir(dir: string): void;
  /** Append one line; creates the file with mode 0600. */
  append(path: string, line: string): void;
  size(path: string): number;
  rename(from: string, to: string): void;
  /** Run `fn` holding the lock at `lockPath`; throws {@link LockTimeoutError} when it cannot be had at once. */
  lock<T>(lockPath: string, fn: () => T): T;
  /** Whether `dir` may be used as the fallback directory (a plain directory owned by this user). */
  trustedDir(dir: string): boolean;
}

export const realDecisionLogOps: DecisionLogOps = {
  mkdir: dir => void mkdirSync(dir, { recursive: true, mode: 0o700 }),
  append: (path, line) => {
    appendFileSync(path, line, { mode: 0o600 });
    try {
      chmodSync(path, 0o600);
    } catch {
      /* platform-restricted */
    }
  },
  size: path => {
    try {
      return statSync(path).size;
    } catch {
      return 0;
    }
  },
  rename: (from, to) => renameSync(from, to),
  lock: (lockPath, fn) => withLockSync(fn, { lockPath }),
  trustedDir: dir => {
    try {
      const st = lstatSync(dir);
      if (!st.isDirectory()) return false;
      const uid = process.getuid?.();
      return uid === undefined || st.uid === uid;
    } catch {
      return false;
    }
  },
};

export interface AppendOptions {
  /** Rotate at this size. Default {@link DECISION_LOG_ROTATE_BYTES}. */
  rotateBytes?: number;
  /** Lock wait. Default {@link DECISION_LOG_LOCK_TIMEOUT_MS}; never more than that. */
  lockTimeoutMs?: number;
  /** The directory the fallback goes under. Default `$TMPDIR`. */
  tmp?: string;
  ops?: DecisionLogOps;
}

export interface AppendResult {
  written: "primary" | "fallback" | "none";
}

/** Replaced in tests by {@link setDecisionLogOpsForTests}; the default is the real file system. */
let opsOverride: DecisionLogOps | null = null;

/** TEST-ONLY: make every writer in this process use `ops` (a throwing one, say). Pass `null` to restore. Mutates module state. */
export function setDecisionLogOpsForTests(ops: DecisionLogOps | null): void {
  if (process.env["NODE_TEST_CONTEXT"] === undefined) return; // inert outside the test runner
  opsOverride = ops;
}

function sleepSync(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    /* no wait available: the loop's deadline still ends it */
  }
}

/** `<path>` → `<path>.1`, `.1` → `.2`, `.2` → `.3`; the old `.3` is dropped by the rename that replaces it. */
function rotate(path: string, ops: DecisionLogOps): void {
  for (let i = DECISION_LOG_KEEP - 1; i >= 1; i--) {
    try {
      ops.rename(`${path}.${i}`, `${path}.${i + 1}`);
    } catch {
      /* that generation does not exist yet */
    }
  }
  ops.rename(path, `${path}.1`);
}

/**
 * Append `line` to `path`, rotating first when the file is over `rotateBytes`. The lock is taken for at most
 * `timeoutMs`; when it cannot be had, the line is appended WITHOUT rotating (an over-size file is harmless, a hook
 * waiting on a lock is not). Throws only when the append itself fails.
 */
function appendTo(path: string, line: string, o: Required<Pick<AppendOptions, "rotateBytes" | "lockTimeoutMs">>, ops: DecisionLogOps): void {
  const lockPath = `${path}.lockfile`;
  const deadline = Date.now() + o.lockTimeoutMs;
  for (;;) {
    try {
      ops.lock(lockPath, () => {
        if (ops.size(path) >= o.rotateBytes) rotate(path, ops);
        ops.append(path, line);
      });
      return;
    } catch (err) {
      // The append itself failed: nothing was written, and trying again without the lock would fail the same way.
      if (err instanceof AppendFailure) throw err;
      if (err instanceof LockTimeoutError && Date.now() < deadline) {
        sleepSync(10);
        continue;
      }
      // The lock was not had in time, or the lock machinery or the rotation failed: append without rotating.
      break;
    }
  }
  ops.append(path, line);
}

/** Marks an error that came from `ops.append` (the one step whose failure means the record was not written). */
class AppendFailure extends Error {
  constructor(readonly inner: unknown) {
    super("append failed");
  }
}

/**
 * Write one record: the primary file, else the fallback under `$TMPDIR` (with `facts.logFallback: true`), else nothing.
 * NEVER throws, whatever the file system does, and waits at most the lock timeout. Does nothing, and says `none`, when
 * the log is switched off.
 */
export function appendDecisionRecord(home: string, rec: DecisionRecord, opts: AppendOptions = {}): AppendResult {
  try {
    if (!isDecisionLogEnabled(home)) return { written: "none" };
    const ops = opts.ops ?? opsOverride ?? realDecisionLogOps;
    const o = {
      rotateBytes: opts.rotateBytes ?? DECISION_LOG_ROTATE_BYTES,
      lockTimeoutMs: Math.min(opts.lockTimeoutMs ?? DECISION_LOG_LOCK_TIMEOUT_MS, DECISION_LOG_LOCK_TIMEOUT_MS),
    };
    const wrapped: DecisionLogOps = {
      ...ops,
      append: (p, l) => {
        try {
          ops.append(p, l);
        } catch (e) {
          throw new AppendFailure(e);
        }
      },
    };
    try {
      ops.mkdir(statePath(home));
      appendTo(decisionLogPath(home), JSON.stringify(rec) + "\n", o, wrapped);
      return { written: "primary" };
    } catch {
      /* fall through to the fallback */
    }
    try {
      const dir = fallbackDecisionDir(opts.tmp);
      ops.mkdir(dir);
      if (!ops.trustedDir(dir)) return { written: "none" };
      appendTo(join(dir, DECISION_LOG_FILE), JSON.stringify(markFallback(rec)) + "\n", o, wrapped);
      return { written: "fallback" };
    } catch {
      return { written: "none" };
    }
  } catch {
    return { written: "none" };
  }
}

/** Build and write in one step; the entry points' common call. Never throws. */
export function recordDecisionTo(home: string, input: DecisionInput, opts: AppendOptions = {}): AppendResult {
  try {
    return appendDecisionRecord(home, buildDecisionRecord(input), opts);
  } catch {
    return { written: "none" };
  }
}

// ---------------------------------------------------------------------------
// The reader
// ---------------------------------------------------------------------------

export interface LoggedDecision {
  record: DecisionRecord;
  source: "primary" | "fallback" | "legacy";
}

function readLines(path: string): string[] {
  try {
    return readFileSync(path, "utf8").split("\n");
  } catch {
    return [];
  }
}

function readJsonl(path: string, source: "primary" | "fallback"): LoggedDecision[] {
  const out: LoggedDecision[] = [];
  for (const line of readLines(path)) {
    if (line === "") continue;
    try {
      const rec = parseDecisionRecord(JSON.parse(line) as unknown);
      if (rec !== null) out.push({ record: rec, source });
    } catch {
      /* a torn or foreign line is skipped */
    }
  }
  return out;
}

/** A record of the old `gh-decisions.jsonl` as a v1 record: `decision` is the outcome, `column` the identity column. */
function legacyToRecord(raw: unknown): DecisionRecord | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r["ts"] !== "string") return null;
  const t = Date.parse(r["ts"]);
  if (!Number.isFinite(t)) return null;
  const verb = typeof r["verb"] === "string" ? r["verb"].replace(/[^a-z-]+/g, " ").trim() : "";
  return buildDecisionRecord({
    layer: "shim",
    outcome: r["decision"] as DecisionOutcome,
    version: "0.0.0",
    now: new Date(t),
    ...(typeof r["code"] === "string" && { code: r["code"] }),
    ...(verb !== "" && { verb }),
    ...(typeof r["owner"] === "string" && typeof r["repo"] === "string" && { destination: { org: r["owner"], repo: r["repo"] } }),
    ...(typeof r["owner"] === "string" && (r["repo"] === null || r["repo"] === undefined) && { destination: { org: r["owner"], repo: "*" } }),
    ...(typeof r["column"] === "string" && { identityColumn: r["column"] as DecisionIdentityColumn }),
    ...(typeof r["approvalId"] === "string" && { approvalId: r["approvalId"] }),
  });
}

export interface ReadOptions {
  tmp?: string;
}

/**
 * Every record this machine holds for the log: the primary file and its rotated generations, the fallback under
 * `$TMPDIR`, and the legacy `gh-decisions.jsonl`, merged by `ts` (oldest first; ties keep read order). Never throws;
 * every line is rebuilt through the validators.
 */
export function readDecisionRecords(home: string = repoAegisHome(), opts: ReadOptions = {}): LoggedDecision[] {
  try {
    const all: LoggedDecision[] = [];
    const primary = decisionLogPath(home);
    for (let i = DECISION_LOG_KEEP; i >= 1; i--) all.push(...readJsonl(`${primary}.${i}`, "primary"));
    all.push(...readJsonl(primary, "primary"));
    const fb = fallbackDecisionLogPath(opts.tmp);
    for (let i = DECISION_LOG_KEEP; i >= 1; i--) all.push(...readJsonl(`${fb}.${i}`, "fallback"));
    all.push(...readJsonl(fb, "fallback"));
    for (const line of readLines(legacyGhDecisionsPath(home))) {
      if (line === "") continue;
      try {
        const rec = legacyToRecord(JSON.parse(line) as unknown);
        if (rec !== null) all.push({ record: rec, source: "legacy" });
      } catch {
        /* skipped */
      }
    }
    return all
      .map((d, i) => ({ d, i }))
      .sort((a, b) => (a.d.record.ts < b.d.record.ts ? -1 : a.d.record.ts > b.d.record.ts ? 1 : a.i - b.i))
      .map(x => x.d);
  } catch {
    return [];
  }
}

/** Whether the fallback holds a record newer than the primary's last one (doctor's `DECISION_LOG_FALLBACK`). */
export function fallbackHoldsNewer(home: string = repoAegisHome(), opts: ReadOptions = {}): boolean {
  const fb = readJsonl(fallbackDecisionLogPath(opts.tmp), "fallback");
  if (fb.length === 0) return false;
  const primary = readJsonl(decisionLogPath(home), "primary");
  const lastPrimary = primary.reduce((m, d) => (d.record.ts > m ? d.record.ts : m), "");
  return fb.some(d => d.record.ts > lastPrimary);
}

/**
 * Whether a record can be written at all, tried without writing one: the primary state directory, else the fallback
 * directory, can be created and written to. Used by doctor (`DECISION_LOG_UNWRITABLE`).
 */
export function decisionLogWritable(home: string = repoAegisHome(), opts: ReadOptions = {}): "primary" | "fallback" | "none" {
  const probe = (dir: string): boolean => {
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const file = join(dir, `.probe-${process.pid}`);
      appendFileSync(file, "", { mode: 0o600 });
      renameSync(file, `${file}.gone`);
      renameSync(`${file}.gone`, file);
      return true;
    } catch {
      return false;
    }
  };
  if (probe(statePath(home))) return "primary";
  return realDecisionLogOps.trustedDir(fallbackDecisionDir(opts.tmp)) || probe(fallbackDecisionDir(opts.tmp)) ? "fallback" : "none";
}
