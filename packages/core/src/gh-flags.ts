// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// Which flags of each `gh` write command take a value, for the egress-intent parser
// (issue #151, §3.3.7-8). Data only.
//
// SOURCE: the pages https://cli.github.com/manual/gh_<group>_<sub> of the official
// GitHub CLI manual, read on 2026-11-02. The manual shows no version number; it is the
// current manual of the gh 2.10x series. A flag that takes a value has a <placeholder>
// in its usage line; a flag without one is a boolean. The same letter can be a boolean
// in one command and a value in another (`pr review -r` is --request-changes, `pr create
// -r` is --reviewer, `repo create -p` is --template), which is why this is a per-command
// table and not a global set.
//
// `-R/--repo` is added to every command by the parser, whether or not the manual lists it
// (`repo edit` and friends take the repository positionally): a repository flag that gh
// rejects does no harm, and one that gh accepts must never be missed.
//
// To refresh: re-read the pages and regenerate; `egress-intent-gh.test.ts` pins the
// entries that matter (review/run/repo/fork/create).

export interface GhCommandFlags {
  /** Long flags (with `--`) that take a value. */
  value: readonly string[];
  /** Short flag letters that take a value. */
  valueShort: string;
  /** Short flag letters that are booleans. */
  boolShort: string;
}

export const GH_COMMAND_FLAGS: Readonly<Record<string, GhCommandFlags>> = {
  "api": { value: ["--cache", "--field", "--header", "--hostname", "--input", "--jq", "--method", "--preview", "--raw-field", "--template"], valueShort: "FHXfpqt", boolShort: "i" },
  "gist create": { value: ["--desc", "--filename"], valueShort: "df", boolShort: "pw" },
  "gist edit": { value: ["--add", "--desc", "--filename", "--remove"], valueShort: "adfr", boolShort: "" },
  "issue close": { value: ["--comment", "--duplicate-of", "--reason", "--repo"], valueShort: "Rcr", boolShort: "" },
  "issue comment": { value: ["--attach", "--body", "--body-file", "--repo"], valueShort: "FRb", boolShort: "ew" },
  "issue create": { value: ["--assignee", "--attach", "--blocked-by", "--blocking", "--body", "--body-file", "--label", "--milestone", "--parent", "--project", "--recover", "--repo", "--template", "--title", "--type"], valueShort: "FRTablmpt", boolShort: "ew" },
  "issue delete": { value: ["--repo"], valueShort: "R", boolShort: "" },
  "issue develop": { value: ["--base", "--branch-repo", "--name", "--repo", "--worktree"], valueShort: "Rbn", boolShort: "cl" },
  "issue edit": { value: ["--add-assignee", "--add-blocked-by", "--add-blocking", "--add-label", "--add-project", "--add-sub-issue", "--attach", "--body", "--body-file", "--milestone", "--parent", "--remove-assignee", "--remove-blocked-by", "--remove-blocking", "--remove-label", "--remove-project", "--remove-sub-issue", "--repo", "--title", "--type"], valueShort: "FRbmt", boolShort: "" },
  "issue lock": { value: ["--reason", "--repo"], valueShort: "Rr", boolShort: "" },
  "issue pin": { value: ["--repo"], valueShort: "R", boolShort: "" },
  "issue reopen": { value: ["--comment", "--repo"], valueShort: "Rc", boolShort: "" },
  "issue transfer": { value: ["--repo"], valueShort: "R", boolShort: "" },
  "issue unlock": { value: ["--repo"], valueShort: "R", boolShort: "" },
  "issue unpin": { value: ["--repo"], valueShort: "R", boolShort: "" },
  "label clone": { value: ["--repo"], valueShort: "R", boolShort: "f" },
  "label create": { value: ["--color", "--description", "--repo"], valueShort: "Rcd", boolShort: "f" },
  "label delete": { value: ["--repo"], valueShort: "R", boolShort: "" },
  "label edit": { value: ["--color", "--description", "--name", "--repo"], valueShort: "Rcdn", boolShort: "" },
  "pr close": { value: ["--comment", "--repo"], valueShort: "Rc", boolShort: "d" },
  "pr comment": { value: ["--attach", "--body", "--body-file", "--repo"], valueShort: "FRb", boolShort: "ew" },
  "pr create": { value: ["--assignee", "--attach", "--base", "--body", "--body-file", "--head", "--label", "--milestone", "--project", "--recover", "--repo", "--reviewer", "--template", "--title"], valueShort: "BFHRTablmprt", boolShort: "defw" },
  "pr edit": { value: ["--add-assignee", "--add-label", "--add-project", "--add-reviewer", "--attach", "--base", "--body", "--body-file", "--milestone", "--remove-assignee", "--remove-label", "--remove-project", "--remove-reviewer", "--repo", "--title"], valueShort: "BFRbmt", boolShort: "" },
  "pr lock": { value: ["--reason", "--repo"], valueShort: "Rr", boolShort: "" },
  "pr merge": { value: ["--author-email", "--body", "--body-file", "--match-head-commit", "--repo", "--subject"], valueShort: "AFRbt", boolShort: "dmrs" },
  "pr ready": { value: ["--repo"], valueShort: "R", boolShort: "" },
  "pr reopen": { value: ["--comment", "--repo"], valueShort: "Rc", boolShort: "" },
  "pr review": { value: ["--body", "--body-file", "--repo"], valueShort: "FRb", boolShort: "acr" },
  "pr unlock": { value: ["--repo"], valueShort: "R", boolShort: "" },
  "pr update-branch": { value: ["--repo"], valueShort: "R", boolShort: "" },
  "release create": { value: ["--discussion-category", "--notes", "--notes-file", "--notes-start-tag", "--repo", "--target", "--title"], valueShort: "FRnt", boolShort: "dp" },
  "release delete": { value: ["--repo"], valueShort: "R", boolShort: "y" },
  "release delete-asset": { value: ["--repo"], valueShort: "R", boolShort: "y" },
  "release edit": { value: ["--discussion-category", "--notes", "--notes-file", "--repo", "--tag", "--target", "--title"], valueShort: "FRnt", boolShort: "" },
  "release upload": { value: ["--repo"], valueShort: "R", boolShort: "" },
  "repo archive": { value: [], valueShort: "", boolShort: "y" },
  "repo create": { value: ["--description", "--gitignore", "--homepage", "--license", "--remote", "--source", "--team", "--template"], valueShort: "dghlprst", boolShort: "c" },
  "repo delete": { value: [], valueShort: "", boolShort: "" },
  "repo deploy-key": { value: ["--repo"], valueShort: "R", boolShort: "" },
  "repo edit": { value: ["--add-topic", "--default-branch", "--description", "--homepage", "--remove-topic", "--squash-merge-commit-message", "--visibility"], valueShort: "dh", boolShort: "" },
  "repo fork": { value: ["--fork-name", "--org", "--remote-name"], valueShort: "", boolShort: "" },
  "repo rename": { value: ["--repo"], valueShort: "R", boolShort: "y" },
  "repo sync": { value: ["--branch", "--source"], valueShort: "bs", boolShort: "" },
  "repo unarchive": { value: [], valueShort: "", boolShort: "y" },
  "ruleset check": { value: ["--repo"], valueShort: "R", boolShort: "w" },
  "run cancel": { value: ["--repo"], valueShort: "R", boolShort: "" },
  "run rerun": { value: ["--job", "--repo"], valueShort: "Rj", boolShort: "d" },
  "secret delete": { value: ["--app", "--env", "--org", "--repo"], valueShort: "Raeo", boolShort: "u" },
  "secret set": { value: ["--app", "--body", "--env", "--env-file", "--org", "--repo", "--repos", "--visibility"], valueShort: "Rabeforv", boolShort: "u" },
  "variable delete": { value: ["--env", "--org", "--repo"], valueShort: "Reo", boolShort: "" },
  "variable set": { value: ["--body", "--env", "--env-file", "--org", "--repo", "--repos", "--visibility"], valueShort: "Rbeforv", boolShort: "" },
  "workflow disable": { value: ["--repo"], valueShort: "R", boolShort: "" },
  "workflow enable": { value: ["--repo"], valueShort: "R", boolShort: "" },
  "workflow run": { value: ["--field", "--raw-field", "--ref", "--repo"], valueShort: "FRfr", boolShort: "" },
};
