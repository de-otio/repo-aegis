// SPDX-License-Identifier: GPL-3.0-or-later
// taaadChecks: a missing pin (a failure) and a pin that is not root-owned (a warning) give different fixes.
// The failure needs taaad installed; root ownership is optional hardening (plan §2.1, Q5).
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { parseRegistryText } from "@de-otio/repo-aegis-core";
import { taaadChecks } from "./doctor-owner-checks.js";
import { SHIM_HEADER_LINE } from "./shim-script.js";

const APP_MAPPED = parseRegistryText(
  "schemaVersion: 3\n" +
    "identities:\n  me: { kind: gh-login, login: alice }\n  me-bot: { kind: github-app, app: example-bot }\n" +
    "personalOrgs:\n  - { name: example-org, person: me, agent: me-bot }\n" +
    "engagements: []\n",
);

const root = mkdtempSync(join(tmpdir(), "ra-taaad-checks-"));
after(() => rmSync(root, { recursive: true, force: true }));

const NO_APP = parseRegistryText(
  "schemaVersion: 3\n" +
    "identities:\n  me: { kind: gh-login, login: alice }\n" +
    "personalOrgs:\n  - { name: example-org, person: me }\n" +
    "engagements: []\n",
);

describe("taaadChecks condition (X-9)", () => {
  it("reports nothing when no owner maps an App as its agent identity, pinned taaad or not", () => {
    const empty = join(root, "cond-no-pin");
    mkdirSync(empty, { recursive: true });
    assert.deepEqual(taaadChecks(NO_APP, empty), []);
    assert.deepEqual(taaadChecks(parseRegistryText("schemaVersion: 3\npersonalOrgs:\n  - example-org\nengagements: []\n"), empty), []);
  });

  it("a pinned taaad that is not root-owned is not reported either when no owner maps an App (it used to warn)", () => {
    const home = join(root, "cond-pinned-no-app");
    const venv = join(root, "cond-venv");
    mkdirSync(join(home, "bin"), { recursive: true });
    mkdirSync(join(venv, "bin"), { recursive: true });
    const launcher = join(venv, "bin", "taaad");
    const interp = join(venv, "bin", "python3");
    writeFileSync(launcher, "#!/bin/sh\n", { mode: 0o755 });
    writeFileSync(interp, "#!/bin/sh\n", { mode: 0o755 });
    writeFileSync(
      join(home, "bin", "gh"),
      `#!/bin/sh\n${SHIM_HEADER_LINE}\n__ra_taaad='${launcher}'\n__ra_taaad_interp='${interp}'\n__ra_taaad_pkg='${venv}'\n`,
      { mode: 0o755 },
    );
    assert.deepEqual(taaadChecks(NO_APP, home), []);
    assert.equal(taaadChecks(APP_MAPPED, home)[0]?.severity, "warn", "with an App agent the same pin is a warning");
  });

  it("reports as soon as one owner maps an App in the agent column", () => {
    const empty = join(root, "cond-app");
    mkdirSync(empty, { recursive: true });
    assert.equal(taaadChecks(APP_MAPPED, empty).length, 1);
  });
});

describe("taaadChecks fix text", () => {
  it("no taaad pinned with an App mapped: a failure whose fix is to install taaad, not root ownership", () => {
    const home = join(root, "no-pin");
    mkdirSync(home, { recursive: true });
    const [c] = taaadChecks(APP_MAPPED, home);
    assert.ok(c !== undefined);
    assert.equal(c.code, "TAAAD_AGENT_WRITABLE");
    assert.equal(c.ok, false);
    assert.equal(c.severity, undefined, "a missing pin is a failure, not a warning");
    assert.match(c.fix ?? "", /taaad v0\.6\.0 or later/);
    assert.doesNotMatch(c.fix ?? "", /root-owned/);
  });

  it("a pin that is not root-owned: a warning whose fix is marked optional", () => {
    const home = join(root, "user-pin");
    const venv = join(root, "venv");
    mkdirSync(join(home, "bin"), { recursive: true });
    mkdirSync(join(venv, "bin"), { recursive: true });
    const launcher = join(venv, "bin", "taaad");
    const interp = join(venv, "bin", "python3");
    writeFileSync(launcher, "#!/bin/sh\n", { mode: 0o755 });
    writeFileSync(interp, "#!/bin/sh\n", { mode: 0o755 });
    writeFileSync(
      join(home, "bin", "gh"),
      `#!/bin/sh\n${SHIM_HEADER_LINE}\n__ra_taaad='${launcher}'\n__ra_taaad_interp='${interp}'\n__ra_taaad_pkg='${venv}'\n`,
      { mode: 0o755 },
    );
    const [c] = taaadChecks(APP_MAPPED, home);
    assert.ok(c !== undefined);
    assert.equal(c.code, "TAAAD_AGENT_WRITABLE");
    assert.equal(c.ok, false);
    assert.equal(c.severity, "warn");
    assert.match(c.fix ?? "", /^optional: /);
    assert.match(c.fix ?? "", /root-owned prefix/);
  });
});
