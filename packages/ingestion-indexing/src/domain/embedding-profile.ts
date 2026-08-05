import {
  assertNoModelIssues,
  issue,
  type ModelValidationIssue,
} from "./model-validation.js";

export type EmbeddingDistance = "cosine" | "dot" | "euclid";

/** Versioned compatibility boundary for one family of embedding vectors. */
export interface EmbeddingProfile {
  readonly id: string;
  readonly version: string;
  readonly model: string;
  readonly dimensions: number;
  readonly distance: EmbeddingDistance;
  readonly maxInputTokens: number;
  readonly textMeasureProfileVersion: string;
}

export function validateEmbeddingProfile(
  profile: EmbeddingProfile,
  path = "embeddingProfile",
): readonly ModelValidationIssue[] {
  const issues: ModelValidationIssue[] = [];
  validateNonEmpty(profile.id, `${path}.id`, issues);
  validateNonEmpty(profile.version, `${path}.version`, issues);
  validateNonEmpty(profile.model, `${path}.model`, issues);
  validatePositiveInteger(
    profile.dimensions,
    `${path}.dimensions`,
    "embedding dimensions",
    issues,
  );
  validatePositiveInteger(
    profile.maxInputTokens,
    `${path}.maxInputTokens`,
    "embedding input limit",
    issues,
  );
  validateNonEmpty(
    profile.textMeasureProfileVersion,
    `${path}.textMeasureProfileVersion`,
    issues,
  );
  if (!(["cosine", "dot", "euclid"] as const).includes(profile.distance)) {
    issues.push(
      issue(
        "invalid_discriminator",
        `${path}.distance`,
        "embedding distance must be cosine, dot, or euclid",
      ),
    );
  }
  return issues;
}

export function assertValidEmbeddingProfile(profile: EmbeddingProfile): void {
  assertNoModelIssues(
    "EmbeddingProfile",
    validateEmbeddingProfile(profile),
  );
}

export function embeddingProfilesMatch(
  left: EmbeddingProfile,
  right: EmbeddingProfile,
): boolean {
  return (
    left.id === right.id &&
    left.version === right.version &&
    left.model === right.model &&
    left.dimensions === right.dimensions &&
    left.distance === right.distance &&
    left.maxInputTokens === right.maxInputTokens &&
    left.textMeasureProfileVersion === right.textMeasureProfileVersion
  );
}

function validateNonEmpty(
  value: string,
  path: string,
  issues: ModelValidationIssue[],
): void {
  if (value.trim().length === 0) {
    issues.push(issue("invalid_value", path, `${path} must not be empty`));
  }
}

function validatePositiveInteger(
  value: number,
  path: string,
  label: string,
  issues: ModelValidationIssue[],
): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    issues.push(
      issue("invalid_value", path, `${label} must be a positive integer`),
    );
  }
}
