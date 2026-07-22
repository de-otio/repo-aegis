# Handoff: prevent private-registry leaks via lockfiles + dotfile auto-ingest

> Working handoff for a follow-up agent. Two proposed repo-aegis features, born
> from a real incident. File each as a GitHub issue on `de-otio/repo-aegis` and
> (ideally) implement. Nothing customer-specific appears here — the vector is
> generic to any private package registry.

## Motivating incident (generic form)

An engineer regenerated a `package-lock.json` on a machine whose **default npm
registry** (`~/.npmrc`) pointed at a **private registry** (an AWS CodeArtifact
instance: `<customer>-<acct-id>.d.codeartifact.<region>.amazonaws.com`). `npm`
baked that private host into the lockfile's `resolved` URLs, and the lockfile was
committed and pushed to a **public** repo — leaking a customer identifier +
cloud account id. Remediated with a history rewrite + force-push.

**Why repo-aegis did not catch it — two gaps:**
1. The relevant engagement had **0 markers**, and `always_block` only holds
   credential shapes — so there was nothing to match the private host / account id.
2. The scan layer that ran was the **Claude Code PostToolUse hook**, which only
   sees files written by editor tools (Write/Edit/MultiEdit). The lockfile was
   written by **`npm install`** (a shell command), so it was never scanned. The
   git-hook layer (`check --staged`/`--range`) was not installed.

Gap 2 was closed operationally by installing the global git hooks. Gap 1 was
closed by adding engagement markers. But both fixes were **manual and
reactive**. The two features below make the protection **structural and
automatic** so this class of leak is caught with no per-customer bookkeeping.

---

## Feature 1 — Lockfile resolved-host check (HIGH priority; customer-agnostic)

**Idea:** flag any dependency `resolved`/URL host in a lockfile that is **not on
a public-registry allowlist**, in **public-class** (or `public-eligible`) repos.
This catches the *structural anomaly* — "a public repo's lockfile resolves from a
private host" — with **zero markers**, so it fires even for a private registry
repo-aegis has never seen.

**Scope of lockfiles + default public allowlist:**
| Ecosystem | Lockfile | Public host(s) |
|---|---|---|
| npm | `package-lock.json`, `npm-shrinkwrap.json` | `registry.npmjs.org` |
| yarn | `yarn.lock` | `registry.yarnpkg.com`, `registry.npmjs.org` |
| pnpm | `pnpm-lock.yaml` | `registry.npmjs.org` |
| pip | `poetry.lock`, `Pipfile.lock`, `*.txt` w/ `--index-url` | `pypi.org`, `files.pythonhosted.org` |
| cargo | `Cargo.lock` | `crates.io`, `static.crates.io` |
| go | `go.sum` (proxy in env, not file) | n/a — note as out-of-scope |

**Behavior:**
- New check in `audit` (and available via `check`), e.g. `--lockfile-registry-check`
  (on by default for public-class; off for private).
- Parse each lockfile, extract every `resolved`/`url`/`source` host, compare
  against the allowlist. Any non-allowlisted host → a finding
  (`file:line`, redacted host).
- Allowlist configurable in `~/.config/repo-aegis` (e.g. `publicRegistries:` list)
  so teams with a legitimate mirror can add it.
- Exit non-zero like other checks; JSON output enumerates findings; **never**
  print the full host un-redacted from hooks (same rule as markers).
- Gate by repo class: only enforce where private hosts are illegitimate
  (public / public-eligible). In private/engagement repos a private host is fine.

**Why it's the strongest fix:** no marker maintenance, no per-customer
enumeration — it would have caught the incident with an empty registry.

**Acceptance:** a `package-lock.json` containing a `*.codeartifact.*.amazonaws.com`
`resolved` URL, staged in a public-class repo, makes `check --staged` exit 1.

## Feature 2 — Auto-ingest private-registry config from dotfiles (MEDIUM)

**Idea:** at `init` (and optionally `render`/a new `scan-env` command), parse the
developer's toolchain config for private-registry hosts and **suggest** them as
markers, so the machine's private-infra surface becomes the deny set
automatically.

**Sources to parse:**
- `~/.npmrc` + project `.npmrc` — `registry=`, `@scope:registry=`, `//host/:_authToken`
- `~/.config/pip/pip.conf`, `pip.conf` — `index-url`, `extra-index-url`
- `~/.docker/config.json` — registry auth hosts
- `~/.m2/settings.xml` — mirror/repository URLs
- `~/.cargo/config.toml` — `[registries]`, `[source]`
- `~/.yarnrc.yml` — `npmRegistryServer`, `npmScopes`

**Behavior:**
- Extract hostnames; **suggest** (interactive, like `suggest-markers`) rather than
  blind-add, because repo-aegis can't always map a host to a specific engagement.
- Offer three placements per host: (a) a specific engagement's markers (allowed in
  that customer's repos), (b) a new `privateInfra` marker group blocked in
  public-class repos only, or (c) `always_block` (everywhere).
- Never store captured **auth tokens** — only host patterns; tokens belong to the
  credential-shape `always_block` patterns, not here.

**Why:** the leak surface literally lives in these files; turning them into the
deny set closes the gap at its source and keeps markers self-maintaining.

---

## Implementation pointers

- Scan entry points: `packages/core/src/` (checks), `check`/`audit` commands.
- Engagement/marker schema: `packages/core/src/schemas.ts`; registry at
  `~/.config/repo-aegis/engagements.yaml` (`markers` = JS regex, case-insensitive,
  single-quoted YAML). `render` regenerates per-engagement marker files.
- Class gating already exists (`private-strict` etc.) — reuse it to scope
  Feature 1 to public-class repos.
- Redaction discipline: hooks/CI must never emit un-redacted matches
  (`--verbose` is dev-only). Mirror the existing marker-hit redaction.
- Tests: add fixtures under `tests/` — a public-class repo with a lockfile
  carrying a private `resolved` host (Feature 1), and a fake `~/.npmrc` with a
  private `registry=` (Feature 2).
