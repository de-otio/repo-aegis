// SPDX-License-Identifier: GPL-3.0-or-later
// Copy the user docs into the CLI's dist so the npm package carries them: `repo-aegis explain` reads the agent
// guide from them, and `repo-aegis docs` prints any of them, from any directory (an agent working in another
// repo has no checkout of this one). Run by `npm run build` (root) and by packages/cli's own build script.
//
// The list below is mirrored by TOPICS in packages/cli/src/commands/docs.ts; docs.test.ts fails when they drift.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, posix, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "packages", "cli", "dist", "docs");

/** Source path (from the repo root, posix) -> path inside dist/docs. */
const SHIPPED = new Map([
  ["README.md", "README.md"],
  ["doc/cli-reference.md", "cli-reference.md"],
  ["doc/configuration.md", "configuration.md"],
  ["doc/agent-guide.md", "agent-guide.md"],
  ["doc/agent-sandbox.md", "agent-sandbox.md"],
  ["doc/agent-install.md", "agent-install.md"],
  ["doc/design/egress-guard.md", "design/egress-guard.md"],
  ["CHANGELOG.md", "CHANGELOG.md"],
]);

const GITHUB = "https://github.com/de-otio/repo-aegis";

/**
 * Relative links are made to work in the package:
 *   - a link to another shipped doc is re-pointed at that doc's place in dist/docs
 *     (`../README.md` in doc/agent-guide.md becomes `README.md`);
 *   - a link to anything else in the repository (source, other docs) becomes an absolute GitHub link,
 *     because the package does not carry those files;
 *   - URLs, bare anchors, links in fenced code and links to files that do not exist stay as written.
 */
function rewriteLinks(text, srcPath) {
  let fence = false;
  return text
    .split("\n")
    .map(line => {
      if (/^\s*(```|~~~)/.test(line)) fence = !fence;
      if (fence) return line;
      return line.replace(/\]\(([^)\s#][^)\s]*?)(#[^)\s]*)?\)/g, (whole, target, anchor = "") => {
        if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return whole;
        const resolved = posix.normalize(posix.join(posix.dirname(srcPath), target));
        const dest = SHIPPED.get(resolved);
        if (dest !== undefined) return `](${posix.relative(posix.dirname(SHIPPED.get(srcPath)), dest)}${anchor})`;
        if (resolved.startsWith("..")) return whole;
        const onDisk = join(root, ...resolved.split("/"));
        if (!existsSync(onDisk)) return whole;
        const kind = statSync(onDisk).isDirectory() ? "tree" : "blob";
        return `](${GITHUB}/${kind}/main/${resolved.replace(/\/$/, "")}${anchor})`;
      });
    })
    .join("\n");
}

for (const [src, dest] of SHIPPED) {
  const from = join(root, ...src.split("/"));
  if (!existsSync(from)) throw new Error(`copy-cli-docs: ${src} is missing`);
  const to = resolve(out, ...dest.split("/"));
  if (relative(out, to).startsWith("..")) throw new Error(`copy-cli-docs: ${dest} escapes dist/docs`);
  mkdirSync(dirname(to), { recursive: true });
  writeFileSync(to, rewriteLinks(readFileSync(from, "utf8"), src));
}
