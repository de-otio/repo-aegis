// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
/**
 * End-to-end check of the human-presence gates (issue #151, D8): each gated
 * command runs as the BUILT CLI in a subprocess whose stderr and stdin are
 * pipes, exactly what an agent's shell gives it. No test seam is involved, so
 * this exercises the real `process.stderr.isTTY` default, and the registry
 * must be byte-identical afterwards.
 *
 * Both env escapes are set on every run to prove neither lifts a gate.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { cliBuilt, cliPath } from "../_subprocess-utils.js";

const skip = cliBuilt() ? undefined : `built CLI not found at ${cliPath}; run \`npm run build\` first`;

const POPULATED = `\
schemaVersion: 2
always_block: []
personalOrgs:
  - home-handle
allowedUpstreams:
  - upstream-org/lib
engagements:
  - id: existing-customer
    name: Existing Customer
    started: 2026-01-01
    markers:
      - existing-marker
    githubOrgs:
      - existing-customer-org
`;

const LAST_OWNER = `\
schemaVersion: 2
always_block: []
engagements:
  - id: only-customer
    name: Only Customer
    started: 2026-01-01
    markers:
      - only-marker
    githubOrgs:
      - only-customer-org
`;

let tmp: string;
before(() => {
  tmp = mkdtempSync(join(tmpdir(), "repo-aegis-owner-gates-cli-"));
});
after(() => rmSync(tmp, { recursive: true, force: true }));

interface Home {
  home: string;
  registry: string;
}

function makeHome(name: string, registry: string): Home {
  const home = join(tmp, name);
  mkdirSync(join(home, "markers"), { recursive: true });
  mkdirSync(join(home, "state"), { recursive: true });
  const path = join(home, "engagements.yaml");
  writeFileSync(path, registry);
  return { home, registry: path };
}

/** stdin and stderr are pipes (the spawnSync default), never terminals. */
function run(h: Home, args: string[]): { code: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [cliPath, ...args, "--json"], {
    cwd: h.home,
    env: {
      ...process.env,
      REPO_AEGIS_HOME: h.home,
      REPO_AEGIS_EGRESS_HUMAN: "1",
      REPO_AEGIS_WAIVE_NONINTERACTIVE: "1",
    },
    encoding: "utf8",
    input: "y\n", // even a piped "y" must not confirm anything
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

function refused(h: Home, args: string[], code: string, extra: (stderr: string) => void = () => {}): void {
  const before = readFileSync(h.registry);
  const r = run(h, args);
  assert.equal(r.code, 2, `${args.join(" ")}: stdout=${r.stdout} stderr=${r.stderr}`);
  assert.match(r.stderr, new RegExp(code), r.stderr);
  assert.match(r.stderr, /No approval covers this/);
  assert.deepEqual(readFileSync(h.registry), before, `${args.join(" ")} must leave the registry byte-identical`);
  extra(r.stderr);
}

describe("gated commands refuse as a subprocess with piped stderr", { skip }, () => {
  it("engagements add --personal-org", () => {
    refused(makeHome("c-personal", POPULATED), ["engagements", "add", "--personal-org", "stranger"], "OWNER_ADD_NEEDS_TTY");
  });

  it("engagements add --github-org", () => {
    const h = makeHome("c-github", POPULATED);
    refused(h, ["engagements", "add", "new-eng", "--github-org", "stranger"], "OWNER_ADD_NEEDS_TTY", () => {
      assert.ok(!existsSync(join(h.home, "markers", "new-eng.txt")));
    });
  });

  it("upstreams add", () => {
    refused(makeHome("c-up-add", POPULATED), ["upstreams", "add", "stranger/repo"], "OWNER_ADD_NEEDS_TTY");
  });

  it("init --migrate-classify (any owner in classify.yml)", () => {
    const h = makeHome("c-migrate", POPULATED);
    writeFileSync(join(h.home, "classify.yml"), `rules:\n  - match: "github\\\\.com[:/]zzq-cli-org/"\n    class: public-eligible\n`);
    refused(h, ["init", "--migrate-classify", "--no-with-hooks", "--no-with-claude"], "OWNER_ADD_NEEDS_TTY", stderr => {
      assert.ok(existsSync(join(h.home, "classify.yml")));
      assert.ok(!existsSync(join(h.home, "classify.yml.legacy")));
      assert.ok(!stderr.includes("zzq-cli-org"));
    });
  });

  it("init --force over a populated registry (H1)", () => {
    refused(makeHome("c-force", POPULATED), ["init", "--force", "--no-with-hooks", "--no-with-claude"], "OWNER_SET_EMPTY_NEEDS_TTY");
  });

  it("engagements remove --hard of the last owner-holding engagement (H1)", () => {
    refused(makeHome("c-remove-last", LAST_OWNER), ["engagements", "remove", "only-customer", "--hard"], "OWNER_SET_EMPTY_NEEDS_TTY");
  });

  it("engagements remove --hard of the last of several long-ended owner-holding engagements (H1)", () => {
    const h = makeHome(
      "c-remove-last-ended",
      "schemaVersion: 2\nengagements:\n  - id: old1\n    name: O1\n    ended: 2020-01-01\n    markers: []\n    githubOrgs: [old1-org]\n",
    );
    refused(h, ["engagements", "remove", "old1", "--hard"], "OWNER_SET_EMPTY_NEEDS_TTY");
  });
});

describe("ungated commands still work as a subprocess with piped stderr", { skip }, () => {
  it("upstreams list and remove", () => {
    const h = makeHome("c-up-ok", POPULATED);
    const ls = run(h, ["upstreams", "list"]);
    assert.equal(ls.code, 0, ls.stderr);
    assert.deepEqual(JSON.parse(ls.stdout), { action: "upstreams-list", upstreams: ["upstream-org/lib"] });
    const rm = run(h, ["upstreams", "remove", "upstream-org/lib"]);
    assert.equal(rm.code, 0, rm.stderr);
    assert.doesNotMatch(readFileSync(h.registry, "utf8"), /upstream-org\/lib/);
  });

  it("engagements remove --hard when another owner remains", () => {
    const h = makeHome("c-remove-ok", POPULATED);
    const r = run(h, ["engagements", "remove", "existing-customer", "--hard"]);
    assert.equal(r.code, 0, r.stderr);
  });

  it("engagements end --purge (removes no owners)", () => {
    const h = makeHome("c-end-purge", LAST_OWNER);
    const r = run(h, ["engagements", "end", "only-customer", "--purge"]);
    assert.equal(r.code, 0, r.stderr);
  });

  it("init --force over an empty stub registry", () => {
    const h = makeHome("c-force-stub", "always_block: []\nengagements: []\n");
    const r = run(h, ["init", "--force", "--no-with-hooks", "--no-with-claude"]);
    assert.equal(r.code, 0, r.stderr);
  });

  it("engagements add without an owner flag", () => {
    const h = makeHome("c-plain-add", POPULATED);
    const r = run(h, ["engagements", "add", "plain-eng", "--marker", "plain-marker"]);
    assert.equal(r.code, 0, r.stderr);
  });
});
