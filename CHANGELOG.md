# Changelog

All notable changes to repo-aegis are documented here.

The format is based on [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]


### Added

- `engagements set-identity --agent none` / `--person none` clear just that column and leave the other
  alone (an owner can move from an App to a person without `--clear` and a re-map). Works for
  engagements and `--personal-org`; both `none` equals `--clear`; clearing needs the same terminal as
  any set-identity call and is audited like `--clear`. `none` is now a reserved identity name:
  `identity add none` is refused so it can never shadow a real identity.
- **A yes at Claude Code's permission prompt now carries down to the layers below it, for that exact
  command, for 2 minutes** (prompt approvals, `doc/design/egress-guard.md` §4a.1). When the agent hook
  asks about a `git push` or a `gh` write in `default` or `acceptEdits` mode, it records the verb,
  repository and destination ref (or API endpoint); git's pre-push hook and the `gh` shim then accept
  that one command instead of sending the person to a terminal. Records live one file each under
  `$REPO_AEGIS_HOME/prompt-approvals/`, are matched exactly (no wildcard), are never read by the agent
  hook itself (so a "no" followed by a different command still asks), and are never written in `auto`,
  `bypassPermissions`, `plan`, `dontAsk` or an unknown mode, or by any host other than Claude Code.
  The prompt says which case applies. `approve --list` shows `source terminal|prompt` for every
  entry, and `--revoke p<id>` / `--revoke all` cover them; each record and each use is an audit record
  with `source: "prompt"`. The credential helper and the `gh` account-write path consult no prompt
  approvals.
- `repo-aegis check --remote-ref <ref>`: the ref git will update on the remote, which pre-push passes
  on both of its paths.
- `Edit(<home>/prompt-approvals/**)` joins the `permissions.deny` rules `install claude-md` writes.
- **A yes ends when the person types.** `install claude-md` registers a UserPromptSubmit hook,
  `repo-aegis hook prompt-submit`, in the managed drop-in or in `settings.json` (`--uninstall` removes it).
  It deletes every prompt approval when the person types to the agent, is silent, exits 0 and never
  blocks the prompt (its pinned command exits 0, not 2, if the pinned binary is gone). So a yes followed
  by the person typing before the push, and a "no" followed by the person's next message, both mean the
  push asks again. `repo-aegis approve --revoke prompt` does the same by hand and leaves terminal
  approvals alone. Re-run `repo-aegis install claude-md` once to register it; with the managed drop-in,
  `doctor` reports `MANAGED_DROPIN_STALE` until you do.
- Prompt approvals bind more exactly: a mutating `gh api` binds the HTTP method as well as the endpoint
  (a yes to a PATCH is not a yes to a DELETE); `gh pr|issue edit|merge|comment|review <n>` and
  `gh release create|edit|upload <tag>` bind the number or tag when one is given (no target: the
  repository only, as before); `git push --delete` / `-d` binds nothing; and a record dated more than 5 s
  ahead of the reader's clock is ignored.
- Documented: for scripted `claude -p` runs, pass an explicit `--permission-mode` other than
  `default`/`acceptEdits`. The hook input has no headless indicator, and `permission_mode` reads
  `default` there too.
- **`repo-aegis docs [<topic>] [--path]`**: prints a user doc that ships in the package, from any directory.
  No topic lists them; `--path` prints the file path so an agent can Read or grep it. Read-only, and an
  agent may run it. `dist/docs` now carries the README, `cli-reference`, `configuration`, `agent-guide`,
  `agent-sandbox`, `agent-install`, `design/egress-guard` and the CHANGELOG (links between them are
  rewritten at build time so they resolve there). An agent helping a person whose command was blocked
  could not read the reference unless this repository was checked out.
- `doc/agent-guide.md` has a "Helping your person" section: run `--help`, read `repo-aegis docs`, hand the
  person the exact person-only command, never run it.

### Changed

- `engagements set-identity` prints `identities unchanged (to clear one column use --agent none or
  --person none; to clear both use --clear)` when nothing changed, instead of a bare "unchanged".

- **`--help` on a person-only command is allowed in an agent's Bash text.** `approve --help`,
  `identity add --help`, `engagements add --help`, `upstreams add --help`, `uninstall --help`,
  `install claude-md --help` and `repo-aegis help <verb>` no longer end in `AGENT_RAN_HUMAN_COMMAND`: the
  call changes nothing, and an agent that cannot read the help guesses flags. The exemption needs
  `--help` / `-h` (or `help <verb>`, `<group> help <sub>`) to be the **only** arguments; `approve x/y --help`,
  `approve --help x/y` and `approve --help && approve x/y` are still refused. The guard reads quote-stripped
  shell tokens: each must be exactly a verb word, exactly `--help` / `-h`, `--json` / `--no-color`, or a whole
  redirection (`2>&1`, `> file`, `< file`), and a redirection's target never counts as help. So `approve >--help`,
  `approve ' --help'` and `approve gh,--help`, which Commander does not read as help, stay refused.

- **Breaking-ish: Node.js 20 is no longer tested or documented as supported.** CI tests Node 22 and
  24, and the README and `doc/agent-install.md` now say Node.js 22 or later. No `package.json` has an
  `engines` field, so nothing changes at install time.
- This repo's own `leak-scan` and `leak-scan-strict` workflows install repo-aegis 0.13.1 (they
  were pinned to 0.10.2), and `dependabot-auto-merge.yml` is deleted.
- **The egress hook no longer reads a command's text for stray `gh` / `git push` mentions.** The
  "word backstop" re-scanned every command for `gh <group>` and `git push` words and reported any
  that the parser had not turned into an intent. Its false positives landed on `sed`, `echo` and
  heredocs: `sed -i 's/x/gh auth token/' doc.md`, `echo "git push"` and a heredoc that mentions
  `gh pr create` are now allowed. A segment the parser does not recognise as `git push` or
  `gh <write>` is not egress at the hook. Plain `git push origin main` and
  `gh pr create --repo o/r` are judged as before, and so are the shapes the parser follows (shell
  `-c` and `eval` text, heredocs and here-strings fed to a shell, wrappers, aliases, `$VAR gh …`).
- **Shapes that only the word backstop caught are now judged one layer down.** `find -exec gh …`,
  `parallel gh …`, `case` bodies, an interpreter's `-c` text or heredoc that runs `gh`, and a pty
  wrapper written out in full (`script -q /dev/null gh …`) are no intent at the hook. When they
  actually run `gh`, the `gh` shim judges the call; when they run `git push`, the pre-push hook
  does. The shim therefore needs to be first on `PATH` for those shapes (`repo-aegis doctor`,
  `SHIM_NOT_FIRST`). `EGRESS_PTY_WRAPPER` is still refused where the parser sees the wrapper
  through a variable or a substitution.
- **Remote and container runners are read as a shape, because no layer below them exists.** The shim and
  the pre-push hook run only on this machine, so `ssh host 'git push …'`, `ssh host gh pr create …`,
  `docker|podman exec|run … git push`, `kubectl exec pod -- gh …`, `devcontainer exec`,
  `nix-shell --run`, `nix develop -c`, `vagrant ssh -c`, `wsl`, `distrobox enter --` and `toolbox run`
  are now an unresolved intent when what they run is a `git push` or a `gh <write>`, so rule h refuses
  or asks as before. It is a parse of the runner's options and the command it is handed, not a scan of
  text: `ssh host ls`, `docker exec ctr cat file` and `ssh host 'echo git push'` stay allowed.
- `sudo -h` and `watch -p` take no value (they were skipped over the command): `sudo -h git push origin main`
  and `watch -p git push` now resolve to the push.
- `SHIM_NOT_FIRST` is a stated FAIL in `doctor` (it already failed by default; the severity is now
  explicit and pinned by a test). The shim is the only guard for the shapes the hook no longer reads.
- A bundle of short flags that ends in a value-taking flag is now read as taking the next word:
  `env -iC /tmp git push origin main` and `sudo -Eu root git push …` resolve to the push, so rule b′
  and the destination checks still see it.

- **The generated pre-push script passes `--remote-ref "$remote_ref"`, so re-run `repo-aegis install
  hooks`.** Until you do, `status` and `doctor` report the pre-push hook as stale
  (`HOOKS_SCRIPT_STALE`), and a yes at the prompt cannot reach it: the push is refused as before, and
  its message says to run `repo-aegis install hooks`. Nothing else about the old script's behaviour
  changes.
- `decideEgress`'s `ask` decision now lists every (intent, target) that asked, in `asked`.

- **A pinned binary that is gone no longer locks you out, and no longer opens a hole.** When the
  pinned node or CLI is missing (a Node upgrade, a removed install), the git hooks, the `gh` shim
  and every Claude Code hook command used to refuse everything until `install hooks`,
  `install shim` and `install claude-md` were re-run. A newer repo-aegis could also write a
  registry an older pinned one could not read, and the older one then refused every push. Now each
  pinned script records the version it was pinned for (`__ra_version=` next to the paths) and,
  when the pin is gone, runs the `repo-aegis` on `PATH` **only if it is at least that new**,
  with a warning naming both versions. An older one, a version that is not plain
  `MAJOR.MINOR.PATCH` (a prerelease, `v0.14.0`, a crash), nothing on `PATH`, or a pin installed
  without a version (an older install) is refused as before (exit 1 for the git hooks, exit 2 for
  the shim and the Claude Code hooks). `PATH` is never consulted while the pin works.
  `ENFORCEMENT_PIN_MISSING` stays a `doctor` failure. **The generated scripts and hook commands
  changed, so existing installs show as stale (`HOOKS_SCRIPT_STALE`, `SHIM_STALE`,
  `MANAGED_DROPIN_STALE`) until you re-run `repo-aegis install hooks`, `repo-aegis install shim` and
  `repo-aegis install claude-md`.**
- **An encrypted registry is treated as no registry.** Encryption at rest is deprecated and goes
  away in 0.15.0. Until then an encrypted registry no longer refuses every publish or every
  Write: the hooks, pre-push, the `gh` shim and the write hooks run as if there were none (rule h
  is skipped, and says so), so a person who left the registry encrypted is not locked out.
  Marker scanning (`_always` and engagement files) is unaffected. `doctor` reports
  `REGISTRY_ENCRYPTED` as a warning; the rule h and identity mapping it switches off are named in
  the message.
- **An unreadable registry now asks at the agent hook.** A registry that does not parse or validate,
  or was written by a newer repo-aegis, used to be refused outright by the Claude Code hook. It
  now asks a person (hosts with no prompt still deny). The pre-push hook and the `gh` shim still
  refuse, so a push stays refused until the registry can be read; the answer's text says so, and
  says "upgrade repo-aegis, then re-run `install hooks` and `install claude-md`" for a newer
  schema instead of "decrypt or repair". `doctor` reports a newer-schema registry as
  `REGISTRY_UNREADABLE` with the upgrade fix.
- **`registry encrypt` is person-only** (`REGISTRY_ENCRYPT_NEEDS_TTY`): an encrypted registry is read
  as none, which collapses every engagement's org boundary to the repository's origin org and turns
  rule h off, so an agent must not be able to do it. While the registry is encrypted the write hooks
  and the agent's egress hook (allows included) show the person a one-line notice as the JSON
  `systemMessage`; the egress hook also shows a notice when it ran through the pin fallback.
  `approve` now has a sentence of its own for an encrypted registry ("rule h is off while the
  registry is encrypted") instead of "encrypted or damaged".
- The write hooks (`hook check-write`, `hook scan-after-write`) report a registry from a newer
  repo-aegis as `REGISTRY_ERROR` with its own text ("a person upgrades repo-aegis and runs
  `repo-aegis install claude-md`"). Both now use fixed text for an unparseable registry: the
  parse error, which can name orgs, is no longer echoed by `scan-after-write`.

- **The git credential helper only chooses the account; it no longer decides whether a push may
  go.** An agent push from the default Claude Code sandbox, which sets a proxy variable and blocks
  the process list, used to be refused (`AGENT_PUSH_CHAIN_UNREADABLE`,
  `AGENT_PUSH_CREDENTIAL_CONFIG`, then `GH_IDENTITY_WRITE_NEEDS_HUMAN`). Now an owner mapped to a
  person login is pushed as that login with no approval (App identities are opt-in), and a public
  destination is still stopped by pre-push rule g. Removed from the helper:
  `AGENT_PUSH_CHAIN_UNREADABLE`, `AGENT_CREDENTIAL_DIRECT_FILL`, the approval lookups, and
  `GH_IDENTITY_WRITE_NEEDS_HUMAN` (it is now `repo-aegis gh` only). Anything that is not a known
  read (`fetch`, `pull`, `clone`, `ls-remote`, `archive`, `remote`, `submodule`) counts as a push,
  including a process list that cannot be read. The configuration checks keep only what would put
  the token in a trace or a helper that stores it (a helper in local, worktree or command scope;
  `GIT_TRACE_CURL`, `GIT_CURL_VERBOSE`, `GIT_TRACE_PACKET`, `GIT_TRACE_REDACT` off). A proxy
  (`HTTPS_PROXY`, `http.proxy`), a CA bundle, `http.extraHeader` and `http.sslBackend` no longer
  refuse, and `http.sslVerify=false` or `GIT_SSL_NO_VERIFY` give the token with a
  `repo-aegis: warning:` line. The same cuts apply to the git processes `repo-aegis gh` starts. A
  registry that exists but cannot be read (it does not parse, or a newer repo-aegis wrote it) is
  `GH_IDENTITY_UNAVAILABLE` for a push; an encrypted one prints a note on stderr and lets the next
  helper answer.
- **`repo-aegis install git-credential` works on stock macOS.** Apple's git carries
  `credential.helper = osxkeychain` in a config nobody edits, so the install used to refuse with
  `GIT_CREDENTIAL_ORDER_REFUSED` and a command a person had to run. When the global
  `credential.https://github.com.helper` list is empty, it now writes an empty reset entry, its
  helper, and the helpers the reset hides (osxkeychain) back after its own, and prints one line
  saying so. The ledger is version 2 (`resetAdded`, `readded`; version 1 is still read), and
  `--uninstall` removes exactly what was added: the helper, each re-added helper, then the reset
  (only when no other value is left under the key). A non-empty list with a system helper in front
  is still refused. The "needs an administrator" hint is gone.
- **`AGENT_PUSH_CREDENTIAL_STORE` is narrower for a person's token.** A later helper that would save
  an App token still always refuses (the person's later pushes would run as the App). A person's own
  login token, push or read, now refuses only for `store` (plaintext in `~/.git-credentials`) and an
  unrecognised helper; the OS stores (`osxkeychain`, `libsecret`, `wincred`, a credential manager)
  and `cache` pass.
- **A backstop for repositories that run their own hooks (`AGENT_PUSH_GUARD_NOT_RUNNING`).** With a
  repository-level `core.hooksPath` (husky), git does not run repo-aegis's pre-push, so a script-run
  push as the person's account to a repository not recorded as private is refused by the helper; a
  private repository, a global `core.hooksPath`, an App identity and reads are unaffected. Known
  residual: `git push --no-verify` skips the pre-push hook.
- **Known reads skip the trace-variable checks.** A `fetch`, `pull` or `clone` as the person's account
  no longer refuses on `GIT_TRACE_CURL` and the other trace variables (nothing is published); the
  plaintext-store guard still applies to reads.
- **The sandbox hint for a failed App mint names the network.** Inside the Claude Code sandbox,
  taaad-signer's own connection to GitHub does not go through the sandbox's proxy (it fails with
  `NSURLErrorDomain -1003`), so the old "keychain or network" guess is replaced, and the text says
  that adding api.github.com to the sandbox allowlist does not help.
- **`doctor` fails only when something is refused today or a guard is silently inert, and its report is
  short** (X-9, which also covers P3-C). Moved from fail to **warn**: `PUSH_DEFAULT_IMPLICIT`,
  `GH_LOGIN_UNREGISTERED`, `PERSONAL_ORG_UNREGISTERED`, `CLASS_VISIBILITY_UNRESOLVED`, `SHIM_STALE`,
  `MANAGED_DROPIN_STALE`, `MANAGED_DROPIN_NOT_ROOT_OWNED`, `MANAGED_DROPIN_LEDGER_STALE`, and
  `MANAGED_DROPIN_ORPHANED` when only the ledger entry is missing (a pin on missing files still fails).
  `GH_MEMBER_ORG_UNREGISTERED` is now **info** with a count (its own fix says "or leave it"). A fresh
  install plus a clone of someone else's repository gives no FAIL; a hook that is not installed, a shim
  that is missing or not first on `PATH`, and the other inert-guard codes still fail, and the exit code
  contract is unchanged (1 when any FAIL).
  `OWNER_IDENTITY_UNMAPPED` is reported only once the registry defines an identity, and
  `TAAAD_AGENT_WRITABLE` only when some owner maps a GitHub App as its agent identity.
  Repeated per-repository findings of one code collapse into one line with a count
  (`HOOKS_PATH_LOCAL_DUPLICATE: 14 repositories (repo-aegis doctor --json lists them)`), the text ends
  with a short "Fix these first" list (each FAIL once, with its fix command), and the per-finding `fix:`
  lines move behind the new `doctor --verbose`, which also lists every repository. `--json` still lists
  everything and gains `fix` on each repository result. The text summary counts the FAIL lines it prints
  (`doctor: 2 failing (1 machine, 1 across 219 repositories)`), and SKIPs that share a reason (two
  checks for one gh account, or `gh` absent) print as one line.

### Removed

- **The Action's `registry` input.** It only exported `REPO_AEGIS_REGISTRY`, but `audit` and
  `check` build the deny set from rendered marker files, so the scan saw no patterns: red under the
  default `require-deny-set` floor, a silent pass without it. The action never rendered markers
  from the registry, so the input could not work. A workflow that needs a registry installs the CLI
  itself and runs `repo-aegis render` (see `doc/github-action.md`).
- **The Action's `hits-json` output.** It was deprecated in 0.8.0 with removal promised for 0.9.0.
  Use `results-file`, the path to the JSON under `RUNNER_TEMP`. Only the exit code and that path
  are step outputs now.

### Fixed

- **Documentation now matches the code.** The README says what `init` does: it asks nothing, uses no
  `sudo`, and sets the git hooks globally. `doc/agent-install.md` step 4 no longer runs a second
  `engagements add` for an engagement that has a GitHub org (it fails with `ENGAGEMENT_EXISTS`).
  `doc/configuration.md` lists `REPO_AEGIS_MARKERS_DIR`, `REPO_AEGIS_VISIBILITY_LOOKUP` and
  `REPO_AEGIS_EGRESS_HUMAN`. A comment in `taaad-pin.ts` said an untrusted taaad refuses App tokens;
  it is a warning.

### Internal

- One non-throwing core loader, `loadRegistryState`, returns the registry's state (`loaded`,
  `missing`, `encrypted`, `unparseable`, `newer-schema`); the hook, the shim's egress check,
  pre-push, the `gh` identity layer, the write hooks and `doctor` use it instead of each
  re-deriving the state from exceptions. A registry from a newer repo-aegis now throws
  `RegistrySchemaTooNewError`, still a `RegistryParseError` with the same message.

## [0.13.2] - 2026-11-10

### Fixed

- **A fetch or pull from the Claude Code sandbox works again for owners mapped to a person's
  account.** 0.13.1 answered these reads with the mapped login's token but ran the push-time
  configuration checks first, and the sandbox always sets a proxy variable
  (`DOCKER_HTTPS_PROXY`), so every read was refused with `AGENT_PUSH_CREDENTIAL_CONFIG`. A known
  read now skips those checks; a later helper that would save the token still refuses it. Pushes
  are unchanged.

## [0.13.1] - 2026-11-09

### Fixed

- **A fetch, pull or clone from an owner mapped to a person's GitHub account now runs as that
  account.** The credential helper used to step aside for these reads, so git fell back to
  whichever account its next helper held (gh's active account, the keychain's). With more than
  one account, the read failed with "Repository not found" while a push to the same repo
  worked. The helper now answers known reads with the mapped login's token. A read needs no
  approval, prints nothing, and passes the same pre-mint checks as a push.

## [0.13.0] - 2026-11-09

### Changed — an agent can publish under one approval (Phase U of `doc/plan-landscape-recommendations.md`)

Before this release, opening one PR from a sandboxed agent session took five refusals and four
human round-trips, even with an active approval. Two of the refusals fired on state repo-aegis's
own installer had created.

- **An account-bound approval covers the deliberate-bypass refusals.** A live
  `repo-aegis approve <owner>/<repo>` or `<owner>/*` that carries a person login now also covers
  `AGENT_PUSH_CHAIN_UNREADABLE` (the credential helper can't read the process list, typically
  inside a sandbox) and `GH_IDENTITY_ARG_UNSAFE` for a repo-local git setting, within that
  approval's owner, scope and lifetime. Each covered call prints one line naming the approval and
  writes an audit record. A `*` approval, an approval without a login, a ref-limited approval and
  an expired one cover nothing. A readable process chain that shows a non-git caller is still
  refused, and so are unsafe gh ARGUMENTS (`--hostname`, `--editor`, …).
- **repo-aegis accepts its own hooks directory.** A repo-local `core.hooksPath` that resolves to
  repo-aegis's pinned hooks directory is no longer "unsafe". `install hooks --local` no longer
  writes a local value equal to the global one, and `doctor` reports an existing duplicate as
  `HOOKS_PATH_LOCAL_DUPLICATE` with the one-line fix.
- **A read falls back instead of refusing.** A read-only gh call whose identity can't be produced
  (`GH_IDENTITY_UNAVAILABLE`) runs as the active gh account with one warning line. Writes still
  refuse, and a minted token is never used on the fallback path.
- **SSH remotes are flagged.** For an owner whose agents push as a GitHub App, `doctor` and
  `classify --apply` report `AGENT_REMOTE_IS_SSH` with the person-run `git remote set-url --push`
  fix. An agent's SSH push goes out as the person's key.
- **Refusals say what caused them.** Every refusal on the agent publish path names its cause, says
  whether repo-aegis created that condition, gives a fix line, and says whether an approval
  covers it. Two refusals wrongly claimed an approval covers them; that is corrected.
- **Inside the agent sandbox, refusals name the sandbox.** `AGENT_PUSH_CHAIN_UNREADABLE` says a
  sandbox is the likely cause. A failed App-token mint says the sandbox most likely stopped
  taaad-signer before its presence prompt (`SANDBOX_RUNTIME` is set). See the new
  `doc/agent-sandbox.md` for what works there and the `sandbox.excludedCommands` route (unverified).
- **A failed mint names taaad's step.** taaad ≥ 0.7.0's last-line `taaad: error=<code>[ status=<n>]`
  is mapped (allowlisted codes only, copied verbatim; an unknown code becomes `internal` and is
  not echoed). With an older taaad, the generic texts now carry taaad's exit status.
- **taaad's derived read class is accepted** (taaad plan 0004). A read token passes when every
  permission is at `read`, whatever the key. Write or admin under read is still refused. taaad
  0.6.0's fixed four keys still pass.
- The acceptance test `packages/cli/src/agent-publish-path.test.ts` replays the sequence above and
  must pass. Not yet exercised against a live sandbox with real Touch ID.

### Added — refusals explain themselves from any repository

A refusal used to end `[CODE, see doc/agent-guide.md#code]`, a path in the repo-aegis repository.
An agent working in another repository had nothing to open, the npm package shipped only `dist`,
and no command explained a code.

- `repo-aegis explain <CODE|topic> [--json]` and `explain --list`. The guide now ships in the
  package (`dist/docs/agent-guide.md` and `agent-sandbox.md`, copied at build time), and the command
  prints the guide's error-table row for the code and the `###` section it links to. Read-only: no
  registry, no network, no git, no repository; the same answer from any directory. An unknown code
  exits 2 with the nearest codes.
- **Every refusal ends `[CODE; details: repo-aegis explain CODE]`.** The code token is first and
  unchanged, so a tool that matches `[CODE` still works. The trailer used to differ in form between
  gates, and three of them linked a case that did not match the guide's anchors.
- `repo-aegis identity list [--json]`, read-only: every identity (name, kind, login or App slug) and
  the personal orgs and engagements that use it as `person` or `agent`. An agent may run it and
  `explain`; the mutating `identity` verbs, `engagements set-identity` and `approve` are still
  refused for agents. Text redacts an engagement-only login, as `status` does.
- `engagements set-identity --person` warns (and still succeeds) when the identity's login is empty
  or not a valid GitHub login, and says writes through it will be refused until it is fixed.
- `GH_IDENTITY_WRITE_NEEDS_HUMAN` now says so when a live approval exists for the owner and
  repository but is bound to a different account than the owner's `person` identity, or when that
  identity has no valid login. It names the approval's id and prints no login.

### Added — egress guard for more agent hosts

- `hook guard-egress --agent copilot | cursor | antigravity`, with one adapter module per host
  under `packages/cli/src/commands/hook-hosts/`. Before this release, Copilot CLI (camelCase) and
  Antigravity CLI payloads were silently allowed even for `git push`, because the hook found no
  command field in them; they are now judged.
- `hook scan-after-write --agent cursor` for Cursor's `afterFileEdit`. It is detection only: the
  edit has already happened, and the pre-commit hook is the gate.
- Codex's current matcher `Bash` is documented (older builds: `shell`), together with the `/hooks`
  trust step. `--agent gemini` is legacy: Gemini CLI was replaced by Antigravity CLI.
- Every non-Claude host is built from vendor documentation and has not been exercised in a live
  session. `doc/agent-install.md` gives hand-registration snippets labelled that way, and a test
  keeps them parseable and registered.

### Fixed

- The git credential helper wrote its audit record to the caller's `REPO_AEGIS_HOME` instead of
  the pinned home.
- **An agent push for an owner whose only identity is a person can now be approved.** The credential
  helper passed no approvals to the identity decision, so `GH_IDENTITY_WRITE_NEEDS_HUMAN` could never
  be lifted for an HTTPS push, while `repo-aegis gh` honoured the same login-bound approval. The helper
  now reads the pinned home's approvals; with one that carries the owner's person login it hands git
  THAT login's token (`gh auth token --user <login>` through the trusted gh, never the active gh
  account's), after every check an App token passes (A5 configuration and environment, the `store`
  guard). It prints one stderr line naming the approval id and writes an audit record (id only: no
  login, no token). Without an approval the refusal stays, and its text now says a login-bound
  `repo-aegis approve <owner>/<repo>` from a terminal covers it.
- **An account-bound approval covers only the owner's CURRENT person login.** `AGENT_PUSH_CHAIN_UNREADABLE`
  and `GH_IDENTITY_ARG_UNSAFE` (git setting) were covered by an approval carrying any login, so one
  minted before the owner's person identity was re-mapped kept covering for up to 24 hours. Both
  callers now compare the approval's login (case-insensitively) with the login the registry maps
  now; an owner with no person login, or a registry that cannot be read, is covered by nothing.
- A covered unreadable-chain request for an owner with no registry is refused
  (`AGENT_PUSH_CHAIN_UNREADABLE`), never answered with silence that hands the push to the person's
  own helper.
- `install hooks --local` compares a `~`-spelled global `core.hooksPath` by its expansion, so
  `~/.repo-aegis/hooks` is the duplicate it is.

### Documentation

- New: `doc/guide-data-leak-prevention.md`, the background guide the README promised; a
  "Companion tools" section (ggshield, gitleaks), plus the result of a ggshield coexistence check:
  its installer keeps repo-aegis's hooks (file contents only, one install order tested); the
  universal secret-shape set is frozen; identity-layer non-goals; npm keywords.

### Documentation — docs corrected against the code

- The docs now describe the force-push scan depth (`--range` for an existing ref, `--push-ref`
  for a new one), `hook check-write` as the primary write gate, what a CI job without a registry
  actually scans, the `config-guard` limits and the `main`/`master` push trigger accurately.
- Instructions that failed as written are fixed: `engagements add` on an existing id, personal-org
  classification, the global `core.hooksPath` default, JSON examples, and config keys.
- Undocumented commands and flags are added to `doc/cli-reference.md`. Six plans and notes now
  name the release they shipped in. External-tool claims are linked or marked unverified, and
  Gemini CLI is noted as replaced by Antigravity CLI.
- Known issues are noted, not fixed: the PostToolUse hooks exit 1 on a hit, which may not reach
  the model (unverified); `allow`/`deny` ignore `--cwd`; the action's `registry` input is not
  rendered to markers.
- New: `doc/analysis-landscape-2026-11.md` (is repo-aegis still the right tool?) and
  `doc/plan-landscape-recommendations.md` (the follow-up plan).

## [0.12.2] - 2026-11-09

### Fixed — an App token mint gave up before Touch ID did

- taaad-signer waits up to 240 s for its presence prompt (Touch ID), but repo-aegis killed
  `taaad mint` after 30 s and reported it as "taaad could not be run". A fingerprint given after
  30 s refused the push or `gh` call. taaad now gets 300 s, and a timeout is reported as one.

### Fixed — a failed mint names the step that failed

- The credential helper always added "(the App may not be installed on this repository)", whatever
  went wrong. The refusal now names the step, from taaad's exit code and its error text (matched,
  never printed): the screen is locked, nobody answered Touch ID in time, the prompt was declined or
  its limit reached, the App has no installation, its installation does not include the repository
  or grant `contents: write`, or the launcher could not be started. `repo-aegis gh` gives the same
  messages.
- With the audit log on, a failed mint in the credential helper is now recorded: a `git-credential`
  entry with `outcome: "refused"`, the code and a fixed `reason` word. Before, it left no trace.

### Changed — `doctor` reports unmapped owners once

- `OWNER_IDENTITY_UNMAPPED` was one finding per owner. The owners are kept out of the text, so the
  report showed the same line once per owner. It is now one finding with the count; `--json` lists
  every owner in `names`.

## [0.12.1] - 2026-11-09

### Fixed — docs and `doctor` text for identities

- `doc/agent-guide.md`: the `dot gh` section said always `--as bot` and never plain `gh`, which
  contradicted `DOT_GH_OWNER_MAPPED`. For an owner mapped in the registry, agents use plain `gh`.
- `doc/configuration.md`: new "Setting up identities" walkthrough. It covers which owners can have
  an App (a private App installs only on its own account), and the person-only mapping for orgs you
  do not administer. A stale "in a later phase" note about `requireIdentity` is corrected: the
  refusal shipped in 0.12.0 (`GH_IDENTITY_UNMAPPED_OWNER`).
- `doctor`: `TAAAD_AGENT_WRITABLE` with no taaad pinned now says to install taaad v0.6.0 or later.
  The fix for a taaad that is not root-owned is marked optional.
- README: covers identities, the managed drop-in, approvals by org and TTL, and rule h.

### Fixed — the git credential helper read every agent push as a fetch

- Real git starts the HTTPS remote helper as `git remote-https <remote> <url>`, waits, and that
  process runs `git-remote-https` as its child. The helper took that dispatcher for the git that
  asked, so a push minted a read-only token and GitHub refused it (403, `Permission … denied to
  <app>[bot]`). It failed safe, but no agent HTTPS push to an App-mapped owner worked. The
  dispatcher is now skipped when it sits directly above the remote helper with the same arguments.
  The tests use the chain shape `GIT_TRACE=1` shows.

## [0.12.0] - 2026-11-08

**Upgrade:** re-run `repo-aegis install shim` (`doctor` reports `SHIM_STALE` until you do), and
optionally `repo-aegis install git-credential`. `person` (gh-login) identities need nothing new;
`agent` (GitHub App) identities need taaad v0.6.0 or later. taaad's macOS helper `taaad-signer`
is optional.

### Added — `repo-aegis gh`: the `gh` shim chooses the GitHub identity per call (phase 3 of `doc/plan-owner-identity.md` §13.3)

- **The shim now execs `repo-aegis gh --home <pinned home> -- "$@"` for every `gh` call except `--version`, `help` and `completion`.** The bash verb pre-filter is gone: reads in any group, and groups that were never publishing, are judged by the CLI too, at the price of one Node start per call. No shell code runs after the `exec`. With the pinned node or CLI missing the shim refuses every such call (exit 2), reads included; before, reads fell open. Re-run `repo-aegis install shim` after upgrading (`SHIM_STALE`).
- `repo-aegis gh` makes the egress decision exactly as `egress-check` does (shared code: same refusals, receipts and body read-back), then the identity decision from the registry and approvals under `--home` only (`REPO_AEGIS_HOME`, `REPO_AEGIS_REGISTRY` and other `REPO_AEGIS_*` in the environment are ignored), then runs `gh`. An unmapped owner runs the real `gh` with the caller's environment unchanged, as before. A mapped owner runs the trusted `gh` with a token for the chosen identity (`gh-login` via `gh auth token`, `github-app` via the pinned `taaad mint`, validated: installation account, exactly one repository, permissions no wider than the verb), in an allowlisted environment (no pager, editor, proxy, `BASH_ENV`, `SHELLOPTS` or `GIT_CONFIG_*` of the caller; fixed `GIT_CONFIG_COUNT` overrides for gh's git children). The token lives only in that child's environment. Prints `repo-aegis: as <identity> (<kind>) for <owner>/<repo>` and records the call (never the token) in `<home>/state/gh-decisions.jsonl`, whatever the audit log's setting.
- A fault between choosing and spawning on a mapped owner is `GH_IDENTITY_UNAVAILABLE` and `gh` does not run; an unmapped call keeps warn-and-run. New refusal codes `GH_IDENTITY_UNAVAILABLE`, `GH_IDENTITY_TOKEN_MISMATCH`, `GH_IDENTITY_INSTALLATION_MISMATCH`, `GH_BINARY_UNTRUSTED` (at the CLI) and `TAAAD_AGENT_WRITABLE`, with core's existing identity codes, in `doc/agent-guide.md`.
- `install shim` also pins taaad (launcher, interpreter, package directory) in the shim, and says whether all three are root-owned and writable by root only. If not, `doctor` warns with `TAAAD_AGENT_WRITABLE`, and App identities still work: repo-aegis guards against honest mistakes, and only an agent that deliberately edits taaad could exploit it. A `github-app` identity with no taaad pinned is a `doctor` failure. taaad `mint` exit codes 3 (prompt limit) and 4 (prompt declined) get their own messages. The git credential helper now reads the same pin instead of `<home>/state/taaad-pin.json`, which is no longer read. One `mintAppToken` (in `taaad-mint.ts`) serves both.
- `repo-aegis approve` records the destination owner's mapped person login in an `<org>/<repo>` or `<org>/*` approval and prints it; only such an approval, minted for that login, lets an agent write as that account to an owner with no `agent` identity. `*` approvals and approvals from before this release carry none and never cover it.
- Hardening of the injecting call, for the agent column: git options for a clone (`--`, `--template`, `--config`, `-c` on `repo clone`, `repo fork --clone`, `gist clone`) are `GH_IDENTITY_ARG_UNSAFE` (core), and for verbs that run git in the working directory (`pr checkout`, `pr create`, `repo sync`, clones, `issue develop --checkout`) the effective git config is checked first, before a token is minted: a local, worktree or command-scope `core.hooksPath`, `core.fsmonitor`, `core.sshCommand`, `url.*.insteadOf`, credential helper, or `http.proxy`-style setting refuses the call. With the registry missing or unreadable, `gh auth token` and the other token verbs are still refused without a person, and an unreadable registry refuses any agent call that names an owner (`GH_IDENTITY_UNAVAILABLE`). A fault in the egress parse on a mapped owner is refused for an agent.
- **Behaviour change for people:** a `gh` call from a non-terminal context (cron, a script with piped stderr) now counts as an agent for owners that are mapped; a mapped owner's App token or login token replaces the active account.

### Added — git credential helper and the pre-push rule (phase 4 of `doc/plan-owner-identity.md` §5.6, §13.4)

- `repo-aegis git-credential --home <home> <get|store|erase>`: a git credential helper. For an agent's HTTPS push to an owner with an `agent` identity it returns `x-access-token` and a token narrowed to that repository (`contents: write` for a push, read for a fetch), minted by the pinned taaad; with a person present, an unmapped owner or a person-only owner it prints nothing and the next helper answers. Every refusal prints exactly `quit=true` with the code on stderr: a request that does not come from `git-remote-https` (`git credential fill` run by hand: `AGENT_CREDENTIAL_DIRECT_FILL`), an unreadable process chain (`AGENT_PUSH_CHAIN_UNREADABLE`), repository-local credential helpers, proxies, TLS and trace settings (`AGENT_PUSH_CREDENTIAL_CONFIG`), a second differing path (`AGENT_PUSH_CREDENTIAL_PATH`), taaad failing or the App not installed.
- `repo-aegis install git-credential [--uninstall]` (needs a terminal): makes the helper the first one git runs for github.com in the global config, after any reset entry, refusing with instructions when a system-scope or global helper would still answer first; sets `credential.useHttpPath`. `--uninstall` removes exactly what it added (ledger in `<home>/state`); the global config is byte-identical after a round trip. `repo-aegis uninstall` runs it.
- Pre-push: with no person present, an owner mapped to an agent identity and an SSH push URL (`git@…`, `ssh://…`, an ssh-config alias) is refused with `AGENT_PUSH_NEEDS_APP` and the HTTPS form; over HTTPS the helper order is re-checked (`GIT_CREDENTIAL_HELPER_ORDER`).
- `doctor`: `GIT_CREDENTIAL_HELPER_ORDER`, a failure when an owner is mapped to an agent identity and the helper is missing, stale or not first.
- The helper uses the taaad pinned by `install shim` (see `repo-aegis gh` above); with none it refuses (`GH_BINARY_UNTRUSTED`); one that is not root-owned is only the `doctor` warning `TAAAD_AGENT_WRITABLE`.

### Added — identity choice for `gh` calls (phase 3 core of `doc/plan-owner-identity.md` §13.1)

No egress behaviour changes: nothing calls these yet. `@de-otio/repo-aegis-core`
exports the pure `identityPresence()`, `ghCallTargets()` and `chooseIdentity()`
(eleven ordered rules: auth verbs, targets, several owners, unmapped owner,
presence, redirect, supplied token, unsafe arguments, then the person or agent
column) with seeded-random property tests.

### Changed — stricter for agents: identity hook rules (`doc/plan-owner-identity.md` §13.2)

New refusals in the agent hook (`hook guard-egress`). They apply to Bash commands
an agent runs; none is lifted by an approval. This is a breaking change for
non-terminal automation that runs `gh auth token`, `taaad mint` and the like
through the hook: with no person present they are now refused.

- **A1** — any command that runs `gh`, `git`, `taaad` or `security` with a
  `REPO_AEGIS_*` variable set (prefix, `env`, `sudo env`, `sh -c`, `eval`, `$(…)`,
  heredoc-fed shell, or an earlier `export`) is `EGRESS_ENV_OVERRIDE`, and under a
  pty wrapper `EGRESS_PTY_WRAPPER`, whatever the command publishes. These checks
  now run before the "no egress intent" exit, so a read such as
  `REPO_AEGIS_EGRESS_HUMAN=1 gh pr view` is refused too. A person present does not
  lift them.
- **A10** — with no person present, `gh auth` with anything but a plain `status`,
  `gh config set|clear-cache`, `gh alias set|import|delete` and
  `gh extension install|upgrade|exec` are `GH_AUTH_NEEDS_HUMAN`. `gh auth token`
  alone (no network call) used to pass the hook.
- **N9** — with no person present, `taaad env|agent|credential-helper|mint`,
  `security find-generic-password|find-internet-password|dump-keychain|export|unlock-keychain`
  and a `python*` / `node` / `perl` / `ruby` / `osascript` `-c` / `-e` text that
  mentions `keyring` or `SecItemCopyMatching` are `TOKEN_MINT_NEEDS_HUMAN`. Speed
  bumps, not proofs; the keychain ACLs are the control.
- **N8** — a recognised `dot gh` write whose literal owner has an identity mapped
  in the registry is `DOT_GH_OWNER_MAPPED` (re-issue the same arguments to plain
  `gh`), decided before `DOT_GH_WRITE_NEEDS_BOT`. Unmapped owners are unchanged.
- **Security-review follow-ups to the above** (same release, stricter for agents):
  - `git credential fill|get|approve`, `git credential-<helper> get` and
    `git-credential-<helper> get` (osxkeychain, manager, …) are
    `TOKEN_MINT_NEEDS_HUMAN` with no person present, and count as token reads for
    `GH_AUTH_TOKEN_NETWORK`, which refuses them next to a network program whether
    or not a person is present.
  - Any segment that assigns or exports a `REPO_AEGIS_*` name with no command
    following (`X=1`, `export X[=…]`, `declare|typeset -x`, `readonly`, `read X`) is
    `EGRESS_ENV_OVERRIDE`, never lifted: the Bash tool's shell persists across
    calls. `REPO_AEGIS_EGRESS_HUMAN` is also ignored when a TTY sits under an agent
    host (an agent ancestor or the agent environment signal); a person's own
    terminal, and the no-TTY case, behave as before.
  - N9 also covers the `keyring` CLI and `secret-tool` (any path), `security -i`
    and `security` fed a listed subcommand on stdin, interpreter text naming
    `find-generic-password`, `find-internet-password`, `dump-keychain`,
    `SecKeychain`, `keytar`, `keyring` or `SecItemCopyMatching` (osascript
    `do shell script` included), and text piped into a non-shell interpreter.
  - A10 reads `--show-token=…` and `-t=…`, and a `gh` reached through
    `G=gh; $G …`, `alias g=gh`, `$(which gh)` or `$(command -v gh)`. A bare
    `gh auth` and `gh auth --help` are no longer refused.
  - The write hook refuses an agent's Edit or Write to gh's `config.yml` and
    `hosts.yml` in `$GH_CONFIG_DIR`, `$XDG_CONFIG_HOME/gh` and `~/.config/gh`
    (`GH_CONFIG_WRITE_REFUSED`).
- **Internal entry points and credential-helper reads** (stricter for agents):
  `repo-aegis gh …` and `repo-aegis git-credential …`, in any program-word form
  (`repo-aegis`, `npx repo-aegis`, `node …/dist/index.js`, a pinned path, behind
  `env`/`sudo`/`sh -c`/an alias), are `AGENT_RAN_HUMAN_COMMAND`: the `gh` shim and
  git reach them, not an agent. (The shim's own `exec` is not Bash text the hook
  sees, so it is unaffected.) `git credential fill|approve|reject` and the helper
  `get` forms are `TOKEN_MINT_NEEDS_HUMAN` with no person present wherever they sit
  on the line, whatever else it runs.
- `refusal` codes are documented in `doc/agent-guide.md`; the shape rules in
  `doc/design/egress-guard.md`.

### Added — registry schema version 3: GitHub identities per owner (phase 2 of `doc/plan-owner-identity.md`)

No egress behaviour changes: nothing chooses or injects a token from the new
data yet.

- The registry accepts `schemaVersion: 3` with a top-level `identities` map
  (`{ kind: gh-login, login }` or `{ kind: github-app, app }`), `personalOrgs`
  entries that are a string or `{ name, person?, agent? }`, an engagement's
  `person` / `agent` (for all its `githubOrgs`) and `requireIdentity`. Parsing
  fails closed and names the path: every reference must resolve, `agent` must
  name a `github-app` and `person` a `gh-login`, unknown keys are rejected,
  names and slugs match `^[a-z0-9][a-z0-9-]{0,62}$`, logins
  `^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:_[A-Za-z0-9]{1,20})?$` (an Enterprise Managed User `handle_shortcode` is accepted), and using any of it below version 3
  is an error naming the version. Identity names are checked on the raw YAML
  keys (a `__proto__` key is an error, not silently dropped). From version 3 an
  engagement may carry only its known keys (`id`, `name`, `started`, `ended`,
  `reposActive`, `markers`, `notes`, `githubOrgs`, `person`, `agent`), and a
  top-level key within edit distance 2 of a known one (`identites`,
  `requireIdentiy`) is an error; other top-level keys are still passed
  through, and below version 3 nothing new is rejected. A build without this
  release refuses the file as newer than it supports: rule h then refuses
  every non-interactive egress, and an older pinned `hook check-write` exits 1,
  which Claude Code treats as non-blocking, so the cross-org write check fails
  open on that install.
- `Registry.personalOrgs` stays a list of names; the mapping is a separate
  `identityMap` (lower-cased owner to `{ person?, agent? }`), so
  `registeredOwners()`, `approvalScopeOf()` and the deny set read what they
  always read.
- New human-only commands (each needs a terminal, `IDENTITY_CHANGE_NEEDS_TTY`,
  and the agent hook refuses them as `AGENT_RAN_HUMAN_COMMAND`):
  `repo-aegis identity add <name> --gh-login <login> | --app <slug>`,
  `identity remove <name>` (refused while referenced), `identity require --off`,
  and `engagements set-identity <id> [--person] [--agent] [--clear]`. For a
  personal org the form is `engagements set-identity --personal-org <org> ...`
  (there is no separate `personal-org` command group). The registry is written
  as version 3 only when the first identity or mapping is set; the first
  `set-identity` also sets `requireIdentity: true`. `identity require --on`
  only tightens, needs no terminal and may be run by an agent. `set-identity`
  refuses an engagement with no `githubOrgs` (it would map nothing).
- Every path that RAISES the schema version (the first `identity add`) refuses
  with `MULTIPLE_INSTALLS` while a `repo-aegis` on `PATH`, or one that an
  installed git hook, the `gh` shim, or a Claude Code hook (the managed drop-in or
  `settings.json`, which runs `hook check-write`) is pinned to, cannot read version 3. That
  is judged by the supported version read from the install's own core package
  (never by running it); when it cannot be read the package version is
  compared, and an install whose version cannot be read is refused.
- `status` lists identities and mappings (names, kinds, logins, slugs; an
  engagement by id, never by its orgs). Text prints a login only when a personal
  org uses the identity: an Enterprise Managed User shortcode can identify a
  customer, so engagement-only and unreferenced logins print as
  `<engagement-only login>`; `--json` carries them all. `doctor` reports
  `OWNER_IDENTITY_UNMAPPED` per registered owner with no identity entry: a
  warning, a failure when `requireIdentity` is set (the text says how many
  owners are still unmapped; owners are named only in `--json`).

### Fixed

- The registry mutators that scan `personalOrgs` for an existing org (`engagements
  add --personal-org`, `init --migrate-classify`) and the owner-set-empty gate
  now see object-form entries, so an entry with identities is neither added
  twice nor invisible to the check that stops the last owner being removed
  without a terminal.
- `init --force` counts `identities` and `requireIdentity` as content, so it needs a
  terminal on an identity-only registry.
- `hook check-write` now blocks (exit 2) when the registry cannot be read,
  with a message that names no org or engagement. It used to exit 1, which
  Claude Code treats as non-blocking, so an unreadable registry switched the
  cross-org write check off.

### Fixed — code scanning

- Two regexes in the human-only command detector (`NAME=VALUE` bindings and
  shell function definitions) are replaced by linear-time scans that return
  exactly the same matches; the old regexes remain in the tests as the oracle.
  Closes the `js/polynomial-redos` alerts.
- Removed unused imports and an unused helper (`js/unused-local-variable`).

## [0.11.4] - 2026-11-08

### Fixed — `GH_AUTH_TOKEN_NETWORK` refused lines with a local `git` command

- `gh auth token` next to any `git` command was refused as a token handed to
  a network call, so a status script that listed tags with `git -C <dir> tag`
  next to `gh` reads could not run. Only git subcommands that can reach a
  remote now count: a positive list of local built-ins (`tag`, `log`,
  `status`, `diff`, `rev-parse`, `describe`, …) does not. `push`, `fetch`,
  `pull`, `clone`, `ls-remote`, `remote`, `submodule`, aliases, unknown
  subcommands and any `-c`, `--config-env` or `--exec-path` option still do.

### Security

- Write hooks no longer let a payload past 1 MiB through unchecked (#156).
  `hook check-write` and `hook scan-after-write` cut the payload at 1 MiB and
  then failed to parse the prefix, so the path policy and the marker scan were
  both skipped and the hooks exited 0. They now read the file path from the
  payload's start with a JSON lexer (a key inside another string's content is
  never taken for one). The path is all the policy needs, and the scan reads
  the file from disk. If the path is not in the prefix, `check-write` refuses
  with `HOOK_INPUT_TOO_LARGE` and `scan-after-write` reports that the file was
  not scanned.
- `hook scan-bash-output` had the same flaw past its 8 MiB cap, so a large
  output was not scanned at all, despite its comment. It now scans the text it
  read.
- The `gh` alias config is read through one file descriptor, so the size cap
  and the read see the same file, and a FIFO at the path cannot hang the
  guard (code scanning: file-system race).
- The tmux socket in a process title is found in linear time instead of with
  a regex that rescans the line from every `(` (code scanning: polynomial
  ReDoS).
- Development only: `minimatch` is overridden to `^11.0.5` (GHSA-g3hv-75wg-m249,
  denial of service; reached only through `c8`, never shipped).

## [0.11.3] - 2026-11-04

### Fixed — `doctor` printed `sudo: a password is required`

- The `SUDO_NOPASSWD` check runs `sudo -n -k /usr/bin/true`, and sudo's
  refusal is the passing outcome. Its stderr went straight to the terminal,
  where it read as an error. The probe now captures it.

## [0.11.2] - 2026-11-04

### Fixed — `[y/N]` prompts answered "no" before the person could type

- `install claude-md`, `install claude-md --uninstall` and every other
  `[y/N]` confirmation returned "not confirmed" at once in a real terminal.
  Checking `process.stdin.isTTY` puts a terminal's stdin into non-blocking
  mode, so the first read threw `EAGAIN`, which was taken as no answer. The
  read now waits and retries on `EAGAIN`; any other error is still no answer.
  This blocked writing the managed-settings drop-in in 0.11.1.

## [0.11.1] - 2026-11-04

### Added — `dot gh` is recognised; agent writes through it need `--as bot`

- **`dot gh` is recognised.** Since 0.11.0 the egress guard refused `node
  <script> gh …` as an unparsed shape, so an agent that followed its
  organisation's rule and wrote as the bot (`dot gh --as bot pr create …`) was
  stopped, and plain `gh` (which writes as the active person) was its only
  path. The parser now reads exactly `node <path>/dot.mjs gh [--as <id>]
  [--explain] <gh args…>` and `dot gh …` as the `gh` call they make, and judges
  it as a plain `gh` (rules a–h, public-repo approval, markers). Every other
  wrapper shape stays refused. `--explain` runs no `gh` and is no egress.
  Design: `doc/plan-recognise-dot-gh.md`.
- **`DOT_GH_WRITE_NEEDS_BOT`.** With no person present, a write through `dot gh`
  must carry `--as bot` as `dot gh`'s first option; without it `dot gh` picks
  the identity from the repository's owner, which for the user's own
  organisation is the user. The refusal gives the corrected command. Reads may
  use any identity. The `install claude-md` block and `doc/agent-guide.md` say
  so.
- **Changed:** a `dot gh` call with a person present is now judged as a plain
  `gh` instead of as an unparsed shape. Agent calls were all refused before, so
  nothing is stricter for agents except the wording of the refusal.
- **Known limit:** a person's own public write or merge through `dot gh` is
  judged at the `gh` shim, which `dot gh` hands a piped stderr, so the shim's
  terminal test never sees a person; such a call needs
  `REPO_AEGIS_EGRESS_HUMAN=1` or plain `gh`.

### Stricter (may refuse what 0.11 allowed)

The git hooks and the `gh` shim now run the scanner by the absolute path of the
Node executable and CLI entry that installed them, and fail closed. **After
moving or upgrading Node (for example through a version manager), or
reinstalling repo-aegis, re-run `repo-aegis install hooks` and `repo-aegis
install shim`**: until you do, commits and pushes are blocked and the shim
refuses `gh` publishing verbs, with a message naming the missing path and the
command to run. Existing installs keep their old, unpinned scripts until you
re-run the installers; `repo-aegis doctor` reports them
(`ENFORCEMENT_UNPINNED`). Design: `doc/plan-pin-enforcement-binary.md`.

- **Pinned enforcement binary.** `pre-commit`, `pre-push` and the `gh` shim called
  `repo-aegis` (and, through its `#!/usr/bin/env node` line, `node`) by name, so
  whatever came first on `PATH` decided what enforced: a file named
  `repo-aegis` that exits 0 in a directory ahead of the real one switched off the
  scans and the shim's egress check, and two installs meant different versions
  in the person's terminal and the agent's shell. `install hooks` and `install
  shim` now write the absolute paths into the scripts (shell-quoted; a path with
  a newline or NUL refuses the install, `PIN_PATH_UNSUPPORTED`).
- **Fail closed.** The hooks used to `exit 0`, and the shim to `exec` the real
  `gh`, when no `repo-aegis` was found. A missing pinned file now makes the hooks
  exit 1 and the shim refuse publishing verbs (exit 2); other `gh` verbs still
  pass through. There is no environment variable to turn this off.
- **Staleness follows the pin.** `status` and `doctor` compare installed hooks and
  the shim with the script rendered for the current pin: a hook or shim pinned
  elsewhere, or an old unpinned one, is `HOOKS_SCRIPT_STALE` / `SHIM_STALE`.
  Library change: `renderHookScript(name, pin)` and `hookScriptDigest(name, pin)`
  replace the `PRE_COMMIT_SCRIPT`, `PRE_PUSH_SCRIPT` and `HOOK_SCRIPTS` constants,
  and `resolveHookState` takes the pin.
- **`doctor`:** `ENFORCEMENT_UNPINNED` and `ENFORCEMENT_PIN_MISSING` (failures),
  and `MULTIPLE_INSTALLS` (warning: more than one `repo-aegis` on `PATH`, listed
  with each version, or the first one is not the pinned one; nothing on `PATH` is
  executed).
- **Claude Code hook commands are pinned too.** `install claude-md` now writes each
  hook (`check-write`, `guard-egress`, `scan-after-write`, `scan-bash-output`,
  `egress-receipt`, `first-touch`) as a one-line `sh` command that runs the pinned
  node and CLI by absolute path and exits 2 (a blocking hook error) if either is
  gone, instead of `repo-aegis hook …` resolved on the agent's PATH. A missing command
  exits 127, which Claude Code treats as non-blocking, so the old form could be
  replaced by a file named `repo-aegis` in a directory ahead of the real one.
  Re-running `install claude-md` replaces older by-name entries in place (and entries
  pinned to an earlier path); `--uninstall` removes both forms; `doctor`
  (`ENFORCEMENT_UNPINNED`) reports by-name entries until then, and
  `GUARD_HOOK_UNREGISTERED` accepts either form. A pin path with a newline or NUL
  refuses the install (`PIN_PATH_UNSUPPORTED`).
- **`install claude-md`** adds `permissions.deny` Edit rules for the pinned CLI's
  package directory and the pinned Node executable, in the same ledger as the
  registry rules, so an agent cannot overwrite the code the pin points at. A
  package directory inside a git work tree (a development checkout) is warned
  about and not denied.
- **`install claude-md` now writes a root-owned managed-settings drop-in**, not
  `~/.claude/settings.json`. Run it from your own terminal: it shows the path,
  size, digest and a diff, asks `[y/N]`, then `sudo` asks for **your password**
  once. The file (`/Library/Application Support/ClaudeCode/managed-settings.d/
  50-repo-aegis-<uid>.json` on macOS, `/etc/claude-code/managed-settings.d/…` on
  Linux) holds the hooks and the `Edit(//…)` deny rules, so the agent running as
  you cannot edit or remove it, and your own `settings.json` can stay portable
  (it holds only your preferences again). Each hook starts with a uid guard, so a
  second account on the machine is unaffected. Only fixed commands run as root,
  by absolute path, after checks on `sudo`, the tools and the directories
  (`PRIVILEGED_TOOL_UNSAFE`, `SYSTEM_DIR_UNSAFE`); the file is read back. The
  first run moves repo-aegis's earlier entries out of `settings.json` (once the
  drop-in is verified and nothing shadows it) and asks you to confirm `/status`
  in Claude Code lists `(drop-ins)`. **Before `npm rm -g repo-aegis`, run
  `repo-aegis install claude-md --uninstall`**; if a fail-closed hook is left
  behind, every blocked call prints the literal `sudo rm '<path>'` that removes
  it. `--user-settings` keeps the old behaviour for containers and other places
  without `sudo` (and is the automatic fallback on an unsupported platform, as
  root, or without `/usr/bin/id`); `init` uses it. New `doctor` codes:
  `MANAGED_DROPIN_STALE`, `MANAGED_DROPIN_NOT_ROOT_OWNED`,
  `MANAGED_DROPIN_UNREADABLE`, `MANAGED_DROPIN_ORPHANED`,
  `MANAGED_DROPIN_LEDGER_STALE`, `MANAGED_HOOKS_DISABLED`,
  `MANAGED_SOURCE_SHADOWED`, `MANAGED_HOOKS_NOT_FIRING` (a SessionStart heartbeat
  proves Claude Code loads the file; server-managed policy and MDM make it ignore
  drop-ins) and, as warnings, `SUDO_NOPASSWD` and `ENFORCEMENT_IN_USER_SETTINGS`.
  With `NOPASSWD` sudo the drop-in is no stronger than the user file. The egress
  guard now also refuses an agent Bash command that uninstalls the drop-in or
  runs `sudo` on the managed-settings directory
  (`AGENT_RAN_HUMAN_COMMAND`). `GUARD_HOOK_UNREGISTERED` and
  `REGISTRY_AGENT_WRITABLE` read the drop-in as well as the user file. Library
  change: `managedHookCommand` and `isManagedHookCommand` in core. See
  `doc/configuration.md#the-claude-code-managed-drop-in`.

- **Security-review fixes for the managed drop-in.**
  - `install claude-md` no longer strips repo-aegis's entries from
    `~/.claude/settings.json` without a person at a terminal, even when the
    drop-in is unchanged (it used to, because no root step ran), and no longer
    does so while `MANAGED_HOOKS_NOT_FIRING` is failing. Without a terminal it
    prints what a terminal run would remove and leaves the file untouched; if
    you put the entries back because the drop-in was shadowed, they stay.
  - An unchanged drop-in in a directory that group or others can write is now
    refused (`SYSTEM_DIR_UNSAFE`) instead of reported as already installed.
  - `MANAGED_HOOKS_NOT_FIRING` fails when the heartbeat or the install time is
    in the future (it cannot be trusted), and skips with its own reason when the
    file system reports no creation time for Claude Code's session files.
  - `SUDO_NOPASSWD` runs `sudo -n -k /usr/bin/true` only after the same check
    that covers every other tool root runs (a root-owned regular file that
    group and others cannot write).
  - The agent-command guard refuses any `sudo` or `doas` command, whatever the
    verb, on a command line that names the managed-settings directory, including
    globbed and `/./`-spelled paths. Reading the directory needs no `sudo`.
    It reads command text and is not a boundary.
  - The privileged write refuses, before any `sudo` call, a symlink, directory
    or other non-regular file at the drop-in path or its temp name.
- CI: a new `managed-dropin-e2e` job (Ubuntu and macOS) installs and uninstalls
  the drop-in with real `sudo` against the real system directory
  (`tests/managed-dropin-e2e.sh`). It is the first macOS job in CI.

## [0.11.0] - 2026-11-03

### Stricter (may refuse what 0.10 allowed)

Egress to an owner nobody registered is now refused, and the rules that keep
that refusal from being bypassed are stricter too (issue #151). **Run
`repo-aegis doctor` after upgrading.** It reports the logged-in `gh` accounts
and organisations that are not registered owners, which is the most likely
cause of a new refusal, and `OWNERS_UNDECLARED` / `REGISTRY_UNREADABLE` as
failures. Each refusal below names its code, says whether an approval helps,
says who runs the fix, and points at `doc/agent-guide.md`. Design:
`doc/design/egress-guard.md`.

- **Rule h: `UNREGISTERED_OWNER_EGRESS`.** With no person present (no TTY on
  stderr), a publish whose destination owner is in neither `personalOrgs` nor
  any engagement's `githubOrgs` is refused at the agent hook, the `gh` shim and
  the pre-push hook. **No approval satisfies it**, `*` included. The registry
  alone decides: not the destination cache, a local class or the active `gh`
  login. It is skipped, with a note, when no registry exists or the registry
  declares no owners; an encrypted or unparseable registry refuses instead.
  Owners whose names contain `_` (Enterprise Managed Users) cannot be
  registered, so an agent is refused there permanently. *Recovery:* a person
  runs, from a terminal, `repo-aegis engagements add --personal-org <owner>`
  (or `--github-org <owner>` under the engagement); for a fork's upstream,
  `repo-aegis upstreams add <owner>/<repo>`. A person at a terminal is never
  refused by rule h.
- **Unresolved writes fail closed (D5).** A write whose owner cannot be named
  offline counts as unregistered: a GraphQL mutation addressed by node id, a
  `gh api` write to an endpoint with no owner in the path
  (`repositories/<id>/…`, `gists`, `projects/…`), a target held in a variable
  (`--repo "$VAR"`, `GH_REPO=$X`), an alias or extension the guard cannot
  expand, a push URL that does not resolve. A `*` approval therefore **no
  longer covers a GraphQL mutation**. The parser also now reads `GH_REPO`,
  URL and `<owner>/<repo>` positionals, `-Ro/r`-style attached flags, gh's
  own base-repository pick, `insteadOf` / `pushInsteadOf` / `pushurl` and ssh
  host aliases, so more commands name their real owner. *Recovery:* name the
  repository literally (`gh issue comment --repo <owner>/<repo> …`, or the
  `repos/<owner>/<repo>/…` endpoint), or a person runs the command.
- **`*` approvals cover only `personalOrgs` (D7).** A `*` approval used to match
  every owner. It now covers repositories under your `personalOrgs` and
  `npm publish`; with no `personalOrgs` it covers `npm publish` only. A
  customer org and an allowed upstream are not covered, and neither is a gist
  or other account-level call. `approve '*'` prints what it covers. *Recovery:*
  a person runs `repo-aegis approve <org>/*` or `repo-aegis approve
  <org>/<repo>`.
- **A non-interactive `gh pr create` must name its target (D10):
  `GH_PR_CREATE_IMPLICIT_TARGET`.** Without `--repo`, `GH_REPO` or a URL, gh
  picks the base repository from `remote.*.gh-resolved` and remote order,
  which an agent can edit. Unconditional; no approval lifts it; `gh pr create`
  only. *Recovery:* re-issue as `gh pr create --repo <owner>/<repo> …`.
- **Registering an owner needs a person at a terminal.** `engagements add
  --personal-org|--github-org`, `upstreams add`, `init --migrate-classify`
  (which also lists the owners and waits for a typed `y`:
  `MIGRATION_NOT_CONFIRMED`), `init --force` over a populated registry, and any
  change that leaves no registered owner refuse with `OWNER_ADD_NEEDS_TTY` or
  `OWNER_SET_EMPTY_NEEDS_TTY`. No env var or approval lifts them. Scripts and
  agent runbooks that ran `engagements add --github-org` unattended now fail.
  Every registry mutator also validates the new registry before writing
  (`REGISTRY_WOULD_BE_INVALID`) and writes nothing on failure. *Recovery:* run
  the command yourself in a terminal window. Removing one owner among several,
  `upstreams remove` and `upstreams list` need no terminal.
- **A terminal is no longer proof of a person.** `approve` and the owner adds
  also read the process ancestry: they refuse when an agent host (`claude`,
  `codex`, `gemini`) or a pty wrapper sits above the process, when
  `CLAUDECODE=1` is set, or when the chain does not reach a login session,
  `sshd`, a terminal emulator or an attached multiplexer; an unreadable chain
  (no `ps`, as in an agent sandbox) means "not a person". Rules g and h refuse
  on an agent or wrapper ancestor too. New hook refusals:
  `EGRESS_PTY_WRAPPER` (a publish under `script`, `unbuffer`, `expect`, `tmux`,
  `ssh -t` and the like), `AGENT_RAN_HUMAN_COMMAND` (a command text that runs
  `approve`, an owner add, `upstreams add` or `init --migrate-classify|--force`)
  and `AGENT_DETACHED_SESSION` (`tmux new -d`, `screen -dm`, `setsid`,
  `daemonize`, `nohup … & disown`). *Recovery:* run the command directly, and
  run `approve` and owner adds in your own terminal window. A tmux server or
  shell started from inside an agent keeps `CLAUDECODE=1`; open a fresh
  terminal, or unset it and `CLAUDE_CODE_ENTRYPOINT`.
- **Shape rules b′ and b″.** `EGRESS_ENV_OVERRIDE`: a publishing command that
  sets `REPO_AEGIS_*`, `HOME`, `PATH`, `GIT_CONFIG*`, `GIT_SSH*`, `GH_CONFIG_DIR`,
  `SRT_*`, `SHELL`, `LD_*` and similar, uses `env -i` / `-u`, `--git-dir` /
  `--work-tree`, or `git -c remote.*` / `url.*` / `core.sshCommand` /
  `core.hooksPath`. `EGRESS_AFTER_STATE_CHANGE`: a publish that follows `git
  remote`, `git config`, `gh repo set-default`, `gh alias set`, `gh auth`,
  `export` or a write into git or gh config in the same command. Both are
  unconditional and no approval lifts them. *Recovery:* re-issue the plain
  command; run a state change as its own call first.
- **Network paths outside `gh` and `git` (R6).** `GITHUB_API_VIA_HTTP_CLIENT`
  refuses `curl` / `wget` writing to `api.github.com` or `uploads.github.com`;
  `GH_AUTH_TOKEN_NETWORK` refuses `gh auth token` in a command that also makes
  a network call. Speed bumps, not proof: an interpreter's `-c` text still gets
  through. *Recovery:* use `gh api …` or a `gh` verb with `--repo`.
- **The pre-push hook script's digest changed.** The only change is a comment
  (`$2` is the URL after all rewriting, once per push URL), but the digest
  covers the script text, so installed copies report `HOOKS_SCRIPT_STALE`
  until `repo-aegis install hooks` is run again. The `gh` shim script is
  unchanged. *Recovery:* `repo-aegis install hooks`.
- **`CROSS_ORG_PUSH` no longer names the boundary's owners.** They can be
  customer names, and a refusal can land in an agent transcript; only the
  destination owner, which the command already carries, is named.
- **The egress parser's expansion is bounded.** `sh -c '"$@" …' sh ARGS…`
  splices its arguments into its text, and nesting multiplies them: about
  1 KB of input could exhaust the guard's memory, and a guard process that
  dies does not block. One positional expansion is now capped at 64 KiB, the
  nested text of one command line at 4 MiB, and a line with more than 64
  publishing operations is judged on its first 64, every shape-rule label, and
  one fail-closed intent for the rest. Past a bound the command is treated as
  unresolved (refused without a person). *Recovery:* split the command.
- **A command larger than 1 MiB is refused at the agent hook** (`HOOK_INPUT_TOO_LARGE`).
  It used to be truncated, fail to parse, and pass unjudged, which skipped every
  hook-only rule. A payload for a non-shell tool still passes. *Recovery:* put
  large content in a file (`--body-file`, `-F`, `-d @file`).

### Known limits (not refused; stated so nobody assumes coverage)

- **R8.** A `GH_REPO` exported from a shell startup file is invisible to the
  agent hook; only the `gh` shim sees it. On hook-only installs that gap is
  open. `doctor` flags the export (`SHELL_STARTUP_OVERRIDES`).
- **R9.** Any ssh override (`GIT_SSH_COMMAND`, `GIT_SSH`, `core.sshCommand`, a
  ProxyCommand or ProxyJump) makes ssh hosts unresolved, so inside the Claude
  Code sandbox, which sets `GIT_SSH_COMMAND`, an agent's ssh push to a
  non-GitHub host (GitLab, an internal server) needs a person. https pushes and
  GitHub pushes through aliases are unaffected.
- **R10.** ssh connection sharing (`ControlMaster`) can carry a later push
  through a connection an agent opened to github.com under another alias name.
  Inside the sandbox `ControlPath=none` defeats it.
- **R11.** On hook-only installs the agent hook cannot see the environment ssh
  will run with; the pre-push hook can, and refuses. `doctor` warns when it is
  not installed (`PREPUSH_HOOK_MISSING`).
- **R12.** Every presence signal (TTY, ancestry, emulator root) can be forged by
  a same-user agent running outside the agent sandbox, which could also write
  the approvals file or the registry directly. Inside the sandbox the gates fail
  closed. A Keychain / Touch ID presence signal is a tracked follow-up.
- **A program written at run time.** The agent hook reads the command text,
  not files: `bash x.sh`, or a script written and run in one command (`cat >
  x.sh <<EOF … EOF; bash x.sh`, a `base64 -d` into a file), is not judged
  there. The `gh` shim and the pre-push hook judge the real `gh` or `git push`
  when it runs.

### Added — registered owners, `upstreams`, and five-part refusals

- **`repo-aegis upstreams add|remove|list <owner>/<repo>`** manages
  `allowedUpstreams` in the registry: exact repositories whose PRs, issues and
  comments a fork may target despite the owner not being registered. It never
  admits `git push`, merge, release, repo or workflow verbs, or `gh api`
  writes. `add` needs a terminal. The field is additive, with no schema bump;
  older binaries ignore it.
- **`approve` says what it covers** when minted, and warns when the
  destination's owner is not registered (the approval will not help until a
  person registers it).
- **Refusals answer five questions**: what was refused, why, whether an
  approval helps, the fix and who runs it, and where to read more. They name
  only the destination owner, never registry contents. Each new code has an
  entry in `doc/agent-guide.md`.
- **Audit:** an owner or upstream add is recorded as `registry-owner-add` with
  a kind and a count, never the owner's name.

### Added — `doctor` owner checks, and a registry write-protection rule

- **`doctor` checks the registered owners** (issue #151): `OWNERS_UNDECLARED`
  and `REGISTRY_UNREADABLE` (both failures), `GH_LOGIN_UNREGISTERED`,
  `GH_MEMBER_ORG_UNREGISTERED` and `REGISTERED_ORG_NOT_MEMBER` for **every**
  `gh` account logged in for github.com (each account's token reaches the child
  `gh` through its environment only; doctor never switches accounts and never
  prints a token). Organisation names appear only in `fix` and `--json`.
  `warn` and `info` findings never change the exit code. Also new:
  `PREPUSH_HOOK_MISSING`, `SHELL_STARTUP_OVERRIDES` and `SSH_GITHUB_REDIRECT`.
- **`install claude-md` adds `permissions.deny` `Edit` rules for the registry
  file (and its `.age`), the approvals store, `hooks/**`, `bin/**` and the
  rendered `markers/**`** (an agent that edits those drops markers silently; an
  agent-run `render` is now refused in the sandbox with
  `MARKERS_WRITE_PROTECTED`, and a person runs it), so the
  agent's file tools cannot register an owner by editing `engagements.yaml`.
  Edit rules reach the sandbox, so a sandboxed `sed -i` is stopped too (verify
  with a sandboxed `touch`); `state/` stays writable. `install claude-md
  --uninstall` removes exactly the rules install added, recorded under
  `state/`. To recover from a rule you do not want:
  `repo-aegis install claude-md --uninstall`.
- **`doctor` only hands a token to a trusted `gh`.** The active account is
  checked without reading a token; other accounts' tokens are read only after a
  y/N at a terminal naming the gh binary. The checks are skipped when another
  `gh` precedes the shim, when the gh or its `PATH` directory is under `$HOME`,
  the cwd or a temp directory or in a writable one, or when the file is not
  really a gh (a link named `gh` to `/bin/sh`): `GH_BINARY_UNTRUSTED`. Other
  accounts' tokens are not read when gh is configured to redirect requests
  (`http_unix_socket`, `GH_CONFIG_DIR`, `GH_HOST`, token variables):
  `GH_CONFIG_REDIRECT`.
- The `PERSONAL_ORG_UNREGISTERED` fix now says a person runs the owner add from
  their own terminal.

## [0.10.3] - 2026-09-23

### Fixed — an `UNKNOWN` destination visibility let a push through

The pre-push hook counted a destination as public only when the visibility
cache said `public`, so a repository the cache had never seen went through
labelled `(unknown)` — on 2026-09-12 that included a public one. A push to a
URL other than the checkout's own origin also borrowed the *pushing* repo's
visibility. The `gh` shim already failed closed on an uncached repo, but only
for personal orgs (#114).

- **One rule, every layer.** The pre-push hook, the `gh` shim and the agent
  hooks share `treatAsPublicDestination`: only a recorded `private` passes
  without a person. `unknown` fails closed exactly like `public` — from a
  shell with no TTY and no live `repo-aegis approve`, it is refused.
- **The cache refreshes itself.** An unknown destination gets one
  `gh repo view <org>/<repo> --json visibility` lookup (5 s timeout); the
  answer is recorded, so the next call is offline again. A failed lookup
  leaves the refusal standing — the network can lift a refusal, never cause
  or skip one. `REPO_AEGIS_VISIBILITY_LOOKUP=0` disables it.
- **Expect more asks** for destinations this machine knows nothing about,
  including `gh --repo` into orgs outside `personalOrgs` and org-level
  `gh api orgs/<org>/…` calls. Those destinations now also get the
  `_private_infra` payload scan that public ones get.

### Fixed — a GraphQL mutation was receipted as the cwd's repository

`gh api graphql` mutations (`enqueuePullRequest(input: {pullRequestId: …})`
and the like) name their target by node id, and the guard fell back to the
cwd's origin — so a mutation against a public repository, issued from a
private checkout, was judged and receipted as the private one (#113).

- A mutation, or a GraphQL document the guard cannot read (stdin, a missing
  file, an unexpanded `$(…)`), resolves to an **UNKNOWN destination**:
  treated as public, so the agent hook asks and the `gh` shim refuses from a
  non-interactive shell. Only a `*` approval covers it, and receipts print
  `UNKNOWN (GRAPHQL MUTATION TARGET NOT RESOLVED, TREATED AS PUBLIC)`.
- Mutations are found by a small GraphQL lexer, not a regex: comments,
  strings and block strings are skipped. Read-only queries are unchanged.
- The suggested `repo-aegis approve '*'` is now quoted; unquoted, the shell
  glob-expands it before repo-aegis sees it.

### Fixed — regular expressions that backtracked on hostile repo content

CodeQL `js/polynomial-redos`. The registry-host scan reads lockfiles,
`.npmrc`, `pip.conf` and Maven settings — repository content, so an
attacker's pull request can shape it. An unterminated `<url>` followed by
50 000 spaces ran for over two minutes before it was stopped. The `#`-comment strip, the pip value capture, the Maven `<url>` pattern and
URL-credential redaction are all linear, with timing tests on each.

### Fixed — smaller hardening

- **File races.** Twenty check-then-act sequences (`existsSync` then
  read or write) are gone: files are opened once and `fstat`ed on the same
  descriptor, created with `wx` where "don't overwrite" matters (the
  registry scaffold, the encryption marker), and appended to where
  "create if missing" is all that was meant (the audit log, the lock file).
- **`repo-aegis-scan` report.** An error message containing `|`, a
  backtick, a backslash or a newline could break the Markdown table row;
  the error cell is now escaped.

### Fixed — a false `PUBLISHED_BODY_MISMATCH` on every newline-terminated body

The PR-body read-back stripped exactly one trailing newline from each side,
on the assumption that GitHub drops the file's final newline. It does not
always: `gh pr create --body-file` stored it, `--jq .body` appended another,
and a byte-identical body was reported as a one-byte mismatch. Trailing
newlines are now ignored on both sides.

### Security — dependencies

- `@hono/node-server` 2.1.1 (transitive, via the MCP SDK):
  GHSA-frvp-7c67-39w9, path traversal in `serve-static` on Windows.
- `brace-expansion` 5.0.12 (development only): GHSA-mh99-v99m-4gvg and
  GHSA-rgw5-rvv9-x895, unbounded-expansion denial of service.

## [0.10.2] - 2026-09-13

### Fixed — a failed push got a `PUBLISHED →` receipt

The PostToolUse receipt decided between `PUBLISHED →` and
`EGRESS FAILED →` by scanning the tool output for failure text and
treating everything else as a publish. Absence of evidence read as
evidence — the silent-skip shape again, and the one error the hook's own
comment says it must never make. Observed on 2026-09-12: a push that died
as `ssh_dispatch_run_fatal: … Broken pipe` was receipted as published.
Two independent reasons it could not have been caught: `\bfatal:` cannot
match `ssh_dispatch_run_fatal:` (`_` is a word character, so there is no
boundary), and the failure patterns are English while git is translated —
on a German machine a failed push says `Schwerwiegend:`, `Fehler:` and
`[zurückgewiesen]`, none of which any pattern covers.

- **Positive evidence is now required wherever the tool emits any.**
  `git push` must show a `<src> -> <dst>` ref line that is not flagged
  `!`, or `Everything up-to-date`; `gh pr create|edit` must show the
  pull-request URL; `gh release create` must show the release URL.
- **A third line, `EGRESS UNCONFIRMED → …`**, for output that proves
  neither — including the transport failure above. It names the
  destination and says plainly that nothing confirms the bytes landed.
- **Read in any locale.** git's flag column (`!` refused, `=` already
  current, `*` created) and the `->` arrow are untranslated, unlike every
  word beside them, so a rejection is recognised as a rejection even when
  the message is not English.
- `fatal:` is matched mid-token, so ssh's `ssh_dispatch_run_fatal:`
  counts; a non-zero `exit_code` on the tool response, where the harness
  supplies one, outranks any text pattern.
- A partly refused push still reads `PUBLISHED` — bytes did reach the
  remote — and now says how many refs were refused. Verbs with no
  distinctive success output (`gh issue create`, mutating `gh api`) keep
  the previous rule; there is nothing to require.

### Fixed — `check --path <dir>` called every readable directory "unreadable"

A directory went straight to the file scanner, which `readFileSync`'d it,
caught the `EISDIR`, and recorded it as `skipped: unreadable`. `--path`
mode is all-or-nothing, so the run then failed closed with
`PATH_NOT_SCANNED … (unreadable)` — the right outcome with the wrong
cause, which sends the operator to look at permissions on something that
was only ever the wrong shape. Found while scanning a folder of files
before publishing them.

- `scanFile` reports a directory as `skipped` reason **`directory`**, and
  an unfollowed symlink as **`symlink`**. Neither is an I/O failure and
  neither is called one now.
- `check --path <dir>` (and the `repo_aegis_check_path` MCP tool) **walks
  the directory**, scanning every regular file through the same `scanFile`
  path as the single-file form — same canonicalisation, working-tree
  check, path exemptions, size cap and binary detection. Lockfile/`.npmrc`
  egress hygiene sweeps the tree too.
- Nothing is hidden to make that cheap. `.git` is the only directory not
  walked (compressed objects no line scan can read; history has
  `--history`) and it is listed in `skippedDirs`. Symlinks are not
  followed and are listed in `skipped`. Files skipped for size or binary
  content are reported as usual and do not fail the run — the rest of the
  tree was read. `--json` adds `filesScanned` so "clean" is never a claim
  without a count behind it; the file form's envelope is unchanged.
- More than `--max-files` (default 10000) exits **2** with
  **`PATH_TOO_MANY_FILES`**. A truncated scan reported as a result is the
  same failure one layer up, so the cap refuses instead of answering
  short. An empty directory is still `PATH_NOT_SCANNED`.

## [0.10.1] - 2026-09-12

### Fixed — an `ask` the `gh` shim cannot back up is now a refusal

The three enforcement layers do not degrade into each other. `PATH` is
per-process, so the `gh` shim reaches only shells started after the
profile line that puts it there — and an agent host that snapshots its
launcher's environment hands every command the `PATH` the launcher had.
In such a shell `gh` runs unshimmed, which leaves the agent hook alone on
rule g, where its answer is `ask`; and an `ask` that no layer beneath it
can enforce is not a refusal at all. Observed on a host whose auto mode
answers an `ask` with a classifier rather than a person: `gh pr create`
against a public repository reached GitHub, while the identical command
with the shim's directory on `PATH` was refused.

- The agent hook now reads its **own** `PATH` — the one its host will
  hand the shell it is about to permit — and a `gh` publishing verb that
  would have been `ask` under rule g is denied with
  **`SHIM_UNREACHABLE_NEEDS_HUMAN`** when the shim is not the first `gh`
  on it. The reason names both fixes: mint an approval
  (`repo-aegis approve <org>/<repo>`) and re-run, or start the agent from
  a shell where the shim comes first (`repo-aegis doctor` says which).
- Scoped deliberately: `git push` is untouched (the pre-push hook is
  `PATH`-independent and already refuses), and so is `npm publish`, which
  has no shim to be unreachable. An approval-backed `allow` and an
  earlier rule's `deny` both survive unchanged, and a `PATH` lookup that
  throws changes nothing — the hook still fails open on its own defects.
  Agents without an `ask` were already denying here.
- `decideEgress` takes `capabilities.ghShimOnPath`; unset means "not
  asked". The predicate is the resolver behind `doctor`'s
  `SHIM_NOT_FIRST`, not a second one that could disagree with it.
- Design: `doc/design/egress-guard.md` §4b (rule g′), with the layer-reach
  table that was the missing half of §3.

## [0.10.0] - 2026-09-12

### Added — human approvals: `repo-aegis approve`

Rule g needs a person, and until now the guard's only test for one was a
TTY — so every publish to a public repository that an agent was asked to
make had to be typed by the operator instead (four terminal round-trips
per release on the first day), while the instruction actually given
("push it") sat in a chat the guard cannot see. And on Claude Code in
auto mode the hook's `ask` never reached the human at all: the auto-mode
classifier answered it, with a refusal.

- **`repo-aegis approve <org>/<repo> | <org>/* | * [--ref <ref>] [--ttl
  15m] [--note …]`** mints a scoped, time-limited approval; `--list` and
  `--revoke <id|all>` manage them. Minting **requires a TTY on stderr and
  does not honour `REPO_AEGIS_EGRESS_HUMAN`**, so an agent cannot mint its
  own (`APPROVE_NEEDS_TTY`). Default 15 minutes, never more than a day.
- Every layer — the agent hook, the `gh` shim, the git pre-push hook —
  treats a matching live approval as "human present" **for rule g only**:
  shape rules, the cross-org boundary and the payload scan still refuse.
  A destination-less verb (`npm publish`) is covered only by `*`.
- Mint, every use (with the layer) and revoke are audit records. The
  agent hook returns an explicit `allow` naming the approval;
  `egress-check` reports `approval: { id, expiresAt }`; the pre-push hook
  prints one line. Rule g's refusal now ends with the exact `approve`
  command to type. Design: `doc/design/egress-guard.md` §4a.
- The managed CLAUDE.md block tells the agent to ask for an approval
  rather than for the human to run the command. (Re-run `install
  claude-md` after an uninstall to refresh an existing block.)

### Fixed — the `gh` shim printed a receipt before `gh` ran

- `egress-check` wrote `PUBLISHED → …` to stderr at decision time, so a
  `gh` that then failed still got a receipt — seen live cutting v0.9.1,
  when `gh release create` returned HTTP 422 under a `PUBLISHED` line.
  The receipt hook's first rule is that a receipt must never claim a
  publish that did not happen; the shim now honours it. `egress-check`
  returns both lines in its verdict (`receipt`, `failedReceipt`) and the
  shim prints exactly one **after** the real `gh` returns, keyed on its
  exit code: `PUBLISHED →` on 0, `EGRESS FAILED →` otherwise. A failed
  `gh pr create|edit` is no longer followed by a read-back (nothing was
  published). `gh`'s own exit code and stderr are unchanged. The smoke
  test gains the failing-`gh` case.
- `doctor` reports **`SHIM_STALE`** when the shim on `PATH` is not the
  script this release generates — the shim's `HOOKS_SCRIPT_STALE`. Fix:
  `repo-aegis install shim`, which rewrites a differing file. **After
  upgrading to this release, run it once.**

## [0.9.1] - 2026-09-12

### Fixed — egress guard: a destination named in full is now judged as itself

Two ways an explicitly named destination was judged from the wrong place,
both found live on 2026-09-12 while merging a PR into a public repository
from a private checkout — the exact shape of the first incident.

- **`gh api` paths were never parsed.** `gh api -X PUT
  repos/<o>/<r>/pulls/<n>/merge` was resolved to the cwd's origin: allowed
  silently from a private checkout, and receipted as `PUBLISHED → <the
  cwd's repo>`. The parser now captures the endpoint positional and the
  resolver reads `repos/<o>/<r>` (and `orgs/<o>` → repo `*`) from it. Paths
  with `{owner}`/`{repo}` placeholders keep resolving from the cwd, which
  is what `gh` does with them.
- **A destination outside the cwd fell open.** Class and visibility live in
  each repository's git config, so `gh … --repo o/r`, a `gh api` path, or
  `git push <url>` from any other directory resolved to "class unknown,
  visibility unknown" and passed. New machine-wide destination cache
  (`$REPO_AEGIS_HOME/destinations.json`, 0600): `<org>/<repo>` → the
  checkout that declares it, followed live. Written by `classify --apply`,
  `status`, `doctor`'s sweep (reported as `destinationsRecorded`) and by
  the guard itself on every command judged from inside a repository.
  Applies to the agent hook, the `gh` shim **and the git pre-push hook**,
  which had the same defect a third time: a push to a URL other than the
  repo's origin was judged by the pushing repo's own class.
- A destination in `personalOrgs` with nothing cached is now treated as
  public-facing (rule g asks; the receipt says `VISIBILITY UNCACHED,
  TREATED AS PUBLIC`) instead of unknown — asking is not blocking, and the
  personal org is where the public repositories live.
- `classify --apply` now caches the visibility it already probed, so
  `classify --apply && status` is one command where the probe resolves.
- Reasons and receipts say where the class came from: `from --repo`,
  `from the API path`, `from the checkout at <path>`. `check --remote-url
  --json` gains `destination.declaredBy` (`origin` | `cache` | `none`).

### Fixed — docs

- The install path now names the `gh` shim. `init` deliberately does
  not write it (it needs a shell-profile edit only the user can make),
  but neither the README quick start nor `doc/agent-install.md` told
  anyone to run `install shim` — so an install that followed the docs
  ended with the pre-push hook and the agent hooks in place and the one
  layer shared by every agent and every human missing, visible only
  through `doctor`. The agent guide gains Step 2b, a three-layer table
  and the `doctor` codes to expect; the quick start gains the two lines.
- `doc/cli-reference.md`: `install shim --uninstall` never removes a
  file repo-aegis did not write (the previous wording implied it did);
  `hook guard-egress` documents the argv-array `command` flattening
  (`["bash", "-lc", "…"]`) and which `cwd` it uses.

## [0.9.0] - 2026-09-12

### Added — the egress guard (destination-aware publishing controls)

Two leaks in one week were one defect (design: `doc/design/egress-guard.md`).
A PR description went to an org-internal customer repository from a body
file that belonged to another project — `$TMPDIR` resolves to two different
directories depending on whether the shell runs sandboxed, and a stale
`pr-body.md` from another session was waiting in the other one. The next
day a bare `git push` at the tail of a compound command whose leading `cd`
had not taken effect ran in the wrong checkout and published a private
in-progress branch to a public remote. Every existing control passed,
correctly: neither incident had unsafe bytes. Both had bytes going to the
wrong place, and the stack had no axis for *where*. The pre-push hook was
even handed the remote URL as `$2` and ignored it.

The fix is mechanical and sits in the command path, because instruction
text does not change the failure rate of attention. **One decision function
in core**, enforced wherever a publishing command must pass:

- **`egress-intent` / `egress-policy` (core).** A quote-aware, operator-
  splitting parser turns a shell command line into the publishing
  operations it carries (`git push`, the mutating `gh` verbs, `npm|pnpm|yarn
  publish`) with the facts the policy needs — remote and refspec, `--repo`,
  payload files, whether an earlier segment was a `cd`, the operator that
  joined the segment, `git -C`. The policy applies rules a–h in a fixed
  order. **Shape rules are unconditional**: a bare `git push`
  (`PUSH_IMPLICIT_TARGET`), egress after `cd` in the same command
  (`EGRESS_AFTER_CD`), egress joined with `;` / `||` / `&`
  (`EGRESS_UNGUARDED_CHAIN`), a payload path that is relative, expands
  `$TMPDIR`, or sits under a mode-dependent temp root
  (`PAYLOAD_MODE_DEPENDENT_PATH`). **Context rules fail open** — a
  guardrail must not block on its own inability to determine context, the
  lesson of the spurious `CROSS_ORG_WRITE` blocks: a destination in a
  disjoint trust boundary (`CROSS_ORG_EGRESS`), a payload matching the
  *destination's* deny set (`PAYLOAD_MARKER_HIT`), and a public destination
  or an irreversible verb with nobody present (`PUBLIC_EGRESS_NEEDS_HUMAN`),
  which `ask`s where the framework can and degrades to `deny` — never to
  `allow` — where it cannot. Destination resolution is offline. Reasons
  name `<org>/<repo>`, visibility, class and ref; never payload content.
  **Decision-only:** no layer rewrites a command, because turning `git
  push` into `git push origin <branch>` silently would rebuild the
  implicit-destination defect one layer up. The two incident commands,
  genericised, are test fixtures.

  One deviation from the design as written: the sandboxed `$TMPDIR` on the
  machine that had both incidents is `/tmp/claude-<uid>`, the parent of the
  agent's session scratchpad — the one place the design tells agents to
  put payloads. Rule d therefore exempts a session-unique `…/scratchpad/`
  segment under that root and refuses everything else there.

- **Git pre-push: `check --remote-url <url>`.** The generated pre-push
  template passes git's `$2` through. `check` parses it and, before the
  content scan, refuses a push into an org disjoint from the repo's trust
  boundary (`CROSS_ORG_PUSH`, deterministic, offline) and a push to a
  public-facing repo from a shell with no TTY on stderr
  (`PUBLIC_PUSH_NEEDS_HUMAN`), unless a human sets
  `REPO_AEGIS_EGRESS_HUMAN=1` for that one invocation — the same contract
  as `REPO_AEGIS_WAIVE_NONINTERACTIVE`: documented human-only, a visible
  act in any transcript. Otherwise it prints the git-native receipt,
  `repo-aegis: pushing <ref> → <org>/<repo> (<visibility>)`. The template
  digest changes, so installed copies report `HOOKS_SCRIPT_STALE` until
  `install hooks` is re-run. This is the layer that reaches every agent
  and every terminal, because git is the one choke point every push passes
  through — and it is inert until a repo is classified and its visibility
  cached, which is why `doctor` now says so.

- **A `gh` shim on `PATH`: `install shim`, `egress-check`,
  `egress-readback`.** Nothing chokes `gh` the way pre-push chokes `git`,
  so `install shim` writes `<home>/bin/gh`, a wrapper that passes reads
  through untouched and runs `repo-aegis egress-check` for the publishing
  verbs — with `capabilities.ask = false`, since a shell has no prompt to
  offer. After a permitted `gh pr create|edit --body-file`, the shim runs
  the real `gh`, then reads the live body back and diffs it against the
  file: `PUBLISHED_BODY_MISMATCH` with byte counts, never content. That
  read-back is the design's one deliberate network call on an enforcement
  path: the verb has already published, so it cannot block, and a wrong
  body found in seconds is a 57-minute exposure not had. `uninstall`
  removes the shim; the shim never resolves to itself.

- **Agent pre-command hooks: `hook guard-egress [--agent claude|codex|gemini]`
  and `hook egress-receipt`.** Registered by `install claude-md` on
  `PreToolUse(Bash)` / `PostToolUse(Bash)`; equivalent snippets for Codex
  CLI and Gemini CLI are in `doc/agent-install.md`. This is the only layer
  that sees the *whole* compound command before anything executes, so it
  is where the shape rules live, and on Claude Code it can return
  `permissionDecision: "ask"`, which forces a human prompt even under
  auto-mode — a guardrail written in prose becoming one that exists. After
  a permitted publish the receipt hook returns one line as
  `additionalContext`: `PUBLISHED → <org>/<repo> (<VISIBILITY>, class
  <class>): <ref | PR #n>`. A model will skim past twenty lines of git
  output; it will not skim past one line that says PUBLIC and a name it
  did not intend. The hook never emits `updatedInput` — a test serialises
  every output the hook can produce and asserts the string is absent.

- **`selfIdentity` — the inverse direction.** Engagement markers stop
  *customer* strings entering *our* repos. The first incident was *our*
  strings entering a *customer's* repository, the direction with the
  business cost. A new registry list renders to the reserved
  `_self_identity` stem and joins the deny set **only** for
  `customer-coupled` repos — and, through the egress guard, customer-
  coupled destinations, which the guard infers from the registry when the
  target org is in an engagement's `githubOrgs`, whatever directory the
  command runs from — exactly as `_private_infra` joins only for
  public-facing ones; excluded from the flat `markers.txt` for the same
  reason; part of the deny-set cache key. `scan-env --self` offers the
  operator's own org names, package names under the scan root, and the
  agent session-link shape as candidates, dry-run by default.

- **`doctor` reports the preconditions.** On the machine that had both
  incidents, the public repository involved had no explicit class and no
  cached visibility, because its org was not in `personalOrgs`; every
  destination-aware rule would have been silent. `doctor` now checks
  `push.default` (`PUSH_DEFAULT_IMPLICIT` — the single cheapest line in the
  design: `git config --global push.default nothing` makes a bare push an
  error in every shell, for every agent and every human, with no
  repo-aegis involvement), the shim (`SHIM_MISSING` / `SHIM_NOT_FIRST`),
  the guard hook (`GUARD_HOOK_UNREGISTERED`), and per repo
  `CLASS_VISIBILITY_UNRESOLVED` and `PERSONAL_ORG_UNREGISTERED`.
  `--no-egress-checks` restores the hook-liveness-only sweep.

Not built: the server-side `audit --pr-body` Action mode (the design's
Phase 4). Not defeated, by construction: `--no-verify`, `-c
core.hooksPath=…`, calling the real `gh` by absolute path — client-side
controls are advisory; these layers add friction and make bypass a
visible, auditable act.

### Fixed

- **The pre-push hook never chained to a repo's own `pre-push` on macOS.**
  The chaining branch called `mktemp` with no template; BSD `mktemp`
  requires one and prints nothing without it, the `|| true` hid the usage
  error, and the empty-string guard fell through to a plain exit — so a
  hook a human or another tool had installed into `.git/hooks` was silently
  skipped on every push since the v0.7 global-`core.hooksPath` default. Found
  by the `gh` shim's smoke test, which made the same mistake and caught it.
  The template now names one; a script-level test runs the real hook in a
  real repo against a chained hook that records what it receives.

Three silent skips found while classifying ~90 repos on a machine with two
`gh` accounts (#97). Each made a control believe less than it should without
saying so, which is the one failure mode a leak-prevention tool cannot have.

- **The visibility probe collapsed every failure into `unknown`.** `gh` not
  installed, no GitHub remote, and — the dangerous one — `gh` running under an
  account with no access to the org all produced the same answer. On a
  two-account machine the third is routine: every public repo resolves and
  every *private* repo 404s, so a whole org's private repos sat at whatever
  class had been guessed for them with no visibility to contradict it.
  `probeGithubVisibility` now returns a status (`resolved` / `no-gh` /
  `no-remote` / `unauthorized` / `unrecognised`) with a fixed explanation and,
  where one exists, a fix. `status` reports it in JSON as `visibilityProbe`,
  puts it on the `github:` line, and warns whenever the probe could not see a
  repo — including when a cached value still answered, because a stale cache
  plus a blind probe is exactly how a repo keeps the wrong class.

  The probe deliberately does **not** echo `gh`'s stderr: that text carries the
  org and repo name, which in this tool's threat model may itself be the
  customer marker being kept out of logs.

- **`classify` gave every `personalOrgs` repo `public-eligible` regardless of
  its actual visibility.** `isPublicFacing` treats that class as public-facing,
  so a *private* repo classified this way starts refusing its own legitimate
  private-infra hosts. A `personalOrgs` match is a statement about the org, not
  the repo, so `classify` now probes: `public` → `public-eligible`, private or
  internal → `private-strict` (with a warning that it differed). When the probe
  cannot resolve visibility, `--apply` **refuses** with exit 2 and
  `VISIBILITY_UNRESOLVED` rather than guessing — `public-eligible` on a private
  repo causes false positives, but `private-strict` on a public repo switches
  egress enforcement *off*, and neither is a coin flip worth taking silently.
  A dry run reports the same state and suggests no class. Engagement matches
  and `classify.yml` rules are unaffected; they do not depend on visibility.

- **`check --cwd <repo> --path <relative>` scanned nothing and reported a
  pass.** The relative path resolved against the process cwd, missed, and was
  reported as `skipped: [{reason: "unreadable"}]` alongside `hits: []` and exit
  0 — indistinguishable from a clean scan unless you thought to read `skipped`.
  Relative paths now resolve against the repo under test (new
  `resolveScanTarget` in core, shared with the egress sweep that already did
  this), and because the requested path *is* the whole scope of `--path` mode,
  a skip is now a hard error (`PATH_NOT_SCANNED`, exit 2) — matching how every
  git-backed mode already fails closed. The same defect and the same fix apply
  to the `repo_aegis_check_path` MCP tool, where an empty `hits` list reads to
  an agent as "this file is clean".

### Added

- **repo-aegis runs its own generated gate.** `.github/workflows/leak-scan.yml`
  and `leak-scan-strict.yml`, installed byte-for-byte from
  `install ci --profile all --no-require-deny-set` and pinned to 0.8.2 — the
  first release whose CLI declares every flag the templates use. Installing
  them against 0.8.1 is what surfaced the ordering constraint recorded below.

  `--no-require-deny-set` is the only correct setting here, not a weakening:
  this repo is `public-eligible`, so *every* engagement is blocked and its deny
  set is the full customer-marker set — the one thing that must never reach a
  public runner. The marker scan therefore reports `skipped: empty deny set`,
  and what does real work is the deny-set-independent half (private-registry
  egress over the lockfile, visibility, remote-vs-class consistency).

## [0.8.2] - 2026-08-08

Found by finally installing the generated workflow into this repo and running
it. The project had been shipping a CI gate it did not run on itself, and three
of the four generated jobs had never worked.

### Fixed

- **The generated `pr` workflow passed `--no-history`, which the CLI does not
  declare.** `audit` has `--history` (off by default); Commander only
  auto-generates a `--no-x` negation for options declared with one, so it
  exited 1 with `unknown option` before scanning anything. Both `pr`-profile
  audit jobs were affected, and had been since at least 0.7.x. The flag was
  only ever expressing a default, so it is simply gone.

- **The generated `strict` and `config-guard` jobs passed `--ignore-waivers`
  and `--ignore-allowlist-comments` to `audit`, which declared neither.** Same
  `unknown option` exit. The `strict` profile — whose entire purpose is showing
  what the day-to-day gate suppresses — had therefore never run at all.

- **New: `--ignore-allowlist-comments` on `audit`.** `audit` respects
  `repo-aegis: allow` comments by default, so the strict profile needed this
  implemented rather than deleted. There is deliberately **no**
  `--ignore-waivers` counterpart: `audit` never applies waivers in the first
  place (unlike `check`), so it is already strict there, and a flag to disable
  something never applied would be a lie in `--help`.

- **A test that the generated workflows are commands the CLI would accept.**
  Nothing caught the above because the templates are strings: the flag-name
  contract test pins what the CLI *accepts*, and the workflow-hygiene script
  lints YAML shape, but neither checked that what we *generate* parses. The new
  test extracts every `repo-aegis` invocation from every generated template and
  validates each flag against `buildProgram()`. Verified by reintroducing
  `--no-history` and watching it fail.

### Added

- **`install ci --no-require-deny-set`**, emitting `--min-patterns 0` instead
  of `--require-deny-set`. The default is right whenever the registry is meant
  to be reachable from CI. But a `public-eligible` repo blocks *every*
  engagement, so its deny set is the full customer-marker set — exactly what
  must never reach a public runner. There the fail-closed flag does not catch a
  misconfiguration, it fails every run, which is why the generated workflow was
  unusable for that whole class of repo (this one included). With the opt-out
  the marker scan reports `skipped: empty deny set` and the deny-set-independent
  checks still do real work.

### Note for anyone changing a template

**A generated template may only use flags present in the version it pins.**
`install ci` embeds the generating CLI's own version in the install step, which
is what stops a compromised publish from reaching every consumer's gate. For a
consumer that is always self-consistent: they generate with a released CLI, and
the template uses that release's flags.

It is *not* self-consistent when generating from an unreleased working tree —
i.e. in this repo. Installing the workflows in the same change that added
`--ignore-allowlist-comments` produced a file pinning the last release and
calling a flag that release does not have, and `config-guard` failed with
`unknown option`. The order therefore has to be: land the CLI change, release
it, then regenerate. That is why the self-hosted workflows are not in this
entry — they follow once these flags exist in a published version.

## [0.8.1] - 2026-08-08

Follow-up to 0.8.0, from watching its own publish run. The tarball gate
0.8.0 added reported `ok: true` after matching **zero** patterns — the exact
failure mode that release set out to remove, in the release's own new gate.

### Fixed

- **`audit --published` reported a vacuous scan as a clean one.** The check
  matches archive contents against the engagement deny set, and the engagement
  registry is machine-local by design — it holds customer markers, which is
  precisely what must never reach a public CI runner. A publish workflow
  scanning its own tarball therefore has **zero** deny-set patterns, and the
  marker pass matched nothing while the check still reported `ok: true` with no
  findings. `--min-patterns` is the wrong instrument here (raising the floor
  would fail every publish, since an empty deny set is legitimate in CI), so
  the check now emits an **informational** `PUBLISHED_EMPTY_DENY_SET` finding.
  It does not fail the check; it makes "matched against nothing" and "matched
  clean" render differently, which is the same principle the deny-set floor
  enforces elsewhere.

- **The secret-shape detector matched its own documentation.** A comment in
  `secret-markers.ts` spelled out the hex encoding of a PEM header as one
  contiguous literal, which its own `PEM_AS_HEX` pattern then matched — so
  `repo-aegis-core`'s tarball flagged itself under the new scan below. The
  byte values are now written spaced. Caught by scanning the real 0.8.0
  tarballs before wiring the check in, not after.

### Added

- **A universal secret-shape pass over `--published` archive contents**
  (PEM private-key headers, the hex-encoded form, JWTs, forge tokens), on by
  default, opt out with `--no-secret-scan`. This needs no registry, so unlike
  the marker pass it still does real work in CI — it covers the threat that
  actually applies to a registry tarball: a key or token that reached the
  archive through build output or `files`/`.npmignore` drift rather than
  through a tracked source file the hooks already cover.

  **This may newly fail a publish** for packages that legitimately ship
  secret-shaped example strings (a documented JWT in a README, a sample PEM in
  a fixture that is not excluded from the tarball). Pass `--no-secret-scan` to
  opt out, or exclude the file from the package.

  Findings report kind, path and count and **never the matched bytes** —
  `scanForSecrets` returns only kind/offset/length by construction — so they
  are safe to print in a public job log. Asserted by a test that greps the
  whole serialised payload rather than selected fields.

## [0.8.0] - 2026-08-08

CI hardening. The client-side gate is advisory by construction — `--no-verify`
bypasses it, a fresh clone has no hooks, and `check --push-ref` reads
remote-tracking refs a hook can never refresh. This release builds out the
server-side half, and fixes four defects found in artefacts repo-aegis was
already shipping.

Design record, including the security review that reshaped the plan before
implementation: [`doc/plan-ci-hardening.md`](doc/plan-ci-hardening.md).

### Changed — behaviour

- **The GitHub Action now fails closed on an empty deny set.** The new
  `require-deny-set` input defaults to `'true'`. Previously, a registry that
  failed to load produced a deny set with zero patterns, a scan that matched
  nothing, and exit 0 — a green check indistinguishable from a real pass. That
  happens on a fork PR (secrets are not exposed to `pull_request` runs from
  forks), a renamed or rotated secret, and a `registry` input pointing at a
  path that does not exist.

  **This will newly fail** for `scratch`-class repos and OSS repos with no
  markers of their own. Set `require-deny-set: 'false'` (or `--min-patterns 0`)
  if you intend a repo to be scanned with no deny set. Exit code is **2**, not
  1: "the gate could not run" is a different fact from "the gate found
  something", and conflating them is what let a broken gate look like a passing
  one.

- **The GitHub Action now redacts engagement attribution by default**
  (`redact-attribution`, default `'true'`). Output keeps file, line, column,
  the redacted preview, `_always` pattern ids, and an `engagementsAffected`
  count; it drops engagement ids and engagement-derived pattern ids. Anything
  the action emits can reach a job log, a step output, or a PR comment, all of
  which are world-readable on a public repo — and an engagement id is usually
  the customer's name.

- **The Action's `version` input no longer defaults to `latest`.** It defaults
  to the version the action shipped with. A compromised npm publish would
  otherwise reach every consumer's gate on their next run. Pass `latest`
  explicitly to opt back into floating.

### Deprecated

- **The Action's `hits-json` output** — use `results-file` instead, which is a
  path to the JSON under `RUNNER_TEMP`. Removal in 0.9.0. Scan output contains
  repo-derived file paths, and interpolating it into a `run:` block lets a path
  containing a quote close the quoting and execute the remainder. Reading a
  file has no such property. `hits-json` remains populated for one minor
  version, now with a randomised heredoc delimiter.

### Added

- **`--min-patterns <n>` / `--require-deny-set` on `check` and `audit`**
  (env: `REPO_AEGIS_MIN_PATTERNS`). Exit 2 when the computed deny set is
  smaller than the floor. Enforced in the CLI where the size is computed, so
  local runs, the MCP server, and scheduled sweeps inherit it — and checked
  before `check`'s `no-deny-set` early return, which is the exact outcome it
  exists to reject.
- **`--redact-attribution` on `check` and `audit`** (env:
  `REPO_AEGIS_REDACT_ATTRIBUTION`). Off locally, where attribution is the most
  useful field on the line and the terminal is not a publication channel.
- **`denySet` in `audit --json`**, mirroring `status` and `check`. Without it a
  consumer could not distinguish "audit passed" from "audit had nothing to
  scan".
- **`repo-aegis install ci --profile <pr|strict|all>`.** `pr` is the previous
  workflow, substantially hardened and extended with two jobs: `new-ref-scan`
  (`check --push-ref` on tag pushes, where remote refs are authoritative rather
  than possibly-stale as in a local hook) and `config-guard` (re-runs with
  `--ignore-waivers` when a PR modifies `.repo-aegis.yml` or the workflow
  itself). `strict` is new: a weekly audit with waivers and allow-comments
  ignored, filing findings as a tracked issue — the PR gate must honour
  suppressions to be usable, which is what makes suppression creep invisible.
- **`REPO_AEGIS_ASSUME_PUBLIC=1`** — assert public visibility so the
  private-registry egress check works on a fresh CI checkout, which has no
  cached `repo-aegis.visibility`. Deliberately one-directional: there is no
  counterpart that asserts "private", because an env var that switches findings
  *off* is a waiver nobody reviewed.
- **`de-otio/repo-aegis/actions/scan`** — the Layer-2 sweep as a composite
  Action (age-decrypt queries into `RUNNER_TEMP`, run, file an issue), with
  reference workflows in `examples/scheduled-sweep.yml` and
  `examples/org-sweep.yml`. Deployment guidance stays private-repo-first: the
  query strings *are* the customer markers.
- **`audit --published` gate in this repo's own `publish.yml`** — packs once,
  scans that artifact with the just-built CLI, and publishes the same bytes. A
  tracked-file scan does not cover `files`/`.npmignore` drift, build output, or
  stray fixtures.
- **Workflow linting in CI** — actionlint, zizmor, and
  `tests/workflow-hygiene.mjs` (no `${{ }}` inside `run:`, every job has
  `timeout-minutes`, every third-party `uses:` is SHA-pinned), applied to the
  generated templates as well as the checked-in files.

### Fixed

- **Script injection in the documented consumer snippet.** `doc/github-action.md`
  showed `echo '${{ steps.scan.outputs.hits-json }}'` inside a `run:` block.
  GitHub splices the expression in before the shell parses it, so a
  repo-derived path containing a quote closes the quoting and the rest is
  executed. The example workflow did it correctly via `env:`; the doc did not.
- **The Action installed the CLI from inside the consumer's checkout.** npm
  reads `./.npmrc` from the working directory, so a PR-supplied `.npmrc` could
  repoint the registry and substitute the package, whose install scripts would
  then run in the job. Now installed from `${{ runner.temp }}` with
  `--ignore-scripts` and an explicit `--registry`. Low impact under
  `pull_request` (read-only token, no secrets) — but it was the precondition
  that would have made any secret-bearing trigger dangerous.
- **The generated CI workflow was two years stale.** It emitted
  `actions/checkout@v4`, `actions/setup-node@v4`, Node 20, no
  `timeout-minutes`, and an unpinned global install, while `action.yml` in the
  same repo used Node 24 — and repo-aegis shipped the stale one into every
  consumer repo. Now SHA-pinned to node24 runtimes, timeout-bounded, with a
  `dependabot.yml` fragment printed so the pins do not rot.
- **The lockfile/egress check was disabled in the generated workflow.** It is
  now on, paired with `REPO_AEGIS_ASSUME_PUBLIC` so it decides correctly on a
  fresh checkout. The generated workflow also triggers on `public:`, which
  GitHub fires the moment a repo flips private → public.
- **Fixed `GITHUB_OUTPUT` heredoc delimiter** in the Action. Not exploitable —
  `emitJson` pretty-prints, so every string value is indented and cannot match
  the delimiter at column 0 — but that is a property of the formatter, not a
  guarantee. Now randomised.
- **`persist-credentials: false`** on every checkout in this repo's workflows,
  and `security-events: write` in `codeql.yml` narrowed from the workflow to
  the job that uses it.

## [0.7.1] - 2026-07-27

### Fixed

- **`doctor` reported a healthy repo as failing, forever.** A repo-local
  `pre-commit` or `pre-push` displaced by `core.hooksPath` was counted as
  bypassed — but since 0.7.0 the generated scripts *chain* to exactly those
  hooks, so they do still run. On a fleet whose only repo-local hook was a
  `pre-commit`, `doctor` exited 1 on every sweep with nothing wrong. It now
  distinguishes the two: `HookState.shadowedRepoHooks` remains the raw
  observation (every displaced script), and the new
  `HookState.bypassedRepoHooks` is the actionable subset — hook types
  repo-aegis does not install and therefore cannot chain (`commit-msg`,
  `post-merge`, …). `doctor` and `status` report and fail on the latter only.
  A guard that fires when nothing is wrong is the failure mode 0.7.0 set out
  to remove; this was an instance of it shipped in the same release.

### Added

- **Self-hygiene now checks for vendor-shaped credentials in this project's
  own source.** 0.7.0's release push was rejected by GitHub secret scanning
  over a Stripe-shaped literal in a test fixture — synthetic, but live-shaped,
  and repo-aegis's own guards had no opinion about it: the deny set covers
  customer markers, and `scanForSecrets` runs only over Bash tool output.
  Neither polices this repo. `self-hygiene.test.ts` now scans tracked source
  for Stripe / GitHub / AWS / Slack / Google / npm key shapes and PEM blocks
  *with key material*, so the next one fails at commit time rather than at a
  push that has already been attempted. Bare PEM headers and regex sources
  describing these shapes are deliberately not flagged — both appear
  legitimately in this repo, and a check that cries wolf gets disabled.

## [0.7.0] - 2026-07-27

### Fixed

- **Renamed files bypassed the scanner — read this if you maintain a repo
  older than this release.** `check --staged` and `check --range` passed
  `--diff-filter=ACM` to git, which excludes rename (`R`) diff entries. Git
  turns on rename detection by default, so `git mv` a file and add a marker
  to it in the same commit or push, and the pre-commit/pre-push hook reported
  "clean" — the content change was real but the diff filter never handed it
  to the scanner. Filter is now `ACMR`. **This means any history committed
  before this release may contain a rename-carried marker that was never
  scanned**, regardless of how clean prior `check`/`audit` runs looked.
  Remediate with a one-off full sweep: `repo-aegis audit --history`.
- **`scanHistory` and the `check` git helpers now fail closed.**
  `scanHistory` previously caught any git failure and returned `[]` — i.e.
  reported "clean" — which is a scanner failure disguised as a clean scan,
  the worst possible failure mode for a tool whose entire job is catching a
  leak before it lands. It now throws the new `GitCommandError`, which
  `check` surfaces as exit 2 rather than exit 0. The same fail-closed
  treatment now applies to the `--staged`/`--range` git helpers and to
  `check.ts`'s egress-scan git plumbing: a failed `git show` can no longer
  silently drop a file from the scan.

### Added

- **`check --push-ref <ref> --remote <name>`.** New scan mode for a ref the
  remote has never seen — the pre-push hook's zero-remote-sha case, which
  covers release tags and new branches. Previously this degraded to a
  full-history scan, which blocked releases on historical, already-pushed,
  benign matches (the tag-push false-positive). It now derives a diff base
  from the remote-tracking refs: nothing new to scan → no scan at all and no
  diff spawned (`repo-aegis: nothing new to scan (ref already reachable from
  <remote>)`); exactly one new boundary → an incremental diff from that
  point; several boundaries (e.g. a merge of two already-pushed lines) →
  widened via an octopus merge-base, which over-scans rather than
  under-scans; no remote-tracking refs at all → the old full-history
  behaviour, unchanged. Escape hatch: `REPO_AEGIS_NEW_REF_FULL_SCAN=1` forces
  full-history unconditionally. The generated pre-push hook now uses this
  mode automatically. **Residual risk, stated plainly:** the base is derived
  from remote-tracking refs, which a hook never refreshes (no network in a
  hook, by design). A stale-*behind* tracking ref causes over-scanning
  (safe); a stale-*ahead* tracking ref — possible after a server-side
  force-push or branch deletion — could under-scan. Server-side push
  protection remains the only non-advisory backstop for that case.
- **Path-scoped exemptions for `_always`-class findings, and `_always`
  only.** A secret *shape* (an `_always` pattern) can have a genuinely benign
  home — a test fixture, a fixture directory — and firing there is pure
  noise that trains people to reach for `--no-verify`. New optional
  `alwaysBlockExemptPaths: string[]` key, settable in the registry
  (`engagements.yaml`, machine-wide) and additively in a repo's
  `.repo-aegis.yml`. Built-in default when the registry omits the key:
  `**/test/**`, `**/tests/**`, `**/__tests__/**`, `**/__fixtures__/**`,
  `**/fixtures/**`, `**/testdata/**`, `**/*.test.*`, `**/*.spec.*`,
  `**/*.fixture.*`. A glob that matches everything (`*`, `**`, `**/*`) is
  rejected at load as a config error. **Engagement markers and
  `_private_infra` are never path-exempt, under any configuration** — a
  customer name typed into a test fixture is still a leak; only generic
  secret shapes are ever exemptible. `audit --fixture-check` still runs the
  full, unexempted pattern set and demotes an exempt-path `_always` hit to
  an informational finding rather than dropping it, so an exemption stays
  visible on audit even though `check` doesn't block on it.
- **`repo-aegis waive`.** A reviewed-benign escape hatch for a genuine
  `_always` false positive, scoped far more narrowly than `--no-verify`:
  `waive --pattern <id> --blob <sha> --reason <text> --approver <name>
  [--expires YYYY-MM-DD]`, plus `waive --list` and `waive --remove --pattern
  <id> --blob <sha>`. Waivers live under a new `waivers:` key in
  `.repo-aegis.yml` — committed, reviewable, diffable. A waiver is keyed on
  `(pattern id, blob sha)`, not path or line: it survives history rewrites
  and covers exactly the bytes that were reviewed, so a new key landing in a
  new blob is not silently covered by an old approval. Pattern ids
  (`<stem>/<12-hex>`, a truncated sha256 of the pattern) are shown in every
  `check` finding, so a waiver command is copy-pasteable straight out of a
  failure. Only `_always` patterns are waivable — `waive` on any other
  pattern is refused — for two reasons: it must never become a way to
  weaken the customer-marker deny set, and a pattern's digest, once
  committed to a public repo, is an offline oracle for guessing the literal
  it was derived from; a generic secret-shape digest gives an attacker
  nothing, an engagement-marker digest would give them a starting point.
  Because `.repo-aegis.yml` is a file inside the repo, an agent blocked by a
  real finding could otherwise write itself a waiver and retry —
  reconstructing `--no-verify` with extra steps. Three independent controls
  close that off, and all three are required: the existing PreToolUse
  `hook check-write` gate now refuses an agent `Write`/`Edit`/`MultiEdit` to
  `.repo-aegis.yml` outright; `waive` itself refuses to run when stdin is
  not a TTY unless `REPO_AEGIS_WAIVE_NONINTERACTIVE=1` is set; and `check`
  always reports `waived: N` (JSON: the full list), on every run, so a
  waiver can never disappear a finding silently. `check --ignore-waivers`
  re-enables audit-grade strictness for a run that must not honour any
  waiver.
- **Built-in recognition of documented example/placeholder credentials.**
  An `_always`-class match is no longer treated as a finding when it's
  shaped like a documented example — an AWS-access-key-shaped token whose
  body ends in `EXAMPLE`, or a value ending in `REDACTED`/`CHANGEME`/
  `XXXXXXXX`, or matching the `YOUR-…-HERE` scaffolding placeholder shape.
  Scoped to `_always` only — never to engagement or `_private_infra`
  markers, and never to a match that merely *contains* one of these words
  mid-string. Suppressions are counted and reported, never silent. Scope
  limit, stated deliberately: the scanner is line-oriented, so multi-line
  PEM-body recognition (e.g. the RFC example keys) is out of scope for now
  and would need block-aware matching this release doesn't add.
- **Hook liveness checking (`status`, `audit`, `doctor`).** Nothing
  previously verified that an installed hook was actually wired up — a
  stale or shadowed `core.hooksPath` fails exactly like a clean repo: no
  hook fires, no error, no signal. `status` gains a `hooks:` line (and a
  `hooks` object in `--json`); `audit` gains a `hooks` check, skippable with
  `--no-hooks-check` (the generated CI workflow now always sets this, since
  a GitHub-hosted runner never has hooks installed and the check would fail
  and get muted on every run). Stable codes for scripting: `HOOKS_OK`,
  `HOOKS_PATH_UNSET`, `HOOKS_PATH_FOREIGN`, `HOOKS_PATH_LOCAL_OVERRIDE`,
  `HOOKS_SCRIPT_MISSING`, `HOOKS_SCRIPT_NOT_EXECUTABLE`,
  `HOOKS_SCRIPT_STALE`. Motivation stated plainly: a tool whose entire value
  proposition is a pre-commit gate had never verified that the gate was
  connected, and an absent guard looks identical to a clean run.
- **`repo-aegis doctor [--scan-root <dir>...] [--fix] [--yes]`.**
  Fleet-wide hook-liveness sweep: walks every repo under the given roots
  (or the default scan roots) and reports every one whose effective hooks
  path isn't repo-aegis's, plus every repo whose own `.git/hooks` scripts
  are being shadowed by a `core.hooksPath`. Exits 1 if any repo fails.
  `--fix` is dry-run by default, matching `uninstall sweep-repos`'s
  convention; `--yes` applies it. Before mutating anything, `doctor` records
  the prior `core.hooksPath` value and the config file's mtime to the audit
  log, because a repair that runs before the forensics are captured erases
  the only evidence of when the drift happened.
- **"Already public" findings on a full-history scan of a public-facing
  repo now warn instead of block.** A history hit is marked `alreadyPublic`
  when its commit is already reachable from a remote-tracking ref, and is
  downgraded from a blocking hit to a surfaced, logged warning (exit 0)
  — but *only* for a genuine full-history scan (`--history`, or
  `--push-ref`'s full-history fallback) on a public-facing repo. A
  first-time addition of the same shape via `--staged` or `--range` still
  blocks, unconditionally; this downgrade never applies there. Mostly
  subsumed by the new `--push-ref` incremental scanning above — once a new
  ref scans incrementally, "I already pushed this to `main`, now I'm
  tagging it" never reaches a full-history scan in the first place.
- `status`, `audit`, and `doctor` now append an `observe-hooks` record
  (state + code, no paths beyond the hooks directory) to the operator audit
  log on every run, when the log is enabled. Cheap, and it's what gives a
  future hook-state regression a timestamp — the audit log is off by
  default, so `repo-aegis audit-log on` is what actually buys the timeline.

### Changed

- **`install hooks` now writes the GLOBAL `core.hooksPath` by default**
  (was: repo-local). Coverage used to be per-repo and opt-in at install
  time, with a stale local value silently beating a correct global one and
  no way to tell. `--local` restores the previous per-repo-only behaviour.
  New `--unset-local` clears a repo-local value that would otherwise shadow
  the global one just installed, in one step. `install hooks --uninstall`
  now clears **both** scopes and reports each — it previously cleared
  whichever scope git found first, which is the same silent-shadowing
  failure mode this release closes elsewhere. `init` inherits the new
  default, so a fresh `init` now enables hook coverage machine-wide, not
  just for the repo it ran in. **Because git consults exactly one hooks
  directory**, the generated `pre-commit`/`pre-push` scripts now chain to a
  repo's own pre-existing `.git/hooks/<name>` after the repo-aegis check
  runs (if one exists and is executable) — otherwise a global
  `core.hooksPath` would silently disable any hook another tool installed
  directly into a repo's `.git/hooks`. A repo-aegis hit still blocks
  regardless of what the chained hook returns.

## [0.6.0] - 2026-07-22

### Added

- **`repo-aegis scan-env`: turn this machine's toolchain config into markers.**
  Parses `~/.npmrc`, `pip.conf`, `~/.docker/config.json`, `~/.m2/settings.xml`,
  `~/.cargo/config.toml`, and `~/.yarnrc.yml` (plus project-level equivalents)
  for private package-registry hosts and offers them as marker patterns. Where
  the egress check catches a private host that already reached a lockfile, this
  addresses the upstream cause — the config that puts it there — so the deny set
  becomes self-maintaining with no per-customer enumeration.
  - **Dry-run by default.** Nothing is written without an explicit
    `--accept <placement>`.
  - Three placements: `private-infra` (recommended), `always-block`, or
    `engagement --engagement <id>`.
  - **Hosts only, never secrets.** These files are full of auth tokens; every
    parser extracts a hostname and nothing else, and no code path persists a
    credential. Public registries (npmjs, PyPI, crates.io, …) are filtered out —
    blocking them would break every project.
  - Hosts become escaped, case-insensitive literals; hosts shorter than
    `MIN_ENV_HOST_LENGTH` are skipped to avoid false positives.
- **New `privateInfra:` registry list and the class-gated `_private_infra`
  marker stem.** Unlike every other marker file, it joins the deny set only in
  **public-facing** repos: a private-registry host is legitimate — often
  required — in a private repo, so blocking it everywhere would make the tool
  unusable exactly where those hosts belong. This is why it is neither
  `always_block` (everywhere) nor engagement-scoped (a machine's infra usually
  maps to no single customer). It is deliberately excluded from the flat
  back-compat `markers.txt`, whose consumers have no notion of repo class.
- The deny-set cache key now includes the public-facing determination, so a repo
  becoming public cannot be served a stale, under-blocking cached set. Cache
  schema version bumped 3 → 4 to invalidate 0.5.x caches on upgrade.

- **Egress hygiene now covers the pip and cargo ecosystems.** `Cargo.lock`
  (`source = "registry+…"` / `"sparse+…"`, prefix-stripped before host
  extraction), `poetry.lock` (`[package.source] url`), `Pipfile.lock`
  (`_meta.sources[].url`), and `requirements*.txt` (`--index-url` /
  `--extra-index-url` / `-i` / `--find-links` — the pip analogue of a private
  `.npmrc`). `pypi.org`, `files.pythonhosted.org`, `crates.io`, and
  `static.crates.io` join the default public host set. Credentials embedded in
  an index URL are redacted; only the host is reported. `requirements` is a new
  `RegistryFinding.kind`. Lockfiles are parsed line-wise rather than with a new
  TOML dependency — the fields needed are single-line quoted strings, and a tool
  that exists to protect a supply chain should not widen its own. `go.sum` stays
  out of scope by design: Go's proxy lives in `GOPROXY`, not the file.

- **Configurable public-registry allowlist for the egress-hygiene check.** A new
  optional top-level `publicRegistries:` list in the engagement registry extends
  the built-in public set (npmjs, yarnpkg, `*.github.com`), so a team running a
  legitimate mirror can allow it instead of disabling the check. Entries are bare
  hosts (optionally `:port`), validated against the WHATWG URL parser — a scheme,
  path, credentials, or `*` wildcard is a parse error rather than a silently
  inert entry, since matching is exact equality against `URL.host`. The list is
  org-wide (registry) rather than per-repo, so a checked-in `.repo-aegis.yml`
  cannot whitelist a private host into a public repo. Loading is fail-soft: a
  missing, encrypted, or malformed registry falls back to the defaults, which is
  the *smallest* allowlist and therefore never weakens the check.

### Fixed

- **Tests no longer inherit the developer's global git config.** The ~34 test
  files that run `git init` picked up the machine's real `core.hooksPath`, so
  anyone with repo-aegis installed saw `install-hooks` tests fail (the tool
  correctly detecting a conflicting hooks path) and `audit` tests fail (the real
  pre-commit hook blocking the temp repos' commits). The npm test scripts now
  null `GIT_CONFIG_GLOBAL` / `GIT_CONFIG_SYSTEM`; a new `test:file` script runs
  a single file with the same isolation. This mattered beyond convenience: a
  suite that cannot run clean is a suite whose failures get skimmed, which is
  how a real account id and a NUL byte reached a public repo.
- Registered `scan-env` in the CLI flag-name contract test.

### Changed

- **Published tarballs no longer contain test files** (`!**/*.test.*`). A
  `.test.ts` fixture is what shipped a real account id to the registry in
  0.5.0; `core`/`llm` still ship `src` so consumer "go to definition" keeps
  working through the declaration maps, but the tests — and their fixtures —
  stay out. Nothing is lost for consumers: `exports` only ever exposed `dist`,
  so no published entry point could reach these files.

### Security

- **New self-hygiene guard (`core/self-hygiene.test.ts`).** Fails the build if
  repo-aegis's own tracked source contains an account-id-shaped string, an
  account-scoped CodeArtifact/ECR host, or a raw NUL byte. This closes a
  structural blind spot: the egress check dispatches on *filename*, so a `.ts`
  test fixture is invisible to it no matter what it contains — which is exactly
  how a real CodeArtifact host lived in a fixture, shipped in the npm tarball,
  and survived a release. Placeholders are recognised by shape (a repeated digit
  or a counting run), not by an allowlist of literals. The guard asserts a
  non-empty file list so it cannot pass vacuously, and its detector is tested
  against a reconstructed sample so it is known to be able to fail.

- `core/egress.ts` contained a raw NUL byte (a composite-key separator written
  as a literal rather than the `\u0000` escape), which made git classify the
  file as binary — so every diff of it rendered as `Bin … bytes` instead of
  reviewable text. Replaced with the escape; the runtime string is unchanged.
  Diffs of the leak-detection module are reviewable again.
- Replaced the account-scoped CodeArtifact host used as a test fixture in
  `core/egress.test.ts` with a synthetic one. This package ships `src` to npm,
  so fixture values are world-readable; the fixture only needs to be
  non-allowlisted, not real.

## [0.5.0] - 2026-06-22

### Added

- **Public-repo egress hygiene: private-registry URL leak prevention.** A new
  `core` module (`scanRegistryEgress`) flags references to non-public package
  registries — e.g. an account-scoped AWS CodeArtifact host — in
  `package-lock.json` (v1/v3), `yarn.lock`, `pnpm-lock.yaml`, and `.npmrc`. This
  guards against committing a private-registry URL — which leaks the owner's
  account id and breaks `npm ci` for external clones — into a repo that is, or
  can become, public.
- Enforcement is **visibility-gated** (`isPublicFacing`): it applies to
  `public-eligible` repos and to any repo whose cached GitHub visibility is
  `public` (a safety net for a repo left at the `private-strict` default), and is
  a no-op for private repos where such URLs are intended.
- `check` runs the scan independently of the marker deny set, reading the staged
  blob (`--staged`) / range tip (`--range`), so the existing pre-commit and
  pre-push hooks block it automatically.
- `audit` gains a `registry-egress` check (replacing the unconditional lockfile
  check, now class-gated) and a `visibility` reconciliation check that flags a
  GitHub-public repo left at the `private-strict` default.
- `status` probes and caches GitHub visibility (`repo-aegis.visibility`) and
  surfaces whether egress hygiene is enforced.

## [0.4.1] - 2026-06-20

### Fixed

- Bump the deny-set cache schema version (2 → 3) so the 0.4.0 engagement-
  identifier auto-block is not masked by a warm pre-0.4 cache. The computed
  pattern set changed without any marker-file mtime change, so a cache written
  by 0.3.x/0.4.0-pre shares the same fingerprint and must be invalidated for the
  new self-markers to take effect on upgrade.

## [0.4.0] - 2026-06-20

### Security

- **Engagement identifiers are now auto-blocked, closing a "configured but
  inert" gap.** The deny set was built solely from marker-file *contents*, so an
  engagement with zero populated markers protected nothing — even though its
  identifier is operator-chosen, typically customer-derived, and the single
  string most prone to leaking (it appears in `status` output and the registry,
  so it readily enters an author's context and is emitted by reflex). A real
  near-miss: a customer-derived engagement id reached an untracked doc and was
  caught only by a manual pre-push grep, not by repo-aegis. `computeDenySet` now
  adds each non-`_always` engagement id as an escaped, case-insensitive literal
  self-marker, so a zero-marker engagement still blocks its own identifier.
  Class scoping is preserved (a `customer-coupled` repo still may mention its own
  id; only *other* engagements' ids are blocked). Identifiers shorter than
  `MIN_AUTO_BLOCK_IDENTIFIER_LENGTH` (4) are skipped to avoid false positives;
  those engagements should carry explicit markers.

## [0.3.3] - 2026-05-27

### Fixed

- **`check-write` PreToolUse hook no longer spuriously blocks clean
  edits, and always explains a block.** Two defects, root-caused in
  `doc/bugs/repo-aegis-check-write-flake.md`:
  - The block diagnostic was written to **stdout**, but Claude Code
    forwards **stderr** to the agent when a PreToolUse hook exits
    non-zero. Every block — including a legitimate `CROSS_ORG_WRITE`
    refusal — surfaced as the bare
    `[repo-aegis hook check-write]: No stderr output` wrapper, with no
    reason and no guidance. Non-zero exits now emit on stderr (matching
    `scan-after-write`). This completes the "No stderr output" story
    begun in 0.3.2, which fixed one *trigger* (linked worktrees) but
    not the missing diagnostic.
  - The launcher trust boundary was derived from the hook process's
    `process.cwd()` — the directory Claude Code happened to spawn the
    hook in, which in a multi-root session can be an unrelated tree
    (`/tmp`, `$HOME`, a sibling repo). When that tree's org differed
    from the edited file's repo, the policy refused a clean same-repo
    edit; retrying when the spawn cwd happened to match succeeded,
    producing an intermittent false positive. The launcher boundary is
    now read from the payload's `cwd` field, and an **empty/unknowable
    source boundary fails open** (scan) instead of refusing — a
    guardrail must not block on its own inability to determine context.
    `scan-after-write` reads the payload `cwd` too, for consistency.

### Changed

- `check-write` now distinguishes exit codes: `2` blocks the tool on a
  `CROSS_ORG_WRITE` policy refusal, while an unrecoverable registry
  error exits `1` (non-blocking) so an unreadable/encrypted registry
  can no longer block every write behind the hook's own failure.
  Diagnostics for both now land on stderr.

## [0.3.2] - 2026-05-22

### Fixed

- **Linked git worktrees inherit the parent repo's trust boundary.**
  `getRemoteOrg` looked for `<gitdir>/config`, but a worktree's
  gitdir (`<parent>/.git/worktrees/<id>/`) does not carry a `config`
  file — config is shared with the parent via the `commondir`
  pointer. The result: every worktree computed as having an empty
  trust boundary, which silently mis-classified `decideHookAction`.
  When the destination tree had a non-empty boundary (any classified
  repo with a remote), the policy refused with `CROSS_ORG_WRITE`
  even though the worktree was literally backed by a repo in the
  same org. Symptom in Claude Code: every Write/Edit from inside a
  `isolation: "worktree"` subagent failed with
  `PreToolUse:Write hook error: [repo-aegis hook check-write]: No
  stderr output`. The fix follows the `commondir` pointer to locate
  the shared config.

### Changed

- Refreshed the lockfile to pick up within-range dependency bumps
  merged via dependabot since 0.3.1 (`re2` 1.24.0→1.24.1, `yaml`
  2.8.3→2.9.0, `zod` 4.4.2→4.4.3, `hono` 4.12.16→4.12.18, plus
  several dev-tooling group bumps and a GitHub Action bump).

## [0.3.1] - 2026-05-09

### Fixed

- **`@de-otio/repo-aegis-llm` is now included in the publish loop.**
  The 0.3.0 release published `core`, `scan`, `cli`, and `mcp` but
  silently skipped `llm`, so consumers resolving `^0.3.0` for the
  llm package fell back to `0.2.0` from npm. The publish workflow
  now iterates over `core llm scan cli mcp` so every workspace
  package whose `version` matches the release tag is shipped.

## [0.3.0] - 2026-05-07

### Security

- **Cross-org-write refusal is now genuine prevention, not
  post-write detection.** The 0.2.0 `repo-aegis hook
  scan-after-write` (PostToolUse) docstring and README claimed the
  hook *refuses* writes whose destination working tree's trust
  boundary did not overlap the launcher's. That claim was
  incorrect: PostToolUse fires *after* the tool's effect lands, so
  a non-zero exit cannot un-write the file. A new PreToolUse hook,
  `repo-aegis hook check-write`, runs the same `decideHookAction`
  policy *before* the tool runs and exits 2 on a cross-boundary
  write — at which point Claude Code blocks the tool from running.
  `install claude-md` registers the new hook automatically;
  existing installs need to re-run `repo-aegis install claude-md`
  to pick up the PreToolUse entry. Not exploitable in a
  privilege-escalation sense; recategorised as a correctness fix
  to a published prevention claim. The PostToolUse refuse-path is
  retained as defence-in-depth for installs that have not yet
  upgraded; its error message now acknowledges the file is already
  on disk and points at remediation.

### Added

- **`repo-aegis hook check-write` (PreToolUse).** New CLI
  subcommand wired into `Write|Edit|MultiEdit` PreToolUse. Reads
  `tool_input.file_path` from stdin, runs the path-aware trust-
  boundary policy, and exits 2 with `CROSS_ORG_WRITE` when the
  destination tree's trust boundary does not overlap the
  launcher's. Same payload shape as the existing PostToolUse
  surface (`code`, `details.srcOrgs`, `details.destOrgs`,
  `details.destTree`).
- **`install claude-md` registers the PreToolUse hook by default.**
  Idempotent on the (event, matcher, command) triple. Re-running
  the installer on an existing v0.2.0 setup adds the new entry
  without touching the existing PostToolUse / SessionStart entries
  or the `CLAUDE.md` managed block. `install claude-md --uninstall`
  strips PreToolUse entries alongside the PostToolUse and
  SessionStart cleanups; the cleanup result counters distinguish
  the three event types.
- **`doc/agent-install.md` — agent install guide.** New top-level
  doc walking a coding agent through the install + interactive
  engagement-configuration flow when a developer says "install and
  configure repo-aegis". Complements the existing
  `doc/agent-guide.md` (operator guide for ongoing use).

### Fixed

- **`[SEC C-1]` containment guard now fires on non-existent forbidden
  paths.** `extractProse` ran `realpathSync(root)` before the
  forbidden-prefix check, so a non-existent path under a forbidden
  prefix (e.g. `~/.gnupg/...` on a system without gnupg installed)
  threw a generic `Error` from realpath's ENOENT and bypassed the
  containment guard entirely. Added a pre-canonicalisation literal-
  prefix check that throws `RootContainmentError` regardless of
  filesystem state. The post-realpath check is preserved for symlink-
  escape protection. Surfaced by Linux CI runs where the runner's
  home doesn't contain `.gnupg` / `.config/git`; previously masked on
  developer macOS boxes where those paths happen to exist.

- **Hook diagnostic JSON now reaches the agent on non-zero exit.**
  `repo-aegis hook scan-after-write` (and any future hook subcommand
  that uses `emitJsonAndExit`) wrote its structured payload to stdout
  for every exit code. Claude Code's hook contract forwards stderr
  and discards stdout when a hook exits non-zero, so on exit 1
  (`EXIT_HIT`) and exit 2 (`CROSS_ORG_WRITE`, `REGISTRY_ERROR`,
  `RegistryEncryptedError`, scan errors) the agent saw
  `[hook]: No stderr output` with no diagnostic. Stream is now
  selected by exit code: stdout for exit 0 (preserves consumers
  piping the normal output), stderr for non-zero (makes the
  structured payload reach the agent so it can surface the
  refusal/hit and propose a remediation rather than silently retry).
  The test helper `runCli` looks at both streams when extracting
  JSON, so existing assertions on `r.json` across exit-1 and exit-2
  paths continue to pass.

## [0.2.0] - 2026-05-07

### Added

- **Secret-shape scanning for Bash tool output.** New PostToolUse hook
  `repo-aegis hook scan-bash-output` reads the Claude Code tool-result
  JSON from stdin, extracts the Bash stdout/stderr, and scans for
  universal secret-shaped patterns: PEM private-key headers (RSA / EC
  / OPENSSH / encrypted variants), the macOS keychain hex-encoded form
  of `-----BEGIN ` (the failure mode where `security ... -w` round-
  trips a PEM as ASCII hex), GitHub token prefixes (`ghs_`, `ghp_`,
  `gho_`, `ghu_`, `ghr_`, `github_pat_`), and three-segment JWT
  shapes anchored on the `eyJ` header. On a hit, exits 1 with a
  structured `SECRET_LEAK` payload that names the kinds and offsets
  detected (no matched bytes — by construction). `--advisory` keeps
  the payload but exits 0 for soft-rollout scenarios.
  - `install claude-md` automatically registers the new hook with a
    `Bash` matcher alongside the existing `Write|Edit|MultiEdit`
    matcher; merge is idempotent on the (matcher, command) pair so
    existing users picking up the upgrade re-run safely.
  - `install claude-md --uninstall` strips the new hook entries.
  - The pattern set is universal — not engagement-scoped, not
    configurable. New `core` exports: `scanForSecrets`,
    `summariseHits`, `SecretMarkerKind`, `SecretMarkerHit`.
  - PostToolUse fires *after* the tool runs, so the leak has already
    reached the agent context by the time the hook detects it. The
    hook is therefore framed as detection-and-alert, not prevention:
    its `remediation` block points the agent at credential rotation
    (e.g. `de-otio/treat-agent-as-a-dev` Step 9) rather than
    pretending the leak can be unsent.

- **One-command uninstall.** New top-level `repo-aegis uninstall`
  reverses every `install …` step in one shot. Defaults to a dry-run;
  `--yes` applies. Opt-in `--purge-repos` walks `~/repos`, `~/code`,
  `~/src`, `~/projects` (override via `--scan-root`) and unsets
  `repo-aegis.*` keys from every git working tree it finds. Opt-in
  `--purge-home` deletes `~/.config/repo-aegis/` (with an
  anti-fat-finger `PURGE_HOME_REFUSED` guard) and surfaces audit-log
  presence in the dry-run report so the user can back it up first.
- **`install claude-md --uninstall`.** Strips the managed `CLAUDE.md`
  block and removes every PostToolUse / SessionStart hook entry
  attributable to repo-aegis (matches the canonical `repo-aegis hook
  scan-after-write` / `repo-aegis hook first-touch` commands plus a
  legacy absolute-path-to-shell-script form). Preserves third-party
  hooks in the same matcher entry. Idempotent.
- **`install ci --uninstall`.** Deletes
  `.github/workflows/leak-scan.yml` if its body matches a known
  emitted template. Surfaces `WORKFLOW_MODIFIED` (and refuses
  deletion) when the user has edited it.
- **`uninstall sweep-repos`** verb. Walks one or more `--scan-root`
  paths and unsets `repo-aegis.class` / `repo-aegis.engagement` keys
  from every git working tree underneath. Dry-run by default;
  `--yes` to apply. Idempotent.
- **`install gitignore` honours `silent`** so the top-level
  uninstall can call it without polluting its own output.

### Changed

- **PostToolUse hook is now path-aware.** `repo-aegis hook
  scan-after-write` resolves the destination working tree from the
  written `file_path` (walking up to the nearest `.git`) instead of
  from the launcher's `cwd`. The destination repo's classification
  and deny set apply, so cross-repo writes inside the same trust
  boundary now scan cleanly instead of fail-closing on
  `OUTSIDE_WORKING_TREE`. New `core` exports: `findEnclosingWorkingTree`,
  `resolveGitDir`, `getRemoteOrg`, `computeTrustBoundary`,
  `trustBoundariesOverlap`.

### Added

- **`CROSS_ORG_WRITE` error code** (PostToolUse hook). When the
  destination working tree's trust boundary (engagement
  `githubOrgs` ∪ `personalOrgs` ∪ remote-org fallback) does not
  overlap the launcher's, the hook refuses with this code and exits
  2. The file is already on disk (PostToolUse fires after the
  write); the hook surfaces the offending path and asks the agent
  to revert. Trust boundaries inferred from classification beat the
  remote URL — forks don't accidentally widen scope.
- **`DEST_UNCLASSIFIED` warning code** (PostToolUse hook). Emitted
  alongside a normal scan result when the destination repo has no
  class, no engagements, and no parseable remote. The scan still
  runs against `_always`; the warning prompts the agent to suggest
  classifying the destination.
- **Phase 1 — zero-config onboarding (org-keyed JIT classification).**
  - Registry schema v2: `personalOrgs` (top-level) and
    `engagements[*].githubOrgs` (per-engagement). v1 files continue to
    parse with `personalOrgs: []` defaults.
  - `repo-aegis hook first-touch` — Claude Code SessionStart hook that
    classifies a previously-unclassified repo from its git remote +
    registry org membership, with a redacted "needs confirmation"
    output for ambiguous cases (`[SEC H-5]`).
  - `repo-aegis engagements add [id] --github-org <org>` /
    `--personal-org <org>` — attach orgs to engagements; mutual
    exclusion + cross-engagement uniqueness validation.
  - `repo-aegis init --migrate-classify` — port a legacy `classify.yml`
    to the registry schema (idempotent, atomic write).
  - `repo-aegis classify` falls back to legacy `classify.yml` with a
    one-time deprecation warning naming the matched rule
    (`[SEC M-7]`).
  - `aegis_classify_first_touch` MCP tool exposing the same pipeline
    to other agent runtimes.
- **Phase 2 — LLM-assisted marker discovery.**
  - New workspace package `@de-otio/repo-aegis-llm` (Ollama HTTP
    client, prose extraction, token synthesis, filters,
    token-extraction prompt).
  - `repo-aegis suggest-markers --engagement <id>
    [--auto-accept-above <n> | --dry-run]` — extract prose, ask a
    local Ollama model to identify customer tokens, synthesise
    word-boundary regexes, filter (dictionary, dependencies,
    existing patterns, user-identity guard), and either auto-accept
    above a confidence threshold or print a review-required
    candidate list for the user to inspect before re-running.
  - `[SEC H-1]` Ollama endpoint validation (loopback-only by default,
    `--allow-remote-model` opt-in, `localhost` DNS lookup guarded
    against `/etc/hosts` redirection).
  - `[SEC C-3]` LLM prompt-injection defence: anti-injection preamble
    + fence delimiters around user-provided prose; structured response
    parsed via Zod.
  - `[SEC H-2]` user-identity cross-check: tokens that match
    `personalOrgs`, `$USER`, or `$HOME` basename are filtered out
    before the candidate list is surfaced.
  - `[SEC H-6]` audit-log redaction for `suggest-markers` runs.
- **Phase 3 — semantic audit sweep (off-machine, advisory).**
  - Per-engagement embedding profiles stored at
    `~/.config/repo-aegis/profiles/<engagement-id>.json` (chmod 0600,
    atomic tmp+fsync+rename, schema-versioned).
  - `[SEC H-3]` source-document manifest with sha256 hashes; rebuild
    surfaces a stored-vs-current diff before re-embedding.
  - `repo-aegis-scan run --semantic` — for each new regex hit,
    fetches the candidate blob, embeds it, scores it against all
    active engagement profiles, and surfaces engagements over the
    per-profile cosine threshold. Output gains a `semantic` section
    (JSON) or "Semantic hits" table (markdown). Best-effort —
    Ollama failures do not abort the regex sweep.
  - `repo-aegis-scan rebuild-profiles [--diff] [--engagement <id>...]` —
    build / refresh profiles from each engagement's `reposActive`.
- **Hot-path determinism guard.** New test
  `packages/core/src/import-graph.test.ts` walks the static import
  graph from each gate-path entry point (PostToolUse hook,
  pre-commit, pre-push, `check`) and fails if any node resolves under
  `packages/llm/` or imports `@de-otio/repo-aegis-llm`. `[SEC M-1]`
  also greps for forbidden literals in case of dynamic imports.

## [0.1.0] - 2026-05-02

First published release. Engagement-scoped leak prevention for multi-customer
git repos: classify a repo, declare which engagements it serves, and refuse
to commit, push, or surface anything that names an unrelated engagement.

### Added

- Core CLI scaffold: `repo-aegis init`, `classify`, `context`.
- `repo-aegis install` for git hooks, `.gitignore` entries, CI workflow, and
  `CLAUDE.md` integration snippets.
- `repo-aegis markers list` and `repo-aegis markers test` for inspecting and
  probing the active deny set.
- `repo-aegis engagements add`, `engagements end`, and `engagements show` for
  managing the scoped engagement registry.
- `repo-aegis audit` composite repo-health command.
- `repo-aegis check --range` and `repo-aegis check --history` for batched
  pre-push and CI-time scans across commit ranges.
- `repo-aegis check --since` for explicit history lower-bound scans.
- `.repo-aegis.yml` per-repo overrides and per-line `repo-aegis-allow`
  comments for documented exceptions.
- `repo-aegis audit --org` and `repo-aegis audit --published` for scanning
  org membership and published artefacts (npm tarballs, VSIX bundles).
- `@de-otio/repo-aegis-scan` package: org-wide GitHub code-search sweep with
  markdown and GitHub-issue output formats.
- `repo-aegis scan run --output-format markdown` and `--output-format issue`.
- `repo-aegis scan encrypt-query` and `scan decrypt-query` (age-based
  wrappers) for shareable encrypted scan inputs.
- `@de-otio/repo-aegis-mcp` server for Model Context Protocol coding-agent
  integration (Claude Code, Cursor, etc.).
- `repo-aegis-vscode` extension for editor-side diagnostic display.
- GitHub Action (`uses: de-otio/repo-aegis@v1`) for drop-in CI integration.
- Optional age-encrypted engagement registry via `repo-aegis registry encrypt`
  and `repo-aegis registry decrypt`.
- Optional operator audit log via `repo-aegis audit-log on|off|show|path`
  (compliance trail of who ran what when).
- Optional `re2` regex backend for linear-time pattern matching on adversarial
  inputs (graceful fallback to native RegExp when `re2` is not installed).
- `repo-aegis hook scan-after-write` subcommand for Claude Code PostToolUse
  integration.
- Universal CLI flags (`--quiet`, `--json`, `--no-color`) across subcommands.
- `repo-aegis engagements remove --hard` for permanent removal, complementing
  the default soft-end.
- `repo-aegis render --retention-months` for time-bounded report rendering.
- Concurrent-write safety via `withLock` around all on-disk state mutations.
- On-disk deny-set cache for fast repeated scans.
- Strict regex validation (subprocess-isolated) to reject patterns that risk
  catastrophic backtracking before they reach the hot path.
- Schema-versioned on-disk state with forward-compatible migrations.
- Zod-validated registry and state schemas at every read boundary.
- Streaming `scanRange` and single-pass `scanHistory` for large commit ranges.
- Diff-based scanning (`parse-diff`) so only touched lines are re-scanned in
  hook and CI contexts.
- 429 / rate-limit handling for GitHub API calls in `scan` and `audit --org`.
- Pruning of stale entries from on-disk seen-marker state.
- CI matrix covering Node 20, 22, and 24, with coverage gating on Node 24.

### Changed

- `repo-aegis init` now wires `installHooks` and `installClaudeMd` end-to-end
  by default, so a fresh init produces a fully-armed repo.
- Audit output renders a structured scan summary; markdown and issue formats
  share a common renderer.
- `repo-aegis install` refactored so the CI installer is reusable from
  `audit` and from external integrations.

### Fixed

- Pre-push hook no longer silently no-ops when the test glob doesn't match.
- Comment-strip pre-pass no longer discards lines that happen to contain a
  substring matching a comment marker.
- `ScanHit.engagement` now correctly attributes hits to the engagement that
  owns the matched marker (was previously empty in some multi-engagement
  layouts).
- `bin` name in package metadata now matches the documented hook command.
- Test-glob silent-skip behaviour replaced with an explicit error.

### Security

- Hardened `audit --published` against zip-slip attacks on extracted
  archives (npm tarballs and VSIX bundles).
- Subprocess-backed regex validation prevents user-supplied patterns from
  hanging the main process via catastrophic backtracking.
- Redaction pre-pass is now applied before any pattern is logged, including
  in error paths and audit-log entries.
- Hook templates avoid shell-injection by passing arguments via argv arrays
  rather than interpolating into a `sh -c` string.
- `init` takes a per-repo lock so concurrent `init` invocations cannot race
  and produce a half-written registry.

[Unreleased]: https://github.com/de-otio/repo-aegis/compare/v0.12.1...HEAD
[0.12.2]: https://github.com/de-otio/repo-aegis/compare/v0.12.1...v0.12.2
[0.12.1]: https://github.com/de-otio/repo-aegis/compare/v0.12.0...v0.12.1
[0.12.0]: https://github.com/de-otio/repo-aegis/compare/v0.11.4...v0.12.0
[0.11.4]: https://github.com/de-otio/repo-aegis/compare/v0.11.3...v0.11.4
[0.11.3]: https://github.com/de-otio/repo-aegis/compare/v0.11.2...v0.11.3
[0.11.2]: https://github.com/de-otio/repo-aegis/compare/v0.11.1...v0.11.2
[0.11.1]: https://github.com/de-otio/repo-aegis/compare/v0.11.0...v0.11.1
[0.11.0]: https://github.com/de-otio/repo-aegis/compare/v0.10.3...v0.11.0
[0.10.3]: https://github.com/de-otio/repo-aegis/compare/v0.10.2...v0.10.3
[0.10.2]: https://github.com/de-otio/repo-aegis/compare/v0.10.1...v0.10.2
[0.10.1]: https://github.com/de-otio/repo-aegis/compare/v0.10.0...v0.10.1
[0.10.0]: https://github.com/de-otio/repo-aegis/compare/v0.9.1...v0.10.0
[0.9.1]: https://github.com/de-otio/repo-aegis/compare/v0.9.0...v0.9.1
[0.9.0]: https://github.com/de-otio/repo-aegis/compare/v0.8.2...v0.9.0
[0.8.2]: https://github.com/de-otio/repo-aegis/compare/v0.8.1...v0.8.2
[0.8.1]: https://github.com/de-otio/repo-aegis/compare/v0.8.0...v0.8.1
[0.8.0]: https://github.com/de-otio/repo-aegis/compare/v0.7.1...v0.8.0
[0.7.1]: https://github.com/de-otio/repo-aegis/compare/v0.7.0...v0.7.1
[0.7.0]: https://github.com/de-otio/repo-aegis/compare/v0.6.0...v0.7.0
[0.1.0]: https://github.com/de-otio/repo-aegis/releases/tag/v0.1.0

See the full release history at
<https://github.com/de-otio/repo-aegis/releases>.
