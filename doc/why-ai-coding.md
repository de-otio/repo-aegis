# Why repo-aegis matters for AI-assisted coding

> The dominant new leak vector in multi-customer work, why prose-only
> rules don't catch it, and how the deterministic gate is shaped to
> compensate.

AI coding agents (Claude Code, Cursor, Copilot, Aider, Cline, Continue)
absorb whatever context they're given — file paths, tool output, prior
conversation turns. Customer names that appear in any of those get
reached for as concrete examples in subsequent writes, even when a
`CLAUDE.md` / `.cursorrules` rule says otherwise. **Recency in
conversation outweighs prose rules.** A token mentioned ten times in
the current session — typically because the user is *handling* a leak
of that value, or just working on that customer's code — sits at the
top of the agent's attention and gets emitted by reflex when a
"concrete example" is needed.

This is the dominant new leak vector for anyone using AI tooling on
multi-customer work. It compounds three other AI-specific dynamics:

- **Agents write fast.** A leak that lands between "agent generates"
  and "human notices" has a much shorter window than for hand-written
  code. Catching the slip on the way to disk matters more than careful
  review afterwards.
- **Agents are now driving git.** Claude Code, Aider, Cursor's
  compose, etc. don't just write files — they stage, commit, sometimes
  push. The traditional "human reviews diff before commit" loop is
  partially automated. The gate has to be readable by the agent, not
  just the human.
- **Multi-customer machines confuse agents.** An agent has no innate
  sense of "which customer is this repo." It has to be told,
  per-repo, in a form it can read at write time.

repo-aegis is designed around that failure mode:

- **Deterministic gate, not a rule.** Pre-commit hook running
  `repo-aegis check --staged` catches what soft instructions cannot
  filter. Same for a Claude Code PostToolUse hook on every
  Write/Edit/MultiEdit — empirically the highest-leverage single
  leak-prevention mechanism for AI coding workflows.
- **Self-correction loop, not just a block.** `repo-aegis check`
  returns structured hit data with `--json` and stable exit codes
  (0 = clean, 1 = hit, 2 = error). The agent reads the output,
  identifies which engagement's marker was tripped, and revises on
  the next turn. Self-catch is empirically more reliable than
  pre-write blocking — the agent gets concrete feedback ("you
  wrote `betaco` in a customer-A repo") rather than an abstract
  refusal.
- **Engagement-scoped deny sets.** Inside customer-A's own repo,
  customer-A's strings legitimately appear in code, tests, configs.
  A flat marker list would false-positive on every legitimate
  reference, training the agent (and the user) to ignore the hook.
  repo-aegis computes a per-repo deny set from `repo-aegis.engagement`
  in `.git/config`: customer-A's markers are excluded inside
  customer-A's repo, but customer-B's markers, your other clients'
  markers, and your org-wide always-block markers are still enforced.
  Zero false positives in the legitimate case; full coverage in
  every other.
- **One verb the agent can invoke.** "Allow references to customer A
  in this repo" maps to `repo-aegis allow "customer A"` — fuzzy name
  match against the engagement registry, then a single `git config`
  call. The agent doesn't need to remember git-config syntax,
  engagement ids, or which file to edit. Same for `deny`, `status`,
  `check`.

The same machinery works for human-only commits through the standard
pre-commit hook. The AI-specific contribution is the agent-readable
structured output, the per-repo scoping that prevents agents from
learning to ignore false positives, and the verb-shaped CLI that an
agent can drive without specialised knowledge.

For the broader threat model and the layered defences this tool sits
inside (identity separation, ambient-coupling elimination, periodic
audits), see the data-leak prevention guide referenced from the
project [README](../README.md) Background section.

## Reference

- Agent operator guide: [agent-guide.md](agent-guide.md)
- CLI reference: [cli-reference.md](cli-reference.md)
- Design + threat model: [design/README.md](design/README.md)
