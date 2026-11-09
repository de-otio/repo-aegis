# repo-aegis

> Keeps one client's names and data out of another client's repositories, and out of public
> ones, when AI coding agents do much of the writing, committing and pushing.

## The problem

If you work for several clients from one machine, each client's names, project codenames and
hostnames are all over your working context. An AI coding agent (Claude Code, Codex, Gemini,
Cursor, …) picks those strings up from files, tool output and the conversation, and reuses them
as "concrete examples" in whatever it writes next: a test fixture in client B's repository, a
commit message, a pull request on a public open-source project. In the author's experience (not a
measured result; incident details are not published), a rule in `CLAUDE.md` that says "never
mention client names" does not reliably stop it, because a string that keeps coming up in the
session outweighs a written rule.

repo-aegis adds checks that run as code, not as instructions. They block the write, the commit
or the push instead of asking the agent to behave.

**Who it is for:** consultants, contractors and anyone else who keeps several clients' code (and
their own or open-source work) on one machine.

**What it is not:** it is not a secret manager or a DLP product for a whole company. Local hooks
can be bypassed (`git commit --no-verify`), so for a hard guarantee also run its CI checks on the
server (`repo-aegis install ci`).

**Background:** the layered approach this tool automates in part (identity separation, removing
ambient coupling, marker gates, agent hooks, audits, and what none of them catch) is written up
in [doc/guide-data-leak-prevention.md](doc/guide-data-leak-prevention.md).

## Concepts in one minute

- **Engagement:** one client relationship, for example `customer-a`. It lists the GitHub orgs
  that belong to that client.
- **Marker:** a pattern that identifies a client, such as its name or a project codename,
  written as a regular expression in the engagement.
- **Registry:** the file that holds your engagements, markers and your own GitHub orgs
  (`~/.config/repo-aegis/engagements.yaml`).
- **Class:** what a repository is, recorded in its git config: a client's own repository, your
  personal one, a public one, and so on. repo-aegis works it out from the remote's GitHub org.
- **Deny set:** the markers that must not appear in a given repository. Inside client A's own
  repository client A's markers are allowed, and everyone else's are denied. Because each
  repository gets its own deny set, client A's name does not set off alarms in client A's own
  code.
- **Egress:** anything that sends data off your machine: `git push`, `gh pr create`,
  `npm publish`.

## What it does

- **Scans before a write lands.** The same scanner runs in a pre-commit hook, a pre-push hook
  and the coding agent's file-write hooks, so a denied marker is caught before it reaches a
  commit. The scanner's result is structured (`--json`), so an agent can in principle act on it
  and fix the slip itself. **Unverified:** Claude Code surfaces PostToolUse output to the model only
  on exit 2; these hooks exit 1 on a hit, so the agent may not see the post-write result. The
  PreToolUse write gate and the commit/push hooks do not depend on this. Tracked; see Claude
  Code's [hooks documentation](https://code.claude.com/docs/en/hooks).
- **Checks where data is going.** Before a `git push`, `gh pr create`, release or publish, it
  checks the destination. A push into another client's org is refused. A publish to a public
  repository, or a merge or release, needs a person to confirm. An agent's push to a GitHub
  owner you never registered is refused outright. When you want an agent to go ahead, you run
  `repo-aegis approve <org>/<repo>` in your own terminal; the approval is short-lived and an
  agent cannot create one.
- **Flags secrets in command output.** Private keys, GitHub tokens and JWTs that show up in the
  agent's shell output are flagged, so you know to rotate them. (Same caveat as above: this hook
  exits 1, and whether Claude Code shows that to the agent is unverified.)
- **Is hard for an agent to switch off.** For Claude Code the hooks are installed as a
  root-owned settings file and run a pinned copy of repo-aegis, so an agent cannot edit them
  away. (`--user-settings` uses your own settings file instead, for machines without `sudo`.)
- **Picks the right GitHub account per client (optional).** Map each GitHub owner to the
  account, and optionally a GitHub App, that should act for it. Several agents can then work
  for different clients at the same time without anyone switching the active `gh` account.
  See [Setting up identities](doc/configuration.md#setting-up-identities-a-walkthrough).
- **Enforces in CI too.** `repo-aegis install ci` generates GitHub Actions workflows that run the
  same checks on the server. Bypassing a local hook does not get past them.

## Requirements

- macOS or Linux, with git. Node.js 22 or later (CI tests 22 and 24).
- `gh` (GitHub CLI), if you want `gh` commands checked.
- `sudo`, for the root-owned Claude Code settings file. Without it, use `--user-settings`.
- Full protection is for **Claude Code**. **Codex CLI**, **Cursor**, **Copilot CLI** and
  **Antigravity CLI** (which replaced Gemini CLI; `--agent gemini` stays for the old one) can get
  the egress check, and Cursor also a post-edit scan. They are configured by hand from snippets
  derived from each vendor's docs and not yet exercised in a live session
  ([doc/agent-install.md](doc/agent-install.md)). Every agent, and you, get the git hooks and the
  `gh` wrapper.

## Quick start

The easy way: point your coding agent at this repository and ask it to **"install and configure
repo-aegis"**. It follows [doc/agent-install.md](doc/agent-install.md), and it stops and asks
you for the steps only a person may do (registering GitHub orgs, typing `y` for the root-owned
settings file).

By hand:

1. **Install and initialise.**

   ```sh
   npm install -g @de-otio/repo-aegis
   repo-aegis init
   ```

   `init` creates the registry, installs the git hooks in the current repository and installs
   the Claude Code hooks. For the last part it shows what it will write, asks `[y/N]`, and
   then `sudo` asks for your password.

2. **Install the `gh` wrapper** so that `gh` commands are checked too:

   ```sh
   repo-aegis install shim
   ```

   It prints a line to add to your shell profile. That line puts its directory **first** on
   `PATH`. Then restart your shell **and** your coding agent, since each one only reads `PATH`
   when it starts.

3. **Describe a client.** From your own terminal (agents may not register GitHub orgs):

   ```sh
   repo-aegis engagements add customer-a \
     --github-org example-client-org \
     --marker 'customer-?a'
   ```

4. **Classify a repository and check it:**

   ```sh
   cd /path/to/customer-a-repo
   repo-aegis classify --apply   # records the repository's class and engagement
   repo-aegis status             # shows its class and which engagements are denied here
   repo-aegis doctor             # machine-wide health check
   ```

   `doctor` lists anything still missing, each with the command that fixes it. New repositories
   under a registered org are classified automatically the first time an agent works in them.

**What install changes on your machine:**
- `~/.config/repo-aegis/` (the registry and state);
- git hooks in the repositories you install them into;
- a block in `~/.claude/CLAUDE.md`;
- a root-owned Claude Code settings file (or `~/.claude/settings.json`);
- the `gh` wrapper directory;
- optionally, a git credential helper.

`repo-aegis uninstall` removes all of it (see below).

## Documentation

| Doc                                          | For                                                                     |
| -------------------------------------------- | ----------------------------------------------------------------------- |
| [doc/agent-install.md](doc/agent-install.md) | Installing, step by step (written for an agent to follow)              |
| [doc/agent-guide.md](doc/agent-guide.md)     | Day-to-day use by coding agents: what each refusal means and what to do |
| [doc/configuration.md](doc/configuration.md) | The registry, GitHub identities, the Claude Code settings file, overrides |
| [doc/cli-reference.md](doc/cli-reference.md) | Every command: flags, exit codes, JSON output                           |
| [doc/why-ai-coding.md](doc/why-ai-coding.md) | Why the checks are shaped the way they are                              |
| [doc/guide-data-leak-prevention.md](doc/guide-data-leak-prevention.md) | Background: the layered approach to client-data leaks that this tool automates in part |
| [doc/github-action.md](doc/github-action.md) | The CI workflows and GitHub Actions                                     |
| [doc/architecture.md](doc/architecture.md)   | Packages and how they fit together                                      |
| [doc/design/](doc/design/)                   | Design notes and threat model                                           |

Working in another repository, where those files are not on disk? Every refusal ends
`[CODE; details: repo-aegis explain CODE]`, and `repo-aegis explain <CODE>` prints the guide's text for it
(the guides ship in the npm package; `explain --list` names every code).

Optional add-ons: [packages/llm](packages/llm/README.md) (local-LLM marker suggestions and a
semantic audit sweep; never part of the blocking checks) and [packages/mcp](packages/mcp/README.md).

## Companion tools

repo-aegis is not a general secret scanner. Its small built-in secret-shape check
(`hook scan-bash-output`) is frozen: no new secret types will be added. Run a
dedicated scanner next to it:

| Tool | What it covers | Notes |
| --- | --- | --- |
| [ggshield](https://docs.gitguardian.com/ggshield-docs/integrations/ai-coding-tools/secret-scanning-for-ai-coding-tools) (GitGuardian) | Secrets in prompts, tool calls and tool output through AI coding hooks, plus git pre-commit and pre-push hooks | Scanning needs a GitGuardian account (SaaS). Installing the hooks did not need one. |
| [gitleaks](https://github.com/gitleaks/gitleaks) | Secrets in a working tree and in git history, as a pre-commit hook and a CI step | Local, no account. Already a common choice. |

They answer a different question from repo-aegis. A secret scanner asks "does this
text look like a credential?". repo-aegis asks "should this customer's name, or this
command, go to that place, as that account?": engagement scoping (one customer's
markers must not reach another's repo or a public one), destination (where a `git
push` or `gh` call sends bytes) and identity (which GitHub account runs it). Use
both; neither replaces the other.

**Coexistence with Claude Code hooks.** Checked with ggshield 1.56.1 in a scratch
home: `ggshield machine setup --agent claude-code --no-git-hooks --no-honeytokens`
(or `ggshield install -m global -t claude-code`, now deprecated) adds its own
`PreToolUse`, `PostToolUse` and `UserPromptSubmit` entries with a `.*` matcher,
after the existing ones, and leaves every repo-aegis entry untouched. Re-running
it changes nothing. Ordering caveat: Claude Code runs all matching hooks of an
event in parallel, so neither tool runs before the other and a block from either
one stops the call; do not rely on an order. This was verified for the file
contents only, not in a live session, and only with repo-aegis installed first;
see [doc/plan-landscape-recommendations.md](doc/plan-landscape-recommendations.md)
(section 5). Run `repo-aegis doctor` after installing either one.

## Uninstalling

```sh
repo-aegis uninstall          # dry run: lists what it would remove
repo-aegis uninstall --yes    # removes every install step
npm uninstall -g @de-otio/repo-aegis
```

`uninstall` reverses the git hooks, the Claude Code wiring (including the root-owned settings
file), the CI workflows, the `gh` wrapper and the git credential helper. `--purge-repos` also
clears repo-aegis's git config in your classified repositories. `--purge-home` also deletes
`~/.config/repo-aegis/`. See `repo-aegis uninstall --help`.

## Development

```sh
npm install
npm run build
node packages/cli/dist/index.js status
```

Contribution guidelines: [CONTRIBUTING.md](CONTRIBUTING.md).

## License

GPL-3.0-or-later. Copyright (C) 2026 Richard Myers and contributors.

A De Otio tool — https://de-otio.org.
