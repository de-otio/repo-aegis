// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// `repo-aegis docs`: the shipped user docs (P1-F). An agent helping a person whose command was blocked must be able
// to read the reference from any directory, so the list must match what the build copies, the command must print
// what it lists, and the links inside the agent guide must resolve inside `dist/docs`. Placeholders only.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { cliBuilt, cliPath } from "../_subprocess-utils.js";
import { TOPICS } from "./docs.js";
import { sections } from "./explain.js";

const here = dirname(fileURLToPath(import.meta.url)); // packages/cli/dist/commands
const distDocs = resolve(here, "..", "docs");
const repoRoot = resolve(here, "..", "..", "..", "..");
const cliPackage = resolve(here, "..", "..");

/** Every file under `dir`, as posix paths relative to it. */
function walk(dir: string, prefix = ""): string[] {
  return readdirSync(join(dir, prefix), { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? walk(dir, `${prefix}${e.name}/`) : [`${prefix}${e.name}`],
  );
}

/** Where each topic's doc comes from in a checkout. */
const SOURCE: Readonly<Record<string, string>> = {
  "README.md": "README.md",
  "cli-reference.md": "doc/cli-reference.md",
  "configuration.md": "doc/configuration.md",
  "agent-guide.md": "doc/agent-guide.md",
  "agent-sandbox.md": "doc/agent-sandbox.md",
  "agent-install.md": "doc/agent-install.md",
  "design/egress-guard.md": "doc/design/egress-guard.md",
  "CHANGELOG.md": "CHANGELOG.md",
};

let tmp: string;
before(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "repo-aegis-docs-test-")));
});
after(() => rmSync(tmp, { recursive: true, force: true }));

function run(args: string[]): { stdout: string; stderr: string; code: number | null } {
  // A directory that is not the repo-aegis checkout, and an empty home: the command needs neither.
  const r = spawnSync(process.execPath, [cliPath, ...args], {
    cwd: tmp,
    env: { ...process.env, REPO_AEGIS_HOME: join(tmp, "home") },
    encoding: "utf8",
  });
  return { stdout: r.stdout, stderr: r.stderr, code: r.status };
}

describe("the user docs ship in dist/docs", () => {
  it("dist/docs holds exactly the docs `repo-aegis docs` lists", () => {
    assert.ok(existsSync(distDocs), "dist/docs is missing: did the build run scripts/copy-cli-docs.mjs?");
    assert.deepEqual(walk(distDocs).sort(), TOPICS.map(t => t.file).sort());
  });

  it("every topic name is unique and every doc has a known source", () => {
    assert.equal(new Set(TOPICS.map(t => t.topic)).size, TOPICS.length);
    assert.deepEqual(Object.keys(SOURCE).sort(), TOPICS.map(t => t.file).sort());
  });

  for (const t of TOPICS) {
    it(`${t.file} is the current ${SOURCE[t.file]}`, () => {
      // The copy re-points relative links at the shipped layout; compare the text with link targets blanked.
      const blank = (s: string): string => s.replace(/\]\([^)\s]*\)/g, "](…)");
      assert.equal(
        blank(readFileSync(join(distDocs, t.file), "utf8")),
        blank(readFileSync(join(repoRoot, SOURCE[t.file]!), "utf8")),
        `${t.file} in dist is stale: run npm run build`,
      );
    });
  }

  it("`npm pack` would include every one of them (the `files` list does not strip dist/docs)", () => {
    const r = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: cliPackage, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    const [pack] = JSON.parse(r.stdout) as Array<{ files: Array<{ path: string }> }>;
    const paths = new Set(pack!.files.map(f => f.path));
    for (const t of TOPICS) assert.ok(paths.has(`dist/docs/${t.file}`), `${t.file} is not in the package:\n${[...paths].join("\n")}`);
  });
});

describe("repo-aegis docs", { skip: !cliBuilt() }, () => {
  it("with no topic, lists every shipped doc", () => {
    const r = run(["docs"]);
    assert.equal(r.code, 0, r.stderr);
    for (const t of TOPICS) assert.match(r.stdout, new RegExp(`^${t.topic}\\s`, "m"), `${t.topic} is not listed:\n${r.stdout}`);
  });

  it("the short names an agent would reach for are topics", () => {
    const names = TOPICS.map(t => t.topic);
    for (const n of ["readme", "cli-reference", "configuration", "agent-guide", "egress-guard", "changelog"]) assert.ok(names.includes(n), n);
  });

  for (const t of TOPICS) {
    it(`docs ${t.topic} prints ${t.file}, and --path names that file`, () => {
      const file = join(distDocs, ...t.file.split("/"));
      const body = readFileSync(file, "utf8");
      const printed = run(["docs", t.topic]);
      assert.equal(printed.code, 0, printed.stderr);
      assert.equal(printed.stdout, body.endsWith("\n") ? body : body + "\n");
      const path = run(["docs", t.topic, "--path"]);
      assert.equal(path.code, 0, path.stderr);
      assert.equal(path.stdout.trim(), file);
      assert.ok(isAbsolute(path.stdout.trim()));
    });
  }

  it("an unknown topic exits 2 and names every topic", () => {
    const r = run(["docs", "no-such-doc"]);
    assert.equal(r.code, 2);
    assert.equal(r.stdout, "");
    for (const t of TOPICS) assert.ok(r.stderr.includes(t.topic), `${t.topic} missing from:\n${r.stderr}`);
  });

  it("--json prints the topics, a doc, or its path", () => {
    const list = JSON.parse(run(["docs", "--json"]).stdout) as { topics: Array<{ topic: string; path: string }> };
    assert.deepEqual(list.topics.map(t => t.topic), TOPICS.map(t => t.topic));
    for (const t of list.topics) assert.ok(existsSync(t.path), t.path);
    const one = JSON.parse(run(["docs", "cli-reference", "--json"]).stdout) as { topic: string; markdown: string };
    assert.equal(one.topic, "cli-reference");
    assert.match(one.markdown, /^# repo-aegis — CLI reference/);
    const err = run(["docs", "nope", "--json"]);
    assert.equal(err.code, 2);
    assert.equal((JSON.parse(err.stderr) as { code: string }).code, "UNKNOWN_DOC_TOPIC");
  });

  it("is not a person-only command: an agent's guard lets it through", () => {
    const r = spawnSync(process.execPath, [cliPath, "hook", "guard-egress"], {
      cwd: tmp,
      env: { ...process.env, REPO_AEGIS_HOME: join(tmp, "home"), REPO_AEGIS_VISIBILITY_LOOKUP: "0" },
      encoding: "utf8",
      input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "repo-aegis docs cli-reference --path" }, cwd: tmp }),
    });
    assert.equal(r.status, 0, r.stderr);
  });
});

describe("links inside the shipped agent guide resolve inside dist/docs", () => {
  const guidePath = join(distDocs, "agent-guide.md");
  const guide = existsSync(guidePath) ? readFileSync(guidePath, "utf8") : "";
  // Links outside code fences; skip URLs and bare anchors.
  const text = guide.replace(/^\s*(```|~~~)[\s\S]*?^\s*\1/gm, "");
  const links = [...text.matchAll(/\]\(([^)\s]+)\)/g)].map(m => m[1]!).filter(l => !/^[a-z][a-z0-9+.-]*:/i.test(l));

  it("the guide has relative links to check (so this test cannot pass on nothing)", () => {
    assert.ok(links.some(l => l.startsWith("#")), "no in-page anchors found");
    assert.ok(links.some(l => !l.startsWith("#")), "no file links found");
  });

  for (const link of new Set(links)) {
    it(`${link}`, () => {
      const [file, anchor] = link.split("#") as [string, string | undefined];
      const target = file === "" ? guidePath : resolve(dirname(guidePath), file);
      assert.ok(!relative(distDocs, target).startsWith(".." + sep) && relative(distDocs, target) !== "..", `${link} leaves dist/docs`);
      assert.ok(existsSync(target), `${link} does not exist in dist/docs`);
      if (anchor !== undefined && anchor !== "" && target.endsWith(".md")) {
        const body = readFileSync(target, "utf8");
        const slugs = new Set(sections(body).map(s => s.slug));
        const ids = new Set([...body.matchAll(/<a id="([^"]+)"/g)].map(m => m[1]!.toLowerCase()));
        assert.ok(slugs.has(anchor) || ids.has(anchor), `${link}: no heading or anchor "${anchor}" in ${relative(distDocs, target)}`);
      }
    });
  }
});
