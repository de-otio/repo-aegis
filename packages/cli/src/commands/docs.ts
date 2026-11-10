// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// `repo-aegis docs [<topic>] [--path]`: the user docs that ship in the package (`dist/docs/`, copied at build
// time by scripts/copy-cli-docs.mjs), readable from any directory.
//
// When repo-aegis refuses a person, their agent is the first helper they ask, and it may be working in a repo
// that has no checkout of repo-aegis. With the reference, the configuration guide and the README on the machine,
// it can read the exact flags instead of guessing them. `explain` stays for refusal codes.
//
// Read-only on purpose, like `explain`: it reads files that ship next to this module and nothing else. No
// registry, no network, no git, no cwd. That is also why an agent may run it (it is not on the human-only list
// in core/human-commands.ts).
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { emitError, emitJson, emitText, type OutputOptions } from "../format.js";

export interface DocTopic {
  readonly topic: string;
  /** Path inside `dist/docs`, posix. */
  readonly file: string;
  readonly summary: string;
}

/** Every shipped doc. Mirrors the list in scripts/copy-cli-docs.mjs; docs.test.ts fails when they drift. */
export const TOPICS: readonly DocTopic[] = [
  { topic: "readme", file: "README.md", summary: "what repo-aegis is, install, quick start" },
  { topic: "cli-reference", file: "cli-reference.md", summary: "every command, flag, exit code and JSON shape" },
  { topic: "configuration", file: "configuration.md", summary: "registry, environment variables, install modes, the pinned binary" },
  { topic: "agent-guide", file: "agent-guide.md", summary: "for agents: the refusal table, workflows, how to help your person" },
  { topic: "agent-sandbox", file: "agent-sandbox.md", summary: "for agents: running under the Claude Code sandbox" },
  { topic: "agent-install", file: "agent-install.md", summary: "wiring the guard into each coding agent" },
  { topic: "egress-guard", file: "design/egress-guard.md", summary: "design of the destination-aware publishing guard" },
  { topic: "changelog", file: "CHANGELOG.md", summary: "what changed in each release" },
];

/** `dist/docs/` next to `dist/commands/`. */
export function defaultDocsDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "docs");
}

export interface DocsOptions extends OutputOptions {
  /** Print the absolute file path instead of the text. */
  path?: boolean;
  /** Test seam: read the docs from here instead of `dist/docs`. */
  docsDir?: string;
}

export function docs(topic: string | undefined, opts: DocsOptions): void {
  const dir = resolve(opts.docsDir ?? defaultDocsDir());
  const shipped = TOPICS.filter(t => existsSync(join(dir, ...t.file.split("/"))));
  if (shipped.length === 0) {
    emitError(
      {
        code: "DOCS_MISSING",
        error: "the docs are not installed next to this command (dist/docs/); reinstall @de-otio/repo-aegis or run `npm run build` in a checkout",
      },
      opts,
    );
  }
  const names = shipped.map(t => t.topic).join(", ");
  if (topic === undefined || topic.trim() === "") {
    if (opts.json) {
      emitJson({ topics: shipped.map(t => ({ topic: t.topic, summary: t.summary, path: join(dir, ...t.file.split("/")) })) });
      return;
    }
    const width = Math.max(...shipped.map(t => t.topic.length));
    for (const t of shipped) emitText(`${t.topic.padEnd(width)}  ${t.summary}`);
    emitText("");
    emitText("repo-aegis docs <topic> prints a doc; --path prints its file path (to Read or grep it). repo-aegis explain <CODE> explains a refusal.");
    return;
  }
  const wanted = topic.trim().toLowerCase();
  const hit = shipped.find(t => t.topic === wanted);
  if (hit === undefined) {
    emitError(
      {
        code: "UNKNOWN_DOC_TOPIC",
        error: `no doc topic "${topic.trim().slice(0, 80)}". Topics: ${names}`,
        ...(opts.json ? { details: { topics: shipped.map(t => t.topic) } } : {}),
      },
      opts,
    );
  }
  const file = join(dir, ...hit.file.split("/"));
  if (opts.path === true) {
    if (opts.json) emitJson({ topic: hit.topic, path: file });
    else emitText(file);
    return;
  }
  const markdown = readFileSync(file, "utf8");
  if (opts.json) emitJson({ topic: hit.topic, path: file, markdown });
  else process.stdout.write(markdown.endsWith("\n") ? markdown : markdown + "\n");
}
