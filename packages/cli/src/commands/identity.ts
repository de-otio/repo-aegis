// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// Registry identities (schemaVersion 3; doc/plan-owner-identity.md §5.1):
//
//   repo-aegis identity add <name> --gh-login <login> | --app <slug>
//   repo-aegis identity remove <name>            (refused while referenced)
//   repo-aegis identity require --off
//   repo-aegis engagements set-identity <id> [--person <name>] [--agent <name>] [--clear]
//   repo-aegis engagements set-identity --personal-org <org> [...same options]
//
// Every one is TTY-gated like `engagements add --personal-org` and is on the
// agent hook's human-only list. Nothing here chooses or injects a token: this
// phase only records which identity belongs to which owner.
//
// The registry is written as schemaVersion 3 only when the first identity or
// mapping is set (never lowered afterwards). The first `set-identity` also sets
// `requireIdentity: true`, unless the key is already present (a person who ran
// `identity require --off` keeps the choice).
import { YAMLMap, YAMLSeq, Scalar, isMap, isSeq } from "yaml";
import {
  registryPath as defaultRegistryPath,
  loadRegistry,
  renderMarkers,
  appendAuditRecord,
  ORG_NAME_REGEX,
  IDENTITY_NAME_REGEX,
  GH_LOGIN_REGEX,
  REGISTRY_IDENTITIES_MIN_VERSION,
} from "@de-otio/repo-aegis-core";
import { emitJson, emitText, emitError, type OutputOptions } from "../format.js";
import { requireTerminalForIdentityChange } from "../identity-gate.js";
import type { RequireTerminalOptions } from "../require-terminal.js";
import {
  loadDoc,
  ownerCount,
  commitRegistry,
  withRegistryLock,
  RegistryCliError,
  personalOrgItemName,
  type Doc,
} from "./registry-mutate.js";
import { ensureSchemaVersion, findEngagementNode } from "./engagements-mutate.js";
import type { InstallGuardOptions } from "./install-readers.js";

interface BaseOptions extends RequireTerminalOptions, InstallGuardOptions {
  registryPath?: string;
}

export interface IdentityAddOptions extends BaseOptions {
  ghLogin?: string;
  app?: string;
}

export interface SetIdentityOptions extends BaseOptions {
  /** `--personal-org <org>`: the target is a personal org instead of an engagement id. */
  personalOrg?: string;
  person?: string;
  agent?: string;
  clear?: boolean;
}

function audit(change: string): void {
  try {
    // Kind of change only: never names (owners can be customer names).
    appendAuditRecord({ action: "registry-identity-change", details: { change } });
  } catch {
    /* audit log must not break user-facing ops */
  }
}

/** Identity name -> kind, from the document as it is now (tolerant of a malformed one). */
function definedIdentities(doc: Doc): Map<string, string> {
  const out = new Map<string, string>();
  const node = doc.get("identities");
  if (!isMap(node)) return out;
  for (const pair of node.items) {
    const key = pair.key instanceof Scalar ? pair.key.value : pair.key;
    const val = pair.value;
    if (typeof key !== "string" || !isMap(val)) continue;
    const kind = val.get("kind");
    out.set(key, typeof kind === "string" ? kind : String((kind as Scalar | null)?.value ?? ""));
  }
  return out;
}

function strOf(node: unknown): string | null {
  if (typeof node === "string") return node;
  if (node instanceof Scalar && typeof node.value === "string") return node.value;
  return null;
}

/** Every identity name some personal org or engagement refers to. */
function referencedIdentities(doc: Doc): Set<string> {
  const refs = new Set<string>();
  const take = (m: YAMLMap): void => {
    for (const col of ["person", "agent"]) {
      const v = strOf(m.get(col));
      if (v !== null) refs.add(v);
    }
  };
  const po = doc.get("personalOrgs");
  if (isSeq(po)) for (const item of po.items) if (isMap(item)) take(item);
  const eng = doc.get("engagements");
  if (isSeq(eng)) for (const item of eng.items) if (isMap(item)) take(item);
  return refs;
}

function flowMap(doc: Doc, value: Record<string, string>): YAMLMap {
  const node = doc.createNode(value) as YAMLMap;
  node.flow = true;
  return node;
}

// ---------------------------------------------------------------------------
// identity add / remove / require --off
// ---------------------------------------------------------------------------

export function identityAdd(name: string | undefined, opts: IdentityAddOptions): void {
  requireTerminalForIdentityChange({ kind: "identity-add", name: name ?? "" }, opts);
  const identity = (name ?? "").trim().toLowerCase();
  const usage = (error: string): never => failUsage(error, opts);
  if (!IDENTITY_NAME_REGEX.test(identity)) {
    usage("identity name must match ^[a-z0-9][a-z0-9-]{0,62}$ (lowercase, digits, hyphens; no leading hyphen)");
  }
  if ((opts.ghLogin === undefined) === (opts.app === undefined)) {
    usage("identity add takes exactly one of --gh-login <login> (a person) or --app <slug> (a GitHub App)");
  }
  let def: Record<string, string>;
  if (opts.ghLogin !== undefined) {
    const login = opts.ghLogin.trim();
    if (!GH_LOGIN_REGEX.test(login)) usage("login must match ^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$ (no leading hyphen)");
    def = { kind: "gh-login", login };
  } else {
    const app = (opts.app ?? "").trim().toLowerCase();
    if (!IDENTITY_NAME_REGEX.test(app)) usage("app slug must match ^[a-z0-9][a-z0-9-]{0,62}$ (no leading hyphen)");
    def = { kind: "github-app", app };
  }
  const path = opts.registryPath ?? defaultRegistryPath();

  const added = withRegistryLock(opts, () => {
    const doc = loadDoc(path);
    const ownersBefore = ownerCount(doc);
    const existing = doc.getIn(["identities", identity]);
    if (existing !== undefined) {
      const same = isMap(existing) && Object.entries(def).every(([k, v]) => strOf(existing.get(k)) === v);
      if (same) return false;
      throw new RegistryCliError(
        "IDENTITY_EXISTS",
        `identity "${identity}" already exists with a different definition; remove it first (it must be unreferenced)`,
      );
    }
    ensureSchemaVersion(doc, REGISTRY_IDENTITIES_MIN_VERSION, opts);
    if (!isMap(doc.get("identities"))) doc.set("identities", doc.createNode({}));
    (doc.get("identities") as YAMLMap).set(identity, flowMap(doc, def));
    commitRegistry(doc, path, { ...opts, ownersBefore, command: { kind: "identity-change" } });
    return true;
  });
  if (added) audit(`identity-add:${def["kind"]}`);
  if (opts.json) {
    emitJson({ action: "identity-add", name: identity, kind: def["kind"], added });
    return;
  }
  emitText(added ? `added identity ${identity} (${def["kind"]})` : `identity ${identity} already present`);
}

export function identityRemove(name: string | undefined, opts: BaseOptions): void {
  requireTerminalForIdentityChange({ kind: "identity-remove", name: name ?? "" }, opts);
  const identity = (name ?? "").trim().toLowerCase();
  if (!IDENTITY_NAME_REGEX.test(identity)) {
    failUsage("identity name must match ^[a-z0-9][a-z0-9-]{0,62}$", opts);
  }
  const path = opts.registryPath ?? defaultRegistryPath();
  withRegistryLock(opts, () => {
    const doc = loadDoc(path);
    const ownersBefore = ownerCount(doc);
    if (!definedIdentities(doc).has(identity)) {
      throw new RegistryCliError("IDENTITY_NOT_FOUND", `identity "${identity}" is not defined`);
    }
    if (referencedIdentities(doc).has(identity)) {
      throw new RegistryCliError(
        "IDENTITY_IN_USE",
        `identity "${identity}" is still referenced by a personal org or an engagement; clear those first ` +
          `(engagements set-identity ... --clear)`,
      );
    }
    doc.deleteIn(["identities", identity]);
    commitRegistry(doc, path, { ...opts, ownersBefore, command: { kind: "identity-change" } });
  });
  audit("identity-remove");
  if (opts.json) {
    emitJson({ action: "identity-remove", name: identity, removed: true });
    return;
  }
  emitText(`removed identity ${identity}`);
}

/**
 * `identity require --off | --on`. `--off` loosens, so it needs a terminal and is human-only. `--on` only
 * tightens (the same state the first `set-identity` creates), so it needs neither and an agent may run it.
 */
export function identityRequire(opts: BaseOptions & { off?: boolean; on?: boolean }): void {
  if (opts.on === true && opts.off === true) failUsage("identity require takes --on or --off, not both", opts);
  if (opts.on !== true) {
    requireTerminalForIdentityChange({ kind: "identity-require-off" }, opts);
    if (opts.off !== true) failUsage("identity require takes --off (clear) or --on (set)", opts);
  }
  const want = opts.on === true;
  const path = opts.registryPath ?? defaultRegistryPath();
  const changed = withRegistryLock(opts, () => {
    const doc = loadDoc(path);
    const ownersBefore = ownerCount(doc);
    const cur = doc.get("requireIdentity");
    if (want) {
      if (cur === true) return false;
      // Without identities there is nothing to require, and setting it would raise the version for nothing.
      if (!(doc.get("schemaVersion") === 3 || (doc.get("schemaVersion") as Scalar | null)?.value === 3)) {
        throw new RegistryCliError("NOTHING_TO_REQUIRE", "the registry has no identities (schemaVersion below 3); add and map some first");
      }
      doc.set("requireIdentity", true);
    } else {
      if (cur === undefined || cur === false) return false; // never set: nothing to clear (and no bump to v3)
      doc.set("requireIdentity", false);
    }
    commitRegistry(doc, path, { ...opts, ownersBefore, command: { kind: "identity-change" } });
    return true;
  });
  if (changed) audit(want ? "identity-require-on" : "identity-require-off");
  if (opts.json) {
    emitJson({ action: "identity-require", requireIdentity: want, changed });
    return;
  }
  emitText(changed ? `requireIdentity ${want ? "set" : "cleared"}` : `requireIdentity was ${want ? "already set" : "not set"}`);
}

// ---------------------------------------------------------------------------
// engagements set-identity
// ---------------------------------------------------------------------------

function failUsage(error: string, opts: OutputOptions): never {
  return emitError({ code: "USAGE", error }, opts);
}

/** Check a `--person` / `--agent` value names an identity of the right kind, as the schema will. */
function checkReference(doc: Doc, column: "person" | "agent", name: string): void {
  const kind = definedIdentities(doc).get(name);
  const want = column === "agent" ? "github-app" : "gh-login";
  if (kind === undefined) {
    throw new RegistryCliError("IDENTITY_NOT_FOUND", `--${column}: identity "${name}" is not defined (add it with identity add)`);
  }
  if (kind !== want) {
    throw new RegistryCliError(
      "IDENTITY_KIND_MISMATCH",
      `--${column}: identity "${name}" is kind "${kind}"; --${column} needs a ${want} identity`,
    );
  }
}

/**
 * `engagements set-identity`. The target is an engagement id, or a personal org with `--personal-org`
 * (chosen to mirror `engagements add --personal-org`: personal orgs have no command group of their own).
 * `--person` / `--agent` set that column and leave the other alone; `--clear` removes both.
 */
export function engagementsSetIdentity(id: string | undefined, opts: SetIdentityOptions): void {
  const orgArg = opts.personalOrg;
  requireTerminalForIdentityChange(
    orgArg !== undefined
      ? { kind: "set-identity-personal-org", org: orgArg }
      : { kind: "set-identity-engagement", id: id ?? "" },
    opts,
  );
  if (orgArg !== undefined && id !== undefined && id !== "") {
    failUsage("engagements set-identity --personal-org <org> does not take an <id>", opts);
  }
  if (orgArg === undefined && (id === undefined || id === "")) {
    failUsage("engagements set-identity needs an <engagement-id> (or --personal-org <org>)", opts);
  }
  const person = opts.person?.trim().toLowerCase();
  const agent = opts.agent?.trim().toLowerCase();
  if (opts.clear === true && (person !== undefined || agent !== undefined)) {
    failUsage("--clear cannot be combined with --person or --agent", opts);
  }
  if (opts.clear !== true && person === undefined && agent === undefined) {
    failUsage("give --person <name>, --agent <name> or --clear", opts);
  }
  for (const [col, v] of [["person", person], ["agent", agent]] as const) {
    if (v !== undefined && !IDENTITY_NAME_REGEX.test(v)) failUsage(`--${col}: not a valid identity name`, opts);
  }
  const org = orgArg?.trim().toLowerCase();
  if (org !== undefined && !ORG_NAME_REGEX.test(org)) failUsage("--personal-org: not a valid org name", opts);

  const path = opts.registryPath ?? defaultRegistryPath();
  const result = withRegistryLock(opts, () => {
    const doc = loadDoc(path);
    const ownersBefore = ownerCount(doc);
    if (opts.clear !== true) {
      if (person !== undefined) checkReference(doc, "person", person);
      if (agent !== undefined) checkReference(doc, "agent", agent);
    }
    let changed = false;
    if (org !== undefined) {
      changed = editPersonalOrg(doc, org, person, agent, opts.clear === true);
    } else {
      const node = findEngagementNode(doc, id!);
      if (node === null) throw new RegistryCliError("ENGAGEMENT_NOT_FOUND", `engagement "${id}" not found`);
      if (opts.clear !== true && personalOrgItemNames(node).length === 0) {
        throw new RegistryCliError("ENGAGEMENT_HAS_NO_ORGS", `engagement "${id}" has no githubOrgs, so an identity would map nothing; add an org first`);
      }
      changed = editMapColumns(node, person, agent, opts.clear === true);
    }
    if (!changed) return { changed: false, firstSet: false, render: null };
    let firstSet = false;
    if (opts.clear !== true) {
      ensureSchemaVersion(doc, REGISTRY_IDENTITIES_MIN_VERSION, opts);
      if (doc.get("requireIdentity") === undefined) {
        doc.set("requireIdentity", true);
        firstSet = true;
      }
    }
    commitRegistry(doc, path, { ...opts, ownersBefore, command: { kind: "identity-change" } });
    return { changed: true, firstSet, render: renderMarkers(loadRegistry(path)) };
  });
  if (result.changed) audit(opts.clear === true ? "set-identity-clear" : "set-identity");
  const target = org !== undefined ? `personal org ${org}` : `engagement ${id}`;
  if (opts.json) {
    emitJson({
      action: "engagements-set-identity",
      target: org !== undefined ? { personalOrg: org } : { engagement: id },
      changed: result.changed,
      requireIdentitySet: result.firstSet,
    });
    return;
  }
  if (!result.changed) emitText(`${target}: identities unchanged`);
  else emitText(`${target}: identities ${opts.clear === true ? "cleared" : "set"}`);
  if (result.firstSet) emitText("requireIdentity set to true (turn it off with `repo-aegis identity require --off`)");
}

/** The `githubOrgs` of an engagement node. */
function personalOrgItemNames(node: YAMLMap): string[] {
  const seq = node.get("githubOrgs");
  return isSeq(seq) ? seq.items.map(strOf).filter((x): x is string => x !== null) : [];
}

/** Set or clear `person` / `agent` on a map node. True when the node changed. */
function editMapColumns(node: YAMLMap, person: string | undefined, agent: string | undefined, clear: boolean): boolean {
  let changed = false;
  const apply = (col: "person" | "agent", v: string | undefined): void => {
    if (clear) {
      if (node.has(col)) {
        node.delete(col);
        changed = true;
      }
      return;
    }
    if (v === undefined || strOf(node.get(col)) === v) return;
    node.set(col, v);
    changed = true;
  };
  apply("person", person);
  apply("agent", agent);
  return changed;
}

/**
 * Set or clear the identities of a personal org. A plain-string entry becomes `{ name, person?, agent? }`
 * (flow style, as in the plan), and an object entry left with only its name becomes a plain string again,
 * so an unmapped org looks exactly as it did in schemaVersion 2. Comments on the entry are kept.
 */
function editPersonalOrg(doc: Doc, org: string, person: string | undefined, agent: string | undefined, clear: boolean): boolean {
  const seq = doc.get("personalOrgs");
  if (!isSeq(seq)) throw new RegistryCliError("PERSONAL_ORG_NOT_FOUND", `personal org "${org}" is not registered (engagements add --personal-org registers one)`);
  const idx = (seq as YAMLSeq).items.findIndex(item => personalOrgItemName(item) === org);
  if (idx < 0) throw new RegistryCliError("PERSONAL_ORG_NOT_FOUND", `personal org "${org}" is not registered (engagements add --personal-org registers one)`);
  const item = seq.items[idx];
  if (isMap(item)) {
    const changed = editMapColumns(item, person, agent, clear);
    if (item.items.length === 1 && item.has("name")) {
      const plain = new Scalar(org);
      plain.comment = item.comment ?? null;
      plain.commentBefore = item.commentBefore ?? null;
      seq.items[idx] = plain;
    }
    return changed;
  }
  if (clear) return false;
  const value: Record<string, string> = { name: org };
  if (person !== undefined) value["person"] = person;
  if (agent !== undefined) value["agent"] = agent;
  const node = flowMap(doc, value);
  if (item instanceof Scalar) {
    node.comment = item.comment ?? null;
    node.commentBefore = item.commentBefore ?? null;
  }
  seq.items[idx] = node;
  return true;
}
