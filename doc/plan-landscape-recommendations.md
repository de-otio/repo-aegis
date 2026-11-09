# Plan: act on the November 2026 landscape analysis

Status: proposed, 2026-11-09. Source: [analysis-landscape-2026-11.md](analysis-landscape-2026-11.md).

## 0. Threat model and scope rule

Unchanged: repo-aegis stops **accidental** leaks into public repositories and
between customers. It is not a wall against an agent that sets out to bypass
it (`doc/plan-recognise-dot-gh.md` §0). Every item below is judged against
that, and against two standing rules:

- **No new config for hardening's sake.** Prefer documenting a limit to adding
  a knob.
- **Every install path ships with its uninstall path, doctor check and docs**
  in the same change.

## 1. Goals

| # | Goal | From analysis |
|---|---|---|
| G0 | An agent with a valid approval can push a branch and open a PR from a default (sandboxed) Claude Code session with no further human steps | Observed 2026-11-09, Phase U |
| G1 | The egress guard runs in the agent hosts people now use: add Cursor and Copilot CLI | C2 |
| G2 | Stop growing commodity secret detection; document a companion scanner and prove the two coexist | C1 |
| G3 | Freeze the identity layer's scope and make its failure mode diagnosable | C3 |
| G4 | Make the project findable: publish the background guide, add metadata | C5 |
| G5 | Write down when to reassess (platform DLP, GitHub scoping) | C4 |

Non-goals: Kiro, Junie, Windsurf and other hosts (later, on demand); any LLM
on the gate path; a SaaS integration; changing the regex-only deterministic
gate.

## 2. Phases

The phases below define *what* to build. §3 splits them into tasks, waves
and model assignments: *who* builds what, and in what order. Each task is
one PR (or one doc edit folded into a phase PR), small enough to verify in
one session.

### Phase 0: verify host facts (spike, no code merged)

The analysis relied on vendor docs and secondary sources. Before designing
adapters, confirm from primary docs and a local run:

1. **Cursor** (`cursor.com/docs/hooks`): for `beforeShellExecution`, the stdin
   field holding the command, the deny/ask response shape, whether `ask`
   exists, and whether the hook fires for cloud agents and the Cursor CLI.
   For `afterFileEdit`, confirm it is observe-only (it cannot reject the edit).
   Config location: global `~/.cursor/hooks.json` vs project
   `.cursor/hooks.json`.
2. **Copilot CLI**: hook names, stdin shape, deny semantics, config location.
3. **Antigravity CLI** (replaced Gemini CLI in 2026): whether the existing
   `--agent gemini` adapter works with its hooks unchanged, needs a new
   adapter, or should be marked legacy. Also re-confirm the documented
   Gemini payload field (`tool_input.command`) against a real payload.
4. **Codex**: confirm the documented matcher (`shell`) and `tool_input.command`
   against a real payload, and document the `/hooks` trust-review step
   (an unreviewed non-managed hook does not run).
5. **Coexistence with ggshield**: install `ggshield machine setup` alongside
   repo-aegis in a scratch home and confirm both hooks run in Claude Code
   (PreToolUse and PostToolUse); confirm order-independence and that neither
   installer overwrites the other's entries in `settings.json` or
   `hooks.json`.

Output: a short findings section appended to this plan (§5), with the
captured stdin/stdout samples saved as test fixtures under
`packages/cli/src/commands/__fixtures__/hosts/`.

Exit criterion: each fact above is either confirmed with a fixture or marked
"unsupported", and the affected goal is cut.

### Phase U: the agent publish path must work (G0) — before Phase 1

**Observed 2026-11-09.** Opening one docs PR from an agent session took
five refusals and four human round-trips, with an active 12-hour
account-bound approval (`repo-aegis approve 'de-otio/*' --ttl 12h`):

| # | Step | Refusal | Cause |
|---|---|---|---|
| 1 | `gh repo view` (read) | `GH_IDENTITY_UNAVAILABLE` | the mint failed; a read was refused anyway |
| 2 | `git push origin <branch>` | `AGENT_PUSH_NEEDS_APP` | the repo's own SSH remote is unusable for agents |
| 3 | `git push https://…` | `AGENT_PUSH_CHAIN_UNREADABLE` | the default Claude Code sandbox blocks process-list reads; the message does not mention the sandbox |
| 4 | same push, sandbox off | succeeded | needed explicit human permission |
| 5 | `gh pr create` | `GH_IDENTITY_ARG_UNSAFE` | a repo-local `core.hooksPath` that `install hooks --local` writes (`install-hooks.ts:45`), here equal to the global value |

Why this phase comes first:

- **Self-inflicted.** Refusals 2 and 5 fire on state that repo-aegis's own
  installer and onboarding create.
- **Fails in the default agent environment.** Refusal 3 makes every agent
  HTTPS push in a sandboxed session need either the sandbox off or a person.
- **The approval barely helps.** It lifts rule g only; refusals 1, 3 and 5
  say "No approval covers this", so a person who just approved still gets
  several more round-trips.
- **Out of the threat model.** Refusals 3 and 5 defend against an agent
  deliberately exfiltrating a token, which §0 puts out of scope. Every
  more host added in Phase 1 is another place to hit this.

Items, smallest first:

| # | Change | Kind | Decision needed |
|---|---|---|---|
| U1 | Accept a repo-local `core.hooksPath` that resolves to repo-aegis's own pinned hooks directory (the same check `doctor` uses for the pin). Stop `install hooks` from writing a local value equal to the global one; `doctor` reports such a duplicate as removable | code | no |
| U2 | `AGENT_PUSH_CHAIN_UNREADABLE`: when the process list is unreadable, say that a sandbox is the likely cause and give the two remedies (run outside the sandbox, or a person runs the push). Spike: can the helper confirm git's remote helper without a process list (for example from what git passes to the helper)? Unverified | code + spike | no |
| U3 | For an owner with an App identity for agents, `doctor` and `classify` flag an SSH `origin` and offer `git remote set-url --push origin https://…` (person-run) | code | no |
| U4 | A read-only `gh` call whose identity can't be minted falls through to the active account with a warning instead of refusing (this answers the open question in Phase 3 item 3) | policy | **owner** |
| U5 | An active approval bound to an account covers the deliberate-bypass refusals (`AGENT_PUSH_CHAIN_UNREADABLE`, `GH_IDENTITY_ARG_UNSAFE`) for its scope and lifetime, not just rule g. Shape, cross-org and payload rules still apply | policy | **owner** |
| U6 | Acceptance test: a fixture session with a valid approval, in a sandbox-like environment where `ps` fails, pushes a branch over HTTPS and opens a PR (gh stubbed) with no further human step. It fails on v0.12.2 and must pass after U1–U5 | test | no |
| U7 | Refusal-text audit: every "report this to your human" refusal names the setting or environment that caused it, says whether repo-aegis created it, and says whether removing it is safe | docs + code | no |

Exit criterion: U6 passes, and the 2026-11-09 sequence above replays with at
most one human step (the approval).

### Phase 1: egress guard for Cursor and Copilot CLI (G1)

`hook guard-egress` already abstracts the host (`--agent claude|codex|gemini`,
`packages/cli/src/commands/hook-guard-egress.ts`). Extend it, don't fork it.

1. `--agent cursor` and `--agent copilot`: input adapter (command field per
   Phase 0) and output adapter (deny shape). Where the host has no `ask`,
   `ask` degrades to `deny` with the existing "have a human run or approve
   this" reason, never to `allow` (existing invariant).
2. Keep both invariants of the hook: decision-only (no rewritten command; the
   output oracle test covers the new hosts) and cheap-and-silent on non-egress
   commands.
3. Registration: match Codex and Gemini today, which are registered **by
   hand** from snippets in `doc/agent-install.md` (§ around line 593). Add
   Cursor and Copilot snippets there. No new installer in this phase: an
   installer is a new install surface and would need its own uninstall,
   doctor check and foreign-entry preservation (ggshield writes to the same
   files). If hand registration proves error-prone, adding an installer is a
   follow-up with its own plan.
4. Uninstall: the hand-registration snippet gets a matching hand-removal
   note in the uninstall section of `doc/agent-guide.md`.
5. Doctor: optional `HOOK_MISSING` per detected host, only if Codex/Gemini
   already have one; otherwise out of scope, for parity.
6. Write-scan on Cursor: wire `afterFileEdit` to the existing post-write scan
   **as detection only**. The message must say the edit has already happened
   and that the pre-commit hook is the gate. If Phase 0 shows that
   `afterFileEdit` gives no usable path, drop this step and document it.
7. Docs: `README.md` (host list), `doc/agent-install.md`,
   `doc/design/egress-guard.md` (host table), `doc/cli-reference.md`.

Tests (must fail when wrong):

- Fixture-driven: each captured host stdin → decision → exact host stdout,
  for allow, deny, ask-degraded-to-deny, and malformed input (fails open
  per existing contract, with an audit record).
- The documented snippets parse as valid host config (a test reads the
  JSON blocks out of `doc/agent-install.md`, so docs and adapter cannot
  drift apart).
- Property test (seeded-random generator, as the repo's existing property
  tests use; no fast-check dependency): for any generated non-egress command, every
  host adapter emits nothing and exits 0.

### Phase 2: freeze secret detection, document a companion (G2)

1. Add a header comment to `hook-scan-bash-output.ts` and a paragraph to
   `doc/design/README.md`: the universal secret-shape set is closed; new
   secret types belong in a dedicated scanner.
2. README and `doc/agent-install.md`: a "Companion tools" section naming
   ggshield (AI hooks, git hooks) and gitleaks (pre-commit, CI) as the
   recommended secret scanners, with what each covers and what repo-aegis
   covers instead (engagement scoping, destination, identity).
3. Record the Phase 0 coexistence result in the same section, including any
   ordering caveat.

No code behaviour change. Verification: the coexistence check from Phase 0,
re-run against the docs' instructions as written.

### Phase 3: identity layer, scope freeze and diagnosability (G3)

1. Add a "Non-goals" section to `doc/plan-owner-identity.md`: no general
   account switcher, no switching of the global active `gh` account, no new
   token sources beyond those v0.12 ships. Say why: owner-switching helpers
   exist, and maintenance cost lands here first.
2. ~~`GH_IDENTITY_UNAVAILABLE` diagnosability~~ **Done in v0.12.2**
   (`fix/mint-diagnostics`): mint failures are classified from the helper's
   exit code and stderr into fixed texts (stderr never printed), a timeout
   is reported as a timeout, git-credential audits failed mints, and
   doctor groups `OWNER_IDENTITY_UNMAPPED`. Drop task T3c unless a gap
   remains after that release.
3. **Open question for the owner (decide before coding; now Phase U item
   U4):** should a read-only
   `gh` call (for example `gh repo view`) that cannot mint its identity fail
   closed as today, or fall through to the active account with a warning?
   Reads publish nothing, but the wrong identity can still see a private repo
   it should not. Default if undecided: keep fail-closed and only improve the
   message.

Tests: one per doctor failure category, each asserting the exact code and
that no secret-shaped string appears in output (reuse the bash-output
secret-shape matcher as the oracle).

### Phase 4: discoverability (G4)

1. Publish the data-leak prevention guide the README's "Background" section
   promises. Before publishing, run `repo-aegis check` on it and a manual
   read for customer-derived strings; the guide is about leaks, so it
   attracts concrete examples.
2. Replace the "once published" sentence with the link.
3. `package.json` keywords (e.g. `claude-code`, `ai-agents`, `dlp`,
   `pre-commit`, `data-leak-prevention`, `cursor`, `codex`) and GitHub repo
   topics and description.
4. Optional, each needing a separate go-ahead because it is public egress:
   submit to one or two curated lists of agent hooks or agent security tools.

Every push, `gh repo edit` and external submission in this phase is
confirmed per invocation (public repository).

### Phase 5: reassessment triggers (G5)

Add a short "Reassess when" list to the analysis doc's verdict (already
drafted there), and a calendar note for about May 2027:

- Claude Enterprise inference hooks reach GA with a stable `tool_call`
  contract (the event exists in beta already; see analysis §3.3).
- A hosting service offers per-repository secret patterns hidden from the
  repository's own admins.
- ggshield or Nightfall ship local, per-repository dictionaries.
- Any host ships a native "this workspace belongs to engagement X" concept.

Done: the list is in doc/analysis-landscape-2026-11.md §5.

## 3. Execution: tasks, waves and models

### 3.1 Model assignment rule

| Model | Gets | Why |
|---|---|---|
| **Opus** | Interface specs, security-boundary decisions, decision memos, reviewing builders' output against the spec | Errors here propagate into every task built on them |
| **Fable** (`security-reviewer` agent) | Security review of code on the enforcement path | Independent read of the trust boundary, not anchored on the builder |
| **Sonnet** | Building to a written spec, research spikes, fixture capture, test loops, doc sections that need judgement, `test-critic` | Execution against a spec |
| **Haiku** | Mechanical edits with the text given, metadata, lookups | No judgement needed |

Every Agent call names its model explicitly. A task moves up a tier only
when this plan says why.

### 3.2 Task list

`H` marks a step only the owner can do (a decision, a GUI host run, or a
public egress). Agents stop at an `H` and report; they never work around one.

| ID | Task | Phase | Model | Depends on | Output |
|---|---|---|---|---|---|
| TU6 | Acceptance test for the agent publish path (Phase U item U6), written first; it must fail on v0.12.2 | U | Sonnet | none | failing test, committed with a skip marker that names Phase U |
| TU1 | Accept repo-aegis's own pinned hooks path in the `GH_IDENTITY_ARG_UNSAFE` check; `install hooks` stops writing a duplicate local value; `doctor` reports an existing duplicate | U | Sonnet | none | code plus tests |
| TU2 | Sandbox-aware `AGENT_PUSH_CHAIN_UNREADABLE` text, plus a spike on confirming git's remote helper without a process list | U | Sonnet | none | code plus tests; spike findings in §5 |
| TU3 | `doctor`/`classify` flag an SSH `origin` for owners with an App identity and print the person-run `set-url --push` line | U | Sonnet | TU1 merged (both touch doctor) | code plus tests |
| TU7 | Audit the refusal texts that say "report this to your human" (U7) | U | Sonnet | TU1, TU2 | text changes plus tests that pin each message's cause line |
| TUm | Decision memo for U4 (read fall-through) and U5 (approval covers the deliberate-bypass refusals): what each lets through, against the §0 threat model, with a recommendation. Replaces T3a | U | Opus | none | memo in §5 |
| HU | Decide U4 and U5 | U | owner | TUm | decision recorded in §5 |
| TU45 | Build whatever HU decides for U4 and U5 | U | Sonnet | HU | code plus tests |
| RU | Security review of TU1, TU2 and TU45: no token leaves the process and no hook runs from a non-pinned path; an approval cannot widen past its account and scope | U | Fable (`security-reviewer`) | TU1, TU2, TU45 | findings |
| T0a | Hook facts for Cursor, Copilot CLI, Antigravity CLI and Codex (Phase 0 items 1–4): read primary docs, write a stdin-dumping probe hook, capture fixtures | 0 | Sonnet | none | §5 findings, fixtures under `__fixtures__/hosts/` |
| H1 | Trigger one allowed and one egress command in each host with the probe hook installed (if the agent can't drive the host itself) | 0 | owner | T0a probe ready | raw stdin captures |
| T0b | ggshield coexistence in a scratch `HOME`: both installers, both hooks firing in Claude Code, no overwritten entries. If a GitGuardian API key is needed, stop and ask; do not create a credential | 0 | Sonnet | none | §5 findings |
| T3a | ~~Decision memo for the read-only `gh` fallback~~ folded into TUm | 3 | — | — | — |
| H2 | ~~Decide T3a~~ folded into HU | 3 | — | — | — |
| T3b | Non-goals section in `doc/plan-owner-identity.md` (text in Phase 3 item 1) | 3 | Haiku | none | doc edit |
| T4a | Locate the background data-leak guide, prepare a publishable version, `repo-aegis check --path` plus a manual customer-string read | 4 | Sonnet | none | draft ready for H3 |
| T4b | `package.json` keywords; draft GitHub topics and description (do not apply) | 4 | Haiku | none | diff plus proposed `gh repo edit` line |
| T5 | "Reassess when" list into the analysis doc | 5 | Haiku | none | doc edit |
| T1a | Host-adapter contract: a typed `HostAdapter` (parse stdin → command or malformed; render decision → stdout and exit code; `hasAsk`), one module per host under `commands/hook-hosts/`, fixtures-to-expected-output table. Refactor the existing claude/codex/gemini handling behind it with no behaviour change | 1 | Opus spec, Sonnet builds the refactor | T0a, H1 | spec in §5; refactor PR with behaviour-comparison tests (old vs new output on all existing fixtures) |
| T1b | Cursor adapter | 1 | Sonnet | T1a | `hook-hosts/cursor.ts` plus fixture tests |
| T1c | Copilot CLI adapter | 1 | Sonnet | T1a | `hook-hosts/copilot.ts` plus fixture tests |
| T1d | Cursor `afterFileEdit` → post-write scan, detection-only message | 1 | Sonnet | T1b | wiring plus test, or a documented drop |
| T1e | Hand-registration snippets and removal notes in `agent-install.md` / `agent-guide.md`; host tables in `egress-guard.md`, `cli-reference.md`, README; the snippet-parsing test | 1 | Sonnet | T1b, T1c | docs plus test |
| T1f | Property test: any generated non-egress command → every adapter silent, exit 0 | 1 | Sonnet | T1b, T1c | seeded-random property test |
| T2 | Freeze comment in `hook-scan-bash-output.ts`; "Companion tools" section with the T0b result | 2 | Sonnet | T0b | doc PR |
| T3c | ~~Doctor failure categories for `GH_IDENTITY_UNAVAILABLE`~~ done in v0.12.2; reopen only for a gap left after it, and for any change H2 decides | 3 | Sonnet | H2 | code plus tests, if any |
| R1 | Review T1a–T1f against this plan and the T1a spec | 1 | Opus | T1a–T1f | findings, fixes by the builder |
| R2 | Security review of T1a–T1d and T3c: decision-only invariant, fail-open with audit on malformed input, `ask` never degrades to `allow`, no token or helper output in any message | 1, 3 | Fable (`security-reviewer`) | T1d, T3c | findings |
| R3 | `test-critic` on the tests from T1a–T1f and T3c | 1, 3 | Sonnet | T1f, T3c | findings |
| H3 | Approve each public egress: PR pushes, guide publication, `gh repo edit`, any list submission | 4, all | owner | each PR | per-invocation `repo-aegis approve` |
| F | Full suite plus coverage once, in the main checkout after merges | all | main session (Sonnet) | all | green run |

### 3.3 Waves

```
Wave 0 (Phase U, first; up to 4 agents):
  TU6  TU1  TU2  TUm            ← Sonnet, Sonnet, Sonnet, Opus
  then TU3 (after TU1), TU7 (after TU1 + TU2)
  owner: HU (when TUm lands) → TU45 (Sonnet) → RU (Fable)
  exit: TU6 passes and the 2026-11-09 sequence replays with one human step

Wave 1 (research and docs; may overlap Wave 0, as nothing here touches code):
  T0a  T0b  T4a                 ← Sonnet, Sonnet, Sonnet
  T3b  T4b  T5                  ← Haiku, in one agent, doc-only, no tests
  owner: H1 (when T0a's probe is ready)

Wave 2 (after T0a + H1, and after Wave 0's exit):
  T1a                           ← Opus spec, then Sonnet refactor (serial: everything builds on it)
  T2   (after T0b)              ← Sonnet, parallel with T1a
  T3c  (only if a gap remains)  ← Sonnet, parallel with T1a

Wave 3 (after T1a merges):
  T1b  T1c                      ← two Sonnet agents in parallel, separate worktrees and modules
  then T1d (after T1b), T1e + T1f (after T1b + T1c)

Wave 4 (reviews, in parallel):
  R1 (Opus)  R2 (Fable)  R3 (Sonnet)  → builders fix → F
```

Critical path: TUm → HU → TU45 → RU (Wave 0 exit) → T1a → T1b/T1c →
T1e/T1f → R1/R2 → F, with T0a → H1 running beside Wave 0. Phase 4 needs the
owner (H3) and runs on its own clock.

Why Wave 0 gates Phase 1: every host Phase 1 adds is another session that
hits the broken publish path. Fixing the path first means the new hosts
arrive usable.

Why T1a stays serial: the existing claude/codex/gemini handling sits in
one file. Building two adapters against it in parallel would conflict.
Extracting the adapter interface first lets T1b and T1c touch disjoint
files.

### 3.4 Running the agents

- **Isolation:** each code task gets its own worktree (`isolation:
  "worktree"`). Doc-only Haiku tasks can share one. Remove each worktree and
  its merged branch in the same turn the PR merges.
- **Resource budget:** at most 4 agents running tests at once. Each agent
  runs one test run at a time, scoped first: `npm run build`, then
  `npm run test:file -- --test-concurrency=2 <dist test files>`. The full
  suite runs only in step F. The orchestrating session keeps a load and
  memory watchdog running (1-minute load > 16 twice, or free memory < 15%)
  and serialises agents when it fires.
- **One level of fan-out:** task agents do not spawn agents of their own.
- **Briefs:** each agent gets its task row, the relevant phase section, the
  §0 threat model and the files to touch. Builders get the T1a spec, not
  the reviewer's opinions; reviewers get the code and the spec, not the
  builder's summary.
- **Agent output is a draft** until the scoped tests pass and R1–R3 have
  run. Nothing merges on the builder's word.
- **Egress:** agents may commit in their worktree. Pushes and PRs go
  through the orchestrating session, with H3 for this public repo.

### 3.5 Effort

| Wave | Wall-clock | Owner time |
|---|---|---|
| 0 (Phase U) | 1 to 1.5 days | HU about 15 min |
| 1 | half a day | H1 about 15 min |
| 2 | half a day | none |
| 3 | 1 day | none |
| 4 | half a day plus fixes | merge approvals |
| Phase 4 | independent | guide editing plus H3 |

## 4. Risks

- **Host hook formats drift.** Cursor's and Copilot's hook specs are young.
  Mitigation: fixtures from real runs, and fail-open plus an audit record on
  unrecognised input, as today.
- **Config collisions** with ggshield or other tools editing the same
  JSON. Mitigation: hand registration in Phase 1, and the Phase 0
  coexistence check.
- **Scope creep in Phase 1** (adding every host). Mitigation: the non-goals
  list; new hosts only on demand.

## 5. Phase 0 findings

_To be filled in by the Phase 0 spike._

### T0b ggshield coexistence

Question: do GitGuardian ggshield's AI hooks and repo-aegis's Claude Code hooks
coexist in one `settings.json`?

**Result: they coexist at the file level. ggshield appends its own entries and
leaves every foreign entry untouched.** The install step needed no GitGuardian
login or API key. Nothing was scanned (a scan needs the SaaS account); only the
installer and the resulting `settings.json` were checked.

Setup (all in a throwaway `HOME` under the session scratchpad, never the real
home; ggshield installed into a venv inside the worktree, since removed):

- ggshield 1.56.1 (`uv pip install ggshield` into a venv; `pip` itself failed
  inside the sandbox on a macOS certificate-trust error, `uv` did not).
- `HOME`, `XDG_CONFIG_HOME`, `XDG_CACHE_HOME` and `XDG_DATA_HOME` pointed into
  the scratch directory, with the working directory outside any git repository.
- A starting `~/.claude/settings.json` with the same event/matcher shape that
  `install claude-md` writes (`claude-hook-specs.ts`), the commands replaced by
  `true # repo-aegis hook <name>`: `PreToolUse` `Write|Edit|MultiEdit` and
  `Bash`; `PostToolUse` `Write|Edit|MultiEdit` and `Bash` (two commands);
  `SessionStart` `*`; plus one `permissions.deny` rule.

Commands and observations:

1. `ggshield install -m global -t claude-code` printed a deprecation warning
   (use `ggshield machine setup`) and "Claude Code hooks successfully added".
2. `GGSHIELD_NO_ENDPOINT_REGISTRATION=1 ggshield machine setup --no-git-hooks
   --no-honeytokens --agent claude-code` on a fresh copy of the starting file
   gave a byte-identical result to (1). `machine setup` also installs global git
   hooks, plants a honeytoken and registers the machine on the Endpoints page
   unless those are switched off, so the flags above matter; those parts were
   not exercised. A second run printed "already installed" and changed nothing
   (idempotent).

What changed in `settings.json`:

- Every repo-aegis entry, the `permissions.deny` rule and their order are
  unchanged.
- ggshield added one entry `{"matcher": ".*", "hooks": [{"type": "command",
  "command": "<abs path>/ggshield secret scan ai-hook"}]}` at the END of
  `PreToolUse`, at the END of `PostToolUse`, and as a new `UserPromptSubmit`
  array. It never merges into an existing matcher entry (its `.*` differs from
  `Bash`, `Write|Edit|MultiEdit` and `*`), so it replaces nothing.
- The ggshield command is `ggshield secret scan ai-hook` with the absolute path
  of the binary that ran the install.

Caveats:

- Both ggshield (`.*`) and repo-aegis (`Bash`, `Write|Edit|MultiEdit`) match the
  same tool call, so two hooks fire per event. Claude Code runs the matching
  hooks of an event in parallel, so neither tool can rely on running before or
  after the other; a block from either one stops the tool call. No ordering
  dependency exists, and none should be documented as a guarantee.
- Only one install order was tested (repo-aegis entries first, ggshield second).
  The reverse follows from reading `mergeHookOnEvent` and `placeHookCommand` in
  `install-claude-md.ts`: repo-aegis adds or replaces only commands recognised as
  its own and finds its matcher entry by exact matcher, so a ggshield `.*` entry
  is left alone. It was not run, because the repo-aegis CLI was not built in
  this worktree and `install claude-md` writes to the real home.
- repo-aegis's uninstall removes only commands it recognises as its own
  (`repo-aegis` plus the hook name), so ggshield's entries survive it. The
  reverse (ggshield's own uninstall leaving repo-aegis's entries) was not run.
- The ggshield hook command embeds the absolute path of the binary, so moving
  or removing the venv/package breaks the hook (Claude Code reports a missing
  command as a non-blocking error).
- Whether ggshield's hooks scan correctly alongside repo-aegis's in a live
  Claude Code session, and what a scan costs per tool call, was not tested
  (needs a GitGuardian account).

### TU2 spike: can the credential helper confirm git's remote helper without the process list?

**Answer: no reliable signal exists. Nothing was implemented on it; the unreadable-chain path rests on the approval (U5) instead.**

Method (2026-11-09, git 2.56.0, macOS, one 30-minute box). A local HTTP server answered every request with `401` and `WWW-Authenticate: Basic`. `git ls-remote` against it ran a stub credential helper that recorded what it received (argv, stdin, the names of the `GIT_*` environment variables, the kinds of open file descriptors, its parent). The server needed a local port, which the default Claude Code sandbox refuses, so the experiment ran with the sandbox off. The comparison run, `git credential fill` with the same attributes on stdin, was refused by repo-aegis's own egress hook and was not rerun around it; its behaviour is taken from git's source and the definition of the protocol, and is marked below as reasoned, not observed.

What git passes to a helper, from the observed run:

| Channel | Content | Distinguishes git's remote helper from an arbitrary caller? |
|---|---|---|
| argv | `<helper> get` | No. The same for any caller of the helper. |
| stdin | `capability[]=authtype`, `capability[]=state`, `protocol`, `host`, `path` (with `credential.useHttpPath`), `wwwauth[]` after a `401` | No. These are the credential-protocol attributes. `git credential fill` reads the same lines from its own stdin and forwards them to the helper, so any caller can supply a `wwwauth[]` line. (Reasoned.) |
| environment | `GIT_EXEC_PATH`, `GIT_DIR`, `GIT_PREFIX`, `GIT_EDITOR`, `GIT_CONFIG_PARAMETERS` | No. git sets these for every child it starts, from any subcommand, and a shell can set them too. There is no variable that only `git-remote-http(s)` sets. |
| file descriptors | stdin and stdout are pipes, plus inherited pipes and directory handles from the harness | No. No git-specific descriptor. |
| parent | `git-remote-http` (visible here only because `ps` worked) | Yes, but only through the process list, which is the thing that is unreadable. |

Other routes considered and rejected without more experiments: `getppid()` gives a pid, not an identity (only `sysctl`/`ps`/`proc_pidpath` turn it into a name, and the sandbox blocks those reads); a socket or pipe credential carried by git does not exist; a nonce in the git config would have to be readable by the caller too (the caller is the same user), so it separates nothing; `GIT_TRACE*` variables are the opposite of a signal, since the helper refuses when they are set.

Conclusion: whatever git hands the helper, a caller can hand it too. This matches the threat model in §0: the process list was only ever a check against an accidental `git credential fill`, not against a deliberate caller. Where it cannot be read, "cannot tell" is covered by a person's approval (U5), which is the only signal that a person decided agents may push here.
