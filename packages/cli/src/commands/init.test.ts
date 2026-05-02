/**
 * Tests for `init.ts`. Migrated to the shared `_test-utils` helpers.
 *
 * Most tests pass `withHooks: false, withClaude: false` so they don't touch
 * the real `~/.claude` or set git config on a tmp git repo. Dedicated tests
 * for the wiring use overrides (`cwd`, `claudeHome`) to install into a
 * tmp dir.
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureOutputAsync, withEnvAsync } from "../_test-utils.js";
import { init } from "./init.js";

let tmp: string;

before(() => {
  tmp = mkdtempSync(join(tmpdir(), "repo-aegis-init-test-"));
});

after(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("init command — fresh init in empty home", () => {
  let home: string;

  before(async () => {
    home = join(tmp, "fresh-home");
    await withEnvAsync("REPO_AEGIS_HOME", home, () =>
      captureOutputAsync(() => init({ withHooks: false, withClaude: false })),
    );
  });

  it("creates home directory", () => {
    assert.ok(existsSync(home));
  });

  it("home directory has mode 0700", () => {
    const st = statSync(home);
    assert.equal(st.mode & 0o777, 0o700);
  });

  it("creates markers directory", () => {
    assert.ok(existsSync(join(home, "markers")));
  });

  it("creates state directory", () => {
    assert.ok(existsSync(join(home, "state")));
  });

  it("creates engagements.yaml", () => {
    assert.ok(existsSync(join(home, "engagements.yaml")));
  });

  it("engagements.yaml has mode 0600", () => {
    const st = statSync(join(home, "engagements.yaml"));
    assert.equal(st.mode & 0o777, 0o600);
  });

  it("engagements.yaml contains stub content", () => {
    const body = readFileSync(join(home, "engagements.yaml"), "utf8");
    assert.ok(body.includes("always_block"));
    assert.ok(body.includes("engagements"));
    assert.ok(body.includes("example-customer"));
  });

  it("prints 'scaffolded engagements.yaml' to stdout", async () => {
    const fresh = join(tmp, "fresh-home-output");
    const r = await withEnvAsync("REPO_AEGIS_HOME", fresh, () =>
      captureOutputAsync(() => init({ withHooks: false, withClaude: false })),
    );
    assert.ok(r.stdout.includes("scaffolded engagements.yaml"));
  });

  it("exits 0 (no exit call on success)", async () => {
    const fresh = join(tmp, "fresh-home-exit");
    const r = await withEnvAsync("REPO_AEGIS_HOME", fresh, () =>
      captureOutputAsync(() => init({ withHooks: false, withClaude: false })),
    );
    assert.equal(r.exitCode, undefined);
  });
});

describe("init command — idempotent re-init (no --force)", () => {
  let home: string;
  let contentBefore: string;

  before(async () => {
    home = join(tmp, "idempotent-home");
    mkdirSync(home, { recursive: true });
    await withEnvAsync("REPO_AEGIS_HOME", home, () =>
      captureOutputAsync(() => init({ withHooks: false, withClaude: false })),
    );
    contentBefore = readFileSync(join(home, "engagements.yaml"), "utf8");
  });

  it("exits 0 on second run", async () => {
    const r = await withEnvAsync("REPO_AEGIS_HOME", home, () =>
      captureOutputAsync(() => init({ withHooks: false, withClaude: false })),
    );
    assert.equal(r.exitCode, undefined);
  });

  it("does not overwrite existing registry", async () => {
    await withEnvAsync("REPO_AEGIS_HOME", home, () =>
      captureOutputAsync(() => init({ withHooks: false, withClaude: false })),
    );
    const after = readFileSync(join(home, "engagements.yaml"), "utf8");
    assert.equal(contentBefore, after);
  });

  it("prints 'registry already exists at <path>'", async () => {
    const r = await withEnvAsync("REPO_AEGIS_HOME", home, () =>
      captureOutputAsync(() => init({ withHooks: false, withClaude: false })),
    );
    assert.ok(r.stdout.includes("registry already exists at"));
    assert.ok(r.stdout.includes("engagements.yaml"));
  });
});

describe("init command — --force flag", () => {
  let home: string;

  before(async () => {
    home = join(tmp, "force-home");
    mkdirSync(home, { recursive: true });
    await withEnvAsync("REPO_AEGIS_HOME", home, () =>
      captureOutputAsync(() => init({ withHooks: false, withClaude: false })),
    );
  });

  it("overwrites existing registry when --force is passed", async () => {
    const regPath = join(home, "engagements.yaml");
    const original = readFileSync(regPath, "utf8");
    writeFileSync(regPath, original + "\n# extra comment to detect overwrite\n");
    await withEnvAsync("REPO_AEGIS_HOME", home, () =>
      captureOutputAsync(() => init({ force: true, withHooks: false, withClaude: false })),
    );
    const after = readFileSync(regPath, "utf8");
    assert.ok(after.includes("example-customer"));
    assert.ok(!after.includes("extra comment to detect overwrite"));
  });
});

describe("init command — --json output", () => {
  let home: string;

  beforeEach(() => {
    home = join(tmp, `json-home-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(home, { recursive: true });
  });

  it("emits valid JSON with expected shape on fresh init", async () => {
    const r = await withEnvAsync("REPO_AEGIS_HOME", home, () =>
      captureOutputAsync(() => init({ json: true, withHooks: false, withClaude: false })),
    );
    const j = JSON.parse(r.stdout) as {
      action: string;
      home: string;
      registry: { path: string; scaffolded: boolean; alreadyExisted: boolean };
      rendered: { written: unknown[]; removed: unknown[] };
      hooks: { ran: boolean };
      claude: { ran: boolean };
    };
    assert.equal(j.action, "init");
    assert.equal(j.home, home);
    assert.ok(j.registry.path.endsWith("engagements.yaml"));
    assert.equal(j.registry.scaffolded, true);
    assert.equal(j.registry.alreadyExisted, false);
    assert.equal(j.hooks.ran, false);
    assert.equal(j.claude.ran, false);
  });

  it("alreadyExisted=true on re-init", async () => {
    await withEnvAsync("REPO_AEGIS_HOME", home, () =>
      captureOutputAsync(() => init({ withHooks: false, withClaude: false })),
    );
    const r = await withEnvAsync("REPO_AEGIS_HOME", home, () =>
      captureOutputAsync(() => init({ json: true, withHooks: false, withClaude: false })),
    );
    const j = JSON.parse(r.stdout) as { registry: { scaffolded: boolean; alreadyExisted: boolean } };
    assert.equal(j.registry.alreadyExisted, true);
    assert.equal(j.registry.scaffolded, false);
  });
});

describe("init command — --with-hooks wires installHooks", () => {
  it("sets core.hooksPath when --with-hooks is on (default) and cwd is a git repo", async () => {
    const home = join(tmp, "with-hooks-home");
    mkdirSync(home, { recursive: true });
    const repo = join(tmp, "with-hooks-repo");
    mkdirSync(repo, { recursive: true });
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "test"], { cwd: repo });

    await withEnvAsync("REPO_AEGIS_HOME", home, () =>
      captureOutputAsync(() => init({ cwd: repo, withClaude: false })),
    );

    const out = execFileSync("git", ["config", "--get", "core.hooksPath"], {
      cwd: repo,
      encoding: "utf8",
    }).trim();
    assert.equal(out, join(home, "hooks"));
    assert.ok(existsSync(join(home, "hooks", "pre-commit")));
    assert.ok(existsSync(join(home, "hooks", "pre-push")));
  });
});

describe("init command — --with-claude wires installClaudeMd", () => {
  it("writes scan-after-write.sh and registers the hook in settings.json", async () => {
    const home = join(tmp, "with-claude-aegis-home");
    mkdirSync(join(home, "state"), { recursive: true });
    const claudeHome = join(tmp, "with-claude-claude-home");
    mkdirSync(claudeHome, { recursive: true });

    await withEnvAsync("REPO_AEGIS_HOME", home, () =>
      captureOutputAsync(() => init({ withHooks: false, claudeHome })),
    );

    assert.ok(existsSync(join(claudeHome, "hooks", "scan-after-write.sh")));
    const settings = JSON.parse(readFileSync(join(claudeHome, "settings.json"), "utf8")) as {
      hooks: { PostToolUse: { matcher: string }[] };
    };
    assert.ok(settings.hooks.PostToolUse.some(e => e.matcher === "Write|Edit|MultiEdit"));
  });
});

describe("init command — renderMarkers behaviour", () => {
  it("exits 0 with stub scaffold (no patterns to validate)", async () => {
    const home = join(tmp, "render-ok-home");
    mkdirSync(home, { recursive: true });
    const r = await withEnvAsync("REPO_AEGIS_HOME", home, () =>
      captureOutputAsync(() => init({ withHooks: false, withClaude: false })),
    );
    assert.equal(r.exitCode, undefined);
  });

  it("marker files are created after init", async () => {
    const home = join(tmp, "render-markers-home");
    mkdirSync(home, { recursive: true });
    await withEnvAsync("REPO_AEGIS_HOME", home, () =>
      captureOutputAsync(() => init({ withHooks: false, withClaude: false })),
    );
    assert.ok(existsSync(join(home, "markers", "_always.txt")));
  });
});
