// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseApiEndpoint, parseEgressIntents, type EgressIntent } from "./egress-intent.js";

function only(command: string): EgressIntent {
  const intents = parseEgressIntents(command);
  assert.equal(intents.length, 1, `expected exactly one intent for ${JSON.stringify(command)}, got ${JSON.stringify(intents)}`);
  return intents[0]!;
}

describe("parseEgressIntents — non-egress commands yield nothing", () => {
  const cases = [
    "",
    "ls -la",
    "git status",
    "git log --oneline -5",
    "git fetch origin --prune",
    "git pull origin main",
    "git remote -v",
    "gh pr view 12 --json body",
    "gh pr list --state open",
    "gh pr checks 12",
    "gh api repos/acme/svc/pulls/12",
    "gh api -X GET repos/acme/svc",
    "gh api --method GET repos/acme/svc -f state=open",
    "gh repo view acme/svc",
    "gh repo clone acme/svc",
    "gh auth status",
    "gh --version",
    "npm test",
    "npm install",
    "npm run publish-docs",
    "echo 'git push origin main'",
    'printf "%s" "gh pr create --body-file x"',
    "# git push origin main",
    "cat <<'EOF'\ngit push origin main\nEOF",
    "cat <<EOF > notes.md\ngh pr create --body-file /tmp/x\nEOF",
    "git pushd",
    "gitx push origin main",
  ];
  for (const c of cases) {
    it(`${JSON.stringify(c)} → []`, () => {
      assert.deepEqual(parseEgressIntents(c), []);
    });
  }
});

describe("parseEgressIntents — git push", () => {
  it("bare push has neither remote nor refspec", () => {
    const i = only("git push");
    assert.equal(i.verb, "git-push");
    assert.equal(i.remote, undefined);
    assert.equal(i.refspec, undefined);
    assert.equal(i.precededByCd, false);
    assert.equal(i.joinedBy, null);
  });

  it("remote only", () => {
    const i = only("git push origin");
    assert.equal(i.remote, "origin");
    assert.equal(i.refspec, undefined);
  });

  it("remote and refspec", () => {
    const i = only("git push origin main");
    assert.equal(i.remote, "origin");
    assert.equal(i.refspec, "main");
  });

  it("-u before positionals", () => {
    const i = only("git push -u origin feat/x");
    assert.equal(i.remote, "origin");
    assert.equal(i.refspec, "feat/x");
  });

  it("--force-with-lease and --tags are boolean", () => {
    const i = only("git push --force-with-lease --tags origin v1.2.3");
    assert.equal(i.remote, "origin");
    assert.equal(i.refspec, "v1.2.3");
  });

  it("value-taking push options are skipped", () => {
    const i = only("git push -o ci.skip --push-option=foo origin main");
    assert.equal(i.remote, "origin");
    assert.equal(i.refspec, "main");
  });

  it("delete refspec is explicit", () => {
    const i = only("git push origin :old-branch");
    assert.equal(i.refspec, ":old-branch");
  });

  it("-- ends options", () => {
    const i = only("git push -- origin main");
    assert.equal(i.remote, "origin");
    assert.equal(i.refspec, "main");
  });

  it("git -C <dir> sets cwdOverride and is not a cd", () => {
    const i = only("git -C /home/u/repos/svc push origin main");
    assert.equal(i.cwdOverride, "/home/u/repos/svc");
    assert.equal(i.precededByCd, false);
  });

  it("git global options with values are skipped before the subcommand", () => {
    const i = only("git --no-pager -c push.default=nothing --git-dir=/x/.git push origin main");
    assert.equal(i.verb, "git-push");
    assert.equal(i.remote, "origin");
  });

  it("absolute path to git resolves", () => {
    const i = only("/usr/bin/git push origin main");
    assert.equal(i.verb, "git-push");
  });

  it("env assignment and wrappers are skipped", () => {
    assert.equal(only("GIT_SSH_COMMAND='ssh -i k' git push origin main").verb, "git-push");
    assert.equal(only("env FOO=1 git push origin main").verb, "git-push");
    assert.equal(only("sudo -u deploy git push origin main").verb, "git-push");
    assert.equal(only("command git push origin main").verb, "git-push");
  });

  it("URL as remote is preserved verbatim", () => {
    const i = only("git push git@github.com:acme/svc.git main");
    assert.equal(i.remote, "git@github.com:acme/svc.git");
  });

  it("command substitution inside the refspec stays one word", () => {
    const i = only("git push origin $(git branch --show-current)");
    assert.equal(i.refspec, "$(git branch --show-current)");
  });
});

describe("parseEgressIntents — shape facts (cd, joins)", () => {
  it("the 2026-09-08 incident shape: cd … && … ; … && … ; git push", () => {
    const cmd =
      "cd /home/u/repos/svc && python3 scripts/regen.py ; git add -A && git commit -m 'regen' ; git push";
    const intents = parseEgressIntents(cmd);
    assert.equal(intents.length, 1);
    const i = intents[0]!;
    assert.equal(i.verb, "git-push");
    assert.equal(i.precededByCd, true);
    assert.equal(i.joinedBy, ";");
    assert.equal(i.remote, undefined);
  });

  it("cd && git push origin main → precededByCd, joinedBy &&", () => {
    const i = only("cd /x && git push origin main");
    assert.equal(i.precededByCd, true);
    assert.equal(i.joinedBy, "&&");
  });

  it("pushd counts as cd", () => {
    assert.equal(only("pushd /x && git push origin main").precededByCd, true);
  });

  it("a cd AFTER the push does not taint it", () => {
    const i = only("git push origin main && cd /x");
    assert.equal(i.precededByCd, false);
  });

  it("newline-separated commands are joined by \\n", () => {
    const i = only("git add -A\ngit push origin main");
    assert.equal(i.joinedBy, "\n");
  });

  it("|| and & are recorded", () => {
    assert.equal(only("make || git push origin main").joinedBy, "||");
    assert.equal(only("sleep 1 & git push origin main").joinedBy, "&");
  });

  it("pipe into the push is recorded as |", () => {
    assert.equal(only("echo y | git push origin main").joinedBy, "|");
  });

  it("subshell parentheses are word boundaries", () => {
    const i = only("(cd /x && git push origin main)");
    assert.equal(i.verb, "git-push");
    assert.equal(i.precededByCd, true);
  });

  it("redirections do not become positionals", () => {
    const i = only("git push origin main 2>&1 > /dev/null");
    assert.equal(i.remote, "origin");
    assert.equal(i.refspec, "main");
    const j = only("git push origin main >/tmp/log 2>&1");
    assert.equal(j.refspec, "main");
  });

  it("two egress segments yield two intents in order", () => {
    const intents = parseEgressIntents("git push origin main && gh pr create --title t --body b");
    assert.deepEqual(
      intents.map(i => [i.verb, i.joinedBy, i.segmentIndex]),
      [
        ["git-push", null, 0],
        ["gh-pr-create", "&&", 1],
      ],
    );
  });
});

describe("parseEgressIntents — gh verbs and payloads", () => {
  it("the 2026-09-07 incident shape: --body-file under $TMPDIR with --repo", () => {
    const i = only('gh pr create --title "x" --body-file "$TMPDIR/pr-body.md" --repo acme/svc');
    assert.equal(i.verb, "gh-pr-create");
    assert.deepEqual(i.payloadFiles, ["$TMPDIR/pr-body.md"]);
    assert.equal(i.repoFlag, "acme/svc");
  });

  it("-R and --repo=", () => {
    assert.equal(only("gh pr merge 12 -R acme/svc").repoFlag, "acme/svc");
    assert.equal(only("gh pr merge 12 --repo=acme/svc").repoFlag, "acme/svc");
  });

  it("-F is --body-file on pr/issue/release", () => {
    assert.deepEqual(only("gh pr edit 12 -F /abs/body.md").payloadFiles, ["/abs/body.md"]);
    assert.deepEqual(only("gh issue comment 3 -F /abs/c.md").payloadFiles, ["/abs/c.md"]);
    assert.deepEqual(only("gh release create v1 --notes-file /abs/n.md").payloadFiles, ["/abs/n.md"]);
  });

  it("--body-file - (stdin) is kept verbatim", () => {
    assert.deepEqual(only("gh pr create --title t --body-file -").payloadFiles, ["-"]);
  });

  it("--body @path is a payload file; plain --body is not", () => {
    assert.deepEqual(only("gh pr create -t t --body @/abs/b.md").payloadFiles, ["/abs/b.md"]);
    assert.deepEqual(only("gh pr create -t t --body 'hello world'").payloadFiles, []);
  });

  it("verb mapping", () => {
    const m: Array<[string, string]> = [
      ["gh pr create -t t -b b", "gh-pr-create"],
      ["gh pr edit 1 -t t", "gh-pr-edit"],
      ["gh pr close 1", "gh-pr-edit"],
      ["gh pr merge 1 --squash", "gh-pr-merge"],
      ["gh pr comment 1 -b hi", "gh-pr-comment"],
      ["gh pr review 1 --approve", "gh-pr-review"],
      ["gh issue create -t t -b b", "gh-issue-create"],
      ["gh issue close 1", "gh-issue-edit"],
      ["gh issue comment 1 -b hi", "gh-issue-comment"],
      ["gh release create v1", "gh-release-create"],
      ["gh release delete v1 -y", "gh-release-edit"],
      ["gh release upload v1 dist/a.tgz", "gh-release-upload"],
      ["gh repo create acme/new --private", "gh-repo-create"],
      ["gh repo fork acme/svc", "gh-repo-create"],
      ["gh repo edit --visibility public", "gh-repo-edit"],
      ["gh repo delete acme/svc --yes", "gh-repo-edit"],
      ["gh gist create f.txt", "gh-gist-create"],
      ["gh workflow run ci.yml", "gh-workflow-run"],
      ["gh run rerun 123", "gh-workflow-run"],
      ["gh secret set TOKEN", "gh-repo-edit"],
      ["npm publish", "npm-publish"],
      ["npm publish --access public", "npm-publish"],
      ["pnpm publish", "npm-publish"],
      ["yarn publish", "npm-publish"],
      ["yarn npm publish", "npm-publish"],
    ];
    for (const [cmd, verb] of m) {
      assert.equal(only(cmd).verb, verb, cmd);
    }
  });

  it("gh release upload assets are not payload files (they are the release, not a body)", () => {
    assert.deepEqual(only("gh release upload v1 dist/a.tgz dist/b.tgz").payloadFiles, []);
  });

  describe("gh api", () => {
    it("-X POST|PATCH|PUT|DELETE is mutating", () => {
      for (const m of ["POST", "PATCH", "PUT", "DELETE", "post"]) {
        assert.equal(only(`gh api -X ${m} repos/acme/svc/issues`).verb, "gh-api-mutating", m);
      }
      assert.equal(only("gh api --method DELETE repos/acme/svc/labels/x").verb, "gh-api-mutating");
    });

    it("fields without a method imply POST", () => {
      assert.equal(only("gh api repos/acme/svc/issues -f title=x").verb, "gh-api-mutating");
      assert.equal(only("gh api graphql -f query='mutation { … }'").verb, "gh-api-mutating");
      assert.equal(only("gh api repos/acme/svc/issues --input /abs/body.json").verb, "gh-api-mutating");
    });

    it("-F key=@file is a payload file; --input is a payload file", () => {
      assert.deepEqual(only("gh api repos/acme/svc/issues -F body=@/abs/b.md").payloadFiles, ["/abs/b.md"]);
      assert.deepEqual(only("gh api -X POST repos/acme/svc/issues --input /abs/b.json").payloadFiles, [
        "/abs/b.json",
      ]);
    });

    it("explicit GET with fields is a read", () => {
      assert.deepEqual(parseEgressIntents("gh api -X GET search/issues -f q=foo"), []);
    });

    it("the endpoint positional is captured verbatim, past value-taking flags", () => {
      // The 2026-09-12 command: a merge into a public repo, judged from a private cwd.
      assert.equal(
        only("gh api -X PUT repos/acme/svc/pulls/103/merge -f merge_method=squash").apiEndpoint,
        "repos/acme/svc/pulls/103/merge",
      );
      assert.equal(
        only("gh api -H 'Accept: application/vnd.github+json' -X POST repos/acme/svc/issues").apiEndpoint,
        "repos/acme/svc/issues",
      );
      assert.equal(only("gh api --hostname ghe.example.com -X DELETE repos/acme/svc/labels/x").apiEndpoint, "repos/acme/svc/labels/x");
      assert.equal(only("gh api graphql -f query='mutation { … }'").apiEndpoint, "graphql");
      assert.equal(only("gh api --method=POST --jq .id repos/acme/svc/issues -f title=x").apiEndpoint, "repos/acme/svc/issues");
    });

    it("a header value is never mistaken for the endpoint", () => {
      assert.equal(only("gh api -X POST -H X-GitHub-Api-Version:2022-11-28 orgs/acme/repos -f name=x").apiEndpoint, "orgs/acme/repos");
    });
  });
});

describe("parseApiEndpoint", () => {
  it("repos/<o>/<r>/… → org and repo, lower-cased, .git stripped", () => {
    assert.deepEqual(parseApiEndpoint("repos/Acme/Svc/pulls/103/merge"), { org: "acme", repo: "svc" });
    assert.deepEqual(parseApiEndpoint("repos/acme/svc"), { org: "acme", repo: "svc" });
    assert.deepEqual(parseApiEndpoint("/repos/acme/svc.git/issues"), { org: "acme", repo: "svc" });
    assert.deepEqual(parseApiEndpoint("repos/acme/svc/issues?state=open"), { org: "acme", repo: "svc" });
  });

  it("orgs/<o>/… → the org, no repo", () => {
    assert.deepEqual(parseApiEndpoint("orgs/acme/repos"), { org: "acme", repo: null });
    assert.deepEqual(parseApiEndpoint("orgs/acme"), { org: "acme", repo: null });
  });

  it("full URLs are reduced to their path; a GHE /api/v3 prefix is dropped", () => {
    assert.deepEqual(parseApiEndpoint("https://api.github.com/repos/acme/svc/pulls"), { org: "acme", repo: "svc" });
    assert.deepEqual(parseApiEndpoint("https://ghe.example.com/api/v3/repos/acme/svc"), { org: "acme", repo: "svc" });
  });

  it("placeholders mean gh resolves from the cwd → null", () => {
    assert.equal(parseApiEndpoint("repos/{owner}/{repo}/pulls"), null);
  });

  it("everything else → null", () => {
    for (const e of ["graphql", "user/repos", "gists", "search/issues", "repos/acme", "repos", "", "://bad"]) {
      assert.equal(parseApiEndpoint(e), null, e);
    }
  });
});

describe("parseEgressIntents — never throws", () => {
  const nasty = [
    "git push origin 'unterminated",
    'gh pr create --body-file "unterminated',
    "git push origin $(unterminated",
    "git push origin ${unterminated",
    "git push origin `unterminated",
    "&& git push origin main",
    "git push origin main &&",
    ";;;",
    "<<",
    "cat <<EOF\nno terminator",
    "\\",
    "git push \\\n origin \\\n main",
  ];
  for (const c of nasty) {
    it(`survives ${JSON.stringify(c)}`, () => {
      assert.doesNotThrow(() => parseEgressIntents(c));
    });
  }

  it("line continuation joins the push into one segment", () => {
    const i = only("git push \\\n origin \\\n main");
    assert.equal(i.remote, "origin");
    assert.equal(i.refspec, "main");
  });
});
