import { createHash } from "node:crypto";

import {
  ModelValidationError,
  type ModelValidationIssue,
  issue,
} from "./model-validation.js";

export const TEXT_MEASURE_PROFILE_VERSION = "unicode-estimate-v1" as const;
export const TEXT_MEASURE_ALGORITHM = "unicode_codepoint_estimate" as const;
export const SEGMENTATION_POLICY_VERSION = "semantic-unit-v1" as const;
export const CHUNK_POLICY_VERSION = "managed-chunk-v1" as const;
export const LINEAGE_POLICY_VERSION = "lineage-policy-v1" as const;

export interface TextMeasureProfile {
  readonly version: typeof TEXT_MEASURE_PROFILE_VERSION;
  readonly algorithm: typeof TEXT_MEASURE_ALGORITHM;
}

export interface SegmentationPolicy {
  readonly version: typeof SEGMENTATION_POLICY_VERSION;
  readonly textMeasureProfileVersion: typeof TEXT_MEASURE_PROFILE_VERSION;
  readonly minUnitTokens: 120;
  readonly targetUnitTokens: 600;
  readonly maxUnitTokens: 1200;
  readonly lexicalWindowBlocks: 3;
  readonly boundaryMadMultiplier: 1;
  readonly zeroMadMinDepth: 0.35;
}

export interface ChunkPolicy {
  readonly version: typeof CHUNK_POLICY_VERSION;
  readonly textMeasureProfileVersion: typeof TEXT_MEASURE_PROFILE_VERSION;
  readonly targetChunkTokens: 320;
  readonly maxChunkTokens: 480;
  readonly overlapTokens: 48;
}

export interface LineagePolicy {
  readonly version: typeof LINEAGE_POLICY_VERSION;
  readonly blockMinTokenJaccard: 0.85;
  readonly blockMinRunnerUpMargin: 0.1;
  readonly unitMinBlockIdJaccard: 0.6;
  readonly unitMinRunnerUpMargin: 0.15;
}

export interface DocumentIndexingPolicySet {
  readonly textMeasureProfile: TextMeasureProfile;
  readonly segmentation: SegmentationPolicy;
  readonly chunk: ChunkPolicy;
  readonly lineage: LineagePolicy;
}

export type DocumentIndexingPolicyIssue = ModelValidationIssue;

export class DocumentIndexingPolicyValidationError extends ModelValidationError {
  readonly code = "invalid_document_indexing_policy";

  constructor(
    model: "DocumentIndexingPolicySet" | "TextMeasureProfile",
    issues: readonly DocumentIndexingPolicyIssue[],
  ) {
    super(model, issues);
    this.name = "DocumentIndexingPolicyValidationError";
  }
}

export const DEFAULT_TEXT_MEASURE_PROFILE: TextMeasureProfile = Object.freeze({
  version: TEXT_MEASURE_PROFILE_VERSION,
  algorithm: TEXT_MEASURE_ALGORITHM,
});

export const DEFAULT_SEGMENTATION_POLICY: SegmentationPolicy = Object.freeze({
  version: SEGMENTATION_POLICY_VERSION,
  textMeasureProfileVersion: TEXT_MEASURE_PROFILE_VERSION,
  minUnitTokens: 120,
  targetUnitTokens: 600,
  maxUnitTokens: 1200,
  lexicalWindowBlocks: 3,
  boundaryMadMultiplier: 1,
  zeroMadMinDepth: 0.35,
});

export const DEFAULT_CHUNK_POLICY: ChunkPolicy = Object.freeze({
  version: CHUNK_POLICY_VERSION,
  textMeasureProfileVersion: TEXT_MEASURE_PROFILE_VERSION,
  targetChunkTokens: 320,
  maxChunkTokens: 480,
  overlapTokens: 48,
});

export const DEFAULT_LINEAGE_POLICY: LineagePolicy = Object.freeze({
  version: LINEAGE_POLICY_VERSION,
  blockMinTokenJaccard: 0.85,
  blockMinRunnerUpMargin: 0.1,
  unitMinBlockIdJaccard: 0.6,
  unitMinRunnerUpMargin: 0.15,
});

export const DEFAULT_DOCUMENT_INDEXING_POLICY: DocumentIndexingPolicySet =
  Object.freeze({
    textMeasureProfile: DEFAULT_TEXT_MEASURE_PROFILE,
    segmentation: DEFAULT_SEGMENTATION_POLICY,
    chunk: DEFAULT_CHUNK_POLICY,
    lineage: DEFAULT_LINEAGE_POLICY,
  });

const ROOT_FIELDS = [
  "chunk",
  "lineage",
  "segmentation",
  "textMeasureProfile",
] as const;
const TEXT_MEASURE_FIELDS = ["algorithm", "version"] as const;
const SEGMENTATION_FIELDS = [
  "boundaryMadMultiplier",
  "lexicalWindowBlocks",
  "maxUnitTokens",
  "minUnitTokens",
  "targetUnitTokens",
  "textMeasureProfileVersion",
  "version",
  "zeroMadMinDepth",
] as const;
const CHUNK_FIELDS = [
  "maxChunkTokens",
  "overlapTokens",
  "targetChunkTokens",
  "textMeasureProfileVersion",
  "version",
] as const;
const LINEAGE_FIELDS = [
  "blockMinRunnerUpMargin",
  "blockMinTokenJaccard",
  "unitMinBlockIdJaccard",
  "unitMinRunnerUpMargin",
  "version",
] as const;

const LATIN_LETTER_OR_NUMBER = /[\p{Script=Latin}\p{Number}]/u;
const WHITESPACE_OR_CONTROL = /[\p{White_Space}\p{Cc}]/u;

export function measureText(
  text: string,
  profile: TextMeasureProfile = DEFAULT_TEXT_MEASURE_PROFILE,
): number {
  assertSupportedTextMeasureProfile(profile);

  let measuredTokens = 0;
  let latinOrNumberRun = 0;

  const flushRun = (): void => {
    measuredTokens += Math.ceil(latinOrNumberRun / 4);
    latinOrNumberRun = 0;
  };

  for (const codePoint of text) {
    if (LATIN_LETTER_OR_NUMBER.test(codePoint)) {
      latinOrNumberRun += 1;
      continue;
    }

    flushRun();
    if (!WHITESPACE_OR_CONTROL.test(codePoint)) {
      measuredTokens += 1;
    }
  }

  flushRun();
  return measuredTokens;
}

export function validateDocumentIndexingPolicy(
  value: unknown,
): readonly ModelValidationIssue[] {
  const issues: ModelValidationIssue[] = [];
  const root = readRecord(value, "$", ROOT_FIELDS, issues);
  if (root === undefined) {
    return issues;
  }

  const textMeasureProfile = validateTextMeasureProfile(
    root.textMeasureProfile,
    "$.textMeasureProfile",
    issues,
  );
  const segmentation = validateSegmentationPolicy(
    root.segmentation,
    "$.segmentation",
    issues,
  );
  const chunk = validateChunkPolicy(root.chunk, "$.chunk", issues);
  validateLineagePolicy(root.lineage, "$.lineage", issues);

  if (textMeasureProfile !== undefined && segmentation !== undefined) {
    requireEqual(
      segmentation.textMeasureProfileVersion,
      textMeasureProfile.version,
      "$.segmentation.textMeasureProfileVersion",
      "segmentation and text measurement profiles must use the same version",
      issues,
    );
  }
  if (textMeasureProfile !== undefined && chunk !== undefined) {
    requireEqual(
      chunk.textMeasureProfileVersion,
      textMeasureProfile.version,
      "$.chunk.textMeasureProfileVersion",
      "chunk and text measurement profiles must use the same version",
      issues,
    );
  }
  if (segmentation !== undefined && chunk !== undefined) {
    requireAtMost(
      chunk.maxChunkTokens,
      segmentation.maxUnitTokens,
      "$.chunk.maxChunkTokens",
      "maxChunkTokens must not exceed maxUnitTokens",
      issues,
    );
  }

  return issues;
}

export function parseDocumentIndexingPolicy(
  value: unknown,
): DocumentIndexingPolicySet {
  const issues = validateDocumentIndexingPolicy(value);
  if (issues.length > 0) {
    throw new DocumentIndexingPolicyValidationError(
      "DocumentIndexingPolicySet",
      issues,
    );
  }
  return DEFAULT_DOCUMENT_INDEXING_POLICY;
}

export function canonicalizeDocumentIndexingPolicy(value: unknown): string {
  const policy = parseDocumentIndexingPolicy(value);
  return JSON.stringify({
    chunk: policy.chunk,
    lineage: policy.lineage,
    segmentation: policy.segmentation,
    textMeasureProfile: policy.textMeasureProfile,
  });
}

export function digestDocumentIndexingPolicy(value: unknown): string {
  const canonical = canonicalizeDocumentIndexingPolicy(value);
  return `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}

function assertSupportedTextMeasureProfile(value: unknown): void {
  const issues: ModelValidationIssue[] = [];
  validateTextMeasureProfile(value, "textMeasureProfile", issues);
  if (issues.length > 0) {
    throw new DocumentIndexingPolicyValidationError(
      "TextMeasureProfile",
      issues,
    );
  }
}

function validateTextMeasureProfile(
  value: unknown,
  path: string,
  issues: ModelValidationIssue[],
): Readonly<Record<string, unknown>> | undefined {
  const record = readRecord(value, path, TEXT_MEASURE_FIELDS, issues);
  if (record === undefined) {
    return undefined;
  }
  requireLiteral(
    record.version,
    TEXT_MEASURE_PROFILE_VERSION,
    `${path}.version`,
    issues,
  );
  requireLiteral(
    record.algorithm,
    TEXT_MEASURE_ALGORITHM,
    `${path}.algorithm`,
    issues,
  );
  return record;
}

function validateSegmentationPolicy(
  value: unknown,
  path: string,
  issues: ModelValidationIssue[],
): Readonly<Record<string, unknown>> | undefined {
  const record = readRecord(value, path, SEGMENTATION_FIELDS, issues);
  if (record === undefined) {
    return undefined;
  }
  requireLiteral(
    record.version,
    SEGMENTATION_POLICY_VERSION,
    `${path}.version`,
    issues,
  );
  requireLiteral(
    record.textMeasureProfileVersion,
    TEXT_MEASURE_PROFILE_VERSION,
    `${path}.textMeasureProfileVersion`,
    issues,
  );
  requireFixedPositiveInteger(
    record.minUnitTokens,
    120,
    `${path}.minUnitTokens`,
    issues,
  );
  requireFixedPositiveInteger(
    record.targetUnitTokens,
    600,
    `${path}.targetUnitTokens`,
    issues,
  );
  requireFixedPositiveInteger(
    record.maxUnitTokens,
    1200,
    `${path}.maxUnitTokens`,
    issues,
  );
  requireFixedPositiveInteger(
    record.lexicalWindowBlocks,
    3,
    `${path}.lexicalWindowBlocks`,
    issues,
  );
  requireFixedFiniteNumber(
    record.boundaryMadMultiplier,
    1,
    `${path}.boundaryMadMultiplier`,
    0,
    issues,
  );
  requireFixedFiniteNumber(
    record.zeroMadMinDepth,
    0.35,
    `${path}.zeroMadMinDepth`,
    0,
    issues,
  );

  requireAtMost(
    record.minUnitTokens,
    record.targetUnitTokens,
    `${path}.minUnitTokens`,
    "minUnitTokens must not exceed targetUnitTokens",
    issues,
  );
  requireAtMost(
    record.targetUnitTokens,
    record.maxUnitTokens,
    `${path}.targetUnitTokens`,
    "targetUnitTokens must not exceed maxUnitTokens",
    issues,
  );
  return record;
}

function validateChunkPolicy(
  value: unknown,
  path: string,
  issues: ModelValidationIssue[],
): Readonly<Record<string, unknown>> | undefined {
  const record = readRecord(value, path, CHUNK_FIELDS, issues);
  if (record === undefined) {
    return undefined;
  }
  requireLiteral(
    record.version,
    CHUNK_POLICY_VERSION,
    `${path}.version`,
    issues,
  );
  requireLiteral(
    record.textMeasureProfileVersion,
    TEXT_MEASURE_PROFILE_VERSION,
    `${path}.textMeasureProfileVersion`,
    issues,
  );
  requireFixedPositiveInteger(
    record.targetChunkTokens,
    320,
    `${path}.targetChunkTokens`,
    issues,
  );
  requireFixedPositiveInteger(
    record.maxChunkTokens,
    480,
    `${path}.maxChunkTokens`,
    issues,
  );
  requireFixedNonNegativeInteger(
    record.overlapTokens,
    48,
    `${path}.overlapTokens`,
    issues,
  );

  requireAtMost(
    record.targetChunkTokens,
    record.maxChunkTokens,
    `${path}.targetChunkTokens`,
    "targetChunkTokens must not exceed maxChunkTokens",
    issues,
  );
  requireLessThan(
    record.overlapTokens,
    record.targetChunkTokens,
    `${path}.overlapTokens`,
    "overlapTokens must be less than targetChunkTokens",
    issues,
  );
  return record;
}

function validateLineagePolicy(
  value: unknown,
  path: string,
  issues: ModelValidationIssue[],
): void {
  const record = readRecord(value, path, LINEAGE_FIELDS, issues);
  if (record === undefined) {
    return;
  }
  requireLiteral(
    record.version,
    LINEAGE_POLICY_VERSION,
    `${path}.version`,
    issues,
  );
  requireFixedRatio(
    record.blockMinTokenJaccard,
    0.85,
    `${path}.blockMinTokenJaccard`,
    issues,
  );
  requireFixedRatio(
    record.blockMinRunnerUpMargin,
    0.1,
    `${path}.blockMinRunnerUpMargin`,
    issues,
  );
  requireFixedRatio(
    record.unitMinBlockIdJaccard,
    0.6,
    `${path}.unitMinBlockIdJaccard`,
    issues,
  );
  requireFixedRatio(
    record.unitMinRunnerUpMargin,
    0.15,
    `${path}.unitMinRunnerUpMargin`,
    issues,
  );
}

function readRecord(
  value: unknown,
  path: string,
  expectedFields: readonly string[],
  issues: ModelValidationIssue[],
): Readonly<Record<string, unknown>> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    issues.push(issue("invalid_value", path, "must be an object"));
    return undefined;
  }

  const record = value as Readonly<Record<string, unknown>>;
  const actualFields = Object.keys(record).sort();
  const expected = [...expectedFields].sort();
  if (
    actualFields.length !== expected.length ||
    actualFields.some((field, index) => field !== expected[index])
  ) {
    issues.push(
      issue(
        "invalid_value",
        path,
        `must contain exactly: ${expected.join(", ")}`,
      ),
    );
  }
  return record;
}

function requireLiteral(
  value: unknown,
  expected: string,
  path: string,
  issues: ModelValidationIssue[],
): void {
  if (value !== expected) {
    issues.push(
      issue(
        "invalid_discriminator",
        path,
        `must be ${JSON.stringify(expected)}`,
      ),
    );
  }
}

function requireFixedPositiveInteger(
  value: unknown,
  expected: number,
  path: string,
  issues: ModelValidationIssue[],
): void {
  requireFixedNumber(value, expected, path, Number.isInteger, "> 0", issues, 0);
}

function requireFixedNonNegativeInteger(
  value: unknown,
  expected: number,
  path: string,
  issues: ModelValidationIssue[],
): void {
  requireFixedNumber(value, expected, path, Number.isInteger, ">= 0", issues, -1);
}

function requireFixedRatio(
  value: unknown,
  expected: number,
  path: string,
  issues: ModelValidationIssue[],
): void {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 1
  ) {
    issues.push(
      issue("invalid_value", path, "must be a finite number from 0 to 1"),
    );
    return;
  }
  requireFixedValue(value, expected, path, issues);
}

function requireFixedFiniteNumber(
  value: unknown,
  expected: number,
  path: string,
  minimum: number,
  issues: ModelValidationIssue[],
): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum) {
    issues.push(
      issue(
        "invalid_value",
        path,
        `must be a finite number >= ${minimum}`,
      ),
    );
    return;
  }
  requireFixedValue(value, expected, path, issues);
}

function requireFixedNumber(
  value: unknown,
  expected: number,
  path: string,
  predicate: (value: number) => boolean,
  comparison: string,
  issues: ModelValidationIssue[],
  minimumExclusive: number,
): void {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    !predicate(value) ||
    value <= minimumExclusive
  ) {
    issues.push(issue("invalid_value", path, `must be an integer ${comparison}`));
    return;
  }
  requireFixedValue(value, expected, path, issues);
}

function requireFixedValue(
  value: number,
  expected: number,
  path: string,
  issues: ModelValidationIssue[],
): void {
  if (value !== expected) {
    issues.push(
      issue(
        "invalid_value",
        path,
        `is fixed at ${expected} for the current policy version; use a new version for different semantics`,
      ),
    );
  }
}

function requireEqual(
  left: unknown,
  right: unknown,
  path: string,
  message: string,
  issues: ModelValidationIssue[],
): void {
  if (left !== right) {
    issues.push(issue("relationship_mismatch", path, message));
  }
}

function requireAtMost(
  left: unknown,
  right: unknown,
  path: string,
  message: string,
  issues: ModelValidationIssue[],
): void {
  if (typeof left === "number" && typeof right === "number" && left > right) {
    issues.push(issue("relationship_mismatch", path, message));
  }
}

function requireLessThan(
  left: unknown,
  right: unknown,
  path: string,
  message: string,
  issues: ModelValidationIssue[],
): void {
  if (typeof left === "number" && typeof right === "number" && left >= right) {
    issues.push(issue("relationship_mismatch", path, message));
  }
}
