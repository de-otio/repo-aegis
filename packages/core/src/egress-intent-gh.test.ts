// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// Issue #151, PR 2a — the parser half of resolver hardening: gh flag syntax
// (§3.3.7, F1), the per-verb repository table (§3.3.8, F9), GH_REPO (§3.3.1),
// positional URLs (§3.3.2) and gh aliases (S11). Every command that names a
// bypass in the plan is pinned here; the ones marked (was: …) produced no
// intent, or the wrong destination, before this change.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  analyseApiEndpoint,
  intentRepoTargets,
  parseApiEndpoint,
  parseEgressIntents,
  parseRepoRef,
  type EgressIntent,
  type ParseEgressOptions,
} from "./egress-intent.js";

function only(command: string, opts?: ParseEgressOptions): EgressIntent {
  const intents = parseEgressIntents(command, opts);
  assert.equal(intents.length, 1, `expected exactly one intent for ${JSON.stringify(command)}, got ${JSON.stringify(intents)}`);
  return intents[0]!;
}

function targets(command: string, opts?: ParseEgressOptions): string[] {
  return intentRepoTargets(only(command, opts)).map(t => `${t.org}/${t.repo ?? "*"}`);
}

/** The facts an attached/detached spelling must not change. */
function shape(i: EgressIntent): Partial<EgressIntent> {
  const { segmentIndex: _s, ...rest } = i;
  return rest;
}

describe("gh flag syntax — pflag attached forms (§3.3.7, F1)", () => {
  it("(was: no repoFlag) -Rvalue, -R=value, --repo=value, -R value, --repo value all name the repo", () => {
    for (const spelling of ["-Rstranger/r", "-R=stranger/r", "--repo=stranger/r", "-R stranger/r", "--repo stranger/r"]) {
      const i = only(`gh issue create ${spelling} --body x`);
      assert.equal(i.verb, "gh-issue-create", spelling);
      assert.equal(i.repoFlag, "stranger/r", spelling);
    }
  });

  it("(was: no intent at all) gh api -XPOST … -fbody=hi", () => {
    const i = only("gh api -XPOST repos/stranger/r/issues -fbody=hi");
    assert.equal(i.verb, "gh-api-mutating");
    assert.equal(i.apiEndpoint, "repos/stranger/r/issues");
  });

  it("(was: no intent) gh api -XDELETE repos/stranger/r, -X=PUT, -XPATCH", () => {
    assert.equal(only("gh api -XDELETE repos/stranger/r").verb, "gh-api-mutating");
    assert.equal(only("gh api -X=PUT repos/stranger/r/topics").verb, "gh-api-mutating");
    assert.equal(only("gh api -XPATCH repos/stranger/r/issues/1 -fstate=closed").verb, "gh-api-mutating");
  });

  it("an attached GET is still a read", () => {
    assert.deepEqual(parseEgressIntents("gh api -XGET repos/stranger/r/issues -fstate=open"), []);
    assert.deepEqual(parseEgressIntents("gh api -X=GET search/issues -fq=foo"), []);
  });

  it("-F/-f/-b attached forms feed payload files and fields exactly as the detached forms do", () => {
    assert.deepEqual(only("gh api repos/o/r/issues -Fbody=@/abs/b.md").payloadFiles, ["/abs/b.md"]);
    assert.deepEqual(only("gh api repos/o/r/issues -F=body=@/abs/b.md").payloadFiles, ["/abs/b.md"]);
    assert.deepEqual(only("gh pr create -F/abs/body.md -tT").payloadFiles, ["/abs/body.md"]);
    assert.deepEqual(only("gh pr create -b@/abs/body.md -tT").payloadFiles, ["/abs/body.md"]);
    assert.equal(only("gh api repos/o/r/issues -fbody=hi").verb, "gh-api-mutating");
  });

  it("an attached -H value is not the endpoint", () => {
    assert.equal(only("gh api -HAccept:application/json -XPOST orgs/acme/repos -fname=x").apiEndpoint, "orgs/acme/repos");
  });

  it("matrix: every value flag, in every spelling, yields an identical intent", () => {
    const cases: Array<{ flag: string; cmd: string }> = [
      { flag: "R", cmd: "gh issue create" },
      { flag: "R", cmd: "gh pr comment 5" },
      { flag: "R", cmd: "gh api repos/o/r/issues -f a=b" },
      { flag: "F", cmd: "gh pr create" },
      { flag: "F", cmd: "gh api repos/o/r/issues" },
      { flag: "f", cmd: "gh api repos/o/r/issues" },
      { flag: "X", cmd: "gh api repos/o/r/issues" },
      { flag: "b", cmd: "gh pr create" },
      { flag: "H", cmd: "gh api -X POST repos/o/r/issues" },
    ];
    const values: Record<string, string[]> = {
      R: ["stranger/r", "acme/svc", "https://github.com/stranger/r"],
      F: ["/abs/b.md", "body=@/abs/b.md", "key=val"],
      f: ["body=hi", "title=x y"],
      X: ["POST", "DELETE", "GET"],
      b: ["hello", "@/abs/b.md"],
      H: ["Accept:application/json"],
    };
    for (const { flag, cmd } of cases) {
      for (const v of values[flag]!) {
        const detached = parseEgressIntents(`${cmd} -${flag} '${v}'`);
        const attached = parseEgressIntents(`${cmd} '-${flag}${v}'`);
        const equals = parseEgressIntents(`${cmd} '-${flag}=${v}'`);
        assert.deepEqual(attached.map(shape), detached.map(shape), `-${flag}${v} after ${cmd}`);
        assert.deepEqual(equals.map(shape), detached.map(shape), `-${flag}=${v} after ${cmd}`);
      }
    }
    // The matrix proves nothing if every cell is empty.
    assert.equal(parseEgressIntents("gh api repos/o/r/issues '-XPOST'").length, 1);
    assert.equal(parseEgressIntents("gh issue create '-Rstranger/r'").length, 1);
  });

  it("mixed attached and detached forms in one command", () => {
    const i = only("gh api -XPOST -f title=x -fbody=y -Hfoo:bar repos/stranger/r/issues --input /abs/b.json");
    assert.equal(i.verb, "gh-api-mutating");
    assert.equal(i.apiEndpoint, "repos/stranger/r/issues");
    assert.deepEqual(i.payloadFiles, ["/abs/b.json"]);
  });

  it("repeated flags: the last --repo wins, as in pflag", () => {
    assert.equal(only("gh issue create --repo acme/x -Rstranger/r").repoFlag, "stranger/r");
    assert.equal(only("gh issue create -R stranger/r --repo=acme/x").repoFlag, "acme/x");
    assert.equal(only("gh issue create -Rstranger/r -R=acme/x --repo acme/y").repoFlag, "acme/y");
  });

  it("repeated -X: the last method wins", () => {
    assert.equal(parseEgressIntents("gh api -XPOST -X GET repos/o/r/issues").length, 0);
    assert.equal(parseEgressIntents("gh api -X GET -XPOST repos/o/r/issues").length, 1);
  });

  it("-- ends flag parsing: what follows is positional, not a repo", () => {
    const i = only("gh issue create --body x -- --repo stranger/r");
    assert.equal(i.repoFlag, undefined);
    assert.equal(only("gh issue create -R stranger/r -- --repo acme/x").repoFlag, "stranger/r");
    // …and a URL after `--` is still a positional selector.
    assert.equal(only("gh pr comment --body x -- https://github.com/stranger/r/pull/5").positionalRepo, "stranger/r");
  });

  it("quoted spellings", () => {
    assert.equal(only('gh issue create "-Rstranger/r" --body x').repoFlag, "stranger/r");
    assert.equal(only("gh issue create '-R=stranger/r' --body x").repoFlag, "stranger/r");
    assert.equal(only('gh issue create --repo "stranger/r" --body x').repoFlag, "stranger/r");
    assert.equal(only('gh issue create "--repo=stranger/r" --body x').repoFlag, "stranger/r");
  });

  it("grouped booleans do not hide a value flag, and a bool-looking letter does not swallow the next token", () => {
    assert.equal(only("gh pr create -dRstranger/r").repoFlag, "stranger/r"); // -d draft, then -R value
    assert.equal(only("gh pr create -f -Rstranger/r").repoFlag, "stranger/r"); // -f is --fill, a boolean
    assert.equal(only("gh pr review -a -R stranger/r 5").repoFlag, "stranger/r"); // -a is --approve here
    assert.equal(only("gh pr merge 5 -sd -R stranger/r").repoFlag, "stranger/r");
    // `-a` takes a value on create/edit, so a URL right after it is the assignee, not a selector…
    assert.equal(only("gh pr create -a someone -R acme/x").positionalRepo, undefined);
    // …but after a boolean `-a` it IS the selector.
    assert.equal(only("gh pr review -a https://github.com/stranger/r/pull/1").positionalRepo, "stranger/r");
  });

  it("existing detached forms are unchanged", () => {
    assert.equal(only("gh pr merge 12 -R acme/svc").repoFlag, "acme/svc");
    assert.equal(only("gh pr merge 12 --repo=acme/svc").repoFlag, "acme/svc");
    assert.deepEqual(only("gh pr edit 12 -F /abs/body.md").payloadFiles, ["/abs/body.md"]);
  });
});

describe("gh command position — where cobra finds the verb", () => {
  it("(was: no intent) a flag with a value between the group and the subcommand", () => {
    const i = only("gh issue --repo stranger/r create --body x");
    assert.equal(i.verb, "gh-issue-create");
    assert.equal(i.repoFlag, "stranger/r");
    assert.equal(only("gh issue -Rstranger/r create --body x").repoFlag, "stranger/r");
    assert.equal(only("gh pr --repo=stranger/r comment 5 -b hi").verb, "gh-pr-comment");
  });

  it("(was: no intent) a flag with a value before the group", () => {
    const i = only("gh --repo stranger/r issue create --body x");
    assert.equal(i.verb, "gh-issue-create");
    assert.equal(i.repoFlag, "stranger/r");
    assert.equal(only("gh -R stranger/r pr merge 5").repoFlag, "stranger/r");
  });

  it("an unknown flag before the subcommand swallows it, as in cobra: gh refuses, so there is no write", () => {
    assert.deepEqual(parseEgressIntents("gh issue --draft create --body x"), []);
  });
});

describe("gh per-verb repository table (§3.3.8, F9)", () => {
  it("(was: no positionalRepo) gh issue transfer <n> <o>/<r>: the destination", () => {
    const i = only("gh issue transfer 5 stranger/r");
    assert.equal(i.verb, "gh-issue-edit");
    assert.equal(i.positionalRepo, "stranger/r");
    // The source is still the cwd; both are targets once --repo names it.
    assert.deepEqual(targets("gh issue transfer 5 stranger/r --repo acme/x"), ["stranger/r", "acme/x"]);
    assert.equal(only("gh issue transfer 5 https://github.com/Stranger/R").positionalRepo, "stranger/r");
  });

  it("(was: no positionalRepo) gh repo sync|edit|delete|archive|unarchive <o>/<r>", () => {
    for (const sub of ["sync", "edit", "delete", "archive", "unarchive"]) {
      assert.equal(only(`gh repo ${sub} stranger/r`).positionalRepo, "stranger/r", sub);
      assert.equal(only(`gh repo ${sub} https://github.com/stranger/r.git`).positionalRepo, "stranger/r", sub);
    }
    assert.equal(only("gh repo edit stranger/r --visibility public").verb, "gh-repo-edit");
  });

  it("gh repo create <o>/<r> names the owner; a bare name is the authenticated account's", () => {
    assert.equal(only("gh repo create stranger/new --private").positionalRepo, "stranger/new");
    const mine = only("gh repo create mine --private");
    assert.equal(mine.positionalRepo, undefined);
    assert.equal(mine.unresolved, undefined);
  });

  it("gh repo fork: the --org is the destination; the forked repository is only read", () => {
    assert.equal(only("gh repo fork acme/x --org stranger").positionalRepo, "stranger");
    assert.equal(only("gh repo fork acme/x --org=stranger --clone").positionalRepo, "stranger");
    assert.equal(only("gh repo fork stranger/lib --clone").positionalRepo, undefined);
  });

  it("gh secret|variable set|delete --org / -o", () => {
    assert.equal(only("gh secret set TOKEN --org stranger").positionalRepo, "stranger");
    assert.equal(only("gh secret set TOKEN -ostranger").positionalRepo, "stranger");
    assert.equal(only("gh variable set NAME --org=stranger --body v").positionalRepo, "stranger");
    assert.equal(only("gh secret delete TOKEN -o stranger").positionalRepo, "stranger");
    assert.equal(only("gh secret set TOKEN").positionalRepo, undefined);
  });

  it("gh label clone copies FROM its argument INTO the base repo: the source is not a target (M6)", () => {
    const i = only("gh label clone stranger/r");
    assert.equal(i.positionalRepo, undefined);
    assert.deepEqual(targets("gh label clone stranger/r"), []); // the cwd's repository, as before
    assert.deepEqual(targets("gh label clone stranger/r --repo acme/x"), ["acme/x"]);
    assert.deepEqual(targets("gh label clone stranger/r -Racme/x"), ["acme/x"]);
    assert.deepEqual(targets("gh label clone stranger/r", { envRepo: "acme/x" }), ["acme/x"]);
  });

  it("gh issue develop --branch-repo", () => {
    assert.equal(only("gh issue develop 5 --branch-repo stranger/r").positionalRepo, "stranger/r");
    assert.equal(only("gh issue develop 5 --branch-repo=stranger/r --repo acme/x").repoFlag, "acme/x");
    assert.deepEqual(targets("gh issue develop 5 --branch-repo=stranger/r --repo acme/x"), ["stranger/r", "acme/x"]);
  });

  it("(was: unattributed) positional URLs of PRs and issues, every verb", () => {
    assert.equal(only("gh pr comment https://github.com/stranger/r/pull/5 --body x").positionalRepo, "stranger/r");
    assert.equal(only("gh issue comment https://github.com/stranger/r/issues/7 -b x").positionalRepo, "stranger/r");
    assert.equal(only("gh pr merge https://github.com/stranger/r/pull/5/files --squash").positionalRepo, "stranger/r");
    assert.equal(only("gh pr close 'HTTPS://GitHub.com/Stranger/R/pull/5'").positionalRepo, "stranger/r");
    assert.equal(only("gh issue edit https://github.com/stranger/r/issues/7 -t x").positionalRepo, "stranger/r");
    assert.equal(only("gh pr review https://github.com/stranger/r/pull/5 --approve").positionalRepo, "stranger/r");
  });

  it("several selectors: every distinct repository is a target", () => {
    const i = only("gh issue close https://github.com/stranger/r/issues/1 https://github.com/acme/x/issues/2 3");
    assert.equal(i.positionalRepo, "stranger/r");
    assert.deepEqual(i.extraRepos, ["acme/x"]);
    assert.deepEqual(targets("gh issue close https://github.com/stranger/r/issues/1 https://github.com/stranger/r/issues/2"), ["stranger/r"]);
  });

  it("--repo, GH_REPO and a URL that disagree are all candidates", () => {
    assert.deepEqual(
      targets("gh pr comment https://github.com/stranger/r/pull/5 --repo acme/x --body y"),
      ["stranger/r", "acme/x"],
    );
  });

  it("a URL inside a flag value is text, not a selector", () => {
    for (const c of [
      "gh pr comment 5 --body 'see https://github.com/stranger/r/pull/5'",
      "gh pr comment 5 -b https://github.com/stranger/r/pull/5",
      "gh pr create --title https://github.com/stranger/r/pull/5 -b x",
      "gh pr create --head https://github.com/stranger/r/pull/5 -b x",
    ]) {
      assert.equal(only(c).positionalRepo, undefined, c);
    }
  });

  it("reads that take a URL stay non-egress", () => {
    for (const c of [
      "gh pr view https://github.com/stranger/r/pull/5",
      "gh issue view https://github.com/stranger/r/issues/7 --json body",
      "gh pr checkout https://github.com/stranger/r/pull/5",
      "gh repo view stranger/r",
      "gh repo clone stranger/r",
      "gh repo set-default stranger/r",
      "gh issue list --repo stranger/r",
    ]) {
      assert.deepEqual(parseEgressIntents(c), [], c);
    }
  });

  it("a number or a branch selector names no repository", () => {
    assert.equal(only("gh pr comment 5 --body x").positionalRepo, undefined);
    assert.equal(only("gh pr comment some-branch --body x").positionalRepo, undefined);
    assert.equal(only("gh pr comment someone:their-branch --body x").positionalRepo, undefined);
  });

  it("(was: no intent) a write subcommand with no shape in the table is unresolved, not ignored", () => {
    const i = only("gh run delete 123 -R acme/x");
    assert.equal(i.verb, "gh-workflow-run");
    assert.equal(i.unresolved, "unknown-shape");
    assert.equal(only("gh pr revert 5").unresolved, "unknown-shape");
    assert.equal(only("gh gist delete abc").verb, "gh-gist-create");
  });

  it("known writes and known reads are not unknown-shape", () => {
    assert.equal(only("gh pr create -t x -b y").unresolved, undefined);
    assert.equal(only("gh release upload v1 a.tgz").unresolved, undefined);
    assert.deepEqual(parseEgressIntents("gh run view 123"), []);
    assert.deepEqual(parseEgressIntents("gh workflow list"), []);
    assert.deepEqual(parseEgressIntents("gh secret list"), []);
    assert.deepEqual(parseEgressIntents("gh search issues foo"), []);
    assert.deepEqual(parseEgressIntents("gh auth status"), []);
    // An Object.prototype key is not a subcommand either; it is just an unknown write.
    assert.equal(only("gh pr constructor").unresolved, "unknown-shape");
  });

  it("an opaque repository slot is unresolved, never silently the cwd", () => {
    for (const c of [
      'gh issue create --repo "$REPO" --body x',
      "gh issue create -R $(cat repo.txt) --body x",
      'gh repo edit "$R" --visibility private',
      "gh pr merge 5 -R svc", // a bare name is not OWNER/REPO: gh refuses, and so do we
      "gh secret set T --org $ORG",
      "gh pr comment https://github.com/ --body x",
    ]) {
      assert.equal(only(c).unresolved, "opaque-repo", c);
    }
  });
});

describe("GH_REPO (§3.3.1, S2)", () => {
  it("(was: skipped as a wrapper) a prefix assignment names the repository", () => {
    assert.equal(only("GH_REPO=stranger/r gh issue create --body x").envRepo, "stranger/r");
    assert.equal(only("env GH_REPO=stranger/r gh issue create --body x").envRepo, "stranger/r");
    assert.equal(only("FOO=1 env -i GH_REPO=stranger/r gh pr comment 5 -b x").envRepo, "stranger/r");
    assert.equal(only("GH_REPO=Stranger/R gh pr comment 5 -b x").envRepo, "stranger/r");
    assert.equal(only('GH_REPO="stranger/r" gh pr comment 5 -b x').envRepo, "stranger/r");
    assert.equal(only("GH_REPO=https://github.com/stranger/r gh pr comment 5 -b x").envRepo, "stranger/r");
    assert.deepEqual(targets("GH_REPO=stranger/r gh issue create --body x"), ["stranger/r"]);
  });

  it("--repo beats GH_REPO, as in gh", () => {
    const i = only("GH_REPO=stranger/r gh issue create --repo acme/x --body x");
    assert.equal(i.envRepo, undefined);
    assert.deepEqual(targets("GH_REPO=stranger/r gh issue create -Racme/x --body x"), ["acme/x"]);
  });

  it("a URL or o/r positional replaces the base repo, so GH_REPO does not apply", () => {
    assert.equal(only("GH_REPO=stranger/r gh pr comment https://github.com/acme/x/pull/5 -b y").envRepo, undefined);
    assert.equal(only("GH_REPO=stranger/r gh repo edit acme/x --visibility private").envRepo, undefined);
    // …but it still names the source of a transfer.
    assert.equal(only("GH_REPO=stranger/r gh issue transfer 5 acme/x").envRepo, "stranger/r");
  });

  it("gh api consults GH_REPO only for {owner}/{repo} placeholders", () => {
    assert.equal(only("GH_REPO=stranger/r gh api -X POST 'repos/{owner}/{repo}/issues' -f title=x").envRepo, "stranger/r");
    assert.equal(only("GH_REPO=stranger/r gh api -X POST repos/acme/x/issues -f title=x").envRepo, undefined);
    assert.equal(only("GH_REPO=stranger/r gh api graphql -f query='mutation { x }'").envRepo, undefined);
  });

  it("the caller's environment supplies GH_REPO (the shim reads its own); a prefix beats it", () => {
    const opts = { envRepo: "stranger/r" };
    assert.equal(only("gh issue create --body x", opts).envRepo, "stranger/r");
    assert.equal(only("gh issue create --repo acme/x --body x", opts).envRepo, undefined);
    assert.equal(only("GH_REPO=other/z gh issue create --body x", opts).envRepo, "other/z");
    // An empty value unsets it, in gh and here.
    assert.equal(only("GH_REPO= gh issue create --body x", opts).envRepo, undefined);
    assert.equal(only("gh issue create --body x", { envRepo: "" }).envRepo, undefined);
    assert.equal(only("gh issue create --body x").envRepo, undefined);
  });

  it("the environment never reaches git push or npm publish", () => {
    assert.equal(only("git push origin main", { envRepo: "stranger/r" }).envRepo, undefined);
    assert.equal(only("npm publish", { envRepo: "stranger/r" }).envRepo, undefined);
    assert.equal(only("GH_REPO=stranger/r git push origin main").envRepo, undefined);
  });

  it("an earlier segment that exports or assigns GH_REPO makes the intent unresolved: env-override", () => {
    for (const c of [
      "export GH_REPO=stranger/r && gh issue create --body x",
      "export GH_REPO=stranger/r; gh issue create --body x",
      "GH_REPO=stranger/r; gh issue create --body x",
      "declare -x GH_REPO=stranger/r\ngh issue create --body x",
      "export FOO=1 GH_REPO=stranger/r && gh pr comment 5 -b x",
      "export GH_REPO && gh issue create --body x",
      "readonly GH_REPO=stranger/r; gh pr comment 5 -b x",
    ]) {
      assert.equal(only(c).unresolved, "env-override", c);
    }
  });

  it("…unless something more specific already names the repository", () => {
    assert.equal(only("export GH_REPO=stranger/r && gh issue create --repo acme/x --body x").unresolved, undefined);
    assert.equal(only("export GH_REPO=stranger/r && gh pr comment https://github.com/acme/x/pull/5 -b y").unresolved, undefined);
    assert.equal(only("export GH_REPO=stranger/r && gh api -X POST repos/acme/x/issues -f a=b").unresolved, undefined);
  });

  it("a prefix assignment is local to its own command", () => {
    const i = only("GH_REPO=stranger/r git status; gh issue create --body x");
    assert.equal(i.envRepo, undefined);
    assert.equal(i.unresolved, undefined);
    // An unrelated export does not mark the intent either.
    assert.equal(only("export FOO=1 && gh issue create --body x").unresolved, undefined);
  });

  it("a GH_REPO that is not a literal repository is opaque", () => {
    assert.equal(only("GH_REPO=$TARGET gh issue create --body x").unresolved, "opaque-repo");
    assert.equal(only("gh issue create --body x", { envRepo: "not-a-repo" }).unresolved, "opaque-repo");
  });
});

describe("gh aliases (S11)", () => {
  const aliases = new Map<string, string>([
    ["ic", "issue create"],
    ["pc", "pr comment $1 --body $2"],
    ["tostranger", "issue create --repo stranger/r"],
    ["rv", "pr view"],
    ["sh", "!gh issue create --repo stranger/r --body x"],
    ["pr", "issue create"], // shadows a built-in: gh ignores it
    ["need3", "pr comment $3"],
    ["constructorx", "issue create"],
  ]);
  const opts: ParseEgressOptions = { ghAliases: aliases };

  it("(was: no intent) an alias to a write verb is that verb", () => {
    const i = only("gh ic --repo stranger/r --body x", opts);
    assert.equal(i.verb, "gh-issue-create");
    assert.equal(i.repoFlag, "stranger/r");
    assert.equal(only("gh ic -Rstranger/r --body x", opts).repoFlag, "stranger/r");
  });

  it("the alias body can carry the repository", () => {
    assert.equal(only("gh tostranger --body x", opts).repoFlag, "stranger/r");
  });

  it("$N placeholders are substituted, as gh does", () => {
    const i = only("gh pc https://github.com/stranger/r/pull/5 hello", opts);
    assert.equal(i.verb, "gh-pr-comment");
    assert.equal(i.positionalRepo, "stranger/r");
  });

  it("an alias to a read stays a read", () => {
    assert.deepEqual(parseEgressIntents("gh rv 5", opts), []);
  });

  it("(was: no intent) a shell alias is an unresolved intent: its script cannot be read", () => {
    const i = only("gh sh", opts);
    assert.equal(i.verb, "gh-alias-shell");
    assert.equal(i.unresolved, "gh-alias");
    assert.equal(only("gh sh --anything", opts).unresolved, "gh-alias");
  });

  it("an alias never overrides a built-in command", () => {
    const i = only("gh pr create -t x -b y --repo acme/x", opts);
    assert.equal(i.verb, "gh-pr-create");
    assert.equal(i.repoFlag, "acme/x");
  });

  it("gh refuses an alias with a missing $N, so nothing is published", () => {
    assert.deepEqual(parseEgressIntents("gh need3 a b", opts), []);
  });

  it("(C1, inverted) without aliases, an unknown first word fails closed: it may be an alias or an extension", () => {
    for (const c of ["gh ic --repo stranger/r --body x", "gh foo"]) {
      for (const o of [undefined, { envRepo: "a/b" }]) {
        const i = only(c, o);
        assert.equal(i.verb, "gh-unknown", c);
        assert.equal(i.unresolved, "gh-alias", c);
      }
    }
  });

  it("prototype keys are not aliases: they are unknown words, so unresolved", () => {
    for (const name of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      assert.equal(only(`gh ${name} --repo stranger/r --body x`, opts).unresolved, "gh-alias", name);
    }
  });

  it("(C1) an alias after leading flags is unresolved, not ignored", () => {
    for (const c of [
      "gh -R stranger/r ic -b x",
      "gh --repo stranger/r ic -b x",
      "gh --repo=stranger/r ic -b x",
      "gh -Rstranger/r ic -b x",
      "gh --repo stranger/r rv 5", // even an alias to a read: the parser cannot tell it is one from here
    ]) {
      const i = only(c, opts);
      assert.equal(i.verb, "gh-unknown", c);
      assert.equal(i.unresolved, "gh-alias", c);
    }
    // A flag first means gh does no alias lookup, but the unknown word must not pass either.
    assert.equal(only("gh --repo stranger/r ic", opts).unresolved, "gh-alias");
  });

  it("aliases of aliases are followed, to a depth of 5", () => {
    const chain = new Map<string, string>([
      ["a0", "issue create"],
      ["a1", "a0"],
      ["a2", "a1"],
      ["a3", "a2"],
      ["a4", "a3"],
      ["a5", "a4"],
      ["a6", "a5"],
    ]);
    const o = { ghAliases: chain };
    assert.equal(only("gh a1 --repo stranger/r -b x", o).verb, "gh-issue-create");
    assert.equal(only("gh a4 --repo stranger/r -b x", o).repoFlag, "stranger/r"); // a4→a3→a2→a1→a0→issue: five expansions
    const deep = only("gh a5 --repo stranger/r -b x", o); // a sixth: over the cap
    assert.equal(deep.verb, "gh-unknown");
    assert.equal(deep.unresolved, "gh-alias");
    assert.equal(only("gh a6 --repo stranger/r -b x", o).unresolved, "gh-alias"); // and however deep
    // A cycle is just the cap again.
    assert.equal(only("gh x --repo a/b", { ghAliases: new Map([["x", "y"], ["y", "x"]]) }).unresolved, "gh-alias");
    // An alias of a shell alias is a shell alias.
    assert.equal(only("gh s2", { ghAliases: new Map([["s2", "s1"], ["s1", "!echo"]]) }).verb, "gh-alias-shell");
  });

  it("(M1) an expansion over 64 KiB, or substituted over it, is unresolved", () => {
    const big = "issue create --body " + "x".repeat(70 * 1024);
    assert.equal(only("gh big --repo a/b", { ghAliases: new Map([["big", big]]) }).unresolved, "gh-alias");
    const grow = new Map([["grow", "issue create --body $1 --body $1 --body $1"]]);
    assert.equal(only(`gh grow ${"y".repeat(30 * 1024)}`, { ghAliases: grow }).unresolved, "gh-alias");
    assert.equal(only("gh grow z --repo a/b", { ghAliases: grow }).verb, "gh-issue-create");
    // More arguments than placeholders can use.
    const many = Array.from({ length: 100 }, (_, k) => `a${k}`).join(" ");
    assert.equal(only(`gh grow ${many}`, { ghAliases: grow }).unresolved, "gh-alias");
  });

  it("(M2) a word-initial # in an expansion starts a comment, as in google/shlex", () => {
    const o = { ghAliases: new Map([["note", "issue create --body $1 --repo acme/x"]]) };
    // `$1` = `#x` makes the rest of the line a comment, so --repo acme/x is NOT in effect.
    assert.equal(only("gh note '#x'", o).repoFlag, undefined);
    assert.equal(only("gh note 'a#x'", o).repoFlag, "acme/x"); // `#` inside a word is not a comment
    assert.equal(only("gh note x", o).repoFlag, "acme/x");
    assert.equal(only("gh issue-ic", { ghAliases: new Map([["issue-ic", "issue create # --repo acme/x"]]) }).repoFlag, undefined);
  });

  it("aliases are loaded lazily, once, and only when a gh call needs them", () => {
    let loads = 0;
    const lazy: ParseEgressOptions = {
      ghAliases: () => {
        loads++;
        return aliases;
      },
    };
    for (const c of ["git push origin main", "npm publish", "gh pr create -t x -b y", "gh api -X POST repos/a/b/issues -f a=b", "ls"]) {
      parseEgressIntents(c, lazy);
    }
    assert.equal(loads, 0);
    assert.equal(parseEgressIntents("gh ic --body x && gh ic --body y", lazy).length, 2);
    assert.equal(loads, 1);
  });

  it("a loader that throws means aliases are unknown: a non-built-in first word is unresolved, never 'no aliases' (H1)", () => {
    const i = only("gh ic --body x", {
      ghAliases: () => {
        throw new Error("boom");
      },
    });
    assert.equal(i.verb, "gh-unknown");
    assert.equal(i.unresolved, "gh-alias");
    // Built-in commands do not need the aliases.
    assert.equal(
      only("gh issue create --body x", {
        ghAliases: () => {
          throw new Error("boom");
        },
      }).verb,
      "gh-issue-create",
    );
  });
});

describe("gh api placeholders — only the owner and repo segments may send the guard to the cwd", () => {
  it("(was: attributed to the cwd) a literal owner/repo wins over a placeholder later in the path or in the query", () => {
    const cases = [
      "gh api -X POST 'repos/stranger/r/issues?ref={branch}' -f title=x -f body=x",
      "gh api -X PATCH 'repos/stranger/r/git/refs/heads/{branch}' -f sha=abc",
      "gh api -X POST 'repos/stranger/r/issues?x={owner}'",
      "gh api -X POST 'repos/stranger/r/issues/{repo}/comments' -f body=x",
      "gh api -X POST 'https://api.github.com/repos/stranger/r/issues?ref={branch}' -f title=x",
      "gh api -X DELETE 'orgs/stranger/teams/{repo}'",
    ];
    for (const c of cases) {
      const i = only(c);
      assert.equal(i.unresolved, undefined, c);
      assert.equal(intentRepoTargets(i).length, 0, c); // nothing new: the endpoint itself names the target
      assert.ok(i.apiEndpoint, c);
    }
    assert.deepEqual(parseApiEndpoint("repos/stranger/r/issues?ref={branch}"), { org: "stranger", repo: "r" });
    assert.deepEqual(parseApiEndpoint("repos/stranger/r/git/refs/heads/{branch}"), { org: "stranger", repo: "r" });
    assert.deepEqual(parseApiEndpoint("repos/stranger/r/issues?x={owner}"), { org: "stranger", repo: "r" });
    assert.deepEqual(parseApiEndpoint("orgs/stranger/teams/{repo}"), { org: "stranger", repo: null });
    assert.deepEqual(parseApiEndpoint("repos/stranger/r?x=1#{frag}"), { org: "stranger", repo: "r" });
  });

  it("a later placeholder does not let GH_REPO redirect an endpoint that names its repository", () => {
    const i = only("GH_REPO=acme/x gh api -X POST 'repos/stranger/r/issues?ref={branch}' -f title=x");
    assert.equal(i.envRepo, undefined);
    assert.equal(only("export GH_REPO=acme/x && gh api -X PATCH 'repos/stranger/r/git/refs/heads/{branch}' -f sha=a").unresolved, undefined);
  });

  it("the legitimate placeholder form falls back to the cwd (and so to GH_REPO)", () => {
    for (const c of [
      "gh api -X POST 'repos/{owner}/{repo}/issues' -f title=x",
      "gh api -X POST 'repos/{owner}/{repo}/issues?ref={branch}' -f title=x",
      "gh api -X POST 'repos/{owner}/literal/issues' -f title=x",
      "gh api -X POST 'repos/literal/{repo}/issues' -f title=x",
      "gh api -X POST 'orgs/{owner}/repos' -f name=x",
      "gh api -X POST 'https://api.github.com/repos/{owner}/{repo}/issues' -f title=x",
    ]) {
      const i = only(c);
      assert.equal(i.unresolved, undefined, c);
      assert.equal(parseApiEndpoint(i.apiEndpoint!), null, c);
      assert.equal(only(c, { envRepo: "stranger/r" }).envRepo, "stranger/r", c);
    }
    assert.equal(only("export GH_REPO=stranger/r && gh api -X POST 'repos/{owner}/{repo}/issues' -f title=x").unresolved, "env-override");
  });

  it("(was: attributed to the cwd) any other placeholder in the owner or repo segment is unresolved", () => {
    for (const c of [
      "gh api -X POST 'repos/{branch}/r/issues' -f title=x",
      "gh api -X POST 'repos/stranger/{branch}/issues' -f title=x",
      "gh api -X POST 'repos/{repo}/{owner}/issues' -f title=x", // swapped: not the placeholder for that segment
      "gh api -X POST 'repos/str{owner}/r/issues' -f title=x",
      "gh api -X DELETE 'orgs/{branch}/teams/t'",
    ]) {
      assert.equal(only(c).unresolved, "opaque-repo", c);
    }
    assert.equal(analyseApiEndpoint("repos/{branch}/r").kind, "opaque");
  });

  it("endpoints with no repository stay 'none'", () => {
    for (const e of ["graphql", "user/starred/a/b", "gists", "search/issues?q={x}", "markdown"]) {
      assert.equal(analyseApiEndpoint(e).kind, "none", e);
    }
  });
});

describe("parseRepoRef / intentRepoTargets", () => {
  it("accepts the forms gh accepts, lower-cased", () => {
    const cases: Array<[string, { org: string; repo: string } | null]> = [
      ["stranger/r", { org: "stranger", repo: "r" }],
      ["Stranger/R.git", { org: "stranger", repo: "r" }],
      ["github.com/stranger/r", { org: "stranger", repo: "r" }],
      ["https://github.com/stranger/r", { org: "stranger", repo: "r" }],
      ["https://github.com/stranger/r/pull/5#issuecomment-1", { org: "stranger", repo: "r" }],
      ["HTTPS://GITHUB.COM:443/stranger/r.git", { org: "stranger", repo: "r" }],
      ["ssh://git@github.com/stranger/r.git", { org: "stranger", repo: "r" }],
      ["git@github.com:stranger/r.git", { org: "stranger", repo: "r" }],
      ["", null],
      ["r", null],
      ["a/b/c/d", null],
      ["$REPO", null],
      ["$(cat x)", null],
      ["{owner}/{repo}", null],
      ["a b/c", null],
      ["../x", null],
      ["https://github.com/", null],
    ];
    for (const [input, expected] of cases) assert.deepEqual(parseRepoRef(input), expected, input);
  });

  it("intentRepoTargets: deduplicated, positional first, then --repo else GH_REPO", () => {
    assert.deepEqual(targets("gh issue create --body x"), []);
    assert.deepEqual(targets("gh pr comment https://github.com/a/b/pull/1 --repo A/B -b x"), ["a/b"]);
    assert.deepEqual(targets("gh issue create --body x", { envRepo: "a/b" }), ["a/b"]);
    assert.deepEqual(targets("gh secret set T --org Acme"), ["acme/*"]);
  });
});

describe("parseEgressIntents with options — never throws", () => {
  const nasty = [
    "gh",
    "gh -",
    "gh --",
    "gh -R",
    "gh --repo",
    "gh issue create -R",
    "gh issue create --repo",
    "gh issue create -",
    "gh issue create --",
    "gh api -X",
    "gh api -XPOST",
    "gh issue transfer",
    "gh issue transfer 5",
    "gh repo create",
    "gh secret set --org",
    "gh ic",
    "gh sh",
    "GH_REPO",
    "GH_REPO=",
    "export GH_REPO",
    "env GH_REPO=",
    "gh pr comment 'https://",
    "gh issue create -R=",
    "gh issue create -R==",
  ];
  const opts: ParseEgressOptions = { envRepo: "a/b", ghAliases: new Map([["ic", "issue create"], ["sh", "!x"]]) };
  for (const c of nasty) {
    it(`survives ${JSON.stringify(c)}`, () => {
      assert.doesNotThrow(() => parseEgressIntents(c, opts));
    });
  }

  it("survives pseudo-random junk made of the parser's own vocabulary", () => {
    const words = [
      "gh", "issue", "pr", "create", "comment", "api", "-R", "-X", "-f", "-F", "--repo", "--", "-", "=", "a/b", "POST",
      "&&", ";", "'", '"', "$X", "GH_REPO=a/b", "export", "ic", "-Rx/y", "--repo=x/y",
      // tokeniser and wrapper vocabulary
      "$'", "$'\\x67h'", '$"', "+=", "GH_REPO+=a/b", "{", "}", "{a,b}", "g{h,}", "$(", "`", ")", "$1", "$2", "#",
      "bash", "-c", "eval", "xargs", "env", "-S", "timeout", "nice", "sudo", "git", "-C", "push", "--git-dir=x", "GIT_DIR=x",
      "unset", "source", ".", "read", "printf", "-v", "<<", "EOF", "\n",
    ];
    let seed = 12345;
    const next = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed;
    };
    for (let n = 0; n < 2000; n++) {
      const len = 1 + (next() % 10);
      const parts: string[] = [];
      for (let k = 0; k < len; k++) parts.push(words[next() % words.length]!);
      const cmd = parts.join(" ");
      assert.doesNotThrow(() => parseEgressIntents(cmd, opts), cmd);
    }
  });
});
