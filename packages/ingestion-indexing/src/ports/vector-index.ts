import type { EmbeddingProfile } from "../domain/embedding-profile.js";
import type {
  VectorIndexRecord,
  VectorIndexRecordMetadata,
} from "../domain/index-manifest.js";

export const MAX_VECTOR_SEARCH_LIMIT = 1_000;
export const MAX_VECTOR_VECTOR_READ = 512;

interface VectorIndexCompatibilityBase {
  readonly securityDomain: string;
  readonly embeddingProfile: EmbeddingProfile;
  readonly payloadSchemaVersion: 2;
}

/** @deprecated Pre-release shape retained for the downstream daemon migration. */
export interface VectorIndexCompatibility extends VectorIndexCompatibilityBase {
  readonly stateNamespaceId?: never;
}

export interface VectorIndexCompatibilityV2
  extends VectorIndexCompatibilityBase {
  readonly stateNamespaceId: string;
}

export type VectorIndexCompatibilityInput =
  | VectorIndexCompatibility
  | VectorIndexCompatibilityV2;

export interface PreparedVectorIndex {
  readonly accessHandle: string;
  readonly capabilities: {
    readonly metadataPreFilter: true;
  };
}

export interface RehydratedVectorIndex {
  readonly capabilities: {
    readonly metadataPreFilter: true;
  };
}

export interface VectorIndexScope {
  readonly documentIndexId: string;
  readonly indexVersion: string;
  readonly documentId: string;
  readonly semanticUnitIds?: readonly string[];
}

export interface VectorIndexSearchHit {
  readonly recordId: string;
  readonly score: number;
  readonly retrievalText: string;
  readonly metadata: VectorIndexRecordMetadata;
}

export interface VectorIndexStoredRecord {
  readonly recordId: string;
  readonly retrievalText: string;
  readonly metadata: VectorIndexRecordMetadata;
}

/**
 * A published vector read back so an unchanged Chunk revision can be copied
 * into the next Index version instead of being embedded again.
 */
export interface VectorIndexStoredVector {
  readonly recordId: string;
  readonly chunkRevisionId: string;
  readonly contentDigest: string;
  readonly embedding: readonly number[];
}

export interface VectorIndexRetentionLease {
  readonly leaseId: string;
  readonly documentIndexId: string;
  readonly indexVersion: string;
  readonly expiresAt: string;
}

/** Outbound storage contract owned by the Ingestion indexing workflow. */
export interface VectorIndexPort {
  prepare(
    compatibility: VectorIndexCompatibilityInput,
  ): Promise<PreparedVectorIndex>;
  /**
   * Restores a published opaque binding after process-local adapter state was
   * lost. Unlike prepare, this operation must not create missing storage.
   */
  rehydrate(input: {
    readonly accessHandle: string;
    readonly compatibility: VectorIndexCompatibilityInput;
  }): Promise<RehydratedVectorIndex>;
  upsertRecords(input: {
    readonly accessHandle: string;
    readonly embeddingProfile: EmbeddingProfile;
    readonly records: readonly VectorIndexRecord[];
  }): Promise<void>;
  listVersionRecords(input: {
    readonly accessHandle: string;
    readonly documentIndexId: string;
    readonly indexVersion: string;
  }): Promise<readonly VectorIndexStoredRecord[]>;
  /**
   * Reads back the stored vectors of an already published version. Requested
   * revisions that are absent are omitted rather than faulted, so the caller
   * embeds them again instead of publishing an incomplete version.
   */
  readVersionVectors(input: {
    readonly accessHandle: string;
    readonly documentIndexId: string;
    readonly indexVersion: string;
    readonly chunkRevisionIds: readonly string[];
  }): Promise<readonly VectorIndexStoredVector[]>;
  search(input: {
    readonly accessHandle: string;
    readonly scope: VectorIndexScope;
    readonly queryVector: readonly number[];
    readonly limit: number;
  }): Promise<readonly VectorIndexSearchHit[]>;
  retainVersion(input: {
    readonly accessHandle: string;
    readonly lease: VectorIndexRetentionLease;
  }): Promise<void>;
  releaseRetentionLease(input: {
    readonly accessHandle: string;
    readonly leaseId: string;
  }): Promise<void>;
  deleteVersion(input: {
    readonly accessHandle: string;
    readonly documentIndexId: string;
    readonly indexVersion: string;
    readonly now: string;
  }): Promise<void>;
}

export type VectorIndexFaultCode =
  | "access_denied"
  | "filter_not_supported"
  | "index_unavailable"
  | "index_version_retained"
  | "invalid_request"
  | "storage_unavailable";

export class VectorIndexFault extends Error {
  constructor(
    readonly code: VectorIndexFaultCode,
    readonly retriable: boolean,
  ) {
    super(`Vector index operation failed: ${code}`);
    this.name = "VectorIndexFault";
  }
}
