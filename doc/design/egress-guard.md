# Design: egress guard (destination-aware publishing controls)

**Status:** proposed
**Author:** (drafted with Claude Code)
**Scope:** `@de-otio/repo-aegis-core`, `@de-otio/repo-aegis` (CLI), the generated
git hooks, a new `PATH` shim

## Problem

repo-aegis asks one question: *are these bytes safe in this repository class?*
Every layer — the agent write hooks, pre-commit, pre-push, the CI scan, the
publish gate — inspects **content** against a deny set derived from the repo the
content sits in. That question has a blind spot, and two incidents in one week
landed in it.

Both were **right bytes, wrong boundary**:

- A PR description was published to an org-internal customer repository from a
  body file that belonged to a different project. `$TMPDIR` resolves to two
  different directories depending on whether a shell runs sandboxed, and a
  stale `pr-body.md` from another session was waiting in the other one.
  `gh pr create --body-file "$TMPDIR/pr-body.md"` exited 0 and returned a URL.
  The content carried no denied marker; it was simply the wrong document, in
  the wrong repository, for 57 minutes.
- A bare `git push` at the tail of a compound command whose leading `cd` had not
  taken effect ran in the *wrong checkout* and published a private in-progress
  branch to a **public** remote. The pre-push hook ran `check --push-ref`, the
  content was clean, and it passed — correctly.

In both cases every existing control behaved as designed. Neither incident had
unsafe content. Both had content going to the wrong place, and the stack has
no axis for *where*.

Two structural gaps follow directly:

1. **The pre-push hook is handed the remote URL as `$2` and ignores it.** The
   one place the stack sees the destination at the moment of egress does not
   look at it.
2. **PR bodies, release notes and issue text are not files in a working tree.**
   They travel as `--body-file` arguments from wherever the agent put them, and
   nothing scans them against the *destination's* rules.

A third fact shapes the design more than either: **not everyone drives the same
agent.** A control that lives only in one agent's hook framework protects one
seat. The enforcement points here are chosen so that most of them require no
agent integration at all.

### Why this is not "the agent should be more careful"

Both incidents already had instruction text pointed at them (prefer the
scratchpad; avoid compound chains; `cd` does not persist). This tool's own
design names the mechanism — *recency pressure* — to justify redacting matched
markers from hook output. The same pressure acts on destinations: a session
deep in repo X reaches for a repo-X-shaped command when it means repo Y. The
fix has to be mechanical, sit in the path of the command, and either refuse or
make a human look.

## What already exists, and how this composes with it

| Existing piece | Reused for |
|---|---|
| `trust-boundary.ts` (`computeTrustBoundary`, `trustBoundariesOverlap`) | source-vs-destination org comparison; `CROSS_ORG_EGRESS` / `CROSS_ORG_PUSH` are the egress twins of `CROSS_ORG_WRITE` |
| `remote-url.ts` (`parseRemoteUrl`) | destination org/repo from a remote URL or `--repo o/r` |
| `repo.ts` (`readRepoConfig`) + `readCachedVisibility` | destination class and cached visibility — offline |
| `check --path` machinery | scanning a payload file against the *destination's* deny set |
| `hook-check-write.ts` pattern (PreToolUse, exit-2 blocks, stderr reason) | the shape of `hook guard-egress` |
| `hook-scan-bash-output.ts` (tolerant payload extraction across harness shapes) | reading `tool_input.command` from Claude Code, Codex CLI and Gemini CLI payloads |
| `waive.ts` TTY gate + `REPO_AEGIS_WAIVE_NONINTERACTIVE=1` precedent | the "is a human present" test and its documented escape |
| `privateInfra` (class-gated marker stem, excluded from flat `markers.txt`) | the template for `selfIdentity` |
| `hooks-state.ts` / `doctor` | new liveness checks for the shim and the guard registration |

## Design

### 1. One decision function in core

```ts
// packages/core/src/egress-intent.ts
export type EgressVerb =
  | "git-push"
  | "gh-pr-create" | "gh-pr-edit" | "gh-pr-merge" | "gh-pr-comment" | "gh-pr-review"
  | "gh-issue-create" | "gh-issue-edit" | "gh-issue-comment"
  | "gh-release-create" | "gh-release-edit" | "gh-release-upload"
  | "gh-repo-create" | "gh-repo-edit"
  | "gh-api-mutating"          // -X POST|PATCH|PUT|DELETE, or -f/-F fields
  | "npm-publish";

export interface EgressIntent {
  verb: EgressVerb;
  /** `git push`: remote and refspec if given. */
  remote?: string;
  refspec?: string;
  /** `gh … --repo o/r` when present. */
  repoFlag?: string;
  /** `--body-file`, `-F`, `--notes-file`, `--body @path`, `--body-file -` (stdin). */
  payloadFiles: string[];
  /** True when any earlier segment of the same command is a `cd`. */
  precededByCd: boolean;
  /** `;`, `&&`, `||`, `|`, newline — the operator joining this segment to its predecessor. */
  joinedBy: ";" | "&&" | "||" | "|" | "\n" | null;
}

/** Tokenise (quote-aware), split on shell operators, classify each segment. Pure; never throws. */
export function parseEgressIntents(command: string): EgressIntent[];
```

```ts
// packages/core/src/egress-policy.ts
export type EgressDecision =
  | { action: "allow" }
  | { action: "ask";  code: EgressCode; reason: string; destination?: Destination }
  | { action: "deny"; code: EgressCode; reason: string; destination?: Destination };

export interface Destination {
  org: string; repo: string;
  class: RepoClass;
  visibility: RepoVisibility;      // from cache only — never a live probe on this path
  publicFacing: boolean;           // class === public-eligible || visibility === public
}

export function decideEgress(opts: {
  intents: EgressIntent[];
  cwd: string;                     // where the command WILL run (hook payload cwd / shim cwd)
  registry: Registry;
  humanPresent: boolean;           // TTY on stderr, or REPO_AEGIS_EGRESS_HUMAN=1
  capabilities: { ask: boolean };  // does the enforcing framework have an "ask"?
}): EgressDecision;
```

Rules, in evaluation order. **Shape rules need no context and are
unconditional. Context rules fail open** — the lesson of the spurious
`CROSS_ORG_WRITE` blocks (doc/bugs/repo-aegis-check-write-flake.md): a
guardrail must not block on its own inability to determine context. Asking is
not blocking, so an unknown destination may still `ask`.

| # | Kind | Rule | Decision | Code |
|---|---|---|---|---|
| a | shape | `git push` with no `<remote> <refspec>` | deny | `PUSH_IMPLICIT_TARGET` |
| b | shape | egress verb with `precededByCd` | deny | `EGRESS_AFTER_CD` |
| c | shape | egress verb with `joinedBy === ";"` (or `\|\|`) | deny | `EGRESS_UNGUARDED_CHAIN` |
| d | shape | payload path relative, contains `$TMPDIR`, or resolves under `/var/folders/**`, `/tmp/claude-*`, `%TEMP%` | deny | `PAYLOAD_MODE_DEPENDENT_PATH` |
| e | context | payload file's enclosing working tree has a trust boundary **positively disjoint** from the destination's | deny | `CROSS_ORG_EGRESS` |
| f | context | payload content matches the destination's deny set (`check --path` with the destination's `RepoConfig`) | deny | `PAYLOAD_MARKER_HIT` |
| g | context | destination `publicFacing`, or verb ∈ {`gh-pr-merge`, `gh-release-*`, `gh-repo-edit`, `npm-publish`}, and `!humanPresent` | `ask` if `capabilities.ask`, else deny | `PUBLIC_EGRESS_NEEDS_HUMAN` |
| h | context | destination class `scratch` | allow | — |
| — | — | otherwise | allow | — |

Reasons name the destination (`<org>/<repo>`, visibility, class) and the
ref/PR — that is the receipt-before-the-fact a human sees when asked. They
never include payload content.

Destination resolution is **offline**: `git push <remote>` →
`remote.<remote>.url` read from `cwd`'s git config → `parseRemoteUrl`; `gh …
--repo o/r` → direct; other `gh` → `cwd`'s origin. Visibility from the
`repo-aegis.visibility` cache. Class from `readRepoConfig(cwd)`. An
unparseable remote or unclassified destination yields `publicFacing: false`
and rules e–h do not fire — except that `class === "public-eligible"` with an
uncached visibility is treated as public-facing, because the class is a
declaration and the cache is only an optimisation.

Two decisions fixed here so they are not relitigated later:

- **Decision-only. Never rewrite the command.** Claude Code's `updatedInput`
  could turn `git push` into `git push origin <branch>` silently. That rebuilds
  the implicit-destination problem one layer up with the agent's intent still
  unexamined. The agent re-issues an explicit command, or a human approves.
- **Where a framework lacks `ask`, `ask` degrades to `deny` — never to
  `allow`.** The deny reason tells the agent to have a human run or approve
  the command.

### 2. Enforcement point: the git pre-push hook (every agent, every human)

`PRE_PUSH_SCRIPT` already receives `<remote-name> <remote-url>` as `$1 $2` and
uses only `$1`. Pass `$2` through:

```
repo-aegis check --push-ref "$local_ref" --remote "$remote_name" --remote-url "$2"
repo-aegis check --range "$range" --remote-url "$2"
```

`check` gains, when `--remote-url` is present:

- **`CROSS_ORG_PUSH`** — the URL's org is positively disjoint from the repo's
  own trust boundary → exit 2. Deterministic, offline, no TTY involved.
- **`PUBLIC_PUSH_NEEDS_HUMAN`** — destination `publicFacing` and no TTY on
  stderr (`isatty(2)`; stdin is always git's ref list, so it is never the
  signal) and `REPO_AEGIS_EGRESS_HUMAN` unset → exit 2 with a reason naming the
  destination and the escape.
- otherwise one stderr line: `repo-aegis: pushing <ref> → <org>/<repo>
  (<visibility>)`.

The TTY test is the same one `repo-aegis waive` uses to stop an agent minting
its own waiver, and the escape variable has the same contract as
`REPO_AEGIS_WAIVE_NONINTERACTIVE=1`: documented as human-only, an agent is
instructed never to set it, and setting it is a visible act in any transcript.
Both codes are honoured by `check`'s existing `--json` shape and appear in the
audit log when it is on.

This is the layer that reaches every agent and every terminal, because git is
the one choke point every push passes through. It is also the layer that is
inert until a repo is classified and its visibility cached — see §7.

### 3. Enforcement point: a `gh` shim on `PATH` (every agent)

Nothing chokes `gh` the way pre-push chokes `git`, so `repo-aegis install shim
gh` writes `<repoAegisHome>/bin/gh` and documents putting that directory first
on `PATH`. The shim:

1. locates the real `gh` by scanning `PATH` past its own directory (never a
   hard-coded path; never itself);
2. **passes every non-egress invocation through untouched**, `exec`'d, with
   argv intact — `view`, `list`, `status`, `api` GET, `auth`, `checks`,
   completion, `--version`;
3. for egress verbs, calls `repo-aegis egress-check --cwd "$PWD" -- "$@"`,
   which runs `decideEgress` with `humanPresent` from `isatty(2)` and
   `capabilities.ask = false` (a shell has no prompt to offer), and refuses
   with the structured reason on `deny`;
4. on allow, `exec`s the real `gh`; for `pr create|edit` with a body file, it
   instead **runs `gh`, waits, then reads the live body back**
   (`gh pr view <n> --json body`) and diffs it against the file, emitting
   `PUBLISHED_BODY_MISMATCH` with byte counts — never content — on difference.

Step 4 is the design's one deliberate network call inside an enforcement path.
The verb has already published, so the call cannot block anything; a wrong body
found in seconds is a 57-minute exposure not had. It is best-effort with a
short timeout and never changes the shim's exit code on read-back *failure*
(only on a confirmed mismatch).

`uninstall` removes the shim. `doctor` reports whether the shim directory
precedes the real `gh` on `PATH` (`SHIM_NOT_FIRST`) — a shim that exists but is
shadowed is the "hooks installed but not running" failure in a new costume.

### 4. Enforcement point: agent pre-command hooks (where offered; richer)

Three agents in current use each expose a pre-command hook that receives the
pending shell command on stdin and blocks on exit 2:

| Agent | Event | Command field | `ask` available |
|---|---|---|---|
| Claude Code | `PreToolUse`, matcher `Bash` | `tool_input.command` | yes — `hookSpecificOutput.permissionDecision: "ask"` forces a user prompt even under auto-allow |
| Codex CLI | `PreToolUse` | `tool_input.command` | not assumed |
| Gemini CLI | `BeforeTool`, matcher `run_shell_command` | `tool_input.command` | not assumed |

One entry point, `repo-aegis hook guard-egress [--agent claude|codex|gemini]`,
reads stdin with the same tolerant field lookup `scan-bash-output` uses, runs
`decideEgress` with `capabilities.ask` per the table (default: `false`, the
conservative choice), and emits:

- `allow` → exit 0, no output;
- `ask` → exit 0 with the Claude Code JSON (`permissionDecision: "ask"`,
  `permissionDecisionReason: <reason>`); on other agents this branch is
  unreachable because `ask` degraded to `deny`;
- `deny` → exit 2, structured reason on **stderr** (the channel these
  frameworks feed back to the model), JSON on stdout for frameworks that read
  it.

What this layer adds over §2 and §3: it runs **before** anything executes, it
sees the **whole compound command** — so the shape rules a–c apply here and
nowhere else, since git and `gh` receive a command the shell has already
resolved — and on Claude Code it turns "GitHub shared-state mutations need
confirmation" from a sentence in an instructions file into a prompt the human
must answer.

`install claude-md` registers it alongside the existing `check-write` hook via
the generalised `mergeHookOnEvent("PreToolUse", "Bash", …)`; it coexists with
any user-authored hook on the same matcher. Equivalent snippets for the other
two agents go in `doc/agent-install.md`.

### 5. Receipts

After a permitted egress, one line to the agent: `PUBLISHED → <org>/<repo>
(<visibility>, class <class>): <ref | PR #n | tag>`. On Claude Code via a
PostToolUse hook (`hook egress-receipt`, `additionalContext`); via the shim's
stderr elsewhere; via the pre-push stderr line for git. A model that has just
pushed to the wrong repository will skim past twenty lines of git output; it
will not skim past one line that says **PUBLIC** and a name it did not intend.

### 6. `selfIdentity` — the inverse direction

Engagement markers stop *customer* strings entering *our* repos. The first
incident was *our* strings entering a *customer's* repository — the direction
with the business cost. Add a registry list:

```yaml
# ~/.config/repo-aegis/engagements.yaml
selfIdentity:
  - example-org
  - internal-project-codename
  - claude\.ai/code/session_
```

Rendered to a reserved `_self_identity` stem and included in the deny set
**only** when the repo — or, for egress, the destination — is
`customer-coupled`. Exactly symmetric to `privateInfra`, which is included only
for public-facing repos; excluded from the flat `markers.txt` for the same
reason; part of the deny-set cache key for the same reason. `scan-env` gains a
`--self` mode that offers the operator's own org names (from `personalOrgs`)
and project names (from `package.json` `name` fields under the scan roots) as
candidates, dry-run by default.

### 7. Classification is a prerequisite, and `doctor` must say so

Every context rule above reads class and cached visibility. On the machine that
had both incidents, the public repository involved had **neither** — `classify`
returned `matched: null` because its org was not in `personalOrgs`, so it sat at
the `private-strict` default with no visibility cached. A destination-aware
control on that estate would have been silent.

`doctor` therefore gains:

| Check | Fires when | Fix |
|---|---|---|
| `PUSH_DEFAULT_IMPLICIT` | `git config --global push.default` is unset or not `nothing` | `git config --global push.default nothing` |
| `CLASS_VISIBILITY_UNRESOLVED` | repo has no explicit class **or** no cached visibility, and has a GitHub remote | `repo-aegis classify --apply && repo-aegis status` |
| `PERSONAL_ORG_UNREGISTERED` | the repo's remote org is in no engagement and not in `personalOrgs` | `engagements add --personal-org <org>` or `--github-org` |
| `SHIM_MISSING` / `SHIM_NOT_FIRST` | §3 | `install shim gh`; fix `PATH` order |
| `GUARD_HOOK_UNREGISTERED` | `settings.json` lacks the `guard-egress` entry | `install claude-md` |

`push.default nothing` is called out first because it is the single cheapest
line in this design: it makes a bare `git push` an error in every shell, for
every agent and every human, with no repo-aegis involvement at all.

### 8. Schema, output, redaction

- `registryFileSchema` += `selfIdentity: string[]` (optional; additive; older
  readers drop it via `.passthrough()` and are strictly laxer only in
  `customer-coupled` repos — document, no `schemaVersion` bump, same argument as
  `alwaysBlockExemptPaths`).
- New exit codes join `exit-codes.ts`; new error codes join the agent guide's
  table with recovery text.
- **Redaction:** reasons and receipts carry `<org>/<repo>`, visibility, class,
  ref/PR number and byte counts. Never payload content, never matched
  substrings, never registry enumeration. Payload marker hits use the existing
  `ScanHit` shape with `matchPreview` redacted.
- `--json` everywhere; hooks never pass `--verbose`.

## Threat-model and locked-decision additions

| Threat | Mitigation |
|---|---|
| Clean content published to the wrong destination (right bytes, wrong boundary) | Destination-aware egress rules at three enforcement points (pre-push, `gh` shim, agent hooks); shape rules refuse the implicit forms (`git push` with no refspec; egress after `cd`; `;`-chained egress) regardless of context |
| Agent self-approving a public egress | `ask` on frameworks that have it; TTY gate elsewhere; escape variable is human-only by contract and a visible act |
| Agent "fixing" a refused command by rewriting it silently | Hook is decision-only; `updatedInput` is never emitted |
| Own-project material entering a customer repository | `selfIdentity` stem, deny-set-included only for `customer-coupled` destinations; payload scan against the destination's rules |
| Destination controls silently inert on an unclassified public repo | `doctor` `CLASS_VISIBILITY_UNRESOLVED` / `PERSONAL_ORG_UNREGISTERED`; `public-eligible` treated as public-facing even with no cache |

| Topic | Decision |
|---|---|
| Egress hook is decision-only | `hook guard-egress` returns `allow`/`ask`/`deny`; it never emits `updatedInput`. Rewriting a command reconstructs the implicit-destination defect. |
| `ask` degrades to `deny` | On a framework without an `ask` decision, `ask` becomes `deny` with a "have a human run or approve this" reason — never `allow`. |
| Shape rules are unconditional; context rules fail open | Rules that need no registry/class/visibility (`PUSH_IMPLICIT_TARGET`, `EGRESS_AFTER_CD`, `EGRESS_UNGUARDED_CHAIN`, `PAYLOAD_MODE_DEPENDENT_PATH`) always apply. Rules that need context never block on missing context, but may still `ask`. |
| Human-presence test | `isatty(2)` on stderr, or `REPO_AEGIS_EGRESS_HUMAN=1`. Same contract as `REPO_AEGIS_WAIVE_NONINTERACTIVE=1`: documented human-only; agents are instructed never to set it. |
| One network call, post-publish only | The `gh pr create/edit` read-back is the only network call on an enforcement path; it runs after the verb has published, cannot block, is best-effort with a timeout, and affects exit status only on a confirmed mismatch. |
| `_self_identity` scoping | Included in the deny set only when the repo or egress destination is `customer-coupled`; excluded from flat `markers.txt`; part of the deny-set cache key. Mirror of `_private_infra`. |

## Test plan

- **`egress-intent.test.ts`** — table-driven: quoting, `;`/`&&`/`||`/`|`/
  newline splitting, `cd` detection (including `cd … && … ; git push`), `git
  push` with 0/1/2 positional args and with `-u`, `gh` verbs with and without
  `--repo`, every payload flag shape including `--body @file` and `-F -`
  (stdin), `gh api` with and without `-X`, non-egress commands producing an
  empty list. **The two incident commands, genericised, are fixtures**: a
  compound `cd <a> && python3 … ; git add … && git commit … ; git push` must
  yield one `git-push` intent with `precededByCd: true, joinedBy: ";"`, and
  `gh pr create --body-file "$TMPDIR/pr-body.md" --repo acme/svc` must yield a
  `PAYLOAD_MODE_DEPENDENT_PATH` decision.
- **`egress-policy.test.ts`** — every rule in isolation; evaluation order;
  fail-open on unparseable remote / unclassified destination; `public-eligible`
  with uncached visibility ⇒ public-facing; `ask`→`deny` degradation when
  `capabilities.ask` is false; `humanPresent` from both TTY and env.
- **`hook-guard-egress.test.ts`** — subprocess tests feeding Claude Code,
  Codex-shaped and Gemini-shaped stdin; exit codes and stdout/stderr channels
  per decision; **no `updatedInput` ever present** (oracle test over the whole
  serialised output).
- **Pre-push integration** — against a local bare remote whose configured URL
  parses to a foreign org: push exits 2 with `CROSS_ORG_PUSH`; same org, public
  cached, `isatty(2)` false → `PUBLIC_PUSH_NEEDS_HUMAN`; with
  `REPO_AEGIS_EGRESS_HUMAN=1` → succeeds and prints the receipt line.
- **Shim** — `tests/shim-smoke.sh`: reads pass through byte-for-byte
  (`gh --version`, `gh api GET`); an egress verb with a `/var/folders/…` body
  path is refused; a permitted `pr create` against a mocked `gh` triggers the
  read-back and reports a seeded mismatch; the shim never resolves to itself.
- **Redaction oracle** — grep every reason/receipt/JSON payload the new code
  can emit for fixture payload content and fixture marker literals; must be
  absent.
- **`ask` verified empirically** against a real Claude Code session in auto
  mode before the docs claim it forces a prompt.

## Rollout

1. **Phase 1 — shape rules + receipts.** `egress-intent`, `egress-policy` with
   rules a–d and g; `hook guard-egress` for Claude Code; `hook egress-receipt`;
   `doctor` `PUSH_DEFAULT_IMPLICIT`. Ships behind `install claude-md`; no
   behaviour change for anyone who does not re-run it.
2. **Phase 2 — git-native destination.** `check --remote-url`, `CROSS_ORG_PUSH`,
   `PUBLIC_PUSH_NEEDS_HUMAN`, pre-push template bump (hook digest changes;
   `HOOKS_SCRIPT_STALE` will tell operators to reinstall). `doctor`
   classification checks. `ask`→`deny` adapters for Codex / Gemini documented.
3. **Phase 3 — the shim and payload rules.** `install shim gh`, rules e–f,
   read-back, `selfIdentity` + `scan-env --self`.
4. **Phase 4 — server side.** `audit --pr-body` and an Action profile that runs
   it on `pull_request`, for repositories the operator controls.

## Non-goals

- **Defeating `--no-verify`, `-c core.hooksPath=…`, or calling the real `gh`
  by absolute path.** Client-side controls are advisory by construction; this
  design adds friction and makes bypass a visible, auditable act. Server-side
  push protection remains the only non-advisory control, and the server cannot
  judge destination intent.
- **Non-GitHub hosts.** `parseRemoteUrl` is GitHub-only; a null parse means
  context rules do not fire. Shape rules still do.
- **Judging whether a PR body is the *right* body.** Only the read-back or a
  human can; the design gets a wrong body in front of a human in seconds and
  makes the mismatch loud.
- **Recalling objects already pushed.** GitHub serves unreachable commits by
  sha after ref deletion on no published schedule. Everything here is
  prevention.
