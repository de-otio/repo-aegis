// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// `repo-aegis explain`: the shipped docs, the section extraction, and the command from a directory that is not
// the repo-aegis repository. Placeholders only.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cliBuilt, cliPath } from "../_subprocess-utils.js";
import {
  errorRows,
  explanationFor,
  findRow,
  knownCodes,
  loadDocs,
  nearest,
  sections,
  slugify,
  type Docs,
} from "./explain.js";

const here = dirname(fileURLToPath(import.meta.url)); // packages/cli/dist/commands
const distDocs = resolve(here, "..", "docs");
const repoRoot = resolve(here, "..", "..", "..", "..");
const cliPackage = resolve(here, "..", "..");

describe("the docs ship in the built package", () => {
  for (const name of ["agent-guide.md", "agent-sandbox.md"]) {
    it(`dist/docs/${name} exists and is the current doc/${name}`, () => {
      assert.ok(existsSync(join(distDocs, name)), `${name} is missing from dist/docs: did the build run scripts/copy-cli-docs.mjs?`);
      // The copy re-points relative links at the shipped layout (`../README.md` -> `README.md`), so compare the text
      // with every link target blanked; docs.test.ts checks that the links resolve.
      const blank = (s: string): string => s.replace(/\]\([^)\s]*\)/g, "](…)");
      assert.equal(blank(readFileSync(join(distDocs, name), "utf8")), blank(readFileSync(join(repoRoot, "doc", name), "utf8")), `${name} in dist is stale`);
    });
  }

  it("`npm pack` would include them (the `files` list does not strip dist/docs)", () => {
    const r = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: cliPackage, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    const [pack] = JSON.parse(r.stdout) as Array<{ files: Array<{ path: string }> }>;
    const paths = pack!.files.map(f => f.path);
    assert.ok(paths.includes("dist/docs/agent-guide.md"), paths.join("\n"));
    assert.ok(paths.includes("dist/docs/agent-sandbox.md"));
    assert.ok(!paths.some(p => /\.test\./.test(p)), "tests must stay out of the package");
  });
});

const MINI = `\
# Guide

## Error codes

Intro text.

| Code | Meaning | Recovery |
|---|---|---|
| \`USAGE\` | flag combination invalid | re-read the flags |
| <a id="alpha_code"></a>\`ALPHA_CODE\` | does a \\| b | see [Deep dive](#deep-dive) and [Top](#top-level) |
| <a id="beta_one"></a>\`BETA_ONE\` / \`BETA_TWO\` | two codes, one row | do the thing |
| \`MULTIPLE_INSTALLS\` (\`engagements set-identity\`) | lower-case words in a cell are not codes | x |

\`\`\`
### Not a heading
| \`FENCED\` | inside a fence | ignored |
\`\`\`

## Next section

| \`OUTSIDE\` | not in the error table | ignored |

### Deep dive

First paragraph.

\`\`\`
### also not a heading
\`\`\`

#### Sub heading

Sub text.

### Another

Other text.

## Top level

Top text.
`;
const mini: Docs = { guide: MINI, sandbox: "# Sandbox\n\nSandbox text.\n" };

describe("parsing the error table", () => {
  it("slugs headings the way GitHub does", () => {
    assert.equal(slugify("Owners are the user's to register"), "owners-are-the-users-to-register");
    assert.equal(slugify('"I get `customer-coupled` errors"'), "i-get-customer-coupled-errors");
    assert.equal(slugify("Deep dive"), "deep-dive");
  });

  it("reads rows: codes, anchor, an escaped pipe, several codes, links; ignores fences, other sections and lower-case words", () => {
    const rows = errorRows(MINI);
    assert.deepEqual(
      rows.map(r => [r.codes, r.anchor]),
      [
        [["USAGE"], null],
        [["ALPHA_CODE"], "alpha_code"],
        [["BETA_ONE", "BETA_TWO"], "beta_one"],
        [["MULTIPLE_INSTALLS"], null],
      ],
    );
    assert.equal(rows[1]!.meaning, "does a | b");
    assert.deepEqual(rows[1]!.links, ["deep-dive", "top-level"]);
  });

  it("finds a row by code, case-insensitively, by a second code, by anchor, and with - for _", () => {
    for (const q of ["ALPHA_CODE", "alpha_code", "alpha-code", "[ALPHA_CODE]", "  Alpha_Code "]) assert.equal(findRow(mini, q)?.anchor, "alpha_code", q);
    assert.equal(findRow(mini, "BETA_TWO")?.anchor, "beta_one");
    assert.equal(findRow(mini, "USAGE")?.codes[0], "USAGE");
    assert.equal(findRow(mini, "FENCED"), null);
    assert.equal(findRow(mini, "OUTSIDE"), null);
    assert.equal(findRow(mini, ""), null);
  });

  it("attaches the ### section the row links to, up to the next ### (a #### stays inside, a fenced ### does not end it), and not a ## link", () => {
    const e = explanationFor(mini, "alpha_code")!;
    assert.equal(e.section?.heading, "Deep dive");
    assert.match(e.section!.markdown, /^### Deep dive\n/);
    assert.match(e.section!.markdown, /First paragraph\./);
    assert.match(e.section!.markdown, /#### Sub heading\n\nSub text\./);
    assert.match(e.section!.markdown, /### also not a heading/);
    assert.doesNotMatch(e.section!.markdown, /Other text|Top text/);
    assert.equal(explanationFor(mini, "USAGE")!.section, null); // no link, no section
  });

  it("sections() ends a section at the next heading of the same or a higher level", () => {
    const s = sections(MINI).find(x => x.slug === "next-section")!;
    assert.match(s.markdown, /OUTSIDE/);
    assert.match(s.markdown, /### Another\n\nOther text\./); // a `###` is inside its `##`
    assert.doesNotMatch(s.markdown, /Top text/); // the next `##` ends it
  });

  it("knownCodes lists every code once, sorted", () => {
    assert.deepEqual(knownCodes(mini), ["ALPHA_CODE", "BETA_ONE", "BETA_TWO", "MULTIPLE_INSTALLS", "USAGE"]);
  });

  it("nearest ranks containment and small edits, and offers nothing for noise", () => {
    const known = ["GH_IDENTITY_WRITE_NEEDS_HUMAN", "GH_IDENTITY_UNAVAILABLE", "UNREGISTERED_OWNER_EGRESS", "USAGE"];
    assert.equal(nearest("gh_identity_write_need", known)[0], "GH_IDENTITY_WRITE_NEEDS_HUMAN");
    assert.equal(nearest("UNREGISTERED_OWNER_EGRES", known)[0], "UNREGISTERED_OWNER_EGRESS");
    assert.equal(nearest("USGAE", known)[0], "USAGE");
    assert.deepEqual(nearest("zzzzzzzzzzzzzz", known), []);
    assert.deepEqual(nearest("", known), []);
  });
});

describe("the real guide", { skip: loadDocs() === null }, () => {
  const docs = loadDocs()!;

  it("every anchor in the error table resolves to its own row", () => {
    const rows = errorRows(docs.guide);
    assert.ok(rows.length > 60, `only ${rows.length} rows parsed`);
    for (const r of rows) {
      if (r.anchor === null) continue;
      assert.equal(findRow(docs, r.anchor)?.anchor, r.anchor, r.anchor);
      for (const c of r.codes) assert.ok(explanationFor(docs, c) !== null, c);
    }
  });

  it("every anchor the guide declares (anywhere) is a row of the table, so a trailer code never dead-ends", () => {
    const declared = [...docs.guide.matchAll(/<a id="([^"]+)"><\/a>/g)].map(m => m[1]!);
    assert.ok(declared.length > 30);
    const rowAnchors = new Set(errorRows(docs.guide).map(r => r.anchor));
    for (const a of declared) assert.ok(rowAnchors.has(a), `anchor ${a} is outside the error table`);
  });

  // Every code a refusal can end with is documented: the codes are literals in the built (non-test) modules that
  // build refusals, so a new code without a row fails here instead of dead-ending an agent.
  it("every code in a built refusal builder has a row", () => {
    const core = resolve(cliPackage, "..", "core", "dist");
    const files = [
      ...["egress-policy.js", "egress-network-rules.js", "identity-choice.js", "human-commands.js"].map(f => join(core, f)),
      ...["gh-command.js", "git-credential.js", "hook-guard-egress.js", "hook-check-write.js"].map(f => join(here, f)),
    ];
    const seen = new Set<string>();
    for (const f of files) {
      for (const m of readFileSync(f, "utf8").matchAll(/\bcode: "([A-Z][A-Z0-9_]{5,})"/g)) seen.add(m[1]!);
    }
    assert.ok(seen.size >= 15, `only ${seen.size} codes found: the scan no longer sees the builders`);
    const missing = [...seen].filter(c => explanationFor(docs, c) === null);
    assert.deepEqual(missing, []);
  });

  it("GH_IDENTITY_WRITE_NEEDS_HUMAN and UNREGISTERED_OWNER_EGRESS explain themselves; the latter brings its linked section", () => {
    const a = explanationFor(docs, "GH_IDENTITY_WRITE_NEEDS_HUMAN")!;
    assert.match(a.meaning, /only a `person` identity/);
    assert.match(a.recovery, /repo-aegis approve/);
    const b = explanationFor(docs, "unregistered_owner_egress")!;
    assert.equal(b.section?.heading, "Owners are the user's to register");
    assert.match(b.section!.markdown, /^### Owners are the user's to register/);
    assert.doesNotMatch(b.section!.markdown, /^## Error codes/m);
  });

  it("a row that names two codes answers to both", () => {
    assert.equal(explanationFor(docs, "GH_IDENTITY_SEVERAL_REPOS")?.anchor, explanationFor(docs, "GH_IDENTITY_SEVERAL_OWNERS")?.anchor);
  });

  it("documents the new trailer, so the guide and the code agree", () => {
    assert.match(docs.guide, /\[<CODE>; details: repo-aegis explain <CODE>\]/);
    assert.doesNotMatch(docs.guide, /see doc\/agent-guide\.md#/);
  });
});

describe("repo-aegis explain, run from a directory that is not the repo-aegis repository", { skip: !cliBuilt() }, () => {
  let cwd: string;
  before(() => {
    cwd = realpathSync(mkdtempSync(join(tmpdir(), "repo-aegis-explain-cwd-")));
  });
  after(() => rmSync(cwd, { recursive: true, force: true }));

  // No registry, no home, no git: a home that does not exist, an empty directory, and git ignored.
  function run(...args: string[]): { stdout: string; stderr: string; code: number | null } {
    const r = spawnSync(process.execPath, [cliPath, ...args], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, REPO_AEGIS_HOME: join(cwd, "no-such-home"), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
    });
    return { stdout: r.stdout, stderr: r.stderr, code: r.status };
  }

  it("prints the row for a code, from any directory, touching no registry", () => {
    const r = run("explain", "GH_IDENTITY_WRITE_NEEDS_HUMAN");
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^GH_IDENTITY_WRITE_NEEDS_HUMAN\n/);
    assert.match(r.stdout, /Meaning: /);
    assert.match(r.stdout, /Recovery: /);
    assert.equal(existsSync(join(cwd, "no-such-home")), false, "explain created a home");
    assert.deepEqual(readdirSync(cwd), [], "explain wrote into the working directory");
  });

  it("works for the exact word in a refusal's trailer, whatever its case", () => {
    for (const q of ["UNREGISTERED_OWNER_EGRESS", "unregistered_owner_egress"]) {
      const r = run("explain", q);
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stdout, /Owners are the user's to register/);
    }
  });

  it("--json prints the same fields", () => {
    const r = run("explain", "AGENT_RAN_HUMAN_COMMAND", "--json");
    assert.equal(r.code, 0, r.stderr);
    const body = JSON.parse(r.stdout) as { code: string; meaning: string; recovery: string; anchor: string };
    assert.equal(body.code, "AGENT_RAN_HUMAN_COMMAND");
    assert.equal(body.anchor, "agent_ran_human_command");
    assert.match(body.recovery, /stop/);
  });

  it("--list prints every code, one per line, and the sandbox topic", () => {
    const r = run("explain", "--list");
    assert.equal(r.code, 0, r.stderr);
    const lines = r.stdout.trim().split("\n");
    for (const c of ["USAGE", "GH_IDENTITY_WRITE_NEEDS_HUMAN", "AGENT_PUSH_CREDENTIAL_STORE", "HOOK_INPUT_TOO_LARGE"]) assert.ok(lines.includes(c), c);
    assert.ok(lines.includes("sandbox (topic)"));
    const j = JSON.parse(run("explain", "--list", "--json").stdout) as { codes: string[]; topics: string[] };
    assert.ok(j.codes.includes("USAGE") && j.topics.includes("sandbox"));
  });

  it("a topic prints the shipped sandbox guide", () => {
    const r = run("explain", "sandbox");
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^# /);
    assert.equal(r.stdout.trimEnd(), readFileSync(join(distDocs, "agent-sandbox.md"), "utf8").trimEnd());
  });

  it("an unknown code exits 2 with the nearest ones; --json carries them in details", () => {
    const r = run("explain", "GH_IDENTITY_WRITE_NEED");
    assert.equal(r.code, 2);
    assert.match(r.stderr, /no explanation for "GH_IDENTITY_WRITE_NEED"; nearest: GH_IDENTITY_WRITE_NEEDS_HUMAN/);
    const j = run("explain", "GH_IDENTITY_WRITE_NEED", "--json");
    assert.equal(j.code, 2);
    const body = JSON.parse(j.stderr) as { code: string; details: { nearest: string[] } };
    assert.equal(body.code, "UNKNOWN_CODE");
    assert.equal(body.details.nearest[0], "GH_IDENTITY_WRITE_NEEDS_HUMAN");
  });

  it("nothing like a code is still exit 2, and echoes at most a bounded prefix", () => {
    const r = run("explain", `zz${"x".repeat(500)}`);
    assert.equal(r.code, 2);
    assert.ok(r.stderr.length < 400, String(r.stderr.length));
  });

  it("without a code it is a usage error, not a crash", () => {
    const r = run("explain", "--json");
    assert.equal(r.code, 2);
    assert.equal((JSON.parse(r.stderr) as { code: string }).code, "USAGE");
  });
});
