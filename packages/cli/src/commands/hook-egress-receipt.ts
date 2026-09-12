// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// `repo-aegis hook egress-receipt` — PostToolUse(Bash) receipt
// (doc/design/egress-guard.md §5).
//
// After a command that published, put ONE line in front of the model
// naming where the bytes went:
//
//   PUBLISHED → <org>/<repo> (<VISIBILITY>, class <class>): <ref | PR #n | tag>
//
// A model that has just pushed to the wrong repository will skim past
// twenty lines of git output; it will not skim past one line that says
// PUBLIC and a name it did not intend. That is the whole mechanism — the
// hook prevents nothing, it makes the destination unmissable seconds after
// the fact rather than 57 minutes later.
//
// Two rules keep the receipt trustworthy:
//
//   1. **A receipt must never claim a publish that did not happen.** That
//      used to be enforced by scanning for failure text (`fatal:`,
//      `! [rejected]`, …) and calling everything else a publish — absence of
//      evidence read as evidence of success. It is not: on a German machine a
//      failed push says `Schwerwiegend:` and `Fehler:`, which no English
//      pattern matches, and `ssh_dispatch_run_fatal: Broken pipe` slipped
//      past `\bfatal:` because `_` is a word character. A push that died at
//      the SSH layer got a `PUBLISHED →` receipt — the one error this hook
//      must not make. So where the tool prints something only a real publish
//      produces, that evidence is now *required*: git's `<src> -> <dst>` ref
//      table (untranslated in every locale, unlike the words around it), the
//      URL `gh pr create` prints. With no such evidence and no failure text
//      the line reads `EGRESS UNCONFIRMED → …`, which is what we actually
//      know. Verbs with no reliable success output keep the old behaviour;
//      for them a failure scan is all there is.
//   2. **Never the payload, never raw git/gh text.** The detail is
//      assembled from extracted refs, an extracted PR number, or an
//      extracted tag — nothing else from the output is repeated.
import {
  describeDestinationForReceipt,
  describeVerb,
  formatReceipt,
  loadRegistry,
  parseEgressIntents,
  resolveDestinationOffline,
  type Destination,
  type EgressIntent,
  type Registry,
} from "@de-otio/repo-aegis-core";

/**
 * Best-effort registry for destination resolution: with it, a destination
 * in an engagement's org is named as customer-coupled; without it the
 * receipt still prints, with the class unknown. Never a reason to fail.
 */
function registryOrUndefined(): Registry | undefined {
  try {
    return loadRegistry();
  } catch {
    return undefined;
  }
}

/** Same tolerant tool-name set as `hook guard-egress`. */
const SHELL_TOOL_NAMES = new Set(["bash", "shell", "run_shell_command"]);

interface HookInput {
  command?: string;
  cwd?: string;
  toolName?: string;
  output: string;
  /**
   * The harness's own verdict on the call, when it ships one: a non-zero
   * exit code or an error flag on the tool response. Worth more than any
   * text pattern — it is a number, not a translated sentence — but not
   * every harness provides it, so it can only ever add certainty.
   */
  toolFailed?: boolean;
}

/** Read stdin to a string. Tool output is larger than a tool input, so 8 MiB (as `scan-bash-output`). */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  const MAX = 8 * 1024 * 1024;
  for await (const chunk of process.stdin) {
    const b = typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer);
    total += b.length;
    if (total > MAX) break;
    chunks.push(b);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function flattenCommand(value: unknown): string | undefined {
  if (typeof value === "string") return value.length > 0 ? value : undefined;
  if (!Array.isArray(value)) return undefined;
  const parts = value.filter((v): v is string => typeof v === "string");
  if (parts.length === 0) return undefined;
  const dashC = parts.findIndex(p => /^-[a-z]*c$/.test(p));
  if (dashC !== -1 && dashC + 1 < parts.length) return parts[dashC + 1];
  return parts.join(" ");
}

/**
 * A harness's structured verdict on the call, if it ships one. Only a
 * definite answer is returned: `undefined` means the response said nothing
 * about success, which is not the same as saying it went well.
 */
function readFailureSignal(response: Record<string, unknown>): boolean | undefined {
  for (const k of ["exit_code", "exitCode", "returnCode", "returncode", "status_code"]) {
    const v = response[k];
    if (typeof v === "number" && Number.isFinite(v)) return v !== 0;
  }
  for (const k of ["is_error", "isError", "error"]) {
    const v = response[k];
    if (typeof v === "boolean") return v;
  }
  const ok = response["success"];
  if (typeof ok === "boolean") return !ok;
  return undefined;
}

/**
 * Tolerant extraction across harness shapes: the command from
 * `tool_input.command` (or a root `command`), and the tool's own output
 * from wherever this harness puts it — the same field sweep
 * `hook-scan-bash-output.ts` performs, because the shapes vary by agent and
 * by version.
 */
function parseHookInput(json: string): HookInput {
  const empty: HookInput = { output: "" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return empty;
  }
  if (!parsed || typeof parsed !== "object") return empty;
  const root = parsed as Record<string, unknown>;
  const out: HookInput = { output: "" };

  const toolName = root["tool_name"];
  if (typeof toolName === "string" && toolName.length > 0) out.toolName = toolName;

  const ti = root["tool_input"];
  if (ti && typeof ti === "object") {
    const command = flattenCommand((ti as Record<string, unknown>)["command"]);
    if (command !== undefined) out.command = command;
  }
  if (out.command === undefined) {
    const command = flattenCommand(root["command"]);
    if (command !== undefined) out.command = command;
  }

  const cwd = root["cwd"];
  if (typeof cwd === "string" && cwd.length > 0) out.cwd = cwd;

  const parts: string[] = [];
  const tr = root["tool_response"];
  if (tr && typeof tr === "object") {
    const trObj = tr as Record<string, unknown>;
    for (const k of ["stdout", "stderr", "output", "content", "result"]) {
      const v = trObj[k];
      if (typeof v === "string" && v.length > 0) parts.push(v);
    }
    const failed = readFailureSignal(trObj);
    if (failed !== undefined) out.toolFailed = failed;
  } else if (typeof tr === "string" && tr.length > 0) {
    parts.push(tr);
  }
  const trText = root["tool_result_text"];
  if (typeof trText === "string" && trText.length > 0) parts.push(trText);
  out.output = parts.join("\n");

  return out;
}

/**
 * Shapes git and gh print when the verb did NOT publish. Deliberately
 * broad — `fatal:` is matched mid-token so that ssh's
 * `ssh_dispatch_run_fatal:` counts, which `\bfatal:` did not.
 *
 * These patterns are English, and git is translated: a German git says
 * `Schwerwiegend:` for `fatal:`, `Fehler:` for `error:` and
 * `[zurückgewiesen]` for `[rejected]`, and nothing here matches any of
 * them. That is why they no longer decide whether a publish happened —
 * they only decide whether a verb with no positive evidence is reported as
 * *failed* or as *unconfirmed*. Both are honest; neither is a receipt.
 */
const FAILURE_PATTERNS: readonly RegExp[] = [
  /fatal:/i,
  /(^|\n)\s*(?:remote:\s*)?error:/i,
  /!\s*\[rejected\]/,
  /!\s*\[remote rejected\]/,
  /\bremote rejected\b/i,
  /\bPermission denied\b/i,
  /\bcould not read\b/i,
];

function looksFailed(output: string): boolean {
  return FAILURE_PATTERNS.some(re => re.test(output));
}

/** Keep an extracted ref printable and bounded; it is the only text taken from git's output. */
function sanitiseRef(ref: string): string {
  // Control characters (an ANSI colour run, a stray CR) are stripped:
  // the receipt is one line and must stay one line.
  const clean = ref.replace(/[\u0000-\u001f\u007f]/g, "");
  return clean.length > 120 ? clean.slice(0, 117) + "..." : clean;
}

/**
 * What git's push status table says happened to each ref. Every line is
 * `<flag> <summary> <src> -> <dst>`, and while the summary is translated
 * (`[neuer Branch]`, `[zurückgewiesen]`) the flag column and the arrow are
 * not — which is what makes this readable in any locale:
 *
 *   `   1a2b3c4..5d6e7f8  main -> main`   (space) updated
 *   ` * [new branch]      topic -> topic` (`*`)   created
 *   ` + abc..def          main -> main`   (`+`)   force-updated
 *   ` ! [rejected]        main -> main`   (`!`)   NOT pushed
 *   ` = [up to date]      main -> main`   (`=`)   nothing to push
 */
interface PushEvidence {
  /** Refs git reports it moved — the only proof bytes actually left. */
  moved: string[];
  /** Refs git reports it refused. A `!` line is a failure in any language. */
  rejected: string[];
  /** The remote already had everything. Nothing published, nothing wrong. */
  upToDate: boolean;
}

function readPushEvidence(output: string): PushEvidence {
  const moved: string[] = [];
  const rejected: string[] = [];
  // git prints this one untranslated (it carries no `_()` in builtin/push.c),
  // so it is safe to read in any locale.
  let upToDate = /(^|\n)\s*Everything up-to-date/.test(output);

  for (const line of output.split("\n")) {
    const m = /(\S+)\s+->\s+(\S+)/.exec(line);
    if (m === null) continue;
    const flagMatch = /^\s*([-+*!=])\s/.exec(line);
    const flag = flagMatch === null ? " " : flagMatch[1]!;
    if (flag === "=") {
      upToDate = true;
      continue;
    }
    const pair = `${sanitiseRef(m[1]!)} -> ${sanitiseRef(m[2]!)}`;
    const bucket = flag === "!" ? rejected : moved;
    if (!bucket.includes(pair) && bucket.length < 4) bucket.push(pair);
  }

  return { moved, rejected, upToDate };
}

/** `https://github.com/<org>/<repo>/pull/<n>` — the URL `gh pr create|edit` prints on success. */
function extractPrNumber(output: string): string | null {
  const m = /https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/pull\/(\d+)/.exec(output);
  return m === null ? null : m[1]!;
}

/** `https://github.com/<org>/<repo>/releases/tag/<tag>` — what `gh release create` prints. */
function extractReleaseTag(output: string): string | null {
  const m = /https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/releases\/tag\/(\S+)/.exec(output);
  return m === null ? null : sanitiseRef(m[1]!);
}

/**
 * What actually travelled, in the fewest characters that identify it: the
 * refs for a push, the PR number for a PR verb, the tag for a release,
 * the verb label otherwise.
 */
function detailFor(intent: EgressIntent, output: string, push: PushEvidence): string {
  if (intent.verb === "git-push") {
    const { moved, rejected } = push;
    // A push can be partly refused. Naming the refs that landed without
    // saying the rest did not would read as "all of it went".
    const suffix = moved.length > 0 && rejected.length > 0 ? `; ${rejected.length} rejected` : "";
    if (moved.length > 0) {
      return intent.refspec === undefined
        ? `${moved.join(", ")}${suffix}`
        : `${sanitiseRef(intent.refspec)} (${moved.join(", ")}${suffix})`;
    }
    return intent.refspec === undefined ? describeVerb(intent.verb) : sanitiseRef(intent.refspec);
  }

  if (intent.verb === "gh-pr-create" || intent.verb === "gh-pr-edit") {
    const n = extractPrNumber(output);
    if (n !== null) return `PR #${n}`;
    return describeVerb(intent.verb);
  }

  if (intent.verb.startsWith("gh-release-")) {
    const tag = extractReleaseTag(output);
    if (tag !== null) return `tag ${tag}`;
    return describeVerb(intent.verb);
  }

  return describeVerb(intent.verb);
}

/**
 * Did the tool print something only a *successful* run of this verb
 * produces? `undefined` means this verb has no such output to look for —
 * `gh issue create` and a mutating `gh api` say nothing a failure could
 * not also say — and for those the failure scan remains the only test
 * available.
 */
function confirmsPublish(
  intent: EgressIntent,
  output: string,
  push: PushEvidence,
): boolean | undefined {
  if (intent.verb === "git-push") {
    return push.moved.length > 0 || push.upToDate;
  }
  if (intent.verb === "gh-pr-create" || intent.verb === "gh-pr-edit") {
    return extractPrNumber(output) !== null;
  }
  if (intent.verb === "gh-release-create") {
    return extractReleaseTag(output) !== null;
  }
  return undefined;
}

/**
 * Evidence of refusal that survives translation: git's `!` flag on a ref
 * line. The sentence beside it (`[rejected]`, `[zurückgewiesen]`) is
 * localised; the flag column is not.
 */
function refused(intent: EgressIntent, push: PushEvidence): boolean {
  return intent.verb === "git-push" && push.rejected.length > 0;
}

/** `PUBLISHED`, `EGRESS FAILED`, or the honest third answer. */
type Outcome = "published" | "failed" | "unconfirmed";

/**
 * Evidence first, failure text second, and silence is never taken for
 * success. A ref that moved outranks a failure message because a partly
 * refused push still published — the bytes are on the remote either way,
 * and that is what a receipt exists to say.
 */
function outcomeFor(
  intent: EgressIntent,
  output: string,
  push: PushEvidence,
  toolFailed: boolean,
): Outcome {
  const confirmed = confirmsPublish(intent, output, push);
  if (confirmed === true) return "published";
  if (toolFailed || refused(intent, push) || looksFailed(output)) return "failed";
  if (confirmed === false) return "unconfirmed";
  return "published";
}

/**
 * `repo-aegis hook egress-receipt` — PostToolUse(Bash). Always exits 0:
 * the tool has already run, so there is nothing left to block, and a
 * non-zero exit here would only surface as a spurious tool error.
 */
export async function hookEgressReceipt(): Promise<void> {
  let lines: string[];
  try {
    const stdinText = await readStdin();
    const { command, cwd, toolName, output, toolFailed } = parseHookInput(stdinText);
    if (toolName !== undefined && !SHELL_TOOL_NAMES.has(toolName.toLowerCase())) process.exit(0);
    if (command === undefined) process.exit(0);

    const intents = parseEgressIntents(command);
    if (intents.length === 0) process.exit(0);

    const base = cwd ?? process.cwd();
    const registry = registryOrUndefined();
    // Read once, so the detail, the confirmation and the refusal check are
    // provably reading the same table.
    const push = readPushEvidence(output);

    lines = intents.map(intent => {
      let destination: Destination | null = null;
      try {
        destination = resolveDestinationOffline(intent, base, registry);
      } catch {
        destination = null;
      }
      const detail = detailFor(intent, output, push);
      const where = describeDestinationForReceipt(destination);
      switch (outcomeFor(intent, output, push, toolFailed === true)) {
        case "failed":
          return `EGRESS FAILED → ${where}: ${detail}`;
        case "unconfirmed":
          // Not a receipt and not a failure — the tool printed neither. The
          // agent is told exactly that, because the alternative is to guess,
          // and guessing "it published" is how a broken pipe got a receipt.
          return `EGRESS UNCONFIRMED → ${where}: ${detail} — nothing in the output confirms it landed; verify before retrying`;
        default:
          return formatReceipt(destination, detail);
      }
    });
  } catch {
    // A receipt is an observation, never an obstacle: any failure here is
    // silent, and the agent simply gets no extra context.
    process.exit(0);
  }

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: lines.join("\n"),
      },
    }) + "\n",
  );
  process.exit(0);
}
