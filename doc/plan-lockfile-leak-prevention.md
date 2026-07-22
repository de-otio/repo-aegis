# Implementation plan: lockfile + dotfile leak prevention

> **Status: complete.** All four items below shipped — A/B/C in
> `core: configurable registry allowlist + pip/cargo egress coverage`, D in
> `cli: add scan-env`. Kept as the design record: the rationale for each
> decision, and the alternatives rejected, are not reconstructable from the
> diff. Where the plan and the code disagree, the code won — deviations are
> noted inline below.

Companion to [`handoff-lockfile-leak-prevention.md`](./handoff-lockfile-leak-prevention.md).
That handoff proposed two features. **A follow-up read of `main` shows most of
Feature 1 already shipped in v0.5.0** (the `core/egress` module — "public-repo
egress hygiene"). This plan reconciles the handoff against what exists and lays
out the remaining work.

## What already exists (v0.5.0, do not rebuild)

`packages/core/src/egress.ts` + wiring already delivers the *core* of Feature 1:

- Parsers for `package-lock.json` (v1/v3), `npm-shrinkwrap.json`, `yarn.lock`
  (classic + berry), `pnpm-lock.yaml`, and `.npmrc`.
- `EgressPolicy { allowedHosts }`, `DEFAULT_ALLOWED_REGISTRY_HOSTS`
  (npmjs, yarnpkg, `*.github.com`), `isHostAllowed`, `scanRegistryEgress`.
- Public-facing gate `isPublicFacing()` (class `public-eligible` OR cached
  GitHub visibility `public`); no-op in private repos.
- `check` runs it on staged blob / range tip, independent of the deny set, so
  the pre-commit / pre-push hooks already block it.
- `audit` has a class-gated `registry-egress` check + a `visibility`
  reconciliation check; `status` probes/caches `repo-aegis.visibility`.
- Redaction discipline: `.npmrc` auth values are redacted; hosts are the signal.

The handoff's acceptance test for Feature 1 (a `*.codeartifact.*` `resolved`
URL in a public-class lockfile makes `check --staged` exit 1) **already passes**
for npm. The remaining work is the parts the handoff scoped that v0.5.0 did not
cover.

## Remaining work

| # | Item | Handoff feature | Priority | Status |
|---|------|-----------------|----------|--------|
| A | Config-driven allowlist (`publicRegistries:`) | F1 | HIGH | ✅ done |
| B | pip ecosystem parsers | F1 | HIGH | ✅ done |
| C | cargo ecosystem parser | F1 | MED | ✅ done |
| D | Dotfile auto-ingest (`scan-env`) | F2 | MED | ✅ done |

Do A first — it's small, unblocks legitimate mirrors, and every new parser
(B, C) inherits the same allowlist plumbing. B/C are independent of each other.
D is separable and can land later.

---

## A. Config-driven allowlist (`publicRegistries:`)

**Gap:** `EgressPolicy.allowedHosts` exists but nothing populates it —
`check`/`audit` both call `scanRegistryEgress(inputs)` with the default policy.
A team with a legitimate public mirror has no way to allow it and would have to
disable the check entirely.

**Change:**
1. Add an optional top-level `publicRegistries: string[]` to the engagement
   registry schema (`packages/core/src/schemas.ts`, `registryFileSchema`).
   Each entry is a bare host (`registry.example.com`). Validate as a hostname
   (reject scheme/path/`*` — matching is exact host equality, as
   `isHostAllowed` already does). Keep `.passthrough()` forward-compat.
2. Add `egressPolicyFromRegistry(reg: RegistryFile): EgressPolicy` in
   `egress.ts` (or a thin builder in the CLI) that merges
   `DEFAULT_ALLOWED_REGISTRY_HOSTS` with `reg.publicRegistries ?? []`.
3. Thread it through the two callers:
   - `check.ts`: `scanRegistryEgress(gatherEgressInputs(...), policy)`.
   - `audit.ts` `checkRegistryEgress`: same.
   Load the registry once (both commands already read `RepoConfig`; confirm
   whether `publicRegistries` should be exposed on `RepoConfig` or loaded
   separately via `loadRegistry()`).

**Why registry, not `.repo-aegis.yml`:** the allowlist is a machine/team-wide
fact ("our org runs this mirror"), not a per-repo override, and the registry is
already the home for org-wide config (`always_block`, `personalOrgs`).

**Tests:** registry with `publicRegistries: ['registry.internal.example.com']`
→ a lockfile resolving from that host produces **no** finding; a different
private host still fires. Schema-rejection test for a URL-shaped entry.

## B. pip ecosystem parsers

**Add three shapes** (`egressParserFor` dispatch + parsers in `egress.ts`):

- `poetry.lock` — TOML. Each `[[package]]` may carry a `[package.source]` with
  `url = "..."`; top-level `[[tool.poetry.source]]` / newer `[[package.source]]`
  entries. Extract every `url`, host-check it. Use the existing `yaml`-style
  fail-soft (a TOML parser is needed — see deps note).
- `Pipfile.lock` — JSON. `_meta.sources[].url` (the index URLs) and any
  per-package `index`. Host-check the `sources[].url` values.
- `requirements*.txt` — line-oriented. Flag `--index-url` / `-i` /
  `--extra-index-url` values whose host is not allowlisted. (Note: this catches
  the *config* leak, which is the pip analogue of `.npmrc`; ordinary pinned
  lines carry no host.) Guard the filename match: only `requirements*.txt`, not
  every `*.txt` (the handoff's `*.txt` is too broad and would scan unrelated
  files).

**Public allowlist additions** (pip hosts, added to
`DEFAULT_ALLOWED_REGISTRY_HOSTS` or a pip-specific default set):
`pypi.org`, `files.pythonhosted.org`.

**Deps note:** poetry.lock is TOML; there is no TOML parser in `core` today
(`egress.ts` uses `yaml` for pnpm). Prefer `smol-toml` (small, no native deps)
over a hand-rolled parser — but a line-oriented `url =` extractor is a viable
zero-dep fallback for both `poetry.lock` and `Cargo.lock`, since we only need
URL-shaped values, not a full parse. **Decide dep-vs-regex before coding B/C.**

**Redaction:** an index-url can embed `https://user:token@host/...`. Strip
userinfo before reporting (reuse/extend `hostOf`; report host only, redact the
value like `.npmrc` auth lines).

## C. cargo parser

- `Cargo.lock` — TOML. `[[package]]` entries have a `source = "registry+https://
  github.com/rust-lang/crates.io-index"` or `source = "sparse+https://..."`
  field; a private registry shows as `registry+https://<host>/...` or
  `sparse+https://<host>/`. Strip the `registry+` / `sparse+` / `git+` scheme
  prefix, then host-check. Also check `[source.<name>]` `registry`/`replace-with`
  in a committed `.cargo/config.toml` if in scope (optional; note if deferred).

**Public allowlist additions:** `crates.io`, `static.crates.io`,
`github.com` (already allowed via the `*.github.com` suffix rule — the default
crates.io index lives on `github.com`, so verify the suffix rule covers it and
does not accidentally allow a private GitHub-Enterprise host; GHE hosts are
*not* `*.github.com`, so this is safe).

**go.sum:** out of scope, as the handoff notes — the proxy lives in
`GOPROXY`/env, not the file. Add a one-line comment in `egressParserFor`
documenting the deliberate omission so a future reader doesn't "fix" it.

## D. Dotfile auto-ingest — `scan-env` (Feature 2)

A new **explicit, opt-in** command that reads the developer's toolchain config
and *suggests* private-registry hosts as markers. Model it on `suggest-markers`:
never blind-add, dry-run by default, audit-logged, no interactive TTY required
for the MVP (print candidates + require explicit acceptance flag).

**New module** `packages/core/src/env-scan.ts` — pure parsers, host in, hosts
out. Sources (each a small parser returning `{ source, host, scope? }[]`):

| Source | Fields to read |
|--------|----------------|
| `~/.npmrc`, project `.npmrc` | `registry=`, `@scope:registry=`, `//host/:_authToken` (host only) |
| `~/.config/pip/pip.conf`, `pip.conf` | `index-url`, `extra-index-url` |
| `~/.docker/config.json` | `auths` keys (registry hosts) |
| `~/.m2/settings.xml` | `<mirror><url>`, `<repository><url>` |
| `~/.cargo/config.toml` | `[registries]`, `[source]` URLs |
| `~/.yarnrc.yml` | `npmRegistryServer`, `npmScopes.*.npmRegistryServer` |

Reuse `.npmrc` and `Cargo.lock`/TOML parsing from `egress.ts` where the shape
overlaps (extract shared host-extraction helpers rather than duplicating).

**New CLI command** `packages/cli/src/commands/scan-env.ts`, registered in
`program.ts`. Behavior:
- Collect hosts across all sources, dedupe, drop already-allowlisted public
  hosts (`isHostAllowed`) and any host already covered by an existing marker.
- For each remaining host, offer three placements (handoff §F2):
  (a) a named engagement's markers, (b) a new `privateInfra` marker group
  blocked in public-class repos only, (c) `always_block` (everywhere).
- `--dry-run` (default-safe print), `--auto-accept <placement>` for
  non-interactive use, `--json`. Persist via `addMarkerPattern(s)` /
  a new `always_block`/`privateInfra` writer in `registry-mutate.ts`.
- **Never persist auth tokens** — hosts only. Tokens are already covered by the
  credential-shape `always_block` patterns.
- Audit-log the run with redacted source basenames (mirror `suggest-markers`'s
  `[SEC H-6]` discipline).

**`privateInfra` group:** decide the schema shape. Simplest: a reserved
engagement-like id (e.g. `_private_infra`, analogous to `_always`) whose markers
are gated to public-class repos only in `computeDenySet`. This needs a
`deny-set.ts` change + a cache-schema-version bump (see v0.4.1 changelog for the
precedent — a computed-set change with no marker mtime change must invalidate
the cache).

**Host → marker translation:** a host must become a safe, escaped,
case-insensitive literal regex (reuse the `synthesizeMarker`/escaping path used
by `suggest-markers`, or the `MIN_AUTO_BLOCK_IDENTIFIER_LENGTH`-style guard) so
a short host fragment doesn't cause false positives.

---

## Cross-cutting

- **Redaction:** every new finding path must obey the existing rule — hooks/CI
  never emit an un-redacted host/value; `--verbose` is dev-only. Mirror the
  `.npmrc` auth redaction already in `egress.ts`.
- **Exit codes / JSON:** reuse `EXIT_HIT` and the existing `egress` JSON array
  in `check` output; new ecosystems produce the same `RegistryFinding` shape, so
  no output-schema change for A–C.
- **Class gating:** all of A–C ride the existing `isPublicFacing` gate — no new
  gate logic. D writes config and is class-agnostic at write time (the gating
  happens later, when the marker is evaluated).
- **`RegistryFinding.kind`:** currently `"lockfile" | "npmrc"`. Widen to include
  the pip config shape (e.g. `"pip-config"`) if we want to distinguish, or keep
  `"lockfile"`/`"npmrc"` and rely on `file`. Prefer keeping the union small.

## Test plan

Fixtures under `tests/` (or `packages/core/src/*.test.ts` in-repo fixtures, the
current convention — `egress.test.ts` uses inline fixture strings):

- **A:** registry with/without `publicRegistries`; mirror host allowed vs a
  different private host still flagged; schema-reject a URL-shaped entry.
- **B:** `poetry.lock` / `Pipfile.lock` / `requirements.txt` each with a private
  index host → finding; public PyPI host → clean; userinfo redaction asserted.
- **C:** `Cargo.lock` with `source = "sparse+https://<private>/"` → finding;
  default crates.io index → clean.
- **D:** fake `$HOME` with a `.npmrc` (private `registry=`) + `pip.conf` →
  `scan-env --dry-run` lists both hosts, persists none; `--auto-accept
  always_block` persists escaped literals and audit-logs; asserts **no token**
  is ever written.
- **Regression:** the existing `egress.test.ts` npm/yarn/pnpm cases keep passing
  unchanged (A must not alter default behavior when `publicRegistries` is unset).
- Pin nondeterminism: no clock/RNG in these paths; parsers are pure.

## Sequencing

1. **A** (schema + policy wiring + tests) — unblocks the rest.
2. **B** and **C** in parallel (decide TOML dep vs regex first; they share it).
3. **D** last — largest, separable, needs the `privateInfra`/deny-set +
   cache-version decision.
4. CHANGELOG entry per landed slice; bump the deny-set cache schema version if D
   changes `computeDenySet`.

## Open decisions — how they resolved

- **TOML parsing:** → **zero-dep, line-wise.** The fields needed (`source =`,
  `url =`) are always single-line quoted strings; `yarn.lock` already set the
  "no full parse" precedent; and a tool whose purpose is supply-chain
  protection should not widen its own dependency surface to read two string
  keys. Same reasoning later applied to `~/.m2/settings.xml` (regex, no XML
  parser).
- **`publicRegistries` home:** → **engagement registry.** A checked-in
  per-repo `.repo-aegis.yml` could otherwise whitelist a private host into a
  public repo, defeating the check.
- **`privateInfra` representation:** → **top-level registry field rendered to
  a reserved `_private_infra` stem**, gated in `computeDenySet` on
  public-facing. Not an engagement id: it is not attributable to a customer,
  and the reserved stem must be excluded from the identifier auto-block.
- **`requirements*.txt` glob:** → **narrow**, plus any `*.txt` under a
  `requirements/` directory (a common split-deps layout the original plan
  missed — caught by a test).

## What the work surfaced (not in the original plan)

- **The gate had to enter the deny-set cache key.** Public-facing state can
  flip with no marker file changing (`status` refreshing cached visibility),
  so without it a repo made public would keep serving a stale, under-blocking
  cached set. Cache version 3 → 4.
- **Redaction was anchored wrong.** `redactUrlCredentials` used `^`, but is
  applied to whole config *lines*; it would have echoed credentials from a
  `--index-url` line. Caught by a test written specifically to try it.
- **`--home` is a reserved global.** `scan-env` initially reused it and
  silently repointed `REPO_AEGIS_HOME`; renamed to `--scan-home`.
- **Two pre-existing hygiene defects in the module this plan extends:** a real
  account id in a test fixture (published via npm, since the package ships
  `src`), and a raw NUL byte that made git treat `egress.ts` as binary — so
  every diff of the leak-detection module was unreviewable. Both fixed.

## Follow-ups — both now fixed

- **The local test suite could not run clean.** ✅ Root cause was *not* the
  sandbox, as first assumed: the ~34 test files that run `git init` inherited
  the developer's global git config, so anyone with repo-aegis installed hit
  its real `core.hooksPath`. `install-hooks` then failed because the tool
  correctly detected a conflict, and `audit` failed because the real
  pre-commit hook blocked the temp repos' commits. Fixed by nulling
  `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM` in the npm test scripts.

  Running the suite once it was unblocked immediately caught a real regression
  this work had introduced — `scan-env` missing from the CLI flag-name
  contract — which vindicates the fix: the broken suite had been hiding it.
  Full suite is now 1141 tests, 0 failures.

  The remaining `llm` failures are genuinely environmental (those tests bind a
  loopback TCP port, which some sandboxes forbid). Left as-is rather than
  refactored to `fetch` stubs: that would touch the `[SEC H-1]`
  endpoint-validation tests, and weakening a security test to satisfy a
  sandbox is a bad trade. Documented in CONTRIBUTING instead.

- **Fixture hygiene had no automated guard.** ✅ Added
  `core/self-hygiene.test.ts` — fails on an account-id-shaped string, an
  account-scoped CodeArtifact/ECR host, or a raw NUL byte anywhere in tracked
  source. Verified by reintroducing the original leak and confirming both
  checks fire. Placeholders are recognised by *shape* (repeated digit, or a
  counting run like `123456789012`) rather than a literal allowlist, which
  would grow silently and re-require the human review step that failed the
  first time. The guard asserts a non-empty file list so it cannot rot into a
  vacuous pass, and never echoes an offending value — reporting `file:line`
  only, so the failure message is not itself the leak.
