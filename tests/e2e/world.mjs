// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// The world the sandbox-shaped end-to-end test runs in (P1-G; doc/CONTRIBUTING.md "Release checklist").
//
// WHY THIS EXISTS. 0.13.1 shipped with every sandboxed fetch refused and 0.13.2 with every sandboxed push refused.
// The unit tests passed both times because none of them ran with the sandbox's conditions TOGETHER: proxy variables
// set, `ps` unreadable, no TTY, no route to GitHub, and the PACKED package rather than the workspace.
//
// WHAT THIS BUILDS, per call to `makeWorld()`:
//   - the packed tarballs (`npm pack` of the four workspace packages, or the directory named by E2E_TARBALL_DIR, so a
//     published release can be replayed), extracted into a temp prefix: what an `npm install` would put on disk.
//     Third-party dependencies are linked in from this checkout's node_modules, but ONLY the closure of what the
//     tarballs declare, so a dependency missing from a package.json fails here. No registry is needed to run.
//   - a temp HOME with its own global git config, a temp REPO_AEGIS_HOME, and the real CLI's own `init` /
//     `install shim` run against them (the person-gated installers cannot run without a terminal; the
//     credential-helper line is rendered by the INSTALLED build's own `helperCommand`, the function
//     `install git-credential` writes it with, and falls back to a hand-written copy only for a release that predates
//     the export).
//   - the sandbox's environment (`sandboxEnv` below, the shapes Claude Code's sandbox sets, every proxy pointing at a
//     dead localhost port), a failing `ps` first on PATH, stdin never a TTY, no network.
//   - cleanup on failure: a setup that throws after the temp root exists removes the root and re-throws.
//
// KNOWN LIMIT. repo-aegis runs `ps` by ABSOLUTE path (/bin/ps, /usr/bin/ps), so a PATH stub cannot make ITS process
// list unreadable; it makes every `ps` that is found by name fail (the hook and shim scripts, any tool a flow spawns).
// Inside Claude Code's own sandbox /bin/ps really is blocked, so a run there exercises the real condition too.
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The workspace packages the CLI needs, in the order npm packs them. */
export const PACKAGES = ["core", "llm", "scan", "cli"];

/** A dead localhost port: nothing listens on the discard port in a test run, and a connect fails at once. */
export const DEAD_PROXY = "http://127.0.0.1:9";

/**
 * The sandbox's proxy URL as Claude Code's sandbox sets it: credentials in the userinfo, the loopback host and a
 * port. Host and port are the dead proxy, so nothing connects; the userinfo is a made-up placeholder in the same
 * shape (`srt.<base64>:<secret>`), never a copy of a real value.
 */
export const SANDBOX_PROXY_URL = "http://srt.ZXhhbXBsZS1wcm94eS11c2Vy:example-proxy-secret@127.0.0.1:9";

/** The `NO_PROXY` list the sandbox sets, verbatim (it holds no secret). */
const SANDBOX_NO_PROXY = "localhost,127.0.0.1,::1,169.254.0.0/16,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16";

/**
 * Every environment variable Claude Code's sandbox sets on an agent's commands that repo-aegis could react to, in
 * the shapes it sets them (read from a real sandboxed session's `env`, names and shapes only, no secret value
 * copied): the proxy family in both cases, `GIT_SSH_COMMAND` with its quoted ProxyCommand, `GIT_CONFIG_PARAMETERS`
 * (a basic-auth setting and an empty credential helper for the proxy), `GIT_CONFIG_COUNT`/`KEY_n`/`VALUE_n`
 * (safe.directory), `SANDBOX_RUNTIME` and `CLAUDECODE`. Every proxy points at {@link DEAD_PROXY}'s host and port.
 * `SRT_SSH_PROXY_COMMAND` (which the real `GIT_SSH_COMMAND` evaluates) is a harmless stand-in: the `ssh` the world
 * puts on PATH never runs a ProxyCommand.
 *
 * @param {string} root the world's root, the directory `safe.directory` names
 */
export function sandboxEnv(root) {
  const proxy = SANDBOX_PROXY_URL;
  const socks = SANDBOX_PROXY_URL.replace(/^http:/, "socks5h:");
  return {
    SANDBOX_RUNTIME: "1",
    CLAUDECODE: "1",
    HTTP_PROXY: proxy,
    HTTPS_PROXY: proxy,
    http_proxy: proxy,
    https_proxy: proxy,
    ALL_PROXY: proxy,
    all_proxy: proxy,
    GRPC_PROXY: proxy,
    grpc_proxy: proxy,
    FTP_PROXY: socks,
    ftp_proxy: socks,
    RSYNC_PROXY: "127.0.0.1:9",
    DOCKER_HTTP_PROXY: proxy,
    DOCKER_HTTPS_PROXY: proxy,
    NO_PROXY: SANDBOX_NO_PROXY,
    no_proxy: SANDBOX_NO_PROXY,
    SRT_SSH_PROXY_COMMAND: "echo 'sandbox proxy: not reachable in the e2e world' >&2; exit 1",
    GIT_SSH_COMMAND: String.raw`ssh -o ControlMaster=no -o ControlPath=none -o ProxyCommand="/bin/sh -c 'eval \"\${SRT_SSH_PROXY_COMMAND:?unset, but GIT_SSH_COMMAND needs it}\"' sh '%h' %p"`,
    GIT_CONFIG_PARAMETERS: `'http.proxyAuthMethod=basic' 'credential.http://127.0.0.1:9.helper='`,
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "safe.directory",
    GIT_CONFIG_VALUE_0: root,
    GIT_CONFIG_KEY_1: "safe.directory",
    GIT_CONFIG_VALUE_1: `${root}/*`,
  };
}

const sh = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/** A fresh temp directory under the test run's $TMPDIR (realpath: macOS's /var is a symlink to /private/var). */
export function tempDir(label) {
  return realpathSync(mkdtempSync(join(tmpdir(), `repo-aegis-e2e-${label}-`)));
}

/** `npm pack` the workspace packages into `dest`. Needs `npm run build` first. Returns the tarball paths. */
export function packWorkspace(dest) {
  mkdirSync(dest, { recursive: true });
  const args = ["pack", "--silent", "--pack-destination", dest, ...PACKAGES.flatMap((p) => ["--workspace", `packages/${p}`])];
  execFileSync("npm", args, { cwd: REPO_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
  return tarballsIn(dest);
}

export function tarballsIn(dir) {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".tgz"))
    .map((f) => join(dir, f));
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/**
 * Extract each tarball to `<prefix>/node_modules/<package name>` and link in the third-party closure of what they
 * declare. Returns `{ cliDir, version }`.
 */
export function installTarballs(tarballs, prefix, hoistedModules = join(REPO_ROOT, "node_modules")) {
  const nm = join(prefix, "node_modules");
  mkdirSync(nm, { recursive: true });
  const installed = new Map();
  for (const tgz of tarballs) {
    const scratch = mkdtempSync(join(prefix, "extract-"));
    execFileSync("tar", ["-xzf", tgz, "-C", scratch]);
    const pkg = readJson(join(scratch, "package", "package.json"));
    const target = join(nm, ...pkg.name.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    cpSync(join(scratch, "package"), target, { recursive: true });
    rmSync(scratch, { recursive: true, force: true });
    installed.set(pkg.name, { dir: target, pkg });
  }
  // The closure of declared third-party dependencies. `optionalDependencies` are linked when present and skipped otherwise.
  const queue = [];
  const queueDeps = (pkg) => {
    for (const d of Object.keys(pkg.dependencies ?? {})) queue.push({ name: d, optional: false, from: pkg.name });
    for (const d of Object.keys(pkg.optionalDependencies ?? {})) queue.push({ name: d, optional: true, from: pkg.name });
  };
  for (const { pkg } of installed.values()) queueDeps(pkg);
  const linked = new Set();
  while (queue.length > 0) {
    const { name, optional, from } = queue.shift();
    if (installed.has(name) || linked.has(name)) continue;
    const src = join(hoistedModules, ...name.split("/"));
    if (!existsSync(join(src, "package.json"))) {
      if (optional) continue;
      throw new Error(`${from} declares ${name}, which is not installed in ${hoistedModules}: run \`npm ci\` first`);
    }
    const dest = join(nm, ...name.split("/"));
    mkdirSync(dirname(dest), { recursive: true });
    symlinkSync(src, dest, "dir");
    linked.add(name);
    queueDeps(readJson(join(src, "package.json")));
  }
  const cli = installed.get("@de-otio/repo-aegis");
  if (cli === undefined) throw new Error("no @de-otio/repo-aegis tarball among " + tarballs.join(", "));
  return { cliDir: cli.dir, version: cli.pkg.version };
}

/**
 * `git-remote-https` as a stub, so a real `git push|fetch https://github.com/<owner>/<repo>` runs with no network and
 * the credential helper still sees what it sees in life: a process called `git-remote-https` with argv
 * `[git-remote-https, <remote>, <url>]`, above it `git push` or `git fetch`, below it the helper. The stub asks the
 * helpers in git's `credential.https://github.com.helper` list for a credential the way git does (in order, an empty
 * entry resets, an empty answer asks the next, `quit=true` stops), writes what happened to `<outDir>/result.json`, and
 * fails the transfer. git finds it first through GIT_EXEC_PATH, a directory of links to git's own commands plus the stub.
 */
export function installHttpsRemoteStub(root, node) {
  const gitCore = execFileSync("git", ["--exec-path"], { encoding: "utf8" }).trim();
  const execDir = join(root, "git-exec");
  mkdirSync(execDir, { recursive: true });
  for (const name of readdirSync(gitCore)) {
    if (name === "git-remote-https" || name === "git-remote-http") continue;
    symlinkSync(join(gitCore, name), join(execDir, name));
  }
  const outDir = join(root, "https-stub-out");
  mkdirSync(outDir, { recursive: true });
  const js = join(root, "git-remote-https-stub.mjs");
  writeFileSync(
    js,
    `import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
// What the process list shows for the real helper: argv[0] git-remote-https, then its own arguments.
process.title = ["git-remote-https", ...process.argv.slice(2)].join(" ");
const url = process.argv[3] ?? "";
const path = new URL(url).pathname.replace(/^\\//, "");
const configured = spawnSync("git", ["config", "--get-all", "credential.https://github.com.helper"], { encoding: "utf8" }).stdout;
let chain = [];
for (const h of configured.split("\\n").slice(0, -1)) {
  if (h === "") chain = [];
  else chain.push(h);
}
const request = "protocol=https\\nhost=github.com\\npath=" + path + "\\n\\n";
const result = { answered: false, refused: false, stdout: "", stderr: "" };
for (const h of chain) {
  if (!h.startsWith("!")) continue;
  const r = spawnSync("sh", ["-c", h.slice(1) + " get"], { input: request, encoding: "utf8" });
  result.stderr += r.stderr ?? "";
  if ((r.stdout ?? "").includes("quit=true")) {
    result.refused = true;
    break;
  }
  if ((r.stdout ?? "").includes("password=")) {
    result.answered = true;
    result.stdout = r.stdout;
    break;
  }
}
writeFileSync(${JSON.stringify(outDir)} + "/result.json", JSON.stringify(result));
process.exit(1);
`,
  );
  const stub = join(execDir, "git-remote-https");
  writeFileSync(stub, `#!/bin/sh\nexec ${sh(node)} ${sh(js)} "$@"\n`, { mode: 0o755 });
  chmodSync(stub, 0o755);
  return { execDir, outDir };
}

/** A stub executable: `body` is the script after the shebang. */
export function writeStub(dir, name, body) {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  chmodSync(path, 0o755);
  return path;
}

/**
 * The registry the world installs: one owner mapped to the person's GitHub login, one to an App, one registered with
 * no identity, and an org-wide marker (an `_always` pattern, so a commit with it is refused wherever it lands).
 */
export const REGISTRY_YAML = `schemaVersion: 3
identities:
  me: { kind: gh-login, login: example-user }
  bot: { kind: github-app, app: example-bot }
personalOrgs:
  - { name: org-person, person: me }
  - { name: org-app, agent: bot, person: me }
  - org-private
  - org-public
always_block:
  - "E2E-MARKER-[0-9]{6}"
engagements: []
`;

/** What the stub taaad mints. Tests assert it never appears on stderr. */
export const APP_TOKEN = "ghs_exampletoken0123456789abcdef";

export const MARKER_TEXT = "E2E-MARKER-123456";

/** The helper line as `install git-credential` writes it, spelled out. The world's test compares it to the installer's own output. */
export function handWrittenHelperLine(node, cli, ra) {
  return `!${sh(node)} ${sh(cli)} git-credential --home ${sh(ra)}`;
}

/**
 * The helper line from the INSTALLED build's own renderer (`helperCommand` in `install-git-credential.js`), so a change
 * to the installer's line changes the world's line with it. Null when that build has no such export (a release that
 * predates it) or cannot be loaded; the caller then falls back to {@link handWrittenHelperLine}.
 */
export function installerHelperLine(cliDir, node, cli, ra, env) {
  const module = pathToFileURL(join(cliDir, "dist", "commands", "install-git-credential.js")).href;
  const script =
    "import(process.argv[1]).then((m) => { if (typeof m.helperCommand !== 'function') process.exit(3); " +
    "process.stdout.write(m.helperCommand({ node: process.argv[2], cli: process.argv[3] }, process.argv[4])); }, () => process.exit(4));";
  const r = spawnSync(node, ["-e", script, module, node, cli, ra], { encoding: "utf8", env, timeout: 60_000 });
  return r.status === 0 && r.stdout !== "" ? r.stdout : null;
}

/**
 * Build the world. `tarballDir` (default: `process.env.E2E_TARBALL_DIR`, else a fresh `npm pack` of the workspace)
 * says which build of repo-aegis is under test. A setup that throws after the temp root exists removes it and
 * re-throws: a failed `before()` must not leave a `repo-aegis-e2e-*` directory behind.
 */
export function makeWorld({ tarballDir = process.env["E2E_TARBALL_DIR"] } = {}) {
  const root = tempDir("world");
  try {
    return buildWorld(root, tarballDir);
  } catch (err) {
    rmSync(root, { recursive: true, force: true });
    throw err;
  }
}

function buildWorld(root, tarballDir) {
  const prefix = join(root, "prefix");
  const home = join(root, "home");
  const ra = join(root, "repo-aegis-home");
  const stubs = join(root, "stubs");
  const ghStubs = join(root, "gh-stub");
  const bare = join(root, "bare");
  for (const d of [prefix, home, ra, stubs, ghStubs, bare]) mkdirSync(d, { recursive: true });

  const tarballs = tarballDir !== undefined && tarballDir !== "" ? tarballsIn(tarballDir) : packWorkspace(join(root, "tarballs"));
  const { cliDir, version } = installTarballs(tarballs, prefix);
  const cli = join(cliDir, "dist", "index.js");
  const node = process.execPath;

  // `ps` that fails the way the sandbox's does: the binary exists and refuses.
  writeStub(stubs, "ps", `echo "ps: operation not permitted" >&2\nexit 1`);

  const gitDir = dirname(execFileSync("which", ["git"], { encoding: "utf8" }).trim());
  const systemPath = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];
  const basePath = [stubs, dirname(node), gitDir, ...systemPath].filter((p, i, a) => a.indexOf(p) === i).join(delimiter);
  const gitconfig = join(home, ".gitconfig");
  writeFileSync(
    gitconfig,
    `[user]\n\tname = E2E\n\temail = e2e@example.com\n[init]\n\tdefaultBranch = main\n[protocol "file"]\n\tallow = always\n`,
  );

  /** The sandbox-shaped environment. Nothing from the caller's environment leaks in (no real HOME, no real tokens). */
  const env = (extra = {}) => ({
    PATH: basePath,
    HOME: home,
    USER: "e2e",
    LC_ALL: "C",
    TMPDIR: root,
    GIT_CONFIG_GLOBAL: gitconfig,
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    REPO_AEGIS_HOME: ra,
    REPO_AEGIS_VISIBILITY_LOOKUP: "0",
    ...sandboxEnv(root),
    ...extra,
  });

  /** Run a program with no TTY on stdin, stdout or stderr. */
  const run = (cmd, args, { cwd = root, input = "", env: extra = {}, timeout = 60_000 } = {}) => {
    const r = spawnSync(cmd, args, { cwd, input, encoding: "utf8", env: env(extra), timeout });
    return { code: r.status, signal: r.signal, stdout: r.stdout ?? "", stderr: r.stderr ?? "", error: r.error };
  };
  const ra_ = (args, opts) => run(node, [cli, ...args], opts);
  const git = (cwd, args, opts = {}) => run("git", args, { cwd, ...opts });

  const https = installHttpsRemoteStub(root, node);
  const world = {
    https,
    root, prefix, home, ra, stubs, ghStubs, bare, cli, cliDir, node, version, gitconfig, env, run, git, cliRun: ra_,
    pathWith: (...dirs) => [...dirs, basePath].join(delimiter),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };

  // The real installers, as a person's agent would run them. `--claude-home` keeps init inside the temp HOME.
  const claudeHome = join(home, ".claude");
  const setupRepo = join(root, "setup-repo");
  mkdirSync(setupRepo, { recursive: true });
  git(setupRepo, ["init", "-q"]);
  const init = ra_(["init", "--claude-home", claudeHome], { cwd: setupRepo });
  if (init.code !== 0) throw new Error(`repo-aegis init failed (${init.code}): ${init.stderr}${init.stdout}`);
  writeFileSync(join(ra, "engagements.yaml"), REGISTRY_YAML);
  const rendered = ra_(["render"], { cwd: setupRepo });
  if (rendered.code !== 0) throw new Error(`repo-aegis render failed (${rendered.code}): ${rendered.stderr}${rendered.stdout}`);
  // A stub taaad (the App-token minter) for `install shim` to pin: it answers a `mint` with a token for the repository asked.
  const taaadDir = join(root, "taaad-bin");
  writeStub(
    taaadDir,
    "taaad",
    `repo=""
while [ $# -gt 0 ]; do
  if [ "$1" = "--repo" ]; then repo="$2"; fi
  shift
done
owner="\${repo%/*}"
name="\${repo#*/}"
printf '{"token":"%s","expiresAt":"2099-01-01T00:00:00Z","installationAccount":"%s","installationId":1,"appId":2,"repositories":["%s"],"permissions":{"contents":"write","metadata":"read"}}\n' '${APP_TOKEN}' "$owner" "$name"`,
  );
  const shim = ra_(["install", "shim"], { cwd: setupRepo, env: { PATH: [taaadDir, basePath].join(delimiter) } });
  if (shim.code !== 0) throw new Error(`repo-aegis install shim failed (${shim.code}): ${shim.stderr}${shim.stdout}`);

  // `install git-credential` needs a person at a keyboard, so its effect is reproduced: the same keys, and the same line,
  // rendered by the installed build's own `helperCommand` (a release that predates the export gets the hand-written copy).
  const renderedLine = installerHelperLine(cliDir, node, cli, ra, { PATH: basePath });
  world.helperLine = renderedLine ?? handWrittenHelperLine(node, cli, ra);
  world.helperLineSource = renderedLine === null ? "hand-written" : "installer";
  git(home, ["config", "--global", "credential.https://github.com.useHttpPath", "true"]);
  git(home, ["config", "--global", "--add", "credential.https://github.com.helper", ""]);
  git(home, ["config", "--global", "--add", "credential.https://github.com.helper", world.helperLine]);

  world.claudeHome = claudeHome;
  return world;
}

/**
 * Make `dir` and everything under it read-only (directories 0555, files without their write bits), the way a sandbox
 * that leaves a configuration directory outside its write list sees it. Returns a function that puts every mode back,
 * which a caller MUST run (in `finally` or `after`) before the world is cleaned up.
 */
export function makeReadOnly(dir) {
  const saved = [];
  const walk = (p) => {
    const st = lstatSync(p);
    if (st.isSymbolicLink()) return;
    saved.push([p, st.mode & 0o7777]);
    if (st.isDirectory()) for (const name of readdirSync(p)) walk(join(p, name));
  };
  walk(dir);
  for (const [p, mode] of [...saved].reverse()) chmodSync(p, mode & ~0o222);
  return () => {
    for (const [p, mode] of saved) chmodSync(p, mode);
  };
}
