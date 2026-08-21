import type {
  DocumentSemanticUnit,
  ManagedChunk,
  NormalizedDocument,
} from "./document-model.js";
import {
  validateEmbeddingProfile,
  type EmbeddingProfile,
} from "./embedding-profile.js";
import {
  assertNoModelIssues,
  isDigest,
  isId,
  isIsoTimestamp,
  isRevisionId,
  isUuidV7Id,
  issue,
  type ModelValidationIssue,
} from "./model-validation.js";
import {
  canonicalDigest,
  canonicalJson,
  revisionIdentity,
  stableIdentity,
} from "./revision-identity.js";

/**
 * Immutable receipt for a completely published document index. It pins every
 * policy and model revision needed to audit the record set without leaking the
 * vector store's physical collection layout.
 */
export interface IndexManifest {
  readonly manifestSchemaVersion: 2;
  readonly stateNamespaceId: string;
  readonly securityDomain: string;
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
  readonly payloadSchemaVersion: 2;
  readonly semanticUnitRevisions: Readonly<Record<string, string>>;
  readonly chunkRevisions: Readonly<Record<string, string>>;
  readonly chunkBindings: Readonly<Record<string, IndexChunkBinding>>;
  readonly recordCount: number;
  readonly recordSetDigest: string;
  readonly scopeRevisions: readonly ScopeRevision[];
  readonly fallbackCounts: Readonly<Record<string, number>>;
  readonly publishedAt: string;
}

/** Immutable ownership proof for one Chunk in a published Index version. */
export interface IndexChunkBinding {
  readonly chunkRevisionId: string;
  readonly semanticUnitId: string;
  readonly semanticUnitRevisionId: string;
  readonly contentDigest: string;
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
  readonly retrievalText: string;
  readonly metadata: VectorIndexRecordMetadata;
}

export interface VectorIndexRecordMetadata {
  readonly payloadSchemaVersion: 2;
  readonly stateNamespaceId: string;
  readonly securityDomain: string;
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

export interface IndexVersionInput {
  readonly document: NormalizedDocument;
  readonly semanticUnits: readonly DocumentSemanticUnit[];
  readonly chunks: readonly ManagedChunk[];
  readonly embeddingProfile: EmbeddingProfile;
  readonly segmentationPolicyVersion: string;
  readonly chunkPolicyVersion: string;
  readonly textMeasureProfileVersion: string;
  readonly payloadSchemaVersion: 2;
}

/** Stable logical index identity for one Source document resource. */
export function createDocumentIndexId(
  sourceId: string,
  documentId: string,
): string {
  return stableIdentity("didx", { sourceId, documentId });
}

/** Immutable build identity for one complete searchable document snapshot. */
export function createIndexVersion(input: IndexVersionInput): string {
  const chunkBindings = createIndexChunkBindings(
    input.semanticUnits,
    input.chunks,
  );
  return revisionIdentity("idxv", {
    sourceId: input.document.sourceId,
    observationId: input.document.observationId,
    documentId: input.document.documentId,
    documentContentDigest: input.document.contentDigest,
    documentSchemaVersion: input.document.schemaVersion,
    parser: input.document.parser,
    normalizationPolicyVersion: input.document.normalizationPolicyVersion,
    lineagePolicyVersion: input.document.lineagePolicyVersion,
    segmentationPolicyVersion: input.segmentationPolicyVersion,
    chunkPolicyVersion: input.chunkPolicyVersion,
    textMeasureProfileVersion: input.textMeasureProfileVersion,
    embeddingProfile: input.embeddingProfile,
    payloadSchemaVersion: input.payloadSchemaVersion,
    semanticUnitRevisions: revisionEntries(
      input.semanticUnits.map((unit) => [unit.id, unit.revisionId]),
    ),
    chunkRevisions: revisionEntries(
      input.chunks.map((chunk) => [chunk.id, chunk.revisionId]),
    ),
    chunkBindings: chunkBindingEntries(chunkBindings),
  });
}

/** Canonical checksum required by the Index Manifest design contract. */
export function computeRecordSetDigest(
  chunkBindings: Readonly<Record<string, IndexChunkBinding>>,
  payloadSchemaVersion: 2 = 2,
): string {
  return canonicalDigest(
    chunkBindingEntries(chunkBindings).map(([chunkId, binding]) => [
      chunkId,
      binding.chunkRevisionId,
      binding.semanticUnitId,
      binding.semanticUnitRevisionId,
      binding.contentDigest,
      String(payloadSchemaVersion),
    ]),
  );
}

/** Builds the canonical Chunk-to-Unit ownership map for one snapshot. */
export function createIndexChunkBindings(
  semanticUnits: readonly DocumentSemanticUnit[],
  chunks: readonly ManagedChunk[],
): Readonly<Record<string, IndexChunkBinding>> {
  const unitRevisionById = new Map(
    semanticUnits.map((unit) => [unit.id, unit.revisionId]),
  );
  const bindings: Record<string, IndexChunkBinding> = {};
  for (const chunk of chunks) {
    const semanticUnitRevisionId = unitRevisionById.get(chunk.semanticUnitId);
    if (
      semanticUnitRevisionId === undefined ||
      Object.hasOwn(bindings, chunk.id)
    ) {
      throw new TypeError("managed Chunk ownership is invalid");
    }
    bindings[chunk.id] = {
      chunkRevisionId: chunk.revisionId,
      semanticUnitId: chunk.semanticUnitId,
      semanticUnitRevisionId,
      contentDigest: chunk.contentDigest,
    };
  }
  return Object.fromEntries(chunkBindingEntries(bindings));
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

  if (manifest.manifestSchemaVersion !== 2) {
    issues.push(
      issue(
        "invalid_value",
        "manifestSchemaVersion",
        "document index requires manifest schema version 2",
      ),
    );
  }
  validateId(manifest.documentIndexId, "didx", "documentIndexId", issues);
  validateNonEmpty(manifest.stateNamespaceId, "stateNamespaceId", issues);
  validateNonEmpty(manifest.securityDomain, "securityDomain", issues);
  validateRevision(manifest.indexVersion, "idxv", "indexVersion", issues);
  validateUuidV7Id(manifest.sourceId, "src", "sourceId", issues);
  validateUuidV7Id(manifest.observationId, "obs", "observationId", issues);
  validateUuidV7Id(manifest.documentId, "doc", "documentId", issues);
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
  issues.push(...validateEmbeddingProfile(manifest.embeddingProfile));
  if (manifest.payloadSchemaVersion !== 2) {
    issues.push(
      issue(
        "invalid_value",
        "payloadSchemaVersion",
        "document index requires payload schema version 2",
      ),
    );
  }
  if (
    manifest.embeddingProfile.textMeasureProfileVersion !==
    manifest.textMeasureProfileVersion
  ) {
    issues.push(
      issue(
        "relationship_mismatch",
        "embeddingProfile.textMeasureProfileVersion",
        "embedding and manifest text measure profiles must match",
      ),
    );
  }

  let expectedChunkBindings: Readonly<Record<string, IndexChunkBinding>> = {};
  try {
    expectedChunkBindings = createIndexChunkBindings(semanticUnits, chunks);
  } catch {
    issues.push(
      issue(
        "relationship_mismatch",
        "chunkBindings",
        "managed Chunk ownership must resolve to one Semantic Unit revision",
      ),
    );
  }
  validateChunkBindings(
    manifest.chunkBindings,
    expectedChunkBindings,
    manifest.semanticUnitRevisions,
    issues,
  );
  const expectedRecordSetDigest = computeRecordSetDigest(
    expectedChunkBindings,
    manifest.payloadSchemaVersion,
  );
  if (manifest.recordSetDigest !== expectedRecordSetDigest) {
    issues.push(
      issue(
        "relationship_mismatch",
        "recordSetDigest",
        "record set digest must match the canonical managed chunk set",
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
    if (chunk.tokenCount > manifest.embeddingProfile.maxInputTokens) {
      issues.push(
        issue(
          "invalid_value",
          `chunks[${index}].tokenCount`,
          "chunk exceeds the embedding profile input limit",
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
  if (
    computeRecordSetDigest(
      manifest.chunkBindings,
      manifest.payloadSchemaVersion,
    ) !== manifest.recordSetDigest
  ) {
    issues.push(
      issue(
        "relationship_mismatch",
        "records",
        "vector record checksum must match the manifest",
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
    const binding = manifest.chunkBindings[metadata.chunkId];
    const matches =
      metadata.payloadSchemaVersion === manifest.payloadSchemaVersion &&
      metadata.stateNamespaceId === manifest.stateNamespaceId &&
      metadata.securityDomain === manifest.securityDomain &&
      metadata.sourceId === manifest.sourceId &&
      metadata.observationId === manifest.observationId &&
      metadata.documentId === manifest.documentId &&
      metadata.documentIndexId === manifest.documentIndexId &&
      metadata.indexVersion === manifest.indexVersion &&
      metadata.semanticUnitId === chunk.semanticUnitId &&
      metadata.chunkId === chunk.id &&
      metadata.chunkRevisionId === chunk.revisionId &&
      metadata.contentDigest === chunk.contentDigest &&
      binding !== undefined &&
      binding.chunkRevisionId === metadata.chunkRevisionId &&
      binding.semanticUnitId === metadata.semanticUnitId &&
      binding.semanticUnitRevisionId ===
        manifest.semanticUnitRevisions[metadata.semanticUnitId] &&
      binding.contentDigest === metadata.contentDigest &&
      record.retrievalText === chunk.text &&
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

function revisionEntries(
  entries: readonly (readonly [string, string])[],
): readonly (readonly [string, string])[] {
  return [...entries].sort(([left], [right]) => left.localeCompare(right));
}

function chunkBindingEntries(
  bindings: Readonly<Record<string, IndexChunkBinding>>,
): readonly (readonly [string, IndexChunkBinding])[] {
  return Object.entries(bindings).sort(([left], [right]) =>
    left.localeCompare(right),
  );
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
    validateUuidV7Id(id, idPrefix, `${path}.${id}`, issues);
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

function validateChunkBindings(
  actual: Readonly<Record<string, IndexChunkBinding>>,
  expected: Readonly<Record<string, IndexChunkBinding>>,
  semanticUnitRevisions: Readonly<Record<string, string>>,
  issues: ModelValidationIssue[],
): void {
  if (Object.keys(actual).length !== Object.keys(expected).length) {
    issues.push(
      issue(
        "count_mismatch",
        "chunkBindings",
        "Chunk bindings must contain exactly the validated managed Chunks",
      ),
    );
  }
  for (const [chunkId, binding] of Object.entries(actual)) {
    const path = `chunkBindings.${chunkId}`;
    validateUuidV7Id(chunkId, "chk", path, issues);
    validateRevision(
      binding.chunkRevisionId,
      "crv",
      `${path}.chunkRevisionId`,
      issues,
    );
    validateUuidV7Id(
      binding.semanticUnitId,
      "unit",
      `${path}.semanticUnitId`,
      issues,
    );
    validateRevision(
      binding.semanticUnitRevisionId,
      "urv",
      `${path}.semanticUnitRevisionId`,
      issues,
    );
    validateDigest(binding.contentDigest, `${path}.contentDigest`, issues);
    if (
      canonicalJson(binding) !== canonicalJson(expected[chunkId]) ||
      semanticUnitRevisions[binding.semanticUnitId] !==
        binding.semanticUnitRevisionId
    ) {
      issues.push(
        issue(
          "relationship_mismatch",
          path,
          "Chunk binding must match its immutable Chunk and Semantic Unit revisions",
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

function validateUuidV7Id(
  value: string,
  prefix: string,
  path: string,
  issues: ModelValidationIssue[],
): void {
  if (!isUuidV7Id(value, prefix)) {
    issues.push(
      issue(
        "invalid_id",
        path,
        `expected ${prefix}_ identifier with UUIDv7 body`,
      ),
    );
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
