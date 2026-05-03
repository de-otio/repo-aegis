# Zero-config onboarding — design

> Design doc for the three-phase onboarding overhaul tracked in
> [`plans/zero-config-onboarding.md`](../../plans/zero-config-onboarding.md)
> and the implementation checklist at
> [`plans/zero-config-onboarding-checklist.md`](../../plans/zero-config-onboarding-checklist.md).
>
> Status: design accepted; Phase 1 (org-keyed JIT classification),
> Phase 2 (LLM-assisted marker discovery), and Phase 3 (semantic
> audit sweep) are implemented on `main` and awaiting the next
> release tag.

This document is the source of truth for the *as-designed* shape of:

- Phase 1 — org-keyed engagements + just-in-time classification.
- Phase 2 — LLM-assisted marker discovery (offline, opt-in).
- Phase 3 — semantic audit sweep in the centralised scanner.

It complements [`doc/design/README.md`](README.md) (the as-built design
of the deterministic core). The hot-path properties listed in that
document — redaction, deterministic regex, exit-code stability — remain
load-bearing and **must not regress**. This design adds layers on top
of that core; it never replaces it.

## Goal

Reduce onboarding friction to the point where opening a Claude Code (or
equivalent) session in a new repo is sufficient setup. The agent
identifies the engagement from the git remote, prompts the user at most
once when an unknown org is encountered, and configures the per-repo
gate without further action. Marker lists are bootstrapped with
LLM-suggested candidates the user reviews offline; the gate itself
remains regex.

## Non-goals (locked)

These are baked into the design. Changing them is a semver-major change
and requires a new design doc PR.

| Topic | Decision |
|---|---|
| Hot-path determinism | PostToolUse, pre-commit, pre-push hooks continue to use regex via re2. No semantic similarity, embedding lookup, or LLM judgement on the write/commit path. |
| Hot-path package independence | `@de-otio/repo-aegis-core` and the gate code in `@de-otio/repo-aegis` (the `check` / `hook scan-after-write` / `render` paths) must not transitively import any LLM client. Enforced by an import-graph test. |
| Registry mutation | JIT classification can prompt; it can never silently add engagements or seed markers. The agent-guide rule (no silent registry edits) stays in force. |
| Replacement of existing CLI verbs | All new behaviour is additive. `classify --apply`, `allow`, `engagements add` keep working unchanged for users who prefer them. |
| Network egress | Gate code emits zero network traffic. Phase 2 / Phase 3 may emit traffic only when the user explicitly invokes the verb that does so, and only to endpoints the user configured. Default endpoints are local. |

## Architecture

### Package layout (after this design lands)

```
packages/
├── core/              @de-otio/repo-aegis-core           (unchanged, lean)
│   └── library: registry, deny-set, scan, render, regex-safety, locking
├── cli/               @de-otio/repo-aegis                (gains JIT classify, suggest-markers)
├── scan/              @de-otio/repo-aegis-scan           (gains semantic sweep)
├── mcp/               @de-otio/repo-aegis-mcp            (gains first-touch tool)
├── vscode/            repo-aegis-vscode                  (unchanged)
└── llm/               @de-otio/repo-aegis-llm            (NEW)
    └── library: ollama client, prose extraction,
        token→regex synthesis, embedding profile builder
```

`packages/llm` is a sibling of `core`, not a child. The dependency
direction is one-way: `cli` and `scan` may depend on `llm`; `core`
never does. This keeps the gate evaluation graph LLM-free by
construction.

### Data flow (additions)

```
git remote ──▶ classify ──▶ engagement match ──▶ setClass + addEngagement
                  │
                  └─▶ first-touch MCP tool ──▶ agent prompts user
                                               on unknown org

repo prose ──▶ prose extraction ──▶ Ollama (local) ──▶ tokens
                                                       │
                                                       ▼
                                              token→regex synthesis
                                                       │
                                                       ▼
                                              filter (dictionary,
                                              dedup, dependency)
                                                       │
                                                       ▼
                                            user review (TTY checkbox)
                                                       │
                                                       ▼
                                            engagements.yaml + render

scan queries hit ──▶ embedding ──▶ profile match ──▶ issue (redacted)
```

## Phase 1 — org-keyed engagements + JIT classification

### 1.1 Schema v2

[packages/core/src/schemas.ts](../../packages/core/src/schemas.ts)

Adds two optional fields. v1 files (no new fields) keep parsing.

```yaml
schemaVersion: 2
personalOrgs:                       # NEW: top-level
  - my-handle
  - my-oss-org
always_block: [...]
engagements:
  - id: foo-corp
    name: Foo Corp
    githubOrgs: [foo-corp]          # NEW: per-engagement
    started: 2026-01-01
    markers: [...]
```

Validation rules (enforced in `registryFileSchema`):

1. Every string in `personalOrgs` and `engagements[*].githubOrgs` is
   non-empty, lowercase, and matches `/^[a-z0-9][a-z0-9-]*$/` (GitHub
   org name shape — same constraint GitHub itself enforces).
2. **Disjointness**: no string appears in both `personalOrgs` and any
   `engagements[*].githubOrgs`. An engagement org and a personal org
   are mutually exclusive — overlap is a user error and load-bearing
   for class derivation, so we fail closed at parse time.
3. **Org uniqueness across engagements**: the same org string cannot
   appear in two different engagements' `githubOrgs`. Same reason —
   ambiguous mapping.

Bumping `MAX_SUPPORTED_REGISTRY_SCHEMA_VERSION` from 1 to 2 means a v2
registry is rejected by older repo-aegis builds with the existing
"upgrade required" error. v1 registries are silently treated as if both
new fields were empty arrays (`schemaVersion ?? 1`).

### 1.2 Remote URL parsing

New utility at `packages/core/src/remote-url.ts`. Pure function:

```ts
export interface ParsedRemote {
  host: string;          // "github.com" (after stripping ssh aliases)
  org: string;           // lowercased
  repo: string;          // lowercased; .git suffix stripped
}

export function parseRemoteUrl(raw: string): ParsedRemote | null;
```

Accepted forms (all normalised to the same shape):

- `https://github.com/<org>/<repo>(.git)?`
- `http://github.com/<org>/<repo>(.git)?`  (warned but parsed)
- `git@github.com:<org>/<repo>(.git)?`
- `git@github.com-<alias>:<org>/<repo>(.git)?`  (multi-account ssh)
- `ssh://git@github.com/<org>/<repo>(.git)?`
- `https://<user>@github.com/<org>/<repo>(.git)?`  (credential prefix stripped)

Returns `null` for non-github.com hosts (gitlab, bitbucket, self-hosted)
in v1 of this implementation. A follow-up may extend this — explicitly
deferred to keep Phase 1 narrow.

`parseRemoteUrl` is total and pure — no IO, no exceptions. Failure mode
is `null`. Tests exhaustively enumerate the URL forms above.

### 1.3 Classify (rewritten)

[packages/cli/src/commands/classify.ts](../../packages/cli/src/commands/classify.ts)

Replace the rules-file-driven path with engagement-registry-driven
derivation. The new flow:

1. Read remote URL (`git remote get-url origin`).
2. `parseRemoteUrl(remote)` → `ParsedRemote | null`.
3. Match against the registry:
   - If `parsed.org ∈ personalOrgs` → suggest `class=public-eligible`,
     no engagement.
   - Else if exactly one engagement has `parsed.org ∈ githubOrgs`
     → suggest `class=customer-coupled`, engagement = that engagement's
     id.
   - Else → no match.
4. Apply (when `--apply`) by calling `setClass` and (where applicable)
   `addEngagement`. Audit-log entry as today.

Legacy `classify.yml` precedence (per Phase 1 plan §1.3):

- If `classify.yml` exists *and* the new derivation produces a result,
  the new derivation wins, and stderr emits exactly one warning per
  invocation: *"classify.yml is superseded by engagement registry; run
  `repo-aegis init --migrate-classify` to migrate"*.
- If `classify.yml` exists *and* the new derivation produces no result,
  fall back to the rules file (preserves existing behaviour during
  migration window).
- If `classify.yml` does not exist, derive from registry only.

This keeps existing setups working through the deprecation window.
Removal target: next major version.

### 1.4 `engagements add` extension

[packages/cli/src/commands/engagements-mutate.ts](../../packages/cli/src/commands/engagements-mutate.ts)

Add two flags to the existing `add` verb:

```sh
repo-aegis engagements add --id foo-corp --name "Foo Corp" \
  --github-org foo-corp \
  --personal-org my-handle    # mutually exclusive with --github-org
```

`--github-org` (repeatable) appends to that engagement's `githubOrgs`.
`--personal-org` writes to top-level `personalOrgs` and ignores the
engagement (rejects if combined with `--github-org` on the same
invocation). Validation reuses the schema rules above.

Two-flag UX rather than positional disambiguation: easier to script and
to call via MCP.

### 1.5 First-touch MCP tool

[packages/mcp/src/tools/first-touch.ts](../../packages/mcp/src/tools/first-touch.ts) (new)

Tool name: `aegis_classify_first_touch`. Single MCP tool the agent
calls at session start. Same JSON shapes as the rest of the MCP
surface; runs in-process; no shell, no `--verbose` exposure.

Inputs: none. Uses the MCP client's cwd.

Output (Zod-validated):

```ts
type FirstTouchResult =
  | { status: "already-classified"; class: RepoClass; engagements: string[] }
  | { status: "applied"; class: RepoClass; engagement: string | null }
  | { status: "needs-confirmation"; remote: string; org: string;
      suggestion: { newEngagement: { idHint: string } } |
                  { addToExisting: { engagementId: string } } |
                  { addAsPersonal: true } }
  | { status: "skipped"; reason: "non-git" | "no-remote" | "non-github-host" | "scratch-path" };
```

The tool **never** mutates the registry on its own. `applied` means it
called `setClass` / `addEngagement` on the *repo* (per-repo git
config) — not the registry. `needs-confirmation` is the path that
requires a follow-up MCP call (`aegis_engagement_add`, already
exposed) to mutate the registry, which the agent makes only after the
user confirms.

`idHint` for new-engagement suggestions is derived deterministically
from the org name (lowercased, kebab-cased), with no other PII. The
agent can show it to the user as a starting point.

### 1.6 SessionStart wiring

`repo-aegis install claude-md` gains a new `--first-touch` flag (also
the default when `install claude-md` runs in a clean install) that
adds:

```jsonc
{
  "hooks": {
    "SessionStart": [{
      "matcher": "*",
      "hooks": [{
        "type": "tool",
        "tool": "mcp__repo-aegis__aegis_classify_first_touch"
      }]
    }]
  }
}
```

Idempotent: re-running `install claude-md --first-touch` does not
duplicate the entry. Existing PostToolUse hook configuration is
preserved.

### 1.7 Migration command

`repo-aegis init --migrate-classify`:

1. Reads `~/.config/repo-aegis/classify.yml`.
2. For each rule with `class: public-eligible` and a `match` regex
   that's a literal `github.com[:/]<org>/` pattern: extract `<org>`,
   add to `personalOrgs`.
3. For each rule with `class: customer-coupled` and a literal-org
   pattern + `engagement: <id>`: append `<org>` to that engagement's
   `githubOrgs`.
4. Rules using non-literal regex (e.g. character classes, alternation
   beyond org name) are surfaced to stderr as "could not auto-migrate;
   handle manually" and are not touched.
5. Renames `classify.yml` to `classify.yml.legacy` on success.

Migration is idempotent: re-running on an already-migrated state is a
no-op with stderr summary.

## Phase 2 — LLM-assisted marker discovery

### 2.1 Subpackage layout

```
packages/llm/
├── src/
│   ├── index.ts                public surface
│   ├── ollama-client.ts        thin HTTP wrapper around Ollama API
│   ├── prose-extraction.ts     repo → bag-of-text
│   ├── token-extraction.ts     prompts the model, parses JSON output
│   ├── synthesis.ts            tokens → regex strings
│   └── filters.ts              dictionary / dedup / dependency-name filters
├── tests/                      unit + integration (with mock Ollama)
└── package.json
```

`@de-otio/repo-aegis-llm` is a runtime dependency of `cli` and
(eventually) `scan`. Not a dev dependency: end users invoking
`suggest-markers` need it.

### 2.2 Ollama client

```ts
export interface OllamaConfig {
  endpoint: string;          // default "http://127.0.0.1:11434"
  model: string;             // default "llama3.2:3b"
  timeoutMs: number;         // default 30_000
  allowRemote: boolean;      // default false; required true for non-local endpoint
}

export interface ChatRequest {
  system: string;
  user: string;
  format?: "json";           // uses Ollama's JSON-mode grammar
  options?: { temperature?: number; seed?: number };
}

export interface ChatResponse {
  text: string;
  model: string;
  totalDurationMs: number;
}

export async function chat(req: ChatRequest, cfg: OllamaConfig): Promise<ChatResponse>;
export async function listModels(cfg: OllamaConfig): Promise<string[]>;
```

Network safety:

1. `endpoint` is parsed; if its hostname is anything other than
   `127.0.0.1`, `::1`, or `localhost` and `allowRemote` is false, the
   client throws `RemoteEndpointDisallowedError` before opening a
   connection.
2. `allowRemote` is exposed as `--allow-remote-model` on the CLI verb
   that uses it. The flag emits a stderr warning *every invocation*
   (no per-session suppression) describing what is being sent and to
   where. No silent remote.
3. No retries. A failed call surfaces directly. The user can re-run
   the command; we don't want hidden multi-egress on transient errors.

### 2.3 Prose extraction

Walks a repo and produces a bounded text payload for the model:

- Includes: `README*`, top-level docs (`docs/*.md`, `*.md` up to N=10
  files), `CODEOWNERS`, `package.json` (only `name`, `description`,
  `repository`, `author`, `homepage`), `LICENSE` author lines.
- Per-file size cap (default 16 KiB); total payload cap (default
  128 KiB). Files truncated mid-line with a `... [truncated]` marker.
- Excludes: lockfiles (`package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`,
  `Cargo.lock`, `go.sum`), generated dirs (`dist`, `build`, `coverage`,
  `node_modules`, `.next`, `target`), vendored dirs.
- Author email harvesting: optional second pass over `git log
  --format='%ae'` (last N commits), distinct domains only, capped.
- Output: `{ files: { path: string; content: string; truncated: boolean }[],
  authorDomains: string[] }`.

Pure with respect to file IO; a single function `extractProse(opts:
ProseExtractionOptions): Promise<ProseBundle>`. Does not phone home;
does not invoke the LLM.

### 2.4 Token extraction (model call)

Single fixed system prompt. Versioned: the prompt string is exported
as `TOKEN_EXTRACTION_PROMPT_V1` so changes are visible in diff.

The system prompt asks for output in this exact JSON schema:

```ts
type ExtractedTokens = {
  tokens: Array<{
    token: string;            // exact substring observed
    kind: "company" | "domain" | "ticket-prefix" | "codename"
        | "account-id" | "person-name" | "other";
    confidence: number;       // 0..1
    sourceFile?: string;      // path within the bundle, if attributable
  }>;
};
```

Output is parsed via `safeJsonParse(z.object({...}))`. Malformed JSON,
tokens > 100 chars, or confidence outside [0,1] → drop with a warning.

Determinism: the chat call uses `temperature: 0, seed: 42` by default.
Re-running on the same input produces stable output (modulo Ollama
build differences) and a regression test asserts that a fixed input
+ stub model gives a fixed output.

### 2.5 Token → regex synthesis

```ts
export function synthesizeMarker(token: string, kind: TokenKind): string;
```

Deterministic. The model never produces regex; this function does.
Strategy by kind:

- `company`, `codename`, `person-name`: escape regex metachars; insert
  `[-_ ]?` between camelCase / kebab boundaries; wrap in `\b…\b`.
  E.g. `FooCorp` → `\bfoo[-_ ]?corp\b`.
- `domain`: escape every `.` to `\.`; wrap in `\b…\b` (left) and a
  trailing-boundary that allows path/port. E.g. `foo.example.com`
  → `\bfoo\.example\.com\b`.
- `ticket-prefix`: `\b<PREFIX>-[0-9]+\b`. Reject if PREFIX is not
  `[A-Z][A-Z0-9]+`.
- `account-id`: word-bounded literal. Reject if not `[0-9]{6,16}` (avoids
  matching benign small numbers).
- `other`: word-bounded literal escape. No fancy variants.

Every synthesised regex is passed through `validatePattern` from
`@de-otio/repo-aegis-core` (re2 backend if available). Patterns failing
validation are dropped with a stderr note.

### 2.6 Filters

After synthesis, candidates pass through:

1. **Dictionary filter**: a small bundled English wordlist (10k most
   common). Tokens that are exactly a dictionary word are dropped.
   Avoids "platform", "service", "common" appearing in markers.
2. **Existing-pattern dedup**: skip candidates whose regex is already
   present in any engagement's `markers` (literal string equality).
3. **Dependency-name filter**: skip candidates that exactly match a
   key in `package.json` `dependencies` / `devDependencies` (or
   equivalents in `Cargo.toml`, `go.mod`, `pyproject.toml`). Avoids
   "lodash" or "react" landing in markers.

All three filters are pure functions; tests cover them in isolation.

### 2.7 `suggest-markers` CLI verb

```sh
repo-aegis suggest-markers \
  --engagement <id> \
  --from <path>                       # default: cwd
  [--model <id>]                      # default: llama3.2:3b
  [--endpoint <url>]                  # default: http://127.0.0.1:11434
  [--allow-remote-model]              # required for non-local endpoint
  [--auto-accept-above <0..1>]        # non-interactive mode
  [--dry-run]                         # show, don't write
```

Flow:

1. `extractProse(--from)` → bundle.
2. Show: *"Extracted N files / M KiB / D author domains. Calling
   model. This is local; no network egress."*
3. Token extraction call.
4. Synthesis + filter (dictionary, dependency-name, existing-pattern,
   plus the `[SEC H-2]` user-identity guard).
5. Decide what to do with survivors:
   - `--dry-run` → print candidate table, exit 0, no writes.
   - `--auto-accept-above <T>` → accept candidates with `confidence >= T`
     that pass the identity guard; identity-rejected candidates are
     dropped with a stderr note (cannot be auto-accepted).
   - Neither flag set → print "review-required" with the candidate
     table and exit 0 without mutating. The user re-runs with
     `--auto-accept-above` (or `--dry-run`) once they've reviewed.
6. Approved patterns are appended to the engagement's `markers` via
   `addMarkerPatterns(engagementId, patterns[])` (a single
   `withLock`-guarded core helper) and `render` runs.
7. Audit log records: source basename `[SEC H-6]`, model id, endpoint
   host kind, candidate count, accepted count, identity-rejected count,
   prompt version. **Never** records the literal patterns or tokens.

Exit codes: 0 success (including the review-required path), 2 config
/ endpoint / validation error.

> **Implementation note (MVP).** The "review-required" path above is
> the MVP fallback in place of the originally-designed TTY checkbox
> UI. A future revision may add interactive selection; the structured
> JSON output of the review-required mode is intentionally
> machine-readable so an agent can drive selection on the user's
> behalf in the meantime.

## Phase 3 — semantic audit sweep

### 3.1 Where it lives

In `@de-otio/repo-aegis-scan`, alongside the existing GitHub
code-search runner. New verb: `repo-aegis-scan run --semantic` (or
`--with-embedding`, decided during implementation).

### 3.2 Per-engagement vector profile

Built on demand from each engagement's marker list + a small set of
representative documents the user supplies (or a sample drawn from
`reposActive`). One profile per active engagement:

```ts
interface EngagementProfile {
  engagementId: string;
  vectors: Float32Array[];      // N reference embeddings, N <= 32
  threshold: number;            // cosine; default 0.78, tunable per profile
  modelId: string;              // e.g. "nomic-embed-text"
  createdAt: string;            // ISO-8601
  schemaVersion: 1;
}
```

Profile storage: `~/.config/repo-aegis/profiles/<engagement-id>.json`.
Mode 0600. Schema-versioned. Rebuilt by an explicit
`repo-aegis-scan rebuild-profiles` verb.

### 3.3 Embedding model

Same `OllamaConfig` shape as Phase 2; default model
`nomic-embed-text` (768-dim). The Ollama client gains
`embed(text: string, cfg): Promise<Float32Array>`. Same network-safety
constraints (local-only by default).

### 3.4 Sweep flow

For each candidate document the existing scan finds:

1. Embed the candidate (one Ollama call).
2. For each active engagement profile, compute max cosine similarity
   against any of its reference vectors.
3. If max similarity ≥ threshold, raise as a *semantic hit*
   (separate from regex hits in the issue body).

Issue body redaction unchanged: engagement id only, candidate URL,
similarity score. **Never** the candidate's text content; **never**
the profile's reference content.

Out of scope for v0.4: combining semantic and regex hits into a
unified report. Keep them as separate sections in the output for now.

### 3.5 Why this doesn't violate the non-goal

Phase 3 runs:

- Off-machine of the developer (in CI or on a scheduled job server).
- Asynchronously (no developer waits on it).
- Producing tickets for human review (no commit blocks).

The hot-path non-goal is about per-write / per-commit operations on
the developer's machine. Phase 3 is none of those. The
import-graph guard test confirms `core/scan/check/render/hook` paths
do not transitively import `@de-otio/repo-aegis-llm`.

## Cross-cutting

### Hot-path determinism guard

A new test `packages/core/src/import-graph.test.ts` walks the import
graph from `scan.ts`, `render.ts`, `hook-scan-after-write.ts`, and
fails if any node resolves to a path under `packages/llm/`. Added at
the same time as `packages/llm/` is created so it can never be true.

### Backward compatibility

- v1 `engagements.yaml` (no schemaVersion or schemaVersion 1) parses
  identically to today. `personalOrgs` and `engagements[*].githubOrgs`
  default to `[]`.
- Existing `classify.yml` continues to function during the deprecation
  window (one-warning policy in 1.3).
- Existing CLI verbs unchanged. The `--first-touch` flag defaults
  conservatively (off in `install claude-md` upgrades; on in
  `init`) so an existing `~/.claude/settings.json` is not modified
  without opt-in.
- MCP tool surface is additive. Existing tools unchanged.

### Test strategy

Coverage targets, locked to existing project policy
(`npm run test:cov` enforces 80% lines / 75% branches via c8):

| Package | Lines | Branches |
|---|---|---|
| `core` (incl. new schema fields, remote-url) | 80 | 75 |
| `cli` (incl. new classify, suggest-markers, engagements add flags) | 80 | 75 |
| `mcp` (incl. first-touch tool) | 80 | 75 |
| `scan` (incl. semantic sweep — network code excluded) | 70 | 65 |
| `llm` | 80 | 75 |

Test layering:

1. **Unit** — colocated `*.test.ts`. Pure functions tested in
   isolation. Mocks only at process boundaries (Ollama HTTP calls,
   git subprocess, fs writes). Stubs are typed.
2. **Integration** — scenario tests that run real CLI subcommands
   against a fixture repo with a stubbed Ollama. Lives at
   `packages/cli/src/integration.test.ts`.
3. **Hot-path determinism** — the import-graph test described above.
4. **Schema migration** — fixture-driven test loading old v1 YAML
   files and asserting the parsed Registry has empty `personalOrgs`
   and empty `githubOrgs`.
5. **Locked CLI flag manifest** — extend
   [`packages/cli/src/program.test.ts`](../../packages/cli/src/program.test.ts)
   with the new flags.

### Telemetry / audit

Audit-log additions (subject to existing on/off policy):

- `classify-first-touch` — args: `{ status, org?, engagementId? }`.
- `engagement-add-org` — args: `{ engagementId, orgName }`.
- `engagement-add-personal-org` — args: `{ orgName }`.
- `suggest-markers-run` — args: `{ engagementId, sourcePath,
  modelId, candidateCount, acceptedCount, promptVersion }`.
- `profile-rebuild` — args: `{ engagementId, vectorCount, modelId }`.

Per existing policy: never logs literal markers, tokens, regex
patterns, or document contents.

## Locked decisions for this design

These extend the table in [`doc/design/README.md`](README.md) and are
permanent unless explicitly redesigned.

| Topic | Decision |
|---|---|
| Org → engagement mapping | One-to-many engagement→orgs; orgs are unique across engagements. Conflicts fail at parse time. |
| Personal orgs vs engagement orgs | Disjoint. Same-string overlap is a parse error. |
| Non-github hosts | Phase 1 returns `null` from `parseRemoteUrl`. Out of scope. |
| Migration of `classify.yml` | One-warning-per-invocation deprecation; migration is opt-in via `init --migrate-classify`. |
| First-touch agent prompt | Single MCP tool returns `needs-confirmation`; agent surfaces to user; user-confirmed call to `aegis_engagement_add` mutates the registry. Tool itself never mutates the registry. |
| LLM endpoint default | `http://127.0.0.1:11434` (Ollama default). Non-local endpoints require explicit `--allow-remote-model`. |
| LLM determinism | `temperature: 0, seed: 42` by default. Tests assert reproducibility. |
| LLM output shape | Tokens with kind, never regex. Synthesis is deterministic and lives in trusted code. |
| Profile storage | `~/.config/repo-aegis/profiles/<id>.json`, mode 0600, schema-versioned. |
| Hot-path independence | `core` and gate paths must not import `llm`. Enforced by import-graph test. |
| Audit log redaction | Never logs literal patterns / tokens / document content. Engagement ids and structural metadata only. |
| Network egress in gate path | Forbidden. Gate code is offline-only. |

## Threat model additions

These extend the threat model in [`doc/design/README.md`](README.md).

| Threat | Mitigation |
|---|---|
| LLM endpoint exfiltration via misconfigured `endpoint` | Hostname check before connect. `--allow-remote-model` required for non-local; emits per-invocation stderr warning. |
| Prose extraction sending secrets to the model | Lockfiles, generated dirs, vendored deps explicitly excluded. Per-file and total size caps. `.env*`, `*.pem`, `id_*` excluded by name pattern. |
| Model output containing pathological regex | Model output is tokens, not regex. Synthesis lives in trusted code; every synthesised pattern passes `validatePattern` (re2). |
| Org name confusion (typosquat) | Disjointness checks at parse time. Org match is exact, case-insensitive, post-normalisation. No fuzzy match. |
| Multi-account ssh alias parsing | Explicit unit tests for each alias form. Failure mode of `parseRemoteUrl` is `null`, which leads to `skipped` status, not silent misclassification. |
| First-touch tool auto-applying wrong class | Auto-apply only on unambiguous match (one org → one engagement). Ambiguous cases return `needs-confirmation`. |
| Profile poisoning (a maliciously crafted reference doc skews similarity) | Profile rebuild is explicit (`rebuild-profiles`); reference docs come from `reposActive` paths the user controls. Schema-versioned files; mode 0600. |
| Audit-log size growth from new event types | Existing 10 MiB rotation policy continues to apply. |
| Embedding model returning weights that leak training data | Out of scope for this layer. The embedding model only produces vectors; no document text travels via the embedding API. |
| Timing side-channel in cosine-similarity comparison (theoretical) | Phase 3 sweep runs asynchronously in CI with no user-observable latency signal; no interactive comparison surface. If a future feature exposes per-call similarity timing to an external caller, switch to a constant-time scoring loop. |

## Reference

- Plan: [`plans/zero-config-onboarding.md`](../../plans/zero-config-onboarding.md)
- Implementation checklist: [`plans/zero-config-onboarding-checklist.md`](../../plans/zero-config-onboarding-checklist.md)
- As-built design: [`doc/design/README.md`](README.md)
- Agent operator guide: [`doc/agent-guide.md`](../agent-guide.md)
