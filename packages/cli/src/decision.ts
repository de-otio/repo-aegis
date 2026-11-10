// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// The entry points' one way to write a decision record (P1-I; core/decision-log.ts has the design). It fills what every
// entry point knows the same way (the version, the clock, the sandbox guess, the proxy variable NAMES, the TTY) and
// hands the rest to core's builder, which is the only thing that decides what a record may hold. It never throws and
// never changes a decision: the caller reads `written` only to word the refusal's trailer.
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DECISION_PROXY_VARS,
  recordDecisionTo,
  repoAegisHome,
  testSeamsEnabled,
  withLogTrailer,
  type DecisionAppendResult,
  type DecisionFactsInput,
  type DecisionHost,
  type DecisionInput,
  type DecisionRegistryState,
  type DecisionSandboxGuess,
} from "@de-otio/repo-aegis-core";
import { psReadableFact } from "./human-presence.js";

let cachedVersion: string | undefined;

/** The running repo-aegis version, from the package.json next to `dist/`; "0.0.0" if it cannot be read (the builder then records it as is). */
export function cliVersion(): string {
  if (cachedVersion !== undefined) return cachedVersion;
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")) as { version?: unknown };
    cachedVersion = typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    cachedVersion = "0.0.0";
  }
  return cachedVersion;
}

/** `claude-sandbox` when SANDBOX_RUNTIME is set; `agent-no-sandbox` for a Claude Code session without it; else `none`. */
export function sandboxGuess(env: NodeJS.ProcessEnv = process.env): DecisionSandboxGuess {
  if ((env["SANDBOX_RUNTIME"] ?? "") !== "") return "claude-sandbox";
  if ((env["CLAUDECODE"] ?? "") !== "" || (env["CLAUDE_CODE_ENTRYPOINT"] ?? "") !== "") return "agent-no-sandbox";
  return "none";
}

/** The names (never the values) of the proxy variables that are set to something. */
export function proxyVarsSet(env: NodeJS.ProcessEnv = process.env): string[] {
  return DECISION_PROXY_VARS.filter(n => (env[n] ?? "") !== "");
}

/** The `--agent` adapter name as the log's closed host list; hosts the list does not name are `unknown`. */
export function hostOfAdapter(name: string): DecisionHost {
  switch (name.toLowerCase()) {
    case "claude":
      return "claude-code";
    case "copilot":
      return "copilot";
    case "cursor":
      return "cursor";
    case "antigravity":
      return "antigravity";
    default:
      return "unknown";
  }
}

/** The registry loader's states as the log's. An encrypted registry is only ever read as ciphertext here: locked. */
export function registryStateFact(state: string): DecisionRegistryState {
  switch (state) {
    case "loaded":
      return "plain";
    case "missing":
      return "missing";
    case "encrypted":
      return "encrypted-locked";
    default:
      return "unreadable";
  }
}

/** `git push` from an egress verb id (`git-push`, `gh-pr-create`): the hyphens become spaces, which the builder's verb rule reads as words. */
export function verbWords(id: string): string {
  return id.replace(/-/g, " ");
}

export interface RecordArgs extends Omit<DecisionInput, "version" | "now"> {
  /** The pinned home (the `gh` shim and the credential helper read a pinned one). Default: the current home. */
  home?: string;
  now?: Date;
}

/** TEST-ONLY clock: `REPO_AEGIS_TEST_NOW` (an ISO time), honoured only under the Node test runner. */
function clock(): Date {
  if (testSeamsEnabled()) {
    const pinned = process.env["REPO_AEGIS_TEST_NOW"];
    if (pinned !== undefined) {
      const d = new Date(pinned);
      if (Number.isFinite(d.getTime())) return d;
    }
  }
  return new Date();
}

/**
 * Write one decision record. Facts the caller does not give are filled with what every process can read for free: the
 * proxy variable names, the sandbox guess, whether stderr is a TTY, and whether the process table was readable (when
 * presence was asked). Returns where the record went; never throws.
 */
export function recordDecision(args: RecordArgs): DecisionAppendResult {
  try {
    const { home, now, ...rest } = args;
    const ps = psReadableFact();
    const facts: DecisionFactsInput = {
      proxyVarSet: proxyVarsSet(),
      sandboxGuess: sandboxGuess(),
      tty: process.stderr.isTTY === true,
      ...(ps !== undefined && { psReadable: ps }),
      ...(rest.facts ?? {}),
    };
    // A relative pinned home (a stale or hand-edited helper line) is never a place to write: the default home is.
    const where = home !== undefined && isAbsolute(home) ? home : repoAegisHome();
    return recordDecisionTo(where, { ...rest, facts, version: cliVersion(), now: now ?? clock() });
  } catch {
    return { written: "none" };
  }
}

/** Record, then return `text` with the log trailer for what happened: the refusal's text is assembled after the write. */
export function recordAndTrail(args: RecordArgs, text: string): string {
  return withLogTrailer(text, recordDecision(args).written);
}
