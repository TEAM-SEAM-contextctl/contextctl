import {
  assertNoModelIssues,
  issue,
  type ModelValidationIssue,
} from "./model-validation.js";
import { canonicalJson } from "./revision-identity.js";

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

export interface LocalDocumentEmbeddingExecution {
  readonly kind: "local";
  readonly adapter: "transformers-js-onnx";
  readonly adapterVersion: string;
  readonly artifactRepository: string;
  readonly artifactRevision: string;
  readonly artifactPath: string;
  readonly artifactSha256: string;
  readonly assetManifestSha256: string;
  readonly precision: "fp32" | "fp16" | "q8" | "q4";
}

export interface RemoteDocumentEmbeddingExecution {
  readonly kind: "remote";
  readonly adapter: "openai-compatible";
  readonly adapterVersion: string;
  readonly model: string;
}

export type DocumentEmbeddingExecution =
  | LocalDocumentEmbeddingExecution
  | RemoteDocumentEmbeddingExecution;

/**
 * Complete vector-semantics boundary for a production document index.
 *
 * The two base aliases are retained while pre-release fixtures migrate. They
 * must exactly mirror `admissionLimit` and are rejected when they diverge.
 */
export interface DocumentRetrievalEmbeddingProfile extends EmbeddingProfile {
  readonly modelRevision: string;
  readonly execution: DocumentEmbeddingExecution;
  readonly pooling: "cls" | "mean" | "provider_defined";
  readonly normalization: "l2";
  readonly documentInputTransformVersion: string;
  readonly queryInputTransformVersion: string;
  readonly modelMaxTokens: number;
  readonly admissionLimit: {
    readonly textMeasureProfileVersion: string;
    readonly maxUnits: number;
  };
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
  if (
    !("cosine" === profile.distance ||
      "dot" === profile.distance ||
      "euclid" === profile.distance)
  ) {
    issues.push(
      issue(
        "invalid_discriminator",
        `${path}.distance`,
        "embedding distance must be cosine, dot, or euclid",
      ),
    );
  }
  if (hasDocumentProfileFields(profile)) {
    issues.push(
      ...validateDocumentRetrievalEmbeddingProfile(
        profile as DocumentRetrievalEmbeddingProfile,
        path,
      ),
    );
  }
  return issues;
}

export function validateDocumentRetrievalEmbeddingProfile(
  profile: DocumentRetrievalEmbeddingProfile,
  path = "embeddingProfile",
): readonly ModelValidationIssue[] {
  const issues: ModelValidationIssue[] = [];
  validateNonEmpty(profile.modelRevision, `${path}.modelRevision`, issues);
  validateNonEmpty(
    profile.documentInputTransformVersion,
    `${path}.documentInputTransformVersion`,
    issues,
  );
  validateNonEmpty(
    profile.queryInputTransformVersion,
    `${path}.queryInputTransformVersion`,
    issues,
  );
  validatePositiveInteger(
    profile.modelMaxTokens,
    `${path}.modelMaxTokens`,
    "model token limit",
    issues,
  );
  validatePositiveInteger(
    profile.admissionLimit?.maxUnits,
    `${path}.admissionLimit.maxUnits`,
    "admission input limit",
    issues,
  );
  validateNonEmpty(
    profile.admissionLimit?.textMeasureProfileVersion ?? "",
    `${path}.admissionLimit.textMeasureProfileVersion`,
    issues,
  );
  if (
    !(profile.pooling === "cls" ||
      profile.pooling === "mean" ||
      profile.pooling === "provider_defined")
  ) {
    issues.push(
      issue(
        "invalid_discriminator",
        `${path}.pooling`,
        "document embedding pooling is invalid",
      ),
    );
  }
  if (profile.normalization !== "l2") {
    issues.push(
      issue(
        "invalid_discriminator",
        `${path}.normalization`,
        "document embedding normalization must be l2",
      ),
    );
  }
  if (profile.distance !== "cosine") {
    issues.push(
      issue(
        "invalid_value",
        `${path}.distance`,
        "document retrieval embeddings require cosine distance",
      ),
    );
  }
  if (
    profile.maxInputTokens !== profile.admissionLimit?.maxUnits ||
    profile.textMeasureProfileVersion !==
      profile.admissionLimit?.textMeasureProfileVersion
  ) {
    issues.push(
      issue(
        "relationship_mismatch",
        `${path}.admissionLimit`,
        "embedding admission aliases must match the complete profile",
      ),
    );
  }
  issues.push(...validateDocumentEmbeddingExecution(profile, path));
  return issues;
}

export function isDocumentRetrievalEmbeddingProfile(
  profile: EmbeddingProfile,
): profile is DocumentRetrievalEmbeddingProfile {
  return (
    hasDocumentProfileFields(profile) &&
    validateEmbeddingProfile(profile).length === 0
  );
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
  return canonicalJson(left) === canonicalJson(right);
}

export const EMBEDDING_L2_NORM_TOLERANCE = 1e-3;

/** Verifies the vector shape and the exact normalization semantics in a profile. */
export function embeddingVectorMatchesProfile(
  profile: EmbeddingProfile,
  vector: readonly number[],
): boolean {
  if (
    vector.length !== profile.dimensions ||
    vector.some((component) => !Number.isFinite(component))
  ) {
    return false;
  }
  if (
    !isDocumentRetrievalEmbeddingProfile(profile) ||
    profile.normalization !== "l2"
  ) {
    return true;
  }
  const squaredNorm = vector.reduce(
    (sum, component) => sum + component * component,
    0,
  );
  if (!Number.isFinite(squaredNorm) || squaredNorm <= 0) return false;
  return (
    Math.abs(Math.sqrt(squaredNorm) - 1) <= EMBEDDING_L2_NORM_TOLERANCE
  );
}

export function documentEmbeddingProfileChangeRequiresFullRebuild(
  previous: DocumentRetrievalEmbeddingProfile,
  next: DocumentRetrievalEmbeddingProfile,
): boolean {
  return !embeddingProfilesMatch(previous, next);
}

function validateDocumentEmbeddingExecution(
  profile: DocumentRetrievalEmbeddingProfile,
  path: string,
): readonly ModelValidationIssue[] {
  const issues: ModelValidationIssue[] = [];
  const execution = profile.execution;
  if (execution?.kind === "local") {
    if (execution.adapter !== "transformers-js-onnx") {
      issues.push(
        issue(
          "invalid_discriminator",
          `${path}.execution.adapter`,
          "local embedding adapter is invalid",
        ),
      );
    }
    validateNonEmpty(
      execution.adapterVersion,
      `${path}.execution.adapterVersion`,
      issues,
    );
    validateNonEmpty(
      execution.artifactRepository,
      `${path}.execution.artifactRepository`,
      issues,
    );
    validateNonEmpty(
      execution.artifactRevision,
      `${path}.execution.artifactRevision`,
      issues,
    );
    validateSafeRelativePath(
      execution.artifactPath,
      `${path}.execution.artifactPath`,
      issues,
    );
    validateSha256(
      execution.artifactSha256,
      `${path}.execution.artifactSha256`,
      issues,
    );
    validateSha256(
      execution.assetManifestSha256,
      `${path}.execution.assetManifestSha256`,
      issues,
    );
    if (
      !(execution.precision === "fp32" ||
        execution.precision === "fp16" ||
        execution.precision === "q8" ||
        execution.precision === "q4")
    ) {
      issues.push(
        issue(
          "invalid_discriminator",
          `${path}.execution.precision`,
          "local embedding precision is invalid",
        ),
      );
    } else {
      const suffix =
        execution.precision === "q8"
          ? "_quantized.onnx"
          : execution.precision === "fp16"
            ? "_fp16.onnx"
            : ".onnx";
      const file =
        typeof execution.artifactPath === "string"
          ? execution.artifactPath.split("/").at(-1) ?? ""
          : "";
      if (!file.endsWith(suffix) || file.length === suffix.length) {
        issues.push(
          issue(
            "relationship_mismatch",
            `${path}.execution.artifactPath`,
            "local artifact path must match the configured precision",
          ),
        );
      }
    }
    if (profile.pooling === "provider_defined") {
      issues.push(
        issue(
          "invalid_value",
          `${path}.pooling`,
          "local embeddings require explicit pooling",
        ),
      );
    }
    return issues;
  }
  if (execution?.kind === "remote") {
    if (execution.adapter !== "openai-compatible") {
      issues.push(
        issue(
          "invalid_discriminator",
          `${path}.execution.adapter`,
          "remote embedding adapter is invalid",
        ),
      );
    }
    validateNonEmpty(
      execution.adapterVersion,
      `${path}.execution.adapterVersion`,
      issues,
    );
    validateNonEmpty(execution.model, `${path}.execution.model`, issues);
    if (execution.model !== profile.model) {
      issues.push(
        issue(
          "relationship_mismatch",
          `${path}.execution.model`,
          "remote execution model must match the profile model",
        ),
      );
    }
    return issues;
  }
  issues.push(
    issue(
      "invalid_discriminator",
      `${path}.execution.kind`,
      "document embedding execution kind is invalid",
    ),
  );
  return issues;
}

function validateNonEmpty(
  value: unknown,
  path: string,
  issues: ModelValidationIssue[],
): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    issues.push(issue("invalid_value", path, `${path} must not be empty`));
  }
}

function validatePositiveInteger(
  value: unknown,
  path: string,
  label: string,
  issues: ModelValidationIssue[],
): void {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    issues.push(
      issue("invalid_value", path, `${label} must be a positive integer`),
    );
  }
}

function validateSha256(
  value: unknown,
  path: string,
  issues: ModelValidationIssue[],
): void {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    issues.push(
      issue("invalid_value", path, `${path} must be a SHA-256 hex digest`),
    );
  }
}

function validateSafeRelativePath(
  value: unknown,
  path: string,
  issues: ModelValidationIssue[],
): void {
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value
      .split("/")
      .some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    issues.push(
      issue("invalid_value", path, `${path} must be a safe relative path`),
    );
  }
}

function hasDocumentProfileFields(profile: EmbeddingProfile): boolean {
  const record = profile as unknown as Readonly<Record<string, unknown>>;
  return [
    "admissionLimit",
    "documentInputTransformVersion",
    "execution",
    "modelMaxTokens",
    "modelRevision",
    "normalization",
    "pooling",
    "queryInputTransformVersion",
  ].some((key) => Object.hasOwn(record, key));
}
