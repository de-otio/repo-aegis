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
}

export class OutsideWorkingTreeError extends Error {
  readonly code = "OUTSIDE_WORKING_TREE" as const;
  constructor(public path: string, public workingTree: string) {
    super(`path ${path} is outside the working tree ${workingTree}`);
    this.name = "OutsideWorkingTreeError";
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
