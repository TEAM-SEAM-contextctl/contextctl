import { describe, expect, it } from "vitest";

import {
  DocumentIndexPublisher,
  FailedIndexStagingCleanup,
  InMemoryIndexPublicationStoreV2,
  InMemoryIndexStagingAttemptStore,
  InMemoryVectorIndexAdapter,
  StaticVectorIndexConnectorRegistry,
  computeRecordSetDigest,
  createVectorRecordId,
  type EmbeddingProfile,
  type IndexPublicationStoreV2,
  type IndexStagingAttemptStore,
  type PublishedIndexVersionV2,
  type PublishDocumentIndexCommand,
  type VectorIndexPort,
  type VectorIndexRecord,
} from "../src/index.js";
import {
  createDocumentFixture,
  createIndexManifestFixture,
  createManagedChunkFixture,
  createSemanticUnitFixture,
  createVectorRecordFixture,
} from "./fixtures/document-fixture.js";

const PROFILE: EmbeddingProfile = createIndexManifestFixture().embeddingProfile;
const CONNECTOR_ID = "vector.local";
const ATTEMPTED_AT = "2026-08-15T00:00:00.000Z";
const CLEANUP_AT = "2026-08-18T00:00:00.000Z";

describe("FailedIndexStagingCleanup", () => {
  it("reclaims a failed publication only after the retention grace period", async () => {
    const delegate = new InMemoryVectorIndexAdapter();
    const vectorIndex = new CapturingVectorIndex(delegate);
    const publications = new InMemoryIndexPublicationStoreV2();
    const attempts = new InMemoryIndexStagingAttemptStore();
    const publisher = new DocumentIndexPublisher({
      vectorIndex,
      publications: new RejectCommitPublicationStore(publications),
      stagingAttempts: attempts,
      batchSize: 1,
      clock: () => ATTEMPTED_AT,
      leaseIds: () => "lease_failedpublication",
    });

    await expect(publisher.publish(command())).rejects.toThrow(
      "simulated Catalog failure",
    );
    const staged = requiredValue(vectorIndex.stagedRecords[0]);
    const key = {
      documentIndexId: staged.metadata.documentIndexId,
      indexVersion: staged.metadata.indexVersion,
    };
    expect(await attempts.find(key)).toMatchObject({ state: "pending" });

    const beforeGrace = cleanup({
      attempts,
      publications,
      vectorIndex: delegate,
      now: "2026-08-15T12:00:00.000Z",
    });
    await expect(beforeGrace.execute()).resolves.toMatchObject({
      examined: 0,
      deleted: 0,
      remainingEligible: 0,
      remainingOrphans: 1,
    });
    expect(await versionRecords(delegate, vectorIndex.accessHandle, key)).toHaveLength(1);

    const afterGrace = cleanup({
      attempts,
      publications,
      vectorIndex: delegate,
      now: CLEANUP_AT,
    });
    await expect(afterGrace.execute()).resolves.toMatchObject({
      examined: 1,
      deleted: 1,
      referenced: 0,
      retained: 0,
      failed: 0,
      remainingEligible: 0,
      remainingOrphans: 0,
    });
    expect(await versionRecords(delegate, vectorIndex.accessHandle, key)).toEqual([]);
    expect(await attempts.find(key)).toBeUndefined();
  });

  it("never claims a version with an active publication lease", async () => {
    const vectorIndex = new InMemoryVectorIndexAdapter();
    const publications = new InMemoryIndexPublicationStoreV2();
    const attempts = new InMemoryIndexStagingAttemptStore();
    const { accessHandle } = await prepareVectorIndex(vectorIndex);
    const record = recordFor("aaaa");
    await vectorIndex.upsertRecords({
      accessHandle,
      embeddingProfile: PROFILE,
      records: [record],
    });
    await attempts.acquirePublication({
      documentIndexId: record.metadata.documentIndexId,
      indexVersion: record.metadata.indexVersion,
      connectorId: CONNECTOR_ID,
      accessHandle,
      attemptedAt: ATTEMPTED_AT,
      leaseId: "lease_activepublication",
      leaseExpiresAt: "2026-08-19T00:00:00.000Z",
    });

    const report = await cleanup({
      attempts,
      publications,
      vectorIndex,
      now: CLEANUP_AT,
    }).execute();

    expect(report).toMatchObject({
      examined: 0,
      deleted: 0,
      remainingOrphans: 1,
    });
    expect(await attempts.find(record.metadata)).toMatchObject({
      state: "publishing",
      ownerLeaseId: "lease_activepublication",
    });
    expect(
      await versionRecords(vectorIndex, accessHandle, record.metadata),
    ).toHaveLength(1);
  });

  it("reports and preserves an orphan retained by the vector adapter", async () => {
    const vectorIndex = new InMemoryVectorIndexAdapter();
    const publications = new InMemoryIndexPublicationStoreV2();
    const attempts = new InMemoryIndexStagingAttemptStore();
    const { accessHandle } = await prepareVectorIndex(vectorIndex);
    const record = recordFor("aaaa");
    await vectorIndex.upsertRecords({
      accessHandle,
      embeddingProfile: PROFILE,
      records: [record],
    });
    await seedPendingAttempt(attempts, accessHandle, record, "retained");
    await vectorIndex.retainVersion({
      accessHandle,
      lease: {
        leaseId: "lease_externalreader",
        documentIndexId: record.metadata.documentIndexId,
        indexVersion: record.metadata.indexVersion,
        expiresAt: "2026-08-19T00:00:00.000Z",
      },
    });

    const report = await cleanup({
      attempts,
      publications,
      vectorIndex,
      now: CLEANUP_AT,
    }).execute();

    expect(report).toMatchObject({
      examined: 1,
      deleted: 0,
      retained: 1,
      failed: 0,
      remainingEligible: 1,
      remainingOrphans: 1,
    });
    expect(report.items).toEqual([
      expect.objectContaining({
        outcome: "retained",
        code: "index_version_retained",
      }),
    ]);
    expect(
      await versionRecords(vectorIndex, accessHandle, record.metadata),
    ).toHaveLength(1);
    expect(await attempts.find(record.metadata)).toMatchObject({
      state: "pending",
    });
  });

  it("isolates an unavailable connector and reports the orphan left behind", async () => {
    const vectorIndex = new InMemoryVectorIndexAdapter();
    const publications = new InMemoryIndexPublicationStoreV2();
    const attempts = new InMemoryIndexStagingAttemptStore();
    const { accessHandle } = await prepareVectorIndex(vectorIndex);
    const reclaimable = recordFor("aaaa");
    const unavailable = recordFor("bbbb");
    await vectorIndex.upsertRecords({
      accessHandle,
      embeddingProfile: PROFILE,
      records: [reclaimable],
    });
    await seedPendingAttempt(
      attempts,
      accessHandle,
      reclaimable,
      "reclaimable",
    );
    await attempts.acquirePublication({
      documentIndexId: unavailable.metadata.documentIndexId,
      indexVersion: unavailable.metadata.indexVersion,
      connectorId: "vector.missing",
      accessHandle: "missing:binding",
      attemptedAt: ATTEMPTED_AT,
      leaseId: "lease_seedunavailable",
      leaseExpiresAt: "2026-08-15T00:05:00.000Z",
    });
    await attempts.abandonPublication({
      documentIndexId: unavailable.metadata.documentIndexId,
      indexVersion: unavailable.metadata.indexVersion,
      leaseId: "lease_seedunavailable",
    });

    const report = await cleanup({
      attempts,
      publications,
      vectorIndex,
      now: CLEANUP_AT,
    }).execute();

    expect(report).toMatchObject({
      examined: 2,
      deleted: 1,
      failed: 1,
      remainingEligible: 1,
      remainingOrphans: 1,
    });
    expect(report.items).toContainEqual(
      expect.objectContaining({
        indexVersion: unavailable.metadata.indexVersion,
        outcome: "failed",
        code: "connector_unavailable",
      }),
    );
    expect(
      await versionRecords(vectorIndex, accessHandle, reclaimable.metadata),
    ).toEqual([]);
    expect(await attempts.find(unavailable.metadata)).toMatchObject({
      state: "pending",
    });
  });

  it("reconciles published versions without changing current search", async () => {
    const vectorIndex = new InMemoryVectorIndexAdapter();
    const publications = new InMemoryIndexPublicationStoreV2();
    const attempts = new InMemoryIndexStagingAttemptStore();
    const { accessHandle } = await prepareVectorIndex(vectorIndex);
    const predecessorRecord = recordFor("aaaa");
    const currentRecord = recordFor("bbbb");
    await vectorIndex.upsertRecords({
      accessHandle,
      embeddingProfile: PROFILE,
      records: [predecessorRecord],
    });
    await vectorIndex.upsertRecords({
      accessHandle,
      embeddingProfile: PROFILE,
      records: [currentRecord],
    });
    await publications.commitCurrent(
      publicationFor("aaaa", accessHandle),
    );
    await publications.commitCurrent(
      publicationFor("bbbb", accessHandle),
    );
    await seedPendingAttempt(
      attempts,
      accessHandle,
      predecessorRecord,
      "predecessor",
    );
    await seedPendingAttempt(
      attempts,
      accessHandle,
      currentRecord,
      "current",
    );
    const searchInput = {
      accessHandle,
      scope: {
        documentIndexId: currentRecord.metadata.documentIndexId,
        indexVersion: currentRecord.metadata.indexVersion,
        documentId: currentRecord.metadata.documentId,
      },
      queryVector: [0.1, 0.2, 0.3],
      limit: 5,
    } as const;
    const before = await vectorIndex.search(searchInput);

    const report = await cleanup({
      attempts,
      publications,
      vectorIndex,
      now: CLEANUP_AT,
    }).execute();
    const after = await vectorIndex.search(searchInput);

    expect(report).toMatchObject({
      examined: 2,
      deleted: 0,
      referenced: 2,
      retained: 0,
      failed: 0,
      remainingEligible: 0,
      remainingOrphans: 0,
    });
    expect(after).toEqual(before);
    expect(before).toHaveLength(1);
    expect(
      await versionRecords(vectorIndex, accessHandle, predecessorRecord.metadata),
    ).toHaveLength(1);
    expect(
      await versionRecords(vectorIndex, accessHandle, currentRecord.metadata),
    ).toHaveLength(1);
    expect(await attempts.find(predecessorRecord.metadata)).toBeUndefined();
    expect(await attempts.find(currentRecord.metadata)).toBeUndefined();
  });
});

function cleanup(input: {
  readonly attempts: IndexStagingAttemptStore;
  readonly publications: IndexPublicationStoreV2;
  readonly vectorIndex: VectorIndexPort;
  readonly now: string;
}): FailedIndexStagingCleanup {
  return new FailedIndexStagingCleanup({
    attempts: input.attempts,
    publications: input.publications,
    vectorIndexes: new StaticVectorIndexConnectorRegistry([
      { connectorId: CONNECTOR_ID, vectorIndex: input.vectorIndex },
    ]),
    policy: {
      gracePeriodMs: 24 * 60 * 60 * 1_000,
      cleanupLeaseMs: 5 * 60 * 1_000,
      batchSize: 100,
    },
    clock: () => input.now,
    leaseIds: () => "lease_cleanupworker",
  });
}

function command(): PublishDocumentIndexCommand {
  const chunks = createManagedChunkFixture();
  return {
    stateNamespaceId: "state_test",
    document: createDocumentFixture(),
    semanticUnits: createSemanticUnitFixture(),
    chunks,
    embeddings: chunks.map((chunk) => ({
      chunkId: chunk.id,
      chunkRevisionId: chunk.revisionId,
      contentDigest: chunk.contentDigest,
      vector: [0.1, 0.2, 0.3],
      origin: "generated" as const,
    })),
    embeddingProfile: PROFILE,
    connectorId: CONNECTOR_ID,
    securityDomain: "test-tenant",
  };
}

async function prepareVectorIndex(vectorIndex: VectorIndexPort) {
  return vectorIndex.prepare({
    compatibility: {
      stateNamespaceId: "state_test",
      securityDomain: "test-tenant",
      embeddingProfile: PROFILE,
      payloadSchemaVersion: 2,
    },
    signal: new AbortController().signal,
  });
}

async function seedPendingAttempt(
  attempts: IndexStagingAttemptStore,
  accessHandle: string,
  record: VectorIndexRecord,
  suffix: string,
): Promise<void> {
  const leaseId = `lease_seed${suffix}`;
  await attempts.acquirePublication({
    documentIndexId: record.metadata.documentIndexId,
    indexVersion: record.metadata.indexVersion,
    connectorId: CONNECTOR_ID,
    accessHandle,
    attemptedAt: ATTEMPTED_AT,
    leaseId,
    leaseExpiresAt: "2026-08-15T00:05:00.000Z",
  });
  expect(
    await attempts.abandonPublication({
      documentIndexId: record.metadata.documentIndexId,
      indexVersion: record.metadata.indexVersion,
      leaseId,
    }),
  ).toBe(true);
}

function recordFor(revision: "aaaa" | "bbbb"): VectorIndexRecord {
  const record = createVectorRecordFixture()[0]!;
  const metadata = {
    ...record.metadata,
    indexVersion: `idxv_${revision}`,
  };
  return {
    ...record,
    recordId: createVectorRecordId(
      metadata.stateNamespaceId,
      metadata.documentIndexId,
      metadata.indexVersion,
      metadata.chunkRevisionId,
    ),
    metadata,
  };
}

function publicationFor(
  revision: "aaaa" | "bbbb",
  accessHandle: string,
): PublishedIndexVersionV2 {
  const manifest = {
    ...createIndexManifestFixture(),
    indexVersion: `idxv_${revision}`,
    recordSetDigest: computeRecordSetDigest(
      createIndexManifestFixture().chunkBindings,
    ),
    scopeRevisions: [
      { scopeId: "scope_payment_failures", scopeVersion: `scpv_${revision}` },
    ],
    publishedAt:
      revision === "aaaa"
        ? "2026-08-14T00:00:00.000Z"
        : "2026-08-14T01:00:00.000Z",
  };
  const documentIndex = {
    documentIndexId: manifest.documentIndexId,
    sourceId: manifest.sourceId,
    documentId: manifest.documentId,
    indexVersion: manifest.indexVersion,
  };
  return {
    manifest,
    documentIndex,
    scopes: [
      {
        scopeId: "scope_payment_failures",
        scopeVersion: `scpv_${revision}`,
        kind: "managed_document",
        documentIndex,
        selector: { kind: "document" },
      },
    ],
    binding: {
      stateNamespaceId: manifest.stateNamespaceId,
      documentIndexId: manifest.documentIndexId,
      indexVersion: manifest.indexVersion,
      connectorId: CONNECTOR_ID,
      accessHandle,
      securityDomain: manifest.securityDomain,
    },
  };
}

function versionRecords(
  vectorIndex: VectorIndexPort,
  accessHandle: string,
  key: { readonly documentIndexId: string; readonly indexVersion: string },
) {
  return vectorIndex.listVersionRecords({
    accessHandle,
    ...key,
    signal: new AbortController().signal,
  });
}

function requiredValue<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("required test value is missing");
  return value;
}

class CapturingVectorIndex implements VectorIndexPort {
  readonly stagedRecords: VectorIndexRecord[] = [];
  accessHandle = "";

  constructor(private readonly delegate: VectorIndexPort) {}

  async prepare(input: Parameters<VectorIndexPort["prepare"]>[0]) {
    const prepared = await this.delegate.prepare(input);
    this.accessHandle = prepared.accessHandle;
    return prepared;
  }

  rehydrate: VectorIndexPort["rehydrate"] = (input) =>
    this.delegate.rehydrate(input);
  async upsertRecords(input: Parameters<VectorIndexPort["upsertRecords"]>[0]) {
    this.stagedRecords.push(...input.records.map((record) => structuredClone(record)));
    return this.delegate.upsertRecords(input);
  }
  listVersionRecords: VectorIndexPort["listVersionRecords"] = (input) =>
    this.delegate.listVersionRecords(input);
  readVersionVectors: VectorIndexPort["readVersionVectors"] = (input) =>
    this.delegate.readVersionVectors(input);
  search: VectorIndexPort["search"] = (input) => this.delegate.search(input);
  retainVersion: VectorIndexPort["retainVersion"] = (input) =>
    this.delegate.retainVersion(input);
  releaseRetentionLease: VectorIndexPort["releaseRetentionLease"] = (input) =>
    this.delegate.releaseRetentionLease(input);
  deleteVersion: VectorIndexPort["deleteVersion"] = (input) =>
    this.delegate.deleteVersion(input);
}

class RejectCommitPublicationStore implements IndexPublicationStoreV2 {
  constructor(private readonly delegate: IndexPublicationStoreV2) {}

  findVersion: IndexPublicationStoreV2["findVersion"] = (input) =>
    this.delegate.findVersion(input);
  current: IndexPublicationStoreV2["current"] = (documentIndexId) =>
    this.delegate.current(documentIndexId);
  findScope: IndexPublicationStoreV2["findScope"] = (scopeRef) =>
    this.delegate.findScope(scopeRef);
  async commitCurrent(): Promise<never> {
    throw new Error("simulated Catalog failure");
  }
}
