// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// Prompt approvals (doc/design/egress-guard.md §4a.1): a person's yes at an agent's own permission prompt, recorded by
// the agent hook, honoured by the layers below it for one exact command for two minutes.
//
// Every test names the way the change could be wrong: a binding that is too wide, a mode that is not a person's, a
// record that outlives its two minutes, or one that an older binary or a terminal-approval matcher would read.
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PROMPT_APPROVALS_DIR,
  PROMPT_APPROVAL_TTL_MS,
  approvalScopeOf,
  approvalsPath,
  approvalSource,
  findAccountBoundApproval,
  findApproval,
  findApprovalWithAnyLogin,
  findLoginApproval,
  findPromptApproval,
  findUncoveringStarApproval,
  listAllApprovals,
  listPromptApprovals,
  mintApproval,
  promptApprovalsDir,
  promptBindingOf,
  recordPromptApproval,
  revokeAllPromptApprovals,
  revokeApprovals,
  listApprovals,
  type PromptBinding,
} from "./egress-approval.js";
import { parseEgressIntents, type EgressIntent } from "./egress-intent.js";

const T0 = new Date("2026-09-12T18:00:00.000Z");
const plus = (ms: number) => new Date(T0.getTime() + ms);

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "prompt-approval-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const dest = (org = "o", repo = "r") => ({ org, repo });
const intentOf = (command: string): EgressIntent => {
  const [i] = parseEgressIntents(command);
  assert.ok(i, `no intent for ${command}`);
  return i;
};
const noHead = () => null;
const bind = (b: Partial<PromptBinding> = {}): PromptBinding => ({ verb: "git-push", org: "o", repo: "r", ref: "main", ...b });

describe("promptBindingOf: the binding the hook computes", () => {
  it("git push binds the DESTINATION ref, not the source side", () => {
    const ref = (refspec: string, head: (d: string) => string | null = noHead) =>
      promptBindingOf({ verb: "git-push", refspec }, dest(), head)?.ref;
    assert.equal(ref("main"), "main");
    assert.equal(ref("HEAD:main"), "main"); // normaliseRef alone would give `HEAD`
    assert.equal(ref("+feat:refs/heads/rel"), "rel");
    assert.equal(ref("refs/tags/v1"), "v1");
    assert.equal(ref("HEAD", () => "feature-x"), "feature-x");
    assert.equal(ref("HEAD", () => "refs/heads/feature-x"), "feature-x");
  });

  it("git push is bound to nothing when the destination ref cannot be named", () => {
    const b = (refspec: string | undefined, head: (d: string) => string | null = noHead) =>
      promptBindingOf({ verb: "git-push", ...(refspec !== undefined && { refspec }) }, dest(), head);
    assert.equal(b("HEAD"), null, "HEAD with no resolver result");
    assert.equal(b("HEAD", () => null), null);
    assert.equal(b("HEAD", () => "bad$name"), null, "a resolved branch is checked too");
    assert.equal(b(":main"), null, "a delete");
    assert.equal(b("+:main"), null);
    assert.equal(b("refs/heads/*"), null);
    assert.equal(b("refs/heads/*:refs/heads/*"), null);
    assert.equal(b("$BR"), null);
    assert.equal(b("HEAD:$BR"), null);
    assert.equal(b("main:`x`"), null);
    assert.equal(b("a:b?"), null);
    assert.equal(b("a:b[0]"), null);
    assert.equal(b("a:b~1"), null);
    assert.equal(b("a:b^"), null);
    assert.equal(b("a:b@{1}"), null);
    assert.equal(b("a:b c"), null);
    assert.equal(b("<unparsed>"), null);
    assert.equal(b(undefined), null);
    assert.equal(b(""), null);
  });

  it("HEAD is resolved from the intent's own directory (git -C), else the cwd", () => {
    const seen: string[] = [];
    const head = (d: string) => (seen.push(d), "main");
    promptBindingOf({ verb: "git-push", refspec: "HEAD", cwdOverride: "/other" }, dest(), head, "/cwd");
    promptBindingOf({ verb: "git-push", refspec: "HEAD" }, dest(), head, "/cwd");
    assert.deepEqual(seen, ["/other", "/cwd"]);
  });

  it("a gh verb binds the verb and the destination, nothing else", () => {
    assert.deepEqual(promptBindingOf({ verb: "gh-pr-create" }, dest("Acme", "Svc"), noHead), {
      verb: "gh-pr-create",
      org: "acme",
      repo: "svc",
    });
  });

  it("gh api binds the endpoint, minus one leading slash; no endpoint binds nothing", () => {
    const api = (apiEndpoint: string, apiMethod = "POST") =>
      promptBindingOf({ verb: "gh-api-mutating", apiEndpoint, apiMethod }, dest(), noHead);
    assert.equal(api("/repos/o/r/issues")?.endpoint, "repos/o/r/issues");
    assert.equal(api("repos/o/r/issues")?.endpoint, "repos/o/r/issues");
    assert.equal(api("repos/o/r/issues", "PATCH")?.method, "PATCH");
    assert.equal(promptBindingOf({ verb: "gh-api-mutating" }, dest(), noHead), null);
    assert.equal(promptBindingOf({ verb: "gh-api-mutating", apiEndpoint: "/", apiMethod: "POST" }, dest(), noHead), null);
    assert.equal(
      promptBindingOf({ verb: "gh-api-mutating", apiEndpoint: "repos/o/r/issues" }, dest(), noHead),
      null,
      "a gh api binding with no method binds nothing",
    );
    assert.equal(api("repos/o/r/issues", "GET"), null, "a method that is not a mutation is never bound");
  });

  it("nothing is bound for an unresolved or wildcard destination, an unresolved intent, or a verb without a repository", () => {
    const ok = { verb: "gh-pr-create" } as const;
    assert.ok(promptBindingOf(ok, dest(), noHead), "control: the plain case binds");
    assert.equal(promptBindingOf(ok, null, noHead), null);
    assert.equal(promptBindingOf(ok, undefined, noHead), null);
    for (const unresolved of ["graphql-mutation", "opaque-url", "self", "ambiguous-target"] as const) {
      assert.equal(promptBindingOf(ok, { ...dest("*", "*"), unresolved }, noHead), null, unresolved);
      // even a destination that names a repo: `unresolved` alone is enough
      assert.equal(promptBindingOf(ok, { ...dest(), unresolved }, noHead), null, `${unresolved} with a name`);
    }
    assert.equal(promptBindingOf(ok, { ...dest(), candidates: [dest("a", "b"), dest("c", "d")] }, noHead), null);
    assert.equal(promptBindingOf(ok, dest("*", "r"), noHead), null);
    assert.equal(promptBindingOf(ok, dest("o", "*"), noHead), null, "an org-level destination");
    assert.equal(promptBindingOf(ok, dest("bad_org", "r"), noHead), null);
    assert.equal(promptBindingOf(ok, dest("o", "r r"), noHead), null);
    assert.equal(promptBindingOf({ ...ok, unresolved: "gh-alias" }, dest(), noHead), null);
    for (const verb of ["gh-gist-create", "gh-alias-shell", "gh-unknown", "npm-publish"] as const) {
      assert.equal(promptBindingOf({ verb }, dest(), noHead), null, verb);
    }
  });

  it("the parsed commands bind as the shim will re-derive them", () => {
    assert.deepEqual(promptBindingOf(intentOf("git push origin HEAD:main"), dest(), noHead), bind());
    assert.equal(promptBindingOf(intentOf("gh pr create --repo o/r"), dest(), noHead)?.verb, "gh-pr-create");
    assert.equal(promptBindingOf(intentOf("gh release create v1 --repo o/r"), dest(), noHead)?.verb, "gh-release-create");
  });
});

describe("recordPromptApproval: the permission-mode allowlist (F9)", () => {
  it("default and acceptEdits write", () => {
    for (const mode of ["default", "acceptEdits"]) {
      const a = recordPromptApproval({ binding: bind(), permissionMode: mode, home, now: T0 });
      assert.ok(a, mode);
      assert.equal(a.permissionMode, mode);
    }
  });

  it("any other mode writes nothing, and does not even create the directory", () => {
    for (const mode of ["auto", "bypassPermissions", "plan", "dontAsk", "", "Default", "default ", "ACCEPTEDITS", undefined]) {
      const h = mkdtempSync(join(tmpdir(), "prompt-approval-mode-"));
      try {
        assert.equal(recordPromptApproval({ binding: bind(), permissionMode: mode, home: h, now: T0 }), null, String(mode));
        assert.equal(existsSync(join(h, PROMPT_APPROVALS_DIR)), false, `${String(mode)}: no directory`);
      } finally {
        rmSync(h, { recursive: true, force: true });
      }
    }
  });

  it("an invalid binding writes nothing", () => {
    const invalid: PromptBinding[] = [
      bind({ org: "*" }),
      bind({ repo: "*" }),
      bind({ org: "Bad Org" }),
      bind({ org: "O" }), // not lower-case: the hook lower-cases before it gets here
      { verb: "git-push", org: "o", repo: "r" } as PromptBinding, // no ref
      bind({ ref: "" }),
      bind({ ref: "a b" }),
      { verb: "gh-api-mutating", org: "o", repo: "r" } as PromptBinding, // no endpoint
      { verb: "gh-api-mutating", org: "o", repo: "r", endpoint: "repos/o/r/issues" } as PromptBinding, // no method
      { verb: "gh-api-mutating", org: "o", repo: "r", endpoint: "repos/o/r/issues", method: "GET" }, // not a mutation
      { verb: "gh-api-mutating", org: "o", repo: "r", endpoint: "repos/o/r/issues", method: "patch" }, // not upper-case
      { verb: "git-push", org: "o", repo: "r", ref: "main", method: "POST" } as PromptBinding, // a method on a push
      { verb: "gh-pr-create", org: "o", repo: "r", target: "12" }, // a target on a verb that takes none
      { verb: "gh-pr-merge", org: "o", repo: "r", target: "a b" }, // not plain text
      { verb: "gh-pr-create", org: "o", repo: "r", ref: "main" } as PromptBinding, // a ref on a verb that has none
      { verb: "gh-gist-create", org: "o", repo: "r" } as unknown as PromptBinding,
      { verb: "npm-publish", org: "o", repo: "r" } as unknown as PromptBinding,
    ];
    for (const b of invalid) {
      assert.equal(recordPromptApproval({ binding: b, permissionMode: "default", home, now: T0 }), null, JSON.stringify(b));
    }
    assert.equal(existsSync(join(home, PROMPT_APPROVALS_DIR)), false);
  });
});

describe("recordPromptApproval: the record on disk", () => {
  it("is private, short-lived and has a prompt-only id", () => {
    const a = recordPromptApproval({ binding: bind(), permissionMode: "default", session: "sess-1", home, now: T0 })!;
    assert.match(a.id, /^p[0-9a-f]{8}$/);
    assert.equal(approvalSource(a), "prompt");
    assert.equal(Date.parse(a.expiresAt) - Date.parse(a.createdAt), 120_000);
    assert.equal(PROMPT_APPROVAL_TTL_MS, 120_000);
    assert.equal(a.session, "sess-1");
    const dir = promptApprovalsDir(home);
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    const file = join(dir, `${a.id}.json`);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), a);
    assert.deepEqual(readdirSync(dir), [`${a.id}.json`], "no temp file left behind");
  });

  it("a session id that is not plain is not recorded", () => {
    const a = recordPromptApproval({ binding: bind(), permissionMode: "default", session: "a b;c", home, now: T0 })!;
    assert.equal(a.session, undefined);
  });

  it("two writes in a row both survive (one file each: no lost update)", () => {
    const a = recordPromptApproval({ binding: bind(), permissionMode: "default", home, now: T0 })!;
    const b = recordPromptApproval({ binding: bind({ ref: "other" }), permissionMode: "default", home, now: T0 })!;
    assert.notEqual(a.id, b.id);
    assert.deepEqual(
      listPromptApprovals(home, T0).map(x => x.id).sort(),
      [a.id, b.id].sort(),
    );
  });

  it("expired files are pruned by the next write, and never by a read", () => {
    const old = recordPromptApproval({ binding: bind(), permissionMode: "default", home, now: T0 })!;
    const dir = promptApprovalsDir(home);
    assert.deepEqual(listPromptApprovals(home, plus(PROMPT_APPROVAL_TTL_MS + 1)), []);
    assert.ok(existsSync(join(dir, `${old.id}.json`)), "a read must not delete (lower layers may be read-only)");
    const fresh = recordPromptApproval({
      binding: bind({ ref: "next" }),
      permissionMode: "default",
      home,
      now: plus(PROMPT_APPROVAL_TTL_MS + 1),
    })!;
    assert.equal(existsSync(join(dir, `${old.id}.json`)), false);
    assert.ok(existsSync(join(dir, `${fresh.id}.json`)));
  });

  it("never throws when the home cannot be written: null", () => {
    const blocker = join(home, "file");
    writeFileSync(blocker, "x");
    // `file/prompt-approvals` cannot be created under a regular file
    assert.equal(recordPromptApproval({ binding: bind(), permissionMode: "default", home: blocker, now: T0 }), null);
  });
});

describe("findPromptApproval: exact match, no wildcard", () => {
  const write = (b: PromptBinding) => recordPromptApproval({ binding: b, permissionMode: "default", home, now: T0 })!;

  it("the same binding matches, org and repo case-insensitively", () => {
    const a = write(bind());
    assert.equal(findPromptApproval(bind(), home, T0)?.id, a.id);
    assert.equal(findPromptApproval(bind({ org: "O", repo: "R" }), home, T0)?.id, a.id);
  });

  it("another repo, org, ref, or a push with no ref matches nothing", () => {
    write(bind());
    assert.equal(findPromptApproval(bind({ repo: "other" }), home, T0), null);
    assert.equal(findPromptApproval(bind({ org: "other" }), home, T0), null);
    assert.equal(findPromptApproval(bind({ ref: "other" }), home, T0), null);
    assert.equal(findPromptApproval(bind({ ref: "main2" }), home, T0), null);
    assert.equal(findPromptApproval({ verb: "git-push", org: "o", repo: "r" } as PromptBinding, home, T0), null);
    assert.equal(findPromptApproval(bind({ ref: "" }), home, T0), null);
    assert.equal(findPromptApproval(bind({ org: "*" }), home, T0), null);
    assert.equal(findPromptApproval(bind({ repo: "*" }), home, T0), null);
  });

  it("the verb is exact, in both directions (F1b)", () => {
    write({ verb: "gh-pr-create", org: "o", repo: "r" });
    assert.equal(findPromptApproval(bind(), home, T0), null, "a gh-pr-create record never lets a push through");
    assert.equal(findPromptApproval({ verb: "gh-release-create", org: "o", repo: "r" }, home, T0), null);
    assert.equal(findPromptApproval({ verb: "gh-issue-comment", org: "o", repo: "r" }, home, T0), null);
    assert.ok(findPromptApproval({ verb: "gh-pr-create", org: "o", repo: "r" }, home, T0));

    const h2 = mkdtempSync(join(tmpdir(), "prompt-approval-b-"));
    try {
      recordPromptApproval({ binding: bind(), permissionMode: "default", home: h2, now: T0 });
      assert.equal(findPromptApproval({ verb: "gh-pr-create", org: "o", repo: "r" }, h2, T0), null, "a push record never covers a PR");
    } finally {
      rmSync(h2, { recursive: true, force: true });
    }
  });

  it("the endpoint is exact", () => {
    const api = (endpoint: string, method = "PATCH"): PromptBinding => ({ verb: "gh-api-mutating", org: "o", repo: "r", endpoint, method });
    write(api("repos/o/r/issues/1"));
    assert.ok(findPromptApproval(api("repos/o/r/issues/1"), home, T0));
    assert.equal(findPromptApproval(api("repos/o/r/pulls"), home, T0), null);
    assert.equal(findPromptApproval(api("repos/o/r/issues/1/comments"), home, T0), null);
    assert.equal(findPromptApproval({ verb: "gh-api-mutating", org: "o", repo: "r" } as PromptBinding, home, T0), null);
  });

  it("the HTTP method is exact: a PATCH approval does not cover a DELETE of the same endpoint (and the reverse)", () => {
    const api = (method: string): PromptBinding => ({ verb: "gh-api-mutating", org: "o", repo: "r", endpoint: "repos/o/r/issues/1", method });
    write(api("PATCH"));
    assert.ok(findPromptApproval(api("PATCH"), home, T0));
    assert.equal(findPromptApproval(api("DELETE"), home, T0), null);
    assert.equal(findPromptApproval(api("POST"), home, T0), null);
    assert.equal(findPromptApproval(api("PUT"), home, T0), null);
    assert.equal(findPromptApproval({ ...api("PATCH"), method: undefined } as unknown as PromptBinding, home, T0), null);
  });

  it("the PR, issue or release target is exact, in both directions", () => {
    const merge = (target?: string): PromptBinding => ({ verb: "gh-pr-merge", org: "o", repo: "r", ...(target !== undefined && { target }) });
    write(merge("12"));
    assert.ok(findPromptApproval(merge("12"), home, T0));
    assert.equal(findPromptApproval(merge("13"), home, T0), null, "another PR");
    assert.equal(findPromptApproval(merge("120"), home, T0), null, "a longer number");
    assert.equal(findPromptApproval(merge(), home, T0), null, "a record that names a PR does not cover a command that names none");
    const h2 = mkdtempSync(join(tmpdir(), "prompt-approval-t-"));
    try {
      recordPromptApproval({ binding: merge(), permissionMode: "default", home: h2, now: T0 });
      assert.ok(findPromptApproval(merge(), h2, T0), "bare binds the repo only, as before");
      assert.equal(findPromptApproval(merge("12"), h2, T0), null, "a record that names none does not cover a named PR");
    } finally {
      rmSync(h2, { recursive: true, force: true });
    }
    const release = (target: string): PromptBinding => ({ verb: "gh-release-edit", org: "o", repo: "r", target });
    write(release("v1.0.0"));
    assert.ok(findPromptApproval(release("v1.0.0"), home, T0));
    assert.equal(findPromptApproval(release("v1.0.1"), home, T0), null);
  });

  it("at expiresAt it is gone (exp > now, not >=)", () => {
    const a = write(bind());
    assert.ok(findPromptApproval(bind(), home, new Date(Date.parse(a.expiresAt) - 1)));
    assert.equal(findPromptApproval(bind(), home, new Date(a.expiresAt)), null);
  });

  it("an absent directory is no approval, not an error", () => {
    assert.equal(findPromptApproval(bind(), join(home, "nowhere"), T0), null);
    assert.deepEqual(listPromptApprovals(join(home, "nowhere"), T0), []);
  });
});

describe("malformed prompt files are ignored", () => {
  const good = () => {
    const a = recordPromptApproval({ binding: bind(), permissionMode: "default", home, now: T0 })!;
    return a;
  };
  const plant = (name: string, body: unknown): void => {
    mkdirSync(promptApprovalsDir(home), { recursive: true });
    writeFileSync(join(promptApprovalsDir(home), name), typeof body === "string" ? body : JSON.stringify(body));
  };
  const live = () => listPromptApprovals(home, T0).length;

  it("each way a hand-made or edited file can be wrong", () => {
    const a = good();
    const base = { ...a };
    const { id: _id, ...rest } = base;
    void _id;
    assert.equal(live(), 1, "control: the good one is live");
    const cases: Array<[string, Record<string, unknown>, string?]> = [
      ["ttl longer than 120 s", { ...base, id: "paaaaaaaa", expiresAt: new Date(T0.getTime() + 121_000).toISOString() }],
      ["a day", { ...base, id: "pbbbbbbbb", expiresAt: new Date(T0.getTime() + 86_400_000).toISOString() }],
      ["terminal-style id", { ...rest, id: "0a1b2c3d" }, "0a1b2c3d.json"],
      ["no source", { ...rest, id: "pcccccccc", source: undefined }],
      ["wrong source", { ...rest, id: "pdddddddd", source: "terminal" }],
      ["unknown verb", { ...rest, id: "peeeeeeee", verb: "gh-everything" }],
      ["npm-publish verb", { ...rest, id: "pffffffff", verb: "npm-publish" }],
      ["org *", { ...rest, id: "p00000001", org: "*" }],
      ["repo *", { ...rest, id: "p00000002", repo: "*" }],
      ["upper-case org", { ...rest, id: "p00000003", org: "O" }],
      ["git-push without ref", { ...rest, id: "p00000004", ref: undefined }],
      ["a ref on a gh verb", { ...rest, id: "p00000005", verb: "gh-pr-create" }],
      ["gh-api without endpoint", { ...rest, id: "p00000006", verb: "gh-api-mutating", ref: undefined }],
      ["gh-api with an endpoint but no method", { ...rest, id: "p0000000c", verb: "gh-api-mutating", ref: undefined, endpoint: "repos/o/r/x" }],
      ["gh-api with a GET method", { ...rest, id: "p0000000d", verb: "gh-api-mutating", ref: undefined, endpoint: "repos/o/r/x", method: "GET" }],
      ["a target on a verb that takes none", { ...rest, id: "p0000000e", verb: "gh-pr-create", ref: undefined, target: "12" }],
      ["created 6 s in the future", { ...rest, id: "p0000000f", createdAt: new Date(T0.getTime() + 6000).toISOString(), expiresAt: new Date(T0.getTime() + 6000 + 120_000).toISOString() }],
      ["mode outside the allowlist", { ...rest, id: "p00000007", permissionMode: "auto" }],
      ["mode bypassPermissions", { ...rest, id: "p00000008", permissionMode: "bypassPermissions" }],
      ["no mode", { ...rest, id: "p00000009", permissionMode: undefined }],
      ["bad timestamps", { ...rest, id: "p0000000a", createdAt: "yesterday" }],
      ["a ref with control characters", { ...rest, id: "p0000000b", ref: "main‮evil" }],
    ];
    for (const [label, body, file] of cases) {
      plant(file ?? `${body["id"] as string}.json`, body);
      assert.equal(live(), 1, `${label} must be ignored`);
    }
  });

  it("a file whose name is not its id is ignored (a record copied under another name)", () => {
    const a = good();
    plant("p12345678.json", { ...a }); // body id differs from the file name
    assert.equal(live(), 1);
  });

  it("a file over 4 KiB, a non-JSON file and a directory are ignored", () => {
    const a = good();
    plant("p00000020.json", JSON.stringify({ ...a, id: "p00000020", pad: "x".repeat(5000) }));
    plant("p00000021.json", "not json");
    mkdirSync(join(promptApprovalsDir(home), "p00000022.json"));
    assert.equal(live(), 1);
  });
});

describe("a prompt record is invisible to every terminal matcher, and leaves the terminal store untouched (F1, version skew)", () => {
  it("with only a prompt record present, no terminal finder returns anything", () => {
    for (const verbBinding of [bind(), bind({ ref: "main" })]) {
      recordPromptApproval({ binding: verbBinding, permissionMode: "default", home, now: T0 });
    }
    recordPromptApproval({ binding: { verb: "gh-pr-create", org: "o", repo: "r" }, permissionMode: "default", home, now: T0 });
    const path = approvalsPath(home);
    const scope = approvalScopeOf({ personalOrgs: ["o"] });
    assert.equal(existsSync(path), false);
    assert.equal(findApproval(dest(), "main", scope, path, T0), null);
    assert.equal(findApproval(dest(), undefined, scope, path, T0), null);
    assert.equal(findLoginApproval(dest(), "someone", path, T0), null);
    assert.equal(findAccountBoundApproval(dest(), "someone", path, T0), null);
    assert.equal(findApprovalWithAnyLogin(dest(), path, T0), null);
    assert.equal(findUncoveringStarApproval(dest(), "main", scope, path, T0), null);
  });

  it("the same holds when a terminal store exists and holds something else", () => {
    mintApproval({ target: { org: "elsewhere", repo: "x" }, path: approvalsPath(home), now: T0 });
    recordPromptApproval({ binding: bind(), permissionMode: "default", home, now: T0 });
    assert.equal(findApproval(dest(), "main", approvalScopeOf({}), approvalsPath(home), T0), null);
  });

  it("egress-approvals.json is byte-identical before and after a prompt record", () => {
    mintApproval({ target: { org: "o", repo: "r" }, path: approvalsPath(home), now: T0 });
    const before = readFileSync(approvalsPath(home));
    recordPromptApproval({ binding: bind(), permissionMode: "default", home, now: T0 });
    recordPromptApproval({ binding: bind({ ref: "two" }), permissionMode: "acceptEdits", home, now: T0 });
    assert.deepEqual(readFileSync(approvalsPath(home)), before);
  });

  it("a terminal approval's id can never look like a prompt id (so revoke and the audit cannot confuse them)", () => {
    for (let i = 0; i < 50; i++) {
      const a = mintApproval({ target: { org: "o", repo: `r${i}` }, path: approvalsPath(home), now: T0 });
      assert.equal(approvalSource(a), "terminal");
      assert.doesNotMatch(a.id, /^p/);
    }
  });
});

describe("revokeApprovals and listAllApprovals cover both stores", () => {
  it("--revoke p… removes only that file; a terminal id leaves prompt files alone", () => {
    const path = approvalsPath(home);
    const t = mintApproval({ target: { org: "o", repo: "r" }, path, now: T0 });
    const p1 = recordPromptApproval({ binding: bind(), permissionMode: "default", home, now: T0 })!;
    const p2 = recordPromptApproval({ binding: bind({ ref: "two" }), permissionMode: "default", home, now: T0 })!;
    assert.deepEqual(revokeApprovals(p1.id, path), [p1.id]);
    assert.deepEqual(listPromptApprovals(home, T0).map(a => a.id), [p2.id]);
    assert.deepEqual(revokeApprovals(t.id, path), [t.id]);
    assert.deepEqual(listPromptApprovals(home, T0).map(a => a.id), [p2.id], "revoking a terminal id keeps the prompt record");
    assert.deepEqual(revokeApprovals("p00000000", path), [], "an unknown prompt id removes nothing");
    assert.deepEqual(revokeApprovals("../../etc/passwd", path), [], "a path-shaped id is never a file name");
  });

  it("`all` clears both stores", () => {
    const path = approvalsPath(home);
    const t = mintApproval({ target: { org: "o", repo: "r" }, path, now: T0 });
    const p = recordPromptApproval({ binding: bind(), permissionMode: "default", home, now: T0 })!;
    assert.deepEqual(revokeApprovals("all", path).sort(), [t.id, p.id].sort());
    assert.deepEqual(listAllApprovals(path, T0), []);
  });

  it("listAllApprovals tags the source of each entry, newest first", () => {
    const path = approvalsPath(home);
    const t = mintApproval({ target: { org: "o", repo: "r" }, path, now: T0 });
    const p = recordPromptApproval({ binding: bind(), permissionMode: "default", home, now: plus(1000) })!;
    const all = listAllApprovals(path, plus(2000));
    assert.deepEqual(
      all.map(a => [a.id, a.source]),
      [
        [p.id, "prompt"],
        [t.id, "terminal"],
      ],
    );
  });
});

describe("a record dated ahead of the reader's clock is not honoured", () => {
  it("5 s of skew is tolerated, 6 s is not (a hand-made file meant to outlive its two minutes)", () => {
    const a = recordPromptApproval({ binding: bind(), permissionMode: "default", home, now: T0 })!;
    const file = join(promptApprovalsDir(home), `${a.id}.json`);
    const dated = (ahead: number) => {
      const created = new Date(T0.getTime() + ahead);
      writeFileSync(file, JSON.stringify({ ...a, createdAt: created.toISOString(), expiresAt: new Date(created.getTime() + 120_000).toISOString() }));
    };
    dated(4000);
    assert.equal(listPromptApprovals(home, T0).length, 1);
    dated(6000);
    assert.equal(listPromptApprovals(home, T0).length, 0);
    assert.equal(findPromptApproval(bind(), home, T0), null);
    // ...and it is honoured once the clock has caught up with it.
    assert.equal(listPromptApprovals(home, plus(2000)).length, 1);
  });
});

describe("what the parser hands the binding: git push --delete, the gh api method, the PR or tag", () => {
  const bound = (command: string, head: (d: string) => string | null = () => "main") =>
    promptBindingOf(intentOf(command), dest(), head);

  it("git push --delete / -d binds nothing, however it is spelled (like the :ref form)", () => {
    assert.equal(bound("git push origin :main"), null);
    for (const flags of ["--delete", "-d", "-fd", "--dele", "--de", "--delete --force"]) {
      assert.equal(bound(`git push ${flags} origin main`), null, `git push ${flags} origin main`);
      assert.equal(bound(`git push origin ${flags} main`), null, `git push origin ${flags} main`);
    }
    assert.equal(bound("git push origin --delete refs/heads/feat"), null);
    assert.equal(bound("git push origin -d main"), null);
    // the control: the same push without the flag binds
    assert.equal(bound("git push origin main")?.ref, "main");
    assert.equal(bound("git push --force-with-lease origin main")?.ref, "main");
    assert.equal(bound("git push --dry-run origin main")?.ref, "main", "--dry-run is not --delete");
  });

  it("gh api carries its method: -X, --method, and gh's POST default for fields", () => {
    const m = (command: string) => bound(command)?.method;
    assert.equal(m("gh api -X PATCH repos/o/r/issues/1 -f title=x"), "PATCH");
    assert.equal(m("gh api --method DELETE repos/o/r/issues/1/labels/bug"), "DELETE");
    assert.equal(m("gh api --method=put repos/o/r/topics -f x=y"), "PUT");
    assert.equal(m("gh api repos/o/r/issues -f title=x"), "POST");
    assert.equal(m("gh api repos/o/r/issues --input body.json"), "POST");
    assert.equal(parseEgressIntents("gh api repos/o/r/issues").length, 0, "a read is not an intent at all");
  });

  it("gh pr|issue <sub> <n> and release <sub> <tag> bind the number or tag; create verbs and bare commands bind the repo only", () => {
    const t = (command: string) => bound(command)?.target;
    assert.equal(t("gh pr merge 12 --repo o/r"), "12");
    assert.equal(t("gh pr merge --repo o/r 12 --squash"), "12");
    assert.equal(t("gh pr comment 7 --repo o/r --body x"), "7");
    assert.equal(t("gh pr edit 7 --repo o/r --title x"), "7");
    assert.equal(t("gh pr review 7 --repo o/r --approve"), "7");
    assert.equal(t("gh issue comment 5 --repo o/r --body x"), "5");
    assert.equal(t("gh issue edit 5 --repo o/r --title x"), "5");
    assert.equal(t("gh pr merge https://github.com/o/r/pull/9"), "https://github.com/o/r/pull/9");
    assert.equal(t("gh release create v1.2.3 --repo o/r"), "v1.2.3");
    assert.equal(t("gh release edit v1.2.3 --repo o/r --notes x"), "v1.2.3");
    assert.equal(t("gh release upload v1.2.3 dist.tgz --repo o/r"), "v1.2.3");
    // no target
    assert.equal(bound("gh pr create --repo o/r --title t")?.verb, "gh-pr-create");
    assert.equal(t("gh pr create --repo o/r --title t"), undefined);
    assert.equal(t("gh issue create --repo o/r --title t"), undefined);
    assert.equal(t("gh pr merge --repo o/r"), undefined, "a bare merge (the current branch) binds the repository only");
    assert.equal(t("gh repo edit o/r --description x"), undefined);
    // an expansion in the target is unresolved: nothing is bound
    assert.equal(bound("gh pr merge $PR --repo o/r"), null);
  });
});

describe("revoking prompt approvals only", () => {
  it('revokeApprovals("prompt") removes every prompt approval and leaves the terminal store byte-identical', () => {
    const path = approvalsPath(home);
    mintApproval({ target: { org: "o", repo: "r" }, path, now: T0 });
    const before = readFileSync(path);
    recordPromptApproval({ binding: bind(), permissionMode: "default", home, now: T0 });
    recordPromptApproval({ binding: bind({ ref: "two" }), permissionMode: "default", home, now: T0 });
    const removed = revokeApprovals("prompt", path);
    assert.equal(removed.length, 2);
    assert.ok(removed.every(id => /^p[0-9a-f]{8}$/.test(id)));
    assert.deepEqual(listPromptApprovals(home, T0), []);
    assert.deepEqual(readFileSync(path), before, "terminal approvals untouched");
    assert.equal(listApprovals(path, T0).length, 1);
  });

  it("revokeAllPromptApprovals never throws, with no directory or a file in its place", () => {
    assert.deepEqual(revokeAllPromptApprovals(join(home, "nowhere")), []);
    writeFileSync(join(home, "prompt-approvals"), "in the way");
    assert.deepEqual(revokeAllPromptApprovals(home), []);
  });
});
