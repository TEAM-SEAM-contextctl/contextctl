import { describe, expect, it } from "vitest";

import {
  InMemoryVectorIndexAdapter,
  QdrantVectorIndexAdapter,
  VectorIndexFault,
  createVectorRecordId,
  sha256Digest,
  type EmbeddingProfile,
  type VectorIndexPort,
  type VectorIndexRecord,
} from "../src/index.js";
import { structuralId } from "./fixtures/root-id-fixture.js";

const profile: EmbeddingProfile = {
  id: "vector-test",
  version: "1.0.0",
  model: "vector-test-v1",
  dimensions: 3,
  distance: "cosine",
  maxInputTokens: 480,
  textMeasureProfileVersion: "unicode-estimate-v1",
};

const compatibility = {
  stateNamespaceId: "state_test",
  securityDomain: "test-tenant",
  embeddingProfile: profile,
  payloadSchemaVersion: 2 as const,
};

describe("VectorIndexPort contract", () => {
  it("isolates document and Unit scopes inside one compatibility collection", async () => {
    const adapter = new InMemoryVectorIndexAdapter();
    const prepared = await adapter.prepare(compatibility);
    await adapter.upsertRecords({
      accessHandle: prepared.accessHandle,
      embeddingProfile: profile,
      records: [
        record("payments", "aaaa", "refunds", [1, 0, 0]),
        record("payments", "bbbb", "shipping", [0.9, 0.1, 0]),
      ],
    });
    await adapter.upsertRecords({
      accessHandle: prepared.accessHandle,
      embeddingProfile: profile,
      records: [record("inventory", "cccc", "stock", [1, 0, 0])],
    });

    const wholeDocument = await search(adapter, prepared.accessHandle);
    const oneUnit = await search(adapter, prepared.accessHandle, ["unit_01890f5c-7b1a-74cb-87b1-6c88b18a4d78"]);
    const severalUnits = await search(adapter, prepared.accessHandle, [
      "unit_01890f5c-7b1a-74cb-87b1-6c88b18a4d78",
      "unit_01890f5c-7b1a-7da6-8af6-ec349f7998e3",
    ]);
    const missing = await search(adapter, prepared.accessHandle, ["unit_01890f5c-7b1a-7a13-8fd3-6939fe7fa688"]);

    expect(wholeDocument.map((hit) => hit.metadata.documentId)).toEqual([
      "doc_payments",
      "doc_payments",
    ]);
    expect(oneUnit.map((hit) => hit.metadata.semanticUnitId)).toEqual([
      "unit_01890f5c-7b1a-74cb-87b1-6c88b18a4d78",
    ]);
    expect(severalUnits).toHaveLength(2);
    expect(missing).toEqual([]);
  });

  it("uses deterministic versioned identities and makes retries idempotent", async () => {
    const adapter = new InMemoryVectorIndexAdapter();
    const prepared = await adapter.prepare(compatibility);
    const first = record("payments", "aaaa", "refunds", [1, 0, 0]);
    const nextVersion = {
      ...first,
      recordId: createVectorRecordId(
        first.metadata.stateNamespaceId,
        first.metadata.documentIndexId,
        "idxv_bbbb",
        first.chunkRevisionId,
      ),
      metadata: { ...first.metadata, indexVersion: "idxv_bbbb" },
    };
    await adapter.upsertRecords({
      accessHandle: prepared.accessHandle,
      embeddingProfile: profile,
      records: [first],
    });
    await adapter.upsertRecords({
      accessHandle: prepared.accessHandle,
      embeddingProfile: profile,
      records: [first],
    });
    await adapter.upsertRecords({
      accessHandle: prepared.accessHandle,
      embeddingProfile: profile,
      records: [nextVersion],
    });

    expect(await search(adapter, prepared.accessHandle)).toHaveLength(1);
    expect(
      await adapter.search({
        accessHandle: prepared.accessHandle,
        scope: {
          documentIndexId: "didx_payments",
          indexVersion: "idxv_bbbb",
          documentId: "doc_payments",
        },
        queryVector: [1, 0, 0],
        limit: 10,
      }),
    ).toHaveLength(1);
    expect(nextVersion.recordId).not.toBe(first.recordId);
  });

  it("protects retained versions and deletes only the requested immutable version", async () => {
    const adapter = new InMemoryVectorIndexAdapter();
    const prepared = await adapter.prepare(compatibility);
    await adapter.upsertRecords({
      accessHandle: prepared.accessHandle,
      embeddingProfile: profile,
      records: [record("payments", "aaaa", "refunds", [1, 0, 0])],
    });
    await adapter.retainVersion({
      accessHandle: prepared.accessHandle,
      lease: {
        leaseId: "lease_card_version",
        documentIndexId: "didx_payments",
        indexVersion: "idxv_aaaa",
        expiresAt: "2026-08-10T00:00:00.000Z",
      },
    });

    await expect(
      adapter.deleteVersion({
        accessHandle: prepared.accessHandle,
        documentIndexId: "didx_payments",
        indexVersion: "idxv_aaaa",
        now: "2026-08-09T00:00:00.000Z",
      }),
    ).rejects.toMatchObject({ code: "index_version_retained" });
    await adapter.deleteVersion({
      accessHandle: prepared.accessHandle,
      documentIndexId: "didx_payments",
      indexVersion: "idxv_aaaa",
      now: "2026-08-11T00:00:00.000Z",
    });
    expect(await search(adapter, prepared.accessHandle)).toEqual([]);
  });

  it("rejects invalid batches atomically and invalid or broader search inputs", async () => {
    const adapter = new InMemoryVectorIndexAdapter();
    const prepared = await adapter.prepare(compatibility);
    const valid = record("payments", "aaaa", "refunds", [1, 0, 0]);
    await expect(
      adapter.upsertRecords({
        accessHandle: prepared.accessHandle,
        embeddingProfile: profile,
        records: [
          valid,
          {
            ...record("payments", "bbbb", "shipping", [1, 0, 0]),
            metadata: {
              ...record("payments", "bbbb", "shipping", [1, 0, 0]).metadata,
              contentDigest: "not-a-digest",
            },
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "invalid_request", retriable: false });
    expect(await search(adapter, prepared.accessHandle)).toEqual([]);
    await expect(
      search(adapter, prepared.accessHandle, []),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      adapter.search({
        accessHandle: prepared.accessHandle,
        scope: {
          documentIndexId: "didx_payments",
          indexVersion: "idxv_aaaa",
          documentId: "doc_payments",
        },
        queryVector: [1, 0, 0],
        limit: 1_001,
      }),
    ).rejects.toMatchObject({ code: "invalid_request" });
  });
});

describe("Qdrant vector index adapter", () => {
  it("creates a compatibility collection and every required pre-filter index", async () => {
    const client = new FakeQdrantClient();
    const adapter = qdrant(client);
    const prepared = await adapter.prepare(compatibility);

    expect(prepared.capabilities.metadataPreFilter).toBe(true);
    expect(client.createdCollections).toHaveLength(1);
    expect(client.createdIndexes).toEqual(
      expect.arrayContaining([
        "recordKind",
        "sourceId",
        "documentIndexId",
        "indexVersion",
        "documentId",
        "semanticUnitId",
        "payloadSchemaVersion",
      ]),
    );
    expect(prepared.accessHandle).toMatch(/^qdrant:v1:[a-f0-9]{32}$/);
    expect(prepared.accessHandle).not.toContain("contextctl_");
  });

  it("recovers a committed collection create on a later prepare without retrying the create", async () => {
    const client = new FakeQdrantClient();
    client.loseCollectionCreateResponseOnce = true;
    const adapter = qdrant(client);

    await expect(adapter.prepare(compatibility)).rejects.toMatchObject({
      code: "storage_unavailable",
      retriable: true,
    });
    expect(client.collectionCreateCalls).toBe(1);

    await expect(adapter.prepare(compatibility)).resolves.toMatchObject({
      capabilities: { metadataPreFilter: true },
    });
    expect(client.collectionCreateCalls).toBe(1);
  });

  it("recovers a committed payload index create without recreating that field", async () => {
    const client = new FakeQdrantClient();
    client.losePayloadIndexCreateResponseOnce = "recordKind";
    const adapter = qdrant(client);

    await expect(adapter.prepare(compatibility)).rejects.toMatchObject({
      code: "storage_unavailable",
      retriable: true,
    });
    expect(
      client.createdIndexes.filter((field) => field === "recordKind"),
    ).toHaveLength(1);

    await expect(adapter.prepare(compatibility)).resolves.toMatchObject({
      capabilities: { metadataPreFilter: true },
    });
    expect(
      client.createdIndexes.filter((field) => field === "recordKind"),
    ).toHaveLength(1);
  });

  it("rehydrates an existing binding into a fresh Qdrant adapter without creating storage", async () => {
    const client = new FakeQdrantClient();
    const prepared = await qdrant(client).prepare(compatibility);
    const value = record("payments", "aaaa", "refunds", [1, 0, 0]);
    client.queryResult = {
      points: [
        {
          score: 0.9,
          payload: {
            recordKind: "chunk",
            recordId: value.recordId,
            retrievalText: value.retrievalText,
            ...value.metadata,
          },
        },
      ],
    };
    const creationsBeforeRestart = client.createdCollections.length;
    const restarted = qdrant(client);

    await restarted.rehydrate({
      accessHandle: prepared.accessHandle,
      compatibility: {
        payloadSchemaVersion: 2,
        stateNamespaceId: compatibility.stateNamespaceId,
        embeddingProfile: {
          distance: profile.distance,
          dimensions: profile.dimensions,
          id: profile.id,
          maxInputTokens: profile.maxInputTokens,
          model: profile.model,
          textMeasureProfileVersion: profile.textMeasureProfileVersion,
          version: profile.version,
        },
        securityDomain: compatibility.securityDomain,
      },
    });

    await expect(search(restarted, prepared.accessHandle)).resolves.toHaveLength(
      1,
    );
    expect(client.createdCollections).toHaveLength(creationsBeforeRestart);
  });

  it("translates records and exact Scope filters without leaking core IDs into point IDs", async () => {
    const client = new FakeQdrantClient();
    const adapter = qdrant(client);
    const prepared = await adapter.prepare(compatibility);
    const value = record("payments", "aaaa", "refunds", [1, 0, 0]);
    await adapter.upsertRecords({
      accessHandle: prepared.accessHandle,
      embeddingProfile: profile,
      records: [value],
    });
    client.queryResult = {
      points: [
        {
          score: 0.75,
          payload: {
            recordKind: "chunk",
            recordId: value.recordId,
            retrievalText: value.retrievalText,
            ...value.metadata,
          },
        },
      ],
    };
    const hits = await adapter.search({
      accessHandle: prepared.accessHandle,
      scope: {
        documentIndexId: "didx_payments",
        indexVersion: "idxv_aaaa",
        documentId: "doc_payments",
        semanticUnitIds: ["unit_01890f5c-7b1a-74cb-87b1-6c88b18a4d78", "unit_01890f5c-7b1a-7da6-8af6-ec349f7998e3"],
      },
      queryVector: [1, 0, 0],
      limit: 4,
    });

    expect(client.lastPointId).toMatch(/^[a-f0-9-]{36}$/);
    expect(client.lastPointId).not.toContain(value.recordId);
    expect(client.lastPayload).toMatchObject({
      retrievalText: value.retrievalText,
      contentDigest: value.metadata.contentDigest,
      payloadSchemaVersion: 2,
    });
    expect(hits).toEqual([
      {
        recordId: value.recordId,
        score: 0.75,
        retrievalText: value.retrievalText,
        metadata: value.metadata,
      },
    ]);
    expect(client.lastFilter).toEqual({
      must: [
        { key: "recordKind", match: { value: "chunk" } },
        { key: "documentIndexId", match: { value: "didx_payments" } },
        { key: "indexVersion", match: { value: "idxv_aaaa" } },
        { key: "documentId", match: { value: "doc_payments" } },
        {
          key: "semanticUnitId",
          match: { any: ["unit_01890f5c-7b1a-74cb-87b1-6c88b18a4d78", "unit_01890f5c-7b1a-7da6-8af6-ec349f7998e3"] },
        },
      ],
    });
  });

  it("reads staged version metadata through the exact version filter", async () => {
    const client = new FakeQdrantClient();
    const adapter = qdrant(client);
    const prepared = await adapter.prepare(compatibility);
    const value = record("payments", "aaaa", "refunds", [1, 0, 0]);
    client.scrollResult = {
      points: [
        {
          payload: {
            recordKind: "chunk",
            recordId: value.recordId,
            retrievalText: value.retrievalText,
            ...value.metadata,
          },
        },
      ],
      next_page_offset: null,
    };

    expect(
      await adapter.listVersionRecords({
        accessHandle: prepared.accessHandle,
        documentIndexId: "didx_payments",
        indexVersion: "idxv_aaaa",
      }),
    ).toEqual([
      {
        recordId: value.recordId,
        retrievalText: value.retrievalText,
        metadata: value.metadata,
      },
    ]);
    expect(client.lastFilter).toEqual({
      must: [
        { key: "recordKind", match: { value: "chunk" } },
        { key: "documentIndexId", match: { value: "didx_payments" } },
        { key: "indexVersion", match: { value: "idxv_aaaa" } },
      ],
    });
  });

  it("fails closed when Qdrant cannot prove the required payload indexes", async () => {
    const client = new FakeQdrantClient();
    client.ignoreIndexCreation = true;
    await expect(qdrant(client).prepare(compatibility)).rejects.toMatchObject({
      code: "filter_not_supported",
      retriable: false,
    });
  });

  it("fails closed when an existing payload index has the wrong schema", async () => {
    const client = new FakeQdrantClient();
    client.payloadIndexes.set("documentId", "integer");
    await expect(qdrant(client).prepare(compatibility)).rejects.toMatchObject({
      code: "filter_not_supported",
      retriable: false,
    });
  });

  it("uses an exact datetime-filtered lease count before version deletion", async () => {
    const client = new FakeQdrantClient();
    const adapter = qdrant(client);
    const prepared = await adapter.prepare(compatibility);
    client.activeLeaseCount = 1;

    await expect(adapter.deleteVersion({
      accessHandle: prepared.accessHandle,
      documentIndexId: "didx_payments",
      indexVersion: "idxv_aaaa",
      now: "2026-08-09T00:00:00.000Z",
    })).rejects.toMatchObject({ code: "index_version_retained" });
    expect(client.lastCountRequest).toEqual({
      exact: true,
      filter: {
        must: [
          { key: "recordKind", match: { value: "retention_lease" } },
          { key: "documentIndexId", match: { value: "didx_payments" } },
          { key: "indexVersion", match: { value: "idxv_aaaa" } },
          { key: "expiresAt", range: { gt: "2026-08-09T00:00:00.000Z" } },
        ],
      },
    });
  });

  it("translates access failures without exposing Qdrant details", async () => {
    const client = new FakeQdrantClient();
    client.failure = { status: 403, detail: "secret server response" };
    const error = await qdrant(client)
      .prepare(compatibility)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(VectorIndexFault);
    expect(error).toMatchObject({ code: "access_denied", retriable: false });
    expect(String(error)).not.toContain("secret server response");
  });

  it("returns stable storage faults for provider failures and corrupted hits", async () => {
    const client = new FakeQdrantClient();
    const adapter = qdrant(client);
    const prepared = await adapter.prepare(compatibility);
    client.failure = { status: 503, detail: "private provider detail" };
    const providerError = await search(adapter, prepared.accessHandle)
      .catch((caught: unknown) => caught);
    expect(providerError).toMatchObject({
      code: "storage_unavailable",
      retriable: true,
    });
    expect(String(providerError)).not.toContain("private provider detail");

    client.failure = undefined;
    const value = record("payments", "aaaa", "refunds", [1, 0, 0]);
    client.queryResult = {
      points: [{
        score: 1,
        payload: {
          recordKind: "chunk",
          recordId: createVectorRecordId(
            value.metadata.stateNamespaceId,
            value.metadata.documentIndexId,
            value.metadata.indexVersion,
            "crv_bbbb",
          ),
          retrievalText: value.retrievalText,
          ...value.metadata,
        },
      }],
    };
    await expect(search(adapter, prepared.accessHandle)).rejects.toMatchObject({
      code: "invalid_result",
      retriable: false,
    });
  });

  it("retries transient idempotent reads within a fixed call budget", async () => {
    const client = new FakeQdrantClient();
    const adapter = qdrant(client);
    const prepared = await adapter.prepare(compatibility);
    client.transientQueryFailures = 2;

    await expect(search(adapter, prepared.accessHandle)).resolves.toEqual([]);
    expect(client.queryCalls).toBe(3);

    client.transientQueryFailures = 4;
    await expect(search(adapter, prepared.accessHandle)).rejects.toMatchObject({
      code: "storage_unavailable",
      retriable: true,
    });
    expect(client.queryCalls).toBe(6);
  });

  it("rejects a collection whose compatibility ownership marker changed", async () => {
    const client = new FakeQdrantClient();
    const prepared = await qdrant(client).prepare(compatibility);
    client.compatibilityMetadata = "0".repeat(64);

    await expect(
      qdrant(client).rehydrate({
        accessHandle: prepared.accessHandle,
        compatibility,
      }),
    ).rejects.toMatchObject({ code: "invalid_request", retriable: false });
  });

  it("propagates caller cancellation to the Qdrant query request", async () => {
    const client = new FakeQdrantClient();
    const adapter = qdrant(client);
    const prepared = await adapter.prepare(compatibility);
    client.blockQueryUntilAbort = true;
    const controller = new AbortController();

    const pending = adapter.search({
      accessHandle: prepared.accessHandle,
      scope: {
        documentIndexId: "didx_payments",
        indexVersion: "idxv_aaaa",
        documentId: "doc_payments",
      },
      queryVector: [1, 0, 0],
      limit: 5,
      signal: controller.signal,
    });
    await Promise.resolve();
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(client.lastQuerySignal).toBe(controller.signal);
  });

  it("rejects credential-bearing and non-local plaintext endpoints", () => {
    expect(
      () => new QdrantVectorIndexAdapter({ url: "https://user:secret@example.test" }),
    ).toThrow(TypeError);
    expect(
      () => new QdrantVectorIndexAdapter({ url: "http://qdrant.example.test" }),
    ).toThrow(TypeError);
    expect(
      () => new QdrantVectorIndexAdapter({ url: "http://127.0.0.1:6333" }),
    ).not.toThrow();
  });

  it("rejects an unbounded or malformed retry policy", () => {
    for (const maxAttempts of [0, 6, 1.5]) {
      expect(
        () =>
          new QdrantVectorIndexAdapter({
            url: "http://127.0.0.1:6333",
            maxAttempts,
          }),
      ).toThrow(RangeError);
    }
    expect(
      () =>
        new QdrantVectorIndexAdapter({
          url: "http://127.0.0.1:6333",
          retryDelayMs: -1,
        }),
    ).toThrow(RangeError);
  });
});

async function search(
  adapter: VectorIndexPort,
  accessHandle: string,
  semanticUnitIds?: readonly string[],
) {
  return adapter.search({
    accessHandle,
    scope: {
      documentIndexId: "didx_payments",
      indexVersion: "idxv_aaaa",
      documentId: "doc_payments",
      ...(semanticUnitIds === undefined ? {} : { semanticUnitIds }),
    },
    queryVector: [1, 0, 0],
    limit: 10,
    signal: new AbortController().signal,
  });
}

function record(
  document: string,
  revision: string,
  unit: string,
  embedding: readonly number[],
): VectorIndexRecord {
  const documentIndexId = `didx_${document}`;
  const indexVersion = "idxv_aaaa";
  const chunkRevisionId = `crv_${revision}`;
  const retrievalText = `${document}:${unit}:${revision}`;
  return {
    recordId: createVectorRecordId("state_test", documentIndexId, indexVersion, chunkRevisionId),
    chunkRevisionId,
    embedding,
    retrievalText,
    metadata: {
      payloadSchemaVersion: 2,
      stateNamespaceId: "state_test",
      securityDomain: "test-tenant",
      sourceId: `src_${document}`,
      observationId: `obs_${document}`,
      documentId: `doc_${document}`,
      documentIndexId,
      indexVersion,
      semanticUnitId: structuralId("unit", unit),
      chunkId: structuralId("chk", revision),
      chunkRevisionId,
      contentDigest: sha256Digest(retrievalText),
    },
  };
}

function qdrant(client: FakeQdrantClient): QdrantVectorIndexAdapter {
  return new QdrantVectorIndexAdapter({
    url: "http://127.0.0.1:6333",
    client,
    retryDelayMs: 0,
  });
}

class FakeQdrantClient {
  readonly createdCollections: object[] = [];
  readonly createdIndexes: string[] = [];
  readonly payloadIndexes = new Map<string, string>();
  exists = false;
  ignoreIndexCreation = false;
  loseCollectionCreateResponseOnce = false;
  losePayloadIndexCreateResponseOnce: string | undefined;
  failure: unknown;
  lastPointId: string | undefined;
  lastPayload: unknown;
  lastFilter: unknown;
  lastCountRequest: unknown;
  activeLeaseCount = 0;
  compatibilityMetadata: string | undefined;
  queryResult: unknown = { points: [] };
  scrollResult: unknown = { points: [], next_page_offset: null };
  blockQueryUntilAbort = false;
  lastQuerySignal: AbortSignal | undefined;
  queryCalls = 0;
  transientQueryFailures = 0;
  collectionCreateCalls = 0;

  async collectionExists() {
    this.raise();
    return { exists: this.exists };
  }

  async createCollection(_name: string, request: object) {
    this.raise();
    this.collectionCreateCalls += 1;
    this.exists = true;
    this.createdCollections.push(request);
    this.compatibilityMetadata = (
      request as {
        readonly metadata?: { readonly contextctlCompatibility?: string };
      }
    ).metadata?.contextctlCompatibility;
    if (this.loseCollectionCreateResponseOnce) {
      this.loseCollectionCreateResponseOnce = false;
      throw { status: 503 };
    }
    return true;
  }

  async getCollection() {
    this.raise();
    return {
      config: {
        params: { vectors: { size: 3, distance: "Cosine" } },
        metadata: {
          contextctlCompatibility: this.compatibilityMetadata,
        },
      },
      payload_schema: Object.fromEntries(
        [...this.payloadIndexes].map(([field, dataType]) => [field, { data_type: dataType }]),
      ),
    };
  }

  async createPayloadIndex(_name: string, request: object) {
    this.raise();
    const { field_name: field, field_schema: schema } = request as {
      field_name: string;
      field_schema: string;
    };
    this.createdIndexes.push(field);
    if (!this.ignoreIndexCreation) this.payloadIndexes.set(field, schema);
    if (this.losePayloadIndexCreateResponseOnce === field) {
      this.losePayloadIndexCreateResponseOnce = undefined;
      throw { status: 503 };
    }
    return { status: "completed" };
  }

  async upsert(_name: string, request: object) {
    this.raise();
    const point = (request as { points: { id: string; payload: unknown }[] })
      .points[0];
    this.lastPointId = point?.id;
    this.lastPayload = point?.payload;
    return { status: "completed" };
  }

  async query(_name: string, request: object, signal?: AbortSignal) {
    this.queryCalls += 1;
    if (this.transientQueryFailures > 0) {
      this.transientQueryFailures -= 1;
      throw { status: 503 };
    }
    this.raise();
    this.lastQuerySignal = signal;
    this.lastFilter = (request as { filter: unknown }).filter;
    if (this.blockQueryUntilAbort) {
      await new Promise<never>((_resolve, reject) => {
        if (signal?.aborted === true) {
          reject(signal.reason);
          return;
        }
        signal?.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
    }
    return this.queryResult;
  }

  async scroll(_name: string, request: object) {
    this.raise();
    this.lastFilter = (request as { filter: unknown }).filter;
    return this.scrollResult;
  }

  async count(_name: string, request: object) {
    this.raise();
    this.lastCountRequest = request;
    return { count: this.activeLeaseCount };
  }

  async delete() {
    this.raise();
    return { status: "completed" };
  }

  private raise(): void {
    if (this.failure !== undefined) throw this.failure;
  }
}
