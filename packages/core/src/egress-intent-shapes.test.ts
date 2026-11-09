// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// Issue #151, PR 2a, second review round: the shapes the parser follows. Reserved words, runners, an
// expansion as the command word, shell alias taint, git aliases and plumbing, the gh api path rules, the
// read lists of the unmodelled groups, and aliases under read groups.
//
// The word backstop (a second read of the command's text for `gh <group>` / `git push` mentions) is gone:
// a segment the parser does not recognise as `git push` / `gh <write>` is no intent at the hook. The shapes
// it used to catch (`find -exec gh …`, `parallel gh …`, an interpreter's `-c` text, `case` bodies) are
// pinned below as "no intent here"; that they are still judged when they actually run `gh` / `git push` is
// tested at the layer below (tests/shim-smoke.sh and the pre-push hook tests).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  analyseApiEndpoint,
  parseApiEndpoint,
  parseEgressIntents,
  type EgressIntent,
  type ParseEgressOptions,
} from "./egress-intent.js";
import { loadGitAliases, parseGitAliasEntries } from "./gh-env.js";

function all(command: string, opts?: ParseEgressOptions): EgressIntent[] {
  return parseEgressIntents(command, opts);
}

function only(command: string, opts?: ParseEgressOptions): EgressIntent {
  const intents = all(command, opts);
  assert.equal(intents.length, 1, `expected exactly one intent for ${JSON.stringify(command)}, got ${JSON.stringify(intents)}`);
  return intents[0]!;
}

/** The command's single intent is unresolved. */
function unresolved(command: string, opts?: ParseEgressOptions): EgressIntent {
  const i = only(command, opts);
  assert.ok(i.unresolved !== undefined, `expected an unresolved intent for ${JSON.stringify(command)}, got ${JSON.stringify(i)}`);
  return i;
}

function q(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

describe("reserved words are transparent: the command they run resolves, it is not merely flagged", () => {
  const stranger = "gh issue create -R stranger/r -b x";

  it("if / then / elif / else / do / while / until / ! / coproc", () => {
    for (const c of [
      `if ${stranger}; then :; fi`,
      `if true; then ${stranger}; fi`,
      `if false; then :; elif ${stranger}; then :; fi`,
      `if false; then :; else ${stranger}; fi`,
      `! ${stranger}`,
      `for x in a b; do ${stranger}; done`,
      `while ${stranger}; do :; done`,
      `until ${stranger}; do :; done`,
      `while true; do ${stranger}; break; done`,
      `coproc ${stranger}`,
      `{ ${stranger}; }`,
      `if ! ${stranger}; then :; fi`,
    ]) {
      const i = only(c);
      assert.equal(i.verb, "gh-issue-create", c);
      assert.equal(i.repoFlag, "stranger/r", c);
      assert.equal(i.unresolved, undefined, c);
    }
  });

  it("a registered target stays resolved (not a blanket sentinel)", () => {
    const i = only("if gh issue create -R acme/x -b x; then :; fi");
    assert.equal(i.repoFlag, "acme/x");
    assert.equal(i.unresolved, undefined);
    assert.equal(only("if git push https://github.com/stranger/r main; then :; fi").remote, "https://github.com/stranger/r");
  });

  it("function NAME { … } and name() { … } do not make the name a command", () => {
    assert.equal(only("function f { gh issue create -R stranger/r -b x; }").repoFlag, "stranger/r");
    assert.equal(only("f() { gh issue create -R stranger/r -b x; }").repoFlag, "stranger/r");
    assert.equal(only("f () { gh issue create -R stranger/r -b x; }").repoFlag, "stranger/r");
  });

  it("case … esac has no reserved-word shape the parser follows: its body is no intent at the hook (the shim and pre-push judge it)", () => {
    assert.deepEqual(all("case x in x) gh issue create -R stranger/r -b x;; esac"), []);
    assert.deepEqual(all("case x in x) git push https://github.com/stranger/r main;; esac"), []);
  });
});

describe("runners and interpreters: not modelled, so no intent at the hook (the layer below judges what they run)", () => {
  it("find -exec, parallel: no intent", () => {
    assert.deepEqual(all("find . -exec gh issue create -R stranger/r -b x \\;"), []);
    assert.deepEqual(all("find . -name x -exec git push https://github.com/stranger/r main ';'"), []);
    assert.deepEqual(all("parallel gh issue create -R stranger/r -b x ::: a b"), []);
  });

  it("watch and flock run their command: it resolves", () => {
    const w = only("watch -n 999 gh issue create -R stranger/r -b x");
    assert.equal(w.repoFlag, "stranger/r");
    assert.equal(w.unresolved, undefined);
    assert.equal(only("watch --interval 5 git push https://github.com/stranger/r main").verb, "git-push");
    assert.equal(only("flock /tmp/l gh issue create -R stranger/r -b x").repoFlag, "stranger/r");
    assert.equal(only("flock -w 5 /tmp/l gh issue create -R stranger/r -b x").repoFlag, "stranger/r");
  });

  it("python, perl, node, ruby, awk -c/-e text: no intent", () => {
    for (const c of [
      `python3 -c "import os; os.system('gh issue create -R stranger/r -b x')"`,
      `python -c "import subprocess; subprocess.run(['git','push','https://github.com/stranger/r','main'])"`,
      `perl -e 'system("gh issue create -R stranger/r -b x")'`,
      `node -e "require('child_process').execSync('gh issue create -R stranger/r -b x')"`,
      `ruby -e 'system("gh issue create -R stranger/r -b x")'`,
      `awk 'BEGIN { system("gh issue create -R stranger/r -b x") }'`,
      `php -r 'system("gh pr comment 5 -b x");'`,
    ]) {
      assert.deepEqual(all(c), [], c);
    }
  });

  it("a bundle of short flags ending in a value-taking flag takes the next word: the command still resolves", () => {
    assert.equal(only("env -iC /tmp git push origin main").verb, "git-push");
    assert.equal(only("sudo -Eu root git push origin main").verb, "git-push");
    assert.equal(only("env -uFOO git push origin main").verb, "git-push"); // value attached: nothing is skipped
    assert.equal(only("sudo -u root -E gh issue create -R stranger/r -b x").repoFlag, "stranger/r");
  });

  it("busybox sh -c is a shell -c: it resolves", () => {
    const i = only(`busybox sh -c ${q("gh issue create -R stranger/r -b x")}`);
    assert.equal(i.repoFlag, "stranger/r");
    assert.equal(i.unresolved, undefined);
  });

  it("an interpreter's text without a gh or git push mention yields nothing", () => {
    assert.deepEqual(all(`python3 -c "print('hello')"`), []);
    assert.deepEqual(all(`node -e "console.log(process.argv)"`), []);
    assert.deepEqual(all(`python3 -c "import os; os.system('ls')"`), []);
  });
});

describe("remote and container runners: a publish run through them is unresolved (no shim or pre-push there)", () => {
  const PUBLISHING: Array<[string, "git-push" | "gh-unknown"]> = [
    ["ssh host 'git push origin main'", "git-push"],
    ["ssh host git push origin main", "git-push"],
    ["ssh -p 22 -i key host gh pr create --repo o/r --title t --body b", "gh-unknown"],
    ["ssh -t host 'cd x && git push origin main'", "git-push"],
    ["sudo ssh host git push origin main", "git-push"],
    ["docker exec ctr git push origin main", "git-push"],
    ["docker exec -it -u root ctr git push origin main", "git-push"],
    ["docker exec ctr sh -c 'git push origin main'", "git-push"],
    ["docker run --rm -e A=1 -v /a:/b img gh pr create --repo o/r --title t", "gh-unknown"],
    ["docker container exec ctr git push origin main", "git-push"],
    ["docker compose run svc gh pr create --repo o/r --title t", "gh-unknown"],
    ["podman exec ctr git push origin main", "git-push"],
    ["podman run --rm img gh pr create --repo o/r --title t", "gh-unknown"],
    ["kubectl exec pod -- git push origin main", "git-push"],
    ["kubectl exec -n ns -c c pod -- gh pr create --repo o/r --title t", "gh-unknown"],
    ["devcontainer exec --workspace-folder . git push origin main", "git-push"],
    ["nix-shell --pure --run 'gh pr create --repo o/r --title t'", "gh-unknown"],
    ["nix-shell shell.nix --run 'git push origin main'", "git-push"],
    ["nix develop -c gh pr create --repo o/r --title t", "gh-unknown"],
    ["nix shell nixpkgs#gh --command gh pr create --repo o/r --title t", "gh-unknown"],
    ["vagrant ssh -c 'git push origin main'", "git-push"],
    ["vagrant ssh default --command 'gh pr create --repo o/r --title t'", "gh-unknown"],
    ["wsl git push origin main", "git-push"],
    ["wsl -d Ubuntu -- gh pr create --repo o/r --title t", "gh-unknown"],
    ["distrobox enter box -- git push origin main", "git-push"],
    ["distrobox-enter -n box -- git push origin main", "git-push"],
    ["toolbox run git push origin main", "git-push"],
    ["toolbox run -c fedora gh pr create --repo o/r --title t", "gh-unknown"],
  ];
  for (const [c, verb] of PUBLISHING) {
    it(`${c} → one unresolved intent`, () => {
      const i = only(c);
      assert.equal(i.verb, verb);
      assert.equal(i.unresolved, "unparsed-shape");
    });
  }

  it("a runner that runs nothing publishing is no intent, and so is a mention inside a quoted echo", () => {
    for (const c of [
      "ssh host ls",
      "ssh host 'echo git push'",
      "ssh host echo git push",
      "ssh host gh pr view 1",
      "ssh -t host htop",
      "docker exec ctr cat file",
      "docker exec ctr echo git push",
      "docker run --rm img echo hi",
      "docker ps",
      "docker build -t x .",
      "podman exec ctr ls -la",
      "kubectl exec pod -- ls",
      "kubectl get pods",
      "devcontainer exec --workspace-folder . npm test",
      "nix-shell --run 'ls'",
      "nix develop -c make",
      "nix build",
      "vagrant ssh -c 'uptime'",
      "vagrant up",
      "wsl ls",
      "distrobox enter box -- ls",
      "toolbox run ls",
      "toolbox list",
    ]) {
      assert.deepEqual(all(c), [], c);
    }
  });
});

describe("a flag that is not a value flag is not skipped over the command", () => {
  it("sudo -h and watch -p take no value: the push behind them resolves", () => {
    assert.equal(only("sudo -h git push origin main").verb, "git-push");
    assert.equal(only("watch -p git push https://github.com/stranger/r main").remote, "https://github.com/stranger/r");
    assert.equal(only("sudo --host h git push origin main").verb, "git-push"); // --host still takes a value
  });
});

describe("process substitution: <(…) and >(…) are commands of their own", () => {
  it("cat <(gh …)", () => {
    const i = only("cat <(gh issue create -R stranger/r -b x)");
    assert.equal(i.verb, "gh-issue-create");
    assert.equal(i.repoFlag, "stranger/r");
  });

  it("tee >(gh … -F -) < body.md", () => {
    const i = only("tee >(gh issue create -R stranger/r -F -) < body.md");
    assert.equal(i.verb, "gh-issue-create");
    assert.equal(i.repoFlag, "stranger/r");
    assert.deepEqual(i.payloadFiles, ["-"]);
  });

  it("several, nested, and git push", () => {
    assert.equal(all("diff <(gh pr list) <(gh issue create -R stranger/r -b x)").length, 1);
    assert.equal(only("cat <(cat <(gh issue create -R stranger/r -b x))").repoFlag, "stranger/r");
    assert.equal(only("tee >(git push https://github.com/stranger/r main)").verb, "git-push");
  });

  it("the rest of the outer command is not swallowed by the substitution, and a read inside is no intent", () => {
    assert.deepEqual(all("diff <(gh pr list) <(gh issue list)"), []);
    assert.equal(only("diff <(echo a) b && gh issue create -R stranger/r -b x").repoFlag, "stranger/r");
  });
});

describe("functions: a body that runs gh with forwarded arguments is unresolved", () => {
  it('f(){ gh "$@"; }; f issue create -R stranger/r -b x', () => {
    const i = unresolved('f(){ gh "$@"; }; f issue create -R stranger/r -b x');
    assert.equal(i.verb, "gh-unknown");
  });

  it('a body with a group and forwarded arguments: the forwarded part can carry the repository', () => {
    unresolved('f() { gh issue create "$@"; }; f -R stranger/r -b x');
    assert.equal(unresolved('f() { git push "$@"; }; f https://github.com/stranger/r main').unresolved, "unparsed-shape");
    unresolved('gh issue create $*');
    unresolved('gh issue create "$@"');
  });

  it("a function that never runs gh yields nothing", () => {
    assert.deepEqual(all('f() { echo "$@"; }; f hello'), []);
  });
});

describe("stdin-fed shells", () => {
  const body = "gh issue create -R stranger/r -b x";

  it("a heredoc fed to a shell is parsed as its commands", () => {
    for (const c of [`sh <<EOF\n${body}\nEOF`, `bash <<'EOF'\n${body}\nEOF`, `bash -s <<EOF\n${body}\nEOF`, `sh - <<EOF\n${body}\nEOF`]) {
      const i = only(c);
      assert.equal(i.verb, "gh-issue-create", c);
      assert.equal(i.repoFlag, "stranger/r", c);
    }
    assert.equal(only(`bash <<EOF\ngit push https://github.com/stranger/r main\nEOF`).verb, "git-push");
    assert.equal(only(`sh <<EOF\ncd /x\n${body}\nEOF`).repoFlag, "stranger/r");
  });

  it("a heredoc fed to a script interpreter is its program, not shell commands: no intent at the hook", () => {
    assert.deepEqual(all(`python3 - <<EOF\nimport os\nos.system('${body}')\nEOF`), []);
    assert.deepEqual(all(`node <<EOF\nrequire('child_process').execSync('${body}')\nEOF`), []);
  });

  it("a heredoc fed to anything else is data", () => {
    assert.deepEqual(all(`cat <<EOF\n${body}\nEOF`), []);
    assert.deepEqual(all(`tee notes.md <<EOF\n${body}\nEOF`), []);
  });

  it("echo … | sh: a shell reading a pipe is unresolved, whatever feeds it", () => {
    for (const c of [`echo ${q(body)} | sh`, `printf '%s\\n' ${q(body)} | bash`]) {
      const intents = all(c);
      assert.equal(intents.length, 1, c);
      assert.equal(intents[0]!.unresolved, "unparsed-shape", c);
    }
  });

  it("sh -s <<< \"…\" (a here-string) is parsed as commands", () => {
    const i = only(`sh -s <<< ${q(body)}`);
    assert.equal(i.verb, "gh-issue-create");
    assert.equal(i.repoFlag, "stranger/r");
    assert.equal(only(`bash <<<${q(body)}`).repoFlag, "stranger/r");
  });
});

describe("an expansion as the command word", () => {
  it("$GH issue create, \"${GH}\" pr comment 5, $(which gh) issue create", () => {
    for (const c of ["$GH issue create -R stranger/r -b x", '"${GH}" pr comment 5 -b x', "$(which gh) issue create -R stranger/r -b x", "`which gh` pr comment 5", "$G push origin main", "${G} send-pack https://github.com/stranger/r"]) {
      assert.equal(only(c).unresolved, "unparsed-shape", c);
    }
  });

  it("an expansion followed by nothing egress-like yields nothing", () => {
    assert.deepEqual(all("$EDITOR notes.md"), []);
    assert.deepEqual(all("$(which python3) script.py"), []);
    assert.deepEqual(all('"$HOME/bin/tool" --version'), []);
  });

  it("a path through an expansion that ends in /gh is gh itself", () => {
    const i = only("$HOME/bin/gh issue create -R stranger/r -b x");
    assert.equal(i.verb, "gh-issue-create");
    assert.equal(i.repoFlag, "stranger/r");
  });
});

describe("shell alias taint", () => {
  it("alias NAME='gh …' makes later uses of NAME unresolved", () => {
    const i = only("alias ic='gh issue create -R stranger/r'; ic -b x");
    assert.equal(i.unresolved, "unparsed-shape");
    assert.equal(i.verb, "gh-unknown");
    assert.equal(only("alias g=gh; g issue create -R stranger/r -b x").unresolved, "unparsed-shape");
  });

  it("a git alias is tainted for pushes only", () => {
    assert.equal(only("alias gp='git push'; gp https://github.com/stranger/r main").unresolved, "unparsed-shape");
    assert.equal(only("alias g=git; g push https://github.com/stranger/r main").unresolved, "unparsed-shape");
    assert.deepEqual(all("alias g=git; g status"), []);
    assert.deepEqual(all("alias gs='git status'; gs"), []);
  });

  it("the definition alone is not an intent, and an unrelated alias is untouched", () => {
    assert.deepEqual(all("alias ic='gh issue create'"), []);
    assert.deepEqual(all("alias ll='ls -la'; ll"), []);
  });

  it("taint reaches nested text", () => {
    assert.equal(only(`alias ic='gh issue create'; bash -c ${q("ic -R stranger/r -b x")}`).unresolved, "unparsed-shape");
  });
});

describe("git aliases and plumbing", () => {
  const gitAliases = new Map([
    ["p", "push"],
    ["pf", "push --force-with-lease"],
    ["pp", "p"],
    ["sh", "!git push origin main"],
    ["st", "status"],
  ]);
  const opts: ParseEgressOptions = { gitAliases };

  it("git -c alias.X=… X is resolved as what it expands to", () => {
    const i = only("git -c alias.p=push p https://github.com/stranger/r main");
    assert.equal(i.verb, "git-push");
    assert.equal(i.remote, "https://github.com/stranger/r");
    assert.equal(i.refspec, "main");
    assert.equal(only("git -c alias.p='push --force' p https://github.com/stranger/r main").remote, "https://github.com/stranger/r");
    assert.deepEqual(all("git -c alias.s=status s"), []);
  });

  it("git -c alias.X='!shell' X, and --config-env alias, are unresolved", () => {
    const shell = all("git -c alias.p='!git push https://github.com/stranger/r main' p");
    assert.equal(shell.length, 1);
    assert.equal(shell[0]!.unresolved, "unparsed-shape");
    assert.equal(only("git --config-env=alias.p=PUSHCMD p").unresolved, "unparsed-shape");
    assert.equal(only("git --config-env alias.p=PUSHCMD p").unresolved, "unparsed-shape");
  });

  it("a configured alias that expands to push is a push", () => {
    const i = only("git p https://github.com/stranger/r main", opts);
    assert.equal(i.verb, "git-push");
    assert.equal(i.remote, "https://github.com/stranger/r");
    assert.equal(only("git pf https://github.com/stranger/r main", opts).remote, "https://github.com/stranger/r");
    assert.equal(only("git pp https://github.com/stranger/r main", opts).verb, "git-push"); // alias of an alias
  });

  it("a shell alias, an unreadable config, and a chain over the cap are unresolved", () => {
    assert.equal(only("git sh", opts).unresolved, "unparsed-shape");
    assert.equal(only("git p origin main", { gitAliases: null }).unresolved, "unparsed-shape");
    assert.equal(
      only("git x0 origin main", { gitAliases: new Map(Array.from({ length: 8 }, (_, k) => [`x${k}`, `x${k + 1}`] as [string, string])) }).unresolved,
      "unparsed-shape",
    );
  });

  it("built-ins and non-push aliases are not pushes, and need no alias lookup", () => {
    let loads = 0;
    const lazy: ParseEgressOptions = {
      gitAliases: () => {
        loads++;
        return gitAliases;
      },
    };
    for (const c of ["git status", "git log --oneline", "git commit -m x", "git fetch origin", "git pull"]) assert.deepEqual(all(c, lazy), [], c);
    assert.equal(loads, 0);
    assert.deepEqual(all("git st", lazy), []);
    assert.equal(loads, 1);
    assert.deepEqual(all("git pushd", lazy), []); // not a built-in, not an alias, not a push
  });

  it("without alias information a non-built-in subcommand is not a push", () => {
    assert.deepEqual(all("git p origin main"), []);
  });

  it("git send-pack <url> and git http-push <url> are pushes to that URL", () => {
    const s = only("git send-pack https://github.com/stranger/r main");
    assert.equal(s.verb, "git-push");
    assert.equal(s.remote, "https://github.com/stranger/r");
    assert.equal(s.refspec, "main");
    const h = only("git http-push --force https://github.com/stranger/r main");
    assert.equal(h.verb, "git-push");
    assert.equal(h.remote, "https://github.com/stranger/r");
    assert.equal(only("git -C /x send-pack --receive-pack=rp https://github.com/stranger/r main").cwdOverride, "/x");
    assert.equal(only("sudo git send-pack https://github.com/stranger/r main").verb, "git-push");
  });

  it("parseGitAliasEntries reads `git config -z --get-regexp` output", () => {
    const m = parseGitAliasEntries(
      "alias.p\npush\0alias.Pf\npush --force-with-lease\0alias.sh\n!echo a b\0alias.empty\0notalias.x\ny\0",
    );
    assert.equal(m.get("p"), "push");
    assert.equal(m.get("pf"), "push --force-with-lease");
    assert.equal(m.get("sh"), "!echo a b");
    assert.equal(m.get("empty"), "");
    assert.equal(m.has("x"), false);
  });

  it("loadGitAliases reads them with git itself; no alias is an empty map; a bad cwd is unknown", () => {
    const empty = loadGitAliases("/", { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" });
    assert.equal(empty?.size, 0);
    assert.equal(loadGitAliases("/definitely/not/a/dir"), null);
  });
});

describe("gh api: path rules for a mutating request", () => {
  it("an expansion anywhere in the path is unresolved; the query keeps its leniency", () => {
    for (const c of [
      'gh api -X POST "repos/stranger/r/issues/$N" -f a=b',
      'gh api -X POST "repos/acme/x/$P" -f a=b',
      "gh api -X POST repos/acme/x/`cat p` -f a=b",
      "gh api -X DELETE \"repos/acme/x/git/refs/heads/$(cat b)\"",
    ]) {
      assert.equal(only(c).unresolved, "opaque-repo", c);
    }
    assert.equal(only('gh api -X POST "repos/acme/x/issues?ref=$B" -f a=b').unresolved, undefined);
  });

  it("%2e and %2f in the path, in any case, and dot, dot-dot and empty segments, are unresolved", () => {
    for (const e of [
      "repos/acme/x/%2e%2e/%2e%2e/stranger/r/issues",
      "repos/acme/x/%2E%2E/stranger/r",
      "repos/acme%2fx/issues",
      "repos/acme%2Fx/issues",
      "repos/acme/x/../../stranger/r/issues",
      "repos/acme/x/./issues",
      "repos/acme//x/issues",
      "repos/acme/x//issues",
    ]) {
      assert.equal(analyseApiEndpoint(e).kind, "opaque", e);
      assert.equal(parseApiEndpoint(e), null, e);
      assert.equal(only(`gh api -X POST ${q(e)} -f a=b`).unresolved, "opaque-repo", e);
    }
  });

  it("the same characters in the query are fine, and a plain path is unchanged", () => {
    assert.equal(analyseApiEndpoint("repos/acme/x/issues?next=..%2f..%2f").kind, "named");
    assert.deepEqual(parseApiEndpoint("repos/acme/x/issues/12"), { org: "acme", repo: "x" });
    assert.deepEqual(parseApiEndpoint("repos/acme/x.y/contents/a.b/c"), { org: "acme", repo: "x.y" });
  });

  it("a read is not judged by it", () => {
    assert.deepEqual(all('gh api "repos/acme/x/$P"'), []);
    assert.deepEqual(all("gh api repos/acme/x/%2e%2e/stranger/r"), []);
  });
});

describe("unmodelled built-in groups: reads give no intent, writes and unknown subcommands do (M4 usability)", () => {
  it("list / view / status / watch are reads for every unmodelled group", () => {
    for (const g of ["codespace", "extension", "cache", "project", "ssh-key", "gpg-key", "copilot", "agent-task"]) {
      for (const sub of ["list", "view", "status", "watch"]) {
        assert.deepEqual(all(`gh ${g} ${sub}`), [], `${g} ${sub}`);
      }
    }
    for (const c of ["gh copilot explain 'ls'", "gh copilot suggest 'undo'", "gh project field-list 1", "gh project item-list 1", "gh codespace logs", "gh extension search x", "gh extension browse"]) {
      assert.deepEqual(all(c), [], c);
    }
  });

  it("writes and unknown subcommands stay unknown-shape", () => {
    for (const c of [
      "gh project item-create 1 --owner stranger --title t",
      "gh project edit 1",
      "gh codespace create -R stranger/r",
      "gh cache delete --all",
      "gh ssh-key add k.pub",
      "gh gpg-key add k.asc",
      "gh agent-task create 'x'",
      "gh extension install stranger/gh-x",
      "gh extension exec x",
      "gh copilot config",
    ]) {
      assert.equal(only(c).unresolved, "unknown-shape", c);
    }
  });

  it("an extension command (a non-built-in that is not an alias) stays unresolved", () => {
    const i = only("gh dash");
    assert.equal(i.verb, "gh-unknown");
    assert.equal(i.unresolved, "gh-alias");
    assert.equal(only("gh dash", { ghAliases: new Map() }).unresolved, "gh-alias");
  });
});

describe("aliases under a read group (M8)", () => {
  const aliases = new Map([
    ["search ic", "issue create"],
    ["auth mine", "!gh issue create"],
    ["status x", "pr list"],
  ]);

  it("a subcommand matching an alias key \"<group> <sub>\" is expanded", () => {
    const i = only("gh search ic -R stranger/r -b x", { ghAliases: aliases });
    assert.equal(i.verb, "gh-issue-create");
    assert.equal(i.repoFlag, "stranger/r");
    assert.equal(only("gh auth mine", { ghAliases: aliases }).verb, "gh-alias-shell");
  });

  it("an alias keyed on a group and subcommand of a write or unmodelled group expands too", () => {
    const o = { ghAliases: new Map([["pr co", "issue create"], ["project mk", "issue create"]]) };
    assert.equal(only("gh pr co -R stranger/r -b x", o).verb, "gh-issue-create");
    assert.equal(only("gh project mk -R stranger/r -b x", o).verb, "gh-issue-create");
  });

  it("with aliases UNKNOWN, a subcommand not on the group's read list is unresolved", () => {
    for (const o of [undefined, { ghAliases: null }, { ghAliases: () => null }, { ghAliases: () => { throw new Error("x"); } }] as Array<ParseEgressOptions | undefined>) {
      assert.equal(only("gh search ic -R stranger/r -b x", o).unresolved, "gh-alias");
      assert.equal(only("gh auth mine", o).unresolved, "gh-alias");
      assert.equal(only("gh org members", o).unresolved, "gh-alias");
      // …and the known subcommands are still plain reads.
      assert.deepEqual(all("gh search issues foo", o), []);
      assert.deepEqual(all("gh auth status", o), []);
      assert.deepEqual(all("gh org list", o), []);
      assert.deepEqual(all("gh browse", o), []);
    }
  });

  it("with aliases KNOWN, an unknown subcommand of a read group is an error in gh: no intent", () => {
    assert.deepEqual(all("gh search nothing-such", { ghAliases: new Map() }), []);
    assert.deepEqual(all("gh org members", { ghAliases: new Map() }), []);
  });

  it("the keyed lookup does not load the aliases for subcommands the parser already knows", () => {
    let loads = 0;
    const lazy: ParseEgressOptions = {
      ghAliases: () => {
        loads++;
        return aliases;
      },
    };
    for (const c of ["gh pr create -t x -b y", "gh pr view 5", "gh search issues x", "gh auth status", "gh issue comment 1 -b x", "gh project list"]) {
      all(c, lazy);
    }
    assert.equal(loads, 0);
  });
});

describe("the wrapper loop's guard", () => {
  it("a chain of 300 wrappers in front of gh is unresolved, not an empty list", () => {
    const chain = "env ".repeat(300);
    assert.equal(only(`${chain}gh issue create -R stranger/r -b x`).unresolved, "unparsed-shape");
    assert.equal(only(`${"nice ".repeat(300)}git push origin main`).unresolved, "unparsed-shape");
  });

  it("…while a long chain without gh or git push yields nothing, and a short one resolves", () => {
    assert.deepEqual(all(`${"env ".repeat(300)}ls`), []);
    assert.equal(only(`${"env ".repeat(20)}gh issue create -R stranger/r -b x`).repoFlag, "stranger/r");
  });
});

describe("accounting: one command, one intent; a command's own words are never a second intent", () => {
  it("a command the parser understood yields exactly one intent", () => {
    for (const c of ["gh issue create -R stranger/r -b x", "git push https://github.com/stranger/r main", "sudo gh pr merge 5", "gh api -X POST repos/a/b/issues -f x=y"]) {
      assert.equal(all(c).length, 1, c);
    }
  });

  it("flag values of gh and git are data", () => {
    assert.equal(all('gh pr create -t "x" -b "run git push and gh issue create later" -R acme/x').length, 1);
    assert.equal(all('gh issue create --body "see gh pr view" -R acme/x').length, 1);
    assert.deepEqual(all('git commit -m "git push gh issue create"'), []);
    assert.deepEqual(all('git tag -a v1 -m "gh release create"'), []);
  });

  it("two commands, two mentions: both are accounted for", () => {
    assert.equal(all("gh issue create -R a/b -b x && git push https://github.com/a/b main").length, 2);
  });

  it("a later gh mention among a recognised command's arguments is its argument, not a second command", () => {
    const intents = all("gh issue create -R acme/x -b x gh pr comment 5");
    assert.equal(intents.length, 1, JSON.stringify(intents));
    assert.equal(intents[0]!.verb, "gh-issue-create");
    assert.equal(intents[0]!.unresolved, undefined);
  });

  it("substitution text is parsed once, not also scanned", () => {
    assert.equal(all('echo "$(gh issue create -R stranger/r -b x)"').length, 1);
    assert.equal(all("echo `gh issue create -R stranger/r -b x`").length, 1);
  });

  it("a comment and a data heredoc are not mentions", () => {
    assert.deepEqual(all("ls # gh issue create -R stranger/r"), []);
    assert.deepEqual(all("cat <<EOF\ngh issue create\nEOF"), []);
  });

  it("words that merely contain gh or git are not mentions", () => {
    assert.deepEqual(all("echo ghost github git-lfs gh-pages"), []);
    assert.deepEqual(all("git push-notes"), []);
    assert.deepEqual(all("ls /usr/local/gh-extensions"), []);
  });
});

describe("the parser stays linear on adversarial text", () => {
  it("long repetitive inputs finish quickly", () => {
    const N = 200_000;
    const inputs = [
      "gh ".repeat(N / 3),
      "git ".repeat(N / 4) + "push",
      "echo " + "gh issue ".repeat(N / 9),
      "bash -c " + q("gh ".repeat(N / 3)),
      "a <(b ".repeat(N / 6),
      "f() { ".repeat(N / 6),
      "sh <<EOF\n" + "gh issue create\n".repeat(N / 16) + "EOF",
      "$(".repeat(N / 2) + "gh issue create",
      "if ".repeat(N / 3) + "gh issue create",
      "alias a=gh;".repeat(N / 11) + "a issue create",
      "python3 -c " + q("gh issue ".repeat(N / 9)),
    ];
    for (const input of inputs) {
      const t = performance.now();
      assert.doesNotThrow(() => parseEgressIntents(input, { ghAliases: new Map(), gitAliases: new Map() }));
      const ms = performance.now() - t;
      assert.ok(ms < 3000, `${ms.toFixed(0)}ms for ${JSON.stringify(input.slice(0, 40))}…`);
    }
  });
});
