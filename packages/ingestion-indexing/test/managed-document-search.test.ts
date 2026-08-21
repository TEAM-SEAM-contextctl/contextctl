import { describe, expect, it } from "vitest";

import {
  DeterministicEmbeddingAdapter,
  DocumentIndexPublisher,
  EmbeddingProviderFault,
  InMemoryIndexPublicationStore,
  InMemoryIndexStagingAttemptStore,
  InMemoryVectorIndexAdapter,
  ManagedDocumentSearch,
  StaticQueryEmbeddingProviderRegistry,
  StaticVectorIndexConnectorRegistry,
  createVectorRecordId,
  sha256Digest,
  type EmbeddingPort,
  type EmbeddingProviderRequest,
  type PublishedIndexVersion,
  type VectorIndexPort,
  type VectorIndexRecord,
} from "../src/index.js";
import {
  createDocumentFixture,
  createManagedChunkFixture,
  createSemanticUnitFixture,
} from "./fixtures/document-fixture.js";

const profile = {
  id: "managed-search-test",
  version: "1.0.0",
  model: "managed-search-test-v1",
  dimensions: 3,
  distance: "cosine" as const,
  maxInputTokens: 480,
  textMeasureProfileVersion: "unicode-estimate-v1",
};

describe("ManagedDocumentSearch", () => {
  it("searches document, single Unit, and multiple Unit Scopes end to end", async () => {
    const harness = await createHarness();
    const documentScope = requiredScope(harness.publication, "document");
    const singleUnitScope = requiredScope(
      harness.publication,
      "semantic_units",
      1,
    );
    const multipleUnitScope = requiredScope(
      harness.publication,
      "semantic_units",
      2,
    );

    for (const scope of [
      documentScope,
      singleUnitScope,
      multipleUnitScope,
    ]) {
      const hits = await harness.search.search({
        queryText: "When should failed payments be retried?",
        securityDomain: "tenant-a",
        scopeRef: ref(scope),
        limit: 5,
      });
      const chunk = createManagedChunkFixture()[0]!;
      expect(hits).toEqual([
        {
          rank: 1,
          chunkId: chunk.id,
          chunkRevisionId: chunk.revisionId,
          semanticUnitId: chunk.semanticUnitId,
          documentId: chunk.documentId,
          text: chunk.text,
          contentDigest: chunk.contentDigest,
        },
      ]);
      expect(JSON.stringify(hits)).not.toMatch(
        /accessHandle|collection|credential|filter|score|vector|vendor/i,
      );
    }

    expect(harness.embeddings.requests).toHaveLength(3);
    expect(
      harness.embeddings.requests.every(
        (request) => JSON.stringify(request.profile) === JSON.stringify(profile),
      ),
    ).toBe(true);
  });

  it("excludes other documents and immutable versions in the same collection", async () => {
    const harness = await createHarness();
    const accessHandle = harness.publication.binding.accessHandle;
    await harness.vectorIndex.upsertRecords({
      accessHandle,
      embeddingProfile: profile,
      records: [
        record({
          documentIndexId: "didx_inventory",
          indexVersion: "idxv_bbbb",
          documentId: "doc_inventory",
          sourceId: "src_inventory",
          observationId: "obs_inventory",
          semanticUnitId: "unit_01890f5c-7b1a-707c-87c9-d66d9e355cdd",
          chunkId: "chk_01890f5c-7b1a-79fe-8696-7c125d2997bb",
          chunkRevisionId: "crv_bbbb",
          retrievalText: "Inventory stock policy",
        }),
      ],
      signal: new AbortController().signal,
    });
    await harness.vectorIndex.upsertRecords({
      accessHandle,
      embeddingProfile: profile,
      records: [
        record({
          documentIndexId: harness.publication.manifest.documentIndexId,
          indexVersion: "idxv_cccc",
          documentId: harness.publication.manifest.documentId,
          sourceId: harness.publication.manifest.sourceId,
          observationId: "obs_later",
          semanticUnitId: "unit_01890f5c-7b1a-7684-8f82-b5950cf2b0dd",
          chunkId: "chk_01890f5c-7b1a-760c-8557-d9a3fe71b70a",
          chunkRevisionId: "crv_cccc",
          retrievalText: "A later immutable version",
        }),
      ],
      signal: new AbortController().signal,
    });

    const hits = await harness.search.search({
      queryText: "payment retry",
      securityDomain: "tenant-a",
      scopeRef: ref(requiredScope(harness.publication, "document")),
      limit: 10,
    });

    expect(hits).toHaveLength(1);
    expect(hits[0]?.documentId).toBe(harness.publication.manifest.documentId);
    expect(hits[0]?.chunkRevisionId).toBe(
      createManagedChunkFixture()[0]!.revisionId,
    );
  });

  it("rejects security-domain and unpublished Scope mismatches before vector search", async () => {
    const harness = await createHarness();
    const scope = requiredScope(harness.publication, "document");

    const securityError = await harness.search
      .search({
        queryText: "payment retry",
        securityDomain: "tenant-b",
        scopeRef: ref(scope),
        limit: 5,
      })
      .catch((error: unknown) => error);
    expect(securityError).toMatchObject({
      code: "security_domain_mismatch",
    });
    expect(String(securityError)).not.toMatch(
      /accessHandle|collection|credential|filter|vector|vendor/i,
    );

    await expect(
      harness.search.search({
        queryText: "payment retry",
        securityDomain: "tenant-a",
        scopeRef: { ...ref(scope), scopeId: "scope_not_published" },
        limit: 5,
      }),
    ).rejects.toMatchObject({ code: "scope_not_published" });
    expect(harness.vectorIndex.searchCalls).toBe(0);
    expect(harness.embeddings.requests).toHaveLength(0);
  });

  it("fails closed when retrieval text does not match its content digest", async () => {
    const harness = await createHarness();
    harness.vectorIndex.corruptRetrievalText = true;

    await expect(
      harness.search.search({
        queryText: "payment retry",
        securityDomain: "tenant-a",
        scopeRef: ref(requiredScope(harness.publication, "document")),
        limit: 5,
      }),
    ).rejects.toMatchObject({ code: "search_result_invalid" });
  });

  it("fails closed when a Chunk is relabeled to another valid Unit", async () => {
    const harness = await createHarness();
    harness.vectorIndex.corruptSemanticUnitId = "unit_01890f5c-7b1a-72e9-843d-dfdd184c9ce7";

    await expect(
      harness.search.search({
        queryText: "payment retry",
        securityDomain: "tenant-a",
        scopeRef: ref(requiredScope(harness.publication, "document")),
        limit: 5,
      }),
    ).rejects.toMatchObject({ code: "search_result_invalid" });
  });

  it.each([
    ["embedding_artifact_unavailable", "embedding_artifact_unavailable"],
    ["input_limit_exceeded", "query_input_limit_exceeded"],
  ] as const)(
    "preserves the typed %s query embedding failure",
    async (providerCode, searchCode) => {
      const harness = await createHarness({
        embed: async () => {
          throw new EmbeddingProviderFault(providerCode, false);
        },
      });

      await expect(
        harness.search.search({
          queryText: "payment retry",
          securityDomain: "tenant-a",
          scopeRef: ref(requiredScope(harness.publication, "document")),
          limit: 5,
        }),
      ).rejects.toMatchObject({ code: searchCode, retriable: false });
    },
  );

  it("stops dispatching queued batch targets after caller cancellation", async () => {
    const harness = await createHarness(
      new DeterministicEmbeddingAdapter(),
      2,
    );
    const controller = new AbortController();
    harness.vectorIndex.onSearchStarted = () => controller.abort();
    const scopeRef = ref(requiredScope(harness.publication, "document"));

    const items = await harness.search.searchBatch({
      queryText: "payment retry",
      securityDomain: "tenant-a",
      targets: Array.from({ length: 8 }, (_unused, index) => ({
        targetKey: `target-${String(index)}`,
        scopeRef,
        limit: 5,
      })),
      signal: controller.signal,
    });

    expect(harness.vectorIndex.searchCalls).toBeGreaterThan(0);
    expect(harness.vectorIndex.searchCalls).toBeLessThanOrEqual(2);
    expect(items).toHaveLength(8);
    expect(
      items.every(
        (item) =>
          item.status === "failed" && item.failure.code === "cancelled",
      ),
    ).toBe(true);
  });
});

async function createHarness(
  embeddingDelegate: EmbeddingPort = new DeterministicEmbeddingAdapter(),
  maxConcurrency?: number,
) {
  const delegate = new InMemoryVectorIndexAdapter();
  const vectorIndex = new RecordingVectorIndex(delegate);
  const publications = new InMemoryIndexPublicationStore();
  const chunks = createManagedChunkFixture();
  const publication = await new DocumentIndexPublisher({
    vectorIndex,
    publications,
    stagingAttempts: new InMemoryIndexStagingAttemptStore(),
    clock: () => "2026-08-13T00:00:00.000Z",
  }).publish({
    stateNamespaceId: "state_test",
    document: createDocumentFixture(),
    semanticUnits: createSemanticUnitFixture(),
    chunks,
    embeddings: chunks.map((chunk) => ({
      chunkId: chunk.id,
      chunkRevisionId: chunk.revisionId,
      contentDigest: chunk.contentDigest,
      vector: [1, 0, 0],
      origin: "generated" as const,
    })),
    embeddingProfile: profile,
    connectorId: "vector.main",
    securityDomain: "tenant-a",
    semanticScopes: [
      { semanticUnitIds: ["unit_01890f5c-7b1a-7684-8f82-b5950cf2b0dd"] },
      {
        semanticUnitIds: ["unit_01890f5c-7b1a-72e9-843d-dfdd184c9ce7", "unit_01890f5c-7b1a-7684-8f82-b5950cf2b0dd"],
      },
    ],
  });
  const embeddings = new RecordingEmbeddingPort(
    embeddingDelegate,
  );
  return {
    embeddings,
    publication,
    vectorIndex,
    search: new ManagedDocumentSearch({
      embeddingProviders: new StaticQueryEmbeddingProviderRegistry([
        {
          securityDomain: "tenant-a",
          embeddingProfile: profile,
          providerId: "provider.test",
          provider: embeddings,
        },
      ]),
      vectorIndexes: new StaticVectorIndexConnectorRegistry([
        { connectorId: "vector.main", vectorIndex },
      ]),
      publications,
      ...(maxConcurrency === undefined ? {} : { maxConcurrency }),
    }),
  };
}

function requiredScope(
  publication: PublishedIndexVersion,
  kind: "document" | "semantic_units",
  unitCount?: number,
) {
  const scope = publication.scopes.find(
    (candidate) =>
      candidate.selector.kind === kind &&
      (candidate.selector.kind === "document" ||
        candidate.selector.semanticUnitIds.length === unitCount),
  );
  if (scope === undefined) throw new Error("required fixture Scope is missing");
  return scope;
}

function ref(scope: { readonly scopeId: string; readonly scopeVersion: string }) {
  return { scopeId: scope.scopeId, scopeVersion: scope.scopeVersion };
}

function record(input: {
  readonly documentIndexId: string;
  readonly indexVersion: string;
  readonly documentId: string;
  readonly sourceId: string;
  readonly observationId: string;
  readonly semanticUnitId: string;
  readonly chunkId: string;
  readonly chunkRevisionId: string;
  readonly retrievalText: string;
}): VectorIndexRecord {
  return {
    recordId: createVectorRecordId(
      "state_test",
      input.documentIndexId,
      input.indexVersion,
      input.chunkRevisionId,
    ),
    chunkRevisionId: input.chunkRevisionId,
    embedding: [1, 0, 0],
    retrievalText: input.retrievalText,
    metadata: {
      payloadSchemaVersion: 2,
      stateNamespaceId: "state_test",
      securityDomain: "tenant-a",
      sourceId: input.sourceId,
      observationId: input.observationId,
      documentId: input.documentId,
      documentIndexId: input.documentIndexId,
      indexVersion: input.indexVersion,
      semanticUnitId: input.semanticUnitId,
      chunkId: input.chunkId,
      chunkRevisionId: input.chunkRevisionId,
      contentDigest: sha256Digest(input.retrievalText),
    },
  };
}

class RecordingEmbeddingPort implements EmbeddingPort {
  readonly requests: EmbeddingProviderRequest[] = [];

  constructor(private readonly delegate: EmbeddingPort) {}

  async embed(request: EmbeddingProviderRequest) {
    this.requests.push(request);
    return this.delegate.embed(request);
  }
}

class RecordingVectorIndex implements VectorIndexPort {
  searchCalls = 0;
  onSearchStarted: (() => void) | undefined;
  corruptRetrievalText = false;
  corruptSemanticUnitId: string | undefined;

  constructor(private readonly delegate: VectorIndexPort) {}

  prepare: VectorIndexPort["prepare"] = (input) => this.delegate.prepare(input);
  rehydrate: VectorIndexPort["rehydrate"] = (input) =>
    this.delegate.rehydrate(input);
  upsertRecords: VectorIndexPort["upsertRecords"] = (input) =>
    this.delegate.upsertRecords(input);
  listVersionRecords: VectorIndexPort["listVersionRecords"] = (input) =>
    this.delegate.listVersionRecords(input);
  readVersionVectors: VectorIndexPort["readVersionVectors"] = (input) =>
    this.delegate.readVersionVectors(input);
  retainVersion: VectorIndexPort["retainVersion"] = (input) =>
    this.delegate.retainVersion(input);
  releaseRetentionLease: VectorIndexPort["releaseRetentionLease"] = (input) =>
    this.delegate.releaseRetentionLease(input);
  deleteVersion: VectorIndexPort["deleteVersion"] = (input) =>
    this.delegate.deleteVersion(input);

  async search(input: Parameters<VectorIndexPort["search"]>[0]) {
    this.searchCalls += 1;
    this.onSearchStarted?.();
    const hits = await this.delegate.search(input);
    if (hits[0] === undefined) return hits;
    const first = {
      ...hits[0],
      ...(this.corruptRetrievalText
        ? { retrievalText: "tampered text" }
        : {}),
      ...(this.corruptSemanticUnitId === undefined
        ? {}
        : {
            metadata: {
              ...hits[0].metadata,
              semanticUnitId: this.corruptSemanticUnitId,
            },
          }),
    };
    return [first, ...hits.slice(1)];
  }
}
