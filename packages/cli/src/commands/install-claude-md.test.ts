import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
  statSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureOutput, withEnv } from "../_test-utils.js";
import { installClaudeMd } from "./install-claude-md.js";

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

  it("writes the scan-after-write hook script", () => {
    const path = join(claudeHome, "hooks", "scan-after-write.sh");
    assert.ok(existsSync(path));
    const body = readFileSync(path, "utf8");
    assert.ok(body.includes("repo-aegis check --path"));
  });

  it("hook script is executable", () => {
    const path = join(claudeHome, "hooks", "scan-after-write.sh");
    const st = statSync(path);
    assert.equal(st.mode & 0o111, 0o111);
  });

  it("registers PostToolUse hook in settings.json", () => {
    const settingsPath = join(claudeHome, "settings.json");
    const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as {
      hooks: { PostToolUse: { matcher: string; hooks: { type: string; command: string }[] }[] };
    };
    const post = settings.hooks.PostToolUse;
    assert.equal(post.length, 1);
    assert.equal(post[0]!.matcher, "Write|Edit|MultiEdit");
    assert.equal(post[0]!.hooks.length, 1);
    assert.equal(post[0]!.hooks[0]!.type, "command");
    assert.equal(post[0]!.hooks[0]!.command, join(claudeHome, "hooks", "scan-after-write.sh"));
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
    assert.equal(aegisEntry!.hooks[0]!.command, join(claudeHome, "hooks", "scan-after-write.sh"));
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
    assert.equal(entry.hooks[1]!.command, join(claudeHome, "hooks", "scan-after-write.sh"));
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
      hookScript: { written: boolean };
      settings: { added: boolean; alreadyPresent: boolean };
      strictModeOn: boolean;
    };
    assert.equal(j.action, "install-claude-md");
    assert.equal(j.claudeHome, claudeHome);
    assert.equal(j.claudeMd.appended, true);
    assert.equal(j.claudeMd.alreadyPresent, false);
    assert.equal(j.hookScript.written, true);
    assert.equal(j.settings.added, true);
    assert.equal(j.settings.alreadyPresent, false);
    assert.equal(j.strictModeOn, false);
  });
});
