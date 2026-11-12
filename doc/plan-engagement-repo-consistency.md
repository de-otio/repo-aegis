# Plan: engagement-org repos classify consistently; narrow `gh repo create --private` waiver; honest failure receipts

Status: revised after security and design review (2026-11-12). Scope of D
decided: the trimmed version below.

## Problem

A field report against 0.15.2 (two throwaway private repositories in an
engagement's GitHub org, `org-a`, whose engagement id is also `org-a`):

1. **Blocker.** The write scan refused `.github/workflows/x.yml` because it
   held `uses: org-a/lib/.github/workflows/y.yml@main`, a cross-repository
   reusable-workflow call that must name the owner. The engagement id is
   auto-blocked as a literal (`deny-set.ts:343-374`), and the repo got the
   full union of markers.
2. `gh repo create org-a/new --private` was refused with
   `PUBLIC_EGRESS_NEEDS_HUMAN`. It is in `VERBS_NEEDING_HUMAN`
   (`egress-policy.ts:342`), and a not-yet-existing repo has unknown
   visibility, treated as public.
3. After the repos existed and the push path had cached `private`, gh receipts
   still said `VISIBILITY UNCACHED, TREATED AS PUBLIC`.
4. The same repo showed class `customer-coupled` on gh receipts and
   `private-strict` on push receipts.
5. (Later report.) A person's `gh repo delete org-a/x --yes` failed with
   GitHub's HTTP 403 (missing `delete_repo` scope). The receipt printed
   `EGRESS FAILED → … (VISIBILITY UNCACHED, TREATED AS PUBLIC, …): gh repo
   edit`: it read like a repo-aegis refusal and named the wrong command.

### Root causes

- **1 + 4.** First-touch classification runs only from the SessionStart hook
  (`claude-hook-specs.ts:29-33`), on the session's cwd. A repo created or
  cloned partway through a session is never classified, so `readRepoConfig`
  defaults it to `private-strict` (`repo.ts:174-176`), which gets every
  engagement's markers and ids. The egress path classifies the same
  destination from the registry instead (`egress-policy.ts:556-571`). There
  are three classifiers with different rules:
  `first-touch.ts:104-112` (personalOrgs first, first engagement wins,
  case-sensitive), `egress-policy.ts:517-524` (every matching engagement,
  case-insensitive, ignores personalOrgs), and the default.
- **3.** The registry branch of `withLocalClass` returns before
  `resolveCachedDestination` is consulted (`egress-policy.ts:560-575`).
- **2.** Rule g ignores flags (`egress-policy.ts:1713-1715`); the parser reads
  no visibility flag.
- **5.** Receipts print the verb-class label (`VERB_LABEL`, `egress-policy.ts:866`),
  and `repo delete|archive|rename|…` all map to `gh-repo-edit`
  (`egress-intent.ts:1364-1374`).

## Goal and threat model

repo-aegis prevents honest mistakes. It does not try to stop an agent or a
person who is working to defeat it. Every refusal must name the honest
mistake it stops; a refusal that stops none is removed. Every relaxation
below names the accident it still stops and gives up when the facts are
ambiguous.

| Change | Honest mistake still stopped | Refusal removed |
|---|---|---|
| A: infer `customer-coupled` for an unclassified repo whose push targets all resolve to one engagement | Another engagement's markers in this repo; our own identity in a customer's repo (`_self_identity` becomes active: stricter); a customer's codenames in that customer's **public** repo (veto) | The engagement's own name and markers in the engagement's own private repo |
| B: registry branch reads a verified, fresh cached visibility | Publishing to a repo whose visibility is unknown, stale, or recorded by a checkout that now points elsewhere | "uncached, treated as public" for a repo a live checkout recorded as private |
| C: `gh repo create OWNER/REPO --private\|--internal` with no content flags skips the person check | Creating a public repo; a repo whose visibility gh will prompt for; a repo under the wrong account (bare name); copying a tree or template into the new repo | Creating an empty private repo in a registered owner |
| D: honest receipt after a command's own failure | (no refusal involved) | (none) — removes a misleading line |

## Changes

### Shared: one owner classifier

New pure function in `packages/core/src/registry.ts` (or a small
`owner-class.ts`):

```ts
export type OwnerClass =
  | { kind: "personal" }
  | { kind: "engagement"; id: string }
  | { kind: "ambiguous"; ids: string[] }   // in two or more engagements, or personal + engagement
  | { kind: "unknown" };

export function classifyOwner(owner: string, registry: Registry): OwnerClass; // case-insensitive
```

Three callers switch to it, and the deliberate behaviour changes are listed
here and pinned by tests:

- `first-touch.ts` `tryRegistryMatch`: `ambiguous` now gives no match
  (needs-confirmation) instead of "first engagement wins"; matching becomes
  case-insensitive.
- `withLocalClass` registry branch: `ambiguous` now gives `private-strict`,
  `classKnown: false` instead of `customer-coupled` with every engagement
  (which un-blocked all of them). `personal` falls through to the existing
  cache/unknown path as today.
- A's inference (below).

### A. Infer the class of an unclassified repo from its push targets (fixes 1 and 4)

`readRepoConfig` stays the raw reader of git config and `.repo-aegis.yml`.
It is unchanged; the mutators (`addEngagements`, `removeEngagement`),
`allow`, `deny`, `classify`, `first-touch`, `uninstall` and `doctor` keep
using it, so `RepoJson.engagements` keeps meaning "what git config holds".

New module `packages/core/src/repo-inference.ts`:

```ts
/** Pure. Null means: no inference, the raw class stands. */
export function inferClass(input: {
  raw: RepoConfig;                       // from readRepoConfig
  targets: readonly RemoteTarget[];      // every push URL of every remote, resolved (remote-url.ts:340 kinds)
  cachedVisibility: RepoVisibility;      // repo-aegis.visibility of this checkout
  registry: Registry;
}): { class: "customer-coupled"; engagement: string } | null;

/** Imperative shell: readRepoConfig + list remotes + resolve push URLs + inferClass. */
export function readEffectiveRepoConfig(cwd: string, registry: Registry | null): EffectiveRepoConfig;
// EffectiveRepoConfig = RepoConfig & { classInferred?: true }
```

`inferClass` returns null unless **all** hold:

1. `raw.classExplicit === false`. An explicit class always wins.
2. At least one push target, and **every** target is of kind `github` (any
   `non-github` or `unresolved` target, e.g. a GitLab mirror or an ssh alias
   that cannot be resolved, gives null).
3. Every target's owner classifies as `engagement` with the **same** id
   (`personal`, `ambiguous`, `unknown` give null).
4. `cachedVisibility !== "public"`. A customer's public repo is not inferred
   coupled; it stays `private-strict` and the customer's markers stay
   blocked. (First-touch gets the same veto.)
5. `raw.engagements` is empty or equals `[id]`. A configured engagement that
   differs is never silently replaced or merged.

`readEffectiveRepoConfig` runs the remote listing only when
`classExplicit` is false (no extra git spawns for classified repos), takes
the registry from its caller (no default load, no hidden I/O), and returns
`class: "customer-coupled"`, `engagements: [id]`, `classExplicit: false`,
`classInferred: true`. Nothing is written to git config.

Callers switched, by name (each computes the effective config **once** per
command and passes config and registry down): `check.ts:989,997`,
`hook-policy.ts:144`, `egress-policy.ts:601,848`,
`destination-cache.ts:128,202`, `git-credential.ts:143`, `status.ts:185`,
`markers.ts:102`, `trust-boundary.ts:50`.

Stated consequences:

- Trust boundary: an inferred repo's boundary becomes the engagement's
  `githubOrgs`, as for a classified repo, and `fromRemoteFallback` /
  `DEST_UNCLASSIFIED` stops firing for it (`trust-boundary.ts:50-78`,
  `hook-policy.ts:153-163`). Intended; tested.
- `status` prints `class: customer-coupled (inferred from origin; run
  \`repo-aegis classify --apply\` to record it)` instead of
  `(default; not set)` (`status.ts:326`). Receipts append `(inferred)`.
- JSON: `RepoJson` (`types.ts:31`) and the VS Code `StatusJson`
  (`packages/vscode/src/types.ts`) gain optional `classInferred`.

### B. Registry branch reads a verified cached visibility (fixes 3)

In `withLocalClass`'s registry branch, for a named repo whose owner
classifies as `engagement`:

- Call `resolveCachedDestination(org, repo)` and accept its visibility only
  if the entry is **live** (the tree exists), the tree's current push target
  re-resolves to the same `org/repo`, and `checkedAt` is younger than
  `VISIBILITY_MAX_AGE` (7 days). Otherwise keep `unknown`.
- Take only `visibility` and `workingTree` from the cache. Keep
  `class: "customer-coupled"`, `inferredFromRegistry` and `engagements`,
  which the payload scanner (`egress-policy.ts:839`) and rule e (`:1645`)
  branch on.
- Only ever replace `unknown`. A known `public` is never downgraded.

Add the origin re-check to `resolveCachedDestination` itself, so the
not-registry cache path (`egress-policy.ts:575`) gets it too.

### C. `gh repo create OWNER/REPO --private` with no content (fixes 2)

Parser (`egress-intent.ts`), for `repo create` only: record
`createVisibility: "private" | "internal" | "public" | "unspecified"` and
`createCopiesContent: boolean` on the intent.

- A visibility flag counts only bare or as `=true`. `--private=false`,
  two visibility flags (including a repeated one), a shell expansion
  anywhere in the argv, or a flag hidden by a gh alias give `unspecified`.
- Confirm `--public`, `--private`, `--internal` are boolean (no value) in
  `gh-flags.ts` so a value flag swallowing a token (`-d --public`,
  `--description=--private`) is parsed as gh does.
- `createCopiesContent` is true when any of `--source`, `--push`,
  `--template`, `--clone` is present.
- `repo fork` (same verb) never gets `createVisibility`.

Policy (`egress-policy.ts`): `gh-repo-create` is waived from
`VERBS_NEEDING_HUMAN` only when **all** hold:

1. `createVisibility` is `private` or `internal`;
2. `createCopiesContent` is false;
3. the positional is an explicit `OWNER/REPO` (not a bare name, not absent)
   and the owner classifies as `personal` or `engagement`.

Only then is the destination's `unknown` visibility set to `private` (never
overriding a known value) before `gateFields`. Every rule before g still
runs. Anything else keeps today's person check. The content-copying shapes
stay with a person because nothing else scans them: `--template` copies on
GitHub's side, and a repo-local `core.hooksPath` skips the global pre-push
hook for `--source . --push`.

### D. Honest receipt after a command's own failure (fixes 5)

Scope:

- Add the typed subcommand to the intent (`ghSubcommand: "delete"`) for
  display; receipts print `gh repo delete`. `VERB_LABEL` stays for policy.
- When the command exits non-zero after an allow, the `EGRESS FAILED` line
  says `gh repo delete exited 1; the error above is GitHub's, repo-aegis
  allowed this command`.

Dropped: naming the injected identity's missing token scope.

## Tests

Spec first: write the failing tests, then the code. Each PR names its
guarding tests and records in its Evidence section that reverting the change
makes them fail.

- **classifyOwner:** table: personal, one engagement, two engagements,
  personal + engagement, unknown, mixed case.
- **A, inferClass:** table of about 15 rows covering each veto (explicit
  class, no target, non-github, unresolved, unmapped, personal, ambiguous,
  two engagements, cached public, differing configured engagement) and the
  positive cases (one target; two targets same engagement; configured
  engagement equal to inferred).
- **A, metamorphic properties (fast-check):** adding any target of kind
  unmapped / personal / non-github / unresolved never turns null into
  non-null; target order and owner case never change the result.
- **A, regressions:** `allow org-a` and `deny org-a` on an inferred repo
  still write and unset git config; `classify` audit logs the raw previous
  class.
- **A, integration:** temp repo, origin in `org-a` (marker list), no class:
  `check` passes a file with the engagement id, fails one with engagement
  `org-b`'s marker, fails one with a `_self_identity` marker. Explicit
  `private-strict`: the id fails. Extra `pushurl` to an unmapped owner or a
  non-GitHub host: id fails. `repo-aegis.visibility public`: id fails.
- **A, consistency:** push receipt and gh receipt for the same destination
  print the same class; org in two engagements gives `private-strict` on
  both paths.
- **A, trust boundary:** inferred repo's boundary equals the engagement's
  orgs, no `DEST_UNCLASSIFIED`.
- **B:** registry org with a live checkout recording `private`: destination
  `customer-coupled`, `private`, not `assumedPublic`, engagements kept.
  Checkout re-pointed to another repo: `unknown`. Stale `checkedAt`:
  `unknown`. Cached `public`: stays public.
- **C, parser table:** `--private`, `--internal`, `--public`,
  `--private=true`, `--private=false`, `--public=false`,
  `--private --private`, `--private --public`, none, `"$VIS"`,
  `-d --public`, `--description=--private`, each content flag, `repo fork
  --org x` (intent field absent).
- **C, parser property (fast-check):** any argv containing `--public`, a
  shell expansion, or two visibility flags never yields `private`.
- **C, policy:** waived only for `OWNER/REPO` + private + no content + known
  owner; bare name, no name, unknown owner, `--template`, `--source --push`
  each keep `PUBLIC_EGRESS_NEEDS_HUMAN`. Golden fixtures under
  `packages/cli/src/commands/__fixtures__/hosts/golden/` updated.
- **D:** receipt for `repo delete` prints `gh repo delete`; non-zero exit
  after allow prints the attribution sentence.
- **e2e (`tests/e2e/sandbox-shaped.test.mjs`):** the field scenario end to
  end with placeholder names.

fast-check is a new dev dependency of `packages/core` (pinned exact
version).

## Docs

- `doc/configuration.md:414`, `doc/agent-guide.md:1282,1291`: class
  precedence gains the "inferred from push targets" step and its vetoes.
- `doc/agent-guide.md:588`: the `DEST_UNCLASSIFIED` row.
- `doc/architecture.md:77-91`: first-touch is no longer the only classifier;
  `classifyOwner` is the shared rule.
- `doc/cli-reference.md:1432` and `doc/design/egress-guard.md`: rule g's
  `gh repo create` waiver and its conditions.
- `doc/guide-data-leak-prevention.md:133`: re-read after C.
- `packages/cli/dist/docs/*`: regenerated by `scripts/copy-cli-docs.mjs`;
  confirm in the build.
- CHANGELOG: one entry per PR under the next minor.

## Rollout

PRs in this order; each small enough to verify in one session:

1. **B** (cache verification and the registry-branch read).
2. **C** (parser fields and the narrow waiver).
3. **A1**: `classifyOwner`, `repo-inference.ts`, unit and property tests.
   No caller changes.
4. **A2**: switch callers (including first-touch and the registry branch to
   `classifyOwner`), status, receipts, JSON fields, docs, e2e.
5. **D**.

No migration: explicit classes are untouched, and nothing is written to git
config.

## Out of scope

- An "allow the repo's own owner" path exception. A supersedes it.
- Running first-touch from another hook (it writes git config; A computes).
- `!` shell commands counting as a person present.
- Waiving `gh repo create` with content flags: a later change could scan
  `--source` as a payload tree and require active hooks.
