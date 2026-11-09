// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
// Single source of truth for on-disk schema definitions.
//
// All YAML configuration files repo-aegis reads at runtime — the
// engagement registry, the per-repo `.repo-aegis.yml` override, the
// classify rules file, the scanner queries file — flow through one of
// the schemas below. The `parse-and-narrow` helpers wrap zod's parse
// with the canonical CLI error type (RegistryParseError /
// RepoOverrideError / ad-hoc) so callers don't have to translate
// ZodError shape themselves.
//
// Why centralise here: previously each callsite hand-rolled a series of
// `typeof obj.foo !== "string"` checks. Adding a field meant editing
// the parser, the type, and the validator separately and hoping they
// stayed in sync. With zod, the schema *is* the type *is* the
// validator.

import { z } from "zod";

/**
 * Format a ZodError into the multi-line "human-readable" string we used
 * to build by hand in the per-callsite validators. The output preserves
 * the substrings that existing tests pin on (e.g. "must be", "missing",
 * "reserved").
 *
 * For deeply nested issues we render `engagements[3].markers: ...`
 * style paths — matches what the previous bespoke loops emitted.
 */
export function formatZodError(err: z.ZodError, kind: string): string {
  const lines: string[] = [];
  for (const issue of err.issues) {
    const path = issue.path
      .map((seg, i) => {
        if (typeof seg === "number") return `[${seg}]`;
        return i === 0 ? String(seg) : `.${String(seg)}`;
      })
      .join("");
    const where = path === "" ? kind : path;
    lines.push(`${where}: ${issue.message}`);
  }
  return lines.length === 1 ? lines[0]! : lines.join("; ");
}

// ---------------------------------------------------------------------------
// Engagement registry (~/.config/repo-aegis/engagements.yaml)
// ---------------------------------------------------------------------------

const ALWAYS_BLOCK_RESERVED_ID_LITERAL = "_always" as const;

/**
 * Allowed shape for a GitHub org name, used in `personalOrgs` and
 * `engagements[*].githubOrgs`. Mirrors GitHub's own org-name constraint:
 * lowercase alphanumerics and hyphens, starting with an alphanumeric.
 *
 * Schema rejects uppercase. Callers writing into the registry (e.g.
 * `engagements add --github-org`) must lowercase input before persisting;
 * the gate-time read path trusts the schema (no runtime case-folding).
 */
export const ORG_NAME_REGEX = /^[a-z0-9][a-z0-9-]*$/;

const orgNameSchema = z
  .string()
  .min(1, "org name must be non-empty")
  .regex(ORG_NAME_REGEX, {
    message:
      "org name must be lowercase, start with [a-z0-9], and contain only [a-z0-9-]",
  });

/**
 * An exact `owner/repo` entry for `allowedUpstreams` (issue #151, D6).
 *
 * The owner half uses {@link ORG_NAME_REGEX} and GitHub's 39-character limit.
 * The repo half allows GitHub's repo charset lower-cased (`[a-z0-9._-]`) up to
 * GitHub's 100-character limit, minus the path-traversal names `.` and `..`
 * and a trailing `.git` (GitHub treats `repo.git` as `repo`, so an entry that
 * keeps the suffix would never match the destination it was meant for). This
 * deviates from the plan's "orgNameSchema's charset for both halves": real
 * upstream repos carry dots and underscores (`foo.js`). No wildcards: an
 * upstream entry names one repo, never an owner.
 */
export const OWNER_REPO_REGEX = /^[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9._-]{1,100}$/;

/**
 * Why `value` is not an acceptable `allowedUpstreams` entry, or null when it
 * is. The one definition shared by the registry schema and the `upstreams
 * add` command, so a value the command accepts always loads.
 */
export function upstreamProblem(value: string): string | null {
  if (!OWNER_REPO_REGEX.test(value)) {
    return "upstream must be lowercase 'owner/repo': owner [a-z0-9-] up to 39 characters, repo [a-z0-9._-] up to 100, no wildcards, URLs or extra segments";
  }
  const repo = value.slice(value.indexOf("/") + 1);
  if (repo === "." || repo === "..") return "upstream repo name must not be '.' or '..'";
  if (repo.endsWith(".git")) return "upstream repo name must not end in '.git': drop the suffix";
  return null;
}

const ownerRepoSchema = z.string().superRefine((v, ctx) => {
  const problem = upstreamProblem(v);
  if (problem !== null) ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem });
});

/**
 * A bare package-registry host, as it would appear in `URL.host` — optionally
 * with a port, never with a scheme, path, credentials, or wildcard.
 *
 * Matching in `isHostAllowed` is exact string equality against `URL.host`, so
 * anything richer than a host silently never matches. Rejecting those shapes
 * at parse time turns a silently-inert allowlist entry into a loud config
 * error. Validation round-trips through the WHATWG URL parser so it agrees
 * with the host extraction in `egress.ts` by construction; `*` is rejected
 * separately because the URL parser accepts it as an ordinary host character.
 */
const registryHostSchema = z
  .string()
  .min(1, "registry host must be non-empty")
  .refine(
    v => {
      if (/\s/.test(v) || v.includes("*")) return false;
      try {
        const u = new URL(`https://${v}`);
        return u.host === v.toLowerCase() && u.username === "" && u.password === "";
      } catch {
        return false;
      }
    },
    {
      message:
        "must be a bare host such as 'registry.example.com' (optionally ':port') — " +
        "no scheme, path, credentials, or '*' wildcard",
    },
  );

// ---------------------------------------------------------------------------
// GitHub identities (registry schemaVersion 3; doc/plan-owner-identity.md §5.1)
// ---------------------------------------------------------------------------

/**
 * An identity's name, and a github-app's slug. Never starts with `-`, so a
 * value can never be read as an option when it is later passed to another
 * program (§12.1 A16).
 */
export const IDENTITY_NAME_REGEX = /^[a-z0-9][a-z0-9-]{0,62}$/;
/**
 * A GitHub login (case-insensitive on GitHub, kept as typed). Never starts with `-` or `_` (§12.1 A16). One
 * optional `_shortcode` suffix is allowed: the Enterprise Managed User form `handle_shortcode`. The shortcode
 * can identify a customer, so `status` and `doctor` text never print the login of an engagement-only identity.
 */
export const GH_LOGIN_REGEX = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:_[A-Za-z0-9]{1,20})?$/;

/**
 * Why a gh-login identity's login cannot be used, or null when it can: `"empty"` or `"invalid"` (not
 * {@link GH_LOGIN_REGEX}). The registry loader already rejects both, so this is for the places that look at an
 * identity without trusting how it got there (`identity list`, the refusal that explains a mismatched approval,
 * the `set-identity` warning). It never returns the login, so callers can say it without printing it.
 */
export function ghLoginProblem(login: string | undefined): "empty" | "invalid" | null {
  if (login === undefined || login.trim() === "") return "empty";
  return GH_LOGIN_REGEX.test(login) ? null : "invalid";
}

const identityNameSchema =z.string().regex(IDENTITY_NAME_REGEX, {
  message: "identity name must match ^[a-z0-9][a-z0-9-]{0,62}$ (lowercase, digits, hyphens; no leading hyphen)",
});

const identityDefinitionSchema = z.discriminatedUnion(
  "kind",
  [
    z.strictObject({
      kind: z.literal("gh-login"),
      login: z.string({ message: "'login' must be a string" }).regex(GH_LOGIN_REGEX, {
        message: `login must match ${GH_LOGIN_REGEX.source} (a GitHub login, or an Enterprise Managed User login handle_shortcode; no leading hyphen or underscore)`,
      }),
    }),
    z.strictObject({
      kind: z.literal("github-app"),
      app: z.string({ message: "'app' must be a string" }).regex(IDENTITY_NAME_REGEX, {
        message: "app slug must match ^[a-z0-9][a-z0-9-]{0,62}$ (lowercase, digits, hyphens; no leading hyphen)",
      }),
    }),
  ],
  { message: "identity 'kind' must be \"gh-login\" or \"github-app\"" },
);

/** The on-disk form of one identity. */
export type IdentityDefinition = z.infer<typeof identityDefinitionSchema>;

/** A `personalOrgs` entry that carries identities: `{ name, person?, agent? }`. */
const personalOrgObjectSchema = z.strictObject({
  name: orgNameSchema,
  person: identityNameSchema.optional(),
  agent: identityNameSchema.optional(),
});

/** A `personalOrgs` entry after parsing: a plain org name or an object that maps it to identities. */
export type PersonalOrgEntry = string | z.infer<typeof personalOrgObjectSchema>;

/**
 * One `personalOrgs` entry: a plain org name (unmapped, as in schemaVersion 2) or `{ name, person?, agent? }`.
 * A hand-written union, because zod's own reports "Invalid input" for a bad branch and never says which
 * field is wrong.
 */
const personalOrgEntrySchema = z.unknown().transform((value, ctx): PersonalOrgEntry => {
  const parsed =
    typeof value === "string"
      ? orgNameSchema.safeParse(value)
      : value !== null && typeof value === "object" && !Array.isArray(value)
        ? personalOrgObjectSchema.safeParse(value)
        : null;
  if (parsed === null) {
    ctx.issues.push({
      code: "custom",
      input: value,
      message: "personalOrgs entry must be an org name or an object { name, person?, agent? }",
    });
    return z.NEVER;
  }
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      ctx.issues.push({ code: "custom", input: value, message: issue.message, path: issue.path });
    }
    return z.NEVER;
  }
  return parsed.data;
});

/** The org name of a parsed `personalOrgs` entry. */
export function personalOrgName(entry: PersonalOrgEntry): string {
  return typeof entry === "string" ? entry : entry.name;
}

/** Keys an engagement may carry (schemaVersion 3 rejects any other). */
const KNOWN_ENGAGEMENT_KEYS: ReadonlySet<string> = new Set([
  "id", "name", "started", "ended", "reposActive", "markers", "notes", "githubOrgs", "person", "agent",
]);

/** Top-level keys the registry reads. Unknown top-level keys stay allowed, except near-misses of these (v3). */
const KNOWN_TOP_LEVEL_KEYS: readonly string[] = [
  "schemaVersion", "always_block", "personalOrgs", "allowedUpstreams", "publicRegistries", "privateInfra",
  "selfIdentity", "alwaysBlockExemptPaths", "engagements", "identities", "requireIdentity",
];

/** Levenshtein distance, for catching a mistyped key (`agnet`, `identites`) that passthrough would swallow. */
function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length]!;
}

const engagementSchema = z
  .object({
    id: z
      .string()
      .min(1, "missing or empty 'id'")
      .refine(v => v !== ALWAYS_BLOCK_RESERVED_ID_LITERAL, {
        message:
          `engagement id "${ALWAYS_BLOCK_RESERVED_ID_LITERAL}" is reserved; ` +
          `use the top-level 'always_block:' field for org-wide markers`,
      }),
    name: z.string({ message: "missing string 'name'" }),
    started: z.string().nullable().optional(),
    ended: z.string().nullable().optional(),
    reposActive: z.array(z.string()).optional(),
    markers: z.array(z.string(), { message: "missing 'markers' list" }),
    notes: z.string().optional(),
    /**
     * GitHub orgs that map to this engagement. Phase 1 of the zero-config
     * onboarding work: a repo whose origin's org appears here is auto-
     * classified as `customer-coupled` with this engagement attached.
     * Schema-level constraints: each entry must match {@link ORG_NAME_REGEX};
     * cross-engagement uniqueness and disjointness with `personalOrgs` are
     * enforced by the registry-level superRefine.
     */
    githubOrgs: z.array(orgNameSchema).optional(),
    /**
     * GitHub identities (schemaVersion 3) for every org in `githubOrgs`: the
     * `person` column (a gh-login identity) and the `agent` column (a
     * github-app identity). Names of top-level `identities` entries.
     */
    person: identityNameSchema.optional(),
    agent: identityNameSchema.optional(),
  })
  .passthrough(); // Forward-compat: unknown sibling fields are kept, not rejected.

export const registryFileSchema = z
  .object({
    schemaVersion: z
      .number({ message: "'schemaVersion' must be a number" })
      .optional(),
    always_block: z
      .array(z.string({ message: "'always_block' entries must be strings" }), {
        message: "'always_block' must be a list of patterns",
      })
      .optional(),
    /**
     * Top-level orgs the user owns / treats as public. A repo whose
     * origin's org is here is auto-classified as `public-eligible`.
     * Disjoint from any engagement's `githubOrgs`.
     */
    personalOrgs: z.array(personalOrgEntrySchema).optional(),
    /**
     * GitHub identities by name (schemaVersion 3, doc/plan-owner-identity.md
     * §5.1). Referenced by `personalOrgs` object entries and by an engagement's
     * `person` / `agent`. Nothing in this phase chooses or injects a token from
     * them.
     */
    identities: z.record(z.string(), identityDefinitionSchema).optional(),
    /**
     * When true, an agent write to a registered owner with no identity entry
     * at all is refused (§12.2 Q4, narrower rule). Set by the first
     * `set-identity`; cleared only by `identity require --off`.
     */
    requireIdentity: z.boolean({ message: "'requireIdentity' must be true or false" }).optional(),
    /**
     * Exact `owner/repo` upstreams an agent may open PRs, issues and comments
     * against without a person present (issue #151, D6). An entry registers
     * that one repo for rule h — never its owner, and never for push,
     * release or repo verbs. Adding one requires a terminal (D8).
     *
     * **No `schemaVersion` bump**, by the same argument as `selfIdentity`:
     * older readers have no rule h, so ignoring the key is harmless.
     */
    allowedUpstreams: z.array(ownerRepoSchema).optional(),
    /**
     * Extra package-registry hosts treated as public by the egress-hygiene
     * check, in ADDITION to the always-allowed defaults (npmjs, yarnpkg,
     * `*.github.com`). For a team that runs a legitimate public mirror.
     *
     * Org-wide, so it lives here rather than in a per-repo
     * `.repo-aegis.yml`: "our org runs this mirror" is a machine-level
     * fact, and a per-repo file could otherwise allow a private host into
     * a public repo — exactly the leak this check exists to stop.
     */
    publicRegistries: z.array(registryHostSchema).optional(),
    /**
     * Patterns for the developer's own private infrastructure — private
     * registry hosts, internal domains — that must not appear in a
     * public-facing repo but are entirely legitimate in a private one.
     *
     * Distinct from `always_block` (blocked everywhere) and from an
     * engagement's markers (scoped to one customer): this machine's private
     * infra is usually not attributable to a single engagement, and blocking
     * it everywhere would fire constantly in the private repos where those
     * hosts belong. Rendered to the reserved `_private_infra` marker stem and
     * included in the deny set only for public-facing repos.
     *
     * Populated by `scan-env`. Hosts only — never captured auth tokens.
     */
    privateInfra: z
      .array(z.string({ message: "'privateInfra' entries must be strings" }), {
        message: "'privateInfra' must be a list of patterns",
      })
      .optional(),
    /**
     * Patterns for the operator's OWN identity — the GitHub orgs they own,
     * their project and package names, their internal project codenames, and
     * the agent session-link shape.
     *
     * The inverse direction of every other list here. Engagement markers stop
     * a *customer's* strings entering *our* repos; `selfIdentity` stops *our*
     * strings entering a *customer's* repo, which is the direction with the
     * business cost. Rendered to the reserved `_self_identity` marker stem and
     * included in the deny set only when the repo — or, for the egress guard,
     * the destination — is `customer-coupled`. Exactly the mirror of
     * `privateInfra`, which is included only for public-facing repos: each is
     * a set of strings that is entirely legitimate at home and a leak abroad,
     * and "abroad" is a different class for each.
     *
     * Populated by `scan-env --self`. Names only — never a credential.
     *
     * camelCase like `privateInfra` and every other key added since the
     * legacy snake_case `always_block`.
     *
     * **No `schemaVersion` bump.** The key is optional and additive, so an
     * older repo-aegis reading a registry that declares it drops the key via
     * `.passthrough()` and simply does not gain the new stem. Unlike
     * `alwaysBlockExemptPaths` the old reader is *laxer*, not stricter — but
     * only in `customer-coupled` repos, and only by declining a protection it
     * never had in the first place. Version gating exists to stop a stale
     * reader from **mis-enforcing** what it half-understands; a reader that
     * ignores the key enforces exactly the pre-`selfIdentity` deny set, which
     * is a state every install was already in. Gating this behind a version
     * bump would instead make every older client refuse the registry outright
     * — a hard failure traded for an absent addition.
     */
    selfIdentity: z
      .array(z.string({ message: "'selfIdentity' entries must be strings" }), {
        message: "'selfIdentity' must be a list of patterns",
      })
      .optional(),
    /**
     * Path globs (see `globs.ts` for the `*`/`?`/`**` semantics) inside which
     * the `_always` marker class — and ONLY that class — is not enforced.
     *
     * The asymmetry is the point. `_always` patterns are secret *shapes* (PEM
     * headers, token prefixes) with a well-known benign home: a keypair under
     * `test/fixtures/` is a throwaway by construction. A customer-marker
     * literal has no benign home — a customer name in a test fixture is still
     * a leak — and neither does `_private_infra`, since a private registry
     * host in a public repo's fixture is exactly the thing that check exists
     * to stop. So engagement and `_private_infra` patterns are never exempted,
     * at any path, by any config.
     *
     * camelCase deliberately: `always_block` above is legacy snake_case, but
     * every key added since (`personalOrgs`, `publicRegistries`,
     * `privateInfra`) is camel, and consistency for new keys beats symmetry
     * with the one legacy name.
     *
     * Absent (undefined) and empty (`[]`) mean different things and the
     * distinction is load-bearing: absent selects the built-in default list
     * (see `BUILTIN_ALWAYS_BLOCK_EXEMPT_PATHS` in deny-set.ts), while `[]`
     * means "exempt nothing". Readers must not collapse the two with `?? []`.
     *
     * **No `schemaVersion` bump.** The key is optional and additive, so an
     * older repo-aegis reading a registry that declares it drops the key via
     * `.passthrough()` and enforces `_always` *everywhere* — i.e. the old
     * reader is strictly STRICTER, never laxer. Version gating exists to stop
     * a stale reader from mis-enforcing; a fail-closed direction needs no
     * gate. The same argument covers `alwaysBlockExemptPaths` in
     * `repoOverrideSchema` below.
     */
    alwaysBlockExemptPaths: z
      .array(z.string({ message: "'alwaysBlockExemptPaths' entries must be strings" }), {
        message: "'alwaysBlockExemptPaths' must be a list of path globs",
      })
      .optional(),
    engagements: z.array(engagementSchema, { message: "'engagements' must be a list" }),
  })
  .passthrough()
  // Cross-field validation: org names must be unique across the
  // (personalOrgs ∪ Σ engagements[*].githubOrgs) union, and within
  // personalOrgs itself. Same-string overlap is a fail-closed parse error.
  .superRefine((data, ctx) => {
    // Names only: an object entry maps its org to identities but is the same org for every rule below.
    const personalOrgs = (data.personalOrgs ?? []).map(personalOrgName);
    const schemaVersion = data.schemaVersion ?? 1;
    const identities = new Map(Object.entries(data.identities ?? {}));
    // 0. schemaVersion 3 gate: the identity keys are not understood below it, so a lower
    // declared version with them is a mismatch, not a quiet upgrade.
    if (schemaVersion < REGISTRY_IDENTITIES_MIN_VERSION) {
      const needs = (path: (string | number)[], what: string): void =>
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path,
          message: `${what} requires schemaVersion ${REGISTRY_IDENTITIES_MIN_VERSION}, but this registry declares schemaVersion ${schemaVersion}`,
        });
      if (data.identities !== undefined) needs(["identities"], "'identities'");
      if (data.requireIdentity !== undefined) needs(["requireIdentity"], "'requireIdentity'");
      (data.personalOrgs ?? []).forEach((entry, i) => {
        if (typeof entry !== "string") needs(["personalOrgs", i], "an object-form personalOrgs entry");
      });
      data.engagements.forEach((eng, i) => {
        if (eng.person !== undefined) needs(["engagements", i, "person"], "an engagement's 'person'");
        if (eng.agent !== undefined) needs(["engagements", i, "agent"], "an engagement's 'agent'");
      });
    }
    // 0a. From version 3 a mistyped key must not pass silently: a misspelt `agent:` or `requireIdentity:` would
    // otherwise be kept by passthrough and quietly leave an owner unmapped or the requirement off.
    if (schemaVersion >= REGISTRY_IDENTITIES_MIN_VERSION) {
      data.engagements.forEach((eng, i) => {
        for (const key of Object.keys(eng)) {
          if (!KNOWN_ENGAGEMENT_KEYS.has(key)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["engagements", i],
              message: `unknown key "${key}" in a schemaVersion ${schemaVersion} engagement (known: ${[...KNOWN_ENGAGEMENT_KEYS].join(", ")})`,
            });
          }
        }
      });
      for (const key of Object.keys(data)) {
        if (KNOWN_TOP_LEVEL_KEYS.includes(key)) continue;
        const near = KNOWN_TOP_LEVEL_KEYS.find(k => editDistance(key.toLowerCase(), k.toLowerCase()) <= 2);
        if (near !== undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key],
            message: `unknown top-level key "${key}" looks like a misspelling of "${near}"`,
          });
        }
      }
    }
    // 0b. identity names (record keys are not validated by the record schema) and references.
    for (const name of identities.keys()) {
      if (!IDENTITY_NAME_REGEX.test(name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["identities", name],
          message: "identity name must match ^[a-z0-9][a-z0-9-]{0,62}$ (lowercase, digits, hyphens; no leading hyphen)",
        });
      }
    }
    const checkRef = (path: (string | number)[], column: "person" | "agent", name: string | undefined): void => {
      if (name === undefined) return;
      const def = identities.get(name);
      if (def === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path,
          message: `${column} refers to identity "${name}", which is not defined in 'identities'`,
        });
        return;
      }
      const want = column === "agent" ? "github-app" : "gh-login";
      if (def.kind !== want) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path,
          message: `${column} identity "${name}" is kind "${def.kind}"; ${column} must refer to a ${want} identity`,
        });
      }
    };
    (data.personalOrgs ?? []).forEach((entry, i) => {
      if (typeof entry === "string") return;
      checkRef(["personalOrgs", i, "person"], "person", entry.person);
      checkRef(["personalOrgs", i, "agent"], "agent", entry.agent);
    });
    data.engagements.forEach((eng, i) => {
      checkRef(["engagements", i, "person"], "person", eng.person);
      checkRef(["engagements", i, "agent"], "agent", eng.agent);
    });
    // 1. personalOrgs internal duplicates.
    const personalSeen = new Map<string, number>();
    for (let i = 0; i < personalOrgs.length; i++) {
      const org = personalOrgs[i];
      if (org === undefined) continue;
      const prev = personalSeen.get(org);
      if (prev !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["personalOrgs", i],
          message: `duplicate org "${org}" (also at personalOrgs[${prev}])`,
        });
      } else {
        personalSeen.set(org, i);
      }
    }
    // 1b. allowedUpstreams internal duplicates (issue #151).
    const upstreamSeen = new Map<string, number>();
    const upstreams = data.allowedUpstreams ?? [];
    for (let i = 0; i < upstreams.length; i++) {
      const up = upstreams[i];
      if (up === undefined) continue;
      const prev = upstreamSeen.get(up);
      if (prev !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["allowedUpstreams", i],
          message: `duplicate upstream "${up}" (also at allowedUpstreams[${prev}])`,
        });
      } else {
        upstreamSeen.set(up, i);
      }
    }
    const personalSet = new Set(personalOrgs);
    // 2. cross-engagement uniqueness + disjointness with personalOrgs.
    const orgToEng = new Map<
      string,
      { engIdx: number; engId: string; orgIdx: number }
    >();
    for (let i = 0; i < data.engagements.length; i++) {
      const eng = data.engagements[i];
      if (eng === undefined) continue;
      const orgs = eng.githubOrgs ?? [];
      for (let j = 0; j < orgs.length; j++) {
        const org = orgs[j];
        if (org === undefined) continue;
        if (personalSet.has(org)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["engagements", i, "githubOrgs", j],
            message:
              `org "${org}" appears in personalOrgs and ` +
              `engagements[${i}=${eng.id}].githubOrgs; ` +
              `the two are mutually exclusive`,
          });
        }
        const prev = orgToEng.get(org);
        if (prev !== undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["engagements", i, "githubOrgs", j],
            message:
              `org "${org}" is also in ` +
              `engagements[${prev.engIdx}=${prev.engId}].githubOrgs; ` +
              `an org maps to at most one engagement`,
          });
        } else {
          orgToEng.set(org, { engIdx: i, engId: eng.id, orgIdx: j });
        }
      }
    }
  });

export type RegistryFile = z.infer<typeof registryFileSchema>;

/** The registry `schemaVersion` that introduced `identities` and the keys that reference them. */
export const REGISTRY_IDENTITIES_MIN_VERSION = 3;

// ---------------------------------------------------------------------------
// Per-repo override (.repo-aegis.yml)
// ---------------------------------------------------------------------------

export const REPO_CLASSES = [
  "public-eligible",
  "private-strict",
  "customer-coupled",
  "scratch",
] as const;
export type RepoClassLiteral = (typeof REPO_CLASSES)[number];

export const repoOverrideSchema = z
  .object({
    class: z.enum(REPO_CLASSES).optional(),
    engagements: z
      .array(z.string().min(1, "'engagements' entries must be non-empty strings"))
      .optional(),
    /**
     * Additional `_always`-only path exemptions for this repo, **added to**
     * whatever the machine-level registry resolves to. Additive only — this
     * file is checked in and therefore writable by anyone with commit access,
     * so allowing it to *remove* a machine-level exemption would be fine but
     * allowing it to remove enforcement is not; the only widening it can do is
     * within the `_always` class, which the registry already permits by kind.
     * It can never touch engagement or `_private_infra` patterns.
     */
    alwaysBlockExemptPaths: z
      .array(z.string().min(1, "'alwaysBlockExemptPaths' entries must be non-empty strings"))
      .optional(),
  })
  .passthrough();

export type RepoOverrideFile = z.infer<typeof repoOverrideSchema>;

// Note: schemas for files only loaded by `cli` (classify rules) or
// `scan` (query files) live in those packages, not here. They use the
// shared `formatZodError` helper exported above for consistent error
// rendering, but the schemas themselves are package-private — moving
// them here would inflate core's public surface for no gain.
