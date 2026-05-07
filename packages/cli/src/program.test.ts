// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
// CLI flag-name contract test.
//
// What this guards: the surface area exposed via `repo-aegis --help` is
// referenced by external artefacts that we don't control once they're on
// users' disks — settings.json hook commands, generated GitHub Actions
// workflows, hand-rolled scripts in the wild. Renaming
// `--retention-months` to `--retain-months`, or moving `engagements
// remove` under `engagements purge`, would silently break those callers
// at the next minor bump.
//
// What the test does: walks Commander's command tree (built by
// `buildProgram`) and asserts the *exact* set of subcommands and option
// flag names against a frozen manifest. Description text, defaults, and
// argument descriptions are intentionally NOT checked — those are free
// to evolve.
//
// What to do when this fails: if the change is intentional (renaming a
// flag, adding a new subcommand) and you have a migration story for
// existing users, update the manifest below in the same commit. The
// failure message will tell you exactly which entries drifted.
//
// What to do when adding a new flag/subcommand: add it to EXPECTED_SHAPE
// in the same commit so downstream callers can take the rename
// deliberately.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Command, Option } from "commander";
import { buildProgram } from "./program.js";

interface CommandShape {
  /** Space-joined command path, e.g. "engagements remove". Empty for root. */
  path: string;
  /** Sorted long-form flag names, including --no-* (commander auto-generates these). */
  flags: string[];
  /** Sorted subcommand names directly under this command. */
  subcommands: string[];
}

/**
 * Extract a sorted, de-duplicated list of long flag names from a
 * Commander command's options array. Includes both positive forms and
 * `--no-*` negations, since renaming either breaks call sites.
 */
function flagsOf(cmd: Command): string[] {
  const flags = new Set<string>();
  for (const opt of cmd.options as Option[]) {
    // Each Option has `.long` (e.g. "--retention-months") and `.short`.
    // We only contract on long flags — short flags are not used here.
    if (opt.long) flags.add(opt.long);
  }
  return [...flags].sort();
}

/**
 * Walk a Commander command tree, yielding a flat list of CommandShape
 * entries (one per command/subcommand). Path is space-joined.
 */
function walkCommandTree(root: Command, prefix: string[] = []): CommandShape[] {
  const path = prefix.join(" ");
  const subcommandNames = root.commands
    .map(c => c.name())
    .filter(n => n !== "help") // Commander auto-injects a "help" command
    .sort();

  const out: CommandShape[] = [
    { path, flags: flagsOf(root), subcommands: subcommandNames },
  ];

  for (const sub of root.commands) {
    if (sub.name() === "help") continue;
    out.push(...walkCommandTree(sub, [...prefix, sub.name()]));
  }
  return out;
}

/**
 * The frozen contract. Every entry below is an external promise: editing
 * a flag string here is a public-API change. Add new entries when adding
 * new commands or flags; remove entries when explicitly retiring them.
 */
const EXPECTED_SHAPE: CommandShape[] = [
  // ---- root ----
  // Commander stores `.long` verbatim, including `--no-*` for negation
  // declarations and `--version` for the auto-generated version flag.
  {
    path: "",
    flags: ["--cwd", "--home", "--json", "--no-color", "--registry-path", "--version"],
    subcommands: [
      "allow",
      "audit",
      "audit-log",
      "check",
      "classify",
      "context",
      "deny",
      "engagements",
      "hook",
      "init",
      "install",
      "markers",
      "registry",
      "render",
      "status",
      "suggest-markers",
      "uninstall",
    ],
  },

  // ---- top-level leaf commands ----
  { path: "allow", flags: [], subcommands: [] },
  { path: "deny", flags: [], subcommands: [] },
  { path: "status", flags: [], subcommands: [] },
  {
    path: "check",
    flags: [
      "--history",
      "--ignore-allowlist-comments",
      "--max-file-bytes",
      "--path",
      "--range",
      "--since",
      "--staged",
      "--verbose",
    ],
    subcommands: [],
  },
  {
    path: "render",
    flags: ["--dry-run", "--retention-months"],
    subcommands: [],
  },
  {
    path: "init",
    flags: [
      "--claude-home",
      "--force",
      "--migrate-classify",
      "--no-with-claude",
      "--no-with-hooks",
      "--with-claude",
      "--with-hooks",
    ],
    subcommands: [],
  },
  {
    path: "classify",
    flags: ["--apply", "--rules"],
    subcommands: [],
  },
  {
    path: "suggest-markers",
    flags: [
      "--accept-remote-author-domains",
      "--allow-remote-model",
      "--auto-accept-above",
      "--dry-run",
      "--endpoint",
      "--engagement",
      "--from",
      "--model",
    ],
    subcommands: [],
  },
  {
    path: "audit",
    flags: [
      "--accept-cross-border",
      "--history",
      "--max-queries",
      "--no-fixture-check",
      "--no-lockfile-check",
      "--no-marker-scan",
      "--no-remote-check",
      "--org",
      "--published",
      "--token",
      "--verbose",
    ],
    subcommands: [],
  },

  // ---- engagements ----
  {
    path: "engagements",
    flags: [],
    subcommands: ["add", "end", "list", "remove", "show"],
  },
  { path: "engagements list", flags: ["--all"], subcommands: [] },
  {
    path: "engagements add",
    flags: [
      "--github-org",
      "--marker",
      "--name",
      "--personal-org",
      "--started",
    ],
    subcommands: [],
  },
  { path: "engagements end", flags: ["--purge"], subcommands: [] },
  { path: "engagements show", flags: [], subcommands: [] },
  { path: "engagements remove", flags: ["--hard"], subcommands: [] },

  // ---- context ----
  {
    path: "context",
    flags: [],
    subcommands: ["off", "on", "status"],
  },
  { path: "context on", flags: [], subcommands: [] },
  { path: "context off", flags: [], subcommands: [] },
  { path: "context status", flags: [], subcommands: [] },

  // ---- install ----
  {
    path: "install",
    flags: [],
    subcommands: ["ci", "claude-md", "gitignore", "hooks"],
  },
  {
    path: "install hooks",
    flags: ["--force", "--uninstall"],
    subcommands: [],
  },
  {
    path: "install gitignore",
    flags: ["--gitignore-path", "--uninstall"],
    subcommands: [],
  },
  {
    path: "install ci",
    flags: ["--force", "--uninstall", "--write"],
    subcommands: [],
  },
  {
    path: "install claude-md",
    flags: [
      "--claude-home",
      "--dry-run",
      "--first-touch",
      "--print-only",
      "--uninstall",
    ],
    subcommands: [],
  },

  // ---- markers ----
  {
    path: "markers",
    flags: [],
    subcommands: ["list", "test"],
  },
  { path: "markers list", flags: ["--verbose"], subcommands: [] },
  { path: "markers test", flags: ["--verbose"], subcommands: [] },

  // ---- registry ----
  {
    path: "registry",
    flags: [],
    subcommands: ["decrypt", "encrypt"],
  },
  { path: "registry encrypt", flags: ["--recipient"], subcommands: [] },
  { path: "registry decrypt", flags: ["--identity"], subcommands: [] },

  // ---- hook (Claude Code et al) ----
  {
    path: "hook",
    flags: [],
    subcommands: ["first-touch", "scan-after-write", "scan-bash-output"],
  },
  { path: "hook scan-after-write", flags: [], subcommands: [] },
  { path: "hook first-touch", flags: [], subcommands: [] },
  { path: "hook scan-bash-output", flags: ["--advisory"], subcommands: [] },

  // ---- audit-log ----
  {
    path: "audit-log",
    flags: [],
    subcommands: ["off", "on", "path", "show"],
  },
  { path: "audit-log on", flags: [], subcommands: [] },
  { path: "audit-log off", flags: [], subcommands: [] },
  { path: "audit-log show", flags: ["--all"], subcommands: [] },
  { path: "audit-log path", flags: [], subcommands: [] },

  // ---- uninstall ----
  {
    path: "uninstall",
    flags: ["--claude-home", "--purge-home", "--purge-repos", "--scan-root", "--yes"],
    subcommands: ["sweep-repos"],
  },
  {
    path: "uninstall sweep-repos",
    flags: ["--scan-root", "--yes"],
    subcommands: [],
  },
];

describe("CLI flag-name contract", async () => {
  const program = await buildProgram();
  const actual = walkCommandTree(program);
  const actualByPath = new Map(actual.map(s => [s.path, s] as const));
  const expectedByPath = new Map(EXPECTED_SHAPE.map(s => [s.path, s] as const));

  it("every expected command path is present", () => {
    const missing = EXPECTED_SHAPE
      .map(s => s.path)
      .filter(p => !actualByPath.has(p));
    assert.deepEqual(
      missing,
      [],
      `expected command path(s) gone from the CLI surface: ${JSON.stringify(missing)}`,
    );
  });

  it("no surprise commands have appeared", () => {
    const surprises = actual
      .map(s => s.path)
      .filter(p => !expectedByPath.has(p));
    assert.deepEqual(
      surprises,
      [],
      `command path(s) present in code but not in the contract — add them to EXPECTED_SHAPE in program.test.ts: ${JSON.stringify(surprises)}`,
    );
  });

  for (const expected of EXPECTED_SHAPE) {
    const label = expected.path === "" ? "(root)" : expected.path;
    it(`${label}: subcommand list is exactly as expected`, () => {
      const got = actualByPath.get(expected.path);
      assert.ok(got, `command path "${expected.path}" not present in built program`);
      assert.deepEqual(
        got.subcommands,
        expected.subcommands,
        `subcommands for "${expected.path}" drifted from the contract`,
      );
    });

    it(`${label}: long flag set is exactly as expected`, () => {
      const got = actualByPath.get(expected.path);
      assert.ok(got, `command path "${expected.path}" not present in built program`);
      assert.deepEqual(
        got.flags,
        expected.flags,
        `flags for "${expected.path}" drifted from the contract`,
      );
    });
  }

  // Sanity checks for the universal flags from the design doc. The full
  // contract test above already covers these; the assertions here exist
  // as targeted, easy-to-read failures if a future refactor removes them
  // by accident.
  it("root carries the design-mandated universal flags", () => {
    const root = actualByPath.get("")!;
    for (const expected of ["--cwd", "--home", "--json", "--no-color", "--registry-path"]) {
      assert.ok(
        root.flags.includes(expected),
        `expected universal flag ${expected} on root`,
      );
    }
  });
});
