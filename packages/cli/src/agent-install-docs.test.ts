// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// Docs and adapters must not drift apart (plan Phase 1, T1e). The hand-
// registration snippets in doc/agent-install.md ("Other agents") are the only
// way a user wires Codex, Gemini, Cursor, Copilot CLI or Antigravity CLI to
// `hook guard-egress`, so this test reads the JSON code blocks out of the
// doc, parses them, and checks that each one:
//
//   - is valid JSON with the structure its host documents (event, matcher);
//   - runs only `repo-aegis hook guard-egress|scan-after-write --agent <name>`;
//   - names an `--agent` value that has a registered adapter;
//   - sits under a paragraph that says it is doc-derived and not exercised
//     in a live session (the honest provenance label);
//   - has a matching hand-removal note in doc/agent-guide.md's uninstall
//     section, and the cli-reference heading lists every registered agent.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ADAPTERS } from "./commands/hook-hosts/index.js";
import { scrubGitEnv } from "./_test-utils.js";
import { cliBuilt, cliPath } from "./_subprocess-utils.js";

const here = dirname(fileURLToPath(import.meta.url));
/** Repo root, reached from `packages/cli/dist`. */
const root = resolve(here, "..", "..", "..");
const read = (rel: string): string => readFileSync(resolve(root, rel), "utf8");
const flat = (s: string): string => s.replace(/\s+/g, " ");

/**
 * Hosts whose adapter lives on another branch while this one is reviewed:
 * their snippets are still parsed and shape-checked, but the "agent is
 * registered" assertion waits for the adapter. A host that IS registered is
 * always checked, so this list can only go stale harmlessly.
 */

const HOSTS: Readonly<Record<string, string>> = {
  codex: "Codex CLI",
  gemini: "Gemini CLI",
  cursor: "Cursor",
  copilot: "Copilot CLI",
  antigravity: "Antigravity CLI",
};

interface Snippet {
  /** The paragraph that introduces the block, from its bold host label on. */
  intro: string;
  json: unknown;
  commands: string[];
  agent: string;
}

function strings(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) for (const x of v) strings(x, out);
  else if (v !== null && typeof v === "object") for (const x of Object.values(v)) strings(x, out);
  return out;
}

function otherAgentsSection(doc: string): string {
  const start = doc.indexOf("\n### Other agents");
  assert.notEqual(start, -1, "agent-install.md has an `Other agents` section");
  const next = doc.indexOf("\n### ", start + 5);
  return doc.slice(start, next === -1 ? undefined : next);
}

function extractSnippets(section: string): Snippet[] {
  const snippets: Snippet[] = [];
  const re = /```json\n([\s\S]*?)\n```/g;
  let prevEnd = 0;
  for (let m = re.exec(section); m !== null; m = re.exec(section)) {
    const before = section.slice(prevEnd, m.index);
    prevEnd = m.index + m[0].length;
    // The host label opens a paragraph: `**Name** — …`.
    const labels = [...before.matchAll(/\n\*\*[A-Z][A-Za-z ]*\*\*(?: \(`agy`\))? —/g)];
    assert.ok(labels.length > 0, "every JSON block is introduced by a bold host label");
    const labelAt = labels[labels.length - 1]!.index!;
    const json: unknown = JSON.parse(m[1]!);
    const commands = strings(json).filter(s => s.includes("repo-aegis"));
    const agents = new Set(commands.map(c => /--agent (\S+)$/.exec(c)?.[1]));
    assert.equal(agents.size, 1, `one --agent value per snippet: ${commands.join(" | ")}`);
    snippets.push({ intro: flat(before.slice(labelAt)).trim(), json, commands, agent: [...agents][0]! });
  }
  return snippets;
}

const doc = read("doc/agent-install.md");
const snippets = extractSnippets(otherAgentsSection(doc));
const byAgent = (a: string): Snippet => {
  const s = snippets.find(x => x.agent === a);
  assert.ok(s, `a snippet for --agent ${a}`);
  return s;
};

describe("doc/agent-install.md host snippets", () => {
  it("covers exactly Codex, Gemini, Cursor, Copilot and Antigravity", () => {
    assert.deepEqual(snippets.map(s => s.agent).sort(), Object.keys(HOSTS).sort());
  });

  for (const [agent, label] of Object.entries(HOSTS)) {
    describe(`--agent ${agent}`, () => {
      it("is introduced by its host label and is marked doc-derived, not exercised in a live session", () => {
        const s = byAgent(agent);
        assert.ok(s.intro.startsWith(`**${label}**`), `${label}: ${s.intro.slice(0, 40)}`);
        assert.match(s.intro, /doc-derived, not exercised in a live session/i);
      });

      it("every repo-aegis command is a hook entry point with --agent last", () => {
        for (const c of byAgent(agent).commands) {
          assert.match(c, /^repo-aegis hook (guard-egress|scan-after-write) --agent [a-z]+$/, c);
        }
        assert.ok(byAgent(agent).commands.some(c => c.startsWith("repo-aegis hook guard-egress ")), "registers the egress guard");
      });

      it("names an --agent value with a registered adapter", () => {
        assert.ok(ADAPTERS.has(agent), `--agent ${agent} is documented but has no adapter in ADAPTERS`);
      });
    });
  }

  it("a registered adapter that no snippet documents is an error (except claude, which install claude-md writes)", () => {
    for (const name of ADAPTERS.keys()) {
      if (name === "claude") continue;
      assert.ok(snippets.some(s => s.agent === name), `adapter ${name} has no hand-registration snippet`);
    }
  });

  it("codex: PreToolUse, matcher `Bash` (not the out-of-date `shell`), and the /hooks trust step is kept", () => {
    const j = byAgent("codex").json as { hooks: { PreToolUse: Array<{ matcher: string; hooks: Array<{ type: string }> }> } };
    assert.equal(j.hooks.PreToolUse[0]!.matcher, "Bash");
    assert.equal(j.hooks.PreToolUse[0]!.hooks[0]!.type, "command");
    assert.match(byAgent("codex").intro, /\/hooks/);
    assert.match(byAgent("codex").intro, /trusted/);
  });

  it("gemini: BeforeTool, matcher run_shell_command", () => {
    const j = byAgent("gemini").json as { hooks: { BeforeTool: Array<{ matcher: string }> } };
    assert.equal(j.hooks.BeforeTool[0]!.matcher, "run_shell_command");
  });

  it("cursor: version 1, beforeShellExecution runs the guard and afterFileEdit runs the write scan", () => {
    const j = byAgent("cursor").json as { version: number; hooks: Record<string, Array<{ command: string }>> };
    assert.equal(j.version, 1);
    assert.deepEqual(Object.keys(j.hooks).sort(), ["afterFileEdit", "beforeShellExecution"]);
    assert.equal(j.hooks["beforeShellExecution"]![0]!.command, "repo-aegis hook guard-egress --agent cursor");
    assert.equal(j.hooks["afterFileEdit"]![0]!.command, "repo-aegis hook scan-after-write --agent cursor");
  });

  it("copilot: version 1, camelCase preToolUse, type command, `bash` field, matcher bash", () => {
    const j = byAgent("copilot").json as { version: number; hooks: Record<string, Array<Record<string, unknown>>> };
    assert.equal(j.version, 1);
    assert.deepEqual(Object.keys(j.hooks), ["preToolUse"]);
    const e = j.hooks["preToolUse"]![0]!;
    assert.equal(e["type"], "command");
    assert.equal(e["bash"], "repo-aegis hook guard-egress --agent copilot");
    assert.equal(e["matcher"], "bash");
  });

  it("antigravity: a named hook group with PreToolUse, matcher run_command, and no version field", () => {
    const j = byAgent("antigravity").json as Record<string, Record<string, Array<{ matcher: string; hooks: Array<{ type: string }> }>>>;
    assert.equal("version" in j, false);
    const groups = Object.values(j);
    assert.equal(groups.length, 1);
    assert.equal(groups[0]!["PreToolUse"]![0]!.matcher, "run_command");
    assert.equal(groups[0]!["PreToolUse"]![0]!.hooks[0]!.type, "command");
  });
});

describe("doc/agent-guide.md uninstall section", () => {
  const guide = read("doc/agent-guide.md");
  const start = guide.indexOf("\n## Uninstalling");
  const section = flat(guide.slice(start, guide.indexOf("\n## ", start + 5)));

  it("has a hand-removal note for every hand-registered host, naming its config file and its command", () => {
    assert.notEqual(start, -1);
    const expect: Record<string, RegExp[]> = {
      codex: [/~\/\.codex\/hooks\.json/, /--agent codex/],
      gemini: [/--agent gemini/],
      cursor: [/\.cursor\/hooks\.json/, /beforeShellExecution/, /afterFileEdit/, /--agent cursor/],
      copilot: [/~\/\.copilot\/hooks\/repo-aegis\.json/, /--agent copilot/],
      antigravity: [/~\/\.gemini\/config\/hooks\.json/, /\.agents\/hooks\.json/, /run_command/],
    };
    assert.deepEqual(Object.keys(expect).sort(), Object.keys(HOSTS).sort());
    for (const [agent, res] of Object.entries(expect)) for (const re of res) assert.match(section, re, `${agent}: ${re}`);
  });

  it("says why a stale Copilot entry matters (it fails closed)", () => {
    assert.match(section, /Copilot CLI \*\*fails closed\*\*/);
  });
});

describe("doc/cli-reference.md", () => {
  it("lists every registered --agent value in the `hook guard-egress` heading", () => {
    const m = /^### `repo-aegis hook guard-egress \[--agent ([^\]]+)\]`/m.exec(read("doc/cli-reference.md"));
    assert.ok(m, "heading found");
    const listed = new Set(m[1]!.split("|"));
    for (const name of ADAPTERS.keys()) assert.ok(listed.has(name), `${name} missing from the heading`);
  });
});

// The self-test blocks in doc/agent-install.md ("Test it once") are claims about behaviour: feed each payload
// through the BUILT hook, with the documented `--agent`, and assert the documented exit code and output. This
// replaces reading the prose for words: a doc that says Cursor denies on stdout with exit 0 is run, not parsed.
describe("doc/agent-install.md self-test blocks run against the built hook", { skip: !cliBuilt() }, () => {
  interface SelfTest {
    agent: string | undefined;
    payload: string;
    code: number;
    fragment: string;
    channel: "stdout" | "stderr";
  }

  /** Every ```sh block line pair: `echo '<payload>' | repo-aegis hook guard-egress [--agent X]` then `echo $?  # N, with <text> on stdout|stderr`. */
  function selfTests(text: string): SelfTest[] {
    const out: SelfTest[] = [];
    for (const block of text.matchAll(/```sh\n([\s\S]*?)\n```/g)) {
      const lines = block[1]!.split("\n");
      lines.forEach((line, i) => {
        const m = /^echo '(.*)' \| repo-aegis hook guard-egress(?: --agent (\S+))?$/.exec(line);
        if (m === null) return;
        const next = /^echo \$\?\s+# (\d+), with (.+) on (stdout|stderr)$/.exec(lines[i + 1] ?? "");
        assert.ok(next, `self-test line has no documented result on the next line: ${line}`);
        out.push({ agent: m[2], payload: m[1]!, code: Number(next[1]), fragment: next[2]!, channel: next[3] as "stdout" | "stderr" });
      });
    }
    return out;
  }

  const tests = selfTests(doc);

  it("documents a self-test for Claude (default agent), Copilot, Cursor and Antigravity", () => {
    assert.deepEqual(tests.map(t => t.agent ?? "claude").sort(), ["antigravity", "claude", "copilot", "cursor"]);
  });

  for (const t of tests) {
    it(`--agent ${t.agent ?? "(default)"}: the documented payload gives exit ${t.code} with ${t.fragment} on ${t.channel}`, () => {
      const restore = scrubGitEnv();
      const tmp = mkdtempSync(join(tmpdir(), "repo-aegis-docs-selftest-"));
      try {
        const env: NodeJS.ProcessEnv = { ...process.env, REPO_AEGIS_HOME: join(tmp, "aegis"), REPO_AEGIS_VISIBILITY_LOOKUP: "0" };
        delete env["REPO_AEGIS_EGRESS_HUMAN"];
        const args = ["hook", "guard-egress", ...(t.agent !== undefined ? ["--agent", t.agent] : [])];
        const r = spawnSync(process.execPath, [cliPath, ...args], { cwd: tmp, env, input: t.payload + "\n", encoding: "utf8" });
        assert.equal(r.status, t.code, `stdout=${r.stdout} stderr=${r.stderr}`);
        const text = t.channel === "stdout" ? r.stdout : r.stderr;
        assert.ok(text.includes(t.fragment), `${t.channel} should contain ${t.fragment}; got ${text}`);
        // The documented deny is a real refusal; the structured reason is on stderr for every host.
        assert.match(r.stderr, /"code": "PUSH_IMPLICIT_TARGET"/);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
        restore();
      }
    });
  }
});
