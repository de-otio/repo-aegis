# @de-otio/repo-aegis-mcp

> Model Context Protocol server wrapping repo-aegis as agent-readable tools.

This package exposes the [repo-aegis](https://github.com/de-otio/repo-aegis)
core library as a typed [MCP](https://modelcontextprotocol.io/) tool surface
so a coding agent (Claude Code, Cursor, Aider, Cline, …) can drive it
without shelling out to the CLI. Every tool returns the same JSON shape
that `repo-aegis <command> --json` does, so the
[agent operator guide](../../doc/agent-guide.md) — including its
quick-reference table — applies unchanged.

The server runs in-process: tool calls invoke `@de-otio/repo-aegis-core`
directly. No subprocess spawn, no `--verbose` flag exposed, no path to
literal markers.

## Configuration (Claude Code)

In `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "repo-aegis": {
      "command": "repo-aegis-mcp"
    }
  }
}
```

Once published to npm and installed globally, Claude Code (and any other
MCP client) will spawn the bin over stdio and discover the tools below.

For local development:

```json
{
  "mcpServers": {
    "repo-aegis": {
      "command": "node",
      "args": ["/abs/path/to/repo-aegis/packages/mcp/dist/index.js"]
    }
  }
}
```

## Tools

| Tool | What it does |
|---|---|
| `repo_aegis_status` | Repo class + allowed engagements + deny-set summary. Same shape as `repo-aegis status --json`. Call this first when landing in a new repo. |
| `repo_aegis_check_path` | Scan a single file against the scoped deny set. Same shape as `repo-aegis check --path <file> --json`. |
| `repo_aegis_check_staged` | Scan the staged diff. Same shape as `repo-aegis check --staged --json`. Pre-commit gate. |
| `repo_aegis_engagements_list` | List engagements in the registry (id, name, dates, markerCount). Same shape as `repo-aegis engagements list --json`. |
| `repo_aegis_engagements_show` | Show one engagement's metadata. Same shape as `repo-aegis engagements show <id> --json`. |
| `repo_aegis_markers_test` | Probe a string against the scoped deny set; returns engagement attribution + redacted previews. Same shape as `repo-aegis markers test <s> --json`. |
| `repo_aegis_markers_list` | List active marker files (engagement-id + redacted pattern previews). Same shape as `repo-aegis markers list --json`. |
| `repo_aegis_audit` | Composite repo audit (marker scan, lockfile, fixtures, remote-vs-class). Same shape as `repo-aegis audit --json`. |
| `aegis_classify_first_touch` | JIT classify a previously-unclassified repo from its git remote + the engagement registry's `githubOrgs` / `personalOrgs`. Returns `status: already-classified | applied | needs-confirmation | skipped` with `[SEC H-5]` redacted org names for ambiguous cases. |

Three CLI flags are deliberately **not** exposed over MCP:

- `--verbose` — the literal-reveal path is for a human at a terminal
  only. Hooks and agents must never see literal markers.
- `audit --org` — sends seed substrings (potentially customer-derived)
  to GitHub code-search; cross-border data transfer requiring explicit
  human consent.
- `audit --published` / `audit --history` — long-running or
  archive-extracting; CLI workflows.

Mutating operations (`engagements add` / `end` / `remove`, `allow`,
`deny`, `init`, `install …`) are also intentionally not exposed: those
are user-confirmed compliance operations that should land at the
terminal, not through an agent.

## Redaction policy

This applies everywhere in this server, by construction:

- Every tool that scans content passes `revealMatches: false` to core's
  `scanFile` / `scanStagedDiff` etc. (it's also the default — the
  explicit setting is for audit clarity).
- Every tool that exposes registry patterns redacts via
  `core.redactMatch` before the value crosses the MCP boundary.
- The `--verbose` CLI path is not exposed as an MCP input.
- The `markers list` tool returns previews (`{ index, preview }`),
  never literal patterns.

If a tool result you receive ever contains a literal marker string,
that's a bug — please file an issue.

## License

GPL-3.0-or-later. Copyright (C) 2026 Richard Myers and contributors.

A De Otio tool — https://de-otio.org.
