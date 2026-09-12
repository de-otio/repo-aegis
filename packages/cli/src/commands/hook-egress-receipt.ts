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
//   1. **A receipt must never claim a publish that did not happen.** If the
//      tool output shows the verb failed (`fatal:`, `! [rejected]`,
//      `Permission denied`, …) the line reads `EGRESS FAILED → …` instead.
//      A false receipt is worse than none: it would teach the agent that
//      the push landed and stop it retrying.
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
 * broad: a missed failure produces a receipt for a publish that never
 * happened, which is the one error this hook must not make.
 */
const FAILURE_PATTERNS: readonly RegExp[] = [
  /\bfatal:/,
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
 * The `<local> -> <remote>` evidence git prints for each ref it actually
 * moved: `   main -> main`, ` * [new branch]      topic -> topic`,
 * ` + abc123...def456 main -> main (forced update)`.
 */
function extractPushRefs(output: string): string[] {
  const refs: string[] = [];
  for (const line of output.split("\n")) {
    const m = /(\S+)\s+->\s+(\S+)/.exec(line);
    if (m === null) continue;
    const pair = `${sanitiseRef(m[1]!)} -> ${sanitiseRef(m[2]!)}`;
    if (!refs.includes(pair)) refs.push(pair);
    if (refs.length >= 4) break;
  }
  return refs;
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
function detailFor(intent: EgressIntent, output: string): string {
  if (intent.verb === "git-push") {
    const refs = extractPushRefs(output);
    if (refs.length > 0) {
      return intent.refspec === undefined
        ? refs.join(", ")
        : `${sanitiseRef(intent.refspec)} (${refs.join(", ")})`;
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
 * `repo-aegis hook egress-receipt` — PostToolUse(Bash). Always exits 0:
 * the tool has already run, so there is nothing left to block, and a
 * non-zero exit here would only surface as a spurious tool error.
 */
export async function hookEgressReceipt(): Promise<void> {
  let lines: string[];
  try {
    const stdinText = await readStdin();
    const { command, cwd, toolName, output } = parseHookInput(stdinText);
    if (toolName !== undefined && !SHELL_TOOL_NAMES.has(toolName.toLowerCase())) process.exit(0);
    if (command === undefined) process.exit(0);

    const intents = parseEgressIntents(command);
    if (intents.length === 0) process.exit(0);

    const base = cwd ?? process.cwd();
    const failed = looksFailed(output);
    const registry = registryOrUndefined();

    lines = intents.map(intent => {
      let destination: Destination | null = null;
      try {
        destination = resolveDestinationOffline(intent, base, registry);
      } catch {
        destination = null;
      }
      const detail = detailFor(intent, output);
      return failed
        ? `EGRESS FAILED → ${describeDestinationForReceipt(destination)}: ${detail}`
        : formatReceipt(destination, detail);
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
