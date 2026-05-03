# Contributing to repo-aegis

Thanks for your interest in repo-aegis. This document covers everything you
need to send a useful change.

## License

repo-aegis is licensed under **GPL-3.0-or-later** (see [`LICENSE`](LICENSE)).

By submitting a pull request, you agree that your contribution is released
under the same license. There is no separate CLA — the license itself is the
contract.

## Project layout

This is an npm workspaces monorepo. Source lives under `packages/*/src/`,
compiled output under `packages/*/dist/`.

| Package                       | Path                | Role                                                |
| ----------------------------- | ------------------- | --------------------------------------------------- |
| `@de-otio/repo-aegis-core`    | `packages/core`     | Scanning engine, registry, state, redaction logic.  |
| `repo-aegis` (CLI)            | `packages/cli`      | The `repo-aegis` command-line tool.                 |
| `@de-otio/repo-aegis-scan`    | `packages/scan`     | Org-wide GitHub code-search sweep tool.             |
| `@de-otio/repo-aegis-mcp`     | `packages/mcp`      | Model Context Protocol server for coding agents.    |
| `repo-aegis-vscode`           | `packages/vscode`   | VSCode extension (editor diagnostics).              |

## Build

```sh
npm install
npm run build
```

`npm run build` runs `tsc -b` across all packages. A clean build is required
before running tests, since the test runner discovers compiled `*.test.js`
files under `dist/`.

## Test

```sh
npm test           # all tests
npm run test:cov   # with coverage thresholds
```

### Coverage targets

- **`core`** and **`cli`**: 80% line, 80% branch.
- **`scan`**: 70% line/branch (network-shaped code is harder to cover
  exhaustively without a heavy mock harness; aim higher when you can).

`npm run test:cov` enforces a global floor; per-package floors are aspirational
and will be tightened as the suite grows.

## Code style

- TypeScript **strict mode** everywhere. `tsc -b` must be clean (no `any`
  escape hatches that swallow real type errors; if you genuinely need `any`,
  comment why).
- **Tests live next to sources** as `*.test.ts`. The `dist/` test runner
  picks them up after `npm run build`.
- Prefer small, focused modules. Cross-package imports go through each
  package's `index.ts` barrel.
- No emoji in source or tests unless the test specifically asserts them.

### Where tests go

| Kind                          | Location                                         |
| ----------------------------- | ------------------------------------------------ |
| Unit test for `foo.ts`        | `foo.test.ts` next to it                         |
| CLI integration test          | `packages/cli/src/integration.test.ts`           |
| Full-lifecycle scenario       | `packages/cli/src/lifecycle.test.ts`             |
| CLI flag/contract surface     | `packages/cli/src/program.test.ts`               |

## CLI flag-name contract

`packages/cli/src/program.test.ts` snapshots the public flag surface of every
subcommand. **Any flag rename, addition, or removal must update
`program.test.ts` in the same commit as the change.** This is how we keep
shell scripts, hooks, MCP wrappers, the GitHub Action, and the VSCode
extension from silently desynchronising from the CLI.

If you're not sure whether your change is "flag-shaped", run `npm test` —
the contract test will tell you.

## Customer confidentiality (HARD RULE)

repo-aegis is a tool for *preventing* customer-name leaks. The repo itself
must not become one.

**Do not put real customer, employer, or client names anywhere** in this
repo. This applies to:

- source code, tests, fixtures, snapshots
- documentation, design notes, plans
- commit messages, PR titles/bodies, issue text
- example configs, sample registries

Use neutral placeholders instead: `customer-a`, `customer-b`, `acme`,
`example.com`, IETF-reserved test domains (`example.org`, `test.example`).

If you spot a real name in the existing tree, please open an issue (or, if
you're confident, a PR that scrubs it). History rewrites are coordinated
through maintainers because they require a force-push.

## Filing issues

Bugs, feature requests, and design questions go to GitHub Issues:
<https://github.com/de-otio/repo-aegis/issues>

Useful things to include:

- repo-aegis version (`repo-aegis --version`)
- Node version (`node --version`)
- the exact command you ran and the output you saw
- a minimal reproduction if you can manage one (a tiny throwaway repo
  with neutral placeholder data is ideal)

## Proposing a design change

For changes that touch the engagement model, the deny-set semantics, the
on-disk state format, the audit-log format, or the CLI surface beyond a
single flag, please send a PR that updates the relevant `doc/design/*`
document **in the same commit** as the implementation.

Smaller PRs (a bug fix, a new test, a perf win on an existing path) don't
need a design-doc update.

## Pull request checklist

Before opening a PR:

- [ ] `npm run build` is clean.
- [ ] `npm test` passes.
- [ ] If you renamed a CLI flag, `program.test.ts` reflects it.
- [ ] If you changed CLI surface beyond a flag, `doc/cli-reference.md`
      reflects it.
- [ ] No real customer names in the diff (sources, tests, fixtures, commit
      message).
- [ ] New behaviour has a test next to its source.
