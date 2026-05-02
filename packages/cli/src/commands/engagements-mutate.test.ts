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
