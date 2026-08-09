import { describe, expect, it } from "vitest";

import {
  DocumentIndexPublisher,
  InMemoryIndexPublicationStore,
  InMemoryVectorIndexAdapter,
  PublishedDocumentScopeError,
  computeRecordSetDigest,
  createDocumentIndexId,
  createIndexVersion,
  createVectorRecordId,
  type ChunkEmbedding,
  type EmbeddingProfile,
  type ManagedChunk,
  type PublishDocumentIndexCommand,
  type VectorIndexPort,
  type VectorIndexStoredRecord,
} from "../src/index.js";
import { sha256Digest } from "../src/domain/document-capture.js";
import {
  createDocumentFixture,
  createManagedChunkFixture,
  createSemanticUnitFixture,
} from "./fixtures/document-fixture.js";

const profile: EmbeddingProfile = {
  id: "publication-test",
  version: "1.0.0",
  model: "publication-test-v1",
  dimensions: 3,
  distance: "cosine",
  maxInputTokens: 480,
  textMeasureProfileVersion: "unicode-estimate-v1",
};

describe("DocumentIndexPublisher", () => {
  it("publishes a verified Manifest with deterministic document and semantic Scopes", async () => {
    const vectorIndex = new InMemoryVectorIndexAdapter();
    const publications = new InMemoryIndexPublicationStore();
    const command = createCommand(2);
    const publisher = new DocumentIndexPublisher({
      vectorIndex,
      publications,
      clock: () => "2026-08-09T00:00:00.000Z",
    });

    const result = await publisher.publish(command);

    expect(result.manifest.recordCount).toBe(2);
    expect(result.manifest.recordSetDigest).toBe(
      computeRecordSetDigest(
        (await vectorIndex.listVersionRecords({
          accessHandle: result.documentIndex.accessHandle,
          documentIndexId: result.manifest.documentIndexId,
          indexVersion: result.manifest.indexVersion,
        })).map((record) => ({
          chunkRevisionId: record.metadata.chunkRevisionId,
          metadata: record.metadata,
        })),
      ),
    );
    expect(result.manifest.scopeRevisions).toEqual(
      result.scopes.map(({ scopeId, scopeVersion }) => ({
        scopeId,
        scopeVersion,
      })),
    );
    expect(result.scopes.map((scope) => scope.selector)).toEqual([
      { kind: "document" },
      {
        kind: "semantic_units",
        semanticUnitIds: ["unit_payment_failures", "unit_payments"],
      },
    ]);
    expect(JSON.stringify(result.scopes)).not.toMatch(
      /collection|namespace|vendor|filter/i,
    );
    expect(await publications.current(result.manifest.documentIndexId)).toEqual(
      result,
    );
  });

  it("returns an already published immutable version without touching staging", async () => {
    const delegate = new InMemoryVectorIndexAdapter();
    const vectorIndex = new RecordingVectorIndex(delegate);
    const publications = new InMemoryIndexPublicationStore();
    const command = createCommand(2);
    const publisher = new DocumentIndexPublisher({
      vectorIndex,
      publications,
      batchSize: 1,
      clock: () => "2026-08-09T00:00:00.000Z",
    });

    const first = await publisher.publish(command);
    const callsAfterFirst = vectorIndex.upsertCalls;
    const retried = await publisher.publish(command);

    expect(retried).toEqual(first);
    expect(vectorIndex.upsertCalls).toBe(callsAfterFirst);
    expect(
      await delegate.listVersionRecords({
        accessHandle: first.documentIndex.accessHandle,
        documentIndexId: first.manifest.documentIndexId,
        indexVersion: first.manifest.indexVersion,
      }),
    ).toHaveLength(2);
  });

  it("rejects a different Scope definition under the same immutable Index version", async () => {
    const vectorIndex = new InMemoryVectorIndexAdapter();
    const publications = new InMemoryIndexPublicationStore();
    const publisher = new DocumentIndexPublisher({
      vectorIndex,
      publications,
      clock: () => "2026-08-09T00:00:00.000Z",
    });
    const command = createCommand(1);
    const first = await publisher.publish(command);

    await expect(
      publisher.publish({ ...command, semanticScopes: [] }),
    ).rejects.toMatchObject({ code: "conflicting_index_version" });
    expect(await publications.current(first.manifest.documentIndexId)).toEqual(
      first,
    );
  });

  it("does not reuse an immutable version across security isolation domains", async () => {
    const vectorIndex = new InMemoryVectorIndexAdapter();
    const publications = new InMemoryIndexPublicationStore();
    const publisher = new DocumentIndexPublisher({
      vectorIndex,
      publications,
      clock: () => "2026-08-09T00:00:00.000Z",
    });
    const command = createCommand(1);
    const first = await publisher.publish(command);

    await expect(
      publisher.publish({ ...command, securityDomain: "tenant-b" }),
    ).rejects.toMatchObject({ code: "conflicting_index_version" });
    expect(await publications.current(first.manifest.documentIndexId)).toEqual(
      first,
    );
  });

  it("does not move current backwards when an older version is committed again", async () => {
    const vectorIndex = new InMemoryVectorIndexAdapter();
    const publications = new InMemoryIndexPublicationStore();
    const publisher = new DocumentIndexPublisher({
      vectorIndex,
      publications,
      clock: () => "2026-08-09T00:00:00.000Z",
    });
    const first = await publisher.publish(createCommand(1));
    const latest = await publisher.publish(createCommand(2));

    expect((await publications.commitCurrent(first)).status).toBe(
      "already_published",
    );
    expect(await publications.current(latest.manifest.documentIndexId)).toEqual(
      latest,
    );
  });

  it("canonicalizes semantic Scope group order", async () => {
    const firstCommand = createCommand(1);
    const semanticScopes = [
      { semanticUnitIds: ["unit_payments"] },
      { semanticUnitIds: ["unit_payment_failures"] },
    ];
    const firstPublisher = new DocumentIndexPublisher({
      vectorIndex: new InMemoryVectorIndexAdapter(),
      publications: new InMemoryIndexPublicationStore(),
      clock: () => "2026-08-09T00:00:00.000Z",
    });
    const secondPublisher = new DocumentIndexPublisher({
      vectorIndex: new InMemoryVectorIndexAdapter(),
      publications: new InMemoryIndexPublicationStore(),
      clock: () => "2026-08-09T00:00:00.000Z",
    });

    const first = await firstPublisher.publish({
      ...firstCommand,
      semanticScopes,
    });
    const second = await secondPublisher.publish({
      ...firstCommand,
      semanticScopes: [...semanticScopes].reverse(),
    });

    expect(second.manifest.scopeRevisions).toEqual(
      first.manifest.scopeRevisions,
    );
    expect(second.scopes.map((scope) => scope.selector)).toEqual(
      first.scopes.map((scope) => scope.selector),
    );
  });

  it("keeps the last-known-good current version when a later batch is interrupted", async () => {
    const delegate = new InMemoryVectorIndexAdapter();
    const publications = new InMemoryIndexPublicationStore();
    const initialPublisher = new DocumentIndexPublisher({
      vectorIndex: delegate,
      publications,
      batchSize: 1,
      clock: () => "2026-08-09T00:00:00.000Z",
    });
    const initial = await initialPublisher.publish(createCommand(1));
    const interrupted = new RecordingVectorIndex(delegate);
    interrupted.failUpsertCall = 2;
    const publisher = new DocumentIndexPublisher({
      vectorIndex: interrupted,
      publications,
      batchSize: 1,
      clock: () => "2026-08-09T01:00:00.000Z",
    });

    await expect(publisher.publish(createCommand(3))).rejects.toThrow(
      "simulated batch interruption",
    );

    expect(await publications.current(initial.manifest.documentIndexId)).toEqual(
      initial,
    );
    expect(
      await publications.findVersion(versionIdentity(createCommand(3))),
    ).toBeUndefined();

    const retried = await new DocumentIndexPublisher({
      vectorIndex: delegate,
      publications,
      batchSize: 1,
      clock: () => "2026-08-09T01:00:00.000Z",
    }).publish(createCommand(3));
    expect(
      await delegate.listVersionRecords({
        accessHandle: retried.documentIndex.accessHandle,
        documentIndexId: retried.manifest.documentIndexId,
        indexVersion: retried.manifest.indexVersion,
      }),
    ).toHaveLength(3);
    expect(await publications.current(retried.manifest.documentIndexId)).toEqual(
      retried,
    );
  });

  it("does not expose current when the adapter reports an incomplete staged set", async () => {
    const delegate = new InMemoryVectorIndexAdapter();
    const vectorIndex = new RecordingVectorIndex(delegate);
    vectorIndex.omitRecordAfterUpsert = true;
    const publications = new InMemoryIndexPublicationStore();
    const publisher = new DocumentIndexPublisher({
      vectorIndex,
      publications,
      clock: () => "2026-08-09T00:00:00.000Z",
    });
    const command = createCommand(2);

    await expect(publisher.publish(command)).rejects.toMatchObject({
      code: "staged_record_mismatch",
    });
    expect(
      await publications.current(versionIdentity(command).documentIndexId),
    ).toBeUndefined();
  });

  it("fails closed before upsert when the same version contains conflicting metadata", async () => {
    const delegate = new InMemoryVectorIndexAdapter();
    const vectorIndex = new RecordingVectorIndex(delegate);
    const command = createCommand(1);
    vectorIndex.reportedBeforeUpsert = [conflictingStoredRecord(command)];
    const publications = new InMemoryIndexPublicationStore();
    const publisher = new DocumentIndexPublisher({
      vectorIndex,
      publications,
      clock: () => "2026-08-09T00:00:00.000Z",
    });

    await expect(publisher.publish(command)).rejects.toMatchObject({
      code: "conflicting_index_version",
    });
    expect(vectorIndex.upsertCalls).toBe(0);
  });

  it("rejects semantic Scope Units outside the Manifest", async () => {
    const publisher = new DocumentIndexPublisher({
      vectorIndex: new InMemoryVectorIndexAdapter(),
      publications: new InMemoryIndexPublicationStore(),
    });

    await expect(
      publisher.publish({
        ...createCommand(1),
        semanticScopes: [{ semanticUnitIds: ["unit_not_in_manifest"] }],
      }),
    ).rejects.toBeInstanceOf(PublishedDocumentScopeError);
  });
});

class RecordingVectorIndex implements VectorIndexPort {
  upsertCalls = 0;
  failUpsertCall: number | undefined;
  omitRecordAfterUpsert = false;
  reportedBeforeUpsert: readonly VectorIndexStoredRecord[] | undefined;

  constructor(private readonly delegate: VectorIndexPort) {}

  prepare: VectorIndexPort["prepare"] = (input) => this.delegate.prepare(input);

  async upsertRecords(input: Parameters<VectorIndexPort["upsertRecords"]>[0]) {
    this.upsertCalls += 1;
    if (this.upsertCalls === this.failUpsertCall) {
      throw new Error("simulated batch interruption");
    }
    return this.delegate.upsertRecords(input);
  }

  async listVersionRecords(
    input: Parameters<VectorIndexPort["listVersionRecords"]>[0],
  ) {
    if (this.upsertCalls === 0 && this.reportedBeforeUpsert !== undefined) {
      return this.reportedBeforeUpsert;
    }
    const records = await this.delegate.listVersionRecords(input);
    return this.omitRecordAfterUpsert && this.upsertCalls > 0
      ? records.slice(1)
      : records;
  }

  search: VectorIndexPort["search"] = (input) => this.delegate.search(input);
  retainVersion: VectorIndexPort["retainVersion"] = (input) =>
    this.delegate.retainVersion(input);
  releaseRetentionLease: VectorIndexPort["releaseRetentionLease"] = (input) =>
    this.delegate.releaseRetentionLease(input);
  deleteVersion: VectorIndexPort["deleteVersion"] = (input) =>
    this.delegate.deleteVersion(input);
}

function createCommand(chunkCount: number): PublishDocumentIndexCommand {
  const document = createDocumentFixture();
  const semanticUnits = createSemanticUnitFixture();
  const chunks = Array.from({ length: chunkCount }, (_, index) =>
    createChunk(index, chunkCount),
  );
  return {
    document,
    semanticUnits,
    chunks,
    embeddings: chunks.map((chunk, index): ChunkEmbedding => ({
      chunkId: chunk.id,
      chunkRevisionId: chunk.revisionId,
      contentDigest: chunk.contentDigest,
      vector: [1, index / 10, 0],
      origin: "generated",
    })),
    embeddingProfile: profile,
    connectorId: "vector.main",
    securityDomain: "tenant-a",
    semanticScopes: [
      { semanticUnitIds: ["unit_payments", "unit_payment_failures"] },
    ],
  };
}

function createChunk(index: number, chunkCount: number): ManagedChunk {
  const base = createManagedChunkFixture()[0]!;
  const suffix = String.fromCharCode("a".charCodeAt(0) + index).repeat(4);
  return {
    ...base,
    id: `chk_payment_failures_${index}`,
    revisionId: `crv_${suffix}`,
    ordinal: index,
    text: base.text,
    contentDigest: sha256Digest(base.text),
    ...(index === 0
      ? {}
      : { previousChunkId: `chk_payment_failures_${index - 1}` }),
    ...(index === chunkCount - 1
      ? {}
      : { nextChunkId: `chk_payment_failures_${index + 1}` }),
  };
}

function versionIdentity(command: PublishDocumentIndexCommand) {
  return {
    documentIndexId: createDocumentIndexId(
      command.document.sourceId,
      command.document.documentId,
    ),
    indexVersion: createIndexVersion({
      document: command.document,
      semanticUnits: command.semanticUnits,
      chunks: command.chunks,
      embeddingProfile: command.embeddingProfile,
      segmentationPolicyVersion:
        command.semanticUnits[0]!.segmentationPolicyVersion,
      chunkPolicyVersion: command.chunks[0]!.chunkPolicyVersion,
      textMeasureProfileVersion: command.chunks[0]!.textMeasureProfileVersion,
      payloadSchemaVersion: 1,
    }),
  };
}

function conflictingStoredRecord(
  command: PublishDocumentIndexCommand,
): VectorIndexStoredRecord {
  const identity = versionIdentity(command);
  const chunk = command.chunks[0]!;
  return {
    recordId: createVectorRecordId(
      identity.documentIndexId,
      identity.indexVersion,
      chunk.revisionId,
    ),
    metadata: {
      payloadSchemaVersion: 1,
      sourceId: command.document.sourceId,
      observationId: command.document.observationId,
      documentId: command.document.documentId,
      ...identity,
      semanticUnitId: chunk.semanticUnitId,
      chunkId: chunk.id,
      chunkRevisionId: chunk.revisionId,
      contentDigest: `sha256:${"f".repeat(64)}`,
    },
  };
}
