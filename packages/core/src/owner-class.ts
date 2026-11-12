// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// What the registry says about a GitHub owner, in one place
// (doc/plan-engagement-repo-consistency.md, "Shared: one owner classifier").
//
// Three callers used to answer this on their own and disagreed about an owner
// that is in two engagements: first-touch took the first match, case-sensitively;
// the egress guard took every match, case-insensitively; and an unclassified
// repo took neither. They now all ask this function, so a repository gets the
// same class whichever layer is looking.
import type { Registry } from "./registry.js";

export type OwnerClass =
  | { kind: "personal" }
  | { kind: "engagement"; id: string }
  /** In two or more engagements, or in `personalOrgs` and an engagement: the registry does not say whose it is. */
  | { kind: "ambiguous"; ids: string[] }
  | { kind: "unknown" };

/** Only the two owner lists are read, so a caller may pass a partial registry. */
export type OwnerRegistry = Pick<Registry, "engagements" | "personalOrgs">;

/** Pure. Owner names compare case-insensitively, as GitHub treats them. */
export function classifyOwner(owner: string, registry: OwnerRegistry): OwnerClass {
  const o = owner.toLowerCase();
  const personal = (registry.personalOrgs ?? []).some(p => p.toLowerCase() === o);
  const ids = registry.engagements
    .filter(e => (e.githubOrgs ?? []).some(g => g.toLowerCase() === o))
    .map(e => e.id);
  if (ids.length >= 2 || (personal && ids.length === 1)) return { kind: "ambiguous", ids };
  if (ids.length === 1) return { kind: "engagement", id: ids[0]! };
  return personal ? { kind: "personal" } : { kind: "unknown" };
}
