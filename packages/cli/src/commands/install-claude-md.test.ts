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

  it("registers PostToolUse hooks in settings.json by bin name", () => {
    const settingsPath = join(claudeHome, "settings.json");
    const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as {
      hooks: { PostToolUse: { matcher: string; hooks: { type: string; command: string }[] }[] };
    };
    const post = settings.hooks.PostToolUse;
    assert.equal(post.length, 2, "expect both file-write and Bash matcher entries");

    const fileEntry = post.find(e => e.matcher === "Write|Edit|MultiEdit");
    assert.ok(fileEntry, "missing file-write matcher entry");
    assert.equal(fileEntry!.hooks.length, 1);
    assert.equal(fileEntry!.hooks[0]!.type, "command");
    assert.equal(fileEntry!.hooks[0]!.command, "repo-aegis hook scan-after-write");

    const bashEntry = post.find(e => e.matcher === "Bash");
    assert.ok(bashEntry, "missing Bash matcher entry");
    assert.equal(bashEntry!.hooks.length, 1);
    assert.equal(bashEntry!.hooks[0]!.type, "command");
    assert.equal(bashEntry!.hooks[0]!.command, "repo-aegis hook scan-bash-output");
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
    assert.equal(post.length, 2, "two matcher entries (Write|Edit|MultiEdit and Bash)");
    for (const entry of post) {
      assert.equal(entry.hooks.length, 1, `hook command should appear exactly once in ${entry.matcher}`);
    }
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

// ---------------------------------------------------------------------------
// Phase 1: --first-touch SessionStart hook
// ---------------------------------------------------------------------------

interface SettingsShape {
  hooks?: {
    PostToolUse?: Array<{
      matcher?: string;
      hooks?: Array<{ type?: string; command?: string }>;
    }>;
    SessionStart?: Array<{
      matcher?: string;
      hooks?: Array<{ type?: string; command?: string }>;
    }>;
  };
}

describe("install-claude-md — --first-touch", () => {
  it("does NOT add SessionStart hook by default (firstTouch off)", () => {
    const claudeHome = makeClaudeHome("first-touch-default");
    const aegisHome = aegisHomeFor("first-touch-default");
    withEnv("REPO_AEGIS_HOME", aegisHome, () =>
      captureOutput(() => installClaudeMd({ claudeHome })),
    );
    const settings = JSON.parse(
      readFileSync(join(claudeHome, "settings.json"), "utf8"),
    ) as SettingsShape;
    assert.equal(settings.hooks?.SessionStart, undefined);
  });

  it("with firstTouch:true, registers SessionStart hook", () => {
    const claudeHome = makeClaudeHome("first-touch-on");
    const aegisHome = aegisHomeFor("first-touch-on");
    withEnv("REPO_AEGIS_HOME", aegisHome, () =>
      captureOutput(() => installClaudeMd({ claudeHome, firstTouch: true })),
    );
    const settings = JSON.parse(
      readFileSync(join(claudeHome, "settings.json"), "utf8"),
    ) as SettingsShape;
    const sessionEntries = settings.hooks?.SessionStart ?? [];
    assert.equal(sessionEntries.length, 1);
    assert.equal(sessionEntries[0]!.matcher, "*");
    assert.equal(
      sessionEntries[0]!.hooks?.[0]?.command,
      "repo-aegis hook first-touch",
    );
  });

  it("idempotent — running twice with --first-touch does not duplicate", () => {
    const claudeHome = makeClaudeHome("first-touch-idempotent");
    const aegisHome = aegisHomeFor("first-touch-idempotent");
    withEnv("REPO_AEGIS_HOME", aegisHome, () =>
      captureOutput(() => installClaudeMd({ claudeHome, firstTouch: true })),
    );
    withEnv("REPO_AEGIS_HOME", aegisHome, () =>
      captureOutput(() => installClaudeMd({ claudeHome, firstTouch: true })),
    );
    const settings = JSON.parse(
      readFileSync(join(claudeHome, "settings.json"), "utf8"),
    ) as SettingsShape;
    const sessionEntries = settings.hooks?.SessionStart ?? [];
    assert.equal(sessionEntries.length, 1);
    assert.equal(sessionEntries[0]!.hooks?.length, 1);
  });

  it("preserves the PostToolUse hooks when firstTouch:true is used", () => {
    const claudeHome = makeClaudeHome("first-touch-preserves");
    const aegisHome = aegisHomeFor("first-touch-preserves");
    withEnv("REPO_AEGIS_HOME", aegisHome, () =>
      captureOutput(() => installClaudeMd({ claudeHome, firstTouch: true })),
    );
    const settings = JSON.parse(
      readFileSync(join(claudeHome, "settings.json"), "utf8"),
    ) as SettingsShape;
    const postEntries = settings.hooks?.PostToolUse ?? [];
    assert.equal(postEntries.length, 2, "file-write + Bash matchers");
    const fileEntry = postEntries.find(e => e.matcher === "Write|Edit|MultiEdit");
    assert.ok(fileEntry);
    assert.equal(
      fileEntry!.hooks?.[0]?.command,
      "repo-aegis hook scan-after-write",
    );
    const bashEntry = postEntries.find(e => e.matcher === "Bash");
    assert.ok(bashEntry);
    assert.equal(
      bashEntry!.hooks?.[0]?.command,
      "repo-aegis hook scan-bash-output",
    );
  });

  it("JSON output includes firstTouch field", () => {
    const claudeHome = makeClaudeHome("first-touch-json");
    const aegisHome = aegisHomeFor("first-touch-json");
    const result = withEnv("REPO_AEGIS_HOME", aegisHome, () =>
      captureOutput(() =>
        installClaudeMd({ claudeHome, firstTouch: true, json: true }),
      ),
    );
    const j = JSON.parse(result.stdout) as {
      firstTouch?: { hookCommand: string; added: boolean };
    };
    assert.ok(j.firstTouch);
    assert.equal(j.firstTouch!.hookCommand, "repo-aegis hook first-touch");
    assert.equal(j.firstTouch!.added, true);
  });
});

describe("install-claude-md — uninstall", () => {
  it("strips the managed block from CLAUDE.md and removes hook entries", () => {
    const claudeHome = makeClaudeHome("uninstall-basic");
    const aegisHome = aegisHomeFor("uninstall-basic");
    withEnv("REPO_AEGIS_HOME", aegisHome, () => {
      captureOutput(() => installClaudeMd({ claudeHome, firstTouch: true }));
      captureOutput(() => installClaudeMd({ claudeHome, uninstall: true }));
    });

    const md = readFileSync(join(claudeHome, "CLAUDE.md"), "utf8");
    assert.ok(!md.includes("repo-aegis: managed block"));
    assert.ok(!md.includes("repo-aegis (data-leak prevention)"));

    const settings = JSON.parse(
      readFileSync(join(claudeHome, "settings.json"), "utf8"),
    ) as { hooks?: Record<string, unknown> };
    // Both hook keys should be gone (or at least the repo-aegis entries
    // are gone — the keys themselves should be cleaned up too).
    assert.ok(!settings.hooks || !("PostToolUse" in settings.hooks));
    assert.ok(!settings.hooks || !("SessionStart" in settings.hooks));
  });

  it("preserves user-authored CLAUDE.md content around the managed block", () => {
    const claudeHome = makeClaudeHome("uninstall-preserve");
    const aegisHome = aegisHomeFor("uninstall-preserve");
    const claudeMd = join(claudeHome, "CLAUDE.md");
    const userBefore = "# My personal CLAUDE.md\n\nSome user notes here.\n";
    const userAfter = "\n## My other section\n\nMore notes.\n";
    writeFileSync(claudeMd, userBefore);
    withEnv("REPO_AEGIS_HOME", aegisHome, () => {
      captureOutput(() => installClaudeMd({ claudeHome }));
    });
    // Append more user content AFTER the managed block landed.
    writeFileSync(claudeMd, readFileSync(claudeMd, "utf8") + userAfter);
    withEnv("REPO_AEGIS_HOME", aegisHome, () => {
      captureOutput(() => installClaudeMd({ claudeHome, uninstall: true }));
    });
    const final = readFileSync(claudeMd, "utf8");
    assert.ok(final.includes("# My personal CLAUDE.md"));
    assert.ok(final.includes("Some user notes here."));
    assert.ok(final.includes("## My other section"));
    assert.ok(!final.includes("repo-aegis: managed block"));
    assert.ok(!final.includes("repo-aegis (data-leak prevention)"));
  });

  it("preserves unrelated keys in settings.json", () => {
    const claudeHome = makeClaudeHome("uninstall-settings-other");
    const aegisHome = aegisHomeFor("uninstall-settings-other");
    const settingsPath = join(claudeHome, "settings.json");
    writeFileSync(
      settingsPath,
      JSON.stringify({
        env: { MY_VAR: "value" },
        permissions: { allow: ["Bash(ls)"] },
      }),
    );
    withEnv("REPO_AEGIS_HOME", aegisHome, () => {
      captureOutput(() => installClaudeMd({ claudeHome }));
      captureOutput(() => installClaudeMd({ claudeHome, uninstall: true }));
    });
    const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as {
      env?: { MY_VAR: string };
      permissions?: { allow: string[] };
      hooks?: unknown;
    };
    assert.equal(settings.env?.MY_VAR, "value");
    assert.deepEqual(settings.permissions?.allow, ["Bash(ls)"]);
    assert.ok(!settings.hooks || Object.keys(settings.hooks as object).length === 0);
  });

  it("preserves third-party PostToolUse hooks", () => {
    const claudeHome = makeClaudeHome("uninstall-coexist");
    const aegisHome = aegisHomeFor("uninstall-coexist");
    const settingsPath = join(claudeHome, "settings.json");
    // Pre-existing third-party hook in the same matcher entry.
    writeFileSync(
      settingsPath,
      JSON.stringify({
        hooks: {
          PostToolUse: [
            {
              matcher: "Write|Edit|MultiEdit",
              hooks: [{ type: "command", command: "/path/to/other-tool/audit.sh" }],
            },
          ],
        },
      }),
    );
    withEnv("REPO_AEGIS_HOME", aegisHome, () => {
      captureOutput(() => installClaudeMd({ claudeHome }));
      captureOutput(() => installClaudeMd({ claudeHome, uninstall: true }));
    });
    const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as {
      hooks?: {
        PostToolUse?: { matcher: string; hooks: { command: string }[] }[];
      };
    };
    const post = settings.hooks!.PostToolUse!;
    assert.equal(post.length, 1);
    const cmds = post[0]!.hooks.map(h => h.command);
    assert.deepEqual(cmds, ["/path/to/other-tool/audit.sh"]);
  });

  it("is idempotent — second uninstall is a no-op", () => {
    const claudeHome = makeClaudeHome("uninstall-idempotent");
    const aegisHome = aegisHomeFor("uninstall-idempotent");
    withEnv("REPO_AEGIS_HOME", aegisHome, () => {
      captureOutput(() => installClaudeMd({ claudeHome }));
      captureOutput(() => installClaudeMd({ claudeHome, uninstall: true }));
      const second = captureOutput(() =>
        installClaudeMd({ claudeHome, uninstall: true, json: true }),
      );
      const j = JSON.parse(second.stdout) as {
        action: string;
        claudeMd: { stripped: boolean; absent: boolean };
        settings: { hookEntriesRemoved: number };
      };
      assert.equal(j.action, "uninstall-claude-md");
      assert.equal(j.claudeMd.stripped, false);
      assert.equal(j.settings.hookEntriesRemoved, 0);
    });
  });

  it("succeeds when neither file exists yet (cold uninstall is a no-op)", () => {
    const claudeHome = makeClaudeHome("uninstall-cold");
    const aegisHome = aegisHomeFor("uninstall-cold");
    withEnv("REPO_AEGIS_HOME", aegisHome, () => {
      const out = captureOutput(() =>
        installClaudeMd({ claudeHome, uninstall: true, json: true }),
      );
      const j = JSON.parse(out.stdout) as {
        claudeMd: { absent: boolean };
        settings: { absent: boolean };
      };
      assert.equal(j.claudeMd.absent, true);
      assert.equal(j.settings.absent, true);
    });
  });

  it("recognises a legacy absolute-path hook command", () => {
    const claudeHome = makeClaudeHome("uninstall-legacy");
    const aegisHome = aegisHomeFor("uninstall-legacy");
    const settingsPath = join(claudeHome, "settings.json");
    writeFileSync(
      settingsPath,
      JSON.stringify({
        hooks: {
          PostToolUse: [
            {
              matcher: "Write|Edit|MultiEdit",
              hooks: [
                {
                  type: "command",
                  command: "/Users/x/.claude/hooks/repo-aegis-scan-after-write.sh",
                },
              ],
            },
          ],
        },
      }),
    );
    withEnv("REPO_AEGIS_HOME", aegisHome, () => {
      captureOutput(() => installClaudeMd({ claudeHome, uninstall: true }));
    });
    const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as {
      hooks?: { PostToolUse?: unknown };
    };
    assert.ok(!settings.hooks || !("PostToolUse" in settings.hooks));
  });
});
