// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// The embedding-based semantic sweep (`run --semantic`, `rebuild-profiles`)
// and the Ollama flags were removed in 0.15.0 along with the LLM package.
// The flags are still parsed (hidden) so that passing one fails with a
// message that says what happened and what to do, instead of commander's
// generic "unknown option".

const REMOVED_SUFFIX =
  "was removed in 0.15.0 (the LLM / semantic-sweep features are gone). " +
  "The regex sweep is unchanged; drop the flag.";

export const REMOVED_REBUILD_PROFILES_MESSAGE =
  "`repo-aegis-scan rebuild-profiles` " +
  REMOVED_SUFFIX.replace("drop the flag", "delete any stored profiles under ~/.config/repo-aegis/profiles/");

/** `run` options that were removed, in the order they are reported. */
const REMOVED_RUN_OPTIONS: ReadonlyArray<readonly [key: string, flag: string]> = [
  ["semantic", "--semantic"],
  ["ollamaEndpoint", "--ollama-endpoint"],
  ["ollamaModel", "--ollama-model"],
  ["ollamaTimeoutMs", "--ollama-timeout-ms"],
  ["allowRemoteOllama", "--allow-remote-ollama"],
  ["semanticMaxBytesPerCandidate", "--semantic-max-bytes-per-candidate"],
];

/** The failure message when `opts` carries a removed flag, else null. */
export function removedRunOptionMessage(opts: object): string | null {
  for (const [key, flag] of REMOVED_RUN_OPTIONS) {
    if ((opts as Record<string, unknown>)[key] !== undefined) return `${flag} ${REMOVED_SUFFIX}`;
  }
  return null;
}
