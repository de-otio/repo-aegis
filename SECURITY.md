# Security Policy

## Supported versions

Active fixes target the latest minor release (`0.2.x`). Older
versions receive fixes only for high-severity issues at the
maintainer's discretion.

## Reporting a vulnerability

Please **do not** file a public issue or PR for security-relevant
reports. Use either:

- GitHub's private vulnerability reporting (this repo's *Security*
  tab → *Report a vulnerability*), or
- email <richard.myers@de-otio.org> with the subject prefix
  `[repo-aegis security]`.

Initial acknowledgement within five business days. Coordinated
disclosure window of 90 days, or earlier by mutual agreement, before
public details are published.

## Scope

In scope:

- The CLI (`packages/cli`) and any hook entry point invoked by it.
- Core scan / deny-set / trust-boundary / first-touch logic
  (`packages/core`).
- Marker-rendering pipeline (`packages/core/src/render.ts` →
  `~/.config/repo-aegis/markers/*.txt`).
- Suggest-markers LLM integration (`packages/llm`,
  `packages/scan`) and MCP server (`packages/mcp`).
- VS Code extension (`packages/vscode`).

Out of scope (please report through the normal issue tracker):

- Build / CI / release-workflow misconfigurations.
- Issues in third-party dependencies — please report upstream first.
