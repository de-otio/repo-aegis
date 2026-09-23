// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// `repo-aegis egress-check -- <gh args…>` — the decision call behind the
// `gh` shim, and `repo-aegis egress-readback` — the post-publish body
// read-back (doc/design/egress-guard.md §3).
//
// Both halves are shaped by the same rule: **a guard that breaks `gh` gets
// uninstalled.** So `egress-check` has exactly one blocking exit (2, a
// policy deny with the reason on stderr), reserves exit 1 for its own
// faults — which the shim treats as "proceed" — and `egress-readback`
// fails to exit 0 whenever it cannot do its job, because it runs AFTER the
// bytes are public and could only ever be noise at that point.
//
// Neither command ever prints payload content, and neither prints `gh`'s
// stderr: the first would defeat the deny-set, the second leaks the
// destination org/repo into contexts (a tool result, a shared log) where
// the whole design says only byte counts and a name we resolved ourselves
// belong.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  appendAuditRecord,
  decideEgress,
  recordWorkingTree,
  describeDestinationForReceipt,
  describeVerb,
  formatReceipt,
  isHumanPresent,
  loadRegistry,
  parseEgressIntents,
  parseRemoteUrl,
  resolveDestinationOffline,
  type Destination,
  type EgressIntent,
  type Registry,
} from "@de-otio/repo-aegis-core";
import { emitJson, type OutputOptions } from "../format.js";

export interface EgressCheckOptions extends OutputOptions {
  cwd?: string;
}

/**
 * Single-quote one argument for a POSIX shell, so an argv vector can be
 * rebuilt as the command STRING `parseEgressIntents` takes.
 *
 * Single quotes are the only shell quoting with no interior escapes at all:
 * inside them `$`, backticks, backslashes and double quotes are literal.
 * An embedded single quote therefore has to leave the quoting, emit an
 * escaped quote, and re-enter — the classic `'\''`. Getting this wrong in
 * the other direction would be a real defect and not a cosmetic one: a
 * `--body-file` argument containing `$TMPDIR` must arrive at the parser as
 * the literal text `$TMPDIR` (so rule d fires), not as something a shell
 * already expanded or mangled.
 */
export function shellQuote(arg: string): string {
  return `'${arg.split("'").join(`'\\''`)}'`;
}

/** `gh <quoted args>` — the command line the policy parser is given. */
export function buildGhCommand(args: string[]): string {
  return args.length === 0 ? "gh" : `gh ${args.map(shellQuote).join(" ")}`;
}

const EMPTY_REGISTRY: Registry = { engagements: [], alwaysBlock: [] };

/**
 * The registry, or an empty one. Fails OPEN by design: a missing or broken
 * registry must not stop `gh` from working, and the shape rules (relative
 * or mode-dependent payload paths, `cd`-preceded egress, unguarded chains)
 * need no registry at all — they still apply.
 */
function loadRegistryOrEmpty(): Registry {
  try {
    return loadRegistry();
  } catch {
    return EMPTY_REGISTRY;
  }
}

/** Public shape of an allow verdict's destination. Never more than this. */
interface DestinationJson {
  org: string;
  repo: string;
  visibility: string;
  class: string;
  /** Present when the command has a destination nothing offline can name (a GraphQL mutation). */
  unresolved?: string;
}

function destinationJson(d: Destination): DestinationJson {
  if (d.unresolved !== undefined) {
    return { org: d.org, repo: d.repo, visibility: "unknown", class: "unknown", unresolved: d.unresolved };
  }
  return { org: d.org, repo: d.repo, visibility: d.visibility, class: d.class };
}

/** The intents whose body file is worth reading back after publication. */
function readbackFor(intents: EgressIntent[]): { bodyFile: string; verb: string } | null {
  for (const intent of intents) {
    if (intent.verb !== "gh-pr-create" && intent.verb !== "gh-pr-edit") continue;
    const files = intent.payloadFiles.filter(f => f !== "-");
    // Exactly one: with several payload files there is no single body to
    // diff the PR against, and guessing would produce a false mismatch —
    // the one outcome that would teach an operator to ignore the check.
    if (files.length !== 1 || intent.payloadFiles.length !== 1) continue;
    return { bodyFile: files[0]!, verb: intent.verb };
  }
  return null;
}

export function egressCheck(args: string[], opts: EgressCheckOptions): void {
  const cwd = opts.cwd ?? process.cwd();
  let intents: EgressIntent[];
  try {
    intents = parseEgressIntents(buildGhCommand(args));
  } catch (err) {
    return internalError(`could not parse the gh command line: ${(err as Error).message}`);
  }

  const registry = loadRegistryOrEmpty();
  // Write-through into the machine-wide destination cache (see
  // `hook guard-egress`): a command judged from inside a repository leaves
  // that repository's declaration where a later command from elsewhere can
  // find it. Best-effort.
  recordWorkingTree(cwd);
  let decision;
  try {
    decision = decideEgress({
      intents,
      cwd,
      registry,
      humanPresent: isHumanPresent(),
      // A shell has no prompt to offer, so `ask` degrades to `deny` in core.
      capabilities: { ask: false },
    });
  } catch (err) {
    return internalError(`egress policy failed: ${(err as Error).message}`);
  }

  if (decision.action === "deny" || decision.action === "ask") {
    process.stderr.write(
      JSON.stringify({
        code: decision.code,
        error: decision.reason,
        details: {
          verb: describeVerb(decision.intent.verb),
          ...(decision.destination && { destination: destinationJson(decision.destination) }),
        },
      }) + "\n",
    );
    process.exit(2);
  }

  // Allowed. Resolve the destination for the receipt and the JSON verdict —
  // best-effort, and never a reason to fail: the policy has already decided.
  let destination: Destination | null = null;
  const first = intents[0];
  if (first !== undefined) {
    try {
      destination = resolveDestinationOffline(first, cwd, registry);
    } catch {
      destination = null;
    }
  }

  if (decision.action === "allow" && decision.approval !== undefined) {
    try {
      appendAuditRecord({
        action: "egress-approval-use",
        cwd,
        details: {
          id: decision.approval.id,
          layer: "gh shim",
          ...(decision.intent && { verb: describeVerb(decision.intent.verb) }),
          ...(decision.destination && { destination: `${decision.destination.org}/${decision.destination.repo}` }),
        },
      });
    } catch {
      /* audit must not block the allow */
    }
  }

  const readback = readbackFor(intents);
  // §5: the one line the model will not skim past — but a receipt must never
  // claim a publish that did not happen, and at this point nothing has run.
  // So the two possible lines travel in the verdict, and the shim prints
  // exactly one of them AFTER the real `gh` has returned, keyed on its exit
  // code. (Until v0.9.2 this command printed `PUBLISHED →` here, before
  // `gh` ran: a `gh release create` that failed with HTTP 422 still got a
  // receipt.) Only for a command that actually publishes, so `gh pr view`
  // carries none.
  const detail =
    first === undefined
      ? undefined
      : `${describeVerb(first.verb)}${first.refspec !== undefined ? ` ${first.refspec}` : ""}`;
  emitJson({
    action: "allow",
    ...(destination && { destination: destinationJson(destination) }),
    ...(decision.action === "allow" &&
      decision.approval !== undefined && {
        approval: { id: decision.approval.id, expiresAt: decision.approval.expiresAt },
      }),
    ...(readback && { readback }),
    ...(detail !== undefined && {
      receipt: formatReceipt(destination, detail),
      failedReceipt: `EGRESS FAILED → ${describeDestinationForReceipt(destination)}: ${detail}`,
    }),
  });
}

/** Exit 1: a fault in the guard, which the shim treats as "proceed". */
function internalError(message: string): never {
  process.stderr.write(`repo-aegis egress-check: ${message}\n`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// egress-readback
// ---------------------------------------------------------------------------

export interface EgressReadbackOptions extends OutputOptions {
  cwd?: string;
  bodyFile?: string;
  pr?: string;
  repo?: string;
  gh?: string;
  timeoutMs?: number;
}

const PR_URL_RE = /https?:\/\/[^\s/]*github\.com\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)\/pull\/(\d+)/;

interface PrRef {
  number: string;
  org?: string;
  repo?: string;
}

/**
 * `--pr` is whatever `gh` printed. That is a URL today, was a bare number
 * in older versions, and is a URL buried in several lines of progress
 * output when `gh` feels chatty — so accept all three rather than make the
 * shim parse `gh`'s output format.
 */
export function parsePrRef(value: string | undefined): PrRef | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return { number: trimmed };
  const m = PR_URL_RE.exec(value);
  if (m) return { number: m[3]!, org: m[1]!.toLowerCase(), repo: m[2]!.toLowerCase() };
  return null;
}

function originRepo(cwd: string): string | null {
  try {
    const url = execFileSync("git", ["config", "--get", "remote.origin.url"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const parsed = url === "" ? null : parseRemoteUrl(url);
    return parsed ? `${parsed.org}/${parsed.repo}` : null;
  } catch {
    return null;
  }
}

/**
 * CRLF→LF, then every trailing newline off each side. Whether GitHub keeps
 * the file's final newline is not something to rely on — `gh pr create
 * --body-file` has been seen storing it — and `--jq .body` appends one more
 * of its own. Stripping exactly one per side (0.10.2 and earlier) turned
 * "GitHub kept it" into a one-byte PUBLISHED_BODY_MISMATCH on every publish of
 * a newline-terminated file, and a check that cries wolf every time is a
 * check nobody reads. A difference in trailing newlines alone is not a
 * difference anyone needs to be told about.
 */
function normaliseBody(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\n+$/, "");
}

/** Exit 0 and say why: the read-back is best-effort and never fails a publish. */
function unavailable(reason: string): never {
  process.stderr.write(JSON.stringify({ code: "READBACK_UNAVAILABLE", reason }) + "\n");
  process.exit(0);
}

export function egressReadback(opts: EgressReadbackOptions): void {
  const cwd = opts.cwd ?? process.cwd();

  if (opts.bodyFile === undefined) return unavailable("no --body-file given");
  let fileBody: string;
  try {
    fileBody = normaliseBody(readFileSync(opts.bodyFile, "utf8"));
  } catch {
    // The path is deliberately not echoed: it is the one string here that
    // could carry a project or customer name.
    return unavailable("the body file could not be read");
  }

  const ref = parsePrRef(opts.pr);
  if (ref === null) return unavailable("no PR number or URL could be identified from gh's output");

  const repo = opts.repo ?? (ref.org && ref.repo ? `${ref.org}/${ref.repo}` : null) ?? originRepo(cwd);
  if (repo === null) return unavailable("no destination repository could be identified");

  let published: string;
  try {
    published = execFileSync(
      opts.gh ?? "gh",
      ["pr", "view", ref.number, "--repo", repo, "--json", "body", "--jq", ".body"],
      {
        cwd,
        encoding: "utf8",
        timeout: opts.timeoutMs ?? 10_000,
        // Piped, never inherited: gh's stderr names the org/repo it failed
        // on, and this command's whole contract is that only byte counts and
        // a destination we resolved ourselves are ever printed.
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  } catch {
    return unavailable("gh could not read the published body back");
  }

  const publishedBody = normaliseBody(published);
  const publishedBytes = Buffer.byteLength(publishedBody, "utf8");
  const fileBytes = Buffer.byteLength(fileBody, "utf8");

  if (publishedBody === fileBody) {
    emitJson({ ok: true, bytes: fileBytes });
    return;
  }

  // Byte counts only. Printing either body — or a diff of them — would put
  // the very content the destination's deny set exists to keep out into a
  // terminal, a tool result and possibly a CI log.
  process.stderr.write(
    JSON.stringify({
      code: "PUBLISHED_BODY_MISMATCH",
      error:
        `the published PR body is not the file that was passed to gh. The bytes are already public; ` +
        `compare them yourself and edit or close the PR.`,
      details: { publishedBytes, fileBytes, pr: Number(ref.number), repo },
    }) + "\n",
  );
  process.exit(1);
}
