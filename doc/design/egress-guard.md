# Design: egress guard (destination-aware publishing controls)

**Status:** implemented — rollout phases 1–3 (shape rules, receipts, agent
hooks; git-native destination; the `gh` shim, payload rules, `selfIdentity`,
`doctor` checks). Phase 4 (server-side `audit --pr-body`) is not built. One
recorded deviation: rule d exempts the agent's session-unique scratchpad under
the sandboxed `$TMPDIR` root (see `isModeDependentPath`), because that is the
location the design tells agents to use. Extended in 0.11.0 (issue #151) with
rule h, which refuses egress to an owner nobody registered, and the shape and
human-presence rules that protect it; the plan is
[plan-unregistered-owner-egress.md](../plan-unregistered-owner-egress.md).
**Author:** (drafted with Claude Code)
**Scope:** `@de-otio/repo-aegis-core`, `@de-otio/repo-aegis` (CLI), the generated
git hooks, a new `PATH` shim

## Problem

repo-aegis asks one question: *are these bytes safe in this repository class?*
Every layer — the agent write hooks, pre-commit, pre-push, the CI scan, the
publish gate — inspects **content** against a deny set derived from the repo the
content sits in. That question has a blind spot, and two incidents landed in it
(both from the author's own use, within one week; details are not published).

Both were **right bytes, wrong boundary**:

- A PR description was published to an org-internal customer repository from a
  body file that belonged to a different project. `$TMPDIR` resolves to two
  different directories depending on whether a shell runs sandboxed, and a
  stale `pr-body.md` from another session was waiting in the other one.
  `gh pr create --body-file "$TMPDIR/pr-body.md"` exited 0 and returned a URL.
  The content carried no denied marker; it was simply the wrong document, in
  the wrong repository, for 57 minutes (the author's own account; no incident record is published).
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
  capabilities: {
    ask: boolean;                  // does the enforcing framework have an "ask"?
    ghShimOnPath?: boolean;        // can the layer below still refuse a `gh` verb?
  };
}): EgressDecision;
```

Rules, in evaluation order. **Shape rules need no context and are
unconditional. Context rules fail open** — the lesson of the spurious
`CROSS_ORG_WRITE` blocks (doc/bugs/repo-aegis-check-write-flake.md): a
guardrail must not block on its own inability to determine context. Asking is
not blocking, so an unknown destination may still `ask`. The one deliberate
exception is rule h, which fails closed on a write whose owner it cannot name
(see the 2026-11-02 note on D5 below).

| # | Kind | Rule | Decision | Code |
|---|---|---|---|---|
| D2 | shape | a recognised `dot gh` call (below) that is a write, with no person present and no leading `--as bot` (evaluated before everything else, so its agent-side fix is named first) | deny | `DOT_GH_WRITE_NEEDS_BOT` |
| pty | shape | a parsed egress intent runs under a pty wrapper, such as `script`, `unbuffer`, `expect`, `socat`, `ssh -t`, `tmux`, `screen`, or an interpreter's pty module (evaluated before a). Since the word backstop went, that is only a wrapper the parser reads through a variable or substitution (`S=script; $S … git push …`); `script -q /dev/null gh …` written out is no intent at the hook | deny | `EGRESS_PTY_WRAPPER` |
| a | shape | `git push` with no `<remote> <refspec>` | deny | `PUSH_IMPLICIT_TARGET` |
| b | shape | egress verb with `precededByCd` | deny | `EGRESS_AFTER_CD` |
| c | shape | egress verb with `joinedBy === ";"` (or `\|\|`) | deny | `EGRESS_UNGUARDED_CHAIN` |
| d | shape | payload path relative, contains `$TMPDIR`, or resolves under `/var/folders/**`, `/tmp/claude-*`, `%TEMP%` | deny | `PAYLOAD_MODE_DEPENDENT_PATH` |
| b′ | shape | the egress segment (or an earlier `export` in the same command) sets an environment variable or option that steers the shim, the pre-push hook, `gh` or `git` elsewhere: `REPO_AEGIS_*`, `HOME`, `PATH`, `XDG_CONFIG_HOME`, `GH_CONFIG_DIR`, `GH_HOST`, `GIT_CONFIG*`, `GIT_SSH*`, `GIT_DIR`, `GIT_WORK_TREE`, `SRT_*`, `SHELL`, `BASH_ENV`, `BASH_FUNC_*`, `LD_*`, `DYLD_*`; `env -i` / `env -u`; `--git-dir` / `--work-tree`; `git -c remote.*`, `url.*`, `core.sshCommand`, `core.hooksPath` | deny | `EGRESS_ENV_OVERRIDE` |
| b″ | shape | the egress segment follows, in the same command, a change to state it reads: `git remote`, `git config`, `gh repo set-default`, `gh alias set`, `gh auth`, `export`, or a write into `.git/`, `~/.ssh/config`, `~/.gitconfig` or the gh config | deny | `EGRESS_AFTER_STATE_CHANGE` |
| a′ | shape | `gh pr create` with no person present and no `--repo`, `GH_REPO` or URL positional (the `gh` counterpart of rule a; D10) | deny | `GH_PR_CREATE_IMPLICIT_TARGET` |
| h | context | no person present, and the destination's owner is not registered: not in `personalOrgs` or any engagement's `githubOrgs`, and not an exact `allowedUpstreams` entry on a PR / issue verb. A destination whose owner cannot be named offline (D5) counts as unregistered. Runs right after resolution, before e and before the visibility lookup; no approval satisfies it | deny | `UNREGISTERED_OWNER_EGRESS` |
| e | context | payload file's enclosing working tree has a trust boundary **positively disjoint** from the destination's | deny | `CROSS_ORG_EGRESS` |
| f | context | payload content matches the destination's deny set (`check --path` with the destination's `RepoConfig`) | deny | `PAYLOAD_MARKER_HIT` |
| g | context | destination `publicFacing`, or verb ∈ {`gh-pr-merge`, `gh-release-*`, `gh-repo-edit`, `npm-publish`}, and `!humanPresent` and no live approval that covers it (§4a) | `ask` if `capabilities.ask`, else deny | `PUBLIC_EGRESS_NEEDS_HUMAN` |
| g′ | context | rule g on a `gh-*` verb with `capabilities.ghShimOnPath === false` | deny | `SHIM_UNREACHABLE_NEEDS_HUMAN` |
| — | — | otherwise (including class `scratch`) | allow | — |

Rule h used to be lettered for "destination class `scratch` → allow". The code
never special-cased `scratch`, so that row is now the unlettered "otherwise
allow", and the letter h belongs to the unregistered-owner rule (issue #151).
Rule h is skipped when no registry file exists, when the registry declares no
owners, or when it is encrypted at rest (repo-aegis runs as if there were no
registry; encryption at rest is deprecated), and the refusal or the stderr
note says which state applied. A registry that exists but cannot be read
(`unparseable`: it does not parse or validate; `newer-schema`: a newer
repo-aegis wrote it) does **not** skip it, because an agent that can write the
file could otherwise switch the rule off with one bad line of YAML. The
decision is `ask` where the host has a prompt (Claude Code, Copilot, Cursor)
and `deny` where it has none, or where the `gh` shim is not first on `PATH`;
the pre-push hook and the shim cannot ask, so they refuse. The `ask` is not a
way through for a push: the pre-push hook still refuses it until the registry
can be read. A person at a terminal still passes. The five states
(`loaded`, `missing`, `encrypted`, `unparseable`, `newer-schema`) come from one
non-throwing core loader, `loadRegistryState`, which the hook, the shim,
pre-push, the `gh` identity layer, the write hooks and `doctor` all use, so
they cannot disagree. Any error the loader does not recognise is `unparseable`.

**`dot gh` is the one wrapper the parser reads** (doc/plan-recognise-dot-gh.md).
Every other wrapper (an interpreter, a script) is not recognised: a segment the
parser cannot read as `git push` / `gh <write>` is no intent at the hook, and
the `gh` shim judges the `gh` call it ends up making. The recognised shape is one shell
segment, after the existing handling of `cd`, `&&`, env assignments and
redirections:

```
node <path ending in /dot.mjs> gh [--as <id> | --as=<id> | --explain]… <gh args…>
dot gh [--as <id> | --as=<id> | --explain]… <gh args…>
```

`node` is the bare word or an absolute path; no option comes between it and a
literal script named `dot.mjs`; `NODE_OPTIONS` / `NODE_PATH` must not be in force
on the segment. dot's own options are read only at the front, as `dot gh` itself
reads them. The rest is parsed as the argument vector of a plain `gh`, and the
intent carries `wrapper: { kind: "dot-gh", as }`; from there rules a–h judge it
exactly as a plain `gh` (public-repo approval, markers, unregistered owners).
`--explain` and own options that `dot gh` refuses (`--as` with no usable value)
run no `gh`, so they are no intent. The one added step, **D2**: with no person
present, a write through `dot gh` needs `--as bot` as its first option, because
without `--as` `dot gh` picks the identity from the repository's owner, and for
the user's own organisation that is the user. A write is any intent the
remainder yields, resolved or not. D2 deliberately precedes the shape rules, so
`cd … && dot gh pr create …` with no `--as` is refused as
`DOT_GH_WRITE_NEEDS_BOT` first. The shim is unchanged: the `gh` that `dot gh`
spawns reaches it with literal arguments and is judged there as a plain `gh`;
it cannot see `--as`, so D2 lives at the hook only. `bot` is a fixed name:
repo-aegis does not read dot gh's identity table.

Accepted limits (the threat model is accidents, not a deliberate agent): `dot.mjs`
and its identity table are files an agent can edit, and `--as bot` is trusted as
a word. A person's own public write or merge through `dot gh` is judged at the
`gh` shim, which `dot gh` hands a piped stderr, so the shim's terminal test
never sees a person: such a call needs `REPO_AEGIS_EGRESS_HUMAN=1` or plain `gh`.

Two further shape rules apply to the command text alone and are not part of the
per-intent table: `GITHUB_API_VIA_HTTP_CLIENT` (`curl` or `wget` writing to
`api.github.com` or `uploads.github.com`) and `GH_AUTH_TOKEN_NETWORK` (`gh auth
token` in a command that also makes a network call). For `git`, only a
subcommand that can reach a remote counts: a positive list of local built-ins
(`tag`, `log`, `status`, …) does not, and an alias, an unknown subcommand or a
`-c` / `--config-env` / `--exec-path` option does. They are speed bumps, not
proofs: an interpreter's `-c` text can still do either.

The identity rules of `doc/plan-owner-identity.md` §13.2 are shape rules of the
same kind (command text only, no registry except N8, no approval lifts any),
and they run on every agent command, ahead of the "no egress intent" exit:

- **A1** — a command that runs `gh`, `git`, `taaad` or `security` (directly, or
  through `env`, `sudo`, `sh -c`, `eval`, substitutions or a heredoc-fed shell)
  with any `REPO_AEGIS_*` variable set (a prefix assignment, an `env` argument,
  or an earlier `export` / assignment in the same command) is
  `EGRESS_ENV_OVERRIDE`; under a pty wrapper it is `EGRESS_PTY_WRAPPER`.
  Whatever the command does, and with a person present too: text is how an agent
  would make the next layer believe a person is there.
- **A10** — with no person present, `gh auth` with anything but a plain
  `status` (`status --show-token` / `-t` included), `gh config set|clear-cache`,
  `gh alias set|import|delete` and `gh extension install|upgrade|exec` are
  `GH_AUTH_NEEDS_HUMAN`. `gh` global flags before the group are read the way gh
  reads them.
- **N9** — with no person present, `taaad env|agent|credential-helper|mint`,
  `security find-generic-password|find-internet-password|dump-keychain|export|unlock-keychain`
  (absolute paths count) and a `python*`, `node`, `perl`, `ruby` or `osascript`
  `-c` / `-e` text, or heredoc, that mentions `keyring` or `SecItemCopyMatching`
  are `TOKEN_MINT_NEEDS_HUMAN`. Speed bumps like `GH_AUTH_TOKEN_NETWORK`: a
  script file or another interpreter still gets through; the keychain ACLs are
  the control.
- **Review follow-ups.** `git credential fill|get|approve` and the
  `git[ -]credential-<helper> get` forms are N9 and are token reads for
  `GH_AUTH_TOKEN_NETWORK`; a segment that leaves a `REPO_AEGIS_*` name set in the
  shell (a bare assignment, `export`, `declare -x`, `readonly`, `read`) is A1,
  because the agent's shell persists across calls, and `REPO_AEGIS_EGRESS_HUMAN`
  no longer counts under an agent host above a TTY; N9 adds the `keyring` and
  `secret-tool` CLIs, `security -i` and stdin text, and interpreter or piped
  text naming a keychain route; A10 reads `--show-token=…` and a gh reached
  through `G=gh; $G`, an alias or `$(which gh)`. The write hook refuses an
  agent's Edit or Write to gh's `config.yml` and `hosts.yml`
  (`GH_CONFIG_WRITE_REFUSED`).
- **N8** — a recognised `dot gh` write whose literal owner (`--repo` / `-R` /
  `GH_REPO`, a URL, a `repos/<o>/<r>` endpoint) has an identity mapped in a v3
  registry is `DOT_GH_OWNER_MAPPED`, decided before D2; a person present or an
  approval does not lift it. An owner with no identity entry keeps D2 as above.

Reasons name the destination (`<org>/<repo>`, visibility, class) and the
ref/PR — that is the receipt-before-the-fact a human sees when asked. They
never include payload content.

Destination resolution is **offline**, and since 0.11.0 it names the owner
`gh` or git will actually write to, not the one the checkout suggests:

- `git push <remote>` → the remote's push URLs, from `git remote get-url
  --push --all`, so `insteadOf`, `pushInsteadOf` and `remote.<remote>.pushurl`
  apply and **every** push URL is a candidate. `parseRemoteUrl` accepts every
  GitHub form git does (any host case, a port, a trailing dot,
  `ssh.github.com`, `www.`, any ssh user). An ssh host alias is read with a
  small pure parser of `~/.ssh/config` (`Host` and `HostName` only; never `ssh
  -G`, which evaluates `Match exec` from a file an agent can write). The
  pre-push hook is handed the URL after all rewriting, once per push URL.
- `gh … --repo o/r` → direct, including the attached forms `-Ro/r` and
  `-R=o/r`. `GH_REPO` applies when there is no `--repo`, in the shim's own
  environment and in a leading `GH_REPO=…` or `env GH_REPO=…` at the hook. A
  PR or issue URL, or an `<o>/<r>` given positionally (`gh pr comment <url>`,
  `gh repo edit o/r`, `gh issue transfer 5 o/r`, `gh repo sync o/r`), names
  that repository. When `--repo`, `GH_REPO` and a URL disagree, every one is a
  candidate and every owner must be registered.
- a `gh` verb with no explicit target → **gh's own pick**: the checkout's
  remotes sorted `upstream`, `github`, `origin`, then the rest, with a
  `remote.<name>.gh-resolved` value (`base`, or an `owner/repo`) honoured first
  for the verb groups gh resolves that way. (Read from the gh source, gh 2.46,
  `context/remote.go`; not re-checked against later gh versions.) A remote the guard cannot read as a
  clean GitHub URL makes the result unresolved, never "the cwd's origin".
- `gh api repos/o/r/…` → from the API path (`orgs/o/…` → the org, repo `*`;
  `{owner}`/`{repo}` placeholders in the owner or repo segment → `cwd`'s
  origin, as `gh` itself does). A path with `..`, `%2f` or an empty segment, an
  endpoint with no owner in it (`repositories/<id>/…`, `gists`, `projects/…`),
  or a placeholder anywhere else in the owner or repo segment is
  **unresolved**. `user`, `user/…` and `gh gist create` belong to the
  authenticated account and are not attributed to any repository (no approval
  covers them; a person runs them). `gh api graphql` → `cwd`'s origin for a
  read-only query, but **UNKNOWN** for a mutation (or a document the guard
  cannot read), see below.
- a `gh` alias is expanded from `gh`'s own `config.yml` before the verb is
  classified; a shell alias or an extension the guard cannot expand is an
  unresolved intent.

The governing rule: any segment the parser recognises as invoking `gh <write>`
or `git push` (directly, or through a wrapper, reserved word, shell `-c` or
`eval` text, a heredoc or here-string fed to a shell, an alias or a
substitution) whose verb or target it cannot fully determine yields an
**unresolved** intent, never "no intent". The parser does **not** read a
command's text for stray mentions: a segment it does not recognise as
`git push` / `gh <write>` is not egress at the hook. A `sed` replacement
(`sed -i 's/x/gh auth token/' doc.md`), `echo "git push"`, a heredoc fed to
`cat`, and an interpreter's program text (`python3 -c "os.system('gh pr create')"`)
are data to it. A word-level re-read of the command used to catch
`find -exec gh …`, `parallel gh …`, `case` bodies and interpreter text, and its false
positives landed on `sed`, `echo` and heredocs; it was removed (P1-C of the
complexity review) because the layer below already judges those shapes when
they actually run: the `gh` shim sees the real argument vector of every `gh`
call on this machine however it was spawned, and the pre-push hook sees every
push made here. That makes the shim, first on `PATH`, the only guard for those
shapes (`doctor` reports `SHIM_NOT_FIRST` as a failure). It does not reach a
command that runs somewhere else: see the remote and container runners in the
known gaps below, which the parser reads as a shape for exactly that reason. A
resolved or unresolved destination is judged by rule h before anything else.

**Remote and container execution.** The shim and the pre-push hook exist only
on this machine, so a `git push` or `gh <write>` run through `ssh host …`,
`docker|podman|nerdctl exec|run …`, `docker compose exec|run`, `kubectl|oc exec`,
`devcontainer exec`, `nix-shell --run`, `nix develop|shell -c`, `vagrant ssh -c`,
`wsl`, `distrobox enter -- …` or `toolbox run` has no layer below the hook. The
parser reads these runners as a shape (the runner's own options and its host,
container or pod are skipped by arity; what follows, a `-c` / `--run` text or
the exec'd words, is parsed as a command of its own). If that command is a
`git push` or `gh <write>`, the result is one **unresolved** intent, so rule h
refuses or asks as for any unnameable destination. This is a parse, not a scan
of text: `ssh host ls`, `docker exec ctr cat file` and `ssh host 'echo git push'`
are no intent. What it cannot see (a script already on the remote host or in
the image that publishes, or a runner that is not listed) is not guarded.

Known gaps, stated so nobody assumes coverage: the fork parent that `gh` can
pick through the API for a `gh` write verb other than `gh pr create` (R5; D10
closes it for `pr create` only, and `gh issue create` and the comment verbs
resolve through remotes, but that is not proven); a `GH_REPO` exported from a
shell startup file, which the hook cannot see and only the shim reads (R8, see
`doctor`'s `SHELL_STARTUP_OVERRIDES`); and, on hook-only installs, an ssh
redirect from a persistent change the hook cannot see, which the pre-push hook
still refuses (R11, `PREPUSH_HOOK_MISSING`); and execution on another host or in
a container, where neither the shim nor the pre-push hook exists (the runners
listed above are read as a shape; any other way to get a command onto a remote
machine, or a publish that a remote script performs by itself, is not guarded).
Owners whose names contain `_`
(Enterprise Managed Users) cannot be registered, so rule h refuses them
permanently for an agent. Visibility from the
`repo-aegis.visibility` cache. Class from `readRepoConfig(cwd)` when the
destination is `cwd`'s own origin. When it is not — the command names a
repository in full from somewhere else — class and visibility come from
the **machine-wide destination cache** (`$REPO_AEGIS_HOME/destinations.json`):
`<org>/<repo>` → the checkout on this machine that declares it, read live
when the checkout still exists and from the snapshot otherwise. It is
written by `classify --apply`, `status`, `doctor`'s sweep, and the guard
itself on every command judged from inside a repository, so it fills in
with use. A remote that is plainly a local path, or a non-GitHub host the
parser understands, yields no destination and rules e–h do not fire; a
URL-shaped push target that does not resolve is **unresolved**, which rule h
refuses (below). A parsed destination is public-facing unless its visibility is a
recorded `private` (`treatAsPublicDestination`, shared by all three
enforcement points): `public-eligible` is public-facing whatever the cache
says, because the class is a declaration and the cache is only an
optimisation, and an **unknown** visibility — nothing cached, in any org —
is treated as public, so rule g asks.

*Added 2026-09-13 (issue #114):* until v0.10.2 an unknown visibility was
treated as public only in `personalOrgs`; everywhere else, and in the
pre-push layer always, it was let through, and on 2026-09-12 a push to a
public repository went through under an `UNKNOWN` receipt. Now, when a
destination's visibility is unknown (and its class is not
`public-eligible`), the guard makes one live lookup — `gh repo view
<org>/<repo> --json visibility`, 5-second timeout, stderr never shown —
and records an answer in the destination checkout's `repo-aegis.visibility`
(and the destination cache), so the next call is offline. A lookup that
cannot answer leaves the destination unknown, i.e. refused without a
person: the network can only lift the refusal, never impose or skip it.
`REPO_AEGIS_VISIBILITY_LOOKUP=0` disables the lookup (the test suite sets
it).

*Added 2026-09-12, after the guard shipped:* the first version resolved
every `gh api` call and every foreign `--repo` / push URL from `cwd`, so a
merge into a public repository run from a private checkout was allowed
unasked and receipted as the private repository — the first incident's
shape, an explicit destination judged from the wrong place. The API-path
parse and the destination cache are the fix; the same cache lookup was
added to the pre-push layer (§2), which had judged a push to a non-origin
URL by the pushing repository's own class.

*Added after issue #113:* a GraphQL mutation (`gh api graphql` with
`enqueuePullRequest(input: {pullRequestId: $id})`, say) has the same
defect with no path to parse: its target is a node id, so the fallback to
`cwd` attributed a mutation against a public repository, issued from a
private checkout, to the private one. The resolver now reads the GraphQL
document (inline `query` field, `-F query=@file`, or the `query` member of
an `--input` body) with a small lexer that ignores strings and comments
and only counts a `mutation` keyword at the top level. A mutation's
destination is `UNKNOWN` (`org`/`repo` `*`, `unresolved:
"graphql-mutation"`): treated as public-facing, the same fail-closed
stance as `visibility uncached, treated as public`, so rule g asks the
agent's human and the shim refuses from a shell with none; only a `*`
approval covers it (since 0.11.0 rule h refuses it first, with no person
present: see the 2026-11-02 note on D5 below); rule e is skipped (a `*` has no boundary to compare);
receipts print `UNKNOWN (GRAPHQL MUTATION TARGET NOT RESOLVED, TREATED AS
PUBLIC)`. A document that cannot be read here (stdin, a missing file, a
non-JSON body, an unexpanded `$(…)` as the hook sees it) counts as a
mutation. Read-only queries are unchanged. Resolving the node id with a
live `node(id:)` query was considered and left out: it would put a network
call on the decision path for a gain (skipping one prompt for a known
private target) that does not justify it.

*Added 2026-11-02 (issue #151, decision D5): unresolved writes fail closed
under rule h.* Until 0.10 the guard asked whether a destination was public;
it never asked whether the owner was anyone it had heard of. A destination
under an owner in neither `personalOrgs` nor any engagement resolved to
`private-strict` with unknown visibility, and `gh issue create --body …`, `gh
pr comment`, `gh api -X POST …/issues -f body=…` or a body file in the session
scratchpad has no source working tree for rule e to compare and no deny set
for rule f to scan. Rule g then asked for a person, and a `*` approval
satisfied it. Rule h closes that: with no person present, an owner that is not
registered is refused, and **a write whose owner cannot be named offline counts
as unregistered**. That covers a GraphQL mutation addressed by node id, a `gh
api` write to an endpoint with no owner in its path (`repositories/<id>/…`,
`gists`, `projects/…`), an implicit target overridden by an earlier `export
GH_REPO=…`, a `gh` alias or extension the guard cannot expand, and a target
held in a variable (`--repo "$VAR"`, `GH_REPO=$X`, `gh pr comment "$URL"`).
This departs deliberately from "context rules fail open": the context is not
missing, what is known is that a write goes to an owner nobody has vouched
for, and #113 took the same stance. The consequence to know: a `*` approval no
longer covers a GraphQL mutation, because rule h runs before rule g and no
approval satisfies it. The workarounds are a `gh` verb that names the
repository literally (`gh issue comment --repo <owner>/<repo> …`), the
`repos/<owner>/<repo>/…` form of an API endpoint, or a person running the
command at a terminal. Scripts an agent runs must name their target
literally, or a person runs them. A later, network-only lookup that resolves
node ids and can only lift the refusal (never impose one) is possible but not
built; the refusal ships first so its frequency can be measured.

*Added 2026-11-02 (issue #151, decision D10): a non-interactive `gh pr create`
must name its target.* From a shell with no person present, `gh pr create`
must carry `--repo`, a `GH_REPO` assignment or a URL positional, or it is
refused with `GH_PR_CREATE_IMPLICIT_TARGET`. Without one, gh picks the base
repository itself, from `remote.*.gh-resolved` and remote priority: config
the agent can edit with a plain `git config`, read by the guard at a
different moment than gh reads it. It is the `gh` counterpart of rule a's
`PUSH_IMPLICIT_TARGET`, and like rule a it is unconditional: it needs no
registry, and an approval does not lift it, because the fix is to re-issue the
command, not to get permission. (Without a TTY gh does not consult the API for
a fork's parent (unverified: not documented by gh). It does so only when it can prompt, which is one more reason
a pty wrapper is refused, below.) It covers `gh pr create` only; the other
`gh` write verbs without `--repo` still rely on gh's own pick, as resolved
above, and on rule h's check that the owner it lands on is registered. A person
at a terminal is exempt, since gh can then ask.

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
repo-aegis check --push-ref "$local_ref" --remote "$remote_name" --remote-ref "$remote_ref" --remote-url "$2"
repo-aegis check --range "$range" --remote-ref "$remote_ref" --remote-url "$2"
```

`--remote-ref` (added with prompt approvals, §4a.1) is the ref git will update
**on the remote**, on both paths. `$local_ref` is the source side and only ever
reaches `--push-ref`, for a new ref; an update passes no ref at all. A prompt
approval is bound to the destination ref, so `check` reads it from
`--remote-ref`. A script from before the flag sends none, so no prompt approval
can match there (it fails closed), and `status` / `doctor` report
`HOOKS_SCRIPT_STALE`: run `repo-aegis install hooks` once.

`check` gains, when `--remote-url` is present:

- **`UNREGISTERED_OWNER_EGRESS`** (rule h) — decided first of all, before any
  cache write or visibility lookup: with no person present, the URL's owner is
  not registered (or the URL does not resolve to a GitHub repository offline,
  or the registry is unparseable or written by a newer repo-aegis) → exit 2,
  whatever approvals exist. An encrypted registry is read as no registry: rule h
  is skipped and stderr says so once (it also says the cross-org check used only
  this repository's remote). It is the same code, the same `registeredOwners()`
  and the same registry states as the agent hook and the shim.
- **`CROSS_ORG_PUSH`** — the URL's org is positively disjoint from the repo's
  own trust boundary → exit 2. Deterministic, offline, no TTY involved.
- **`PUBLIC_PUSH_NEEDS_HUMAN`** — destination `publicFacing` (by the same
  `treatAsPublicDestination` rule as §1, so an unknown visibility counts as
  public after one live lookup fails) and no TTY on stderr (`isatty(2)`;
  stdin is always git's ref list, so it is never the signal) and
  `REPO_AEGIS_EGRESS_HUMAN` unset and no live approval (a terminal approval, or
  a prompt approval for exactly this push, §4a.1) → exit 2 with a reason naming
  the destination and the escapes (`repo-aegis approve <org>/<repo>`).
- otherwise one stderr line: `repo-aegis: pushing <ref> → <org>/<repo>
  (<visibility>)`.

The 0.11.0 change to the generated hook script is a comment only (it now says
that `$2` is the URL after all rewriting, once per push URL, and that for a URL
push `$1` equals `$2`), but the script's digest covers its text, so installed
copies report `HOOKS_SCRIPT_STALE` until `repo-aegis install hooks` runs again.
The behaviour that changed is in the CLI the hook calls.

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
2. passes `--version`, `help` and `completion` through untouched, `exec`'d;
3. for **every other invocation** (since the identity work,
   `doc/plan-owner-identity.md` D1; before it only the publishing groups) refuses if the
   pinned enforcement binary is gone, then `exec`s
   `<pinned node> <pinned cli> gh --home <pinned home> -- "$@"`. No shell code runs after the
   `exec`, so no token ever passes through the shim;
4. `repo-aegis gh` makes the same decision `egress-check` makes (`decideEgress` with
   `humanPresent` from `isatty(2)` and `capabilities.ask = false`, a shell has no prompt to
   offer; the same function, `evaluateEgress`) and refuses with the structured reason on
   `deny`. It then chooses the GitHub identity for the call's owner from the registry and
   approvals under the pinned home (`chooseIdentity`, presence from `checkTerminal()`), and
   spawns the real `gh`: with the caller's environment unchanged when no identity applies, or
   with an allowlisted environment plus `GH_TOKEN` when one does (see
   [cli-reference.md](../cli-reference.md#repo-aegis-gh---home-home----gh-args)). It runs
   `gh` and waits (it no longer `exec`s it), prints the receipt keyed on `gh`'s exit code, and
   for `pr create|edit` with a body file **reads the live body back**
   (`gh pr view <n> --json body`, as the same identity) and diffs it against the file, emitting
   `PUBLISHED_BODY_MISMATCH` with byte counts — never content — on difference.

A fault in the identity step on an owner that has a mapping is a refusal (`GH_IDENTITY_UNAVAILABLE`),
not a fall back to the active account; on an owner with none, a warning and `gh` as before.

Step 4 is the design's one deliberate network call inside an enforcement path.
The verb has already published, so the call cannot block anything; a wrong body
found in seconds is a 57-minute exposure not had. It is best-effort with a
short timeout and never changes the shim's exit code on read-back *failure*
(only on a confirmed mismatch).

`uninstall` removes the shim. `doctor` reports whether the shim directory
precedes the real `gh` on `PATH` (`SHIM_NOT_FIRST`) — a shim that exists but is
shadowed is the "hooks installed but not running" failure in a new costume — and
whether the shim on `PATH` is this release's script (`SHIM_STALE`).

This layer is the one with a reach condition, and §4b is about what follows
from it: `PATH` is per-process, so the shim is absent from any shell whose
environment was fixed before the profile line existed.  That is the ordinary
state of an agent's shell, not an edge case.

### 4. Enforcement point: agent pre-command hooks (where offered; richer)

Six agents in current use each expose a pre-command hook that receives the
pending shell command on stdin and blocks on exit 2 (or a deny on stdout):

| Agent | Event | Command field | `ask` available |
|---|---|---|---|
| Claude Code | `PreToolUse`, matcher `Bash` | `tool_input.command` | yes — `hookSpecificOutput.permissionDecision: "ask"` asks for a decision, but under Claude Code's auto mode the auto-mode classifier answers it, not a person (§4a, §4b) |
| Codex CLI | `PreToolUse`, matcher `Bash` (older builds: `shell`) | `tool_input.command` | no — the hook run is marked failed and the tool runs, so `ask` renders as `deny` |
| Gemini CLI (legacy) | `BeforeTool`, matcher `run_shell_command` | `tool_input.command` | not assumed |
| Cursor | `beforeShellExecution` (and observe-only `afterFileEdit` for the write scan) | root `command` | yes on `beforeShellExecution`; accepted but not enforced on `preToolUse` |
| Copilot CLI | `preToolUse`, matcher `bash` (also `PreToolUse`) | `toolArgs` (a JSON-encoded string) `.command`, or `tool_input.command` | yes in the interactive CLI; a deny in the cloud agent and autopilot. Fails closed on a non-zero exit other than 2, so the adapter never exits 1 |
| Antigravity CLI (unverified) | `PreToolUse`, matcher `run_command` | `toolCall.args.CommandLine` | no (not documented): the adapter answers `ask` as deny |

Only the Claude Code row has been exercised live. Every other row is doc-derived (vendor documentation read on 2026-11-09; plan `doc/plan-landscape-recommendations.md` §5.1 has the sources and the exact shapes), and each is registered by hand from `doc/agent-install.md`. Gemini CLI was replaced by Antigravity CLI (<https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/>), whose payload and answer shape differ, so it has its own adapter and `--agent gemini` stays for the old shape. Each host is one adapter module under `packages/cli/src/commands/hook-hosts/` (contract in `types.ts`).

One entry point, `repo-aegis hook guard-egress [--agent claude|codex|gemini|copilot|cursor|antigravity]`,
reads stdin with the same tolerant field lookup `scan-bash-output` uses, runs
`decideEgress` with `capabilities.ask` per the table (default: `false`, the
conservative choice), and emits:

- `allow` → exit 0 and the least output the host accepts as "no objection":
  nothing for most hosts, the host's minimal allow where empty output is not
  accepted (Cursor `{"permission":"allow"}`, Antigravity
  `{"decision":"allow"}`). The output is host-specific, so invariant 2 is "no
  registry read, no I/O, the least output the host accepts", not "silent";
- `ask` → exit 0 with the host's ask JSON (Claude Code:
  `permissionDecision: "ask"`, `permissionDecisionReason: <reason>`); on
  agents without an ask this branch is unreachable because `ask` degraded to
  `deny`;
- `deny` → exit 2 (hosts where exit 2 blocks) or a deny on stdout with exit 0
  (Cursor, Antigravity), structured reason on **stderr** (the channel these
  frameworks feed back to the model), JSON on stdout for frameworks that read
  it.

A payload an adapter cannot read fails **open**, like the guard's own defects
(a guard that walls off every command because a host changed its format is
worse than one that misses a command), but not silently: a hook registered
with the wrong `--agent` or event looks exactly like a working one, so when a
payload names a shell tool with no command field, carries a command in another
host's shape, or is not JSON, the hook prints one fixed stderr line and
writes a `guard-egress-malformed` audit record when the audit log is on. The
text carries a fixed reason and never payload bytes. A non-shell tool stays a
silent skip. The same holds if rendering a decision throws: the hook answers
`error` through the adapter (the host's fail-open answer) rather than exit 1,
which Copilot would treat as a block.

**Known limits of host coverage** (what is still not judged):

- Codex `write_stdin` (text typed into a running session): its field names are
  not in the hook documentation the Codex adapter was built from, so it is
  skipped like any non-shell tool. Copilot `write_bash` / `write_powershell`
  (`input`) and Antigravity `send_command_input` (`Input`) are judged.
- Cursor `preToolUse`: `ask` is not enforced there, so the Cursor adapter
  judges `beforeShellExecution` only; a `preToolUse` shell payload is reported
  as not judged.
- Cursor `afterFileEdit` is detection only (the edit already happened).
- Any host's tools that run code without a shell tool (editors, MCP servers,
  a script an earlier call wrote) are outside this hook; the pre-push hook and
  the `gh` shim are the layers behind it.

What this layer adds over §2 and §3: it runs **before** anything executes, it
sees the **whole compound command** — so the shape rules a–c, b′ and b″
apply here and nowhere else, since git and `gh` receive a command the shell
has already resolved (the shim, which sees one `gh` invocation and its real
environment, also applies a′ and reads `GH_REPO` itself) — and on Claude Code it turns "GitHub shared-state mutations need
confirmation" from a sentence in an instructions file into a prompt the human
must answer.

`install claude-md` registers it alongside the existing `check-write` hook via
the generalised `mergeHookOnEvent("PreToolUse", "Bash", …)`; it coexists with
any user-authored hook on the same matcher. Equivalent snippets for the other
two agents go in `doc/agent-install.md`.

### 4a. Human approvals — the person declares themselves in advance

*Added 2026-09-12, after the first day of running the guard.* Rule g needs
a person, and the guard's only test for one is a TTY on stderr. The
consequence on a machine where agents do the work: every publish to a
public repository — the push, the PR, the merge, the tag, the release —
must be typed by the operator, because the instruction they actually give
("push it") lives in a chat the guard cannot see; and the one escape,
`REPO_AEGIS_EGRESS_HUMAN=1`, is exactly what an agent must never set. On
the first release cut under the guard that was four terminal round-trips,
and on Claude Code in auto mode the hook's `ask` never reached the human
at all: the auto-mode classifier answered it (with a refusal).

An **approval** moves the human signal to where every layer can read it:

```
repo-aegis approve <org>/<repo> [--ref <ref>] [--ttl 15m] [--note …]
repo-aegis approve --list | --revoke <id|all>
```

- **Minting needs a TTY on stderr, and does not honour the env escape.**
  An agent's shell has neither, so an agent cannot mint its own approval —
  the property the env-var rule protected, now enforced rather than
  instructed. Since 0.11.0 the terminal must also be a person's (see "What
  counts as a person", below). `--list` and `--revoke` publish nothing and
  need no TTY.
- **Scoped and short-lived.** `<org>/<repo>`, `<org>/*`, or `*` (which since
  0.11.0 is no longer a global wildcard: see the D7 note below);
  optionally one ref (`refs/heads/x` and `x` are the same). Default 15
  minutes, never more than 24 hours. Stored at
  `$REPO_AEGIS_HOME/egress-approvals.json` (0600). Not consumed on use: a
  push passes the agent hook and then the pre-push hook, and a single-use
  token consumed by the first would refuse at the second — the TTL is the
  bound.
- **Rule g only.** Every layer (agent hook, `gh` shim, git pre-push)
  treats a matching live approval as "human present" for rule g and for
  nothing else: the shape rules, the cross-org boundary and the payload
  scan run first and still refuse. A destination-less irreversible verb
  (`npm publish`) is covered only by `*`.
- **Audited both ways.** The mint (`egress-approval-mint`), every use
  (`egress-approval-use`, with the layer), and every revoke are audit
  records; the agent hook returns an explicit `allow` whose reason names
  the approval, so a framework that shows decision reasons shows it.
- **Refusals say how.** Rule g's reason now ends with `repo-aegis approve
  <org>/<repo>`, so the person reading a refusal in a tool result knows
  the one command to type.

What this does not change: `REPO_AEGIS_EGRESS_HUMAN` keeps its contract
(one invocation, a human's hand on the keyboard); the agent-side rule
stays "never set it, never work around a refusal" — the recovery is now
"ask the human for an approval" instead of "ask the human to run it".

#### 4a.1. Prompt approvals — a yes at the agent's own prompt carries down

*Added after 0.13.1.* On Claude Code the hook's `ask` is a permission prompt, and
a person's yes there used to reach nothing below it: the push then met the
pre-push hook, which wanted a person again, and the operator was sent to a
terminal to type the command the agent had just been allowed to run. The honest
mistake the guard stops is private content published to a public repository, or
an irreversible verb, with no person's yes; a yes at the prompt **is** a
person's yes, for **this command only**.

The agent hook writes a **prompt approval** when it asks, and the two layers
below the prompt (git's pre-push hook and the `gh` shim) may honour it:

- **The record.** One file per approval,
  `$REPO_AEGIS_HOME/prompt-approvals/p<8 hex>.json` (0600, directory 0700), written
  by `recordPromptApproval` in core (`egress-approval.ts`): the exact verb
  (`git-push`, `gh-pr-create`, …), `org`/`repo`, the destination `ref` for a push
  or the `endpoint` for a mutating `gh api`, the permission mode, the host's
  session id (audit only, not matched), and an expiry **120 seconds** after
  creation. The lifetime is a constant: no flag, no environment variable. It is
  not consumed on use (pre-push sees one push; the shim sees one command).
- **A separate directory, not the terminal store.** `egress-approvals.json` and
  every terminal matcher (`findApproval`, `findLoginApproval`,
  `findAccountBoundApproval`, `findApprovalWithAnyLogin`,
  `findUncoveringStarApproval`) are unchanged and never read it. An older pinned
  binary does not know the directory exists, so it cannot mistake a prompt record
  for a terminal approval (a terminal approval with no ref matches every verb).
  One file per approval also means no read-modify-write and no lock between
  concurrent hooks. A prompt id starts with `p`; a terminal id is eight hex
  digits and never does.
- **What it is bound to, exactly** (`promptBindingOf`; no wildcard anywhere).
  `git push` binds the **destination** side of the first refspec, normalised:
  `main`, `HEAD:main`, `+feat:refs/heads/rel` and `refs/tags/v1` give `main`,
  `main`, `rel` and `v1`; bare `HEAD` gives the current branch (read with
  `git symbolic-ref`, only on the ask path). A `gh` verb that acts on one numbered
  or tagged thing (`gh pr|issue edit|merge|comment|review <n>`, `gh release
  create|edit|upload <tag>`) also binds that number, URL or tag exactly, so a yes
  to merging #12 is not a yes to merging #13; a command that names none (`gh pr
  create`, a bare `gh pr merge`) binds the repository only, and a record that
  names a target never covers a command that names none, nor the reverse. A
  mutating `gh api` binds the endpoint **and the HTTP method** (gh's POST for a
  call with only fields or a body), so a yes to a PATCH is not a yes to a DELETE
  of the same endpoint. Nothing is written, so nothing below can honour a yes,
  when the refspec is missing or unparsed, is a delete (`:main`, `--delete`,
  `-d`, or an unambiguous prefix such as `--dele`), holds a glob, variable or
  revision syntax, or names a detached `HEAD`; when the destination is unresolved (GraphQL mutation, opaque URL, your
  own account, an ambiguous target), a wildcard, or not a plausible GitHub name;
  for a verb with no repository destination or no layer below the hook (`gh gist
  create`, `npm publish`, an unrecognised `gh` shape); or for a `gh api` with no
  endpoint. A second refspec, `--follow-tags` or `--tags` is not bound: pre-push
  refuses the extra ref, and re-running that command gets its own prompt.
- **Where it is honoured.** Pre-push: verb `git-push`, the same org/repo, and a
  ref equal to the `--remote-ref` the script passes (§2); a terminal approval is
  tried first. The `gh` shim: the verb, org/repo and (for `gh api`) endpoint from
  the shim's own parse of argv (`egress-check.ts`), after the terminal finder.
  A record for a PR never lets a push through, and the reverse. Each use is an
  `egress-approval-use` audit record with `source: "prompt"`. The credential
  helper and the `gh` identity layer consult **no** prompt approvals: a write as
  a person-mapped account still needs a terminal approval carrying that login.
- **The hook never reads them (F1).** The record is written **before** the person
  answers, so after a "no" it is still live. If the hook honoured it, a second,
  different command to the same repository would pass on the first one's record.
  `decideEgress` therefore gets `findPromptApproval` only from the layers below
  the prompt; the hook passes none, so after a "no" every command asks again.
- **Only where a person answered (F9).** The hook writes only when the adapter
  is `claude` and the payload's `permission_mode` is exactly `default` or
  `acceptEdits` (case-sensitive; an allowlist, not a denylist). In `auto` a
  classifier answers the prompt; in `bypassPermissions`, `plan` and `dontAsk`
  nobody does; a missing, unknown or non-string mode counts as none of these.
  The ask reason says which case applies, in one fixed sentence (no payload
  text): *a yes here lets this `<verb>` to `<org>/<repo>` [ref `<ref>`] through
  git's pre-push hook / the gh shim for 2 minutes; any other command asks
  again*, or *in this permission mode a yes does not reach the layers below; a
  person mints an approval from a terminal*. Copilot, Cursor, Antigravity and
  Codex never write one.
- **Compound commands.** The `ask` from `decideEgress` carries `asked`, every
  (intent, target) that judged `ask` (a `git push … && gh pr create …`, or a
  remote with several push URLs); the hook writes one record per eligible entry.
- **An agent cannot write one.** The permissions deny list (`install claude-md`)
  includes `Edit(<home>/prompt-approvals/**)`, and the mint command is still
  refused in agent text. `prompt-approvals/` is runtime state like
  `egress-approvals.json` and has the same, absent, uninstall treatment.
- **Audited.** Each record is an `egress-approval-mint` with `source: "prompt"`
  (verb, scope, ref or endpoint, expiry, mode, session,
  `layer: "hook guard-egress"`), never the command text. `approve --list` shows
  both kinds with their `source`, and `--revoke p…` / `--revoke all` cover prompt
  records.

- **Typing ends it.** `install claude-md` also registers a UserPromptSubmit hook,
  `repo-aegis hook prompt-submit` (next to the others, in the managed drop-in or in
  `settings.json`; `--uninstall` removes it). The moment the person types, it
  deletes every prompt approval (terminal approvals are untouched). It is silent,
  exits 0 on every path and **never blocks the prompt**: its pinned command fails
  open (exit 0) where every guard fails closed (exit 2), because exit 2 on this
  event would swallow the person's own message. `repo-aegis approve --revoke
  prompt` does the same by hand. So a yes followed by the person typing something
  before the push happens means **the push asks again**, and so does a "no"
  followed by the person's next message; only a command that runs straight after
  the answer, with the person saying nothing in between, can use the yes.
- **Headless `claude -p` has nobody to answer.** The hook input's
  `permission_mode` reads `default` there too, and the hook input has no field that
  tells a headless run from an interactive session (checked against
  code.claude.com/docs/en/hooks: the common fields are `session_id`, `prompt_id`,
  `transcript_path`, `cwd`, `scratchpad_dir`, `permission_mode`, `effort`,
  `hook_event_name`, `agent_id` and `agent_type`; nothing names print mode or the
  SDK). Process ancestry is not used for this, because `ps` fails inside the
  sandbox. For scripted `claude -p` runs, pass an explicit `--permission-mode` that
  is not `default` or `acceptEdits` (for example `dontAsk` or
  `bypassPermissions`); otherwise prompt approvals are written with nobody to
  answer the prompt, and the residual below applies to every ask.
- **Not from the future.** A record whose `createdAt` is more than 5 seconds ahead
  of the reader's clock is dropped, so a hand-made file cannot outlive its two
  minutes by being dated ahead.

*Known residual (accepted).* Because the record exists before the answer, a
command the hook does **not** recognise as egress (a script, a Makefile target,
any shape the parser drops) could repeat the **identical** verb, destination and
ref within 120 seconds and pass the lower layers after a "no", **unless the
person types in between** (the UserPromptSubmit hook above). It is bounded by
the exact binding and two minutes, and it is not matched on session, because the
lower layers cannot see one. If the person takes more than 120 seconds to
answer, or the command runs a long build before `git push`, the record has
expired: pre-push then refuses (its text says a yes covers 2 minutes), and a
re-run prompts again. Terminal `--ref` approvals are bound to the local ref at
pre-push and never match an update of an existing branch; making them bind
`--remote-ref` too is a separate change.

*Added 2026-11-02 (issue #151, decision D7): `*` covers only your own orgs.*
A `*` approval used to match every owner, so one minted for a personal release
window also covered publishing to a customer's public repository. Since 0.11.0
a `*` approval covers a destination only when its owner is in `personalOrgs`,
and a destination-less verb (`npm publish`), which was already covered only by
`*`. A customer's repository needs `approve <org>/*` or `approve <org>/<repo>`;
an allowed upstream needs `approve <owner>/<repo>`. `<org>/*` and
`<org>/<repo>` behave as before, but rule h runs first, so no approval, of any
form, helps with an owner that is not registered. An operator with no
`personalOrgs` therefore finds that `*` covers `npm publish` only. `approve
'*'` says what it covers when it is minted, and a refusal that finds a live `*`
that does not apply names the approval and says why.

| Approval | Personal org repo | Customer org repo | Allowed upstream (PR, issue, comment verbs) | Unregistered owner | `npm publish` |
|---|---|---|---|---|---|
| `*` | covered | not covered | not covered | not covered (rule h refuses first) | covered |
| `<org>/*` | covered | covered | covered, when `<org>` is the upstream's owner | not covered (rule h refuses first) | not covered |
| `<org>/<repo>` | covered, for that repo | covered, for that repo | covered, for that repo | not covered (rule h refuses first) | not covered |

"Covered" means the approval satisfies rule g for a publish there. It never
lifts a shape rule, rule e, rule f or rule h. An approval minted for an
unregistered owner is accepted but inert, and `approve` warns that it will not
help until a person registers the owner (`engagements add`, or `upstreams add`
for a fork's upstream). An upstream is never "ours": `git push`, merge,
release, repo and workflow verbs and `gh api` writes to it stay refused by
rule h, and rules e–g still apply to the PRs and issues it does admit.

#### What counts as a person

Rules g and h, `approve` and every owner add rest on one question: is a person
at this terminal? A TTY on stderr is not proof. `script -q /dev/null <cmd>`,
`unbuffer`, `expect`, `tmux new -d '…'` and `ssh -tt localhost` all hand an
agent's child a pty. Since 0.11.0 the answer comes from several layers, none
of which is proof:

- **`EGRESS_PTY_WRAPPER`** refuses a publish run under a pty wrapper, so the
  command never reaches a layer that would read its pty as a person.
- **`AGENT_RAN_HUMAN_COMMAND`** refuses any Bash command whose text runs
  `repo-aegis approve`, `engagements add --personal-org|--github-org`,
  `upstreams add` or `init --migrate-classify|--force`, wherever it sits
  (`bash -c`, a heredoc, a multiplexer argument), with or without a terminal.
  The accepted false positive is a quoted mention next to a repo-aegis word.
- **`AGENT_DETACHED_SESSION`** refuses starting a detached session in any
  command: `tmux new -d`, `tmux new-window` / `send-keys`, `screen -dm`,
  `setsid`, `daemonize`, `nohup … & disown`. A process that outlives the
  command is re-parented to init, where no ancestry check sees an agent above
  it.
- The CLI **reads the process ancestry**. For `approve` and the owner adds,
  stderr must be a TTY, no agent host (`claude`, `codex`, `gemini`) or pty
  wrapper may sit above the process, `CLAUDECODE=1` must not be set, and the
  chain must reach a login session, `sshd`, a terminal emulator or an attached
  multiplexer. If the chain cannot be read (no `ps`, as in an agent's sandbox)
  the answer is "not a person". Rules g and h make the opposite choice for an
  unreadable or unrooted chain, because refusing a person's own publish is the
  worse failure there; a recognised agent or wrapper ancestor means "not a
  person" for them too.
- `REPO_AEGIS_EGRESS_HUMAN` stays honoured for rules g and h only, and never
  for `approve` or an owner add.

All of this is advisory outside the agent's sandbox: a same-user agent that
can run code outside it can forge a process name, an environment variable, or
write the approvals file or the registry directly. Inside the Claude Code
sandbox no pty can be opened and `ps` is blocked, so the gates fail closed, and
`install claude-md` merges Edit denies over the registry, approvals, markers,
hooks and shim into the sandbox's write-deny list. The lasting fix is a signal
an agent cannot forge, such as a Keychain item with a user-presence (Touch ID)
ACL; it is a tracked follow-up (R12).

### 4b. The layers do not degrade into each other — rule g′

*Added 2026-09-12, from a finding on the host that runs this guard.* The
three enforcement points are described above as defence in depth, which
invites the assumption that losing one leaves the rest. For rule g that is
false, and the reach of each layer is the reason:

| Layer | Reaches an agent shell? | Rule g outcome |
|---|---|---|
| git pre-push hook (global `core.hooksPath`) | yes — `PATH`-independent | refuses outright (no TTY) |
| `gh` shim | **only if `PATH` carries it** | refuses outright, exit 2 |
| agent pre-command hook | yes — registered in the agent's settings | `ask` where the framework has one |

The shim is on `PATH` only for processes started after the profile line
that puts it there. An agent host that snapshots its launcher's
environment — Claude Code writes a literal `export PATH=…` into its shell
snapshot — hands every Bash call the `PATH` the launcher had, so a session
started from a window that predates `install shim` never sees it, however
correct the profile is. `which gh` in such a shell resolves to the real
`gh`, and `doctor` says `SHIM_NOT_FIRST` — but only if someone runs it.

That leaves the agent hook alone on rule g for `gh` verbs, and its answer
there is `ask`. An `ask` is a refusal only while something below it can
hold the command when the ask is not answered by a person — and on Claude
Code in auto mode an `ask` is answered by the auto-mode classifier, not a
human (the same observation §4a is built on). Observed 2026-09-12 from an
agent shell (recorded in `CHANGELOG.md` `[0.10.1]`, where it was fixed): `gh pr create` against a public repository reached GitHub;
the identical command with the shim's directory prepended to `PATH` was
refused with `PUBLIC_EGRESS_NEEDS_HUMAN`, exit 2.

So the hook reads its **own** `PATH` — the environment its host will hand
the shell it is about to permit, not a guess about the caller — and passes
`capabilities.ghShimOnPath` to the decision function. When it is `false`
and rule g fires on a `gh-*` verb, the decision is `deny` with
`SHIM_UNREACHABLE_NEEDS_HUMAN` rather than `ask`.

Four boundaries, each chosen rather than fallen into:

1. **`gh` verbs only.** `git push` keeps the pre-push hook, which is
   `PATH`-independent and already refuses; `npm publish` has no shim to be
   unreachable, so this `PATH` fact says nothing new about it. Denying
   either on a `PATH` condition would be an unrelated behaviour change
   smuggled in under this one.
2. **Only where the decision would have been `ask`.** An earlier rule's
   `deny` keeps its own code; an `allow` — including an approval-backed
   allow, which is decided before the ask/deny split — must never become a
   `deny` because of a `PATH` fact. An approval is the cheap fix here, and
   it would be perverse if the missing shim defeated it.
3. **Its own code.** The operator's fix is a `PATH` or an approval, not a
   prompt, and the agent guide's error-code table is how a refusal gets
   read. The reason names both halves of the fix.
4. **Unknown ≠ absent.** The hook fails open on its own defects, so a
   `PATH` lookup that *throws* leaves the capability unset and changes
   nothing. A lookup that succeeds and says the shim is absent is a fact,
   and is acted on. The predicate is `ghShimIsFirstOnPath`, the same
   resolver `doctor`'s `SHIM_NOT_FIRST` uses — a second one that
   disagreed would let `doctor` call a shim healthy while the guard
   believed otherwise.

Agents other than Claude Code are unaffected: `capabilities.ask` is
already false for them, so rule g denies before g′ is reached.

### 5. Receipts

After a permitted egress, one line to the agent: `PUBLISHED → <org>/<repo>
(<visibility>, class <class>): <ref | PR #n | tag>`. On Claude Code via a
PostToolUse hook (`hook egress-receipt`, `additionalContext`); via the shim's
stderr elsewhere; via the pre-push stderr line for git. A model that has just
pushed to the wrong repository will skim past twenty lines of git output; it
will not skim past one line that says **PUBLIC** and a name it did not intend.

**A publish is confirmed, not assumed.** The shim and the pre-push hook have
the real thing to key on — the command's exit code — and use it. The
PostToolUse hook has only the tool's captured output, and it originally
read that output for *failure* and called everything else a publish. That is
the same silent-skip shape as #97 one layer out: absence of evidence became
evidence. It broke in the obvious way on 2026-09-12, when a push that died as
`ssh_dispatch_run_fatal: … Broken pipe` (no boundary before `fatal`, so
`\bfatal:` missed it) beside a German `Schwerwiegend:` (no English pattern
covers it) was receipted `PUBLISHED →` with zero refs to name.

So the hook now requires positive evidence wherever the tool emits any:

| Verb | Evidence of a publish |
|---|---|
| `git push` | a `<src> -> <dst>` ref line not flagged `!`, or `Everything up-to-date` |
| `gh pr create` / `gh pr edit` | the pull-request URL |
| `gh release create` | the release URL |
| everything else | — no distinctive success output; failure scan only |

Locale is the reason this must be evidence and not text: git's flag column
(`!` refused, `=` already current, `*` created) and the `->` arrow carry no
translation, while every word beside them does. With no evidence and no
failure signal the line reads `EGRESS UNCONFIRMED → …`, which is what is
actually known; a partly refused push still says `PUBLISHED` — bytes reached
the remote — and names how many refs were refused.

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
| Non-interactive publish to an owner nobody registered (right bytes, a stranger's repository), including via `GH_REPO`, a URL positional, an opaque API endpoint, a GraphQL mutation, `insteadOf` or an ssh alias | Rule h (`UNREGISTERED_OWNER_EGRESS`) at all three layers, judged against `personalOrgs` and engagement `githubOrgs` only (no approval, cache or local class counts); an unresolved destination fails closed; the resolver names the owner gh or git will actually use |
| Agent registering an owner or upstream, or emptying the owner set, to undo rule h | `engagements add --personal-org\|--github-org`, `upstreams add`, `init --migrate-classify` and any change that leaves zero owners need a person at a terminal (`OWNER_ADD_NEEDS_TTY`, `OWNER_SET_EMPTY_NEEDS_TTY`); `install claude-md` adds Edit denies over the registry; every mutator validates in memory first (`REGISTRY_WOULD_BE_INVALID`) |
| Agent steering the shim, the pre-push hook, `gh` or `git` through the environment, or through a state change earlier in the same command | Shape rules b′ (`EGRESS_ENV_OVERRIDE`) and b″ (`EGRESS_AFTER_STATE_CHANGE`) at the hook; below the hook this is residual (R2) |
| Agent faking a person with a pty wrapper, a detached session or a text-level `approve` | `EGRESS_PTY_WRAPPER`, `AGENT_DETACHED_SESSION`, `AGENT_RAN_HUMAN_COMMAND`; process-ancestry check in `approve` and the owner adds. Advisory outside the agent sandbox (R12) |
| Publishing without `gh` or `git`: a raw HTTP client against the GitHub API, or `gh auth token` next to a network call | `GITHUB_API_VIA_HTTP_CLIENT`, `GH_AUTH_TOKEN_NETWORK`; a speed bump (an interpreter's `-c` text still gets through) |
| Agent crashing the hook with a command line built to blow up (nested `sh -c '"$@"; "$@"' …` multiplies its text at every level), since a hook that dies does not block | Bounded expansion: 64 KiB per positional substitution, 4 MiB of nested text per line, at most 64 intents judged one by one plus every shape-rule label and one fail-closed intent for the rest; past a bound the segment is unresolved and fails closed |
| A program written at run time (`bash x.sh`, a script written and run in one command) | Not visible to the hook, which reads command text only; the `gh` shim and the pre-push hook judge the real command when it runs (residual) |
| Agent "fixing" a refused command by rewriting it silently | Hook is decision-only; `updatedInput` is never emitted |
| Own-project material entering a customer repository | `selfIdentity` stem, deny-set-included only for `customer-coupled` destinations; payload scan against the destination's rules |
| Destination controls silently inert on an unclassified public repo | `doctor` `CLASS_VISIBILITY_UNRESOLVED` / `PERSONAL_ORG_UNREGISTERED`; `public-eligible` treated as public-facing even with no cache; an unknown visibility treated as public at every enforcement point (issue #114) |

| Topic | Decision |
|---|---|
| Egress hook is decision-only | `hook guard-egress` returns `allow`/`ask`/`deny`; it never emits `updatedInput`. Rewriting a command reconstructs the implicit-destination defect. |
| `ask` degrades to `deny` | On a framework without an `ask` decision, `ask` becomes `deny` with a "have a human run or approve this" reason — never `allow`. |
| An `ask` needs a layer beneath it | Rule g′: on a `gh` verb, where the enforcing framework reports the `gh` shim is not first on its `PATH`, `ask` becomes `deny` (`SHIM_UNREACHABLE_NEEDS_HUMAN`) — an unanswered `ask` with nothing below it is not a refusal. `git push` (pre-push hook) and `npm publish` (no shim) are out of scope; an unknown `PATH` changes nothing. §4b. |
| Shape rules are unconditional; context rules fail open (except rule h) | Rules that need no registry/class/visibility (`PUSH_IMPLICIT_TARGET`, `EGRESS_AFTER_CD`, `EGRESS_UNGUARDED_CHAIN`, `PAYLOAD_MODE_DEPENDENT_PATH`, `EGRESS_ENV_OVERRIDE`, `EGRESS_AFTER_STATE_CHANGE`, `GH_PR_CREATE_IMPLICIT_TARGET`, `DOT_GH_WRITE_NEEDS_BOT`, `EGRESS_PTY_WRAPPER`) always apply. Rules that need context never block on missing context, but may still `ask`. Rule h is the exception: it refuses a write whose owner it cannot name, and asks or refuses on a registry that is unparseable or from a newer repo-aegis. |
| Human-presence test | `isatty(2)` on stderr that no agent host or pty wrapper sits above, or `REPO_AEGIS_EGRESS_HUMAN=1` (rules g and h only). Same contract as `REPO_AEGIS_WAIVE_NONINTERACTIVE=1`: documented human-only; agents are instructed never to set it. `approve` and the owner adds do not honour the env escape and also require the process chain to reach a login session, `sshd`, a terminal emulator or an attached multiplexer. A speed bump, not proof of a person; the sandbox is the boundary. |
| Rule h: only the registry decides | `owner ∈ personalOrgs ∪ engagements[*].githubOrgs`, or an exact `owner/repo` in `allowedUpstreams` on a PR / issue / comment verb. Not the destination cache, not a local `repo-aegis.class`, not an approval, not the authenticated `gh` login (the active account changes under other sessions; `doctor` reports unregistered logins instead). Missing registry, no owners, or an encrypted registry (read as none): skipped, with a note. Unparseable or newer-schema registry: ask where the host has a prompt, else refuse (pre-push always refuses). |
| Unresolved writes fail closed | A write whose owner cannot be named offline is treated as unregistered (D5). The deliberate departure from "context rules fail open". |
| `*` approvals cover only `personalOrgs` and destination-less verbs | D7. Customer orgs need `<org>/*` or `<org>/<repo>`; upstreams need `<owner>/<repo>`. |
| A non-interactive `gh pr create` names its target | D10. `GH_PR_CREATE_IMPLICIT_TARGET`, unconditional; `gh pr create` only. |
| Adding an owner needs a person | D8. No env escape, no approval; the audit record for an add carries a kind and a count, never owner names (owners can be customer names, and the audit log can be read back into a transcript). |
| Two network calls, neither a condition for refusing | The `gh pr create/edit` read-back runs after the verb has published, cannot block, is best-effort with a timeout, and affects exit status only on a confirmed mismatch. The pre-decision visibility lookup (issue #114) runs only when a destination's visibility is unknown, is best-effort with a 5-second timeout, and can only turn `unknown` into an answer; when it fails the destination stays unknown and is refused without a person. |
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
  fail-open on unparseable remote; `public-eligible` with uncached visibility
  ⇒ public-facing; any other uncached visibility ⇒ public-facing after a
  stubbed lookup fails, allowed after it answers `private` (and cached); `ask`→`deny` degradation when
  `capabilities.ask` is false; `humanPresent` from both TTY and env. Rule g′:
  a `gh` verb asks with `ghShimOnPath: true` and denies with `false`; an unset
  capability changes nothing; `git push` and `npm publish` are unaffected by
  `false`; an approval-backed allow and an earlier rule's deny both survive it.
- **`hook-guard-egress.test.ts`** — subprocess tests feeding Claude Code,
  Codex-shaped and Gemini-shaped stdin; exit codes and stdout/stderr channels
  per decision; **no `updatedInput` ever present** (oracle test over the whole
  serialised output); rule g′ end to end, with and without a shim on the
  subprocess's `PATH`.
- **`install-shim.test.ts`** — `ghShimIsFirstOnPath` agrees with `checkShim`
  on every case but the stale one, where a reachable shim is still reachable.
- **Prompt approvals (§4a.1)** — `egress-prompt-approval.test.ts` (binding,
  mode allowlist, file modes and TTL, exact match, malformed files, invisibility
  to every terminal matcher, revoke and list);
  `egress-policy-prompt-approval.test.ts` (the hook's decision ignores a
  matching record, the shim honours it, `asked`);
  `hook-guard-egress-prompt-approval.test.ts` (the built hook: modes, the
  never-read invariant after a "no", Copilot/Cursor/Codex, failures, audit, and
  `hook prompt-submit`: silent, exit 0, terminal approvals survive);
  `check-egress.test.ts` (pre-push: remote ref, other verb, expiry, old script);
  `egress-check.test.ts` (the shim); `agent-publish-path.test.ts` (a real
  `git push` through the rendered pre-push script: `default` passes, `auto` is
  refused).
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
  mode before the docs claim it forces a prompt. *Done 2026-09-12, and the
  answer was no: under auto mode the classifier answers the `ask`, not the
  person. §4a and §4b are what followed — an approval the human mints in
  advance, and `deny` in place of an `ask` that nothing beneath it could
  enforce.*

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

- **Stopping an agent that sets out to get around the guard.** repo-aegis
  stops *accidental* leaks: into public repositories, and from one customer to
  another. It is not a wall against a deliberate bypass.
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
- **Recalling objects already pushed.** GitHub can keep serving a commit by its
  sha after a force-push or ref deletion, for example through cached views, forks
  and pull requests that reference it
  ([GitHub: removing sensitive data from a repository](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository)),
  and GitHub publishes no schedule for when it stops. Everything here is
  prevention.
