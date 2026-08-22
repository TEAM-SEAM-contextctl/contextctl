import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  OpenAiCompatibleEmbeddingAdapter,
  QdrantVectorIndexAdapter,
  createLocalMarkdownPublicationRuntime,
  createVectorRecordId,
  sha256Digest,
  type EmbeddingProfile,
  type DocumentRetrievalEmbeddingProfile,
  type VectorIndexRecord,
} from "../src/index.js";
import { rootId, structuralId } from "./fixtures/root-id-fixture.js";

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
        documentId: rootId("doc", "payments"),
        semanticUnitIds: ["unit_01890f5c-7b1a-74cb-87b1-6c88b18a4d78"],
      },
      queryVector: [1, 0, 0],
      limit: 10,
    });
    expect(paymentsOnly).toHaveLength(1);
    expect(paymentsOnly[0]?.metadata.documentId).toBe(
      rootId("doc", "payments"),
    );
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
          documentId: rootId("doc", "payments"),
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
          documentId: rootId("doc", "inventory"),
        },
        queryVector: [1, 0, 0],
        limit: 10,
      }),
    ).toHaveLength(1);
  }, integrationTestTimeoutMs);

  it("publishes and searches one immutable Scope through a pinned remote provider", async () => {
    const fixtureDirectory = await mkdtemp(
      join(tmpdir(), "contextctl-remote-embedding-"),
    );
    const markdownPath = join(fixtureDirectory, "remote.md");
    await writeFile(
      markdownPath,
      "# 결제 운영\n\n## 재시도\n\n결제 실패는 세 번까지 재시도합니다.\n",
      "utf8",
    );
    const requests: Array<{ model: string; inputCount: number }> = [];
    const server = fixedEmbeddingServer(requests);
    const endpoint = await listen(server);
    const remoteSecurityDomain = `remote-${String(Date.now())}`;
    const remoteProfile: DocumentRetrievalEmbeddingProfile = {
      id: "document-fixed-remote-v1",
      version: "1",
      model: "fixed-remote-model-2026-08-21",
      modelRevision: "sha256:fixed-remote-model-revision",
      execution: {
        kind: "remote",
        adapter: "openai-compatible",
        adapterVersion: "1.0.0",
        model: "fixed-remote-model-2026-08-21",
      },
      dimensions: 3,
      pooling: "provider_defined",
      normalization: "l2",
      distance: "cosine",
      documentInputTransformVersion: "identity-v1",
      queryInputTransformVersion: "identity-v1",
      modelMaxTokens: 8_192,
      admissionLimit: {
        textMeasureProfileVersion: "unicode-estimate-v1",
        maxUnits: 480,
      },
      maxInputTokens: 480,
      textMeasureProfileVersion: "unicode-estimate-v1",
    };

    try {
      const embeddingProvider = new OpenAiCompatibleEmbeddingAdapter({
        endpoint,
        profile: remoteProfile,
        headers: { authorization: "Bearer integration-secret" },
      });
      const runtime = createLocalMarkdownPublicationRuntime({
        configurations: { "source.remote": { path: markdownPath } },
        embeddingProfile: remoteProfile,
        embeddingProvider,
        embeddingProviderId: "remote.integration",
        vectorIndex: new QdrantVectorIndexAdapter({ url: requiredUrl() }),
        connectorId: "vector.qdrant.remote",
        stateNamespaceId: `state-remote-${String(Date.now())}`,
        securityDomain: remoteSecurityDomain,
      });
      const published = await runtime.workflow.publish({
        source: {
          sourceType: "markdown",
          displayName: "Remote embedding fixture",
          configReference: "source.remote",
          polling: { enabled: false },
        },
        connectorId: "vector.qdrant.remote",
        securityDomain: remoteSecurityDomain,
      });
      const retryUnit = published.publication?.knowledgeUnits.find((unit) =>
        unit.facts.some(
          (fact) => fact.name === "section.label" && fact.value === "재시도",
        ),
      );
      if (retryUnit === undefined) {
        throw new Error("managed retry unit was not published");
      }
      const scope = retryUnit.publishedScopes[0];
      if (scope === undefined || scope.kind !== "managed_document") {
        throw new Error("managed retry Scope was not published");
      }

      const hits = await runtime.search.search({
        queryText: "결제 실패 재시도",
        securityDomain: remoteSecurityDomain,
        scopeRef: {
          scopeId: scope.scopeId,
          scopeVersion: scope.scopeVersion,
        },
        limit: 3,
      });

      expect(hits.length).toBeGreaterThan(0);
      expect(hits.every((hit) => hit.semanticUnitId === retryUnit.id)).toBe(true);
      expect(hits.some((hit) => hit.text.includes("재시도"))).toBe(true);
      expect(requests.length).toBeGreaterThanOrEqual(2);
      expect(requests.every((request) => request.model === remoteProfile.model))
        .toBe(true);
      expect(requests.every((request) => request.inputCount > 0)).toBe(true);
    } finally {
      await close(server);
      await rm(fixtureDirectory, { recursive: true, force: true });
    }
  }, integrationTestTimeoutMs);
});

function requiredUrl(): string {
  if (qdrantUrl === undefined) throw new Error("CONTEXTCTL_QDRANT_URL is required");
  return qdrantUrl;
}

function fixedEmbeddingServer(
  requests: Array<{ model: string; inputCount: number }>,
): Server {
  return createServer(async (request, response) => {
    try {
      if (
        request.method !== "POST" ||
        request.url !== "/v1/embeddings" ||
        request.headers.authorization !== "Bearer integration-secret"
      ) {
        response.writeHead(404).end();
        return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of request) {
        const buffer = Buffer.from(chunk);
        bytes += buffer.length;
        if (bytes > 1024 * 1024) {
          response.writeHead(413).end();
          return;
        }
        chunks.push(buffer);
      }
      const payload = JSON.parse(
        Buffer.concat(chunks).toString("utf8"),
      ) as unknown;
      if (
        !isRecord(payload) ||
        typeof payload.model !== "string" ||
        !Array.isArray(payload.input) ||
        payload.input.some((text) => typeof text !== "string")
      ) {
        response.writeHead(400).end();
        return;
      }
      requests.push({
        model: payload.model,
        inputCount: payload.input.length,
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          model: payload.model,
          data: payload.input.map((text, index) => ({
            index,
            embedding: text.includes("재시도") ? [1, 0, 0] : [0, 1, 0],
          })),
        }),
      );
    } catch {
      response.writeHead(500).end();
    }
  });
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo | null;
  if (address === null) throw new Error("embedding fixture did not listen");
  return `http://127.0.0.1:${String(address.port)}/v1/embeddings`;
}

async function close(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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
      sourceId: rootId("src", document),
      observationId: rootId("obs", document),
      documentId: rootId("doc", document),
      documentIndexId,
      indexVersion,
      semanticUnitId: structuralId("unit", unit),
      chunkId: structuralId("chk", revision),
      chunkRevisionId,
      contentDigest: sha256Digest(retrievalText),
    },
  };
}
