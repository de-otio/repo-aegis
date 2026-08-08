#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// Workflow hygiene guard for every piece of GitHub Actions YAML this repo
// ships — its own workflows, the composite actions, the reference examples,
// AND the templates `repo-aegis install ci` emits into consumer repos.
//
// actionlint checks syntax and expression validity; zizmor checks the security
// audits it knows about. Neither enforces the three project rules below, and
// all three have already been violated in shipped artefacts:
//
//   1. No `${{ }}` interpolation inside a `run:` block. GitHub splices the
//      expression into the script BEFORE the shell sees it, so any
//      attacker-influenced value (a PR title, a branch name, a file path
//      echoed out of a scanner) can close the quoting and run commands. Pass
//      values through `env:` instead, where they are ordinary shell variables.
//      zizmor's template-injection audit catches the well-known contexts; this
//      check is unconditional, because our own outputs (scan JSON containing
//      repo-derived paths) are not on anybody's known-bad list.
//   2. Every job declares `timeout-minutes`. The default is 360 — six billed
//      hours for one wedged step.
//   3. Every third-party `uses:` is pinned to a full 40-hex commit SHA. A
//      floating major on a leak-prevention gate means an upstream compromise
//      silently disables the gate.
//
// Runnable as `node tests/workflow-hygiene.mjs` from the repo root. Pass
// `--skip-generated` to check only checked-in files (no built CLI required).

import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SHA_PIN = /@[0-9a-f]{40}$/;

/** Actions exempt from the SHA-pin rule: our own, by relative path. */
const LOCAL_USES = /^\.\//;

/**
 * Also exempt: references to THIS action in the reference examples.
 *
 * A SHA in an example is worse than a tag — a reader copies it verbatim and
 * silently pins themselves to whatever commit happened to be current when the
 * doc was written, with no signal that it has aged. The examples say in prose
 * that consumers should pin; the pin rule stays enforced for every third-party
 * action, which is where the supply-chain risk actually is.
 */
const FIRST_PARTY_USES = /^de-otio\/repo-aegis(\/|@)/;

const errors = [];

function fail(file, msg) {
  errors.push(`${relative(REPO_ROOT, file)}: ${msg}`);
}

function listYaml(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter(e => e.isFile() && (e.name.endsWith(".yml") || e.name.endsWith(".yaml")))
    .map(e => join(dir, e.name));
}

/** Steps live under `jobs.<id>.steps` (workflow) or `runs.steps` (composite action). */
function stepsOf(doc) {
  const out = [];
  if (doc && typeof doc === "object") {
    const jobs = doc.jobs;
    if (jobs && typeof jobs === "object") {
      for (const [jobId, job] of Object.entries(jobs)) {
        if (!job || typeof job !== "object") continue;
        for (const step of job.steps ?? []) out.push({ where: `jobs.${jobId}`, step });
      }
    }
    const runsSteps = doc.runs?.steps;
    if (Array.isArray(runsSteps)) {
      for (const step of runsSteps) out.push({ where: "runs", step });
    }
  }
  return out;
}

function checkDoc(file, doc, { requireTimeouts }) {
  if (!doc || typeof doc !== "object") {
    fail(file, "does not parse to a mapping");
    return;
  }

  // Rule 2 — job timeouts. Composite actions have no jobs and no timeout
  // concept; the caller's job timeout governs them.
  if (requireTimeouts && doc.jobs && typeof doc.jobs === "object") {
    for (const [jobId, job] of Object.entries(doc.jobs)) {
      if (!job || typeof job !== "object") continue;
      // A `uses:` job (reusable workflow call) inherits the callee's timeouts.
      if (job.uses) continue;
      if (job["timeout-minutes"] === undefined) {
        fail(file, `jobs.${jobId} is missing timeout-minutes (default is 360 = 6 billed hours)`);
      }
    }
  }

  for (const { where, step } of stepsOf(doc)) {
    if (!step || typeof step !== "object") continue;
    const label = step.name ? `${where} step "${step.name}"` : `${where} step`;

    // Rule 1 — no interpolation inside run:.
    if (typeof step.run === "string" && step.run.includes("${{")) {
      const line = step.run.split("\n").find(l => l.includes("${{"))?.trim() ?? "";
      fail(
        file,
        `${label} interpolates \${{ }} inside run: — pass it via env: instead\n      ${line}`,
      );
    }

    // Rule 3 — SHA-pinned third-party actions.
    if (typeof step.uses === "string") {
      const uses = step.uses.trim();
      const isLocal = LOCAL_USES.test(uses);
      const isDocker = uses.startsWith("docker://");
      const isFirstParty = FIRST_PARTY_USES.test(uses);
      if (!isLocal && !isDocker && !isFirstParty && !SHA_PIN.test(uses)) {
        fail(file, `${label} uses "${uses}" — pin to a full 40-hex commit SHA with a # version comment`);
      }
    }
  }
}

function checkFile(file, opts) {
  let doc;
  try {
    doc = parse(readFileSync(file, "utf8"));
  } catch (err) {
    fail(file, `is not valid YAML: ${err.message}`);
    return;
  }
  checkDoc(file, doc, opts);
}

// ---------------------------------------------------------------------------

/** Composite actions nested under `actions/<name>/action.yml`, if any exist yet. */
function nestedActions() {
  let entries;
  try {
    entries = readdirSync(join(REPO_ROOT, "actions"), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.filter(e => e.isDirectory()).map(e => join(REPO_ROOT, "actions", e.name, "action.yml"));
}

const checkedIn = [
  ...listYaml(join(REPO_ROOT, ".github", "workflows")),
  ...listYaml(join(REPO_ROOT, "examples")),
  join(REPO_ROOT, "action.yml"),
  ...nestedActions(),
];

for (const f of checkedIn) {
  checkFile(f, { requireTimeouts: true });
}

// The generated templates are the artefacts consumers actually run, so they
// are held to the same bar as the workflows in this repo. Skipped when the CLI
// isn't built (e.g. a quick local run before `npm run build`).
if (!process.argv.includes("--skip-generated")) {
  const cliEntry = join(REPO_ROOT, "packages", "cli", "dist", "index.js");
  const tmp = mkdtempSync(join(tmpdir(), "repo-aegis-workflow-hygiene-"));
  for (const profile of ["pr", "strict"]) {
    let out;
    try {
      out = execFileSync("node", [cliEntry, "install", "ci", "--profile", profile, "--json"], {
        encoding: "utf8",
        cwd: REPO_ROOT,
      });
    } catch (err) {
      errors.push(
        `install ci --profile ${profile} failed (build the CLI first, or pass --skip-generated): ${err.message}`,
      );
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(out);
    } catch (err) {
      errors.push(`install ci --profile ${profile} did not emit JSON: ${err.message}`);
      continue;
    }
    for (const [relPath, content] of Object.entries(parsed.templates ?? {})) {
      const f = join(tmp, relPath.replace(/[/\\]/g, "_"));
      writeFileSync(f, content);
      // Report against the template's logical path, not the temp file.
      const before = errors.length;
      checkFile(f, { requireTimeouts: true });
      for (let i = before; i < errors.length; i++) {
        errors[i] = errors[i].replace(relative(REPO_ROOT, f), `<generated ${relPath}>`);
      }
    }
  }
}

if (errors.length > 0) {
  process.stderr.write("FAIL: workflow hygiene violations:\n");
  for (const e of errors) process.stderr.write(`  - ${e}\n`);
  process.stderr.write(`\n${errors.length} violation(s).\n`);
  process.exit(1);
}

process.stdout.write(`OK: workflow hygiene clean (${checkedIn.length} checked-in file(s) + generated templates)\n`);
