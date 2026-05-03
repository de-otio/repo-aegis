# @de-otio/repo-aegis-llm

LLM-assisted helpers for [repo-aegis](https://github.com/de-otio/repo-aegis):
Ollama HTTP client, prose extraction, marker-token suggestion
(Phase 2), and per-engagement embedding profiles for the centralised
semantic sweep (Phase 3).

**Internal — do not depend on this package directly.** It is consumed by
`@de-otio/repo-aegis` (the CLI's `suggest-markers` verb) and
`@de-otio/repo-aegis-scan` (the `--semantic` sweep and
`rebuild-profiles` verb). The deterministic gate code in
`@de-otio/repo-aegis-core` does *not* depend on this package, and the
import-graph guard test in `packages/core/src/import-graph.test.ts`
enforces that.

## What's in here

| Module | Purpose |
|---|---|
| `ollama-client.ts` | `chat`, `embed`, `cosine`. Endpoint validation `[SEC H-1]` (loopback-only by default; `localhost` is DNS-checked to defeat `/etc/hosts` redirection). No retries, no fallbacks. |
| `prose-extraction.ts` | Walks a repo to gather prose for the LLM. Hard-skips secrets / `.git` / `.ssh` / `.aws` / `.gnupg`. `[SEC C-1, H-4]` realpath / TOCTOU defence. `[SEC M-2]` resource caps. |
| `synthesis.ts` | Synthesise word-boundary regexes per token kind (company, codename, person-name, domain, ticket-prefix, account-id). `[SEC M-4]` Unicode-safe boundaries. |
| `filters.ts` | Filter dictionary words, dependency names, existing patterns. |
| `token-extraction.ts` | Token-extraction prompt (`TOKEN_EXTRACTION_PROMPT_V1`). `[SEC C-3]` anti-injection preamble + fence delimiters. Zod-validated response. |
| `profile.ts` | Build, write, read, diff per-engagement embedding profiles. Atomic tmp+fsync+rename `[SEC M-5]`. sha256-stamped manifest `[SEC H-3]`. |

## Why this is a separate package

The deterministic gate (PostToolUse hook, pre-commit hook,
`repo-aegis check`) must run sub-millisecond, offline, and free of
heavy runtime dependencies. Splitting LLM-adjacent code into its own
package keeps `core` lean and makes the hot-path independence property
machine-checkable. See
[`doc/design/zero-config-onboarding.md`](../../doc/design/zero-config-onboarding.md)
for the rationale.

## License

GPL-3.0-or-later. Copyright (C) 2026 Richard Myers and contributors.

A De Otio tool — https://de-otio.org.
