import { describe, expect, it } from "vitest";

import {
  QdrantVectorIndexAdapter,
  createVectorRecordId,
  sha256Digest,
  type EmbeddingProfile,
  type VectorIndexRecord,
} from "../src/index.js";

const qdrantUrl = process.env.CONTEXTCTL_QDRANT_URL;
const integration = qdrantUrl === undefined ? describe.skip : describe;
const integrationTestTimeoutMs = 30_000;
const stateNamespaceId = `state-integration-${String(Date.now())}`;
const securityDomain = `integration-${String(Date.now())}`;

const profile: EmbeddingProfile = {
  id: "qdrant-integration",
  version: "1.0.0",
  model: "qdrant-integration-v1",
  dimensions: 3,
  distance: "cosine",
  maxInputTokens: 480,
  textMeasureProfileVersion: "unicode-estimate-v1",
};

integration("QdrantVectorIndexAdapter integration", () => {
  it("publishes, filters, retains and deletes immutable versions", async () => {
    const adapter = new QdrantVectorIndexAdapter({ url: requiredUrl() });
    const prepared = await adapter.prepare({
      stateNamespaceId,
      securityDomain,
      embeddingProfile: profile,
      payloadSchemaVersion: 2,
    });
    const payments = record("payments", "aaaa", "refunds", [1, 0, 0]);
    const inventory = record("inventory", "bbbb", "stock", [1, 0, 0]);

    await adapter.upsertRecords({
      accessHandle: prepared.accessHandle,
      embeddingProfile: profile,
      records: [payments],
    });
    await adapter.upsertRecords({
      accessHandle: prepared.accessHandle,
      embeddingProfile: profile,
      records: [inventory],
    });
    await adapter.upsertRecords({
      accessHandle: prepared.accessHandle,
      embeddingProfile: profile,
      records: [payments],
    });

    const paymentsOnly = await adapter.search({
      accessHandle: prepared.accessHandle,
      scope: {
        documentIndexId: "didx_payments",
        indexVersion: "idxv_aaaa",
        documentId: "doc_payments",
        semanticUnitIds: ["unit_refunds"],
      },
      queryVector: [1, 0, 0],
      limit: 10,
    });
    expect(paymentsOnly).toHaveLength(1);
    expect(paymentsOnly[0]?.metadata.documentId).toBe("doc_payments");
    expect(
      await adapter.listVersionRecords({
        accessHandle: prepared.accessHandle,
        documentIndexId: "didx_payments",
        indexVersion: "idxv_aaaa",
      }),
    ).toEqual([
      {
        recordId: payments.recordId,
        // Required by payload schema v2, and required here for the reason the
        // schema requires it: the stored text is what a reindex copies forward
        // instead of embedding again, so a record that came back without it
        // would silently lose the Chunk's text on the next publication.
        retrievalText: payments.retrievalText,
        metadata: payments.metadata,
      },
    ]);
    // Byte-for-byte, not merely present. The digest in the metadata is taken
    // over exactly these bytes, so text that survived the round trip in a
    // different encoding would still satisfy a looser check and would then fail
    // verification somewhere with no reference to this store.
    const [storedPayments] = await adapter.listVersionRecords({
      accessHandle: prepared.accessHandle,
      documentIndexId: "didx_payments",
      indexVersion: "idxv_aaaa",
    });
    expect(Buffer.from(storedPayments?.retrievalText ?? "", "utf8")).toEqual(
      Buffer.from(payments.retrievalText, "utf8"),
    );
    expect(storedPayments?.metadata.contentDigest).toBe(
      sha256Digest(payments.retrievalText),
    );

    await adapter.retainVersion({
      accessHandle: prepared.accessHandle,
      lease: {
        leaseId: "lease_integration",
        documentIndexId: "didx_payments",
        indexVersion: "idxv_aaaa",
        expiresAt: "2099-01-01T00:00:00.000Z",
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
    await adapter.releaseRetentionLease({
      accessHandle: prepared.accessHandle,
      leaseId: "lease_integration",
    });
    await adapter.deleteVersion({
      accessHandle: prepared.accessHandle,
      documentIndexId: "didx_payments",
      indexVersion: "idxv_aaaa",
      now: "2026-08-09T00:00:00.000Z",
    });

    expect(
      await adapter.search({
        accessHandle: prepared.accessHandle,
        scope: {
          documentIndexId: "didx_payments",
          indexVersion: "idxv_aaaa",
          documentId: "doc_payments",
        },
        queryVector: [1, 0, 0],
        limit: 10,
      }),
    ).toEqual([]);
    expect(
      await adapter.search({
        accessHandle: prepared.accessHandle,
        scope: {
          documentIndexId: "didx_inventory",
          indexVersion: "idxv_aaaa",
          documentId: "doc_inventory",
        },
        queryVector: [1, 0, 0],
        limit: 10,
      }),
    ).toHaveLength(1);
  }, integrationTestTimeoutMs);
});

function requiredUrl(): string {
  if (qdrantUrl === undefined) throw new Error("CONTEXTCTL_QDRANT_URL is required");
  return qdrantUrl;
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
    recordId: createVectorRecordId(stateNamespaceId, documentIndexId, indexVersion, chunkRevisionId),
    chunkRevisionId,
    embedding,
    retrievalText,
    metadata: {
      payloadSchemaVersion: 2,
      stateNamespaceId,
      securityDomain,
      sourceId: `src_${document}`,
      observationId: `obs_${document}`,
      documentId: `doc_${document}`,
      documentIndexId,
      indexVersion,
      semanticUnitId: `unit_${unit}`,
      chunkId: `chk_${revision}`,
      chunkRevisionId,
      contentDigest: sha256Digest(retrievalText),
    },
  };
}
