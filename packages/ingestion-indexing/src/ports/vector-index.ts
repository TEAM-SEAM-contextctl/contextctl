import type { EmbeddingProfile } from "../domain/embedding-profile.js";
import type {
  VectorIndexRecord,
  VectorIndexRecordMetadata,
} from "../domain/index-manifest.js";

export const MAX_VECTOR_SEARCH_LIMIT = 1_000;

export interface VectorIndexCompatibility {
  readonly securityDomain: string;
  readonly embeddingProfile: EmbeddingProfile;
  readonly payloadSchemaVersion: 1;
}

export interface PreparedVectorIndex {
  readonly accessHandle: string;
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
  readonly metadata: VectorIndexRecordMetadata;
}

export interface VectorIndexStoredRecord {
  readonly recordId: string;
  readonly metadata: VectorIndexRecordMetadata;
}

export interface VectorIndexRetentionLease {
  readonly leaseId: string;
  readonly documentIndexId: string;
  readonly indexVersion: string;
  readonly expiresAt: string;
}

/** Outbound storage contract owned by the Ingestion indexing workflow. */
export interface VectorIndexPort {
  prepare(compatibility: VectorIndexCompatibility): Promise<PreparedVectorIndex>;
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
