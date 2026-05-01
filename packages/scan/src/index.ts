#!/usr/bin/env node
import { Command } from "commander";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseQueryFile, validateQueryFile } from "./queries.js";
import { loadState, saveStateAtomic } from "./state.js";
import { runScan } from "./run.js";
import { makeOctokitClient } from "./octokit-client.js";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")) as { version: string };

interface RunCliOptions {
  queries: string[];
  state: string;
  excludeOrg?: string[];
  excludeRepo?: string[];
  outputFormat?: string;
  reportIssueRepo?: string;
  token?: string;
  interRequestSleepMs?: number;
  maxPagesPerQuery?: number;
  capResultsPerQuery?: number;
  noUpdateState?: boolean;
  revealMatches?: boolean;
}

function emitError(payload: { code: string; error: string; details?: unknown }, exitCode = 2): never {
  process.stderr.write(JSON.stringify(payload) + "\n");
  process.exit(exitCode);
}

const program = new Command()
  .name("repo-aegis-scan")
  .description("org-wide GitHub code-search sweep for leaked engagement markers")
  .version(pkg.version);

program
  .command("validate-queries <file>")
  .description("schema-check a queries YAML file")
  .action((file: string) => {
    let parsed;
    try {
      parsed = parseQueryFile(file);
    } catch (err) {
      emitError({ code: "PARSE_ERROR", error: (err as Error).message });
    }
    const result = validateQueryFile(parsed!);
    if (!result.ok) {
      process.stderr.write(JSON.stringify({ ok: false, issues: result.issues }, null, 2) + "\n");
      process.exit(2);
    }
    process.stdout.write(
      JSON.stringify({ ok: true, validQueries: result.queries.length }, null, 2) + "\n",
    );
  });

program
  .command("run")
  .description("run the configured queries against GitHub code-search")
  .requiredOption("--queries <file...>", "one or more query YAML files (repeatable)")
  .requiredOption("--state <file>", "state file (seen-hits.json)")
  .option("--exclude-org <org...>", "exclude these orgs (repeatable)")
  .option("--exclude-repo <full_name...>", "exclude these full_names (repeatable)")
  .option("--output-format <format>", "issue|json|markdown — only json is implemented in v0.2", "json")
  .option("--report-issue-repo <owner/repo>", "for --output-format=issue (v0.3)")
  .option("--token <env-var>", "env var holding the GitHub token", "GH_TOKEN")
  .option("--inter-request-sleep-ms <n>", "delay between API requests", v => parseInt(v, 10))
  .option("--max-pages-per-query <n>", "max paginated requests per query", v => parseInt(v, 10))
  .option("--cap-results-per-query <n>", "stop scanning a query after this many hits", v => parseInt(v, 10))
  .option("--no-update-state", "dry-run; do not write state")
  .option("--reveal-matches", "include literal snippet text in output (default OFF)")
  .action(async (opts: RunCliOptions) => {
    if (opts.outputFormat && opts.outputFormat !== "json") {
      emitError({
        code: "NOT_IMPLEMENTED",
        error: `output-format=${opts.outputFormat} is planned for v0.3`,
        details: "only --output-format=json is supported in v0.2",
      });
    }
    const tokenVarName = opts.token ?? "GH_TOKEN";
    const token = process.env[tokenVarName];
    if (!token) {
      emitError({
        code: "TOKEN_MISSING",
        error: `${tokenVarName} environment variable is not set`,
      });
    }

    const allValid = [];
    for (const f of opts.queries) {
      let parsed;
      try {
        parsed = parseQueryFile(f);
      } catch (err) {
        emitError({ code: "PARSE_ERROR", error: (err as Error).message, details: f });
      }
      const v = validateQueryFile(parsed!);
      if (!v.ok) {
        emitError({
          code: "QUERY_VALIDATION",
          error: `${f} has invalid queries`,
          details: v.issues,
        });
      }
      allValid.push(...v.queries);
    }

    let state;
    try {
      state = loadState(opts.state);
    } catch (err) {
      emitError({ code: "STATE_PARSE_ERROR", error: (err as Error).message, details: opts.state });
    }

    const client = makeOctokitClient({ token: token! });

    const result = await runScan({
      queries: allValid,
      state: state!,
      client,
      excludeOrg: opts.excludeOrg,
      excludeRepo: opts.excludeRepo,
      interRequestSleepMs: opts.interRequestSleepMs,
      maxPagesPerQuery: opts.maxPagesPerQuery,
      capResultsPerQuery: opts.capResultsPerQuery,
      revealMatches: opts.revealMatches,
    });

    if (!opts.noUpdateState) {
      saveStateAtomic(opts.state, result.updatedState);
    }

    process.stdout.write(JSON.stringify({ summary: result.summary, hits: result.hits }, null, 2) + "\n");

    const allFailed = result.summary.queries.every(q => !q.ok);
    if (allFailed && result.summary.queries.length > 0) {
      process.exit(2);
    }
    if (result.summary.totalNew > 0) {
      process.exit(1);
    }
    process.exit(0);
  });

await program.parseAsync(process.argv);
