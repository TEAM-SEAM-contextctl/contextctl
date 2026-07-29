import type {
  DocumentSemanticUnit,
  ManagedChunk,
  NormalizedDocument,
} from "./document-model.js";
import {
  assertNoModelIssues,
  isDigest,
  isId,
  isIsoTimestamp,
  isRevisionId,
  issue,
  type ModelValidationIssue,
} from "./model-validation.js";

/** Reproducibility contract for vectors written under one index version. */
export interface EmbeddingProfile {
  readonly id: string;
  readonly version: string;
  readonly dimensions: number;
  readonly distance: "cosine" | "dot" | "euclid";
}

/**
 * Immutable receipt for a completely published document index. It pins every
 * policy and model revision needed to audit the record set without leaking the
 * vector store's physical collection layout.
 */
export interface IndexManifest {
  readonly documentIndexId: string;
  readonly indexVersion: string;
  readonly sourceId: string;
  readonly observationId: string;
  readonly documentId: string;
  readonly documentSchemaVersion: number;
  readonly parserVersion: string;
  readonly normalizationPolicyVersion: string;
  readonly lineagePolicyVersion: string;
  readonly segmentationPolicyVersion: string;
  readonly chunkPolicyVersion: string;
  readonly textMeasureProfileVersion: string;
  readonly embeddingProfile: EmbeddingProfile;
  readonly payloadSchemaVersion: 1;
  readonly semanticUnitRevisions: Readonly<Record<string, string>>;
  readonly chunkRevisions: Readonly<Record<string, string>>;
  readonly recordCount: number;
  readonly recordSetDigest: string;
  readonly scopeRevisions: readonly ScopeRevision[];
  readonly fallbackCounts: Readonly<Record<string, number>>;
  readonly publishedAt: string;
}

export interface ScopeRevision {
  readonly scopeId: string;
  readonly scopeVersion: string;
}

/** One vector payload for one immutable Managed Chunk revision. */
export interface VectorIndexRecord {
  readonly recordId: string;
  readonly chunkRevisionId: string;
  readonly embedding: readonly number[];
  readonly metadata: VectorIndexRecordMetadata;
}

export interface VectorIndexRecordMetadata {
  readonly payloadSchemaVersion: 1;
  readonly sourceId: string;
  readonly observationId: string;
  readonly documentId: string;
  readonly documentIndexId: string;
  readonly indexVersion: string;
  readonly semanticUnitId: string;
  readonly chunkId: string;
  readonly chunkRevisionId: string;
  readonly contentDigest: string;
}

export interface IndexManifestValidationInput {
  readonly document: NormalizedDocument;
  readonly semanticUnits: readonly DocumentSemanticUnit[];
  readonly chunks: readonly ManagedChunk[];
  readonly manifest: IndexManifest;
}

/**
 * Verifies that a manifest describes exactly one normalized document snapshot
 * and the complete Unit and Chunk revision sets produced from it.
 */
export function validateIndexManifest(
  input: IndexManifestValidationInput,
): readonly ModelValidationIssue[] {
  const { document, semanticUnits, chunks, manifest } = input;
  const issues: ModelValidationIssue[] = [];

  validateId(manifest.documentIndexId, "didx", "documentIndexId", issues);
  validateRevision(manifest.indexVersion, "idxv", "indexVersion", issues);
  validateId(manifest.sourceId, "src", "sourceId", issues);
  validateId(manifest.observationId, "obs", "observationId", issues);
  validateId(manifest.documentId, "doc", "documentId", issues);
  validateDigest(manifest.recordSetDigest, "recordSetDigest", issues);
  validateNonEmpty(manifest.parserVersion, "parserVersion", issues);
  validateNonEmpty(
    manifest.normalizationPolicyVersion,
    "normalizationPolicyVersion",
    issues,
  );
  validateNonEmpty(
    manifest.lineagePolicyVersion,
    "lineagePolicyVersion",
    issues,
  );
  validateNonEmpty(
    manifest.segmentationPolicyVersion,
    "segmentationPolicyVersion",
    issues,
  );
  validateNonEmpty(manifest.chunkPolicyVersion, "chunkPolicyVersion", issues);
  validateNonEmpty(
    manifest.textMeasureProfileVersion,
    "textMeasureProfileVersion",
    issues,
  );
  validateNonEmpty(manifest.embeddingProfile.id, "embeddingProfile.id", issues);
  validateNonEmpty(
    manifest.embeddingProfile.version,
    "embeddingProfile.version",
    issues,
  );

  if (
    !Number.isInteger(manifest.embeddingProfile.dimensions) ||
    manifest.embeddingProfile.dimensions <= 0
  ) {
    issues.push(
      issue(
        "invalid_value",
        "embeddingProfile.dimensions",
        "embedding dimensions must be a positive integer",
      ),
    );
  }
  if (!isIsoTimestamp(manifest.publishedAt)) {
    issues.push(
      issue(
        "invalid_value",
        "publishedAt",
        "published timestamp must be canonical ISO-8601 UTC",
      ),
    );
  }
  if (
    manifest.sourceId !== document.sourceId ||
    manifest.observationId !== document.observationId ||
    manifest.documentId !== document.documentId
  ) {
    issues.push(
      issue(
        "relationship_mismatch",
        "manifest",
        "manifest must belong to the validated document snapshot",
      ),
    );
  }
  if (
    manifest.documentSchemaVersion !== document.schemaVersion ||
    manifest.parserVersion !== document.parser.version ||
    manifest.normalizationPolicyVersion !==
      document.normalizationPolicyVersion ||
    manifest.lineagePolicyVersion !== document.lineagePolicyVersion
  ) {
    issues.push(
      issue(
        "relationship_mismatch",
        "manifest",
        "manifest document and parser versions must match the document",
      ),
    );
  }

  validateRevisionMap(
    manifest.semanticUnitRevisions,
    semanticUnits.map((unit) => [unit.id, unit.revisionId]),
    "semanticUnitRevisions",
    "unit",
    "urv",
    issues,
  );
  validateRevisionMap(
    manifest.chunkRevisions,
    chunks.map((chunk) => [chunk.id, chunk.revisionId]),
    "chunkRevisions",
    "chk",
    "crv",
    issues,
  );

  semanticUnits.forEach((unit, index) => {
    if (unit.segmentationPolicyVersion !== manifest.segmentationPolicyVersion) {
      issues.push(
        issue(
          "relationship_mismatch",
          `semanticUnits[${index}].segmentationPolicyVersion`,
          "semantic unit policy must match the manifest",
        ),
      );
    }
  });
  chunks.forEach((chunk, index) => {
    if (
      chunk.chunkPolicyVersion !== manifest.chunkPolicyVersion ||
      chunk.textMeasureProfileVersion !== manifest.textMeasureProfileVersion
    ) {
      issues.push(
        issue(
          "relationship_mismatch",
          `chunks[${index}]`,
          "chunk policy and text measure versions must match the manifest",
        ),
      );
    }
  });

  if (
    !Number.isInteger(manifest.recordCount) ||
    manifest.recordCount < 0 ||
    manifest.recordCount !== chunks.length
  ) {
    issues.push(
      issue(
        "count_mismatch",
        "recordCount",
        "record count must equal the managed chunk count",
      ),
    );
  }

  const seenScopes = new Set<string>();
  if (manifest.scopeRevisions.length === 0) {
    issues.push(
      issue(
        "invalid_value",
        "scopeRevisions",
        "published document index requires at least one retrieval scope",
      ),
    );
  }
  manifest.scopeRevisions.forEach((scope, index) => {
    const path = `scopeRevisions[${index}]`;
    validateId(scope.scopeId, "scope", `${path}.scopeId`, issues);
    validateRevision(
      scope.scopeVersion,
      "scpv",
      `${path}.scopeVersion`,
      issues,
    );
    const identity = `${scope.scopeId}:${scope.scopeVersion}`;
    if (seenScopes.has(identity)) {
      issues.push(
        issue(
          "duplicate_reference",
          path,
          "scope revision must not be repeated",
        ),
      );
    }
    seenScopes.add(identity);
  });

  for (const [fallback, count] of Object.entries(manifest.fallbackCounts)) {
    if (fallback.length === 0 || !Number.isInteger(count) || count < 0) {
      issues.push(
        issue(
          "invalid_value",
          `fallbackCounts.${fallback}`,
          "fallback count must use a non-empty key and non-negative integer",
        ),
      );
    }
  }

  return issues;
}

export function assertValidIndexManifest(
  input: IndexManifestValidationInput,
): void {
  assertNoModelIssues("IndexManifest", validateIndexManifest(input));
}

/**
 * Verifies a one-to-one correspondence between manifest Chunk revisions and
 * vector records, including embedding shape and immutable lineage metadata.
 */
export function validateVectorIndexRecords(
  manifest: IndexManifest,
  chunks: readonly ManagedChunk[],
  records: readonly VectorIndexRecord[],
): readonly ModelValidationIssue[] {
  const issues: ModelValidationIssue[] = [];
  const chunkByRevision = new Map(
    chunks.map((chunk) => [chunk.revisionId, chunk]),
  );
  const recordIds = new Set<string>();
  const recordedChunkRevisions = new Set<string>();

  if (records.length !== manifest.recordCount) {
    issues.push(
      issue(
        "count_mismatch",
        "records",
        "vector record count must match the manifest",
      ),
    );
  }

  records.forEach((record, index) => {
    const path = `records[${index}]`;
    validateRevision(record.recordId, "vrec", `${path}.recordId`, issues);
    validateRevision(
      record.chunkRevisionId,
      "crv",
      `${path}.chunkRevisionId`,
      issues,
    );
    if (recordIds.has(record.recordId)) {
      issues.push(
        issue("duplicate_id", `${path}.recordId`, "record ID must be unique"),
      );
    }
    recordIds.add(record.recordId);
    if (recordedChunkRevisions.has(record.chunkRevisionId)) {
      issues.push(
        issue(
          "duplicate_reference",
          `${path}.chunkRevisionId`,
          "chunk revision may have only one vector record per index version",
        ),
      );
    }
    recordedChunkRevisions.add(record.chunkRevisionId);

    if (
      record.embedding.length !== manifest.embeddingProfile.dimensions ||
      record.embedding.some((component) => !Number.isFinite(component))
    ) {
      issues.push(
        issue(
          "count_mismatch",
          `${path}.embedding`,
          "embedding must contain the configured number of finite dimensions",
        ),
      );
    }

    const chunk = chunkByRevision.get(record.chunkRevisionId);
    if (chunk === undefined) {
      issues.push(
        issue(
          "invalid_reference",
          `${path}.chunkRevisionId`,
          "record must reference a manifest chunk revision",
        ),
      );
      return;
    }

    const metadata = record.metadata;
    const matches =
      metadata.sourceId === manifest.sourceId &&
      metadata.observationId === manifest.observationId &&
      metadata.documentId === manifest.documentId &&
      metadata.documentIndexId === manifest.documentIndexId &&
      metadata.indexVersion === manifest.indexVersion &&
      metadata.semanticUnitId === chunk.semanticUnitId &&
      metadata.chunkId === chunk.id &&
      metadata.chunkRevisionId === chunk.revisionId &&
      metadata.contentDigest === chunk.contentDigest &&
      record.chunkRevisionId === metadata.chunkRevisionId;
    if (!matches) {
      issues.push(
        issue(
          "relationship_mismatch",
          `${path}.metadata`,
          "record metadata must match its immutable manifest and chunk",
        ),
      );
    }
  });

  for (const chunk of chunks) {
    if (!recordedChunkRevisions.has(chunk.revisionId)) {
      issues.push(
        issue(
          "missing_reference",
          "records",
          `chunk revision ${chunk.revisionId} has no vector record`,
        ),
      );
    }
  }

  return issues;
}

export function assertValidVectorIndexRecords(
  manifest: IndexManifest,
  chunks: readonly ManagedChunk[],
  records: readonly VectorIndexRecord[],
): void {
  assertNoModelIssues(
    "VectorIndexRecord",
    validateVectorIndexRecords(manifest, chunks, records),
  );
}

function validateRevisionMap(
  actual: Readonly<Record<string, string>>,
  expectedEntries: readonly (readonly [string, string])[],
  path: string,
  idPrefix: string,
  revisionPrefix: string,
  issues: ModelValidationIssue[],
): void {
  const expected = new Map(expectedEntries);
  if (Object.keys(actual).length !== expected.size) {
    issues.push(
      issue(
        "count_mismatch",
        path,
        "revision map must contain exactly the validated model revisions",
      ),
    );
  }

  for (const [id, revision] of Object.entries(actual)) {
    validateId(id, idPrefix, `${path}.${id}`, issues);
    validateRevision(revision, revisionPrefix, `${path}.${id}`, issues);
    if (expected.get(id) !== revision) {
      issues.push(
        issue(
          "relationship_mismatch",
          `${path}.${id}`,
          "revision must match the validated model",
        ),
      );
    }
  }
}

function validateId(
  value: string,
  prefix: string,
  path: string,
  issues: ModelValidationIssue[],
): void {
  if (!isId(value, prefix)) {
    issues.push(issue("invalid_id", path, `expected ${prefix}_ identifier`));
  }
}

function validateRevision(
  value: string,
  prefix: string,
  path: string,
  issues: ModelValidationIssue[],
): void {
  if (!isRevisionId(value, prefix)) {
    issues.push(
      issue("invalid_id", path, `expected ${prefix}_ revision identifier`),
    );
  }
}

function validateDigest(
  value: string,
  path: string,
  issues: ModelValidationIssue[],
): void {
  if (!isDigest(value)) {
    issues.push(issue("invalid_digest", path, "expected sha256 digest"));
  }
}

function validateNonEmpty(
  value: string,
  path: string,
  issues: ModelValidationIssue[],
): void {
  if (value.length === 0) {
    issues.push(issue("invalid_value", path, "value must not be empty"));
  }
}
