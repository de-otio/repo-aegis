// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// End-to-end tests for the enforcement pin (doc/plan-pin-enforcement-binary.md,
// T2-T5): the INSTALLED pre-commit hook, pre-push hook and `gh` shim must run
// the CLI they were installed with, not a `repo-aegis` or `node` that happens
// to come first on PATH.
//
// Everything here goes through the built CLI as a subprocess (`install hooks`,
// `install shim`, then the generated scripts themselves) with a temp
// REPO_AEGIS_HOME, a temp GIT_CONFIG_GLOBAL, a temp git repo and a temp PATH.
// Nothing reads or writes the real home or the real global git config.
//
// Placeholder names only (`customer-b`, `betaco`, `acme`): this repository is public.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { cliBuilt, cliPath } from "./_subprocess-utils.js";

const skipReason = cliBuilt() ? undefined : `built CLI not found at ${cliPath}; run \`npm run build\` first`;
const skipOpts = skipReason ? { skip: skipReason } : {};

let tmp: string;
let home: string;
let repo: string;
let gitGlobal: string;
let hooksDir: string;
let shimDir: string;
/** Directories that each hold ONE impostor, to put first on PATH. */
let fakeRepoAegisDir: string;
let fakeNodeDir: string;
let fakeGhDir: string;
let impostorLog: string;
let ghLog: string;
const base = (): NodeJS.ProcessEnv => ({
  ...process.env,
  REPO_AEGIS_HOME: home,
  REPO_AEGIS_VISIBILITY_LOOKUP: "0",
  GIT_CONFIG_GLOBAL: gitGlobal,
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  IMPOSTOR_LOG: impostorLog,
  GH_LOG: ghLog,
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, env: base(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function runCli(args: string[]): void {
  const r = spawnSync(process.execPath, [cliPath, ...args], { cwd: repo, env: base(), encoding: "utf8" });
  assert.equal(r.status, 0, `repo-aegis ${args.join(" ")}: ${r.stdout}${r.stderr}`);
}

/** An executable script `name` in `dir` that logs its own name and exits 0 ("allow"). */
function writeImpostor(dir: string, name: string, extra = ""): void {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, name);
  writeFileSync(p, `#!/bin/sh\necho "${name} ran: $*" >> "$IMPOSTOR_LOG"\n${extra}exit 0\n`, { mode: 0o755 });
  chmodSync(p, 0o755);
}

function commit(file: string, content: string, message: string): string {
  writeFileSync(join(repo, file), content);
  git(repo, ["add", file]);
  git(repo, ["commit", "-q", "--no-verify", "-m", message]);
  return git(repo, ["rev-parse", "HEAD"]);
}

before(() => {
  if (skipReason) return;
  tmp = mkdtempSync(join(tmpdir(), "repo-aegis-pin-e2e-"));
  home = join(tmp, "home");
  repo = join(tmp, "repo");
  gitGlobal = join(tmp, "gitconfig-global");
  impostorLog = join(tmp, "impostor.log");
  ghLog = join(tmp, "gh.log");
  fakeRepoAegisDir = join(tmp, "fake-repo-aegis");
  fakeNodeDir = join(tmp, "fake-node");
  fakeGhDir = join(tmp, "fake-gh");
  mkdirSync(home, { recursive: true });
  writeFileSync(gitGlobal, "");

  writeFileSync(
    join(home, "engagements.yaml"),
    `engagements:
  - id: customer-b-2024
    name: Customer B
    markers:
      - betaco
`,
  );
  mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "test"]);
  git(repo, ["config", "repo-aegis.class", "public-eligible"]);
  git(repo, ["remote", "add", "origin", "git@github.com:acme/svc.git"]);
  runCli(["render"]);

  // The installers pin THIS build's node and CLI. --local keeps core.hooksPath out of any global config.
  runCli(["install", "hooks", "--local"]);
  runCli(["install", "shim"]);
  hooksDir = join(home, "hooks");
  shimDir = join(home, "bin");

  // Impostors. The fake repo-aegis exits 0 whatever it is asked; the fake node does too.
  writeImpostor(fakeRepoAegisDir, "repo-aegis");
  writeImpostor(fakeNodeDir, "node");
  // The real-gh stand-in the shim execs when (and only when) the verdict allows.
  writeImpostor(fakeGhDir, "gh", 'echo "gh ran: $*" >> "$GH_LOG"\n');
});

after(() => {
  if (skipReason) return;
  rmSync(tmp, { recursive: true, force: true });
});

/** PATH variants: what sits first. T5 is the `node` and `both` rows. */
const SHADOWS: ReadonlyArray<readonly [string, () => string[]]> = [
  ["a fake `repo-aegis` first on PATH", () => [fakeRepoAegisDir]],
  ["a fake `node` first on PATH (T5)", () => [fakeNodeDir]],
  ["a fake `repo-aegis` and a fake `node` first on PATH (T5)", () => [fakeRepoAegisDir, fakeNodeDir]],
];

function envWith(first: string[], extra: string[] = []): NodeJS.ProcessEnv {
  return { ...base(), PATH: [...first, ...extra, process.env["PATH"] ?? ""].join(delimiter) };
}

function runScript(script: string, args: string[], env: NodeJS.ProcessEnv, input = ""): { status: number | null; out: string } {
  const r = spawnSync("bash", [script, ...args], { cwd: repo, env, input, encoding: "utf8" });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

function impostorRan(): boolean {
  return existsSync(impostorLog) && readFileSync(impostorLog, "utf8").trim() !== "";
}

describe("pinned enforcement (end to end)", skipOpts, () => {
  for (const [label, first] of SHADOWS) {
    describe(`with ${label}`, () => {
      it("T2: the installed pre-commit hook still blocks a staged marker hit, and the impostor never runs", () => {
        rmSync(impostorLog, { force: true });
        writeFileSync(join(repo, "leak.txt"), "see betaco for details\n");
        git(repo, ["add", "leak.txt"]);
        try {
          const r = runScript(join(hooksDir, "pre-commit"), [], envWith(first()));
          assert.notEqual(r.status, 0, `the hook let a marker hit through: ${r.out}`);
          assert.equal(impostorRan(), false, "the hook ran an impostor from PATH");
        } finally {
          git(repo, ["rm", "-q", "--cached", "-f", "leak.txt"]);
          rmSync(join(repo, "leak.txt"), { force: true });
        }
      });

      it("T2 control: the same hook passes a clean staged file (so the block above is the scan, not breakage)", () => {
        rmSync(impostorLog, { force: true });
        writeFileSync(join(repo, "clean.txt"), "nothing to see here\n");
        git(repo, ["add", "clean.txt"]);
        try {
          const r = runScript(join(hooksDir, "pre-commit"), [], envWith(first()));
          assert.equal(r.status, 0, r.out);
          assert.equal(impostorRan(), false);
        } finally {
          git(repo, ["rm", "-q", "--cached", "-f", "clean.txt"]);
          rmSync(join(repo, "clean.txt"), { force: true });
        }
      });

      it("T3: the installed pre-push hook still blocks a commit range that adds a marker hit", () => {
        rmSync(impostorLog, { force: true });
        const before = commit(`push-base-${Math.abs(hash(label))}.txt`, "ordinary\n", "base");
        const after = commit(`push-leak-${Math.abs(hash(label))}.txt`, "betaco was here\n", "leak");
        const stdin = `refs/heads/main ${after} refs/heads/main ${before}\n`;
        const r = runScript(join(hooksDir, "pre-push"), ["origin"], envWith(first()), stdin);
        assert.notEqual(r.status, 0, `the hook let a marker hit through: ${r.out}`);
        assert.equal(impostorRan(), false, "the hook ran an impostor from PATH");
        // Control: the clean range before it passes.
        const clean = runScript(join(hooksDir, "pre-push"), ["origin"], envWith(first()), `refs/heads/main ${before} refs/heads/main ${before}\n`);
        assert.equal(clean.status, 0, clean.out);
      });

      it("T4: the shim's egress decision is the pinned CLI's, not the impostor's allow", () => {
        rmSync(impostorLog, { force: true });
        rmSync(ghLog, { force: true });
        // The pinned CLI refuses a `gh pr create` with no --repo (GH_PR_CREATE_IMPLICIT_TARGET).
        // An impostor `repo-aegis` that "allows" would let the fake gh run.
        const r = runScript(join(shimDir, "gh"), ["pr", "create", "--title", "t", "--body", "b"], envWith(first(), [shimDir, fakeGhDir]));
        assert.equal(r.status, 2, r.out);
        assert.match(r.out, /GH_PR_CREATE_IMPLICIT_TARGET/);
        assert.equal(existsSync(ghLog), false, "the real gh ran although the pinned CLI refused");
        assert.equal(impostorRan(), false, "an impostor from PATH ran");
      });
    });
  }
});

/** A small stable string hash so each variant commits to its own file names. */
function hash(s: string): number {
  let h = 0;
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return h;
}
