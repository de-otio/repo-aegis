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
  .version(pkg.version);

program
  .command("allow")
  .argument("<engagement...>", "one or more engagement ids or fuzzy name matches")
  .description("allow references to one or more engagements in the current repo")
  .option("--json", "output JSON")
  .action((engagements: string[], opts: { json?: boolean }) => allow(engagements, opts));

program
  .command("deny")
  .argument("<engagement...>", "one or more engagement ids or fuzzy name matches")
  .description("stop allowing references to engagements in the current repo")
  .option("--json", "output JSON")
  .action((engagements: string[], opts: { json?: boolean }) => deny(engagements, opts));

program
  .command("status")
  .description("show this repo's class, allowed engagements, and deny-set summary")
  .option("--json", "output JSON")
  .action((opts: { json?: boolean }) => status(opts));

program
  .command("check")
  .description("scan content against this repo's scoped deny set")
  .option("--staged", "scan the staged diff (used by pre-commit hook)")
  .option("--path <path>", "scan a single file")
  .option("--range <revspec>", "scan additions in a git range, e.g. <remote>..<local> (used by pre-push hook)")
  .option("--history", "scan full git history with `git log -G` per pattern (slow)")
  .option("--max-file-bytes <n>", "skip files larger than this (default 1 MiB)", v => parseInt(v, 10))
  .option("--verbose", "reveal literal matched markers (NEVER pass from hooks)")
  .option("--json", "output JSON")
  .action((opts) => check(opts));

program
  .command("render")
  .description("regenerate per-engagement marker files from the registry")
  .option("--json", "output JSON")
  .option("--dry-run", "show what would be written without writing")
  .action((opts: { json?: boolean; dryRun?: boolean }) => render(opts));

const engagements = program
  .command("engagements")
  .description("manage the engagement registry");

engagements
  .command("list")
  .description("list registered engagements")
  .option("--json", "output JSON")
  .option("--all", "include ended engagements past the retention window")
  .action((opts: { json?: boolean; all?: boolean }) => engagementsList(opts));

engagements
  .command("add <id>")
  .description("add a new engagement (validates patterns, triggers render)")
  .option("--name <name>", "human-readable name (defaults to id)")
  .option("--started <date>", "started date in YYYY-MM-DD (defaults to today)")
  .option("--marker <pattern...>", "marker pattern; pass multiple times for multiple markers")
  .option("--json")
  .action((id: string, opts) => engagementsAdd(id, opts));

engagements
  .command("end <id>")
  .description("mark engagement ended; markers retain for 12 months by default")
  .option("--purge", "back-date so markers are removed at next render")
  .option("--json")
  .action((id: string, opts) => engagementsEnd(id, opts));

engagements
  .command("show <id>")
  .description("show one engagement's registered details")
  .option("--json")
  .action((id: string, opts) => engagementsShow(id, opts));

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
  .description("bootstrap repo-aegis: create config dir, scaffold registry, render markers")
  .option("--with-hooks", "also install git hooks (deferred to v0.2.1)", true)
  .option("--with-claude", "also install Claude Code hooks (deferred to v0.2.1)", true)
  .option("--force", "overwrite existing engagements.yaml")
  .option("--json")
  .action(opts => init(opts));

program
  .command("classify")
  .description("auto-detect class+engagement from this repo's remote URL")
  .option("--apply", "actually set git config (otherwise: print suggestion)")
  .option("--rules <path>", "rules YAML; defaults to ~/.config/repo-aegis/classify.yml")
  .option("--cwd <dir>", "target a different working directory")
  .option("--json")
  .action(opts => classify(opts));

const ctx = program.command("context").description("toggle leak-context strict mode");
ctx.command("on").description("enable strict mode").option("--json").action(opts => contextOn(opts));
ctx.command("off").description("disable strict mode").option("--json").action(opts => contextOff(opts));
ctx.command("status").description("show whether strict mode is on").option("--json").action(opts => contextStatus(opts));

const install = program.command("install").description("install hooks, gitignore, claude-md, or ci workflow");

install
  .command("hooks")
  .description("write pre-commit/pre-push to ~/.config/repo-aegis/hooks and set core.hooksPath")
  .option("--force", "overwrite a conflicting core.hooksPath")
  .option("--cwd <dir>", "target a different repo directory")
  .option("--json")
  .action(opts => installHooks(opts));

install
  .command("gitignore")
  .description("append recommended secret-file patterns to ~/.config/git/ignore")
  .option("--gitignore-path <path>", "override default global gitignore path")
  .option("--json")
  .action(opts => installGitignore(opts));

install
  .command("ci")
  .description("emit (or --write) .github/workflows/leak-scan.yml")
  .option("--write", "write to disk instead of printing to stdout")
  .option("--force", "overwrite an existing workflow file")
  .option("--cwd <dir>", "target a different repo directory")
  .option("--json")
  .action(opts => installCi(opts));

install
  .command("claude-md")
  .description("install Claude Code PostToolUse hook + CLAUDE.md snippet")
  .option("--claude-home <dir>", "override default ~/.claude location")
  .option("--json")
  .action(opts => installClaudeMd(opts));

const markers = program.command("markers").description("inspect and probe the marker deny set");

markers
  .command("list")
  .description("list patterns grouped by source file (redacted by default)")
  .option("--verbose", "reveal literal patterns (NEVER pass from hooks)")
  .option("--json")
  .action(opts => markersList(opts));

markers
  .command("test <string>")
  .description("report which patterns would match <string> in this repo's deny set")
  .option("--verbose", "reveal literal matches (NEVER pass from hooks)")
  .option("--cwd <dir>", "evaluate from a different repo directory")
  .option("--json")
  .action((input: string, opts) => markersTest(input, opts));

program
  .command("audit")
  .description("composite repo audit: marker scan, lockfile, fixtures, remote consistency")
  .option("--history", "also sweep full git history with `git log -G` per pattern (slow)")
  .option("--no-marker-scan", "skip the marker scan over tracked files")
  .option("--no-lockfile-check", "skip package-lock.json non-public-registry check")
  .option("--no-fixture-check", "skip scan of fixture/__fixtures__/testdata directories")
  .option("--no-remote-check", "skip the remote-vs-class consistency check")
  .option("--cwd <dir>", "audit a different repo directory")
  .option("--verbose", "reveal literal matches in scan output (NEVER from hooks)")
  .option("--json")
  .action(opts => audit(opts));

await program.parseAsync(process.argv);
