// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// `repo-aegis suggest-markers` (P2-B-2) — LLM-assisted marker discovery.
//
// Pipeline: prose-extraction → token-extraction (Ollama) → synthesis
// → filters → user review → addMarkerPattern. Off the deterministic
// gate path; this verb only runs when the user explicitly invokes it.
//
// All security findings tagged at the call site or in the underlying
// modules. The verb itself adds:
//   - [SEC H-2] auto-accept identity guard (cross-check vs personalOrgs / $USER)
//   - [SEC H-6] audit-log path redaction (sourceBasename instead of full path)

import { existsSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import {
  loadRegistry,
  addMarkerPatterns,
  appendAuditRecord,
  PatternValidationError,
  EngagementNotFoundError,
} from "@de-otio/repo-aegis-core";
import {
  extractProse,
  extractTokens,
  synthesizeMarker,
  filterDictionary,
  filterExistingPatterns,
  filterDependencyNames,
  type OllamaConfig,
  type TokenT,
  type ExtractedToken,
} from "@de-otio/repo-aegis-llm";
import {
  emitJson,
  emitText,
  emitError,
  type OutputOptions,
} from "../format.js";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface SuggestMarkersOptions extends OutputOptions {
  engagement: string;
  from?: string;
  model?: string;
  endpoint?: string;
  allowRemoteModel?: boolean;
  acceptRemoteAuthorDomains?: boolean;
  /**
   * Numeric threshold in [0, 1]. Tokens with confidence >= this value
   * are auto-accepted (subject to the [SEC H-2] identity guard); the
   * rest are dropped. Setting this disables interactive review.
   */
  autoAcceptAbove?: number;
  /** Print candidates and exit 0 without persisting. */
  dryRun?: boolean;
  /**
   * Override registry path; passed through to addMarkerPatterns.
   * Test-facing, not exposed via Commander.
   */
  registryPath?: string;
}

const DEFAULT_OLLAMA_ENDPOINT = "http://127.0.0.1:11434";
const DEFAULT_OLLAMA_MODEL = "llama3.2:3b";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface Candidate {
  token: ExtractedToken;
  pattern: string;
}

/**
 * Convert ExtractedToken → Candidate by running synthesis. Drops tokens
 * that synthesis rejects (e.g. invalid kind/format combinations).
 */
function synthesizeCandidates(tokens: ExtractedToken[]): {
  candidates: Candidate[];
  dropped: Array<{ token: string; reason: string }>;
} {
  const candidates: Candidate[] = [];
  const dropped: Array<{ token: string; reason: string }> = [];
  for (const t of tokens) {
    const pattern = synthesizeMarker(t.token, t.kind);
    if (pattern === null) {
      dropped.push({
        token: t.token,
        reason: `synthesis rejected ${t.kind} token`,
      });
      continue;
    }
    candidates.push({ token: t, pattern });
  }
  return { candidates, dropped };
}

/**
 * [SEC H-2] Identity guard for `--auto-accept-above`. Checks each
 * candidate against the user's personal-orgs list and $USER /
 * $HOME-basename. Matching candidates are downgraded — they cannot
 * be auto-accepted; in non-interactive mode they are dropped (since
 * we can't prompt).
 */
function isUserIdentityToken(token: string, personalOrgs: string[]): boolean {
  const lower = token.toLowerCase();
  if (personalOrgs.includes(lower)) return true;
  const user = process.env["USER"];
  if (user && lower === user.toLowerCase()) return true;
  const home = process.env["HOME"];
  if (home && lower === basename(home).toLowerCase()) return true;
  return false;
}

/**
 * [SEC C-2] tail of: determine whether the configured Ollama endpoint
 * is non-loopback. Used to wire the prose-extraction author-domain
 * remote-egress guard.
 */
function isLoopbackEndpoint(endpoint: string): boolean {
  try {
    const url = new URL(endpoint);
    const host = url.hostname.toLowerCase();
    return (
      host === "127.0.0.1" ||
      host === "::1" ||
      host === "::ffff:127.0.0.1" ||
      host === "0.0.0.0" ||
      host === "localhost" ||
      host === "[::1]"
    );
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function suggestMarkers(opts: SuggestMarkersOptions): Promise<void> {
  if (!opts.engagement) {
    emitError(
      { code: "USAGE", error: "suggest-markers requires --engagement <id>" },
      opts,
    );
  }

  const fromPath = resolve(opts.from ?? process.cwd());
  if (!existsSync(fromPath) || !statSync(fromPath).isDirectory()) {
    emitError(
      {
        code: "USAGE",
        error: `--from path does not exist or is not a directory: ${fromPath}`,
      },
      opts,
    );
  }

  const endpoint = opts.endpoint ?? DEFAULT_OLLAMA_ENDPOINT;
  const allowRemote = !!opts.allowRemoteModel;

  // Confirm the endpoint vs allowRemote consistency up front.
  if (!isLoopbackEndpoint(endpoint) && !allowRemote) {
    emitError(
      {
        code: "REMOTE_DISALLOWED",
        error:
          `endpoint ${endpoint} is non-loopback; pass --allow-remote-model ` +
          `to opt in (with the security implications: customer prose data ` +
          `will be sent to ${endpoint})`,
      },
      opts,
    );
  }

  const ollamaCfg: OllamaConfig = {
    endpoint,
    model: opts.model ?? DEFAULT_OLLAMA_MODEL,
    timeoutMs: 60_000,
    allowRemote,
  };

  // 1. Extract prose.
  let bundle;
  try {
    bundle = await extractProse({
      root: fromPath,
      gitLogAuthors: true,
      ...(opts.allowRemoteModel && { intendedRemoteEndpoint: endpoint }),
      allowRemoteAuthorDomains: !!opts.acceptRemoteAuthorDomains,
    });
  } catch (err) {
    emitError(
      {
        code: "PROSE_EXTRACTION_FAILED",
        error: (err as Error).message,
      },
      opts,
    );
  }

  if (!opts.json) {
    emitText(
      `prose: ${bundle.files.length} files, ${bundle.authorDomains.length} author domain(s)`,
    );
  }

  // 2. Token extraction (Ollama call).
  let tokens;
  try {
    const result = await extractTokens(bundle, ollamaCfg);
    tokens = result.tokens;
  } catch (err) {
    emitError(
      {
        code: "TOKEN_EXTRACTION_FAILED",
        error: (err as Error).message,
      },
      opts,
    );
  }

  // 3. Synthesize regexes.
  const { candidates, dropped: synthDropped } = synthesizeCandidates(tokens);

  // 4. Run filters.
  const reg = loadRegistry();
  const personalOrgs = (reg.personalOrgs ?? []).map(o => o.toLowerCase());
  const allExistingPatterns = reg.engagements.flatMap(e => e.markers);

  // Filters operate on token-shaped values; produce TokenT[] for them.
  const tokensForFilters: TokenT[] = candidates.map(c => ({
    token: c.token.token,
    kind: c.token.kind,
    confidence: c.token.confidence,
    ...(c.token.sourceFile !== undefined && { sourceFile: c.token.sourceFile }),
  }));

  let filtered = filterDictionary(tokensForFilters);
  filtered = filterExistingPatterns(
    filtered,
    candidates.map(c => c.pattern),
    // Note: filters' filterExistingPatterns compares the candidate's
    // *token* against the existing patterns list. We want the
    // synthesised regex compared against existing markers. Adjust:
  ).filter(t => {
    const cand = candidates.find(c => c.token.token === t.token);
    if (!cand) return false;
    return !allExistingPatterns.includes(cand.pattern);
  });
  filtered = filterDependencyNames(filtered, fromPath);

  // Reduce back to Candidate set (preserving the original synthesis pattern).
  const survivors: Candidate[] = filtered
    .map(t => candidates.find(c => c.token.token === t.token))
    .filter((c): c is Candidate => c !== undefined);

  if (survivors.length === 0) {
    if (opts.json) {
      emitJson({
        action: "suggest-markers",
        engagement: opts.engagement,
        candidates: [],
        accepted: [],
        skipped: synthDropped,
      });
      return;
    }
    emitText("no candidate markers survived filtering");
    return;
  }

  // 5. Decide which candidates to accept (auto vs dry-run vs interactive).
  let accepted: Candidate[] = [];
  const identityRejected: Candidate[] = [];

  if (opts.dryRun) {
    // Dry-run: print, don't persist.
    if (opts.json) {
      emitJson({
        action: "suggest-markers",
        engagement: opts.engagement,
        dryRun: true,
        candidates: survivors.map(c => ({
          token: c.token.token,
          kind: c.token.kind,
          confidence: c.token.confidence,
          pattern: c.pattern,
          ...(c.token.sourceFile !== undefined && { sourceFile: c.token.sourceFile }),
        })),
      });
      return;
    }
    emitText(`dry-run: ${survivors.length} candidate(s):`);
    for (const c of survivors) {
      emitText(
        `  [${c.token.confidence.toFixed(2)}] ${c.token.kind.padEnd(14)} → ${c.pattern}`,
      );
    }
    return;
  }

  if (typeof opts.autoAcceptAbove === "number") {
    // Auto-accept path. [SEC H-2] identity guard.
    const threshold = opts.autoAcceptAbove;
    for (const c of survivors) {
      if (c.token.confidence < threshold) continue;
      if (isUserIdentityToken(c.token.token, personalOrgs)) {
        identityRejected.push(c);
        continue;
      }
      accepted.push(c);
    }
  } else {
    // Without --auto-accept-above and without TTY interactivity, we
    // can't prompt. Provide the safe default: print candidates and
    // require the user to re-run with explicit acceptance. This is
    // less convenient than a TTY checkbox UI but avoids surprising
    // mutations.
    if (opts.json) {
      emitJson({
        action: "suggest-markers",
        engagement: opts.engagement,
        review: "required",
        message:
          "interactive TTY review not supported in this MVP; pass --auto-accept-above <N> or --dry-run",
        candidates: survivors.map(c => ({
          token: c.token.token,
          kind: c.token.kind,
          confidence: c.token.confidence,
          pattern: c.pattern,
        })),
      });
      return;
    }
    emitText("review-required: interactive TTY review not yet supported.");
    emitText(
      "  options: pass --auto-accept-above <N> to auto-accept above a threshold,",
    );
    emitText("           or --dry-run to print candidates without persisting.");
    for (const c of survivors) {
      emitText(
        `  [${c.token.confidence.toFixed(2)}] ${c.token.kind.padEnd(14)} → ${c.pattern}`,
      );
    }
    return;
  }

  // 6. Persist accepted patterns.
  if (accepted.length === 0) {
    if (opts.json) {
      emitJson({
        action: "suggest-markers",
        engagement: opts.engagement,
        accepted: [],
        identityRejected: identityRejected.map(c => c.token.token),
      });
      return;
    }
    emitText("no candidates met threshold (or all were identity-filtered)");
    return;
  }

  let result;
  try {
    result = addMarkerPatterns(
      opts.engagement,
      accepted.map(c => c.pattern),
      {
        ...(opts.registryPath !== undefined && { registryPath: opts.registryPath }),
        source: "suggest-markers",
      },
    );
  } catch (err) {
    if (err instanceof EngagementNotFoundError) {
      emitError(
        {
          code: err.code,
          error: err.message,
        },
        opts,
      );
    }
    if (err instanceof PatternValidationError) {
      emitError(
        {
          code: err.code,
          error: "synthesised patterns failed validation (defensive guard)",
        },
        opts,
      );
    }
    emitError({ code: "WRITE_FAILED", error: (err as Error).message }, opts);
  }

  // 7. Audit log — [SEC H-6] redaction.
  try {
    appendAuditRecord({
      action: "suggest-markers-run",
      engagement: opts.engagement,
      details: {
        sourceBasename: basename(fromPath),
        modelId: ollamaCfg.model.slice(0, 128),
        endpointHostKind: isLoopbackEndpoint(endpoint) ? "loopback" : "remote",
        candidateCount: survivors.length,
        acceptedCount: result.added.length,
        identityRejectedCount: identityRejected.length,
        promptVersion: 1,
      },
    });
  } catch {
    /* audit log must not break user-facing ops */
  }

  if (opts.json) {
    emitJson({
      action: "suggest-markers",
      engagement: opts.engagement,
      accepted: result.added,
      skippedDuplicates: result.skipped,
      identityRejected: identityRejected.map(c => c.token.token),
      rendered: result.rendered,
    });
    return;
  }
  emitText(
    `accepted ${result.added.length} pattern(s) for ${opts.engagement}` +
      (result.skipped.length > 0
        ? ` (${result.skipped.length} duplicate(s) skipped)`
        : "") +
      (identityRejected.length > 0
        ? ` (${identityRejected.length} identity-rejected)`
        : ""),
  );
}

/**
 * `git rev-parse` helper — used by some integration tests to confirm
 * the cwd is inside a git working tree before treating `--from` as
 * valid. Surfaces here (not in extractProse) because suggest-markers
 * has additional UX needs around the error message.
 */
export function isInsideGitRepo(cwd: string): boolean {
  try {
    execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
    });
    return true;
  } catch {
    return false;
  }
}
