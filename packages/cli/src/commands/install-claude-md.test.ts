// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
import { describe, it, before, after } from "node:test";
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
import { installClaudeMd } from "./install-claude-md.js";

const HOOK_COMMAND = "repo-aegis hook scan-after-write";

let tmp: string;

before(() => {
  tmp = mkdtempSync(join(tmpdir(), "repo-aegis-install-claude-md-test-"));
});

after(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function makeClaudeHome(name: string): string {
  const dir = join(tmp, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function aegisHomeFor(name: string): string {
  const dir = join(tmp, name + "-aegis");
  mkdirSync(join(dir, "state"), { recursive: true });
  return dir;
}

describe("install-claude-md — fresh install", () => {
  let claudeHome: string;
  let aegisHome: string;

  before(() => {
    claudeHome = makeClaudeHome("fresh");
    aegisHome = aegisHomeFor("fresh");
    withEnv("REPO_AEGIS_HOME", aegisHome, () => {
      captureOutput(() => installClaudeMd({ claudeHome }));
    });
  });

  it("writes CLAUDE.md with the managed block", () => {
    const body = readFileSync(join(claudeHome, "CLAUDE.md"), "utf8");
    assert.ok(body.includes("repo-aegis: managed block"));
    assert.ok(body.includes("repo-aegis (data-leak prevention)"));
  });

  it("does not write a hook shell script (settings.json calls the bin directly)", () => {
    assert.ok(!existsSync(join(claudeHome, "hooks", "scan-after-write.sh")));
    assert.ok(!existsSync(join(claudeHome, "hooks")));
  });

  it("registers PostToolUse hook in settings.json by bin name", () => {
    const settingsPath = join(claudeHome, "settings.json");
    const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as {
      hooks: { PostToolUse: { matcher: string; hooks: { type: string; command: string }[] }[] };
    };
    const post = settings.hooks.PostToolUse;
    assert.equal(post.length, 1);
    assert.equal(post[0]!.matcher, "Write|Edit|MultiEdit");
    assert.equal(post[0]!.hooks.length, 1);
    assert.equal(post[0]!.hooks[0]!.type, "command");
    assert.equal(post[0]!.hooks[0]!.command, HOOK_COMMAND);
  });
});

describe("install-claude-md — idempotency", () => {
  it("re-running does not duplicate the snippet or hook", () => {
    const claudeHome = makeClaudeHome("idem");
    const aegisHome = aegisHomeFor("idem");

    withEnv("REPO_AEGIS_HOME", aegisHome, () => {
      captureOutput(() => installClaudeMd({ claudeHome }));
      captureOutput(() => installClaudeMd({ claudeHome }));
    });

    const claudeMd = readFileSync(join(claudeHome, "CLAUDE.md"), "utf8");
    const matches = claudeMd.match(/repo-aegis: managed block/g) ?? [];
    assert.equal(matches.length, 1, "managed block should appear exactly once");

    const settings = JSON.parse(
      readFileSync(join(claudeHome, "settings.json"), "utf8"),
    ) as { hooks: { PostToolUse: { matcher: string; hooks: unknown[] }[] } };
    const post = settings.hooks.PostToolUse;
    assert.equal(post.length, 1);
    assert.equal(post[0]!.hooks.length, 1, "hook command should appear exactly once");
  });
});

describe("install-claude-md — merges into existing settings", () => {
  it("preserves unrelated keys and PostToolUse entries", () => {
    const claudeHome = makeClaudeHome("merge");
    const aegisHome = aegisHomeFor("merge");

    const settingsPath = join(claudeHome, "settings.json");
    writeFileSync(
      settingsPath,
      JSON.stringify(
        {
          theme: "dark",
          hooks: {
            PostToolUse: [
              {
                matcher: "Bash",
                hooks: [{ type: "command", command: "/some/other/script.sh" }],
              },
            ],
          },
        },
        null,
        2,
      ),
    );

    withEnv("REPO_AEGIS_HOME", aegisHome, () => {
      captureOutput(() => installClaudeMd({ claudeHome }));
    });

    const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as {
      theme: string;
      hooks: { PostToolUse: { matcher: string; hooks: { command: string }[] }[] };
    };
    assert.equal(settings.theme, "dark");
    assert.equal(settings.hooks.PostToolUse.length, 2);
    const aegisEntry = settings.hooks.PostToolUse.find(
      e => e.matcher === "Write|Edit|MultiEdit",
    );
    assert.ok(aegisEntry);
    assert.equal(aegisEntry!.hooks[0]!.command, HOOK_COMMAND);
  });

  it("appends to existing matcher entry without duplicating", () => {
    const claudeHome = makeClaudeHome("merge-existing-matcher");
    const aegisHome = aegisHomeFor("merge-existing-matcher");

    const settingsPath = join(claudeHome, "settings.json");
    writeFileSync(
      settingsPath,
      JSON.stringify(
        {
          hooks: {
            PostToolUse: [
              {
                matcher: "Write|Edit|MultiEdit",
                hooks: [{ type: "command", command: "/another/hook.sh" }],
              },
            ],
          },
        },
        null,
        2,
      ),
    );

    withEnv("REPO_AEGIS_HOME", aegisHome, () => {
      captureOutput(() => installClaudeMd({ claudeHome }));
    });

    const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as {
      hooks: { PostToolUse: { matcher: string; hooks: { command: string }[] }[] };
    };
    const entry = settings.hooks.PostToolUse[0]!;
    assert.equal(entry.matcher, "Write|Edit|MultiEdit");
    assert.equal(entry.hooks.length, 2);
    assert.equal(entry.hooks[0]!.command, "/another/hook.sh");
    assert.equal(entry.hooks[1]!.command, HOOK_COMMAND);
  });
});

describe("install-claude-md — strict-mode warning", () => {
  it("warns to stdout when leak-context flag is absent", () => {
    const claudeHome = makeClaudeHome("warn");
    const aegisHome = aegisHomeFor("warn");
    const result = withEnv("REPO_AEGIS_HOME", aegisHome, () =>
      captureOutput(() => installClaudeMd({ claudeHome })),
    );
    assert.ok(result.stdout.includes("strict mode is OFF"));
    assert.ok(result.stdout.includes("repo-aegis context on"));
  });

  it("does not warn when leak-context flag is present", () => {
    const claudeHome = makeClaudeHome("no-warn");
    const aegisHome = aegisHomeFor("no-warn");
    writeFileSync(join(aegisHome, "state", "leak-context-mode"), "");
    const result = withEnv("REPO_AEGIS_HOME", aegisHome, () =>
      captureOutput(() => installClaudeMd({ claudeHome })),
    );
    assert.ok(!result.stdout.includes("strict mode is OFF"));
  });
});

describe("install-claude-md — --dry-run", () => {
  it("does not create CLAUDE.md, settings.json, or any hook script", () => {
    const claudeHome = makeClaudeHome("dryrun-fresh");
    const aegisHome = aegisHomeFor("dryrun-fresh");

    const result = withEnv("REPO_AEGIS_HOME", aegisHome, () =>
      captureOutput(() => installClaudeMd({ claudeHome, dryRun: true })),
    );
    assert.equal(result.exitCode, undefined);

    assert.ok(!existsSync(join(claudeHome, "CLAUDE.md")));
    assert.ok(!existsSync(join(claudeHome, "settings.json")));
    assert.ok(!existsSync(join(claudeHome, "hooks")));
  });

  it("prints the would-be CLAUDE.md additions and merged settings.json to stdout", () => {
    const claudeHome = makeClaudeHome("dryrun-stdout");
    const aegisHome = aegisHomeFor("dryrun-stdout");

    const result = withEnv("REPO_AEGIS_HOME", aegisHome, () =>
      captureOutput(() => installClaudeMd({ claudeHome, dryRun: true })),
    );
    assert.ok(result.stdout.includes("dry run"));
    assert.ok(result.stdout.includes("repo-aegis: managed block"));
    assert.ok(result.stdout.includes("repo-aegis (data-leak prevention)"));
    // settings.json preview must show the registered hook command.
    assert.ok(result.stdout.includes(HOOK_COMMAND));
    assert.ok(result.stdout.includes("PostToolUse"));
    assert.ok(result.stdout.includes("Write|Edit|MultiEdit"));
  });

  it("preserves existing settings keys in the preview", () => {
    const claudeHome = makeClaudeHome("dryrun-merge");
    const aegisHome = aegisHomeFor("dryrun-merge");

    const settingsPath = join(claudeHome, "settings.json");
    writeFileSync(
      settingsPath,
      JSON.stringify(
        {
          theme: "dark",
          hooks: {
            PostToolUse: [
              {
                matcher: "Bash",
                hooks: [{ type: "command", command: "/some/other/script.sh" }],
              },
            ],
          },
        },
        null,
        2,
      ),
    );
    const before = readFileSync(settingsPath, "utf8");

    const result = withEnv("REPO_AEGIS_HOME", aegisHome, () =>
      captureOutput(() => installClaudeMd({ claudeHome, dryRun: true })),
    );

    // Disk file untouched.
    assert.equal(readFileSync(settingsPath, "utf8"), before);

    // Preview shows both old + new entries.
    assert.ok(result.stdout.includes("dark"));
    assert.ok(result.stdout.includes("Bash"));
    assert.ok(result.stdout.includes("/some/other/script.sh"));
    assert.ok(result.stdout.includes("Write|Edit|MultiEdit"));
  });

  it("emits the expected dry-run JSON shape", () => {
    const claudeHome = makeClaudeHome("dryrun-json");
    const aegisHome = aegisHomeFor("dryrun-json");

    const result = withEnv("REPO_AEGIS_HOME", aegisHome, () =>
      captureOutput(() =>
        installClaudeMd({ claudeHome, dryRun: true, json: true }),
      ),
    );
    const j = JSON.parse(result.stdout) as {
      action: string;
      dryRun: boolean;
      claudeHome: string;
      claudeMd: { path: string; wouldAppend: boolean; alreadyPresent: boolean; addition: string };
      hookCommand: string;
      settings: { path: string; wouldAdd: boolean; alreadyPresent: boolean; contents: string };
      strictModeOn: boolean;
    };
    assert.equal(j.action, "install-claude-md");
    assert.equal(j.dryRun, true);
    assert.equal(j.claudeHome, claudeHome);
    assert.equal(j.claudeMd.wouldAppend, true);
    assert.equal(j.claudeMd.alreadyPresent, false);
    assert.ok(j.claudeMd.addition.includes("repo-aegis: managed block"));
    assert.equal(j.hookCommand, HOOK_COMMAND);
    assert.equal(j.settings.wouldAdd, true);
    assert.equal(j.settings.alreadyPresent, false);
    assert.ok(j.settings.contents.includes("Write|Edit|MultiEdit"));
    assert.ok(j.settings.contents.includes(HOOK_COMMAND));

    // No filesystem side effects.
    assert.ok(!existsSync(join(claudeHome, "CLAUDE.md")));
    assert.ok(!existsSync(join(claudeHome, "settings.json")));
    assert.ok(!existsSync(join(claudeHome, "hooks")));
  });

  it("respects silent: no stdout/stderr output", () => {
    const claudeHome = makeClaudeHome("dryrun-silent");
    const aegisHome = aegisHomeFor("dryrun-silent");

    const result = withEnv("REPO_AEGIS_HOME", aegisHome, () =>
      captureOutput(() =>
        installClaudeMd({ claudeHome, dryRun: true, silent: true }),
      ),
    );
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
    assert.ok(!existsSync(join(claudeHome, "CLAUDE.md")));
  });
});

describe("install-claude-md — JSON output", () => {
  it("emits the expected shape", () => {
    const claudeHome = makeClaudeHome("json");
    const aegisHome = aegisHomeFor("json");
    const result = withEnv("REPO_AEGIS_HOME", aegisHome, () =>
      captureOutput(() => installClaudeMd({ claudeHome, json: true })),
    );
    const j = JSON.parse(result.stdout) as {
      action: string;
      claudeHome: string;
      claudeMd: { appended: boolean; alreadyPresent: boolean };
      hookCommand: string;
      settings: { added: boolean; alreadyPresent: boolean };
      strictModeOn: boolean;
    };
    assert.equal(j.action, "install-claude-md");
    assert.equal(j.claudeHome, claudeHome);
    assert.equal(j.claudeMd.appended, true);
    assert.equal(j.claudeMd.alreadyPresent, false);
    assert.equal(j.hookCommand, HOOK_COMMAND);
    assert.equal(j.settings.added, true);
    assert.equal(j.settings.alreadyPresent, false);
    assert.equal(j.strictModeOn, false);
  });
});
