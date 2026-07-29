export type ModelValidationIssueCode =
  | "count_mismatch"
  | "cycle_detected"
  | "duplicate_id"
  | "duplicate_reference"
  | "invalid_digest"
  | "invalid_discriminator"
  | "invalid_id"
  | "invalid_order"
  | "invalid_root_count"
  | "invalid_reference"
  | "invalid_source_span"
  | "invalid_value"
  | "missing_reference"
  | "non_contiguous_order"
  | "relationship_mismatch"
  | "text_mismatch";

export interface ModelValidationIssue {
  readonly code: ModelValidationIssueCode;
  readonly path: string;
  readonly message: string;
}

export class ModelValidationError extends Error {
  readonly issues: readonly ModelValidationIssue[];

  constructor(model: string, issues: readonly ModelValidationIssue[]) {
    super(`${model} failed validation with ${issues.length} issue(s)`);
    this.name = "ModelValidationError";
    this.issues = issues;
  }
}

export function assertNoModelIssues(
  model: string,
  issues: readonly ModelValidationIssue[],
): void {
  if (issues.length > 0) {
    throw new ModelValidationError(model, issues);
  }
}

export function issue(
  code: ModelValidationIssueCode,
  path: string,
  message: string,
): ModelValidationIssue {
  return { code, path, message };
}

export function isId(value: string, prefix: string): boolean {
  return new RegExp(`^${prefix}_[a-z0-9]+(?:[a-z0-9_-]*[a-z0-9])?$`).test(
    value,
  );
}

export function isDigest(value: string): boolean {
  return /^sha256:[a-f0-9]{64}$/.test(value);
}

export function isRevisionId(value: string, prefix: string): boolean {
  return new RegExp(`^${prefix}_[a-z2-7]+$`).test(value);
}

export function isIsoTimestamp(value: string): boolean {
  const timestamp = Date.parse(value);
  return (
    Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
  );
}
