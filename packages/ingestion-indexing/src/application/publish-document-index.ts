import type { PublishedDocumentScope } from "@contextctl/contracts";

import type { ChunkEmbedding } from "./embed-managed-chunks.js";
import {
  createPublishedDocumentScopes,
  type SemanticPublishedScopeInput,
} from "./published-document-scope.js";
import type {
  DocumentSemanticUnit,
  ManagedChunk,
  NormalizedDocument,
} from "../domain/document-model.js";
import {
  assertValidDocumentSemanticUnits,
  assertValidManagedChunks,
  assertValidNormalizedDocument,
} from "../domain/document-model.js";
import type { EmbeddingProfile } from "../domain/embedding-profile.js";
import {
  assertValidIndexManifest,
  assertValidVectorIndexRecords,
  computeRecordSetDigest,
  createDocumentIndexId,
  createIndexVersion,
  type IndexManifest,
  type VectorIndexRecord,
} from "../domain/index-manifest.js";
import { canonicalJson } from "../domain/revision-identity.js";
import { createVectorRecordId } from "../domain/vector-index.js";
import {
  IndexPublicationStoreConflict,
  type IndexPublicationStore,
  type PublishedIndexVersion,
} from "../ports/index-publication-store.js";
import type {
  VectorIndexCompatibility,
  VectorIndexPort,
  VectorIndexStoredRecord,
} from "../ports/vector-index.js";

export interface PublishDocumentIndexCommand {
  readonly document: NormalizedDocument;
  readonly semanticUnits: readonly DocumentSemanticUnit[];
  readonly chunks: readonly ManagedChunk[];
  readonly embeddings: readonly ChunkEmbedding[];
  readonly embeddingProfile: EmbeddingProfile;
  readonly connectorId: string;
  readonly securityDomain: string;
  readonly semanticScopes?: readonly SemanticPublishedScopeInput[];
}

export interface DocumentIndexPublisherDependencies {
  readonly vectorIndex: VectorIndexPort;
  readonly publications: IndexPublicationStore;
  readonly batchSize?: number;
  readonly clock?: () => string;
}

export type DocumentIndexPublicationErrorCode =
  | "conflicting_index_version"
  | "invalid_input"
  | "staged_record_mismatch";

export class DocumentIndexPublicationError extends Error {
  constructor(readonly code: DocumentIndexPublicationErrorCode) {
    super(`Document index publication failed: ${code}`);
    this.name = "DocumentIndexPublicationError";
  }
}

export class DocumentIndexPublisher {
  readonly #vectorIndex: VectorIndexPort;
  readonly #publications: IndexPublicationStore;
  readonly #batchSize: number;
  readonly #clock: () => string;

  constructor(dependencies: DocumentIndexPublisherDependencies) {
    if (
      dependencies.batchSize !== undefined &&
      (!Number.isSafeInteger(dependencies.batchSize) ||
        dependencies.batchSize <= 0)
    ) {
      throw new TypeError("document index publication batch size is invalid");
    }
    this.#vectorIndex = dependencies.vectorIndex;
    this.#publications = dependencies.publications;
    this.#batchSize = dependencies.batchSize ?? 64;
    this.#clock = dependencies.clock ?? (() => new Date().toISOString());
  }

  async publish(
    command: PublishDocumentIndexCommand,
  ): Promise<PublishedIndexVersion> {
    const prepared = preparePublication(command);
    const existing = await this.#publications.findVersion({
      documentIndexId: prepared.documentIndexId,
      indexVersion: prepared.indexVersion,
    });
    if (existing !== undefined) {
      if (!matchesRequestedPublication(existing, prepared)) {
        throw new DocumentIndexPublicationError("conflicting_index_version");
      }
      return existing;
    }

    const compatibility: VectorIndexCompatibility = {
      securityDomain: command.securityDomain,
      embeddingProfile: command.embeddingProfile,
      payloadSchemaVersion: 2,
    };
    const vectorTarget = await this.#vectorIndex.prepare(compatibility);
    const scopes = createPublishedDocumentScopes({
      manifest: prepared.manifestDraft,
      connectorId: command.connectorId,
      accessHandle: vectorTarget.accessHandle,
      ...(command.semanticScopes === undefined
        ? {}
        : { semanticScopes: command.semanticScopes }),
    });
    const manifest: IndexManifest = {
      ...prepared.manifestDraft,
      recordSetDigest: computeRecordSetDigest(prepared.records),
      scopeRevisions: scopeRevisions(scopes),
      publishedAt: this.#clock(),
    };
    assertValidInput(() => {
      assertValidIndexManifest({
        document: command.document,
        semanticUnits: command.semanticUnits,
        chunks: command.chunks,
        manifest,
      });
      assertValidVectorIndexRecords(manifest, command.chunks, prepared.records);
    });

    const stagedBefore = await this.#vectorIndex.listVersionRecords({
      accessHandle: vectorTarget.accessHandle,
      documentIndexId: manifest.documentIndexId,
      indexVersion: manifest.indexVersion,
    });
    const missing = assertCompatibleStaging(stagedBefore, prepared.records);
    for (let offset = 0; offset < missing.length; offset += this.#batchSize) {
      const batch = missing.slice(offset, offset + this.#batchSize);
      if (batch.length > 0) {
        await this.#vectorIndex.upsertRecords({
          accessHandle: vectorTarget.accessHandle,
          embeddingProfile: command.embeddingProfile,
          records: batch,
        });
      }
    }

    const stagedAfter = await this.#vectorIndex.listVersionRecords({
      accessHandle: vectorTarget.accessHandle,
      documentIndexId: manifest.documentIndexId,
      indexVersion: manifest.indexVersion,
    });
    assertCompleteStaging(
      manifest,
      command.chunks,
      stagedAfter,
      prepared.records,
    );

    const publication: PublishedIndexVersion = {
      manifest,
      securityDomain: command.securityDomain,
      documentIndex: scopes[0]!.documentIndex,
      scopes,
    };
    try {
      return (await this.#publications.commitCurrent(publication)).publication;
    } catch (error) {
      if (error instanceof IndexPublicationStoreConflict) {
        throw new DocumentIndexPublicationError("conflicting_index_version");
      }
      throw error;
    }
  }
}

interface PreparedPublication {
  readonly documentIndexId: string;
  readonly indexVersion: string;
  readonly manifestDraft: Omit<
    IndexManifest,
    "publishedAt" | "recordSetDigest" | "scopeRevisions"
  > & {
    readonly publishedAt: string;
    readonly recordSetDigest: string;
    readonly scopeRevisions: readonly [];
  };
  readonly records: readonly VectorIndexRecord[];
  readonly requestedScopeShape: readonly unknown[];
  readonly connectorId: string;
  readonly securityDomain: string;
}

function preparePublication(
  command: PublishDocumentIndexCommand,
): PreparedPublication {
  if (
    command.semanticUnits.length === 0 ||
    command.chunks.length === 0 ||
    command.embeddings.length !== command.chunks.length
  ) {
    throw new DocumentIndexPublicationError("invalid_input");
  }
  assertValidInput(() => {
    assertValidNormalizedDocument(command.document);
    assertValidDocumentSemanticUnits(command.document, command.semanticUnits);
    assertValidManagedChunks(
      command.document,
      command.semanticUnits,
      command.chunks,
    );
  });
  const segmentationPolicyVersion = command.semanticUnits[0]!.segmentationPolicyVersion;
  const chunkPolicyVersion = command.chunks[0]!.chunkPolicyVersion;
  const textMeasureProfileVersion = command.chunks[0]!.textMeasureProfileVersion;
  const documentIndexId = createDocumentIndexId(
    command.document.sourceId,
    command.document.documentId,
  );
  const indexVersion = createIndexVersion({
    document: command.document,
    semanticUnits: command.semanticUnits,
    chunks: command.chunks,
    embeddingProfile: command.embeddingProfile,
    segmentationPolicyVersion,
    chunkPolicyVersion,
    textMeasureProfileVersion,
    payloadSchemaVersion: 2,
  });
  const embeddingByRevision = new Map(
    command.embeddings.map((embedding) => [embedding.chunkRevisionId, embedding]),
  );
  const records = command.chunks.map((chunk): VectorIndexRecord => {
    const embedding = embeddingByRevision.get(chunk.revisionId);
    if (
      embedding === undefined ||
      embedding.chunkId !== chunk.id ||
      embedding.contentDigest !== chunk.contentDigest
    ) {
      throw new DocumentIndexPublicationError("invalid_input");
    }
    return {
      recordId: createVectorRecordId(
        documentIndexId,
        indexVersion,
        chunk.revisionId,
      ),
      chunkRevisionId: chunk.revisionId,
      embedding: embedding.vector,
      retrievalText: chunk.text,
      metadata: {
        payloadSchemaVersion: 2,
        sourceId: command.document.sourceId,
        observationId: command.document.observationId,
        documentId: command.document.documentId,
        documentIndexId,
        indexVersion,
        semanticUnitId: chunk.semanticUnitId,
        chunkId: chunk.id,
        chunkRevisionId: chunk.revisionId,
        contentDigest: chunk.contentDigest,
      },
    };
  });
  if (new Set(records.map((record) => record.chunkRevisionId)).size !== records.length) {
    throw new DocumentIndexPublicationError("invalid_input");
  }
  const manifestDraft = {
    documentIndexId,
    indexVersion,
    sourceId: command.document.sourceId,
    observationId: command.document.observationId,
    documentId: command.document.documentId,
    documentSchemaVersion: command.document.schemaVersion,
    parserVersion: command.document.parser.version,
    normalizationPolicyVersion: command.document.normalizationPolicyVersion,
    lineagePolicyVersion: command.document.lineagePolicyVersion,
    segmentationPolicyVersion,
    chunkPolicyVersion,
    textMeasureProfileVersion,
    embeddingProfile: command.embeddingProfile,
    payloadSchemaVersion: 2 as const,
    semanticUnitRevisions: sortedRevisionMap(
      command.semanticUnits.map((unit) => [unit.id, unit.revisionId]),
    ),
    chunkRevisions: sortedRevisionMap(
      command.chunks.map((chunk) => [chunk.id, chunk.revisionId]),
    ),
    recordCount: records.length,
    recordSetDigest: computeRecordSetDigest(records),
    scopeRevisions: [] as const,
    fallbackCounts: fallbackCounts(command),
    publishedAt: "1970-01-01T00:00:00.000Z",
  };
  const requestedScopes = createPublishedDocumentScopes({
    manifest: manifestDraft,
    connectorId: command.connectorId,
    accessHandle: "opaque:pending",
    ...(command.semanticScopes === undefined
      ? {}
      : { semanticScopes: command.semanticScopes }),
  });
  return {
    documentIndexId,
    indexVersion,
    manifestDraft,
    records,
    requestedScopeShape: requestedScopes.map(scopeShape),
    connectorId: command.connectorId,
    securityDomain: command.securityDomain,
  };
}

function matchesRequestedPublication(
  existing: PublishedIndexVersion,
  prepared: PreparedPublication,
): boolean {
  const { publishedAt: _publishedAt, scopeRevisions: _scopeRevisions, ...manifest } =
    existing.manifest;
  const {
    publishedAt: _draftPublishedAt,
    scopeRevisions: _draftScopeRevisions,
    ...draft
  } = prepared.manifestDraft;
  return (
    canonicalJson(manifest) === canonicalJson(draft) &&
    existing.securityDomain === prepared.securityDomain &&
    existing.documentIndex.connectorId === prepared.connectorId &&
    canonicalJson(existing.scopes.map(scopeShape)) ===
      canonicalJson(prepared.requestedScopeShape)
  );
}

function scopeShape(scope: PublishedDocumentScope): unknown {
  return {
    scopeId: scope.scopeId,
    scopeVersion: scope.scopeVersion,
    kind: scope.kind,
    selector: scope.selector,
  };
}

function assertCompatibleStaging(
  stored: readonly VectorIndexStoredRecord[],
  intended: readonly VectorIndexRecord[],
): readonly VectorIndexRecord[] {
  const intendedById = new Map(intended.map((record) => [record.recordId, record]));
  const seen = new Set<string>();
  for (const record of stored) {
    const expected = intendedById.get(record.recordId);
    if (
      expected === undefined ||
      seen.has(record.recordId) ||
      record.retrievalText !== expected.retrievalText ||
      canonicalJson(record.metadata) !== canonicalJson(expected.metadata)
    ) {
      throw new DocumentIndexPublicationError("conflicting_index_version");
    }
    seen.add(record.recordId);
  }
  return intended.filter((record) => !seen.has(record.recordId));
}

function assertCompleteStaging(
  manifest: IndexManifest,
  chunks: readonly ManagedChunk[],
  stored: readonly VectorIndexStoredRecord[],
  intended: readonly VectorIndexRecord[],
): void {
  const missing = assertCompatibleStaging(stored, intended);
  if (missing.length !== 0 || stored.length !== intended.length) {
    throw new DocumentIndexPublicationError("staged_record_mismatch");
  }
  const intendedById = new Map(intended.map((record) => [record.recordId, record]));
  const reconstructed = stored.map((record): VectorIndexRecord => ({
    recordId: record.recordId,
    chunkRevisionId: record.metadata.chunkRevisionId,
    embedding: intendedById.get(record.recordId)!.embedding,
    retrievalText: record.retrievalText,
    metadata: record.metadata,
  }));
  try {
    assertValidVectorIndexRecords(manifest, chunks, reconstructed);
  } catch {
    throw new DocumentIndexPublicationError("staged_record_mismatch");
  }
}

function sortedRevisionMap(
  entries: readonly (readonly [string, string])[],
): Readonly<Record<string, string>> {
  return Object.fromEntries(
    [...entries].sort(([left], [right]) => left.localeCompare(right)),
  );
}

function scopeRevisions(
  scopes: readonly PublishedDocumentScope[],
): readonly { readonly scopeId: string; readonly scopeVersion: string }[] {
  return scopes.map(({ scopeId, scopeVersion }) => ({ scopeId, scopeVersion }));
}

function fallbackCounts(
  command: PublishDocumentIndexCommand,
): Readonly<Record<string, number>> {
  const counts = new Map<string, number>();
  const add = (key: string): void => {
    counts.set(key, (counts.get(key) ?? 0) + 1);
  };
  for (const diagnostic of command.document.completeness.diagnostics) {
    add(`parser:${diagnostic.code}`);
  }
  for (const unit of command.semanticUnits) {
    if (unit.boundary.kind === "size_fallback") add("segmentation:size_fallback");
    for (const diagnostic of unit.diagnostics) {
      add(`segmentation:${diagnostic.code}`);
    }
  }
  for (const chunk of command.chunks) {
    if (chunk.splitKind !== "block_pack") add(`chunk:${chunk.splitKind}`);
  }
  return Object.fromEntries([...counts].sort(([left], [right]) => left.localeCompare(right)));
}

function assertValidInput(assertion: () => void): void {
  try {
    assertion();
  } catch {
    throw new DocumentIndexPublicationError("invalid_input");
  }
}
