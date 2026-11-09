# repo-aegis inside an agent's sandbox

Coding agents increasingly run shell commands inside an OS sandbox. Claude Code
does this by default on macOS (Seatbelt) and sets `SANDBOX_RUNTIME` in the
sandboxed process. This page says what works there, what does not, and what to
configure. It was written on 2026-11-09. Items marked **unverified** were taken
from vendor documentation and have not been run end to end.

## What works inside the sandbox

- **Every gate that only reads local files:** the write and egress hooks, the
  pre-commit and pre-push scans, `check`, `status` and `doctor`.
- **Reads through `repo-aegis gh`** whose App token cannot be minted. Since
  0.13.0 they fall back to the active `gh` account and print one warning line.
- **The process-chain check of the git credential helper.** The sandbox blocks
  the process list, which used to refuse every agent HTTPS push with
  `AGENT_PUSH_CHAIN_UNREADABLE`. Since 0.13.0, a live account-bound approval
  (`repo-aegis approve <owner>/<repo>` or `<owner>/*`, run by a person in a
  terminal) covers it for that owner and that approval's lifetime.

- **A yes at Claude Code's permission prompt for a publish.** In `default` and
  `acceptEdits` mode, when the hook asks about a `git push` or a `gh` write and
  the user says yes, that yes now carries down for **that exact command** (same
  verb, same repository and ref or endpoint) for 2 minutes: git's pre-push hook
  and the `gh` shim honour it, so the user is not sent to a terminal for a
  command they just approved. It does **not** carry in `auto` mode (a classifier
  answers the prompt, not a person), `bypassPermissions`, `plan` or `dontAsk`,
  and the prompt says so. Run `repo-aegis install hooks` once after upgrading:
  the pre-push script now passes the ref being updated, and an older script
  cannot honour the yes (`repo-aegis doctor` reports it as a stale hook). A write
  as a person-mapped account still needs an approval minted by a person from a
  terminal.

## What does not work inside the sandbox

**Minting a GitHub App token.** taaad-signer reads the macOS keychain, shows a
Touch ID prompt and calls api.github.com. From inside Claude Code's sandbox it
fails before the prompt appears (observed 2026-11-09: no Touch ID dialog). So
an agent WRITE that needs the App's token (a push over HTTPS, or `gh pr create`
as the App) fails with `GH_IDENTITY_UNAVAILABLE`. Since 0.13.0 the message
names taaad's failing step, and says that the agent sandbox is the likely
cause.

Claude Code's documentation describes no setting that keeps the sandbox on and
still allows the keychain or LocalAuthentication. `sandbox.network.allowMachLookup`
exists, but nothing documents whether it covers these services
([sandboxing docs](https://code.claude.com/docs/en/sandboxing)).

## What to configure

Run the publishing commands outside the sandbox and keep everything else in it.
Claude Code's `sandbox.excludedCommands` takes `Bash(...)` permission-rule
patterns. A matching command runs with no filesystem restriction and no network
proxy. The docs' own example excludes git's network verbs. repo-aegis's hooks
still judge the command before it runs, because hooks run whether or not the
command is sandboxed.

A person adds this to their **user** settings (`~/.claude/settings.json`), not
to a repository's `.claude/settings.json`: a repository should not be able to
widen its own sandbox.

```json
{
  "sandbox": {
    "excludedCommands": [
      "Bash(git -C * push *)",
      "Bash(git push *)",
      "Bash(gh pr create *)",
      "Bash(gh pr merge *)",
      "Bash(gh release create *)"
    ]
  }
}
```

**Unverified:**

- Whether `*` in the middle of a pattern (`git -C * push *`) matches
  `git -C /abs/path push origin main`. repo-aegis requires that `-C` form for
  agents. If it does not match, the push stays sandboxed and fails as above.
- Whether a command run outside the sandbox also takes its child processes
  (git → credential helper → taaad → taaad-signer) out of it. The docs do not
  say so.

Check both once with `/sandbox` (the Config tab shows the resolved settings)
and a real push, then remove this paragraph.

Until then the fallback is the one repo-aegis's refusal gives: a person runs
the publishing command from a terminal, or lets that one command run outside
the sandbox when the agent asks.

## Related

- [agent-guide.md](agent-guide.md): the refusal codes, including
  `AGENT_PUSH_CHAIN_UNREADABLE` and `GH_IDENTITY_UNAVAILABLE`.
- [plan-landscape-recommendations.md](plan-landscape-recommendations.md)
  Phase U: why this path was fixed, and the acceptance test that pins it.
