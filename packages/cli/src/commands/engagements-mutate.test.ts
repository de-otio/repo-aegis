// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureOutput, withEnv } from "../_test-utils.js";
import {
  engagementsAdd,
  engagementsEnd,
  engagementsShow,
  engagementsRemove,
} from "./engagements-mutate.js";

let tmp: string;

before(() => {
  tmp = mkdtempSync(join(tmpdir(), "repo-aegis-engagements-test-"));
});

after(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const STUB_REGISTRY = `\
# repo-aegis engagement registry
always_block: []
engagements:
  - id: existing-customer
    name: Existing Customer
    started: 2026-01-01
    markers:
      - existing-marker
`;

interface Env {
  home: string;
  registryPath: string;
}

function setupEnv(name: string): Env {
  const home = join(tmp, name);
  mkdirSync(join(home, "markers"), { recursive: true });
  mkdirSync(join(home, "state"), { recursive: true });
  const registryPath = join(home, "engagements.yaml");
  writeFileSync(registryPath, STUB_REGISTRY);
  return { home, registryPath };
}

describe("engagements add — happy path", () => {
  let env: Env;

  before(() => {
    env = setupEnv("add-happy");
    withEnv("REPO_AEGIS_HOME", env.home, () => {
      captureOutput(() =>
        engagementsAdd("new-customer", {
          name: "New Customer",
          marker: ["new-marker-pattern"],
          registryPath: env.registryPath,
        }),
      );
    });
  });

  it("writes the new engagement to the registry", () => {
    const body = readFileSync(env.registryPath, "utf8");
    assert.ok(body.includes("new-customer"));
    assert.ok(body.includes("New Customer"));
    assert.ok(body.includes("new-marker-pattern"));
  });

  it("preserves the existing engagement", () => {
    const body = readFileSync(env.registryPath, "utf8");
    assert.ok(body.includes("existing-customer"));
    assert.ok(body.includes("existing-marker"));
  });

  it("preserves YAML comments", () => {
    const body = readFileSync(env.registryPath, "utf8");
    assert.ok(body.includes("# repo-aegis engagement registry"));
  });

  it("triggers render — marker file is created", () => {
    const markerFile = join(env.home, "markers", "new-customer.txt");
    assert.ok(existsSync(markerFile));
    assert.ok(readFileSync(markerFile, "utf8").includes("new-marker-pattern"));
  });
});

describe("engagements add — duplicate id", () => {
  it("refuses to add an existing id and exits 2", () => {
    const env = setupEnv("add-dup");
    const result = withEnv("REPO_AEGIS_HOME", env.home, () =>
      captureOutput(() =>
        engagementsAdd("existing-customer", {
          marker: ["any-marker"],
          registryPath: env.registryPath,
        }),
      ),
    );
    assert.equal(result.exitCode, 2);
    assert.ok(result.stderr.includes("already exists"));
  });
});

describe("engagements add — reserved id", () => {
  it("rejects _always as engagement id", () => {
    const env = setupEnv("add-reserved");
    const result = withEnv("REPO_AEGIS_HOME", env.home, () =>
      captureOutput(() =>
        engagementsAdd("_always", {
          marker: ["any"],
          registryPath: env.registryPath,
        }),
      ),
    );
    assert.equal(result.exitCode, 2);
    assert.ok(result.stderr.includes("reserved"));
  });
});

describe("engagements add — invalid pattern", () => {
  it("exits 2 with PATTERN_VALIDATION when a marker is invalid", () => {
    const env = setupEnv("add-invalid");
    const result = withEnv("REPO_AEGIS_HOME", env.home, () =>
      captureOutput(() =>
        engagementsAdd("bad-customer", {
          marker: ["[unclosed-bracket"],
          registryPath: env.registryPath,
        }),
      ),
    );
    assert.equal(result.exitCode, 2);
    assert.ok(result.stderr.includes("validation"));
  });
});

describe("engagements add — JSON output", () => {
  it("emits the expected shape", () => {
    const env = setupEnv("add-json");
    const result = withEnv("REPO_AEGIS_HOME", env.home, () =>
      captureOutput(() =>
        engagementsAdd("json-customer", {
          name: "JSON Customer",
          marker: ["json-marker"],
          registryPath: env.registryPath,
          json: true,
        }),
      ),
    );
    const j = JSON.parse(result.stdout) as {
      action: string;
      id: string;
      name: string;
      markers: number;
      rendered: { written: unknown[] };
    };
    assert.equal(j.action, "engagements-add");
    assert.equal(j.id, "json-customer");
    assert.equal(j.name, "JSON Customer");
    assert.equal(j.markers, 1);
    assert.ok(Array.isArray(j.rendered.written));
  });
});

describe("engagements end — default (retain markers)", () => {
  let env: Env;

  before(() => {
    env = setupEnv("end-default");
    withEnv("REPO_AEGIS_HOME", env.home, () => {
      captureOutput(() =>
        engagementsEnd("existing-customer", { registryPath: env.registryPath }),
      );
    });
  });

  it("sets ended date in registry", () => {
    // Timing-sensitive: `engagementsEnd` writes `ended: <todayIso()>` at
    // the moment the `before()` hook ran. Comparing strict-equality to
    // `new Date().toISOString().slice(0,10)` here flakes across UTC
    // midnight (the before hook ran on day N, the assertion runs on day
    // N+1). We instead verify the format and tolerate today-or-yesterday
    // (UTC) — the only two values it can legitimately have under
    // realistic test execution windows.
    const body = readFileSync(env.registryPath, "utf8");
    assert.ok(body.includes("ended:"));
    const m = body.match(/ended:\s*(\d{4}-\d{2}-\d{2})/);
    assert.ok(m, `expected an ISO-date 'ended:' line; got body:\n${body}`);
    const ended = m![1]!;
    assert.match(ended, /^\d{4}-\d{2}-\d{2}$/);
    const now = Date.now();
    const today = new Date(now).toISOString().slice(0, 10);
    const yesterday = new Date(now - 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    assert.ok(
      ended === today || ended === yesterday,
      `ended=${ended} should be today (${today}) or yesterday (${yesterday}) UTC`,
    );
  });

  it("retains marker file (within retention window)", () => {
    const markerFile = join(env.home, "markers", "existing-customer.txt");
    assert.ok(existsSync(markerFile), "marker file should still exist within retention");
  });
});

describe("engagements end — purge", () => {
  it("back-dates ended so render removes the marker file", () => {
    const env = setupEnv("end-purge");
    withEnv("REPO_AEGIS_HOME", env.home, () => {
      captureOutput(() =>
        engagementsEnd("existing-customer", {
          purge: true,
          registryPath: env.registryPath,
        }),
      );
    });
    const markerFile = join(env.home, "markers", "existing-customer.txt");
    assert.ok(!existsSync(markerFile), "purge should remove marker file at render");
  });
});

describe("engagements end — not found", () => {
  it("exits 2 when engagement id is unknown", () => {
    const env = setupEnv("end-missing");
    const result = withEnv("REPO_AEGIS_HOME", env.home, () =>
      captureOutput(() =>
        engagementsEnd("does-not-exist", { registryPath: env.registryPath }),
      ),
    );
    assert.equal(result.exitCode, 2);
    assert.ok(result.stderr.includes("not found"));
  });
});

describe("engagements show", () => {
  let env: Env;

  beforeEach(() => {
    env = setupEnv(`show-${Math.random().toString(36).slice(2)}`);
  });

  it("prints engagement details for a known id", () => {
    const result = withEnv("REPO_AEGIS_HOME", env.home, () =>
      captureOutput(() =>
        engagementsShow("existing-customer", { registryPath: env.registryPath }),
      ),
    );
    assert.ok(result.stdout.includes("existing-customer"));
    assert.ok(result.stdout.includes("Existing Customer"));
    assert.ok(result.stdout.includes("active:"));
  });

  it("emits expected JSON shape", () => {
    const result = withEnv("REPO_AEGIS_HOME", env.home, () =>
      captureOutput(() =>
        engagementsShow("existing-customer", {
          registryPath: env.registryPath,
          json: true,
        }),
      ),
    );
    const j = JSON.parse(result.stdout) as {
      action: string;
      id: string;
      name: string;
      active: boolean;
      markerCount: number;
    };
    assert.equal(j.action, "engagements-show");
    assert.equal(j.id, "existing-customer");
    assert.equal(j.name, "Existing Customer");
    assert.equal(j.active, true);
    assert.equal(j.markerCount, 1);
  });

  it("exits 2 when engagement id is unknown", () => {
    const result = withEnv("REPO_AEGIS_HOME", env.home, () =>
      captureOutput(() =>
        engagementsShow("does-not-exist", { registryPath: env.registryPath }),
      ),
    );
    assert.equal(result.exitCode, 2);
    assert.ok(result.stderr.includes("not found"));
  });
});

describe("engagements remove --hard", () => {
  it("refuses without --hard and exits 2", () => {
    const env = setupEnv("remove-no-hard");
    const result = withEnv("REPO_AEGIS_HOME", env.home, () =>
      captureOutput(() =>
        engagementsRemove("existing-customer", { registryPath: env.registryPath }),
      ),
    );
    assert.equal(result.exitCode, 2);
    assert.ok(result.stderr.includes("--hard"));
    // Entry should still be in the registry
    const body = readFileSync(env.registryPath, "utf8");
    assert.ok(body.includes("existing-customer"));
  });

  it("with --hard, removes the entry and triggers render", () => {
    const env = setupEnv("remove-hard");
    // First confirm the marker file would exist after a regular render
    withEnv("REPO_AEGIS_HOME", env.home, () => {
      captureOutput(() =>
        engagementsRemove("existing-customer", {
          hard: true,
          registryPath: env.registryPath,
        }),
      );
    });
    const body = readFileSync(env.registryPath, "utf8");
    assert.ok(!body.includes("existing-customer"), "entry must be physically gone from YAML");
    const markerFile = join(env.home, "markers", "existing-customer.txt");
    assert.ok(!existsSync(markerFile), "marker file must be removed by post-remove render");
  });

  it("rejects the reserved _always id", () => {
    const env = setupEnv("remove-reserved");
    const result = withEnv("REPO_AEGIS_HOME", env.home, () =>
      captureOutput(() =>
        engagementsRemove("_always", {
          hard: true,
          registryPath: env.registryPath,
        }),
      ),
    );
    assert.equal(result.exitCode, 2);
    assert.ok(result.stderr.includes("reserved"));
  });

  it("idempotent: removing a non-existent engagement is a clear no-op", () => {
    const env = setupEnv("remove-noop");
    const result = withEnv("REPO_AEGIS_HOME", env.home, () =>
      captureOutput(() =>
        engagementsRemove("never-existed", {
          hard: true,
          registryPath: env.registryPath,
        }),
      ),
    );
    assert.equal(result.exitCode, undefined);
    assert.ok(result.stdout.includes("not in registry"));
  });

  it("emits the expected JSON shape", () => {
    const env = setupEnv("remove-json");
    const result = withEnv("REPO_AEGIS_HOME", env.home, () =>
      captureOutput(() =>
        engagementsRemove("existing-customer", {
          hard: true,
          registryPath: env.registryPath,
          json: true,
        }),
      ),
    );
    const j = JSON.parse(result.stdout) as {
      action: string;
      id: string;
      removed: boolean;
      rendered: { written: unknown[]; removed: unknown[] };
    };
    assert.equal(j.action, "engagements-remove");
    assert.equal(j.id, "existing-customer");
    assert.equal(j.removed, true);
    assert.ok(Array.isArray(j.rendered.removed));
  });
});

// ---------------------------------------------------------------------------
// Phase 1: --github-org and --personal-org
// ---------------------------------------------------------------------------

describe("engagements add — --github-org", () => {
  it("populates githubOrgs on the new engagement and bumps schemaVersion", () => {
    const env = setupEnv("add-github-org");
    withEnv("REPO_AEGIS_HOME", env.home, () => {
      captureOutput(() =>
        engagementsAdd("foo-corp", {
          name: "Foo Corp",
          githubOrg: ["foo-corp", "foo-corp-archived"],
          registryPath: env.registryPath,
        }),
      );
    });
    const body = readFileSync(env.registryPath, "utf8");
    assert.ok(body.includes("githubOrgs"));
    assert.ok(body.includes("foo-corp"));
    assert.ok(body.includes("foo-corp-archived"));
    assert.ok(/schemaVersion:\s*2/.test(body), `body: ${body}`);
  });

  it("[SEC M-8] emits a warning on v1 → v2 schemaVersion bump", () => {
    const env = setupEnv("add-github-org-bump");
    let stderrOutput = "";
    withEnv("REPO_AEGIS_HOME", env.home, () => {
      const result = captureOutput(() =>
        engagementsAdd("bar-co", {
          name: "Bar Co",
          githubOrg: ["bar-co"],
          registryPath: env.registryPath,
        }),
      );
      stderrOutput = result.stderr;
    });
    assert.ok(
      /schemaVersion bumped from 1 to 2/.test(stderrOutput),
      `stderr: ${stderrOutput}`,
    );
  });

  it("does not bump or warn when registry is already schemaVersion 2", () => {
    const env = setupEnv("add-github-org-no-bump");
    writeFileSync(
      env.registryPath,
      `schemaVersion: 2
always_block: []
engagements:
  - id: existing-customer
    name: Existing
    started: 2026-01-01
    markers: [existing-marker]
`,
    );
    let stderrOutput = "";
    withEnv("REPO_AEGIS_HOME", env.home, () => {
      const result = captureOutput(() =>
        engagementsAdd("new-corp", {
          name: "New Corp",
          githubOrg: ["new-corp"],
          registryPath: env.registryPath,
        }),
      );
      stderrOutput = result.stderr;
    });
    assert.ok(
      !/schemaVersion bumped/.test(stderrOutput),
      `stderr should not contain bump warning: ${stderrOutput}`,
    );
  });

  it("rejects invalid org names (uppercase, leading hyphen, empty)", () => {
    const env = setupEnv("add-github-org-invalid");
    withEnv("REPO_AEGIS_HOME", env.home, () => {
      const result = captureOutput(() =>
        engagementsAdd("foo", {
          githubOrg: ["FOO-Corp", "-bad", ""],
          registryPath: env.registryPath,
          json: true,
        }),
      );
      assert.equal(result.exitCode, 2);
      // emitError writes JSON to stderr in --json mode; uppercase and
      // empty are rejected, leading-hyphen is also rejected.
      const j = JSON.parse(result.stderr) as { code: string };
      assert.equal(j.code, "INVALID_ORG_NAME");
    });
  });

  it("lowercases org names automatically", () => {
    const env = setupEnv("add-github-org-lowercase");
    writeFileSync(
      env.registryPath,
      `schemaVersion: 2
always_block: []
engagements: []
`,
    );
    withEnv("REPO_AEGIS_HOME", env.home, () => {
      captureOutput(() =>
        engagementsAdd("foo-mixed", {
          githubOrg: ["Foo-Corp"], // mixed case input
          registryPath: env.registryPath,
        }),
      );
    });
    const body = readFileSync(env.registryPath, "utf8");
    assert.ok(body.includes("foo-corp"), `body: ${body}`);
    assert.ok(!body.includes("Foo-Corp"), `body should be lowercased: ${body}`);
  });

  it("dedupes within a single --github-org invocation", () => {
    const env = setupEnv("add-github-org-dedupe");
    writeFileSync(
      env.registryPath,
      `schemaVersion: 2
always_block: []
engagements: []
`,
    );
    withEnv("REPO_AEGIS_HOME", env.home, () => {
      const result = captureOutput(() =>
        engagementsAdd("dup-corp", {
          githubOrg: ["dup-corp", "DUP-Corp", "dup-corp"],
          registryPath: env.registryPath,
          json: true,
        }),
      );
      const j = JSON.parse(result.stdout) as { githubOrgs: string[] };
      assert.deepEqual(j.githubOrgs, ["dup-corp"]);
    });
  });
});

describe("engagements add — --personal-org", () => {
  it("appends to top-level personalOrgs and skips engagement creation", () => {
    const env = setupEnv("add-personal-org");
    withEnv("REPO_AEGIS_HOME", env.home, () => {
      captureOutput(() =>
        engagementsAdd(undefined, {
          personalOrg: ["my-handle"],
          registryPath: env.registryPath,
        }),
      );
    });
    const body = readFileSync(env.registryPath, "utf8");
    assert.ok(/personalOrgs:/.test(body), `body: ${body}`);
    assert.ok(/my-handle/.test(body));
    // Should NOT have created an engagement; existing list unchanged
    assert.ok(/existing-customer/.test(body));
  });

  it("idempotent — re-adding an existing personal org is a no-op", () => {
    const env = setupEnv("add-personal-org-idempotent");
    withEnv("REPO_AEGIS_HOME", env.home, () => {
      captureOutput(() =>
        engagementsAdd(undefined, {
          personalOrg: ["my-handle"],
          registryPath: env.registryPath,
        }),
      );
      const result = captureOutput(() =>
        engagementsAdd(undefined, {
          personalOrg: ["my-handle"],
          registryPath: env.registryPath,
          json: true,
        }),
      );
      const j = JSON.parse(result.stdout) as {
        added: string[];
        skipped: string[];
      };
      assert.deepEqual(j.added, []);
      assert.deepEqual(j.skipped, ["my-handle"]);
    });
  });

  it("rejects when --personal-org is combined with a positional <id>", () => {
    const env = setupEnv("personal-with-id");
    withEnv("REPO_AEGIS_HOME", env.home, () => {
      const result = captureOutput(() =>
        engagementsAdd("an-engagement", {
          personalOrg: ["my-handle"],
          registryPath: env.registryPath,
          json: true,
        }),
      );
      assert.equal(result.exitCode, 2);
      const j = JSON.parse(result.stderr) as { code: string; error: string };
      assert.equal(j.code, "USAGE");
      assert.ok(/does not take a positional/.test(j.error));
    });
  });
});

describe("engagements add — flag conflict", () => {
  it("rejects --github-org + --personal-org together", () => {
    const env = setupEnv("conflict");
    withEnv("REPO_AEGIS_HOME", env.home, () => {
      const result = captureOutput(() =>
        engagementsAdd("foo", {
          githubOrg: ["a"],
          personalOrg: ["b"],
          registryPath: env.registryPath,
          json: true,
        }),
      );
      assert.equal(result.exitCode, 2);
      const j = JSON.parse(result.stderr) as { code: string; error: string };
      assert.equal(j.code, "USAGE");
      assert.ok(/mutually exclusive/.test(j.error));
    });
  });
});
