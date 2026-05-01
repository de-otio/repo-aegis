/**
 * Integration tests for `init.ts`.
 *
 * These tests invoke `init()` directly (not via subprocess) to work around the
 * fact that `index.ts` wires up the command *after* this module is delivered.
 * The coordinator wires `init` into the CLI once both agents are done; until
 * then, subprocess invocation would hit the NOT_IMPLEMENTED stub.
 *
 * We test the filesystem side-effects by pointing `REPO_AEGIS_HOME` at a
 * temporary directory and capturing stdout/stderr through thin wrappers.
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
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

// Helpers to capture stdout/stderr written directly to process streams
function captureOutput(fn: () => void): { stdout: string; stderr: string; exitCode?: number } {
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  let exitCode: number | undefined;

  const origStdoutWrite = process.stdout.write.bind(process.stdout);
  const origStderrWrite = process.stderr.write.bind(process.stderr);
  const origExit = process.exit.bind(process);

  const patchedExit = (code?: number): never => {
    exitCode = code ?? 0;
    // Restore before throwing so teardown works
    process.stdout.write = origStdoutWrite;
    process.stderr.write = origStderrWrite;
    process.exit = origExit;
    throw new ExitError(code ?? 0);
  };

  process.stdout.write = (chunk: unknown, ...args: unknown[]): boolean => {
    stdoutChunks.push(Buffer.from(chunk as string));
    return true;
  };
  process.stderr.write = (chunk: unknown, ...args: unknown[]): boolean => {
    stderrChunks.push(Buffer.from(chunk as string));
    return true;
  };
  (process as NodeJS.Process).exit = patchedExit as typeof process.exit;

  try {
    fn();
  } catch (e) {
    if (!(e instanceof ExitError)) {
      process.stdout.write = origStdoutWrite;
      process.stderr.write = origStderrWrite;
      process.exit = origExit;
      throw e;
    }
  } finally {
    process.stdout.write = origStdoutWrite;
    process.stderr.write = origStderrWrite;
    process.exit = origExit;
  }

  return {
    stdout: Buffer.concat(stdoutChunks).toString("utf8"),
    stderr: Buffer.concat(stderrChunks).toString("utf8"),
    exitCode,
  };
}

class ExitError extends Error {
  constructor(public code: number) {
    super(`process.exit(${code})`);
  }
}

function withHome<T>(home: string, fn: () => T): T {
  const prev = process.env["REPO_AEGIS_HOME"];
  process.env["REPO_AEGIS_HOME"] = home;
  try {
    return fn();
  } finally {
    if (prev === undefined) {
      delete process.env["REPO_AEGIS_HOME"];
    } else {
      process.env["REPO_AEGIS_HOME"] = prev;
    }
  }
}

// Lazily import init so we can set env before module-level code runs
// (paths.ts reads REPO_AEGIS_HOME at call time, not import time, so this is fine)
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

  before(() => {
    home = join(tmp, "fresh-home");
    // Do NOT pre-create; init must create it
    withHome(home, () => {
      captureOutput(() => init({}));
    });
  });

  it("creates home directory", () => {
    assert.ok(existsSync(home), "home directory should exist after init");
  });

  it("home directory has mode 0700", () => {
    const st = statSync(home);
    assert.equal(st.mode & 0o777, 0o700, `home dir mode should be 0700, got ${(st.mode & 0o777).toString(8)}`);
  });

  it("creates markers directory", () => {
    const markersPath = join(home, "markers");
    assert.ok(existsSync(markersPath), "markers directory should exist");
  });

  it("creates state directory", () => {
    const stateDirPath = join(home, "state");
    assert.ok(existsSync(stateDirPath), "state directory should exist");
  });

  it("creates engagements.yaml", () => {
    const regPath = join(home, "engagements.yaml");
    assert.ok(existsSync(regPath), "engagements.yaml should exist");
  });

  it("engagements.yaml has mode 0600", () => {
    const regPath = join(home, "engagements.yaml");
    const st = statSync(regPath);
    assert.equal(st.mode & 0o777, 0o600, `registry mode should be 0600, got ${(st.mode & 0o777).toString(8)}`);
  });

  it("engagements.yaml contains stub content", () => {
    const regPath = join(home, "engagements.yaml");
    const contents = readFileSync(regPath, "utf8");
    assert.ok(contents.includes("always_block"), "stub should contain always_block");
    assert.ok(contents.includes("engagements"), "stub should contain engagements");
    assert.ok(contents.includes("example-customer"), "stub should contain example-customer placeholder");
  });

  it("prints 'scaffolded engagements.yaml' to stdout", () => {
    const freshHome = join(tmp, "fresh-home-output");
    const result = withHome(freshHome, () => captureOutput(() => init({})));
    assert.ok(result.stdout.includes("scaffolded engagements.yaml"), `stdout: ${result.stdout}`);
  });

  it("prints hooks deferred note to stdout", () => {
    const freshHome = join(tmp, "fresh-home-hooks");
    const result = withHome(freshHome, () => captureOutput(() => init({})));
    assert.ok(result.stdout.includes("deferred to v0.2.1"), `stdout: ${result.stdout}`);
  });

  it("exits 0 (no exit call on success)", () => {
    const freshHome = join(tmp, "fresh-home-exit");
    const result = withHome(freshHome, () => captureOutput(() => init({})));
    assert.equal(result.exitCode, undefined, "init should not call process.exit on success");
  });
});

describe("init command — idempotent re-init (no --force)", () => {
  let home: string;
  let contentBefore: string;

  before(() => {
    home = join(tmp, "idempotent-home");
    mkdirSync(home, { recursive: true });
    withHome(home, () => captureOutput(() => init({})));
    contentBefore = readFileSync(join(home, "engagements.yaml"), "utf8");
  });

  it("exits 0 on second run", () => {
    const result = withHome(home, () => captureOutput(() => init({})));
    assert.equal(result.exitCode, undefined, "second init should exit 0");
  });

  it("does not overwrite existing registry", () => {
    withHome(home, () => captureOutput(() => init({})));
    const contentAfter = readFileSync(join(home, "engagements.yaml"), "utf8");
    assert.equal(contentBefore, contentAfter, "registry contents should be unchanged on re-init");
  });

  it("prints 'registry already exists at <path>'", () => {
    const result = withHome(home, () => captureOutput(() => init({})));
    assert.ok(result.stdout.includes("registry already exists at"), `stdout: ${result.stdout}`);
    assert.ok(result.stdout.includes("engagements.yaml"), `stdout: ${result.stdout}`);
  });
});

describe("init command — --force flag", () => {
  let home: string;

  before(() => {
    home = join(tmp, "force-home");
    mkdirSync(home, { recursive: true });
    withHome(home, () => captureOutput(() => init({})));
  });

  it("overwrites existing registry when --force is passed", () => {
    const regPath = join(home, "engagements.yaml");
    const original = readFileSync(regPath, "utf8");
    const modified = original + "\n# extra comment to detect overwrite\n";
    writeFileSync(regPath, modified);

    withHome(home, () => captureOutput(() => init({ force: true })));

    const after = readFileSync(regPath, "utf8");
    assert.notEqual(after, modified, "registry should have been overwritten");
    assert.ok(after.includes("example-customer"), "overwritten registry should contain stub");
  });

  it("prints 'scaffolded engagements.yaml' after --force overwrite", () => {
    const result = withHome(home, () => captureOutput(() => init({ force: true })));
    assert.ok(result.stdout.includes("scaffolded engagements.yaml"), `stdout: ${result.stdout}`);
  });
});

describe("init command — --json output", () => {
  let home: string;

  beforeEach(() => {
    home = join(tmp, `json-home-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(home, { recursive: true });
  });

  it("emits valid JSON with expected shape on fresh init", () => {
    let captured = "";
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: unknown, ...args: unknown[]): boolean => {
      captured += chunk as string;
      return true;
    };
    try {
      withHome(home, () => init({ json: true }));
    } finally {
      process.stdout.write = origWrite;
    }

    const j = JSON.parse(captured) as {
      action: string;
      home: string;
      registry: { path: string; scaffolded: boolean; alreadyExisted: boolean };
      rendered: { written: unknown[]; removed: unknown[] };
      hooks: { deferred: boolean; reason: string };
      claude: { deferred: boolean; reason: string };
    };

    assert.equal(j.action, "init");
    assert.equal(j.home, home);
    assert.ok(j.registry.path.endsWith("engagements.yaml"));
    assert.equal(j.registry.scaffolded, true);
    assert.equal(j.registry.alreadyExisted, false);
    assert.ok(Array.isArray(j.rendered.written));
    assert.ok(Array.isArray(j.rendered.removed));
    assert.equal(j.hooks.deferred, true);
    assert.equal(j.hooks.reason, "v0.2.1 task");
    assert.equal(j.claude.deferred, true);
    assert.equal(j.claude.reason, "v0.2.1 task");
  });

  it("alreadyExisted=true on re-init", () => {
    // First init
    withHome(home, () => captureOutput(() => init({})));

    let captured = "";
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: unknown, ...args: unknown[]): boolean => {
      captured += chunk as string;
      return true;
    };
    try {
      withHome(home, () => init({ json: true }));
    } finally {
      process.stdout.write = origWrite;
    }

    const j = JSON.parse(captured) as { registry: { scaffolded: boolean; alreadyExisted: boolean } };
    assert.equal(j.registry.alreadyExisted, true);
    assert.equal(j.registry.scaffolded, false);
  });

  it("scaffolded=true and alreadyExisted=true with --force", () => {
    // First init
    withHome(home, () => captureOutput(() => init({})));

    let captured = "";
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: unknown, ...args: unknown[]): boolean => {
      captured += chunk as string;
      return true;
    };
    try {
      withHome(home, () => init({ json: true, force: true }));
    } finally {
      process.stdout.write = origWrite;
    }

    const j = JSON.parse(captured) as { registry: { scaffolded: boolean; alreadyExisted: boolean } };
    assert.equal(j.registry.scaffolded, true);
    assert.equal(j.registry.alreadyExisted, true);
  });
});

describe("init command — renderMarkers behaviour", () => {
  /**
   * The scaffold stub has no real patterns (markers: [] for the example
   * engagement, no alwaysBlock entries), so PatternValidationError cannot be
   * triggered by the stub itself. This test verifies init succeeds on fresh
   * scaffold, documenting that the validation path is a no-op with the stub.
   */
  it("exits 0 with stub scaffold (no patterns to validate)", () => {
    const home = join(tmp, "render-ok-home");
    mkdirSync(home, { recursive: true });
    const result = withHome(home, () => captureOutput(() => init({})));
    assert.equal(result.exitCode, undefined, "init should exit 0 with stub scaffold");
  });

  it("marker files are created after init", () => {
    const home = join(tmp, "render-markers-home");
    mkdirSync(home, { recursive: true });
    withHome(home, () => captureOutput(() => init({})));
    // renderMarkers always writes _always.txt
    const alwaysFile = join(home, "markers", "_always.txt");
    assert.ok(existsSync(alwaysFile), "_always.txt should exist after init+render");
  });
});
