# repo-aegis — agent install guide

> Audience: a coding agent (Claude Code, Cursor, Aider, Cline, etc.) that
> a developer has just told to *install and configure* repo-aegis on
> their machine. The agent has been pointed at
> `https://github.com/de-otio/repo-aegis` and needs to know what to do.
>
> Purpose: take the agent from "package not on disk" to "registry
> configured, hooks wired, status verified" without making compliance
> decisions on the user's behalf and without leaking the user's
> customer data.

If you are a human reading this: yes, it is written second-person at
your AI. Skip to the [README](../README.md) for the user-oriented
overview and to [doc/agent-guide.md](agent-guide.md) for the
operator guide that takes over after install.

## What you are installing

repo-aegis is a CLI for the consultant / contractor pattern: one
machine, multiple concurrent customer engagements, plus personal and
OSS work. It stops customer-A's data from leaking into customer-B's
repo (or into a public OSS repo) by maintaining an
**engagement-scoped deny set** of customer-identifying patterns and
running it as a deterministic gate on every write path: pre-commit,
pre-push, and Claude Code Pre/PostToolUse hooks.

You are not building a model. You are wiring a **regex gate**. The
gate runs locally; nothing leaves the machine.

Read [doc/agent-guide.md](agent-guide.md) ("Mental model" + "The
five facts to internalise") before configuring engagements — those
sections explain what the user is going to ask you to set up and
why each constraint exists. The install steps below assume you've
internalised that framing.

## What this guide does NOT do for you

These are compliance decisions only the user can make. Surface them,
do not guess:

- **Which engagements exist.** You must ask the user. Do not infer
  customer names from filenames, recent conversation, or git remotes
  on disk.
- **What the markers are for each engagement.** The user knows their
  customer's identifiers (company name, codename, canonical domain,
  internal hostnames). Ask. Do **not** invent markers.
- **Which classification to apply to each existing repo.** Use
  `classify --apply` (which derives from the git remote + registry
  org membership) when you have it; ask the user when you don't.
- **Whether to enable the audit log** (off by default, opt-in
  compliance trail). Ask.
- **Whether to encrypt the registry at rest.** Surface as an option;
  do not auto-encrypt.

## Pre-flight

Before installing, check:

```sh
node --version          # CI tests Node 22 and 24; package.json has no `engines` field
npm --version
which repo-aegis        # is it already installed?
```

If `repo-aegis` is already on PATH:

```sh
repo-aegis --version
repo-aegis status       # in any git repo, to confirm it works
```

If the existing install is older than the current published version,
ask the user whether to upgrade (`npm install -g
@de-otio/repo-aegis@latest`). Don't auto-upgrade — a working install
might be older for a reason.

If the user is on a machine they don't have global npm permissions
on, install per-project instead:

```sh
npm install --save-dev @de-otio/repo-aegis
# then invoke as: npx repo-aegis ...
```

## Step 1 — install the package

```sh
npm install -g @de-otio/repo-aegis
```

The package publishes from npm with **trusted publishing
provenance** (a SLSA provenance attestation; confirmed on the npm registry
for v0.12.1; which release first carried it was not checked). After install:

```sh
repo-aegis --version
repo-aegis --help
```

If `npm install -g` fails on permissions, do not `sudo`. Surface
the error. The user has either an `nvm` / `volta` setup that
isolates global installs, or they want a per-project install.

## Step 2 — bootstrap

```sh
repo-aegis init
```

This is idempotent. It:

1. Creates `~/.config/repo-aegis/` (configurable via
   `REPO_AEGIS_HOME`).
2. Scaffolds an empty `engagements.yaml` registry.
3. Renders empty marker files (one per engagement, plus `_always`).
4. Installs git hooks at `~/.config/repo-aegis/hooks/` (pre-commit,
   pre-push) and sets `core.hooksPath` in the global git config (`install
   hooks --local` sets it for one repo instead).
5. Installs the Claude Code hooks: PreToolUse `check-write` (refuses
   cross-org writes), PreToolUse `guard-egress` (judges where a
   publishing command would send bytes), PostToolUse
   `scan-after-write` (deny-set scan), PostToolUse
   `scan-bash-output` (secret-shape scan), PostToolUse
   `egress-receipt` (names the destination after a publish), and
   the SessionStart `first-touch` hook (auto-classify on first
   touch).
6. Appends a managed block to `~/.claude/CLAUDE.md` describing the
   hook behaviour to the agent.

It does **not** install the `gh` shim — the egress guard's one layer
that works for every agent and every human, not only Claude Code —
because the shim needs a shell-profile edit only the user can make.
That is [Step 2b](#step-2b--install-the-gh-shim), and it is not
optional: without it a `gh pr create` from a terminal, from Codex, or
from Gemini CLI / Antigravity CLI reaches GitHub unjudged.

After `init`:

```sh
repo-aegis engagements list --json
# -> { "engagements": [], "alwaysBlock": { "patternCount": 0 } }
```

Empty registry. That's expected — you haven't configured anything
yet.

If the user has `REPO_AEGIS_HOME` set in their environment (a
non-default config home), `init` honours it. Don't try to "fix"
this — it's deliberate.

## Step 2b — install the `gh` shim

```sh
repo-aegis install shim
# -> installed shim at ~/.config/repo-aegis/bin/gh
#    The shim only guards once ~/.config/repo-aegis/bin comes FIRST on PATH. Add to your shell profile:
#      export PATH="/home/<user>/.config/repo-aegis/bin:$PATH"
```

Two halves, and the command can only do the first:

1. **Write the shim.** Idempotent; a second run reports `already
   installed`. If a file that repo-aegis did not write is already at
   that path, the command refuses with `SHIM_PATH_OCCUPIED` and leaves
   it alone — surface that to the user; it is their wrapper, not yours
   to overwrite.
2. **Put the shim's directory first on `PATH`.** Ask the user which
   shell profile they use (`~/.zshrc`, `~/.bashrc`, `~/.config/fish/…`)
   and add the printed `export PATH=…` line to it — or show them the
   line and let them add it. A shim that is installed but not first on
   `PATH` never runs; `doctor` reports it as `SHIM_NOT_FIRST`.

**`PATH` is per-process, so the profile line only reaches shells started
after it.** Every process already running — the terminal window you are
in, and an agent host that snapshotted its launcher's environment — keeps
the `PATH` it started with. Tell the user to restart the shell *and* the
agent host after the profile edit, and to run `doctor` in the shell they
actually publish from: a missing `PUBLISHED →` receipt is otherwise the
only sign the shim was bypassed. The agent hook refuses a `gh` publishing
verb outright (`SHIM_UNREACHABLE_NEEDS_HUMAN`) when the shim is not first
on its own `PATH`, rather than asking a question no layer beneath it could
enforce — but that covers one agent, and only `gh`.

Why this layer exists when the Claude Code hook already judges `gh`
commands: the hook guards one agent's sessions. The shim sits in front of
*every* `gh` invocation on the machine — a human terminal, Codex, Gemini
CLI or Antigravity CLI, a script — and it is the only place the post-publish read-back
(`PUBLISHED_BODY_MISMATCH`) happens. Non-publishing verbs (`gh pr view`,
`gh api GET`) pass straight through.

After the profile edit, in a **new** shell:

```sh
repo-aegis doctor
# -> SHIM_MISSING ok, SHIM_NOT_FIRST ok, PUSH_DEFAULT_IMPLICIT ...
```

If `PUSH_DEFAULT_IMPLICIT` is not ok, `git config --global push.default`
is anything but `nothing` (unset, `simple`, `current`, ...; only the global
scope is read), so a bare `git push` still works. The guard
refuses a bare push from an agent anyway, but making it an error for
humans too is one line — recommend
`git config --global push.default nothing` and let the user decide.

## Step 3 — collect engagement information from the user

This is the **interactive step**. You don't know the user's
customers; ask. A reasonable script:

> I'll need a few pieces of information to configure repo-aegis.
> For each customer / employer / engagement that you currently work
> with on this machine, tell me:
>
> 1. A short stable id (e.g. `customer-a`, `acme`, `client-foo`).
>    This goes in commit messages and config; it's not customer-
>    visible. Avoid the literal customer name if the id will appear
>    in public artefacts.
> 2. A human-readable name (e.g. "Customer A").
> 3. The GitHub org(s) that map to this engagement (e.g.
>    `acme-corp`). This lets repo-aegis auto-classify future repos
>    in those orgs without prompting.
> 4. Three to five **markers** — short regex patterns identifying
>    strings that should not appear outside this engagement's repos.
>    Common patterns: company name (`\\bacme-corp\\b`), product
>    codenames, canonical domain (`acme\\.com`), internal hostname
>    pattern (`internal\\.acme\\.example`), bug-tracker prefix.
>
> Also tell me your *personal* GitHub orgs — orgs you own where
> public/OSS work happens. These are configured separately; a repo in one
> is classified `public-eligible` only if GitHub says that repo is public.

Ask for all engagements at once if it's natural in the conversation;
ask one at a time if the user prefers. Either is fine.

**Things to watch for when listening to the user's answers:**

- **Marker patterns are regexes.** If the user gives you a literal
  string with a regex metacharacter (e.g. `acme.com`), wrap the
  metacharacter in escape (e.g. `acme\\.com`) before passing to
  `engagements add`. The CLI runs a regex-safety validator (rejects
  ReDoS-suspect patterns and oversize patterns) but cannot fix
  ambiguous user intent.
- **Don't suggest markers.** The user knows what's identifying for
  their customer. You don't.
- **The id is not the marker.** `customer-a` is the engagement id;
  the marker is the literal regex that catches that customer's
  strings. They look similar in examples but they are different
  fields.
- **Personal orgs ≠ engagement orgs.** A single GitHub org belongs
  to *exactly one* of {`personalOrgs`, an engagement's
  `githubOrgs`}. The CLI enforces uniqueness across engagements; if
  the user lists the same org twice, ask which scope it belongs to.

## Step 4 — register engagements, then have the user register their owners

Two different things happen here, and only the first is yours.

**4a. You register each engagement that has no GitHub org, with its markers.**
Leave the org flags off. An engagement is created once: a second
`engagements add` for the same id fails with `ENGAGEMENT_EXISTS`, and no verb
adds an org to an existing engagement. So skip 4a for any engagement that has
a GitHub org; 4b creates that one in a single command.

```sh
repo-aegis engagements add customer-a \
  --name "Customer A" \
  --marker '\bacme-corp\b' \
  --marker 'acme\.com' \
  --marker 'AC-[0-9]+'
```

Use **single quotes** to avoid shell-interpreting the regex.

**4b. The user registers the owners, from their own terminal.** An *owner*
is a GitHub org or login whose repositories repo-aegis may publish to:
`--github-org` ties an org to an engagement, `--personal-org` lists an org
or login the user owns (no engagement created). Registering one tells
repo-aegis that publishing there is safe, so those commands refuse unless a
person is at a terminal (`OWNER_ADD_NEEDS_TTY`), and the agent hook refuses
any command line that contains them (`AGENT_RAN_HUMAN_COMMAND`). **Do not run
them, wrap them in `script`, `tmux` or `bash -c`, or edit
`engagements.yaml`.** For an engagement with a GitHub org, the user's command
creates the engagement with its org and its markers together. Print the exact
lines for the user, with the engagement id and org from step 3 and the markers
as `<marker>` placeholders (do not echo the patterns; the user fills them in
from their own notes), and wait until they say they have run them:

> Please run these in your own terminal window (not through me), then tell me
> when they are done:
>
> ```sh
> repo-aegis engagements add customer-a --github-org acme-corp \
>   --marker '<marker>' --marker '<marker>'
> repo-aegis engagements add --personal-org rmyers --personal-org my-oss-org
> ```

Tell the user why it matters: once any owner is registered, repo-aegis
refuses, from a shell with no person at it, any publish to an owner that is
not on the list, so the list has to be complete. That includes the user's own
`gh` login and every org they publish to. `repo-aegis doctor` (step 6) lists
the logged-in accounts and orgs that are missing. An operator who registers no
owner at all gets no owner check (`OWNERS_UNDECLARED`), and a `*` approval then
covers `npm publish` only.

If the user's `~/.config/repo-aegis/classify.yml` holds legacy rules, they run
`repo-aegis init --migrate-classify` themselves in the same way: it lists the
owners it would register and waits for a typed `y`.

After each `engagements add`, the CLI returns JSON with the rendered
marker count. Surface the result to the user briefly:

> Registered customer-a (Customer A). 3 markers active. The marker
> file lives at `~/.config/repo-aegis/markers/customer-a.txt`.

The user **does not** need to see the literal patterns echoed back
— they typed them in. Don't echo them.

If `engagements add` fails with `PATTERN_VALIDATION`:

- The error reports the engagement id and a structural reason
  (`regex-syntax`, `redos-suspect`, `oversize`). It **does not**
  echo the literal pattern.
- Tell the user which engagement and which reason. Ask for a
  reformulated pattern. Do **not** auto-rewrite the pattern; that's
  your guess at intent.

If `engagements add` fails with `ENGAGEMENT_EXISTS`:

- The id is already registered. Run `repo-aegis engagements show
  <id> --json` to inspect, surface the existing entry, and ask the
  user whether to pick a different id. `engagements add` is not additive:
  no verb adds an org or a marker to an existing engagement, and
  `--github-org` only takes effect on a newly created one. To add an org to
  an existing engagement, the user edits its `githubOrgs` in the registry
  file themselves.

If the user reports that `engagements add --github-org X` failed because `X`
already belongs to another engagement / `personalOrgs`, ask which scope it
should belong to. Do **not** auto-resolve, and do not run the corrected
command yourself. If a mutator fails with `REGISTRY_WOULD_BE_INVALID`, nothing
was written; it usually means an org was registered twice.

## Step 5 — classify the user's existing repos

For every git repo on disk that the user works in, the
classification (`repo-aegis.class` + allowed engagements) needs to
be set. Two paths:

**Auto-classify based on remote** — for each repo:

```sh
cd /path/to/repo
repo-aegis classify --apply
```

If the repo's `git remote get-url origin` matches an engagement's
`githubOrgs`, it sets `repo-aegis.class = customer-coupled` and
`allow`s that engagement. If it matches `personalOrgs`, it asks GitHub
(`gh repo view`) whether the repo is public: `public-eligible` if so,
`private-strict` if not, and if that cannot be resolved it exits 2 with
`VISIBILITY_UNRESOLVED` and sets nothing (see
[doc/agent-guide.md](agent-guide.md)). If neither matches, it reports
`matched: null` and sets nothing — ask the user.

**Manual classify** when auto fails:

```sh
git config repo-aegis.class private-strict       # or customer-coupled / public-eligible / scratch
repo-aegis allow customer-a                       # only for customer-coupled
```

Do **not** classify customer repos as `public-eligible`. Do **not**
classify personal repos as `customer-coupled`. The classes are
not interchangeable; their hook behaviour differs (see
[doc/agent-guide.md "The four classes"](agent-guide.md)).

If the user has many repos, you can sweep with the SessionStart
hook (already installed in step 2): each time the user opens a
repo in their agent, `repo-aegis hook first-touch` runs and either
classifies cleanly or surfaces `needs-confirmation`. So you don't
have to classify every repo eagerly during install.

## Step 6 — verify

```sh
repo-aegis engagements list --json
repo-aegis status                                 # in some classified repo
```

`status` should show the repo's class, allowed engagements, and a
non-zero `patterns` count. If `patterns: 0`, no engagement has
markers configured yet — go back to step 4.

Sanity-test the deny set in a `customer-coupled` repo:

```sh
cd /path/to/customer-a-repo
repo-aegis markers test 'acme-corp' --json
# -> { "input": "acme-corp", "matches": [...] }   # at least one match for customer-a
```

If a known-good marker doesn't match, the engagement may not be
`allow`'d in that repo, or the regex is broken. Re-check `status`.

## Step 7 — hand off to the operator guide

At this point repo-aegis is installed and configured. From here on,
the agent's day-to-day operation — reacting to hits, adding new
engagements, classifying new repos, handling cross-org writes — is
covered in **[doc/agent-guide.md](agent-guide.md)**. Read it before
the user starts working.

Surface to the user:

> repo-aegis is installed and configured. {N} engagement(s)
> registered. {M} repo(s) classified.
>
> The hooks now run on every Write/Edit/MultiEdit and every Bash
> tool call. If a write would cross trust boundaries
> (`CROSS_ORG_WRITE`) it is refused before the file is created. If
> a write contains a marker for a forbidden engagement, the tool
> result is meant to carry a redacted hit with the engagement id and the
> file:line:column (whether the agent sees it is unverified, see
> [doc/agent-guide.md](agent-guide.md)).
>
> Publishing commands (`git push`, `gh pr create`, `npm publish`, …)
> are judged by destination before they run — in this agent's
> sessions by a hook, and everywhere else on the machine by the git
> pre-push hook and the `gh` shim. {The shim is on PATH — `doctor` is
> clean. | The shim is written but your shell profile still needs the
> PATH line: `export PATH="…/.config/repo-aegis/bin:$PATH"`.}
> A publish to a public repository from an agent needs you: either run
> it yourself, or run `repo-aegis approve <org>/<repo>` from a terminal
> and the agent can run it for the next 15 minutes.
>
> If you ever want to remove repo-aegis, run `repo-aegis uninstall`
> (dry-run by default; pass `--yes` to apply). Don't hand-edit
> `~/.claude/settings.json` to remove the hooks.
>
> Optional: enable the audit log (`repo-aegis audit-log on`) for a
> compliance trail of state-changing CLI invocations.

## The egress guard (destination-aware publishing controls)

Everything above answers one question: *are these bytes safe in this
repository?* The egress guard answers a different one: *is this the
repository those bytes were meant for?* It exists because two incidents in
one week were **right bytes, wrong boundary** — a PR body published to the
wrong repository from a `$TMPDIR` path that resolved differently under a
sandbox, and a bare `git push` at the tail of a compound command whose
leading `cd` had not taken effect. Every content control behaved correctly
in both. See [doc/design/egress-guard.md](design/egress-guard.md).

### What `install claude-md` registers

Two more hook entries, alongside the existing ones, both idempotent:

| Event | Matcher | Command |
|---|---|---|
| `PreToolUse` | `Bash` | `repo-aegis hook guard-egress --agent claude` |
| `PostToolUse` | `Bash` | `repo-aegis hook egress-receipt` |
| `UserPromptSubmit` | `*` | `repo-aegis hook prompt-submit` (revokes prompt approvals when you type; never blocks) |

The PostToolUse `Bash` matcher entry now carries **two** repo-aegis hooks —
`scan-bash-output` and `egress-receipt`. They do different jobs on the same
tool result; neither replaces the other, and both coexist with any
user-authored hook in the same entry.

`repo-aegis install claude-md --print-only` shows exactly what would be
written without touching disk. `repo-aegis install claude-md --uninstall`
removes both again. These entries go into a root-owned managed-settings
drop-in (macOS `/Library/Application Support/ClaudeCode/managed-settings.d/`,
Linux `/etc/claude-code/managed-settings.d/`) that the person writes from their
own terminal with `sudo`; `--user-settings` writes `~/.claude/settings.json`
instead. See [`doc/configuration.md`](configuration.md#the-claude-code-managed-drop-in).

It also adds `permissions.deny` **Edit** rules for the registry file and its
`.age`, the approvals store, the emergency pause (`pause.json`), the destination cache (`destinations.json`), `hooks/**`, `bin/**`, `prompt-approvals/**` (the hook's record of a yes at the agent prompt), `markers/**` (the rendered
deny set) and `state/deny-set.cache.json` plus the uninstall ledger under the
repo-aegis home
(default `~/.config/repo-aegis`), so the agent cannot register an owner by
editing `engagements.yaml`. Only Edit rules are written (Claude Code never
matches `Write(path)`), and Claude Code merges them into the sandbox write-deny
list, so a sandboxed Bash `sed -i` is stopped too: verify once with a sandboxed
`touch` of the registry file. `state/` stays writable on purpose. An agent-run
`repo-aegis render` is therefore refused in the sandbox
(`MARKERS_WRITE_PROTECTED`): a person runs `render` from their own terminal.
`--uninstall` removes exactly the rules install added (recorded in
`state/claude-md-deny-rules.json`), never one you already had. `doctor` warns
`REGISTRY_AGENT_WRITABLE` until the rules are present.

**The guard:** reads the pending shell command on stdin before anything
runs, extracts every publishing operation it carries (`git push`, the
mutating `gh` verbs, `npm publish`), and returns `allow` / `ask` / `deny`.

- **Shape rules are unconditional** — a `git push` with no explicit
  `<remote> <refspec>`, an egress verb after a `cd` in the same command, an
  egress verb joined by `;` or `||` to a prerequisite that may have failed,
  a payload file on a mode-dependent path (`$TMPDIR`, a relative path, the
  shared sandbox temp root), a `gh pr create` with no `--repo`
  (`GH_PR_CREATE_IMPLICIT_TARGET`), an environment or option override on the
  publishing command (`EGRESS_ENV_OVERRIDE`), a publish that follows a
  config change in the same command (`EGRESS_AFTER_STATE_CHANGE`), and a
  publish run under a pty wrapper (`EGRESS_PTY_WRAPPER`), and a write through
  `dot gh` without `--as bot` as its first option
  (`DOT_GH_WRITE_NEEDS_BOT`). These need no
  registry, no classification and no network, so they work on a machine that
  has only just installed the tool.
- **Rule h refuses an owner nobody registered.** With no person present, a
  publish to an owner that is not in `personalOrgs`, not in any engagement's
  `githubOrgs` and not an allowed upstream is refused
  (`UNREGISTERED_OWNER_EGRESS`), at all three layers, and no approval
  covers it. So does a write whose owner cannot be named offline (a GraphQL
  mutation, an opaque `gh api` endpoint, a target in a shell variable). It is
  skipped when no registry exists or the registry declares no owners, which
  is why step 4b matters. Only a person registers an owner (step 4b), or an
  upstream with `repo-aegis upstreams add <owner>/<repo>`; the agent never
  does.
- **Context rules fail open** — cross-org egress, a payload matching the
  destination's deny set, a public destination with no human present. They
  need class and cached visibility; where those are missing, the guard does
  not block. Run `repo-aegis classify --apply` in each repo so they are not
  silently inert (`doctor` reports `CLASS_VISIBILITY_UNRESOLVED`).
- **It is decision-only.** The guard never rewrites a command and never
  emits `updatedInput`. A refusal means *you* re-issue the command
  explicitly: `git push <remote> <branch>`, `git -C <abs-path>`,
  `gh --repo <org>/<repo>`, and payload files written to the session
  scratchpad and passed by absolute path.
- **Never set `REPO_AEGIS_EGRESS_HUMAN`.** It is the human's declaration
  that a person is at the keyboard, with the same contract as
  `REPO_AEGIS_WAIVE_NONINTERACTIVE`. An agent setting it is the agent
  approving its own publish.
- **When refused for want of a person, ask for an approval.** The human
  runs `repo-aegis approve <org>/<repo>` (optionally `--ref`, `--ttl`)
  from their terminal — the mint refuses without a TTY, so the agent
  cannot do it — and the agent re-issues the same command. The approval
  satisfies rule g only, for that destination, for 15 minutes by default;
  the refusal's reason spells out the exact `approve` line. A `*` approval
  covers only the user's own `personalOrgs` and `npm publish`; a customer's
  repository needs `approve <org>/*` or `approve <org>/<repo>`. An approval
  never helps with an unregistered owner.

**The receipt:** after a command that published, one line of
`additionalContext`:

```
PUBLISHED → acme/svc (PUBLIC, class public-eligible): main -> main
```

Read it. If the destination named there is not the one you intended, stop
and tell the user immediately — that is the whole point of the line. If the
command did not actually publish, the line reads `EGRESS FAILED → …`
instead; a receipt never claims a publish that did not happen. And when
the output proves neither — a push that died in transport, a `gh` verb
that printed no URL — it reads `EGRESS UNCONFIRMED → …`: treat that as
"find out", not as "it worked".

### The three enforcement points

The hooks above are the richest layer, not the only one. The same
decision function runs at three places, and an install is complete only
when all three are in:

| Layer | Installed by | Catches | Who it protects |
|---|---|---|---|
| git `pre-push` hook | `repo-aegis init` / `install hooks` | `git push` to a cross-org or public destination, with the remote URL git hands the hook | every agent and every human, in every repo with `core.hooksPath` set |
| `gh` shim on `PATH` | `repo-aegis install shim` + the profile line ([Step 2b](#step-2b--install-the-gh-shim)) | the publishing verbs of `gh pr`, `gh issue`, `gh release`, `gh repo` and mutating `gh api`, plus the post-publish read-back | every agent and every human, in every shell where the shim is first |
| agent pre-command hook | `repo-aegis install claude-md` (Claude Code); see below for Codex, Gemini CLI, Cursor, Copilot CLI and Antigravity CLI | everything, before the command runs, with `ask` where the agent supports it | that one agent |

Skipping the shim leaves the middle row empty: `gh pr create` from a
terminal, from a script, or from an agent without a pre-command hook
reaches GitHub without anyone judging the destination.

The rows do not cover for each other, and the middle one has a condition
the others do not: it reaches only shells whose `PATH` carries it. The
pre-push hook is `PATH`-independent, so `git push` is covered either way;
`gh` is not. That is why the agent hook checks its own `PATH` and denies a
`gh` publishing verb (`SHIM_UNREACHABLE_NEEDS_HUMAN`) when the shim is
missing from it — see `doc/design/egress-guard.md` §4b.

### Verify the registration

```sh
repo-aegis doctor
```

`GUARD_HOOK_UNREGISTERED` means `settings.json` has no `PreToolUse` entry
with matcher `Bash` running `repo-aegis hook guard-egress`. Fix with
`repo-aegis install claude-md`. A guard that is not registered is invisible:
a session with no guard looks exactly like a session where nothing needed
guarding, which is why `doctor` checks for it rather than trusting that a
past install happened.

`SHIM_MISSING` means `repo-aegis install shim` has not run;
`SHIM_NOT_FIRST` means it has, but another `gh` precedes the shim on
`PATH` (or the check ran in a shell that never sourced the profile
line); `SHIM_STALE` means the shim on `PATH` was written by an earlier
release — re-run `repo-aegis install shim` after every upgrade, the way
`install hooks` is re-run for `HOOKS_SCRIPT_STALE`. All three are
[Step 2b](#step-2b--install-the-gh-shim).
`PUSH_DEFAULT_IMPLICIT` is the one-line `git config --global
push.default nothing` recommendation.

### Other agents

The same entry point serves Codex CLI, Gemini CLI, Cursor, Copilot CLI and
Antigravity CLI; only the event name, the matcher, the payload and the
`--agent` value change. Register it by hand in that agent's settings
(consult the agent's own documentation for the exact key spelling —
repo-aegis writes only Claude Code's `settings.json`, and there is no
installer for these). **Every snippet below is doc-derived, not exercised
in a live session** of that agent: it was written from the agent's
documentation, and its payload fixtures under
`packages/cli/src/commands/__fixtures__/hosts/` are marked `doc-derived`
until a real capture replaces them. Run the self-test at the end of this
section after registering. To remove a hand-registered entry, see
[Uninstalling](agent-guide.md#uninstalling) in `doc/agent-guide.md`.

**Codex CLI** — `PreToolUse`, matcher `Bash`, command in
`tool_input.command`. Per the Codex hooks documentation
(https://developers.openai.com/codex/hooks, which redirects to
https://learn.chatgpt.com/docs/hooks), Codex reads hooks from
`~/.codex/hooks.json`, `~/.codex/config.toml` (an inline `[hooks]` table),
or the same two files under `<repo>/.codex/`. **Codex does not run a
non-managed hook until it is reviewed and trusted:** after registering the
entry, have the user open `/hooks` in Codex and trust it. Until then the
guard is not running, and nothing says so. Trust is tied to the hook's
hash, so trust it again after any change to the command. (An earlier
version of this guide used the matcher `shell`; the Codex docs name
`Bash`, and the unified exec tool matches as `Bash` too. The adapter still
accepts a payload whose `tool_name` is `shell`, for older builds.) Codex has
no `ask`: the hook run is marked failed and the tool runs, so `ask` is
rendered as a deny. Doc-derived, not exercised in a live session.

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          { "type": "command", "command": "repo-aegis hook guard-egress --agent codex" }
        ]
      }
    ]
  }
}
```

**Gemini CLI** — `BeforeTool`, matcher `run_shell_command`, command in
`tool_input.command` (that payload field is unverified: it was not checked
against Gemini CLI's documentation).

Google announced on 2026-05-19 that consumer access to Gemini CLI ends on
2026-06-18 and that Antigravity CLI replaces it
(https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/).
Gemini CLI stays available to Gemini Code Assist Standard / Enterprise
customers and with paid API keys, so the snippet below still applies to
those installs. Antigravity CLI has its own event, payload and answer
shape, so `--agent gemini` does **not** work with it: use the Antigravity
snippet below. Doc-derived, not exercised in a live session.

```json
{
  "hooks": {
    "BeforeTool": [
      {
        "matcher": "run_shell_command",
        "hooks": [
          { "type": "command", "command": "repo-aegis hook guard-egress --agent gemini" }
        ]
      }
    ]
  }
}
```

**Cursor** — `.cursor/hooks.json` in the project (or `~/.cursor/hooks.json`
for every project). Two events: `beforeShellExecution` is the guard (the
command is the root `command` field; `ask` is honoured on this event only),
and `afterFileEdit` runs the post-write scan. `afterFileEdit` is
observe-only: Cursor has already written the file, so a hit is a
notification that the edit happened, not a block; the git pre-commit hook is
the gate. Cloud agents run project hooks but **not** user hooks, so register
in the project file if the cloud agent matters. Doc-derived, not exercised
in a live session.

```json
{
  "version": 1,
  "hooks": {
    "beforeShellExecution": [
      { "command": "repo-aegis hook guard-egress --agent cursor" }
    ],
    "afterFileEdit": [
      { "command": "repo-aegis hook scan-after-write --agent cursor" }
    ]
  }
}
```

**Copilot CLI** — `preToolUse` (camelCase), matcher `bash`, in
`~/.copilot/hooks/repo-aegis.json` (or `$COPILOT_HOME/hooks/`; a repo's
`.github/hooks/*.json` also works, and also covers the Copilot cloud
agent). The command is inside `toolArgs`, which Copilot sends as a
JSON-encoded string; the adapter decodes it. The PascalCase `PreToolUse`
event (snake_case, VS Code-compatible payload) is accepted too. Two Copilot
behaviours to know: a hook that exits non-zero other than 2 **fails closed**
(blocks the tool), so the guard never exits 1 under `--agent copilot` and
renders its own internal errors as an allow; and `ask` works in the
interactive CLI but is treated as a deny in the cloud agent and autopilot
mode. Doc-derived, not exercised in a live session.

```json
{
  "version": 1,
  "hooks": {
    "preToolUse": [
      {
        "type": "command",
        "bash": "repo-aegis hook guard-egress --agent copilot",
        "matcher": "bash",
        "timeoutSec": 30
      }
    ]
  }
}
```

**Antigravity CLI** (`agy`) — `PreToolUse`, matcher `run_command`, in
`~/.gemini/config/hooks.json` (or `.agents/hooks.json` in the project). The
top-level key is a name you choose for the hook group. Hooks in
`~/.gemini/antigravity-cli/settings.json` are **not** loaded; `/hooks` in
Antigravity lists what was. The command is `toolCall.args.CommandLine`.
Doc-derived, not exercised in a live session.

```json
{
  "repo-aegis": {
    "PreToolUse": [
      {
        "matcher": "run_command",
        "hooks": [
          { "type": "command", "command": "repo-aegis hook guard-egress --agent antigravity" }
        ]
      }
    ]
  }
}
```

On Codex, Antigravity CLI and Gemini CLI, **`ask` degrades to `deny`** —
never to `allow`. None of these is assumed to have an "ask" decision (Codex
treats an `ask` as a failed hook and runs the tool; Antigravity's `ask` is
unverified), so a case Claude Code would put in front of the user (a public
destination with no human present) becomes a refusal whose reason says to
have a human run or approve the command. That is the conservative
direction, and it is deliberate: a guard that silently allowed what it could
not ask about would be worse than no guard, because the operator would
believe they had one. Cursor and Copilot CLI do have an `ask`; each adapter
uses it only where the host enforces it (see the per-host notes above), and
an `ask` that a host treats as a deny is the same safe direction.

Typed input is judged where the host says what it is: Copilot CLI's
`write_bash` / `write_powershell` (`input`) and Antigravity's
`send_command_input` (`Input`) are read as the command, since a push typed
into an open session is a push. Codex's `write_stdin` is **not** judged (see
the known limits in [design/egress-guard.md](design/egress-guard.md)).

On Cursor, `afterFileEdit` runs after the file is written, so its non-zero
answer is detection only. Cursor probably shows the hook's output only in its
hooks log, not in the agent's conversation, so do not count on the agent (or
a person) seeing it: the pre-commit hook is the gate.

The hook reads stdin tolerantly and **fails open**: a payload it cannot read
is allowed, never blocked. Where the payload names a shell tool but has no
command where this `--agent` reads one, or carries a command in another
host's shape (a Claude- or Gemini-shaped payload under `--agent
antigravity`, a Cursor `preToolUse` payload under `--agent cursor`), the hook
says so once on stderr (`repo-aegis: guard-egress: this payload was not
judged (…); check that the hook is registered with the right --agent and
event`) and, when the audit log is on, writes a `guard-egress-malformed`
record. A payload for a non-shell tool stays silent. `--agent` is matched
without regard to case. An unknown name is judged in any known payload shape
and answered as a host without an `ask`. Test your registration once. The
first block is for Claude Code, Codex and Gemini CLI (deny is exit 2); the
others answer a deny on stdout:

```sh
echo '{"tool_name":"Bash","tool_input":{"command":"git push"}}' | repo-aegis hook guard-egress
echo $?    # 2, with PUSH_IMPLICIT_TARGET on stderr
```

For Copilot CLI, whose command sits in a JSON string, the same check is:

```sh
echo '{"toolName":"bash","toolArgs":"{\"command\":\"git push\"}"}' | repo-aegis hook guard-egress --agent copilot
echo $?    # 2, with "permissionDecision":"deny" on stdout
```

For Cursor and Antigravity CLI the deny is on stdout and the exit code is 0:

```sh
echo '{"hook_event_name":"beforeShellExecution","command":"git push"}' | repo-aegis hook guard-egress --agent cursor
echo $?    # 0, with "permission":"deny" on stdout
```

```sh
echo '{"toolCall":{"name":"run_command","args":{"CommandLine":"git push"}}}' | repo-aegis hook guard-egress --agent antigravity
echo $?    # 0, with "decision":"deny" on stdout
```

### Caveat: Claude Code's `ask` is not yet empirically verified

The design relies on `hookSpecificOutput.permissionDecision: "ask"` forcing
a user prompt **even under auto-accept**. That behaviour has not yet been
verified end-to-end in a real Claude Code session against the version you
are installing. Until it has been, treat `ask` as "the guard's decision was
recorded and the framework was asked to prompt", not as a guarantee that a
human saw it. The `deny` path — exit 2 — is the one whose blocking
behaviour is part of the documented hook contract, and every shape rule
uses it. If you verify the `ask` behaviour, say so to the user; if you
observe it NOT prompting under auto mode, that is a finding worth an issue.

## Companion tools

repo-aegis is not a general secret scanner; its built-in secret-shape check is
frozen. Offer the user a dedicated scanner alongside it. Do not install one
without asking, and never create a GitGuardian account or API key for them.

- **ggshield** ([AI coding tools guide](https://docs.gitguardian.com/ggshield-docs/integrations/ai-coding-tools/secret-scanning-for-ai-coding-tools)):
  AI hooks (prompts, tool calls, tool output) plus git pre-commit and pre-push
  hooks. Scanning needs a GitGuardian account (SaaS); the user does that part.
- **[gitleaks](https://github.com/gitleaks/gitleaks)**: local, no account,
  pre-commit and CI. Already a common choice.

What each covers versus repo-aegis: a secret scanner recognises credential
shapes. repo-aegis does engagement scoping (a customer's markers must not reach
another customer's repo or a public one), destination (where `git push` and `gh`
send bytes) and identity (which account runs them). They do not overlap; keep both.

**Coexistence result (ggshield 1.56.1, checked in a scratch home).** After
`repo-aegis install claude-md`, the user can run
`ggshield machine setup --agent claude-code --no-git-hooks --no-honeytokens`
(`machine setup` also installs global git hooks and plants a honeytoken unless
those flags switch them off; leave them on only if the user wants them).
ggshield appends one `.*`-matcher entry to `PreToolUse` and `PostToolUse` and
adds a `UserPromptSubmit` entry. It does not merge into or replace any
repo-aegis entry, and a second run changes nothing.

Ordering caveat: Claude Code runs all matching hooks of an event in parallel, so
neither tool runs before the other; a block from either stops the call. Never
tell the user one runs first. The other install order (ggshield first, then
`install claude-md`) was checked only by reading the merge code, not run. The
ggshield hook command holds the absolute path of the `ggshield` binary, so it
breaks if that binary moves. Afterwards, confirm with
`repo-aegis doctor` that `GUARD_HOOK_UNREGISTERED` is not reported, and tell the
user the ggshield side was not tested in a live session. Source:
`doc/plan-landscape-recommendations.md`, section 5.

## Common pitfalls

### "I see `customer-coupled with no engagement` errors after `classify --apply`"

The remote matched an engagement org but `allow` wasn't called. Run
`repo-aegis allow <engagement-id>` in that repo. (`classify --apply`
should have done this; if it didn't, the engagement may not have
the org attached. Check `repo-aegis engagements show <id> --json`.)

### "The user has existing repos with `repo-aegis.class` set from before"

`init` and `classify --apply` are both idempotent and won't overwrite
existing classification. If the user wants to re-classify, they can
`git config --unset repo-aegis.class` first, then re-run `classify
--apply`. Don't unset on their behalf.

### "The CLAUDE.md block looks weird in the user's existing CLAUDE.md"

`install claude-md` (called by `init`) appends a marker-bracketed
block. If the user has an older block from a previous install, it
remains untouched (the marker prevents duplicate insertion). To
refresh: `repo-aegis install claude-md --uninstall && repo-aegis
install claude-md`. Ask the user before doing this — they may have
hand-edited the block.

### "I can't tell which Claude Code config home to use"

Default is `~/.claude`. Override with `--claude-home <dir>` or by
passing `claudeHome` to the `install claude-md` command directly.
The user is the source of truth on this; don't probe with `find`.

### "The user has multiple machines and wants the same registry on all of them"

The registry lives in `~/.config/repo-aegis/engagements.yaml`. To
sync across machines, the user can:

- Encrypt the registry at rest (`repo-aegis registry encrypt
  --recipient age1...`) and keep the ciphertext in a dotfiles repo,
  decrypting on each machine via `registry decrypt --identity
  <path>`.
- Or replicate the file via their existing dotfiles workflow.

Don't propose a sync mechanism without asking. The registry is
sensitive data even when it's not encrypted (it lists all the
user's customers and their identifying patterns).

## What you should never do during install

- **Use `--purge-repos` / `--purge-home`** in any flow. These belong
  to uninstall, not install.
- **Echo a literal marker pattern back to the user.** They typed it;
  they don't need it back.
- **Commit the user's `engagements.yaml` to a public repo.** It
  contains customer identifiers in plaintext. The user owns whether
  to encrypt-and-sync; surface that decision when relevant.
- **Set the `git config user.email` to a customer-derived address.**
  Repo-aegis doesn't touch git identity, but agents that "set up
  everything" sometimes do; don't.

## Short version (for an agent that read this and wants the recipe)

```sh
# 1. install
npm install -g @de-otio/repo-aegis

# 2. bootstrap
repo-aegis init

# 2b. gh shim — then add the printed `export PATH=…` line to the user's shell profile
repo-aegis install shim

# 3 + 4. for each engagement the user named that has NO GitHub org, with its markers:
repo-aegis engagements add <id> \
  --name "<Name>" \
  --marker '<pattern>' \
  --marker '<pattern>'

# 3b. THE USER runs these in their own terminal (an agent cannot: they need a TTY).
#     An engagement with a GitHub org is created once, here, with its markers
#     (do not run 3 + 4 for it first: a second add of the same id is ENGAGEMENT_EXISTS):
#     repo-aegis engagements add <id> --github-org <org> --marker '<pattern>' --marker '<pattern>'
#     repo-aegis engagements add --personal-org <org>
# Wait for them before continuing.

# 5. for each existing repo on disk:
cd <repo>
repo-aegis classify --apply       # or `git config repo-aegis.class ...; repo-aegis allow <id>`

# 6. verify
repo-aegis engagements list --json
repo-aegis status
repo-aegis markers test '<known-marker>'
repo-aegis doctor                 # in a NEW shell, so the PATH line has taken effect
```

Then read [doc/agent-guide.md](agent-guide.md).

## Reference

- Tool home page: https://github.com/de-otio/repo-aegis
- Operator guide (post-install): [doc/agent-guide.md](agent-guide.md)
- README (user-oriented overview): [../README.md](../README.md)
- CLI reference: [doc/cli-reference.md](cli-reference.md)
- Uninstall: `repo-aegis uninstall --help` or
  [agent-guide.md "Uninstalling"](agent-guide.md#uninstalling)
