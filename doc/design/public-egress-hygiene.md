# Design: public-repo egress hygiene (private-registry URL leak prevention)

**Status:** proposed
**Author:** (drafted with Claude Code)
**Scope:** `@de-otio/repo-aegis-core`, `@de-otio/repo-aegis` (CLI)

## Problem

A private package registry URL (e.g. AWS CodeArtifact:
`dot-<acct-id>.d.codeartifact.<region>.amazonaws.com`) baked into a
`package-lock.json` and committed to a **public** repo leaks the owner's AWS
account id and breaks `npm ci` for any external clone (they can't authenticate to
the private registry). It is not a customer-confidentiality breach, so it sits
*outside* repo-aegis's marker/deny-set threat model — and today nothing
automatic catches it.

This was hit live: a lockfile regenerated via `npm install` (whose default
registry was pointed at CodeArtifact by an inherited `~/.npmrc`) produced 338
CodeArtifact `resolved` URLs about to be committed to a public repo. It was
caught only by a *manual* host-histogram check, not by tooling.

### Why the existing hooks miss it

| Surface | Why it misses |
|---|---|
| `scan-after-write` (PostToolUse Write/Edit) | the lockfile was written by `npm install` (Bash), not Write/Edit |
| `scan-bash-output` (PostToolUse Bash) | scans the command's **stdout/stderr** for secret-shaped strings; the URLs went into a *file*, and an account id is not a secret |
| `check` / pre-commit / pre-push | only runs the **deny-set** (customer-marker) regex; a registry host is not a marker, and `check` early-returns when the deny set is empty |
| deny set | de-otio's *own* account id is correctly **not** a customer marker |

## What already exists (and its three gaps)

`packages/cli/src/commands/audit.ts::checkLockfile` already parses
`package-lock.json` and flags every `packages[].resolved` host not in
`{registry.npmjs.org, registry.yarnpkg.com, *.github.com, codeload.github.com}`.
The detection is essentially done. Its gaps:

1. **Manual-only.** It runs solely under `repo-aegis markers audit` (and the CI
   leak-scan workflow). Nothing fires it on commit / agent write.
2. **Not visibility-aware.** It flags non-public registries *unconditionally*.
   In a **private** repo (dot-atrium, atrium) a CodeArtifact `resolved` URL is
   *correct and intended* — running this check there is all false positives.
3. **Narrow.** Only root `package-lock.json`, working-tree copy. Misses
   `yarn.lock`, `pnpm-lock.yaml`, nested lockfiles, the **staged blob** (what's
   actually being committed), and `.npmrc` `registry=` / `@scope:registry=`
   lines (the upstream cause).

## Design

### 1. Extract detection into core

Move the host-classification logic out of the CLI audit command into
`@de-otio/repo-aegis-core` as a pure, tested function:

```ts
// packages/core/src/egress.ts
export interface RegistryFinding {
  file: string;          // repo-relative path
  pkg?: string;          // lockfile package path, when applicable
  host: string;          // offending registry host
  line?: number;         // for .npmrc / yaml
  kind: "lockfile" | "npmrc";
}
export interface EgressPolicy {
  allowedHosts: string[];           // default public set; user-extendable
}
export function scanRegistryEgress(
  files: { path: string; text: string }[],
  policy: EgressPolicy,
): RegistryFinding[];
```

Parsers:
- **`package-lock.json`** — iterate `packages[].resolved` (current logic) *and*
  the legacy `dependencies[].resolved` tree (lockfileVersion 1).
- **`yarn.lock`** — `resolved "<url>#..."` lines (regex; yaml-ish, no full parse).
- **`pnpm-lock.yaml`** — `resolution: { tarball: <url> }` and the `registry`
  field; parse with the existing `yaml` dep.
- **`.npmrc`** — `registry=` and `@scope:registry=` lines whose host is not
  allowed (the root cause; catches the misconfig before it ever rewrites a lock).
- **`Cargo.lock`** — `source = "registry+https://…"` / `"sparse+https://…"`;
  strip the scheme prefix before host extraction or the URL will not parse and
  the finding is silently dropped.
- **`poetry.lock`** — `[package.source] url = "…"`.
- **`Pipfile.lock`** — `_meta.sources[].url` (JSON).
- **`requirements*.txt`** — `--index-url` / `--extra-index-url` / `-i` /
  `--find-links`. The pip analogue of `.npmrc`; ordinary pinned lines carry no
  host. Matched by name, or any `*.txt` under a `requirements/` directory —
  deliberately *not* every `*.txt`.
- **`go.sum`** — out of scope: the proxy is configured via `GOPROXY` in the
  environment and never recorded in the file, so there is no host to check.

The two TOML-ish lockfiles are scanned line-wise rather than with a real TOML
parser: the fields needed are always single-line quoted strings, `yarn.lock`
already sets the "no full parse" precedent, and a tool whose purpose is
supply-chain protection should not widen its own dependency surface to read two
string keys.

Any URL may carry credentials (`https://user:token@host/simple`); these are
redacted before a finding is emitted, in both the value and any echoed line.
The host is the signal — the secret is not ours to print.

Default `allowedHosts`: the current public set. Make it the single source of
truth (CLI audit imports it instead of hard-coding).

**Extending the allowlist (shipped).** A team running a legitimate mirror adds
it to the engagement registry:

```yaml
# ~/.config/repo-aegis/engagements.yaml
publicRegistries:
  - registry.internal.example.com
  - mirror.example.org:8443      # optional :port
```

`loadEgressPolicy()` merges these over the built-in defaults. Notes:

- **Org-wide, not per-repo.** It lives in the registry rather than
  `.repo-aegis.yml` because "our org runs this mirror" is a machine-level fact
  — and a checked-in per-repo file could otherwise whitelist a private host
  into a public repo, defeating the check.
- **Bare hosts only.** Entries are validated against the WHATWG URL parser and
  must match `URL.host`; a scheme, path, credentials, or `*` wildcard is a
  parse error. Matching is exact equality, so those shapes would otherwise be
  silently inert.
- **Fail-soft load.** A missing, encrypted, or malformed registry falls back to
  the defaults rather than erroring — the check must keep working with zero
  config on the pre-commit path. This cannot weaken the check: the fallback is
  the *smallest* allowlist, so an unreadable registry yields more findings,
  never fewer.

### 2. Visibility gate — the crux

The check must enforce **only when the content can become public**. Two signals:

- **`repo.class === "public-eligible"`** — declarative, offline, already in
  `RepoConfig`. *But* class defaults to `private-strict` and is org-derived
  (`personalOrgs`), which **cannot distinguish public vs private repos in the
  same org** — e.g. `de-otio` hosts public `maildummy` *and* private
  `dot-atrium`. maildummy is currently misclassified `private-strict` (default),
  so a class-only gate would not fire on it.
- **Actual GitHub repo visibility** (`gh repo view --json visibility` /
  `GET /repos/{o}/{r}`) — authoritative per-repo, but a network call.

**Decision:** gate on a derived `isPublicFacing` predicate:

```
isPublicFacing =
     repo.class === "public-eligible"                       // offline declaration wins
  || (visibilityProbe() === "public" && class allows it)    // authoritative, cached
```

- The **pre-commit/agent** path stays offline by default (uses `class`), so it
  never blocks on the network. A cached visibility probe (written by
  `classify` / `status` / a periodic refresh into git config
  `repo-aegis.visibility` with a timestamp) supplies the authoritative signal
  without a per-commit API call.
- **Never enforce** for `customer-coupled` / `scratch`, and for `private-strict`
  *unless* the cached visibility says `public` (the misclassification safety
  net — this is what would have caught maildummy).
- A private repo with intentional CodeArtifact URLs (dot-atrium) → no findings.

### 3. Enforcement wiring

- **Primary: fold into `check`.** Add an egress pass to
  `packages/cli/src/commands/check.ts` that runs for `--staged`, `--range`,
  `--path` whenever `isPublicFacing`. Two changes to respect:
  - It must run **independently of the deny set** (today `check` returns early
    when `combinedRegex === ""`). Egress findings are not marker hits.
  - `--staged` must read the **staged blob** (`git show :path`), not the
    working tree — the committed bytes are what matter.
  This automatically covers **pre-commit** (`check --staged`) and **pre-push**
  (`check --range`) with no hook-script change.
- **Exit code:** reuse a non-zero exit on findings so the pre-commit hook blocks
  the commit; honor the `scratch` "advisory" downgrade.
- **Keep `markers audit`'s lockfile check**, re-pointed at the shared core
  function and made class-aware (no more false positives on private repos).
- **CI** (`install ci` → leak-scan.yml) inherits via `check`/`audit`.
- **PostToolUse (optional):** a small `hook scan-bash-output` enhancement — when
  a Bash command's tool-input is an install (`npm i`, `npm ci`, `npm install`),
  re-run the egress check on the lockfile afterward. Lower priority than
  pre-commit (pre-commit is the reliable gate); listed for defense-in-depth.

### 4. Fix classification of public repos

The misclassification (maildummy = public but class private-strict) is the
root reason the existing check would not have fired even if wired in. Address:

- Enhance `classify` to record actual GitHub visibility (one API call) and set
  `public-eligible` when the repo is public *and* in a `personalOrg`.
- Add an **`audit` reconciliation finding**: class vs actual visibility mismatch
  (e.g. "repo is GitHub-public but class=private-strict" or the inverse), so the
  fleet can be swept and corrected.
- Document: public repos in a personal org should be `public-eligible`.

### 5. Config / schema additions

- Registry allow-list override, per-repo (`.repo-aegis.yml`) and global
  (registry file): `allowedRegistries: [host, ...]` merged onto the default
  public set — for teams that legitimately publish a public mirror host.
- Optional `egress: { enforce: on|off }` per-repo escape hatch (audited).
- Extend `repoOverrideSchema` / `registryFileSchema` (zod) + `status` output to
  surface the egress policy and resolved `isPublicFacing`.

### 6. Output & redaction

Registry hosts / account ids are **not** customer markers, so they are *not*
subject to the marker-redaction rule — they can be printed in full (they're the
actionable detail). Keep them out of the deny-set match path entirely; they flow
through their own `RegistryFinding` channel.

## Test plan

Mirror existing patterns (`audit.test.ts`, `check.test.ts`, fixtures):

- **core/egress.test.ts** — table-driven parser tests per lockfile format + a
  `.npmrc`; allowed vs disallowed hosts; lockfileVersion 1 vs 3; `file:`/`link:`
  entries ignored; malformed input fails closed-but-graceful.
- **visibility gate** — `public-eligible` enforces; `private-strict` w/o
  visibility skips; `private-strict` + cached `public` enforces (the maildummy
  case); `customer-coupled`/`scratch` skip; intentional private CodeArtifact →
  zero findings.
- **check --staged** — a staged lockfile with a CodeArtifact URL blocks the
  commit (non-zero exit); working-tree-only change is irrelevant to staged scan.
- **regression** — `markers audit` no longer false-positives on a private repo.

## Rollout

1. Phase 1 — core `egress.ts` + tests; re-point `audit` at it, class-gated
   (removes private-repo false positives). *No behavior change for public repos
   yet beyond audit.*
2. Phase 2 — wire into `check` (pre-commit/pre-push), staged-blob aware, deny-set
   independent. Ship behind `egress.enforce` defaulting **on** for
   `public-eligible`, **advisory** for `private-strict`+cached-public for one
   release, then enforcing.
3. Phase 3 — `classify`/`status` visibility probe + caching + audit
   reconciliation finding; sweep + correct existing repo classes (maildummy →
   `public-eligible`).
4. Phase 4 — broaden parsers (yarn/pnpm/.npmrc) + the optional Bash-install
   PostToolUse enhancement.

## Non-goals

- Scrubbing existing history (separate remediation; `audit --history` already
  finds past occurrences once the pattern is known).
- General SBOM / supply-chain scanning — this is narrowly "private-registry URL
  in a public-facing tree."
- Blocking CodeArtifact URLs in private repos — that is the intended setup.
