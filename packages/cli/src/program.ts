// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
// Builds the Commander program. Separated from the bin entry (`index.ts`)
// so the contract test (`program.test.ts`) can walk the command tree
// without triggering `process.argv` parsing.
//
// All side-effecting behaviour (homeWarning, parseAsync, process.exit on
// hard failures inside subcommand handlers) lives in the bin wrapper or
// the individual command modules — never in this file.

import { Command, Option } from "commander";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { allow } from "./commands/allow.js";
import { deny } from "./commands/deny.js";
import { status } from "./commands/status.js";
import { check } from "./commands/check.js";
import { render } from "./commands/render.js";
import { engagementsList } from "./commands/engagements-list.js";
import { emitError } from "./format.js";
import { repoAegisHome } from "@de-otio/repo-aegis-core";
import { noticeApplies, recordsVersion, recordVersion, versionNotice } from "./version-notice.js";

function packageVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")) as {
    version: string;
  };
  return pkg.version;
}

/** The names from the program down to `cmd` (`["install", "hooks"]`); empty for the program itself. */
function commandPath(cmd: Command): string[] {
  const out: string[] = [];
  for (let c: Command | null = cmd; c !== null && c.parent !== null; c = c.parent) out.unshift(c.name());
  return out;
}

// Helper: merge global opts with command-specific opts. Per-command
// values win on collision (so a subcommand-level --json overrides
// global --json).
function withGlobals<T extends object>(
  opts: T,
  cmd: { optsWithGlobals: () => Record<string, unknown> },
): T {
  return { ...cmd.optsWithGlobals(), ...opts } as T;
}

export async function buildProgram(): Promise<Command> {
  const program = new Command()
    .name("repo-aegis")
    .description("Engagement-scoped leak prevention for multi-customer git repos")
    .version(packageVersion())
    // Universal flags. Apply to every subcommand uniformly. Specified once.
    // Per the design doc § Locked decisions table.
    .option("--cwd <dir>", "evaluate from a different working directory (default: process.cwd())")
    .option("--registry-path <path>", "override the engagement registry path (default: ~/.config/repo-aegis/engagements.yaml)")
    .option("--home <dir>", "override the repo-aegis home dir (default: ~/.config/repo-aegis)")
    .option("--no-color", "disable color in output (reserved; currently no color is used)")
    .option("--json", "output JSON (also accepted as a per-command flag for back-compat)");

  // Translate --home / --registry-path into the env vars that paths.ts
  // reads at call time. Runs before any subcommand action.
  program.hook("preAction", (_thisCommand, actionCommand) => {
    const g = program.opts() as {
      home?: string;
      registryPath?: string;
    };
    if (g.home) process.env["REPO_AEGIS_HOME"] = g.home;
    if (g.registryPath) process.env["REPO_AEGIS_REGISTRY"] = g.registryPath;
    // Once per version, on stderr, from interactive commands and git hooks only (never `hook`, `git-credential`
    // or `gh`: their output is read as data). Must never stop a command from running.
    try {
      const path = commandPath(actionCommand);
      // `--json` (global or command level) means a machine reads this: neither print nor record, or the line is spent on nobody.
      const json = actionCommand.optsWithGlobals()["json"] === true;
      if (noticeApplies(path, process.env, json)) versionNotice({ home: repoAegisHome(), version: packageVersion(), write: s => void process.stderr.write(s) });
    } catch {
      /* a notice is never worth a failed command */
    }
  });

  // `init` writes this release's hook scripts and its user-settings hooks, so the notice has nothing to say
  // about them after it. It installs neither the shim nor the managed drop-in: a machine that has either got
  // them from `install shim` / `install claude-md`, and `upgrade` finds those when they go stale.
  program.hook("postAction", (_thisCommand, actionCommand) => {
    try {
      const path = commandPath(actionCommand);
      if (recordsVersion(path) && actionCommand.opts()["migrateClassify"] !== true) recordVersion(repoAegisHome(), packageVersion());
    } catch {
      /* best-effort */
    }
  });

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
    .option("--path <path>", "scan a single file, or every file under a directory (recursively; `.git` is not walked)")
    .option("--max-files <n>", "with a directory --path: refuse (exit 2) rather than scan more than <n> files (default 10000)", v => parseInt(v, 10))
    .option("--range <revspec>", "scan additions in a git range, e.g. <remote>..<local> (used by pre-push hook)")
    .option("--push-ref <ref>", "scan a ref the remote does not have yet, relative to refs/remotes/<remote>/* (used by pre-push hook for new branches and tags)")
    .option("--remote <name>", "with --push-ref: remote whose tracking refs bound the scan (default: origin)")
    .option(
      "--remote-url <url>",
      "with --push-ref/--range: the destination remote URL (git passes it to pre-push as $2); enables the destination checks CROSS_ORG_PUSH and PUBLIC_PUSH_NEEDS_HUMAN and prints the push receipt",
    )
    .option(
      "--remote-ref <ref>",
      "with --push-ref/--range: the ref git will update on the remote (pre-push's $remote_ref); lets a live prompt approval for exactly this push stand in for a person",
    )
    .option("--history", "scan full git history with `git log -G` per pattern (slow)")
    .option("--since <revspec>", "with --history: lower-bound revspec (only commits reachable forward of this point)")
    .option("--max-file-bytes <n>", "skip files larger than this (default 1 MiB)", v => parseInt(v, 10))
    .option("--ignore-allowlist-comments", "do not respect `repo-aegis: allow` comments (audit-grade strict)")
    .option("--ignore-waivers", "do not apply waivers from .repo-aegis.yml; report every _always finding even if a reviewed-benign waiver exists (audit-grade strict)")
    .option("--min-patterns <n>", "exit 2 if the computed deny set has fewer than <n> patterns (fail closed on a missing registry)", v => parseInt(v, 10))
    .option("--require-deny-set", "sugar for --min-patterns 1")
    .option("--redact-attribution", "strip engagement ids and engagement-derived pattern ids from output (set this for anything published: PR comments, issues, public job logs)")
    .option("--verbose", "reveal literal matched markers (NEVER pass from hooks)")
    .action((opts, cmd) => check(withGlobals(opts, cmd)));

  program
    .command("render")
    .description("regenerate per-engagement marker files from the registry")
    .option("--dry-run", "show what would be written without writing")
    .option("--retention-months <n>", "months an ended engagement's markers stay in the deny set (default 12)", v => parseInt(v, 10))
    .action((opts, cmd) => render(withGlobals(opts, cmd)));

  const engagements = program
    .command("engagements")
    .description("manage the engagement registry");

  engagements
    .command("list")
    .description("list registered engagements")
    .option("--all", "include ended engagements past the retention window")
    .action((opts, cmd) => engagementsList(withGlobals(opts, cmd)));

  // v0.2 commands (Phase B parallel work) — implemented and wired:
  const { init } = await import("./commands/init.js");
  const { classify } = await import("./commands/classify.js");
  const { contextOn, contextOff, contextStatus } = await import("./commands/context.js");
  const { installHooks } = await import("./commands/install-hooks.js");
  const { installGitignore } = await import("./commands/install-gitignore.js");
  const { installCi } = await import("./commands/install-ci.js");
  const { installClaudeMd } = await import("./commands/install-claude-md.js");
  const { markersList, markersTest } = await import("./commands/markers.js");
  const { engagementsAdd, engagementsEnd, engagementsShow, engagementsRemove } = await import(
    "./commands/engagements-mutate.js"
  );
  const { audit } = await import("./commands/audit.js");
  const { hookScanAfterWrite } = await import("./commands/hook-scan-after-write.js");
  const { auditLogOn, auditLogOff, auditLogShow, auditLogPathCmd } = await import(
    "./commands/audit-log.js"
  );
  const { uninstall } = await import("./commands/uninstall.js");
  const { uninstallSweepRepos } = await import("./commands/uninstall-sweep-repos.js");
  const { doctor } = await import("./commands/doctor.js");
  const { waive } = await import("./commands/waive.js");
  const { upgrade } = await import("./commands/upgrade.js");

  engagements
    .command("add [id]")
    .description(
      "add a new engagement (or, with --personal-org, append to top-level personalOrgs). --personal-org and --github-org register owners and need a terminal (a TTY on stderr); an agent must not run them.",
    )
    .option("--name <name>", "human-readable name (defaults to id)")
    .option("--started <date>", "started date in YYYY-MM-DD (defaults to today)")
    .option("--marker <pattern...>", "marker pattern; pass multiple times for multiple markers")
    .option(
      "--github-org <org...>",
      "GitHub org(s) that map to this engagement; enables auto-classify on first agent open. Needs a terminal.",
    )
    .option(
      "--personal-org <org...>",
      "GitHub org(s) you own; appended to top-level personalOrgs (no engagement created). Mutually exclusive with --github-org. Needs a terminal.",
    )
    .action((id: string | undefined, opts, cmd) =>
      engagementsAdd(id, withGlobals(opts, cmd)),
    );

  engagements
    .command("end <id>")
    .description("mark engagement ended; markers retain for 12 months by default")
    .option("--purge", "back-date so markers are removed at next render")
    .action((id: string, opts, cmd) => engagementsEnd(id, withGlobals(opts, cmd)));

  engagements
    .command("show <id>")
    .description("show one engagement's registered details")
    .action((id: string, opts, cmd) => engagementsShow(id, withGlobals(opts, cmd)));

  engagements
    .command("remove <id>")
    .description("hard-delete an engagement entry from the registry (data-subject erasure)")
    .option("--hard", "required: physically delete the entry. Use `engagements end --purge` for soft removal.")
    .action((id: string, opts, cmd) => engagementsRemove(id, withGlobals(opts, cmd)));

  engagements
    .command("set-identity [id]")
    .description(
      "map an engagement's orgs (or, with --personal-org, one personal org) to GitHub identities: --person is a gh-login identity, --agent a github-app identity. The first one sets requireIdentity. Needs a terminal; an agent must not run it.",
    )
    .option("--personal-org <org>", "target a personal org instead of an engagement <id>")
    .option("--person <name>", "identity name acting when a person is present (kind gh-login); `none` clears just this column")
    .option("--agent <name>", "identity name acting when no person is present (kind github-app); `none` clears just this column")
    .option("--clear", "remove both identities from the target")
    .action(async (id: string | undefined, opts, cmd) => {
      const { engagementsSetIdentity } = await import("./commands/identity.js");
      engagementsSetIdentity(id, withGlobals(opts, cmd));
    });

  // The end of every refusal reads `[CODE; details: repo-aegis explain CODE]`. Read-only, and an agent may run it:
  // it reads the guide that ships in dist/docs and nothing else (no registry, no network, no git, no repo).
  program
    .command("explain [code]")
    .description(
      "print what a refusal or error code means and what to do about it, from the agent guide that ships with repo-aegis (the code is the word in `[CODE; details: …]`). Read-only; works from any directory. `--list` prints every known code.",
    )
    .option("--list", "print every known code (and topic)")
    .action(async (code: string | undefined, opts, cmd) => {
      const { explain } = await import("./commands/explain.js");
      explain(code, withGlobals(opts, cmd));
    });

  // The user docs that ship in dist/docs, for an agent helping its person from any repo. Read-only like `explain`.
  program
    .command("docs [topic]")
    .description(
      "print a doc that ships with repo-aegis (cli-reference, configuration, agent-guide, egress-guard, readme, changelog, …); with no topic, list them. `--path` prints the file path so you can Read or grep it. Read-only; works from any directory.",
    )
    .option("--path", "print the absolute path of the doc instead of its text")
    .action(async (topic: string | undefined, opts, cmd) => {
      const { docs } = await import("./commands/docs.js");
      docs(topic, withGlobals(opts, cmd));
    });

  // The sandbox-shaped end-to-end flows against this install (P1-G). Read-only outside $TMPDIR; an agent may run it.
  program
    .command("selftest")
    .description(
      "run the real hooks, shim and credential helper through throwaway repositories under $TMPDIR, from the conditions you are in now (proxy variables, no process list, no TTY), and print one line per layer: pre-commit, pre-push, shim, credential helper, egress hook. Exit 0 when every layer is ok, 1 otherwise. Never touches your repositories, the registry, approvals or audit log, or the network. Run it first when anything is refused.",
    )
    .action(async (opts, cmd) => {
      const { selftest } = await import("./commands/selftest.js");
      selftest(withGlobals(opts, cmd));
    });

  // Registry schemaVersion 3: named GitHub identities. The mutators need a terminal and are human-only; `list` is read-only.
  const identity = program
    .command("identity")
    .description(
      "manage the registry's GitHub identities (schemaVersion 3). `list` is read-only; every other subcommand needs a terminal, and an agent must not run it.",
    );
  identity
    .command("list")
    .description("list every identity (name, kind, login or App slug) and which engagements and personal orgs map to it. Read-only; prints no token or key.")
    .action(async (opts, cmd) => {
      const { identityList } = await import("./commands/identity-list.js");
      identityList(withGlobals(opts, cmd));
    });
  identity
    .command("add <name>")
    .description("define identity <name> as a GitHub login (a person) or a GitHub App slug (an agent). Needs a terminal.")
    .option("--gh-login <login>", "a gh account login (kind gh-login)")
    .option("--app <slug>", "a GitHub App slug (kind github-app)")
    .action(async (name: string, opts, cmd) => {
      const { identityAdd } = await import("./commands/identity.js");
      identityAdd(name, withGlobals(opts, cmd));
    });
  identity
    .command("remove <name>")
    .description("remove identity <name>; refused while an owner or engagement still references it. Needs a terminal.")
    .action(async (name: string, opts, cmd) => {
      const { identityRemove } = await import("./commands/identity.js");
      identityRemove(name, withGlobals(opts, cmd));
    });
  identity
    .command("require")
    .description("turn requireIdentity on or off (the first set-identity turns it on). --off needs a terminal; --on only tightens and needs none.")
    .option("--off", "clear requireIdentity (needs a terminal)")
    .option("--on", "set requireIdentity (no terminal needed)")
    .action(async (opts, cmd) => {
      const { identityRequire } = await import("./commands/identity.js");
      identityRequire(withGlobals(opts, cmd));
    });

  // Forks: `allowedUpstreams` lifts rule h (refusal of egress to an unregistered
  // owner) for PRs, issues and comments to one exact owner/repo. `add` widens
  // what an agent may publish to, so it is human-only, like `approve`.
  const upstreams = program
    .command("upstreams")
    .description(
      "manage allowedUpstreams: exact <owner>/<repo> upstreams of your forks that PRs, issues and comments may target. `add` needs a terminal.",
    );
  upstreams
    .command("add <owner/repo>")
    .description(
      "allow PRs, issues and comments to <owner>/<repo>. Needs a terminal (a TTY on stderr): an agent must not register upstreams, and no env var or approval lifts this. Never allows git push, merge, release or gh api writes.",
    )
    .action(async (target: string, opts, cmd) => {
      const { upstreamsAdd } = await import("./commands/upstreams.js");
      upstreamsAdd(target, withGlobals(opts, cmd));
    });
  upstreams
    .command("remove <owner/repo>")
    .description("remove an allowed upstream (no terminal needed: removing only tightens)")
    .action(async (target: string, opts, cmd) => {
      const { upstreamsRemove } = await import("./commands/upstreams.js");
      upstreamsRemove(target, withGlobals(opts, cmd));
    });
  upstreams
    .command("list")
    .description("list allowed upstreams (no terminal needed)")
    .action(async (opts, cmd) => {
      const { upstreamsList } = await import("./commands/upstreams.js");
      upstreamsList(withGlobals(opts, cmd));
    });

  program
    .command("init")
    .description("bootstrap repo-aegis: create config dir, scaffold registry, render markers, install hooks")
    .option("--with-hooks", "install git hooks (default on)", true)
    .option("--with-claude", "install Claude Code PostToolUse hook + CLAUDE.md snippet (default on)", true)
    .option("--no-with-hooks", "skip git hook installation")
    .option("--no-with-claude", "skip Claude Code hook installation")
    .option(
      "--force",
      "overwrite existing engagements.yaml. Needs a terminal (a TTY on stderr) when the existing registry declares anything (owners, upstreams, engagements, markers, always_block)",
    )
    .option("--claude-home <dir>", "override default ~/.claude location (used by --with-claude)")
    .option(
      "--migrate-classify",
      "migrate ~/.config/repo-aegis/classify.yml into the engagement registry's githubOrgs/personalOrgs (Phase 1 onboarding); does not bootstrap or install. Adds owners, so it needs a terminal (a TTY on stderr), lists them, and asks for a typed y (stdin must be a TTY) when classify.yml has any",
    )
    .action((opts, cmd) => init(withGlobals(opts, cmd)));

  program
    .command("classify")
    .description("auto-detect class+engagement from this repo's remote URL")
    .option("--apply", "actually set git config (otherwise: print suggestion)")
    .option("--rules <path>", "rules YAML; defaults to ~/.config/repo-aegis/classify.yml")
    .action((opts, cmd) => classify(withGlobals(opts, cmd)));

  program
    .command("scan-env")
    .description(
      "discover private package-registry hosts from this machine's toolchain configs (~/.npmrc, pip.conf, ~/.docker/config.json, ~/.m2/settings.xml, ~/.cargo/config.toml, ~/.yarnrc.yml) and offer them as markers. Dry-run unless --accept is given; never reads auth tokens.",
    )
    .option(
      "--accept <placement>",
      "persist discovered hosts: private-infra (public-facing repos only) | always-block (everywhere) | engagement",
    )
    .option("--engagement <id>", "engagement id, required with --accept engagement")
    .option(
      "--self",
      "offer the operator's own identity (personalOrgs, package names under the scan roots, the agent session-link shape) as selfIdentity candidates — the strings that must never reach a customer-coupled destination",
    )
    .option("--from <path>", "also scan project-level configs under this dir (default: cwd)")
    .option(
      "--scan-home <dir>",
      "override the home dir whose dotfiles are scanned (default: $HOME). Distinct from the global --home, which repoints the repo-aegis config dir.",
    )
    .action(async (opts, cmd) => {
      const { scanEnv } = await import("./commands/scan-env.js");
      scanEnv(withGlobals(opts, cmd));
    });

  const ctx = program.command("context").description("toggle leak-context strict mode");
  ctx.command("on").description("enable strict mode").action((opts, cmd) => contextOn(withGlobals(opts, cmd)));
  ctx.command("off").description("disable strict mode").action((opts, cmd) => contextOff(withGlobals(opts, cmd)));
  ctx.command("status").description("show whether strict mode is on").action((opts, cmd) => contextStatus(withGlobals(opts, cmd)));

  const install = program.command("install").description("install hooks, gitignore, claude-md, or ci workflow");

  install
    .command("hooks")
    .description("write pre-commit/pre-push to ~/.config/repo-aegis/hooks and set core.hooksPath")
    .option("--force", "overwrite a conflicting core.hooksPath")
    .option("--global", "write core.hooksPath in the global git config (default)")
    .option("--local", "write core.hooksPath in this repo's local git config only (pre-0.7 default)")
    .option("--unset-local", "clear a repo-local core.hooksPath that would shadow the global value just installed")
    .option("--uninstall", "unset core.hooksPath in both global and local scope and remove pre-commit/pre-push from <home>/hooks")
    .action((opts, cmd) => installHooks(withGlobals(opts, cmd)));

  install
    .command("gitignore")
    .description("append recommended secret-file patterns to ~/.config/git/ignore")
    .option("--gitignore-path <path>", "override default global gitignore path")
    .option("--uninstall", "strip the managed block from the target gitignore (idempotent)")
    .action((opts, cmd) => installGitignore(withGlobals(opts, cmd)));

  install
    .command("ci")
    .description("emit (or --write) the generated leak-scan workflow(s)")
    .option(
      "--profile <name>",
      "which workflow to emit: pr (blocking gate, default), strict (weekly suppression-ignoring audit), or all",
    )
    .option("--write", "write to disk instead of printing to stdout")
    .option("--force", "overwrite an existing workflow file")
    .option(
      "--uninstall",
      "remove the workflow file(s) (refuses if user-edited; idempotent on missing file; defaults to every profile)",
    )
    .option(
      "--no-require-deny-set",
      "emit --min-patterns 0 instead of --require-deny-set, for a repo where an empty deny set on CI is permanent (a public repo whose registry is machine-local) rather than a fault",
    )
    .action((opts, cmd) => installCi(withGlobals(opts, cmd)));

  install
    .command("claude-md")
    .description("install the Claude Code hooks and deny rules into ~/.claude/settings.json, plus a CLAUDE.md snippet")
    .option("--claude-home <dir>", "override default ~/.claude location")
    .option(
      "--user-settings",
      "no-op, kept for one release: writing to ~/.claude/settings.json is now the only mode (the root-owned drop-in was removed)",
    )
    .option("--dry-run", "preview the would-be settings.json + CLAUDE.md additions without writing")
    .option("--print-only", "alias for --dry-run")
    .option("--verbose", "print each hook's full command and every deny rule (default: one line per hook)")
    .option(
      "--first-touch",
      "also register a SessionStart hook that calls `repo-aegis hook first-touch` (Phase 1 onboarding)",
    )
    .option(
      "--uninstall",
      "strip the CLAUDE.md block and remove repo-aegis hook entries from settings.json (idempotent); if a legacy root-owned drop-in is still installed, prints the command that removes it. Run this BEFORE `npm rm -g repo-aegis`",
    )
    .action((opts, cmd) => {
      const merged = withGlobals(opts, cmd) as {
        dryRun?: boolean;
        printOnly?: boolean;
        userSettings?: boolean;
      };
      if (merged.printOnly) merged.dryRun = true;
      if (merged.userSettings === true) {
        process.stderr.write("note: --user-settings is now the only mode; the flag is ignored and will be removed in a later release\n");
      }
      installClaudeMd(merged);
    });

  // The `gh` shim: the tool-agnostic egress enforcement point for everything
  // that publishes through `gh` (doc/design/egress-guard.md §3).
  install
    .command("shim [tool]")
    .description("write <home>/bin/<tool> (default: gh), a wrapper that hands every gh call (but --version, help, completion) to `repo-aegis gh`, which decides egress and the GitHub identity; also pins taaad; put that directory first on PATH")
    .option("--uninstall", "remove the shim (idempotent)")
    .option("--force", "overwrite a file at the shim path that repo-aegis did not write")
    .action(async (tool: string | undefined, opts, cmd) => {
      const { installShim } = await import("./commands/install-shim.js");
      installShim(tool, withGlobals(opts, cmd));
    });

  install
    .command("git-credential")
    .description("make the repo-aegis credential helper the first git helper for https://github.com (global config; needs a terminal), so an agent's HTTPS push goes out as the account chosen for its owner (the mapped person login, or an App token narrowed to one repository); sets credential.useHttpPath, and on stock macOS an empty reset entry plus osxkeychain after ours")
    .option("--uninstall", "remove exactly what this command added (recorded in <home>/state/git-credential-install.json)")
    .action(async (opts, cmd) => {
      const { installGitCredential } = await import("./commands/install-git-credential.js");
      installGitCredential(withGlobals(opts, cmd));
    });

  // The git credential helper (doc/plan-owner-identity.md §5.6). Reads the credential protocol on stdin; prints only
  // protocol lines on stdout; always exits 0 (git ignores a non-zero helper and asks the next one).
  program
    .command("git-credential <action>")
    .description("git credential helper: `get` answers an agent's push for a mapped owner with the mapped person's token or an App token; every refusal prints quit=true; store and erase are ignored (git calls this; configure it with `install git-credential`)")
    .action(async (action: string, opts, cmd) => {
      const { runGitCredential } = await import("./commands/git-credential.js");
      const { readFileSync } = await import("node:fs");
      let stdin = "";
      try {
        stdin = readFileSync(0, "utf8");
      } catch {
        /* no stdin: the empty request is not for github.com */
      }
      const merged = withGlobals(opts, cmd) as { home?: string };
      const result = runGitCredential(action, stdin, merged.home ?? "");
      if (result.stderr !== "") process.stderr.write(result.stderr);
      process.stdout.write(result.stdout);
    });

  program
    .command("egress-check")
    .description("decide allow/deny for a `gh` invocation about to run (called by the shim): exit 0 allow, 2 deny with a structured reason on stderr; never rewrites the command")
    .argument("[args...]", "the gh arguments, verbatim (use `--` before them)")
    .action(async (args: string[], opts, cmd) => {
      const { egressCheck } = await import("./commands/egress-check.js");
      egressCheck(args, withGlobals(opts, cmd));
    });

  // What the shim `exec`s for every `gh` call but --version, help and completion (doc/plan-owner-identity.md D1).
  program
    .command("gh")
    .description("run `gh` for the shim: the egress decision, then the GitHub identity the registry maps to the call's owner, then the real gh; use `--home <pinned home> -- <gh args>`")
    .argument("[args...]", "the gh arguments, verbatim (use `--` before them)")
    .action(async (args: string[], opts, cmd) => {
      const { ghCommand } = await import("./commands/gh-command.js");
      ghCommand(args, withGlobals(opts, cmd));
    });

  program
    .command("egress-readback")
    .description("after `gh pr create|edit` with a body file: read the live PR body back and diff it against the file; PUBLISHED_BODY_MISMATCH on difference (byte counts only, never content)")
    .option("--body-file <path>", "the body file that was published")
    .option("--pr <ref>", "PR number or URL (from gh's output)")
    .option("--repo <org/repo>", "destination repository (default: the cwd's origin)")
    .option("--gh <path>", "path to the real gh binary (the shim passes its own resolution)")
    .option("--timeout-ms <n>", "read-back timeout (default 10000)", v => parseInt(v, 10))
    .action(async (opts, cmd) => {
      const { egressReadback } = await import("./commands/egress-check.js");
      egressReadback(withGlobals(opts, cmd));
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
    .description("composite repo audit: marker scan, lockfile, fixtures, remote consistency, hooks (the org/published sweeps moved to `repo-aegis-scan audit`)")
    .option("--history", "also sweep full git history with `git log -G` per pattern (slow)")
    .option("--no-marker-scan", "skip the marker scan over tracked files")
    .option("--no-lockfile-check", "skip package-lock.json non-public-registry check")
    .option("--no-fixture-check", "skip scan of fixture/__fixtures__/testdata directories")
    .option("--no-hooks-check", "skip the git-hooks liveness check (core.hooksPath wiring); the generated CI workflow always sets this — hooks are never installed on a CI runner")
    .option("--no-remote-check", "skip the remote-vs-class consistency check")
    // Moved to `repo-aegis-scan audit` (P2-E). Still parsed, hidden from --help, and
    // answered with the exact replacement command and exit 2. Drop after one release.
    .addOption(new Option("--org <org>", "moved to `repo-aegis-scan audit --org`").hideHelp())
    .addOption(new Option("--published <pkg-or-tarball>", "moved to `repo-aegis-scan audit --published`").hideHelp())
    .addOption(new Option("--no-secret-scan", "moved with --published").hideHelp())
    .option("--ignore-allowlist-comments", "report findings a `repo-aegis: allow` comment suppresses (audit-grade strict; audit never applies waivers, so there is no --ignore-waivers counterpart)")
    .addOption(new Option("--token <env-var>", "moved with --org").hideHelp())
    .addOption(new Option("--max-queries <n>", "moved with --org").argParser((v: string) => parseInt(v, 10)).hideHelp())
    .addOption(new Option("--accept-cross-border", "moved with --org").hideHelp())
    .option("--min-patterns <n>", "exit 2 if the computed deny set has fewer than <n> patterns (fail closed on a missing registry)", v => parseInt(v, 10))
    .option("--require-deny-set", "sugar for --min-patterns 1")
    .option("--redact-attribution", "strip engagement ids and engagement-derived pattern ids from output (set this for anything published: PR comments, issues, public job logs)")
    .option("--verbose", "reveal literal matches in scan output (NEVER from hooks)")
    .action((opts, cmd) => audit(withGlobals(opts, cmd)));

  // `registry` subcommand group. At-rest encryption of the registry is being
  // removed (it is not part of accident prevention). `encrypt` is gone and only
  // tells you so; `decrypt` stays for at least one release so an already-encrypted
  // registry can be migrated. `loadRegistry` deliberately does NOT auto-decrypt
  // (it throws `RegistryEncryptedError`); a person runs
  // `repo-aegis registry decrypt --identity <path>`.
  const registry = program.command("registry").description("migrate an encrypted engagement registry back to plaintext (at-rest encryption is removed)");

  const { registryDecrypt } = await import("./commands/registry-decrypt.js");

  registry
    .command("encrypt")
    .description("removed in 0.15.0; exits 2")
    .allowUnknownOption()
    .allowExcessArguments()
    .action((_opts, cmd) => {
      emitError(
        {
          code: "REGISTRY_ENCRYPT_REMOVED",
          error: "registry encrypt was removed in 0.15.0; at-rest encryption is not part of accident prevention",
        },
        withGlobals({}, cmd),
      );
    });

  registry
    .command("decrypt")
    .description("decrypt engagements.yaml.age back to engagements.yaml and remove the ciphertext")
    .requiredOption("--identity <path>", "age identity file (private key)")
    .action((opts, cmd) => registryDecrypt(withGlobals(opts, cmd)));

  // `hook` subcommand group — entry points wired into Claude Code (or
  // other coding agents') hook frameworks. Kept separate from the human-
  // facing commands so the surface stays uncluttered. The settings.json
  // from `install claude-md` references `repo-aegis hook scan-after-write`
  // by bin name; if claude-home is moved or settings.json is hand-edited,
  // the command keeps resolving via PATH.
  const hook = program.command("hook").description("entry points invoked by coding-agent hook frameworks (Claude Code et al)");

  hook
    .command("scan-after-write")
    .description("PostToolUse: read tool-result JSON on stdin and run check on the written file")
    .option("--agent <name>", "hook framework shape: claude (default) | cursor (afterFileEdit; detection only, the edit has already happened)")
    .action((opts, cmd) => hookScanAfterWrite(withGlobals(opts, cmd)));

  hook
    .command("check-write")
    .description("PreToolUse: read tool-call JSON on stdin and refuse cross-org Write/Edit/MultiEdit before the tool runs")
    .action(async (_opts, _cmd) => {
      const { hookCheckWrite } = await import("./commands/hook-check-write.js");
      await hookCheckWrite();
    });

  hook
    .command("scan-bash-output")
    .description("PostToolUse(Bash): scan Bash tool stdout/stderr for secret-shaped strings (PEM, JWT, GitHub tokens)")
    .option("--advisory", "exit 0 on hit (still emits structured payload)")
    .action(async (opts, cmd) => {
      const { hookScanBashOutput } = await import("./commands/hook-scan-bash-output.js");
      hookScanBashOutput(withGlobals(opts, cmd));
    });

  // Egress guard (doc/design/egress-guard.md §4, §5): the pre-command hook
  // that sees the whole compound command before it runs, and the
  // post-command receipt. Decision-only: neither ever rewrites a command.
  hook
    .command("guard-egress")
    .description("PreToolUse(Bash): read the pending shell command on stdin and allow / ask / deny its publishing operations (git push, gh pr|issue|release|repo|api, npm publish); exit 2 blocks")
    .option("--agent <name>", "hook framework shape: claude (default; supports ask) | cursor (supports ask; beforeShellExecution) | copilot (supports ask) | codex | antigravity (unverified) | gemini (legacy): no ask, ask degrades to deny")
    .action(async (opts, cmd) => {
      const { hookGuardEgress } = await import("./commands/hook-guard-egress.js");
      await hookGuardEgress(withGlobals(opts, cmd));
    });

  // UserPromptSubmit: a person typing ends the life of any prompt approval (egress-guard.md §4a.1). Silent, exit 0.
  hook
    .command("prompt-submit")
    .description("UserPromptSubmit hook: revoke prompt approvals (a yes at the agent's prompt covers one command); silent, never blocks the prompt")
    .action(async () => {
      const { hookPromptSubmit } = await import("./commands/hook-prompt-submit.js");
      await hookPromptSubmit();
    });

  hook
    .command("egress-receipt")
    .description("PostToolUse(Bash): after a command that published, return one line naming the destination (org/repo, visibility, class) as additionalContext")
    .action(async (_opts, _cmd) => {
      const { hookEgressReceipt } = await import("./commands/hook-egress-receipt.js");
      await hookEgressReceipt();
    });

  hook
    .command("first-touch")
    .description(
      "SessionStart: classify the current repo from its remote against the engagement registry; emits FirstTouchResult JSON",
    )
    .action(async (opts, cmd) => {
      const { hookFirstTouch } = await import("./commands/hook-first-touch.js");
      hookFirstTouch(withGlobals(opts, cmd));
    });

  // legacy-managed-remover: remove in 0.17
  // A root-owned drop-in written by 0.13 or earlier still runs this on SessionStart until its owner removes
  // it; an unknown command would exit 1 and print a hook error at every session start.
  hook
    .command("managed-heartbeat", { hidden: true })
    .description("no-op: only a legacy managed drop-in calls this (`repo-aegis doctor` reports it as MANAGED_LEGACY_PRESENT)")
    .action(() => {});

  // `audit-log` subcommand group — operator compliance trail. OFF by
  // default; opt-in via `audit-log on`. State-changing operations
  // (allow/deny, engagements add/end/remove, classify --apply, init,
  // install hooks/claude-md/gitignore/ci, render, registry decrypt) emit one JSONL record per success when enabled. The log
  // never contains literal marker patterns or matched substrings —
  // only structural metadata (engagement ids, counts, paths).
  const auditLog = program
    .command("audit-log")
    .description("operator compliance trail (off by default)");

  auditLog
    .command("on")
    .description("enable the audit log (writes JSONL records of state-changing actions)")
    .action((opts, cmd) => auditLogOn(withGlobals(opts, cmd)));

  auditLog
    .command("off")
    .description("disable the audit log (existing records preserved on disk)")
    .action((opts, cmd) => auditLogOff(withGlobals(opts, cmd)));

  auditLog
    .command("show")
    .description("print audit-log records (last 50 by default)")
    .option("--all", "print every record, not just the most recent 50")
    .action((opts, cmd) => auditLogShow(withGlobals(opts, cmd)));

  auditLog
    .command("path")
    .description("print the active audit-log file path")
    .action((opts, cmd) => auditLogPathCmd(withGlobals(opts, cmd)));

  // Stub helper for parity with the original index.ts shape. Every v0.2
  // command is now implemented; if a future v0.3 command lands as a
  // pre-implementation placeholder, wrap it with this so the surface
  // reports a clean "not yet" instead of an unhelpful Commander error.
  void ((name: string) =>
    program
      .command(name)
      .description(`(placeholder — not yet implemented)`)
      .allowUnknownOption()
      .action(() => {
        emitError(
          {
            code: "NOT_IMPLEMENTED",
            error: `${name} is not yet implemented`,
          },
          {},
        );
      }));

  const uninstallCmd = program
    .command("uninstall")
    .description("reverse the install (hooks, gitignore, claude-md, ci); --purge-* for state")
    .option("--yes", "apply changes (default: dry-run)")
    .option("--purge-repos", "also unset repo-aegis.* git config in every classified repo")
    .option(
      "--scan-root <path...>",
      "directories to walk for --purge-repos (default: ~/repos, ~/code, ~/src, ~/projects)",
    )
    .option(
      "--purge-home",
      "also delete ~/.config/repo-aegis/ (registry, audit log, profiles, cached state)",
    )
    .option("--claude-home <dir>", "override default ~/.claude location")
    .action((opts, cmd) => uninstall(withGlobals(opts, cmd)));

  uninstallCmd
    .command("sweep-repos")
    .description("walk repos under --scan-root and unset repo-aegis.* git config keys")
    .option("--yes", "apply changes (default: dry-run)")
    .option(
      "--scan-root <path...>",
      "directories to walk (default: ~/repos, ~/code, ~/src, ~/projects)",
    )
    .action((opts, cmd) => uninstallSweepRepos(withGlobals(opts, cmd)));

  // The auditable alternative to `--no-verify`: dismiss ONE reviewed-benign
  // `_always` finding, keyed on the blob it was found in, instead of disabling
  // the whole hook. TTY-gated so an agent cannot mint one to unblock itself.
  program
    .command("waive")
    .description("mint, list, or remove a reviewed-benign waiver for an `_always` finding in .repo-aegis.yml")
    .option("--pattern <id>", "pattern id to waive, e.g. _always/9f2c1a4b7de0 (from a `check` finding)")
    .option("--blob <sha>", "git blob sha (40 hex) the waiver covers")
    .option("--reason <text>", "why this finding is reviewed-benign (required to add a waiver)")
    .option("--approver <name>", "who reviewed and approved this waiver (required to add a waiver)")
    .option("--expires <date>", "optional YYYY-MM-DD after which the waiver no longer applies")
    .option("--list", "list existing waivers instead of adding one")
    .option("--remove", "remove a waiver instead of adding one (requires --pattern and --blob)")
    .action((opts, cmd) => waive(withGlobals(opts, cmd)));

  // The human's side of rule g: a time-limited, destination-scoped approval
  // minted at a terminal, so an agent can publish on the operator's say-so
  // without the operator running the command — and without the env escape.
  program
    .command("approve [target]")
    .description(
      "mint (from a person's terminal), list, or revoke a time-limited human approval for publishing to <org>/<repo>, <org>/*, or *. '*' covers only your personalOrgs and npm publish, not customer orgs or allowed upstreams (use <org>/* or <org>/<repo>). No approval helps with an unregistered owner: register it first (engagements add, upstreams add).",
    )
    .option("--ref <ref>", "approve only this branch or tag")
    .option("--ttl <duration>", "how long the approval lives: 15m (default), 2h, 90s, 1d — never more than 24h")
    .option("--note <text>", "why (audit trail only)")
    .option("--list", "list live approvals instead of minting one")
    .option("--revoke <id|all|prompt>", "revoke one approval by id, every one, or only the prompt approvals (a yes at the agent's prompt; terminal approvals stay)")
    .action(async (target: string | undefined, opts, cmd) => {
      const { approve } = await import("./commands/approve.js");
      approve(target, withGlobals(opts, cmd));
    });

  // The emergency pause: a person-only, time-boxed off switch for "repo-aegis is wrong right now and I have to ship".
  // Needs a terminal like `approve`, always expires (default 1h, cap 8h), and `resume` ends it early.
  program
    .command("pause")
    .description(
      "pause repo-aegis for a while (a person's terminal only; always expires: default 1h, at most 8h). With --repo <owner>/<repo> only that repository is paused. The hooks, egress guard, gh shim and git credential helper then stand aside (a machine-wide pause keeps the cross-org checks on; one with --repo lifts them for that repository); approve, pause, identity changes and uninstall stay person-only. End it early with `resume`.",
    )
    .option("--for <duration>", "how long: 30m, 2h, 90s (default 1h, never more than 8h)")
    .option("--repo <owner/repo>", "pause only for this repository (its pushes and its working copy); default: everything on this machine")
    .option("--reason <text>", "why (only its length is recorded)")
    .option("--list", "show the active pause instead of setting one")
    .action(async (opts, cmd) => {
      const { pause } = await import("./commands/pause.js");
      pause(withGlobals(opts, cmd));
    });

  program
    .command("resume")
    .description("end an emergency pause now (repo-aegis protects again); allowed for an agent, because it only turns protection back on")
    .action(async (opts, cmd) => {
      const { resume } = await import("./commands/pause.js");
      resume(withGlobals(opts, cmd));
    });

  // The decision log (P1-I): on by default, read-only for an agent. When a refusal ends `(logged: repo-aegis log --last 1)`,
  // this is the command to run, then `explain <code>`. `--off` is a person's (terminal-gated); `--on` is anyone's.
  program
    .command("log")
    .description(
      "print the decision log: what each repo-aegis hook, shim and credential helper decided and the facts it decided on (the last 20 refusals by code with their one fix line, or --last N records). Read-only; works from any directory; never holds a token, a path, a URL, a command or a marker. `--off` (a person's terminal only) switches recording off; `--on` switches it back on.",
    )
    .option("--since <duration>", "only records from the last 30m, 2h, 1d, ...")
    .option("--code <CODE>", "only records with this refusal code")
    .option("--layer <layer>", "only records of this layer: pre-commit, pre-push, egress-hook, check-write, scan-after-write, shim, credential-helper, prompt-submit, prompt-approval, pause")
    .option("--last <n>", "the last n records, any outcome (`--last 1` is the record the refusal just wrote)")
    .option("--off", "switch the decision log off (a person's terminal only; an agent that did would remove the data its next refusal needs)")
    .option("--on", "switch the decision log back on")
    .action(async (opts, cmd) => {
      const { log } = await import("./commands/log.js");
      log(withGlobals(opts, cmd));
    });

  // A client-side gate that is installed but disconnected looks exactly like
  // one that is clean — both are silent. `doctor` is the fleet-wide sweep that
  // makes that state findable on purpose rather than by luck.
  program
    .command("doctor")
    .description("fleet-wide sweep: verify repo-aegis hooks are live across every repo under --scan-root")
    .option(
      "--scan-root <path...>",
      "directories to walk (default: ~/repos, ~/code, ~/src, ~/projects)",
    )
    .option("--fix", "report (or, with --yes, unset) repo-local core.hooksPath overrides")
    .option("--yes", "apply --fix changes (default: dry-run report only)")
    .option(
      "--no-egress-checks",
      "skip the egress-guard checks (push.default, gh shim on PATH, guard hook registered, class + visibility resolved per repo, registered owners vs every logged-in gh account, pre-push hook, shell startup overrides)",
    )
    .option("--claude-home <dir>", "override default ~/.claude location (for the guard-hook check)")
    .option(
      "--verbose",
      "print every finding with its fix; by default repeated per-repository findings of one code collapse into one line with a count and the fixes appear once, in a closing 'Fix these first' list (--json always lists everything)",
    )
    .action((opts, cmd) => doctor(withGlobals(opts, cmd)));

  // One command after upgrading the package: re-run the installers whose generated output `doctor` calls stale.
  // Allowed for agents: it only re-runs installers an agent may already run, and what needs a person
  // (the credential helper; removing a legacy root-owned drop-in) is listed, not run, when no person is at a terminal.
  program
    .command("upgrade")
    .description(
      "after upgrading repo-aegis: re-run the installers whose output is stale (git hook scripts, the gh shim, the git credential helper), one line per step. Steps that need a person at a terminal (the credential helper; removing a legacy root-owned drop-in) are listed under `run yourself:` when none is attached. Never installs what was not installed.",
    )
    .option("--dry-run", "report what would be done; change nothing")
    .option("--force", "pin to this install even when it looks temporary (a git checkout, an npx cache, a project devDependency); once that copy is removed every commit and push is refused until `install hooks` runs from a lasting install; never overrides a version rollback")
    .option("--claude-home <dir>", "override default ~/.claude location (for the claude-md step)")
    .action((opts, cmd) => {
      upgrade(withGlobals(opts, cmd), { version: packageVersion() });
    });

  return program;
}
