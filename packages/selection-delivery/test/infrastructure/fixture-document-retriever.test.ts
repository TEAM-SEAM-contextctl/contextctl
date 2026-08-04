import { describe, expect, it } from "vitest";

import type {
  ApprovedDocumentIndexRef,
  ApprovedDocumentSelection,
} from "../../src/domain/card-catalog.js";
import { FixtureDocumentRetriever } from "../../src/infrastructure/fixture-document-retriever.js";
import type {
  DocumentChunkQuery,
  RetrievedChunk,
} from "../../src/ports/managed-document-retriever.js";
import { DocumentRetrievalFault } from "../../src/ports/managed-document-retriever.js";
import { createRefundPolicyChunkMap } from "../fixtures/document-chunk.fixture.js";

const documentIndex: ApprovedDocumentIndexRef = {
  documentIndexId: "docidx_refund_policy",
  sourceId: "src_policy_docs",
  documentId: "doc_refund_policy",
  indexVersion: "idxv_0001",
  connectorId: "vector.local",
  accessHandle: "documents/policies/indexes/refund",
};

function query(
  overrides: Partial<DocumentChunkQuery> = {},
): DocumentChunkQuery {
  return {
    queryText: "환불",
    documentIndex,
    selection: { kind: "document" } satisfies ApprovedDocumentSelection,
    limit: 10,
    ...overrides,
  };
}

function chunkIdsOf(chunks: readonly RetrievedChunk[]): string[] {
  return chunks.map((chunk) => chunk.chunkId);
}

describe("FixtureDocumentRetriever", () => {
  it("returns every chunk of a registered index with a score inside [0, 1]", async () => {
    const retriever = new FixtureDocumentRetriever(createRefundPolicyChunkMap());

    const chunks = await retriever.searchChunks(
      query({ queryText: "환불 규정" }),
    );

    expect(chunkIdsOf(chunks).sort()).toEqual([
      "chunk_refund_excluded",
      "chunk_refund_window",
      "chunk_shipping_fee",
    ]);
    for (const chunk of chunks) {
      expect(chunk.score).toBeGreaterThanOrEqual(0);
      expect(chunk.score).toBeLessThanOrEqual(1);
    }
  });

  it("ranks the chunk that states the query wording first", async () => {
    const retriever = new FixtureDocumentRetriever(createRefundPolicyChunkMap());

    const chunks = await retriever.searchChunks(
      query({ queryText: "환불 불가 상품" }),
    );

    expect(chunks[0]?.chunkId).toBe("chunk_refund_excluded");
    expect(chunks[0]?.score).toBeGreaterThan(chunks[1]?.score ?? 1);
  });

  it("returns only the chunks the semantic unit selection names", async () => {
    const retriever = new FixtureDocumentRetriever(createRefundPolicyChunkMap());

    const chunks = await retriever.searchChunks(
      query({
        selection: {
          kind: "semantic_units",
          semanticUnitIds: ["unit_refund_excluded"],
        },
      }),
    );

    expect(chunkIdsOf(chunks)).toEqual(["chunk_refund_excluded"]);
  });

  it("returns nothing when the selection names no unit present in the index", async () => {
    const retriever = new FixtureDocumentRetriever(createRefundPolicyChunkMap());

    const chunks = await retriever.searchChunks(
      query({
        selection: {
          kind: "semantic_units",
          semanticUnitIds: ["unit_not_in_this_document"],
        },
      }),
    );

    expect(chunks).toEqual([]);
  });

  it("faults with index_unavailable when the index was never registered", async () => {
    const retriever = new FixtureDocumentRetriever(createRefundPolicyChunkMap());

    const search = retriever.searchChunks(
      query({
        documentIndex: { ...documentIndex, documentIndexId: "docidx_unknown" },
      }),
    );

    await expect(search).rejects.toBeInstanceOf(DocumentRetrievalFault);
    await expect(search).rejects.toMatchObject({ code: "index_unavailable" });
  });

  it("truncates to the requested limit, and returns nothing for a limit of zero", async () => {
    const retriever = new FixtureDocumentRetriever(createRefundPolicyChunkMap());

    expect(await retriever.searchChunks(query({ limit: 1 }))).toHaveLength(1);
    expect(await retriever.searchChunks(query({ limit: 0 }))).toEqual([]);
  });

  it("returns the same chunks in the same order for a repeated query", async () => {
    const retriever = new FixtureDocumentRetriever(createRefundPolicyChunkMap());

    const first = await retriever.searchChunks(query({ queryText: "환불 배송비" }));
    const second = await retriever.searchChunks(
      query({ queryText: "환불 배송비" }),
    );

    expect(second).toEqual(first);
  });
});
