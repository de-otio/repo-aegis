// SPDX-License-Identifier: GPL-3.0-or-later
// Copy the user docs into the CLI's dist so the npm package carries them: `repo-aegis explain` reads the agent
// guide from them, and `repo-aegis docs` prints any of them, from any directory (an agent working in another
// repo has no checkout of this one). Run by `npm run build` (root) and by packages/cli's own build script.
//
// The list below is mirrored by TOPICS in packages/cli/src/commands/docs.ts; docs.test.ts fails when they drift.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

/**
 * A relative link that points at another shipped doc is re-pointed at that doc's place in dist/docs
 * (`../README.md` in doc/agent-guide.md becomes `README.md`), so links work in the checkout and in the package.
 * Links to anything not shipped, URLs and bare anchors stay as written.
 */
function rewriteLinks(text, srcPath) {
  return text.replace(/\]\(([^)\s#][^)\s]*?)(#[^)\s]*)?\)/g, (whole, target, anchor = "") => {
    if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return whole;
    const resolved = posix.normalize(posix.join(posix.dirname(srcPath), target));
    const dest = SHIPPED.get(resolved);
    if (dest === undefined) return whole;
    const fromDir = posix.dirname(SHIPPED.get(srcPath));
    return `](${posix.relative(fromDir, dest)}${anchor})`;
  });
}

for (const [src, dest] of SHIPPED) {
  const from = join(root, ...src.split("/"));
  if (!existsSync(from)) throw new Error(`copy-cli-docs: ${src} is missing`);
  const to = resolve(out, ...dest.split("/"));
  if (relative(out, to).startsWith("..")) throw new Error(`copy-cli-docs: ${dest} escapes dist/docs`);
  mkdirSync(dirname(to), { recursive: true });
  writeFileSync(to, rewriteLinks(readFileSync(from, "utf8"), src));
}
