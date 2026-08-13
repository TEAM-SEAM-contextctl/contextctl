import { createHash } from "node:crypto";

import type { EmbeddingProfile } from "./embedding-profile.js";
import { assertValidEmbeddingProfile } from "./embedding-profile.js";
import type { VectorIndexRecord } from "./index-manifest.js";
import type { VectorIndexRecordMetadata } from "./index-manifest.js";
import {
  isDigest,
  isId,
  isIsoTimestamp,
  isRevisionId,
} from "./model-validation.js";
import { revisionIdentity } from "./revision-identity.js";

export function createVectorRecordId(
  documentIndexId: string,
  indexVersion: string,
  chunkRevisionId: string,
): string {
  return revisionIdentity("vrec", {
    documentIndexId,
    indexVersion,
    chunkRevisionId,
  });
}

export function assertValidVectorRecordBatch(
  profile: EmbeddingProfile,
  records: readonly VectorIndexRecord[],
): void {
  assertValidEmbeddingProfile(profile);
  if (records.length === 0) {
    throw new TypeError("vector record batch must not be empty");
  }
  const first = records[0];
  if (first === undefined) {
    throw new TypeError("vector record batch must not be empty");
  }
  const seen = new Set<string>();
  for (const record of records) {
    const metadata = record.metadata;
    assertValidVectorRecordMetadata(metadata);
    if (
      !isRevisionId(record.recordId, "vrec") ||
      !isRevisionId(record.chunkRevisionId, "crv") ||
      record.recordId !==
        createVectorRecordId(
          metadata.documentIndexId,
          metadata.indexVersion,
          record.chunkRevisionId,
        ) ||
      metadata.chunkRevisionId !== record.chunkRevisionId ||
      metadata.documentIndexId !== first.metadata.documentIndexId ||
      metadata.indexVersion !== first.metadata.indexVersion ||
      metadata.documentId !== first.metadata.documentId ||
      metadata.sourceId !== first.metadata.sourceId ||
      metadata.observationId !== first.metadata.observationId ||
      metadata.payloadSchemaVersion !== 2 ||
      record.retrievalText.length === 0 ||
      metadata.contentDigest !== retrievalTextDigest(record.retrievalText) ||
      record.embedding.length !== profile.dimensions ||
      record.embedding.some((component) => !Number.isFinite(component)) ||
      seen.has(record.recordId)
    ) {
      throw new TypeError("invalid vector record batch");
    }
    seen.add(record.recordId);
  }
}

export function assertValidVectorRecordMetadata(
  metadata: VectorIndexRecordMetadata,
): void {
  if (
    metadata.payloadSchemaVersion !== 2 ||
    !isId(metadata.sourceId, "src") ||
    !isId(metadata.observationId, "obs") ||
    !isId(metadata.documentId, "doc") ||
    !isId(metadata.documentIndexId, "didx") ||
    !isRevisionId(metadata.indexVersion, "idxv") ||
    !isId(metadata.semanticUnitId, "unit") ||
    !isId(metadata.chunkId, "chk") ||
    !isRevisionId(metadata.chunkRevisionId, "crv") ||
    !isDigest(metadata.contentDigest)
  ) {
    throw new TypeError("invalid vector record metadata");
  }
}

function retrievalTextDigest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function assertValidVectorIndexScope(input: {
  readonly documentIndexId: string;
  readonly indexVersion: string;
  readonly documentId: string;
  readonly semanticUnitIds?: readonly string[];
}): void {
  if (
    !isId(input.documentIndexId, "didx") ||
    !isRevisionId(input.indexVersion, "idxv") ||
    !isId(input.documentId, "doc") ||
    input.semanticUnitIds?.length === 0 ||
    input.semanticUnitIds?.some((unitId) => !isId(unitId, "unit"))
  ) {
    throw new TypeError("invalid vector index scope");
  }
}

export function assertValidVectorVersion(input: {
  readonly documentIndexId: string;
  readonly indexVersion: string;
}): void {
  if (
    !isId(input.documentIndexId, "didx") ||
    !isRevisionId(input.indexVersion, "idxv")
  ) {
    throw new TypeError("invalid vector index version");
  }
}

export function assertValidVectorDeletion(input: {
  readonly documentIndexId: string;
  readonly indexVersion: string;
  readonly now: string;
}): void {
  assertValidVectorVersion(input);
  if (!isIsoTimestamp(input.now)) {
    throw new TypeError("invalid vector index deletion timestamp");
  }
}

export function assertValidLeaseId(leaseId: string): void {
  if (!isId(leaseId, "lease")) {
    throw new TypeError("invalid vector index retention lease ID");
  }
}

export function assertValidRetentionLease(input: {
  readonly leaseId: string;
  readonly documentIndexId: string;
  readonly indexVersion: string;
  readonly expiresAt: string;
}): void {
  if (
    !isId(input.leaseId, "lease") ||
    !isId(input.documentIndexId, "didx") ||
    !isRevisionId(input.indexVersion, "idxv") ||
    !isIsoTimestamp(input.expiresAt)
  ) {
    throw new TypeError("invalid vector index retention lease");
  }
}
