// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// `repo-aegis selftest [--json]` (P1-G): the sandbox-shaped end-to-end flows, run against the person's REAL install
// (the pinned hooks, the shim, the credential helper's pinned command, the registered Claude Code hook) from the
// conditions the caller is in right now, so "why is everything refused?" has an answer that is not a day of guessing.
//
// The honest mistake it covers: a release, a stale install or a sandbox that blocks the main path, found by hand from
// inside real work. 0.13.1 and 0.13.2 each did that to every sandboxed agent.
//
// WHAT IT TOUCHES. Throwaway repositories under $TMPDIR, and nothing else that is written:
//   - REPO_AEGIS_HOME is pointed at a temp home for every child it runs, so the real registry, approvals, destination
//     cache and audit log are only ever READ (they are not even read: a synthetic registry stands in for them).
//   - The shim is run from a COPY whose pinned `--home` is the temp home (every other byte is the installed script).
//   - The credential helper is run from the command in git's own configuration with its `--home` swapped for the
//     temp home, and a stub `taaad` that mints a fake token.
//   - No network: `ssh` is a stub on PATH serving local bare repositories, GIT_ALLOW_PROTOCOL admits only ssh and
//     file, visibility lookups are off, and every flow is a refusal or a local push.
//   - Never `REPO_AEGIS_EGRESS_HUMAN` or any other "a person is here" claim: the children have no TTY.
// An agent may run it; it is not a person-only verb.
//
// WHAT IT CANNOT SAY. Whether Claude Code loaded the registered hook (the SessionStart heartbeat covers that), and
// whether the person's OWN credential helper would answer a fetch (it is never asked).
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadRegistry, readProcessAncestry, renderMarkers, repoAegisHome, shellQuote } from "@de-otio/repo-aegis-core";
import { currentEnforcementPin, versionOf } from "../enforcement-pin.js";
import { emitJson, emitText, type OutputOptions } from "../format.js";
import { checkGuardHook } from "./install-claude-md.js";
import { readDropInSettings } from "./doctor-managed-checks.js";
import { resolveManagedEnv } from "./managed-privileged.js";
import { checkShim } from "./install-shim.js";
import { parseHomeFromScript, renderShimScript } from "./shim-script.js";

export const LAYERS = ["pre-commit", "pre-push", "shim", "credential helper", "egress hook"] as const;
export type LayerName = (typeof LAYERS)[number];

export interface LayerResult {
  layer: LayerName;
  ok: boolean;
  /** What follows the layer name on its line: `ok`, `not first on PATH`, `refuses: <code>`, ... */
  status: string;
  /** One more sentence for a layer that is not ok. Never a marker, a token or a path of the person's. */
  detail: string | null;
}

export interface SandboxFacts {
  /** Names only, never values. */
  proxyVars: string[];
  /** Whether the process list could be read (`ps`, or /proc). */
  psReadable: boolean;
  /** Whether stderr is a terminal. */
  tty: boolean;
}

export interface SelftestReport {
  version: string | null;
  ok: boolean;
  layers: LayerResult[];
  sandbox: SandboxFacts;
}

export interface SelftestOptions extends OutputOptions {
  /** Test seam: where Claude Code's settings.json lives (default `~/.claude`). */
  claudeHome?: string;
}

/** The synthetic marker the pre-commit flow commits. Not a secret and not anyone's name. */
const SELFTEST_MARKER = "SELFTEST-MARKER-424242";
const OWNER = "selftest-org";
const APP_OWNER = "selftest-app";
const FAKE_TOKEN = "ghs_selftesttoken0123456789abcdef";
const SPAWN_TIMEOUT_MS = 60_000;

const REGISTRY_YAML = `schemaVersion: 3
identities:
  selftest-bot: { kind: github-app, app: selftest-bot }
personalOrgs:
  - ${OWNER}
  - { name: ${APP_OWNER}, agent: selftest-bot }
always_block:
  - "SELFTEST-MARKER-[0-9]{6}"
engagements: []
`;

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

function run(cmd: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv, input = ""): Run {
  const r = spawnSync(cmd, args, { cwd, env, input, encoding: "utf8", timeout: SPAWN_TIMEOUT_MS });
  return { code: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? (r.error !== undefined ? String(r.error.message) : "") };
}

/** The code a refusal names (`[CODE; details: ...]`, `[CODE]`, or a JSON `"code":"CODE"`), or null. */
export function refusalCodeIn(text: string): string | null {
  const m = /\[([A-Z][A-Z0-9_]{3,})[;\]]/.exec(text) ?? /"code":"([A-Z][A-Z0-9_]{3,})"/.exec(text);
  return m === null ? null : m[1]!;
}

/** A short, single-line excerpt of a child's stderr for a failure detail. Only repo-aegis's and git's own words. */
function excerpt(text: string): string {
  const line = text
    .split("\n")
    .map(l => l.trim())
    .find(l => l !== "");
  return line === undefined ? "no output" : line.length > 140 ? `${line.slice(0, 137)}...` : line;
}

function writeExecutable(path: string, body: string): void {
  writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  chmodSync(path, 0o755);
}

/** The temp world one run builds. Everything under `root`; `root` is removed afterwards. */
interface World {
  root: string;
  home: string;
  stubs: string;
  ghStubs: string;
  bare: string;
  ghLog: string;
  env: NodeJS.ProcessEnv;
}

/** Variables that would make a flow claim a person is present, or redirect where bytes go. Removed from every child. */
const SCRUBBED_ENV = [
  "REPO_AEGIS_EGRESS_HUMAN",
  "REPO_AEGIS_ASSUME_PUBLIC",
  "REPO_AEGIS_REGISTRY",
  "GIT_SSH",
  "GIT_SSH_VARIANT",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GH_REPO",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
];

function buildWorld(baseEnv: NodeJS.ProcessEnv): World {
  const root = mkdtempSync(join(tmpdir(), "repo-aegis-selftest-"));
  const home = join(root, "home");
  const stubs = join(root, "stubs");
  const ghStubs = join(root, "gh-stub");
  const bare = join(root, "bare");
  for (const d of [home, stubs, ghStubs, bare, join(home, "state")]) mkdirSync(d, { recursive: true });

  // A synthetic registry and its rendered markers, in the TEMP home only.
  const registryPath = join(home, "engagements.yaml");
  writeFileSync(registryPath, REGISTRY_YAML);
  renderMarkers(loadRegistry(registryPath), { markersDir: join(home, "markers"), flatPath: join(home, "markers.txt") });

  // `ssh` for git: serves `git-receive-pack|git-upload-pack '<owner>/<repo>.git'` from the local bare repositories.
  writeExecutable(
    join(stubs, "ssh"),
    `for a; do last="$a"; done
svc="\${last%% *}"
path="\${last#* }"
path="\${path#\\'}"
path="\${path%\\'}"
exec git "\${svc#git-}" ${shellQuote(bare)}/"$path"`,
  );
  // The `gh` the shim finds after itself.
  const ghLog = join(root, "gh.log");
  writeFileSync(ghLog, "");
  writeExecutable(join(ghStubs, "gh"), `echo "gh argv: $*" >> ${shellQuote(ghLog)}\necho "https://github.com/${OWNER}/selftest/pull/1"`);
  // The `taaad` the credential helper mints through: a fake token for the repository asked.
  writeExecutable(
    join(stubs, "taaad"),
    `repo=""
while [ $# -gt 0 ]; do
  if [ "$1" = "--repo" ]; then repo="$2"; fi
  shift
done
printf '{"token":"%s","expiresAt":"2099-01-01T00:00:00Z","installationAccount":"%s","installationId":1,"appId":2,"repositories":["%s"],"permissions":{"contents":"write","metadata":"read"}}\\n' ${shellQuote(FAKE_TOKEN)} "\${repo%/*}" "\${repo#*/}"`,
  );

  const env: NodeJS.ProcessEnv = { ...baseEnv };
  for (const name of SCRUBBED_ENV) delete env[name];
  env["REPO_AEGIS_HOME"] = home;
  env["REPO_AEGIS_VISIBILITY_LOOKUP"] = "0";
  env["GIT_TERMINAL_PROMPT"] = "0";
  env["GIT_ALLOW_PROTOCOL"] = "ssh:file";
  // Plain `ssh` (the stub) beats a person's `core.sshCommand`, which could otherwise send a flow to a real host.
  env["GIT_SSH_COMMAND"] = "ssh";
  env["PATH"] = [stubs, baseEnv["PATH"] ?? ""].join(delimiter);
  return { root, home, stubs, ghStubs, bare, ghLog, env };
}

/** Never the person's identity, signing, or hook-skipping defaults for the throwaway commits. */
const GIT_FLAGS = ["-c", "user.name=selftest", "-c", "user.email=selftest@example.invalid", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false"];

function git(w: World, cwd: string, args: readonly string[]): Run {
  return run("git", [...GIT_FLAGS, ...args], cwd, w.env);
}

/** A throwaway repository whose origin is a GitHub ssh URL (served by the stub) and whose visibility is declared. */
function makeRepo(w: World, name: string, owner: string, repo: string, visibility: "private" | "public"): string {
  const dir = join(w.root, name);
  mkdirSync(dir, { recursive: true });
  git(w, dir, ["init", "-q"]);
  git(w, dir, ["remote", "add", "origin", `git@github.com:${owner}/${repo}.git`]);
  git(w, dir, ["config", "repo-aegis.visibility", visibility]);
  git(w, dir, ["config", "repo-aegis.class", visibility === "private" ? "private-strict" : "public-eligible"]);
  mkdirSync(join(w.bare, owner, `${repo}.git`), { recursive: true });
  git(w, join(w.bare, owner, `${repo}.git`), ["init", "-q", "--bare"]);
  return dir;
}

function commitFile(w: World, dir: string, file: string, text: string): Run {
  writeFileSync(join(dir, file), text);
  const add = git(w, dir, ["add", "--", file]);
  if (add.code !== 0) return add;
  return git(w, dir, ["commit", "-q", "-m", "selftest"]);
}

const ok = (layer: LayerName): LayerResult => ({ layer, ok: true, status: "ok", detail: null });
const bad = (layer: LayerName, status: string, detail: string | null): LayerResult => ({ layer, ok: false, status, detail });

// ---------------------------------------------------------------------------
// The layers
// ---------------------------------------------------------------------------

function preCommitLayer(w: World): LayerResult {
  const dir = makeRepo(w, "commit-repo", OWNER, "selftest", "private");
  const clean = commitFile(w, dir, "a.txt", "nothing to see\n");
  if (clean.code !== 0) {
    const code = refusalCodeIn(clean.stderr);
    return bad("pre-commit", code === null ? "FAILED" : `refuses a clean commit: ${code}`, `a commit with nothing to find was refused: ${excerpt(clean.stderr)}`);
  }
  const leak = commitFile(w, dir, "leak.txt", `see ${SELFTEST_MARKER}\n`);
  if (leak.code === 0) {
    return bad("pre-commit", "FAILED", "a commit with a marker hit was not refused: the global core.hooksPath is not the repo-aegis hooks directory (or a repository sets its own), so no pre-commit hook ran; run `repo-aegis doctor`");
  }
  if (!/marker hit/.test(leak.stderr)) {
    return bad("pre-commit", "FAILED", `the commit was refused, but not by a marker hit (${excerpt(leak.stderr)}); the pinned CLI may be missing, run \`repo-aegis doctor\``);
  }
  return ok("pre-commit");
}

function prePushLayer(w: World): LayerResult {
  const pub = makeRepo(w, "public-repo", OWNER, "public-one", "public");
  const priv = makeRepo(w, "push-repo", OWNER, "private-one", "private");
  for (const d of [pub, priv]) {
    const c = commitFile(w, d, "a.txt", "nothing to see\n");
    if (c.code !== 0) return bad("pre-push", "FAILED", `could not make a commit to push: ${excerpt(c.stderr)}`);
  }
  const toPublic = git(w, pub, ["push", "origin", "HEAD:refs/heads/main"]);
  if (toPublic.code === 0) {
    return bad("pre-push", "FAILED", "a push to a public destination went out without a person: no pre-push hook ran (the global core.hooksPath is not the repo-aegis hooks directory, or a repository sets its own); run `repo-aegis doctor`");
  }
  const code = refusalCodeIn(toPublic.stderr);
  if (code !== "PUBLIC_PUSH_NEEDS_HUMAN") {
    return bad("pre-push", "FAILED", `the push to a public destination was refused, but ${code === null ? "not by a repo-aegis rule" : `as ${code}`} (${excerpt(toPublic.stderr)}); run \`repo-aegis doctor\``);
  }
  const toPrivate = git(w, priv, ["push", "origin", "HEAD:refs/heads/main"]);
  if (toPrivate.code !== 0) {
    const c = refusalCodeIn(toPrivate.stderr);
    return bad("pre-push", c === null ? "FAILED" : `refuses: ${c}`, `a push to a private destination was refused: ${excerpt(toPrivate.stderr)}`);
  }
  return ok("pre-push");
}

/** Copy of the installed shim with only its pinned `--home` swapped, run through a private and a public `gh pr create`. */
function shimLayer(w: World, env: NodeJS.ProcessEnv): LayerResult {
  const first = checkShim(env);
  const missing = first.find(c => c.code === "SHIM_MISSING" && !c.ok);
  if (missing !== undefined) return bad("shim", "not installed", "run `repo-aegis install shim`");
  const notFirst = first.some(c => c.code === "SHIM_NOT_FIRST" && !c.ok);

  const installed = join(env["REPO_AEGIS_HOME"] ?? repoAegisHome(), "bin", "gh");
  let text: string;
  try {
    text = readFileSync(installed, "utf8");
  } catch {
    return bad("shim", "not installed", "run `repo-aegis install shim`");
  }
  if (parseHomeFromScript(text) === null) {
    return bad("shim", "FAILED", "the installed shim carries no pinned home, so it is from before this release; run `repo-aegis install shim`");
  }
  // At `<temp home>/bin/gh`, where `repo-aegis gh` expects the shim: it skips that directory when it looks for the real
  // gh, and a copy anywhere else would be found as the "real" gh and run again, for ever.
  const copyDir = join(w.home, "bin");
  mkdirSync(copyDir, { recursive: true });
  writeFileSync(join(copyDir, "gh"), text.replace(/^__ra_home=.*$/m, `__ra_home=${shellQuote(w.home)}`), { mode: 0o755 });
  chmodSync(join(copyDir, "gh"), 0o755);
  const shimEnv: NodeJS.ProcessEnv = { ...w.env, PATH: [copyDir, w.ghStubs, w.env["PATH"] ?? ""].join(delimiter) };

  const priv = makeRepo(w, "shim-private", OWNER, "private-two", "private");
  const pub = makeRepo(w, "shim-public", OWNER, "public-two", "public");
  const toPrivate = run("gh", ["pr", "create", "--repo", `${OWNER}/private-two`, "--title", "selftest", "--body", "selftest"], priv, shimEnv);
  const ran = readFileSync(w.ghLog, "utf8").includes("gh argv: pr create");
  if (toPrivate.code !== 0 || !ran) {
    const code = refusalCodeIn(toPrivate.stderr);
    return bad("shim", code === null ? "FAILED" : `refuses: ${code}`, `a gh write to a private destination did not go through the shim (${excerpt(toPrivate.stderr)})`);
  }
  writeFileSync(w.ghLog, "");
  const toPublic = run("gh", ["pr", "create", "--repo", `${OWNER}/public-two`, "--title", "selftest", "--body", "selftest"], pub, shimEnv);
  if (toPublic.code === 0 || readFileSync(w.ghLog, "utf8") !== "") {
    return bad("shim", "FAILED", "a gh write to a public destination was not refused by the shim without a person");
  }
  const code = refusalCodeIn(toPublic.stderr);
  if (code !== "PUBLIC_EGRESS_NEEDS_HUMAN") {
    return bad("shim", "FAILED", `a gh write to a public destination was refused, but ${code === null ? "not by a repo-aegis rule" : `as ${code}`} (${excerpt(toPublic.stderr)})`);
  }
  if (notFirst) return bad("shim", "not first on PATH", "the shim works, but another `gh` comes first on PATH, so agents never reach it; put the shim's directory first");
  return ok("shim");
}

/** The installed helper's command (git's global configuration), with the `--home` swapped; null when none is installed. */
function installedHelperPrefix(w: World, cwd: string): string | null {
  const r = run("git", ["config", "--global", "--get-all", "credential.https://github.com.helper"], cwd, w.env);
  for (const value of r.stdout.split("\n")) {
    const m = /^!(.*) git-credential --home /.exec(value.trim());
    if (m !== null) return m[1]!;
  }
  return null;
}

function credentialLayer(w: World, baseEnv: NodeJS.ProcessEnv): LayerResult {
  const dir = makeRepo(w, "credential-repo", APP_OWNER, "selftest", "private");
  // The helper pins a taaad through the shim text of <home>/bin/gh; its own temp home gets one that pins the stub.
  const pin = currentEnforcementPin();
  const credHome = join(w.root, "credential-home");
  mkdirSync(join(credHome, "bin"), { recursive: true });
  writeFileSync(join(credHome, "engagements.yaml"), REGISTRY_YAML);
  const taaad = join(w.stubs, "taaad");
  writeFileSync(join(credHome, "bin", "gh"), renderShimScript(pin, { home: credHome, taaad: { launcher: taaad, interpreter: taaad, packageDir: w.stubs } }), { mode: 0o755 });

  const installed = installedHelperPrefix(w, dir);
  const prefix = installed ?? `${shellQuote(process.execPath)} ${shellQuote(pin.cli)}`;
  // The real environment of the caller (proxy variables included) and git's real configuration are what this layer is FOR.
  const env: NodeJS.ProcessEnv = { ...baseEnv, PATH: w.env["PATH"] ?? "" };
  for (const name of SCRUBBED_ENV) delete env[name];
  delete env["REPO_AEGIS_HOME"];
  const r = run("sh", ["-c", `${prefix} git-credential --home ${shellQuote(credHome)} get`], dir, env, `protocol=https\nhost=github.com\npath=${APP_OWNER}/selftest.git\n\n`);
  const note = installed === null ? "the helper is not installed in git's global configuration (`repo-aegis install git-credential`), so the flow ran this CLI directly" : null;
  if (r.stdout.includes(`password=${FAKE_TOKEN}`)) {
    return { layer: "credential helper", ok: true, status: installed === null ? "ok (not installed in git's global configuration)" : "ok", detail: note };
  }
  if (r.stdout.trim() === "quit=true") {
    const code = refusalCodeIn(r.stderr) ?? "UNKNOWN";
    return bad("credential helper", `refuses: ${code}`, `${excerpt(r.stderr)}; \`repo-aegis explain ${code}\``);
  }
  return bad("credential helper", "refuses: NO_ANSWER", `the helper printed nothing for an App-mapped owner (${excerpt(r.stderr)})`);
}

function egressHookLayer(opts: SelftestOptions): LayerResult {
  const checks = checkGuardHook(opts.claudeHome, readDropInSettings(resolveManagedEnv()));
  if (checks.length > 0 && checks.every(c => c.ok)) return ok("egress hook");
  return bad("egress hook", "not registered", "run `repo-aegis install claude-md`");
}

// ---------------------------------------------------------------------------
// The facts, the report, the command
// ---------------------------------------------------------------------------

const PROXY_VAR = /^(?:docker_)?(?:https?|all|no)_proxy$/i;

export function sandboxFacts(env: NodeJS.ProcessEnv = process.env): SandboxFacts {
  let psReadable = false;
  try {
    // An unreadable process list is an empty chain (`ps` blocked or missing); any parent at all means it was read.
    psReadable = readProcessAncestry().ancestors.length > 0;
  } catch {
    psReadable = false;
  }
  return {
    proxyVars: Object.keys(env)
      .filter(k => PROXY_VAR.test(k) && (env[k] ?? "") !== "")
      .sort(),
    psReadable,
    tty: process.stderr.isTTY === true,
  };
}

/** Run every layer. Writes only under a temp directory it removes. */
export function runSelftest(opts: SelftestOptions = {}): SelftestReport {
  const baseEnv = process.env;
  const w = buildWorld(baseEnv);
  try {
    // The shim's own install and the egress hook are read from the REAL home and settings (read-only); the flows run in the temp one.
    const layers: LayerResult[] = [
      preCommitLayer(w),
      prePushLayer(w),
      shimLayer(w, baseEnv),
      credentialLayer(w, baseEnv),
      egressHookLayer(opts),
    ];
    const here = fileURLToPath(new URL("../index.js", import.meta.url));
    return { version: versionOf(here), ok: layers.every(l => l.ok), layers, sandbox: sandboxFacts(baseEnv) };
  } finally {
    rmSync(w.root, { recursive: true, force: true });
  }
}

/** The report as text: one line per layer, then the facts. */
export function formatSelftest(report: SelftestReport): string {
  const lines = report.layers.map(l => `${l.layer} ${l.status}${l.detail !== null && !l.ok ? `\n  ${l.detail}` : ""}`);
  const s = report.sandbox;
  lines.push(`sandbox: proxy variables set: ${s.proxyVars.length === 0 ? "none" : s.proxyVars.join(", ")}; ps readable: ${s.psReadable ? "yes" : "no"}; tty: ${s.tty ? "yes" : "no"}`);
  return lines.join("\n");
}

export function selftest(opts: SelftestOptions): void {
  const report = runSelftest(opts);
  if (opts.json) emitJson(report);
  else emitText(formatSelftest(report));
  process.exit(report.ok ? 0 : 1);
}
