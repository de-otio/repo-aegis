import { redactMatch } from "./redaction.js";

export class RegistryNotFoundError extends Error {
  readonly code = "REGISTRY_NOT_FOUND" as const;
  constructor(public path: string) {
    super(`engagement registry not found at ${path}`);
    this.name = "RegistryNotFoundError";
  }
}

export class RegistryParseError extends Error {
  readonly code = "REGISTRY_PARSE" as const;
  constructor(public path: string, public override cause: unknown) {
    super(`failed to parse registry at ${path}: ${(cause as Error).message ?? cause}`);
    this.name = "RegistryParseError";
  }
}

export class NotAGitRepoError extends Error {
  readonly code = "NOT_GIT_REPO" as const;
  constructor() {
    super("not inside a git repository");
    this.name = "NotAGitRepoError";
  }
}

export class AmbiguousQueryError extends Error {
  readonly code = "AMBIGUOUS_QUERY" as const;
  constructor(public query: string, public candidateCount: number) {
    super(`ambiguous engagement query "${query}" (${candidateCount} candidates)`);
    this.name = "AmbiguousQueryError";
  }
}

export class EngagementNotFoundError extends Error {
  readonly code = "ENGAGEMENT_NOT_FOUND" as const;
  constructor(public query: string) {
    super(`no engagement matches "${query}"`);
    this.name = "EngagementNotFoundError";
  }
}

export class PatternValidationError extends Error {
  readonly code = "PATTERN_VALIDATION" as const;
  constructor(
    public invalid: { pattern: string; reason: string; engagementId?: string }[],
  ) {
    super(`${invalid.length} marker pattern${invalid.length === 1 ? "" : "s"} failed validation`);
    this.name = "PatternValidationError";
  }

  /**
   * Same shape as {@link invalid} but with each `pattern` field passed
   * through {@link redactMatch} so the literal customer-derived substring
   * never leaves the process.
   *
   * Marker patterns are user-authored regexes that typically embed
   * customer-derived strings (e.g. `acmeengineering\.com`). They fall
   * under the same redaction policy as match values whenever they are
   * surfaced to JSON, log files, or anything an AI agent might
   * subsequently read.
   *
   * Callers serialising this error to JSON, stderr, or any persisted
   * artifact should prefer `redactedPatterns`. The raw `invalid` field
   * remains for the in-process renderer (it needs the literal pattern to
   * point the user at the offending entry in their own marker file) —
   * that is an internal contract; do not leak it across a process
   * boundary.
   */
  get redactedPatterns(): { pattern: string; reason: string; engagementId?: string }[] {
    return this.invalid.map(entry => {
      const out: { pattern: string; reason: string; engagementId?: string } = {
        pattern: redactMatch(entry.pattern),
        reason: entry.reason,
      };
      if (entry.engagementId !== undefined) out.engagementId = entry.engagementId;
      return out;
    });
  }
}

export class OutsideWorkingTreeError extends Error {
  readonly code = "OUTSIDE_WORKING_TREE" as const;
  constructor(public path: string, public workingTree: string) {
    super(`path ${path} is outside the working tree ${workingTree}`);
    this.name = "OutsideWorkingTreeError";
  }
}

export class LockTimeoutError extends Error {
  readonly code = "LOCK_TIMEOUT" as const;
  constructor(public lockPath: string) {
    super(`could not acquire registry lock at ${lockPath} (another repo-aegis process is running?)`);
    this.name = "LockTimeoutError";
  }
}

export class CustomerCoupledNoEngagementError extends Error {
  readonly code = "CUSTOMER_COUPLED_NO_ENGAGEMENT" as const;
  constructor() {
    super(
      "repo-aegis.class=customer-coupled but no repo-aegis.engagement is set; " +
        "run `repo-aegis allow <engagement-id>` to declare which engagement(s) " +
        "this repo legitimately references",
    );
    this.name = "CustomerCoupledNoEngagementError";
  }
}
