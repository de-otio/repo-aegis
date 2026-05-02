#!/usr/bin/env node
import { Command } from "commander";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseQueryFile, validateQueryFile } from "./queries.js";
import { loadState, saveStateAtomic } from "./state.js";
import { runScan } from "./run.js";
import { makeOctokitClient } from "./octokit-client.js";
import { renderMarkdown } from "./output.js";
import { fileIssue } from "./issue-filer.js";
import { encryptFile, decryptFile, writeBufferTo, AgeNotFoundError, AgeError } from "./age.js";

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
    const format = opts.outputFormat ?? "json";
    if (!["json", "markdown", "issue"].includes(format)) {
      emitError({
        code: "USAGE",
        error: `--output-format must be one of: json, markdown, issue (got ${format})`,
      });
    }
    if (format === "issue" && !opts.reportIssueRepo) {
      emitError({
        code: "USAGE",
        error: "--report-issue-repo is required when --output-format=issue",
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

    if (format === "json") {
      process.stdout.write(
        JSON.stringify({ summary: result.summary, hits: result.hits }, null, 2) + "\n",
      );
    } else if (format === "markdown") {
      process.stdout.write(renderMarkdown(result.summary, result.hits));
    } else if (format === "issue") {
      const filed = await fileIssue(result.summary, result.hits, {
        reportRepo: opts.reportIssueRepo!,
        client,
      });
      process.stdout.write(
        JSON.stringify(
          {
            action: filed.action,
            issueNumber: filed.issueNumber ?? null,
            url: filed.url ?? null,
            title: filed.title,
          },
          null,
          2,
        ) + "\n",
      );
    }

    const allFailed = result.summary.queries.every(q => !q.ok);
    if (allFailed && result.summary.queries.length > 0) {
      process.exit(2);
    }
    // For markdown/issue, exit 0 even with new hits (the report is the
    // signal). Surface partial-failure ("degraded") through stderr so
    // operators see N/M failed queries without parsing the JSON.
    if (format !== "json" && result.summary.degraded) {
      const failed = result.summary.queries.filter(q => !q.ok).length;
      const total = result.summary.queries.length;
      process.stderr.write(
        `repo-aegis-scan: degraded — ${failed}/${total} queries failed\n`,
      );
    }
    if (format === "json" && result.summary.totalNew > 0) {
      // Per the design contract: json caller must react; issue/markdown
      // outputs already deliver the report, so they exit 0 even with
      // new hits.
      process.exit(1);
    }
    process.exit(0);
  });

program
  .command("encrypt-query <file>")
  .description("encrypt a queries YAML file with age")
  .option("--recipient <pubkey...>", "age recipient(s); pass multiple times for multiple recipients")
  .option("--recipient-file <path>", "file with one recipient per line")
  .option("--output <path>", "write ciphertext here (default: <file>.age)")
  .action((file: string, opts: { recipient?: string[]; recipientFile?: string; output?: string }) => {
    try {
      const buf = encryptFile(file, {
        recipients: opts.recipient,
        recipientFile: opts.recipientFile,
      });
      const target = opts.output ?? `${file}.age`;
      writeBufferTo(target, buf);
      process.stdout.write(JSON.stringify({ action: "encrypt-query", input: file, output: target }, null, 2) + "\n");
    } catch (err) {
      if (err instanceof AgeNotFoundError) {
        emitError({ code: err.code, error: err.message });
      }
      if (err instanceof AgeError) {
        emitError({ code: err.code, error: err.message });
      }
      emitError({ code: "ENCRYPT_ERROR", error: (err as Error).message });
    }
  });

program
  .command("decrypt-query <file>")
  .description("decrypt an age-encrypted queries YAML file")
  .requiredOption("--identity <path>", "age identity file (private key)")
  .option("--output <path>", "write cleartext here (default: stdout)")
  .action((file: string, opts: { identity: string; output?: string }) => {
    try {
      const buf = decryptFile(file, { identityFile: opts.identity });
      if (opts.output) {
        writeBufferTo(opts.output, buf);
        process.stdout.write(
          JSON.stringify({ action: "decrypt-query", input: file, output: opts.output }, null, 2) + "\n",
        );
      } else {
        process.stdout.write(buf);
      }
    } catch (err) {
      if (err instanceof AgeNotFoundError) {
        emitError({ code: err.code, error: err.message });
      }
      if (err instanceof AgeError) {
        emitError({ code: err.code, error: err.message });
      }
      emitError({ code: "DECRYPT_ERROR", error: (err as Error).message });
    }
  });

await program.parseAsync(process.argv);
