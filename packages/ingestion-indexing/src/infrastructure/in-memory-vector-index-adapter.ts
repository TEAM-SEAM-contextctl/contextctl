import { createHash } from "node:crypto";

import type { EmbeddingProfile } from "../domain/embedding-profile.js";
import { assertValidEmbeddingProfile } from "../domain/embedding-profile.js";
import type { VectorIndexRecord } from "../domain/index-manifest.js";
import { canonicalJson } from "../domain/revision-identity.js";
import {
  assertValidLeaseId,
  assertValidRetentionLease,
  assertValidVectorDeletion,
  assertValidVectorIndexScope,
  assertValidVectorRecordBatch,
  assertValidVectorVersion,
} from "../domain/vector-index.js";
import {
  MAX_VECTOR_SEARCH_LIMIT,
  VectorIndexFault,
  type PreparedVectorIndex,
  type VectorIndexCompatibility,
  type VectorIndexPort,
  type VectorIndexRetentionLease,
  type VectorIndexScope,
  type VectorIndexSearchHit,
  type VectorIndexStoredRecord,
} from "../ports/vector-index.js";

interface MemoryCollection {
  readonly compatibility: VectorIndexCompatibility;
  readonly records: Map<string, VectorIndexRecord>;
  readonly leases: Map<string, VectorIndexRetentionLease>;
}

export class InMemoryVectorIndexAdapter implements VectorIndexPort {
  readonly #collections = new Map<string, MemoryCollection>();

  async prepare(
    compatibility: VectorIndexCompatibility,
  ): Promise<PreparedVectorIndex> {
    assertInput(() => assertCompatibility(compatibility));
    const accessHandle = compatibilityHandle(compatibility);
    if (!this.#collections.has(accessHandle)) {
      this.#collections.set(accessHandle, {
        compatibility,
        records: new Map(),
        leases: new Map(),
      });
    }
    return { accessHandle, capabilities: { metadataPreFilter: true } };
  }

  async rehydrate(input: {
    readonly accessHandle: string;
    readonly compatibility: VectorIndexCompatibility;
  }): Promise<{ readonly capabilities: { readonly metadataPreFilter: true } }> {
    assertInput(() => assertCompatibility(input.compatibility));
    const collection = this.#requiredCollection(input.accessHandle);
    assertInput(() => {
      if (compatibilityHandle(input.compatibility) !== input.accessHandle) {
        throw new TypeError("vector binding is incompatible");
      }
      assertSameProfile(
        collection.compatibility.embeddingProfile,
        input.compatibility.embeddingProfile,
      );
      if (
        collection.compatibility.securityDomain !==
          input.compatibility.securityDomain ||
        collection.compatibility.payloadSchemaVersion !==
          input.compatibility.payloadSchemaVersion
      ) {
        throw new TypeError("vector binding is incompatible");
      }
    });
    return { capabilities: { metadataPreFilter: true } };
  }

  async upsertRecords(input: {
    readonly accessHandle: string;
    readonly embeddingProfile: EmbeddingProfile;
    readonly records: readonly VectorIndexRecord[];
  }): Promise<void> {
    const collection = this.#requiredCollection(input.accessHandle);
    assertInput(() => {
      assertSameProfile(collection.compatibility.embeddingProfile, input.embeddingProfile);
      assertValidVectorRecordBatch(input.embeddingProfile, input.records);
    });
    for (const record of input.records) {
      collection.records.set(record.recordId, structuredClone(record));
    }
  }

  async search(input: {
    readonly accessHandle: string;
    readonly scope: VectorIndexScope;
    readonly queryVector: readonly number[];
    readonly limit: number;
  }): Promise<readonly VectorIndexSearchHit[]> {
    const collection = this.#requiredCollection(input.accessHandle);
    assertSearch(input, collection.compatibility.embeddingProfile);
    return [...collection.records.values()]
      .filter((record) => matchesScope(record, input.scope))
      .map((record) => ({
        recordId: record.recordId,
        score: similarity(
          input.queryVector,
          record.embedding,
          collection.compatibility.embeddingProfile.distance,
        ),
        retrievalText: record.retrievalText,
        metadata: structuredClone(record.metadata),
      }))
      .sort((left, right) => right.score - left.score || left.recordId.localeCompare(right.recordId))
      .slice(0, input.limit);
  }

  async listVersionRecords(input: {
    readonly accessHandle: string;
    readonly documentIndexId: string;
    readonly indexVersion: string;
  }): Promise<readonly VectorIndexStoredRecord[]> {
    assertInput(() => assertValidVectorVersion(input));
    return [...this.#requiredCollection(input.accessHandle).records.values()]
      .filter(
        (record) =>
          record.metadata.documentIndexId === input.documentIndexId &&
          record.metadata.indexVersion === input.indexVersion,
      )
      .map((record) => ({
        recordId: record.recordId,
        retrievalText: record.retrievalText,
        metadata: structuredClone(record.metadata),
      }))
      .sort((left, right) => left.recordId.localeCompare(right.recordId));
  }

  async retainVersion(input: {
    readonly accessHandle: string;
    readonly lease: VectorIndexRetentionLease;
  }): Promise<void> {
    assertInput(() => assertValidRetentionLease(input.lease));
    this.#requiredCollection(input.accessHandle).leases.set(
      input.lease.leaseId,
      structuredClone(input.lease),
    );
  }

  async releaseRetentionLease(input: {
    readonly accessHandle: string;
    readonly leaseId: string;
  }): Promise<void> {
    assertInput(() => assertValidLeaseId(input.leaseId));
    this.#requiredCollection(input.accessHandle).leases.delete(input.leaseId);
  }

  async deleteVersion(input: {
    readonly accessHandle: string;
    readonly documentIndexId: string;
    readonly indexVersion: string;
    readonly now: string;
  }): Promise<void> {
    const collection = this.#requiredCollection(input.accessHandle);
    assertInput(() => assertValidVectorDeletion(input));
    const now = Date.parse(input.now);
    for (const lease of collection.leases.values()) {
      if (
        lease.documentIndexId === input.documentIndexId &&
        lease.indexVersion === input.indexVersion &&
        Date.parse(lease.expiresAt) > now
      ) {
        throw new VectorIndexFault("index_version_retained", false);
      }
    }
    for (const [recordId, record] of collection.records) {
      if (
        record.metadata.documentIndexId === input.documentIndexId &&
        record.metadata.indexVersion === input.indexVersion
      ) {
        collection.records.delete(recordId);
      }
    }
    for (const [leaseId, lease] of collection.leases) {
      if (
        lease.documentIndexId === input.documentIndexId &&
        lease.indexVersion === input.indexVersion
      ) {
        collection.leases.delete(leaseId);
      }
    }
  }

  #requiredCollection(accessHandle: string): MemoryCollection {
    const collection = this.#collections.get(accessHandle);
    if (collection === undefined) {
      throw new VectorIndexFault("index_unavailable", false);
    }
    return collection;
  }
}

function compatibilityHandle(compatibility: VectorIndexCompatibility): string {
  const digest = createHash("sha256")
    .update(canonicalJson({
      securityDomain: compatibility.securityDomain,
      profile: compatibility.embeddingProfile,
      payloadSchemaVersion: compatibility.payloadSchemaVersion,
    }))
    .digest("hex")
    .slice(0, 24);
  return `memory:v1:${digest}`;
}

function assertCompatibility(compatibility: VectorIndexCompatibility): void {
  assertValidEmbeddingProfile(compatibility.embeddingProfile);
  if (compatibility.securityDomain.trim() === "" || compatibility.payloadSchemaVersion !== 2) {
    throw new VectorIndexFault("invalid_request", false);
  }
}

function assertSameProfile(left: EmbeddingProfile, right: EmbeddingProfile): void {
  if (canonicalJson(left) !== canonicalJson(right)) {
    throw new VectorIndexFault("invalid_request", false);
  }
}

function assertSearch(
  input: { readonly queryVector: readonly number[]; readonly limit: number; readonly scope: VectorIndexScope },
  profile: EmbeddingProfile,
): void {
  assertInput(() => assertValidVectorIndexScope(input.scope));
  if (
    !Number.isSafeInteger(input.limit) ||
    input.limit <= 0 ||
    input.limit > MAX_VECTOR_SEARCH_LIMIT ||
    input.queryVector.length !== profile.dimensions ||
    input.queryVector.some((component) => !Number.isFinite(component)) ||
    input.scope.semanticUnitIds?.length === 0
  ) {
    throw new VectorIndexFault("invalid_request", false);
  }
}

function assertInput(assertion: () => void): void {
  try {
    assertion();
  } catch (error) {
    if (error instanceof VectorIndexFault) throw error;
    throw new VectorIndexFault("invalid_request", false);
  }
}

function matchesScope(record: VectorIndexRecord, scope: VectorIndexScope): boolean {
  const metadata = record.metadata;
  return (
    metadata.documentIndexId === scope.documentIndexId &&
    metadata.indexVersion === scope.indexVersion &&
    metadata.documentId === scope.documentId &&
    (scope.semanticUnitIds === undefined || scope.semanticUnitIds.includes(metadata.semanticUnitId))
  );
}

function similarity(
  left: readonly number[],
  right: readonly number[],
  distance: EmbeddingProfile["distance"],
): number {
  if (distance === "euclid") {
    return 1 / (1 + Math.sqrt(left.reduce((sum, value, index) => {
      const delta = value - (right[index] ?? 0);
      return sum + delta * delta;
    }, 0)));
  }
  const dot = left.reduce((sum, value, index) => sum + value * (right[index] ?? 0), 0);
  if (distance === "dot") return dot;
  const leftNorm = Math.sqrt(left.reduce((sum, value) => sum + value * value, 0));
  const rightNorm = Math.sqrt(right.reduce((sum, value) => sum + value * value, 0));
  return leftNorm === 0 || rightNorm === 0 ? 0 : dot / (leftNorm * rightNorm);
}
