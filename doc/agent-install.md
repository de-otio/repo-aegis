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
  internal hostnames). Ask. Do **not** invent markers; do **not**
  run `suggest-markers` (which sends prose to a local model) without
  explicit user direction.
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
node --version          # must be >= 20
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
provenance** as of v0.2.0+ (sigstore attestation). After install:

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
   pre-push) and sets `core.hooksPath` per repo.
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
from Gemini reaches GitHub unjudged.

After `init`:

```sh
repo-aegis engagements list --json
# -> { "engagements": [], "alwaysBlock": [], "schemaVersion": 2 }
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

Why this layer exists when the Claude Code hook already judges `gh`
commands: the hook guards one agent's sessions. The shim sits in front of
*every* `gh` invocation on the machine — a human terminal, Codex, Gemini,
a script — and it is the only place the post-publish read-back
(`PUBLISHED_BODY_MISMATCH`) happens. Non-publishing verbs (`gh pr view`,
`gh api GET`) pass straight through.

After the profile edit, in a **new** shell:

```sh
repo-aegis doctor
# -> SHIM_MISSING ok, SHIM_NOT_FIRST ok, PUSH_DEFAULT_IMPLICIT ...
```

If `PUSH_DEFAULT_IMPLICIT` is not ok, `git config --global push.default`
is unset or `simple`, so a bare `git push` still works. The guard
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
> public/OSS work happens. These are configured separately and
> classify their repos as `public-eligible`.

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

## Step 4 — register engagements

For each engagement the user gave you:

```sh
repo-aegis engagements add customer-a \
  --name "Customer A" \
  --github-org acme-corp \
  --marker '\bacme-corp\b' \
  --marker 'acme\.com' \
  --marker 'AC-[0-9]+'
```

Use **single quotes** to avoid shell-interpreting the regex.

For personal orgs (no engagement created — just an entry in
top-level `personalOrgs`):

```sh
repo-aegis engagements add --personal-org rmyers --personal-org my-oss-org
```

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
  user whether to update (different verb: `engagements add
  --github-org` is additive on orgs and markers) or pick a different
  id.

If `engagements add --github-org X` fails because `X` already
belongs to another engagement / `personalOrgs`, surface verbatim and
ask the user which scope it should belong to. Do **not**
auto-resolve.

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
`allow`s that engagement. If it matches `personalOrgs`, it sets
`repo-aegis.class = public-eligible`. If neither, it reports
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
> result will carry a redacted hit with the engagement id and the
> file:line:column.
>
> Publishing commands (`git push`, `gh pr create`, `npm publish`, …)
> are judged by destination before they run — in this agent's
> sessions by a hook, and everywhere else on the machine by the git
> pre-push hook and the `gh` shim. {The shim is on PATH — `doctor` is
> clean. | The shim is written but your shell profile still needs the
> PATH line: `export PATH="…/.config/repo-aegis/bin:$PATH"`.}
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

The PostToolUse `Bash` matcher entry now carries **two** repo-aegis hooks —
`scan-bash-output` and `egress-receipt`. They do different jobs on the same
tool result; neither replaces the other, and both coexist with any
user-authored hook in the same entry.

`repo-aegis install claude-md --print-only` shows exactly what would be
written without touching disk. `repo-aegis install claude-md --uninstall`
removes both again.

**The guard:** reads the pending shell command on stdin before anything
runs, extracts every publishing operation it carries (`git push`, the
mutating `gh` verbs, `npm publish`), and returns `allow` / `ask` / `deny`.

- **Shape rules are unconditional** — a `git push` with no explicit
  `<remote> <refspec>`, an egress verb after a `cd` in the same command, an
  egress verb joined by `;` or `||` to a prerequisite that may have failed,
  a payload file on a mode-dependent path (`$TMPDIR`, a relative path, the
  shared sandbox temp root). These need no registry, no classification and
  no network, so they work on a machine that has only just installed the
  tool.
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

**The receipt:** after a command that published, one line of
`additionalContext`:

```
PUBLISHED → acme/svc (PUBLIC, class public-eligible): main -> main
```

Read it. If the destination named there is not the one you intended, stop
and tell the user immediately — that is the whole point of the line. If the
command did not actually publish, the line reads `EGRESS FAILED → …`
instead; a receipt never claims a publish that did not happen.

### The three enforcement points

The hooks above are the richest layer, not the only one. The same
decision function runs at three places, and an install is complete only
when all three are in:

| Layer | Installed by | Catches | Who it protects |
|---|---|---|---|
| git `pre-push` hook | `repo-aegis init` / `install hooks` | `git push` to a cross-org or public destination, with the remote URL git hands the hook | every agent and every human, in every repo with `core.hooksPath` set |
| `gh` shim on `PATH` | `repo-aegis install shim` + the profile line ([Step 2b](#step-2b--install-the-gh-shim)) | the publishing verbs of `gh pr`, `gh issue`, `gh release`, `gh repo` and mutating `gh api`, plus the post-publish read-back | every agent and every human, in every shell where the shim is first |
| agent pre-command hook | `repo-aegis install claude-md` (Claude Code); see below for Codex and Gemini | everything, before the command runs, with `ask` where the agent supports it | that one agent |

Skipping the shim leaves the middle row empty: `gh pr create` from a
terminal, from a script, or from an agent without a pre-command hook
reaches GitHub without anyone judging the destination.

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

The same entry point serves Codex CLI and Gemini CLI; only the event name,
the matcher and the `--agent` value change. Register it by hand in that
agent's settings (consult the agent's own documentation for the file
location and exact key spelling — repo-aegis writes only Claude Code's
`settings.json`).

**Codex CLI** — `PreToolUse`, command in `tool_input.command`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "shell",
        "hooks": [
          { "type": "command", "command": "repo-aegis hook guard-egress --agent codex" }
        ]
      }
    ]
  }
}
```

**Gemini CLI** — `BeforeTool`, matcher `run_shell_command`, command in
`tool_input.command`:

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

On both of those, **`ask` degrades to `deny`** — never to `allow`. Neither
framework is assumed to have an "ask" decision, so a case Claude Code would
put in front of the user (a public destination with no human present)
becomes a refusal whose reason says to have a human run or approve the
command. That is the conservative direction, and it is deliberate: a guard
that silently allowed what it could not ask about would be worse than no
guard, because the operator would believe they had one.

The hook reads stdin tolerantly and exits 0 on anything it cannot parse, so
registering it against a tool that sends a different payload shape is
harmless — but it also means a misregistration is silent. Test it once:

```sh
echo '{"tool_name":"Bash","tool_input":{"command":"git push"}}' | repo-aegis hook guard-egress
echo $?    # 2, with a PUSH_IMPLICIT_TARGET reason on stderr
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

- **Run `suggest-markers`.** It sends prose from the user's repo
  to a local Ollama model. The user must opt in.
- **Set `--auto-accept-above` on `suggest-markers`.** Auto-acceptance
  bypasses the user's review of model-suggested markers.
- **Set `--allow-remote-model` / `--allow-remote-ollama`** anywhere.
  Sending customer prose to a non-localhost model is a compliance
  decision.
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

# 3 + 4. for each engagement the user named, with their markers:
repo-aegis engagements add <id> \
  --name "<Name>" \
  --github-org <org> \
  --marker '<pattern>' \
  --marker '<pattern>'

# (personal orgs separately:)
repo-aegis engagements add --personal-org <org>

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
