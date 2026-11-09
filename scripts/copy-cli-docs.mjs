// SPDX-License-Identifier: GPL-3.0-or-later
// Copy the agent-facing docs into the CLI's dist so the npm package carries them and `repo-aegis explain`
// can read them from any directory. Run by `npm run build` (root) and by packages/cli's own build script.
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "packages", "cli", "dist", "docs");
mkdirSync(out, { recursive: true });
for (const name of ["agent-guide.md", "agent-sandbox.md"]) {
  copyFileSync(join(root, "doc", name), join(out, name));
}
