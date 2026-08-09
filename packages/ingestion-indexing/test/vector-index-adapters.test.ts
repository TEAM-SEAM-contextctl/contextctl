import { describe, expect, it } from "vitest";

import {
  InMemoryVectorIndexAdapter,
  QdrantVectorIndexAdapter,
  VectorIndexFault,
  createVectorRecordId,
  type EmbeddingProfile,
  type VectorIndexPort,
  type VectorIndexRecord,
} from "../src/index.js";

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
  securityDomain: "test-tenant",
  embeddingProfile: profile,
  payloadSchemaVersion: 1 as const,
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
    const oneUnit = await search(adapter, prepared.accessHandle, ["unit_refunds"]);
    const severalUnits = await search(adapter, prepared.accessHandle, [
      "unit_refunds",
      "unit_shipping",
    ]);
    const missing = await search(adapter, prepared.accessHandle, ["unit_missing"]);

    expect(wholeDocument.map((hit) => hit.metadata.documentId)).toEqual([
      "doc_payments",
      "doc_payments",
    ]);
    expect(oneUnit.map((hit) => hit.metadata.semanticUnitId)).toEqual([
      "unit_refunds",
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
    await adapter.search({
      accessHandle: prepared.accessHandle,
      scope: {
        documentIndexId: "didx_payments",
        indexVersion: "idxv_aaaa",
        documentId: "doc_payments",
        semanticUnitIds: ["unit_refunds", "unit_shipping"],
      },
      queryVector: [1, 0, 0],
      limit: 4,
    });

    expect(client.lastPointId).toMatch(/^[a-f0-9-]{36}$/);
    expect(client.lastPointId).not.toContain(value.recordId);
    expect(client.lastFilter).toEqual({
      must: [
        { key: "recordKind", match: { value: "chunk" } },
        { key: "documentIndexId", match: { value: "didx_payments" } },
        { key: "indexVersion", match: { value: "idxv_aaaa" } },
        { key: "documentId", match: { value: "doc_payments" } },
        {
          key: "semanticUnitId",
          match: { any: ["unit_refunds", "unit_shipping"] },
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
    ).toEqual([{ recordId: value.recordId, metadata: value.metadata }]);
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
            value.metadata.documentIndexId,
            value.metadata.indexVersion,
            "crv_bbbb",
          ),
          ...value.metadata,
        },
      }],
    };
    await expect(search(adapter, prepared.accessHandle)).rejects.toMatchObject({
      code: "storage_unavailable",
      retriable: false,
    });
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
  return {
    recordId: createVectorRecordId(documentIndexId, indexVersion, chunkRevisionId),
    chunkRevisionId,
    embedding,
    metadata: {
      payloadSchemaVersion: 1,
      sourceId: `src_${document}`,
      observationId: `obs_${document}`,
      documentId: `doc_${document}`,
      documentIndexId,
      indexVersion,
      semanticUnitId: `unit_${unit}`,
      chunkId: `chk_${revision}`,
      chunkRevisionId,
      contentDigest: `sha256:${revision.padEnd(64, "a").slice(0, 64)}`,
    },
  };
}

function qdrant(client: FakeQdrantClient): QdrantVectorIndexAdapter {
  return new QdrantVectorIndexAdapter({
    url: "http://127.0.0.1:6333",
    client,
  });
}

class FakeQdrantClient {
  readonly createdCollections: object[] = [];
  readonly createdIndexes: string[] = [];
  readonly payloadIndexes = new Map<string, string>();
  exists = false;
  ignoreIndexCreation = false;
  failure: unknown;
  lastPointId: string | undefined;
  lastFilter: unknown;
  lastCountRequest: unknown;
  activeLeaseCount = 0;
  queryResult: unknown = { points: [] };
  scrollResult: unknown = { points: [], next_page_offset: null };

  async collectionExists() {
    this.raise();
    return { exists: this.exists };
  }

  async createCollection(_name: string, request: object) {
    this.raise();
    this.exists = true;
    this.createdCollections.push(request);
    return true;
  }

  async getCollection() {
    this.raise();
    return {
      config: { params: { vectors: { size: 3, distance: "Cosine" } } },
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
    return { status: "completed" };
  }

  async upsert(_name: string, request: object) {
    this.raise();
    const point = (request as { points: { id: string }[] }).points[0];
    this.lastPointId = point?.id;
    return { status: "completed" };
  }

  async query(_name: string, request: object) {
    this.raise();
    this.lastFilter = (request as { filter: unknown }).filter;
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
