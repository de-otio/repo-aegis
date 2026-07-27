# Implementation plan: tag-push false positives + hook liveness

**Status:** complete — shipped in v0.7.0. Kept as the design record: the
rationale for each decision, and the alternatives rejected (notably why `git
log -p` is the wrong primitive for item A), are not reconstructable from the
diff. Where the plan and the code disagree, the code won; the deviations are
noted in the [Review log](#review-log) and in [Deviations](#deviations-during-implementation).
**Sources:**
[`doc/design/tag-push-history-rescan-false-positives.md`](./design/tag-push-history-rescan-false-positives.md)
(items A–E) and the `core.hooksPath` blind-spot write-up in `dot-notes`
(`doc/topics/data-leaks-on-github/prevention/hook-coverage-blind-spot.md`,
items H1–H6).

The two documents look unrelated but land on the same two files —
`packages/cli/src/commands/install-hooks.ts` (the hook scripts) and the
`status`/`audit` check surface. Doing them in one pass avoids touching the
pre-push script twice, and the hook-template *staleness* check (H1) is what
tells users their installed pre-push script predates the fix in A.

They are also the same failure class from opposite sides: **A–E are a guard
that fires when it shouldn't; H1–H6 are a guard that doesn't fire when it
should.** Both push the operator toward `--no-verify`.

A review pass while writing this plan turned up a **third** instance of the
same class — a guard that silently doesn't fire on renamed files — which is
now item **P0** and ships first.

---

## Constraints discovered in the code

Read these before estimating anything — several change the shape of the work
relative to what the design docs assume.

1. **Renamed files are not scanned at all.** `scanStagedDiff` and `scanRange`
   pass `--diff-filter=ACM` ([scan.ts:368](../packages/core/src/scan.ts#L368),
   [scan.ts:393](../packages/core/src/scan.ts#L393)), which excludes `R`
   entries — and git's rename detection is on by default (`diff.renames`,
   since git 2.9). Verified end-to-end against the shipped CLI: `git mv` a
   file and append a marker in the same commit and `check --staged` reports
   **`clean`, exit 0**; the identical content change without the rename
   reports the hit. `gatherEgressInputs` in `check.ts` already uses `ACMR`,
   which is what makes this read as an oversight rather than a decision.
   → item **P0**.
2. **`git log -p` shows no diff for merge commits.** Verified on git 2.53: a
   merge commit that introduces content not present in either parent (an
   "evil merge") produces *zero* diff output under plain `git log -p`. Today's
   `git diff <empty-tree>..<ref>` is a tree diff and catches it. This ruled out
   the log-based implementation of A that the first draft of this plan
   proposed — see [A](#a-incremental-range-for-new-refs).
3. **Diff-mode hits carry no file path.** `streamScanDiff` /
   `processDiffLine` parse the unified diff but discard `diff --git` /
   `+++ b/<path>` headers; a `ScanHit` from `--staged` or `--range` has
   `line`/`column` only (the CLI prints `<staged>`). **B (path-scoped
   exemptions) and D (blob-scoped waivers) are both blocked on threading path —
   and blob sha — through the diff scanner.** That is item **P** below, a
   prerequisite, not part of B.
4. **Patterns have no ids.** The deny set is a flat `patterns: string[]` with a
   parallel `patternSources: string[]` holding the marker-file *stem*
   (`_always`, `_private_infra`, or an engagement id). D's
   `--pattern _always/private-key` names something that does not exist; a
   stable id has to be minted (item D).
5. **`scanHistory` fails open.** [scan.ts:466](../packages/core/src/scan.ts#L466)
   is `catch { return []; }` — any git failure reports *clean*. `check.ts`'s
   `git()` helper has the same shape. New code must fail **closed**; the
   existing site is fixed in P0.
6. **The CLI surface is contract-tested.** `packages/cli/src/program.test.ts`
   asserts the exact subcommand + flag set against a frozen manifest. Every new
   command or flag below needs a manifest edit *in the same commit*.
7. **Hook scripts are copies on disk.** `install hooks` writes
   `~/.config/repo-aegis/hooks/{pre-commit,pre-push}` from string constants in
   the CLI. Any change to the pre-push script only reaches a machine when
   `install hooks` is re-run — which nothing currently detects or prompts for.
8. **A global `core.hooksPath` shadows every repo's own `.git/hooks`.** Git
   consults exactly one hooks directory. H3's default flip therefore silently
   disables any repo-local hook a user or tool installed directly into
   `.git/hooks` — see [H3](#h3-install-hooks---global-by-default).
9. **This repo scans itself.** `packages/core/src/self-hygiene.test.ts` plus the
   author's own `_always` set means literal example secrets must never be
   committed here, not even as fixtures. Item E has to be written to avoid
   embedding the strings it recognises.

---

## Work items

| # | Item | Source | Priority | Depends on |
|---|------|--------|----------|-----------|
| **P0** | Scan renamed files (`ACM` → `ACMR`); fail closed on git errors | review | **0 — ship alone** | — |
| **A** | Incremental range for new refs (kills the tag-push failure) | design A | **1** | — |
| **H1** | `hooks-state` core module (effective path, presence, staleness) | notes 1 | **2** | — |
| **H2** | Wire `hooks` into `status` + `audit` | notes 1–2 | **2** | H1 |
| **P** | Thread file path + blob sha through the diff scanners | prereq | **3** | P0 |
| **B** | Path-scoped exemptions for `_always` patterns only | design B | **4** | P |
| **H3** | `install hooks --global` by default, `--local` opt-in, hook chaining | notes 3 | **5** | H1 |
| **D** | Reviewed-benign waivers (`repo-aegis waive`) | design D | **6** | P |
| **H4** | `repo-aegis doctor --scan-root` fleet sweep | notes 4 | **7** | H1, H3 |
| **E** | Built-in known-non-secret exception list | design E | **8** | — |
| **C** | "Already public" → warn, not block | design C | **9** | A |
| **H6** | Record observed hook state in the audit log | notes 6 | **9** | H1, H2 |

P0 is a live bypass and ships on its own, ahead of everything. A alone closes
the tag-push incident; H1+H2 alone close the silent-coverage incident.
Everything after that is durable-mechanism work and can land incrementally.

### Commit / PR slicing

Eleven items is too much to verify in one sitting. Land as seven reviewable
units, each independently revertable and each green on its own:

| PR | Contents | Rough size |
|---|---|---|
| 1 | P0 (+ regression tests) | ~50 lines |
| 2 | A (+ hook script, manifest, docs) | ~250 lines |
| 3 | H1 + H2 (+ hook-scripts move to core) | ~300 lines |
| 4 | P (+ behaviour-comparison harness) | ~200 lines |
| 5 | B (+ glob compiler) | ~250 lines |
| 6 | H3 + H4 | ~300 lines |
| 7 | D, then E, then C, then H6 (separate commits, one PR is fine) | ~400 lines |

---

## P0. Scan renamed files, and fail closed

**Gap (verified, live bypass).** `--diff-filter=ACM` drops rename entries, so
*move a file and add a marker in the same change* passes both the pre-commit
and pre-push hooks. Reproduction, against the shipped CLI with a one-pattern
deny set:

```
git mv src/a.txt src/b.txt && printf '<canary>\n' >> src/b.txt && git add -A
repo-aegis check --staged   # → "repo-aegis: clean (1 patterns checked)", exit 0
```

Without the `git mv`, the same appended line is caught. This is the most
mundane possible refactor shape, so it is not a theoretical evasion.

**Changes**

1. `scanStagedDiff` / `scanRange`: `--diff-filter=ACM` → `--diff-filter=ACMR`.
   (Not `--no-renames`: keeping detection on means the rename entry carries
   only the *changed* lines, which is less noise than re-scanning the whole
   file as an addition. `D` stays excluded — deletions add nothing.)
2. `scanHistory`: replace `catch { return []; }` with a thrown
   `GitCommandError`, surfaced by `check` as exit 2 (`GIT_ERROR`). A scanner
   that reports "clean" when git failed is worse than one that reports nothing.
3. Same treatment for `check.ts`'s `gatherEgressInputs` git helper: a failed
   `git show` must not silently drop an egress-relevant file from the scan.

**Tests.** Rename+modify staged → hit (the exact reproduction above);
rename-only → no hit; copy (`C`) with a marker → hit; delete-only → no hit;
`scanHistory` with a git failure injected → throws, `check --history` exits 2
(**not** 0). Add the rename case to `integration.test.ts` so it runs through
the real hook path.

**Why first.** It is ~50 lines, needs none of the other work, and every day it
is unshipped is a day the tool advertises coverage it does not have.

---

## A. Incremental range for new refs

**Gap.** `PRE_PUSH_SCRIPT` ([install-hooks.ts:33](../packages/cli/src/commands/install-hooks.ts#L33))
maps a zero `remote_sha` to `empty_tree..local_sha`, i.e. the full reachable
history. A release tag pointing at an already-pushed commit therefore re-scans
everything and blocks on historical benign matches.

**Decision 1: the logic goes in the CLI, not in bash.** The hook script is
untested (no harness runs it), and `audit`/CI want the same predicate. The hook
stays a thin shim.

**Decision 2: compute a diff *base* and keep using `git diff` — do not switch
to `git log -p`.** The obvious implementation is
`git log -p <ref> --not --remotes=<remote>`, and the first draft of this plan
specified exactly that. It is wrong: `git log -p` emits **no diff for merge
commits**, so content introduced by the merge itself (an evil merge, or a
conflict resolution that pastes in a marker) would go unscanned — a coverage
*regression* against today's tree diff. Verified on git 2.53. The alternatives
were: `--diff-merges=first-parent` (re-introduces the false positives A exists
to remove, since already-pushed side-branch content reappears as added), or
`-c`/`--cc` combined diffs (whose `diff --combined` / `@@@` / `++` framing
`processDiffLine` does not parse correctly). Computing a base and running one
ordinary tree diff avoids all three problems and keeps a single scanner path
shared with `--range`.

**Changes**

1. `core/src/scan.ts`: new
   `resolveNewRefBase(repo, { ref, remote }): { mode, base? }` using
   `git rev-list --boundary <ref> --not --remotes=<remote>`:

   | Situation | `mode` | Scan |
   |---|---|---|
   | no commits in `<ref>` that remote-tracking refs lack | `nothing-new` | none — **the tag case** |
   | new commits, exactly one boundary commit | `incremental` | `git diff <boundary>..<ref>` |
   | new commits, several boundaries | `incremental-widened` | `git diff $(git merge-base --octopus …)..<ref>` — a superset, so over-scan, never under-scan |
   | no boundary (disjoint / root history) | `full-history` | `<empty-tree>..<ref>` (correct: nothing is shared) |
   | no `refs/remotes/<remote>/*` at all (fresh clone, detached CI) | `full-history` | as today, and tagged so C can downgrade |
   | any git invocation fails | — | **throw** → exit 2, never "clean" |

2. `scanNewRef(repo, denySet, { ref, remote }, opts)` resolves the base and
   delegates to the existing `scanRange` machinery. No new diff parsing, no
   merge blindness, identical semantics to the pre-push path users already have.
   `ref` and `remote` are separate argv entries — no shell, no quoting hazard.
3. `cli/commands/check.ts`: new mode `--push-ref <ref> --remote <name>`, added
   to the existing "exactly one of" validation. JSON gains `mode: "push-ref"`
   and `rangeMode`. Text output for `nothing-new`:
   `repo-aegis: nothing new to scan (ref already reachable from <remote>)`.
4. `install-hooks.ts` `PRE_PUSH_SCRIPT`: git passes `<remote-name> <remote-url>`
   as `$1 $2`. Use `--range` when `remote_sha` is non-zero (unchanged), and
   `check --push-ref "$local_ref" --remote "$1"` when it is zero. Keep the
   fail-open `command -v repo-aegis` guard.
5. Escape hatch: `REPO_AEGIS_NEW_REF_FULL_SCAN=1` forces the old behaviour.
6. Update `program.test.ts` manifest, `doc/cli-reference.md`,
   `doc/design/README.md` (locked-decisions row for `check --push-ref`).

**Residual risk, and its direction.** `--remotes=<remote>` reads
*remote-tracking* refs, which the hook does not refresh (no network in a hook,
deliberately). Stale-behind tracking refs cause **over-scanning** (safe).
Stale-*ahead* tracking refs — possible after a server-side force-push or branch
deletion — could cause under-scanning. Document it; `REPO_AEGIS_NEW_REF_FULL_SCAN=1`
is the escape. Repos configured with a non-standard fetch refspec have no
`refs/remotes/<remote>/*` and so sit permanently in `full-history` — they keep
today's behaviour rather than regressing. Server-side push protection remains
the only non-advisory control (notes item 5).

**Tests** (`core/src/scan.test.ts` + subprocess CLI test + one integration test
against a **local bare remote**, so the assertion is "the push succeeds", not
"the function returned an empty array")

- Tag pointing at a commit already reachable from `refs/remotes/origin/main` →
  `nothing-new`, exit 0, no diff spawned.
- Annotated tag (tag object, not commit) → same.
- Tag carrying one never-pushed commit that adds a marker → exit 1.
- **Evil merge**: new branch whose merge commit introduces a marker present in
  neither parent → **exit 1** (the regression test for Decision 2).
- Brand-new branch with new commits → only the new commits scanned; a marker in
  an already-pushed commit does not fire.
- Multiple boundaries (branch merging two already-pushed lines) → widened base,
  marker in the new commit fires.
- Zero remote-tracking refs → `full-history`, marker fires.
- `git rev-list` failure injected → exit 2, **not** 0.
- `REPO_AEGIS_NEW_REF_FULL_SCAN=1` on the tag case → full history, marker fires.

---

## H1. `hooks-state` core module

**Gap.** Nothing resolves or reports the effective `core.hooksPath`. A local
override to an empty `.git/hooks` silently disables everything.

**Changes**

1. Move `PRE_COMMIT_SCRIPT` / `PRE_PUSH_SCRIPT` out of
   `cli/commands/install-hooks.ts` into `core/src/hook-scripts.ts`, exporting
   the strings plus `hookScriptDigest(name)` (sha256). One source of truth for
   installer and checker; this is what makes staleness detectable.
2. New `core/src/hooks-state.ts`:
   ```ts
   resolveHookState(cwd): {
     effectivePath: string | null;   // null = unset → git's default .git/hooks
     origin: "local" | "global" | "system" | "worktree" | "unset";
     expectedPath: string;           // join(repoAegisHome(), "hooks")
     scripts: Record<"pre-commit" | "pre-push",
       { present: boolean; executable: boolean; current: boolean }>;
     shadowedRepoHooks: string[];    // executable non-sample scripts in .git/hooks
     ok: boolean;
     code: HookStateCode;
   }
   ```
   `origin` comes from `git config --show-origin --show-scope --get
   core.hooksPath`. `current` compares the on-disk digest to
   `hookScriptDigest`. `shadowedRepoHooks` feeds H3's chaining warning.
3. Codes (stable, machine-readable): `HOOKS_OK`, `HOOKS_PATH_UNSET`,
   `HOOKS_PATH_FOREIGN`, `HOOKS_PATH_LOCAL_OVERRIDE`, `HOOKS_SCRIPT_MISSING`,
   `HOOKS_SCRIPT_NOT_EXECUTABLE`, `HOOKS_SCRIPT_STALE`.
4. Each code carries a one-line `fix` string
   (`git config --unset core.hooksPath`, `repo-aegis install hooks`, …).

**Tests.** A temp-repo matrix over: unset; global-only correct; local override
to an empty dir (the exact incident); local override to a dir with a
*non-executable* pre-commit; correct path with a stale (old-digest) pre-push;
a repo with its own `.git/hooks/pre-commit` while a global path is set
(`shadowedRepoHooks` non-empty); fully correct. Assert code + `ok` for each.

---

## H2. `hooks` check in `status` and `audit`

**Changes**

1. `status.ts`: JSON gains a `hooks` object (the H1 result verbatim); text
   output gains a line that reads as a failure, not a warning:
   ```
   hooks:    FAIL — core.hooksPath is <repo>/.git/hooks (local override),
             expected ~/.config/repo-aegis/hooks; no pre-commit found.
             fix: git config --unset core.hooksPath
   ```
   `status` does not exit non-zero for other problems today; keep that — the
   line is the signal, `audit` is the gate.
2. `audit.ts`: new `checkHooks()` in the check registry, `ok: false` for
   anything but `HOOKS_OK`, one finding per failing script with `detail.code`.
   Skipped when not a git repo. Gated by `--no-hooks-check` for parity.
3. **Do not add it to the generated CI workflow.** `install-ci.ts` emits a
   workflow that runs `repo-aegis audit --json` on a GitHub runner, where hooks
   are never installed — the check would fail every run and get muted. Set
   `--no-hooks-check` in the emitted template. The right surface for notes
   item 2 is the developer-machine sweep in **H4**, plus server-side push
   protection for repos that must not leak.

**Tests.** `audit --json` in a repo with a local override → `checks[].name ===
"hooks"`, `ok: false`, `code: HOOKS_PATH_LOCAL_OVERRIDE`, exit 1. Generated
workflow YAML contains `--no-hooks-check` (assert in `install-ci.test.ts`).

---

## P. Thread file path + blob sha through the diff scanners

Prerequisite for B and D; independently a usability win (hits stop printing
`<staged>`).

**Changes** in `core/src/scan.ts`:

1. `processDiffLine` gains carried state `{ path, newBlob }`, updated from
   `diff --git a/… b/…`, `+++ b/<path>` (`/dev/null` ⇒ deletion, skip), and the
   `index <old>..<new> <mode>` line. Add `--full-index` to every diff argv so
   `newBlob` is a full 40-char sha.
2. Run the underlying git with `-c core.quotePath=false` so non-ASCII paths
   arrive unquoted; add a non-ASCII-filename test either way.
3. Handle the rename stanza P0 just un-hid: `rename from` / `rename to` lines,
   where the post-image path comes from `+++ b/…` as usual.
4. `ScanHit` gains optional `path` (already declared, unset in diff mode today)
   and optional `blob`. Additive — `cli/format.ts`,
   `vscode/src/diagnostics.ts`, and the MCP tools keep working unchanged.
5. Keep the virtual line numbering as-is (documented behaviour); path is the
   new precision, not a line remapping.

**Behaviour comparison, not just unit tests.** This is a parser refactor, so
the verification that matters is old-vs-new on real input: run both
implementations over every commit in this repo's own history plus a synthetic
corpus (renames, binaries, merges, non-ASCII, CRLF, no-trailing-newline), and
assert the hit sets are identical modulo the new fields. Keep the harness in
`packages/core/src/scan.compare.test.ts`; it is cheap to keep and it is the
only thing that will catch a subtle chunk-state regression.

**Tests.** Multi-file staged diff → each hit carries the right path; rename
with modification → path is the *new* path; binary stanza → no hits, no path
leakage; non-ASCII path; blob sha of a hit equals `git hash-object` of the
post-image.

---

## B. Path-scoped exemptions, `_always` class only

**Gap.** `_always` patterns are secret *shapes* with well-known benign homes
(test fixtures); customer-marker literals are not. Today both fire everywhere.

**Changes**

1. `core/src/globs.ts` (new): a small `**`/`*`/`?` glob→RegExp compiler. No new
   dependency — the tree's runtime deps are `yaml`, `zod`, `commander`,
   `proper-lockfile`, and adding `picomatch` for nine globs is not worth the
   supply-chain surface in a security tool. Reject a glob that matches
   everything (`**`, `**/*`, `*`) at parse time: an exemption that exempts the
   whole repo is a config error, not a preference. **Property-based tests** fit
   here — for a random path and a random glob, `compile(glob).test(path)` must
   agree with a reference oracle (`git check-ignore`-style semantics or a
   brute-force segment matcher).
2. `deny-set.ts`: split the combined regex in two — `strictRegex` (every
   pattern whose source is *not* `_always`) and `exemptibleRegex` (`_always`
   only). Scanners pick per file: exempt path ⇒ `strictRegex` only. Filtering
   *after* a combined match would be wrong — an `_always` hit would mask a
   co-located engagement hit on the same line. Bump `DENY_SET_CACHE_VERSION`
   4 → 5.
3. **`_private_infra` is not exemptible.** A private-registry host or internal
   domain in a test fixture of a public repo is still a leak. Only `_always`
   joins `exemptibleRegex`.
4. Config, two levels, **camelCase in both** (the registry's `always_block` is
   legacy snake_case; every key added since — `personalOrgs`,
   `publicRegistries`, `privateInfra` — is camel):
   - registry (`engagements.yaml`, machine-level):
     `alwaysBlockExemptPaths: string[]`, defaulting to the built-in list when
     absent;
   - per-repo `.repo-aegis.yml`: `alwaysBlockExemptPaths: string[]`, **additive
     only**, never subtractive, never applicable to engagement markers.

   Built-in default: `**/test/**`, `**/tests/**`, `**/__tests__/**`,
   `**/__fixtures__/**`, `**/fixtures/**`, `**/testdata/**`, `**/*.test.*`,
   `**/*.spec.*`, `**/*.fixture.*`.
5. **Keep `audit --fixture-check` honest.** That check exists to scan exactly
   the directories B exempts. It must continue to run the full pattern set;
   `_always` hits inside exempt paths become informational findings (`ok`
   unaffected) so the exemption is visible in an audit rather than invisible
   everywhere.

**Tests.** Private-key shape under `test/` → not flagged by `check`, reported
informationally by `audit`. Same shape in `src/` → flagged. Customer marker in
a test fixture → flagged (the load-bearing asymmetry). `_private_infra` host in
a test fixture of a public-facing repo → flagged. A line carrying both an
`_always` shape and an engagement marker, in an exempt path → still flagged
(regression test for the two-regex split). `**` in config → parse error.

---

## H3. `install hooks --global` by default

**Gap.** [install-hooks.ts:244](../packages/cli/src/commands/install-hooks.ts#L244)
writes a *repo-local* `core.hooksPath`. Coverage is per-repo and opt-in at
install time; a stale local value silently beats a correct global one.

**The footgun the notes document misses.** Git consults exactly one hooks
directory. Setting a *global* `core.hooksPath` therefore silently disables the
`.git/hooks` scripts of every repo on the machine that installed hooks directly
(some `prepare` scripts, older husky versions, hand-written hooks). Flipping the
default without handling this trades one silent-coverage-loss bug for another —
in the same config key.

**Changes**

1. Add `--global` (default) / `--local` to `install hooks`. `init` uses global.
2. **Chain, don't shadow.** The generated `pre-commit` / `pre-push` run the
   repo-aegis check and then `exec` the repo's own
   `"$(git rev-parse --git-path hooks)/<name>"` when it exists, is executable,
   and is not the file we just ran (guard against self-exec when
   `core.hooksPath` happens to point there). Preserve the exit code: a
   repo-aegis hit still blocks regardless of what the chained hook returns.
3. When writing global while a differing *local* value exists: refuse without
   `--force`, exactly as the current conflict guard does, and name the local
   value. Add `--unset-local` to clear the shadowing key in one step.
4. **Uninstall symmetry.** `install hooks --uninstall` runs a bare
   `git config --unset`, which clears whichever scope git finds first. It must
   unset both scopes and report each. Same for `uninstall.ts`. Update
   `doc/cli-reference.md` and the uninstall docs in the same commit — every
   install path needs its opposite.
5. Before mutating, capture the prior value **and** `.git/config` mtime into
   the audit record. The notes document lost the only evidence dating the
   change by repairing before recording; the fix is cheap.
6. Behaviour change → CHANGELOG `Changed`, minor bump.

**Tests.** Global install sets the global key, leaves local untouched; global
install with a differing local value refuses without `--force`; `--unset-local`
clears it; `--uninstall` clears both scopes; a repo with an executable
`.git/hooks/pre-commit` still runs it after a global install (chaining), and its
non-zero exit still blocks; a chained hook that exits 0 does not override a
repo-aegis hit; audit record carries `previousCoreHooksPath` and `configMtime`.

---

## D. Reviewed-benign waivers

**Gap.** The only escape from a benign always-block finding is `--no-verify`,
which disables everything — and which agent classifiers correctly refuse to run.

**Design decisions beyond the source doc**

- **Pattern id.** Patterns are unnamed, so mint
  `patternId = "<stem>/<sha256(pattern)[0:12]>"`. Surfaced by `markers list`
  and in every `ScanHit`, so the `waive` command is copy-pasteable from the
  failure output.
- **Only `_always` patterns may be waived.** Two reasons, both hard. (1) The
  design's own non-goal forbids weakening the customer-marker deny set. (2) A
  pattern digest committed to a *public* repo is an offline oracle: anyone can
  hash candidate customer names and confirm a match. `_always` patterns are
  generic secret shapes, so their digests reveal nothing. `waive` on an
  engagement-scoped pattern errors with a pointer to
  `repo-aegis allow <engagement>`.
- **A waiver must not become an agent-reachable `--no-verify`.** This is the
  threat the whole tool exists for: an agent blocked mid-task will look for the
  cheapest unblock, and "write four lines of YAML into a file in this repo" is
  cheaper than `--no-verify`. Controls, all three required:
  1. `repo-aegis hook check-write` (the existing PreToolUse gate) refuses
     agent `Write`/`Edit`/`MultiEdit` to `.repo-aegis.yml`.
  2. `waive` refuses to run when stdin is not a TTY, unless
     `REPO_AEGIS_WAIVE_NONINTERACTIVE=1` is set — so a hook, script, or agent
     cannot mint one silently. `--reason` and `--approver` are mandatory.
  3. `check` always prints `waived: N` (JSON: the full list). A waiver is
     surfaced on every run, never silent.
  Add a row to the threat-model table in `doc/design/README.md`.
- **Storage.** `.repo-aegis.yml` (already the committed, reviewable per-repo
  config; `repoOverrideSchema` is `.passthrough()`, so this is additive):
  ```yaml
  waivers:
    - pattern: _always/9f2c1a4b7de0
      blob: 3f7a…                 # post-image blob sha, 40 hex
      reason: fedify test-fixture keypair
      approver: <name>
      date: 2026-07-26
      expires: 2027-07-26         # optional
  ```
- Blob-keyed, per the source doc: survives history rewrites and re-scans, and a
  *new* key in a *new* blob is not covered.

**Changes**

1. `core/src/waivers.ts`: schema, loader, `isWaived(hit, waivers, now)` — `now`
   is an **injected parameter, not `Date.now()`**, so expiry tests are
   deterministic. An expired waiver does not apply and emits a warning.
2. `check.ts`: filter waived hits, always report the count.
   `--ignore-waivers` for audit-grade runs.
3. `audit.ts`: honours waivers but lists each applied one as an informational
   finding — the compliance trail should show what was waived.
4. New CLI: `repo-aegis waive --pattern <id> --blob <sha> --reason <text>
   --approver <name> [--expires <date>]`, plus `waive --list` and
   `waive --remove --pattern <id> --blob <sha>` (the required opposite).
   Writes under the existing `withLockSync`; appends an audit record.
5. `program.test.ts` manifest + `doc/cli-reference.md` + `doc/configuration.md`.

**Tests.** Waived `(pattern, blob)` skipped and counted; a different blob of the
same shape still flagged; expired waiver does not apply and warns (frozen
clock); `waive` on an engagement pattern refused; `waive` with stdin not a TTY
refused; `hook check-write` refuses an agent write to `.repo-aegis.yml`;
`--ignore-waivers` re-flags; malformed waiver entry is a parse error, not a
silent skip (**fail closed**).

---

## H4. `repo-aegis doctor`

**Changes**

1. Promote `findWorkingTrees` + `SKIP_DIRS` out of
   `cli/commands/uninstall-sweep-repos.ts` into a shared `cli/src/repo-walk.ts`
   (pure move + export; `uninstall sweep-repos` keeps using it).
2. New `repo-aegis doctor [--scan-root <dir>…] [--json] [--fix] [--yes]`: run
   H1's `resolveHookState` per discovered working tree; report every repo whose
   effective hooks path is not repo-aegis, **and** every repo whose own
   `.git/hooks` scripts are being shadowed (H3). Exit 1 when any repo fails.
3. `--fix` unsets local `core.hooksPath` overrides. **Dry-run by default**, per
   the `sweep-repos` convention (`--yes` to apply); record prior value + config
   mtime per repo in the audit log *before* mutating.
4. This — not the per-repo GHA workflow — is the "wire it into CI" answer from
   notes item 2: a scheduled or manual fleet sweep on the developer machine.

**Tests.** Two temp repos, one healthy, one with a local override → doctor
reports one failure, exit 1; `--fix` without `--yes` mutates nothing; with
`--yes` unsets and the repo then passes; a repo with shadowed `.git/hooks`
scripts is reported.

---

## E. Built-in known-non-secret list

**Scope cut from the source doc.** The design lists RFC 7515 / RFC 8037 example
keys. The scanner is **line-oriented** (`scanText` splits on `\n` and matches
per line; the `_always` PEM pattern matches only the `-----BEGIN …-----`
header), so "recognise the RFC's example key" would need multi-line block
context the scanner does not have, plus a normalisation rule for wrapping and
whitespace that is brittle by construction. Ship the cheap, line-local rules
now; revisit block-aware matching only if a real PEM false positive survives B.

**Changes**

1. `core/src/known-non-secrets.ts`, consulted **only** for matches whose source
   stem is `_always` (never for engagement or `_private_infra` markers):
   - AWS-key-shaped tokens whose body ends in `EXAMPLE`;
   - placeholder bodies: `EXAMPLE`, `REDACTED`, `CHANGEME`, `YOUR-…-HERE`,
     `XXXXXXXX`.
2. Applied in `scanText` / `processDiffLine` after a match, before emitting.
3. Report the suppression count (`suppressedKnownNonSecrets: N`) in
   verbose/JSON output so it is observable rather than magic.

**Self-hygiene constraint.** Do not commit the literal example keys anywhere in
this repo — not in source, not in fixtures. Match by shape + suffix, and have
tests construct the literals at runtime by concatenation. The repo scans itself
(`self-hygiene.test.ts`); a literal would trip it.

**Tests.** Constructed AWS example key → not flagged; a real-shaped AWS key with
a non-`EXAMPLE` body → flagged; a customer marker containing the substring
`EXAMPLE` → still flagged (`_always`-only scoping).

---

## C. "Already public" → warn, not block

Mostly subsumed by A: once new refs scan incrementally, "I already pushed this
to `main`, now I'm tagging it" never reaches the scanner. What remains is the
`full-history` fallback and `check --history`.

**Changes.** Compute the remote-reachable commit set **once** per run
(`git rev-list --remotes=<remote>` into a `Set`), not per hit — a
`merge-base --is-ancestor` per finding is a process spawn per finding. A hit is
`alreadyPublic: true` when its commit is in that set. When the repo is
public-facing **and** the mode is the `full-history` fallback, downgrade those
to warn (surfaced, logged, exit 0); a first-time addition of the same shape
still blocks. Never downgrade in `--staged` or `--range` mode.

**Tests.** Full-history fallback where the historical hit is reachable from
`origin/main` → warn, exit 0; the same hit in a commit on no remote → block,
exit 1.

---

## H6. Observed hook state in the audit log

Append an `observe-hooks` record (state + code; no paths beyond the hooks dir)
on every `status`, `audit`, and `doctor` run. Cheap, and it timestamps a
regression — the forensic gap the notes document ran into. The audit log is off
by default, so note in `doc/agent-guide.md` that `audit-log on` is what buys the
timeline.

---

## Cross-cutting checklist

- `program.test.ts` manifest updated in the same commit as any flag change
  (A, D, H2, H3, H4).
- `doc/cli-reference.md`, `doc/configuration.md`, `doc/design/README.md`
  (locked decisions + threat model) updated for: `check --push-ref`, waivers,
  `alwaysBlockExemptPaths`, global hook install + chaining, `doctor`.
- CHANGELOG: **`Fixed`** for P0 (call the rename gap out plainly — users need to
  know their history may contain unscanned renames) and A; `Added` for
  B/D/E/H1–H4; **`Changed`** for H3's default flip.
- **Forward/backward compat is fail-closed in both directions**, and there is a
  test for it: an older repo-aegis reading a registry with
  `alwaysBlockExemptPaths`, or a `.repo-aegis.yml` with `waivers`, ignores both
  (`.passthrough()`) and is therefore *stricter*, never laxer. No
  `schemaVersion` bump is needed for either — both are optional additive keys —
  but state the reasoning in `doc/configuration.md` so the next person does not
  have to re-derive it.
- Redaction discipline holds throughout: new fields (`patternId`, `blob`,
  `path`) are structural, never literal marker text. `patternId` is a truncated
  digest and is only ever emitted for `_always` patterns in committed files
  (see D).
- Determinism: no `Date.now()` inside core predicates — `now` is a parameter
  (waiver expiry). Tests freeze it.
- After landing, **re-run `install hooks` on this machine** — A's fix does not
  reach an installed hook until then, which is precisely what H1's
  `HOOKS_SCRIPT_STALE` now reports. Then verify by hand against a local bare
  remote: tag an already-pushed commit and confirm the push succeeds.

## Rejected alternatives

- **`git log -p --not --remotes` for A.** Misses evil merges (verified) — a
  coverage regression against today's tree diff.
- **`--diff-merges=first-parent` for A.** Merge commits would re-present all
  already-pushed side-branch content as added, reviving the false positives A
  exists to remove.
- **`-c` / `--cc` combined diffs for A.** `processDiffLine` does not parse
  `diff --combined` / `@@@` / `++` framing; making it do so is real work for a
  case the boundary-base approach handles with no parser change.
- **`--no-renames` instead of `ACMR` for P0.** Would re-scan an entire renamed
  file as an addition — more noise, and it discards the rename information P
  wants for path attribution.
- **Fixing A in bash inside the pre-push script.** Smaller diff, untestable in
  this repo's harness, not reusable by `audit`/CI.
- **Making `_always` allowlist-able via `allow <engagement>`.** Explicitly ruled
  out by the source design; waivers (D) are the scoped replacement.
- **Global `exemptPaths` across all pattern classes.** Would let a customer
  marker hide in a test fixture. The exemption is scoped to the pattern
  *class*, and that asymmetry is the whole point.
- **Adding `picomatch`/`minimatch` for B.** Nine globs do not justify a new
  runtime dependency in a security tool.
- **Running the `hooks` check in the generated GHA workflow.** Guaranteed to
  fail on every runner; would train people to ignore it. H4 instead.

## Deviations during implementation

What the code does differently from the plan above, and why. Each was forced by
something only running the software revealed.

| Plan said | Shipped | Why |
|---|---|---|
| `check` always prints `waived: N` | Printed only when a waiver actually applied | Implemented literally it put `waived: 0` in hook output on every commit. The intent was "no waiver applies silently", not "announce zero" — permanent noise trains people to skim past the line that matters. JSON always carries the list. |
| Waived entries in JSON | Entries carry `reason` + `approver` too | The bare hit dropped the human justification, which is the entire audit value of a waiver. |
| — (not in the plan) | `check`/`status` now honour the global `--cwd` | Found via the end-to-end harness: both called `readRepoConfig()` with no argument, silently scanning the process cwd. That violated the "Universal CLI flags" locked decision *and* made the first harness run report the rename bypass as unfixed. |
| — (not in the plan) | `init` degrades instead of aborting when the hook install fails | H3's global-config default made `init` exit 2 *after* scaffolding the home dir — total-failure exit for a partial success. Safe to degrade only because H1/H2 now make an uninstalled hook detectable. |
| — (not in the plan) | The scaffolded registry ships **no active engagement** | `init` seeded an active `example-customer` engagement; since engagement ids are auto-blocked as literals, every new user got a generic placeholder in their deny set, which then flagged this project's own fixtures. Commented out, matching `always_block` directly above it. |
| `markers list` surfaces pattern ids | It does now — it did not before | The plan asserted this as existing fact. It wasn't, so the waiver copy-paste workflow was half-built. |

## Review log

Changes made to this plan after a review pass against the code and against
`git` behaviour (both verified experimentally, not from memory):

| Finding | Effect on the plan |
|---|---|
| `--diff-filter=ACM` skips renames → live bypass, reproduced against the shipped CLI | New item **P0**, priority 0 |
| `git log -p` emits no diff for merge commits (git 2.53) | **A** redesigned: boundary-based tree diff instead of `git log -p`; evil-merge regression test added |
| `scanHistory` returns `[]` on git error → reports clean | Fail-closed fix folded into **P0**; A must throw, not swallow |
| A global `core.hooksPath` shadows repos' own `.git/hooks` | **H3** gains hook *chaining* + `shadowedRepoHooks` in H1/H4 |
| `.repo-aegis.yml` is agent-writable → waivers reconstruct `--no-verify` | **D** gains three controls (PreToolUse refusal, TTY requirement, always-report) and a threat-model row |
| Scanner is line-oriented; PEM block digests don't fit | **E** scope cut to line-local rules; block matching deferred |
| `_private_infra` exemptibility was unstated | **B** states it: not exemptible |
| Registry keys are camelCase except legacy `always_block` | `always_block_exempt_paths` → `alwaysBlockExemptPaths` |
| Eleven items is not one-sitting reviewable | Explicit 7-PR slicing table |
| P is a parser refactor | Behaviour-comparison harness (old vs new over real history), not only unit tests |
| Glob compiler is a property-testing shape | Property-based tests specified for `globs.ts` |
| Waiver expiry used ambient time | `now` injected; tests freeze the clock |
| C's predicate was a process spawn per finding | Compute the remote-reachable set once |
| Unit tests alone don't prove "the push succeeds" | Integration test against a local bare remote for A |
