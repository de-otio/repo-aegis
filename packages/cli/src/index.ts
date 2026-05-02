#!/usr/bin/env node
import { Command } from "commander";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { allow } from "./commands/allow.js";
import { deny } from "./commands/deny.js";
import { status } from "./commands/status.js";
import { check } from "./commands/check.js";
import { render } from "./commands/render.js";
import { engagementsList } from "./commands/engagements-list.js";
import { homeWarning, emitError } from "./format.js";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")) as { version: string };

homeWarning();

const program = new Command()
  .name("repo-aegis")
  .description("Engagement-scoped leak prevention for multi-customer git repos")
  .version(pkg.version)
  // Universal flags. Apply to every subcommand uniformly. Specified once.
  // Per the design doc § Locked decisions table.
  .option("--cwd <dir>", "evaluate from a different working directory (default: process.cwd())")
  .option("--registry-path <path>", "override the engagement registry path (default: ~/.config/repo-aegis/engagements.yaml)")
  .option("--home <dir>", "override the repo-aegis home dir (default: ~/.config/repo-aegis)")
  .option("--no-color", "disable color in output (reserved; currently no color is used)")
  .option("--json", "output JSON (also accepted as a per-command flag for back-compat)");

// Translate --home / --registry-path into the env vars that paths.ts
// reads at call time. Runs before any subcommand action.
program.hook("preAction", () => {
  const g = program.opts() as {
    home?: string;
    registryPath?: string;
  };
  if (g.home) process.env["REPO_AEGIS_HOME"] = g.home;
  if (g.registryPath) process.env["REPO_AEGIS_REGISTRY"] = g.registryPath;
});

// Helper: merge global opts with command-specific opts. Per-command
// values win on collision (so a subcommand-level --json overrides
// global --json).
function withGlobals<T extends object>(opts: T, cmd: { optsWithGlobals: () => Record<string, unknown> }): T {
  return { ...cmd.optsWithGlobals(), ...opts } as T;
}

program
  .command("allow")
  .argument("<engagement...>", "one or more engagement ids or fuzzy name matches")
  .description("allow references to one or more engagements in the current repo")
  .action((engagements: string[], opts, cmd) => allow(engagements, withGlobals(opts, cmd)));

program
  .command("deny")
  .argument("<engagement...>", "one or more engagement ids or fuzzy name matches")
  .description("stop allowing references to engagements in the current repo")
  .action((engagements: string[], opts, cmd) => deny(engagements, withGlobals(opts, cmd)));

program
  .command("status")
  .description("show this repo's class, allowed engagements, and deny-set summary")
  .action((opts, cmd) => status(withGlobals(opts, cmd)));

program
  .command("check")
  .description("scan content against this repo's scoped deny set")
  .option("--staged", "scan the staged diff (used by pre-commit hook)")
  .option("--path <path>", "scan a single file")
  .option("--range <revspec>", "scan additions in a git range, e.g. <remote>..<local> (used by pre-push hook)")
  .option("--history", "scan full git history with `git log -G` per pattern (slow)")
  .option("--max-file-bytes <n>", "skip files larger than this (default 1 MiB)", v => parseInt(v, 10))
  .option("--ignore-allowlist-comments", "do not respect `repo-aegis: allow` comments (audit-grade strict)")
  .option("--verbose", "reveal literal matched markers (NEVER pass from hooks)")
  .action((opts, cmd) => check(withGlobals(opts, cmd)));

program
  .command("render")
  .description("regenerate per-engagement marker files from the registry")
  .option("--dry-run", "show what would be written without writing")
  .action((opts, cmd) => render(withGlobals(opts, cmd)));

const engagements = program
  .command("engagements")
  .description("manage the engagement registry");

engagements
  .command("list")
  .description("list registered engagements")
  .option("--all", "include ended engagements past the retention window")
  .action((opts, cmd) => engagementsList(withGlobals(opts, cmd)));

engagements
  .command("add <id>")
  .description("add a new engagement (validates patterns, triggers render)")
  .option("--name <name>", "human-readable name (defaults to id)")
  .option("--started <date>", "started date in YYYY-MM-DD (defaults to today)")
  .option("--marker <pattern...>", "marker pattern; pass multiple times for multiple markers")
  .action((id: string, opts, cmd) => engagementsAdd(id, withGlobals(opts, cmd)));

engagements
  .command("end <id>")
  .description("mark engagement ended; markers retain for 12 months by default")
  .option("--purge", "back-date so markers are removed at next render")
  .action((id: string, opts, cmd) => engagementsEnd(id, withGlobals(opts, cmd)));

engagements
  .command("show <id>")
  .description("show one engagement's registered details")
  .action((id: string, opts, cmd) => engagementsShow(id, withGlobals(opts, cmd)));

// v0.2 commands: stubbed so the CLI surface is complete-feeling and the
// handoff to parallel agents has clear entry points.
const stubbed = (name: string) =>
  program
    .command(name)
    .description(`(v0.2 — not yet implemented; see implementation plan)`)
    .allowUnknownOption()
    .action(() => {
      emitError(
        {
          code: "NOT_IMPLEMENTED",
          error: `${name} is planned for v0.2`,
          details: "see plans/repo-aegis-implementation-plan.md",
        },
        {},
      );
    });

// All v0.2 leaf commands implemented; nothing left to stub.
void stubbed;

// v0.2 commands (Phase B parallel work) — implemented and wired:
const { init } = await import("./commands/init.js");
const { classify } = await import("./commands/classify.js");
const { contextOn, contextOff, contextStatus } = await import("./commands/context.js");
const { installHooks } = await import("./commands/install-hooks.js");
const { installGitignore } = await import("./commands/install-gitignore.js");
const { installCi } = await import("./commands/install-ci.js");
const { installClaudeMd } = await import("./commands/install-claude-md.js");
const { markersList, markersTest } = await import("./commands/markers.js");
const { engagementsAdd, engagementsEnd, engagementsShow } = await import("./commands/engagements-mutate.js");
const { audit } = await import("./commands/audit.js");

program
  .command("init")
  .description("bootstrap repo-aegis: create config dir, scaffold registry, render markers, install hooks")
  .option("--with-hooks", "install git hooks (default on)", true)
  .option("--with-claude", "install Claude Code PostToolUse hook + CLAUDE.md snippet (default on)", true)
  .option("--no-with-hooks", "skip git hook installation")
  .option("--no-with-claude", "skip Claude Code hook installation")
  .option("--force", "overwrite existing engagements.yaml")
  .option("--claude-home <dir>", "override default ~/.claude location (used by --with-claude)")
  .action((opts, cmd) => init(withGlobals(opts, cmd)));

program
  .command("classify")
  .description("auto-detect class+engagement from this repo's remote URL")
  .option("--apply", "actually set git config (otherwise: print suggestion)")
  .option("--rules <path>", "rules YAML; defaults to ~/.config/repo-aegis/classify.yml")
  .action((opts, cmd) => classify(withGlobals(opts, cmd)));

const ctx = program.command("context").description("toggle leak-context strict mode");
ctx.command("on").description("enable strict mode").action((opts, cmd) => contextOn(withGlobals(opts, cmd)));
ctx.command("off").description("disable strict mode").action((opts, cmd) => contextOff(withGlobals(opts, cmd)));
ctx.command("status").description("show whether strict mode is on").action((opts, cmd) => contextStatus(withGlobals(opts, cmd)));

const install = program.command("install").description("install hooks, gitignore, claude-md, or ci workflow");

install
  .command("hooks")
  .description("write pre-commit/pre-push to ~/.config/repo-aegis/hooks and set core.hooksPath")
  .option("--force", "overwrite a conflicting core.hooksPath")
  .option("--uninstall", "unset core.hooksPath and remove pre-commit/pre-push from <home>/hooks")
  .action((opts, cmd) => installHooks(withGlobals(opts, cmd)));

install
  .command("gitignore")
  .description("append recommended secret-file patterns to ~/.config/git/ignore")
  .option("--gitignore-path <path>", "override default global gitignore path")
  .option("--uninstall", "strip the managed block from the target gitignore (idempotent)")
  .action((opts, cmd) => installGitignore(withGlobals(opts, cmd)));

install
  .command("ci")
  .description("emit (or --write) .github/workflows/leak-scan.yml")
  .option("--write", "write to disk instead of printing to stdout")
  .option("--force", "overwrite an existing workflow file")
  .action((opts, cmd) => installCi(withGlobals(opts, cmd)));

install
  .command("claude-md")
  .description("install Claude Code PostToolUse hook + CLAUDE.md snippet")
  .option("--claude-home <dir>", "override default ~/.claude location")
  .option("--dry-run", "preview the would-be settings.json + CLAUDE.md additions without writing")
  .option("--print-only", "alias for --dry-run")
  .action((opts, cmd) => {
    const merged = withGlobals(opts, cmd) as { dryRun?: boolean; printOnly?: boolean };
    if (merged.printOnly) merged.dryRun = true;
    installClaudeMd(merged);
  });

const markers = program.command("markers").description("inspect and probe the marker deny set");

markers
  .command("list")
  .description("list patterns grouped by source file (redacted by default)")
  .option("--verbose", "reveal literal patterns (NEVER pass from hooks)")
  .action((opts, cmd) => markersList(withGlobals(opts, cmd)));

markers
  .command("test <string>")
  .description("report which patterns would match <string> in this repo's deny set")
  .option("--verbose", "reveal literal matches (NEVER pass from hooks)")
  .action((input: string, opts, cmd) => markersTest(input, withGlobals(opts, cmd)));

program
  .command("audit")
  .description("composite repo audit: marker scan, lockfile, fixtures, remote consistency, optional org/published sweep")
  .option("--history", "also sweep full git history with `git log -G` per pattern (slow)")
  .option("--no-marker-scan", "skip the marker scan over tracked files")
  .option("--no-lockfile-check", "skip package-lock.json non-public-registry check")
  .option("--no-fixture-check", "skip scan of fixture/__fixtures__/testdata directories")
  .option("--no-remote-check", "skip the remote-vs-class consistency check")
  .option("--org <org>", "also run a one-shot GitHub code-search sweep against this org (needs GH_TOKEN)")
  .option("--published <pkg-or-tarball>", "also scan a packed npm tarball, VSIX bundle, or npm package name")
  .option("--token <env-var>", "env var holding the GitHub token for --org (default GH_TOKEN)")
  .option("--max-queries <n>", "cap on --org seed-derived queries per run (default 30)", v => parseInt(v, 10))
  .option("--accept-cross-border", "consent to sending --org seed substrings to GitHub (or set REPO_AEGIS_ACCEPT_ORG_SEED_TRANSFER=1)")
  .option("--verbose", "reveal literal matches in scan output (NEVER from hooks)")
  .action((opts, cmd) => audit(withGlobals(opts, cmd)));

await program.parseAsync(process.argv);
