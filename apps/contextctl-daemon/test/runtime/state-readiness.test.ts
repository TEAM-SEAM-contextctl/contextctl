import { describe, expect, it, vi } from "vitest";

import type {
  IndexPublicationStore,
  PublishedIndexVersion,
  VectorIndexConnectorResolver,
  VectorIndexPort,
} from "@contextctl/ingestion-indexing";
import type {
  ApprovedCard,
  ApprovedCardCatalog,
} from "@contextctl/selection-delivery";

import {
  assertDaemonStateReady,
  DaemonStateReadinessError,
} from "../../src/runtime/state-readiness.js";

const stateIdentity: {
  readonly stateNamespaceId: string;
  readonly securityDomain: string;
} = {
  stateNamespaceId: "state_demo",
  securityDomain: "tenant-a",
} as const;

const scopeReference = {
  scopeId: "scope_01890f5c-7b1a-7100-8000-000000000001",
  scopeVersion: "scopev_aaaaaaaa",
} as const;

function approvedCard(): ApprovedCard {
  return {
    cardId: "card_01890f5c-7b1a-7100-8000-000000000002",
    versionId: "cardv_01890f5c-7b1a-7100-8000-000000000003",
    meaning: {
      description: "배송 조회",
      representativeQuestions: ["배송은 어디에 있나요?"],
      aliases: [],
      keywords: ["배송"],
    },
    policy: { sensitive: false, allowedUsage: ["retrieval"] },
    scopes: [
      {
        kind: "managed_document",
        reference: scopeReference,
        documentIndex: {
          documentIndexId: "didx_aaaaaaaa",
          sourceId: "src_01890f5c-7b1a-7100-8000-000000000004",
          documentId: "doc_01890f5c-7b1a-7100-8000-000000000005",
          indexVersion: "idxv_aaaaaaaa",
        },
        selection: { kind: "document" },
      },
    ],
  };
}

function publishedIndex(
  identity = stateIdentity,
): PublishedIndexVersion {
  const documentIndex = {
    documentIndexId: "didx_aaaaaaaa",
    sourceId: "src_01890f5c-7b1a-7100-8000-000000000004",
    documentId: "doc_01890f5c-7b1a-7100-8000-000000000005",
    indexVersion: "idxv_aaaaaaaa",
  } as const;
  const scope = {
    scopeId: scopeReference.scopeId,
    scopeVersion: scopeReference.scopeVersion,
    kind: "managed_document" as const,
    documentIndex,
    selector: { kind: "document" as const },
  };
  return {
    manifest: {
      manifestSchemaVersion: 2,
      payloadSchemaVersion: 2,
      stateNamespaceId: identity.stateNamespaceId,
      securityDomain: identity.securityDomain,
      sourceId: documentIndex.sourceId,
      observationId: "obs_01890f5c-7b1a-7100-8000-000000000006",
      documentId: documentIndex.documentId,
      documentIndexId: documentIndex.documentIndexId,
      indexVersion: documentIndex.indexVersion,
      documentSchemaVersion: 1,
      parserVersion: "1.0.0",
      normalizationPolicyVersion: "normalize-v1",
      lineagePolicyVersion: "lineage-v1",
      segmentationPolicyVersion: "segments-v1",
      chunkPolicyVersion: "chunks-v1",
      textMeasureProfileVersion: "unicode-estimate-v1",
      embeddingProfile: {
        id: "test-profile",
        version: "1.0.0",
        model: "test-model",
        dimensions: 8,
        distance: "cosine",
        maxInputTokens: 480,
        textMeasureProfileVersion: "unicode-estimate-v1",
      },
      semanticUnitRevisions: {},
      chunkRevisions: {},
      chunkBindings: {},
      recordCount: 0,
      recordSetDigest: `sha256:${"a".repeat(64)}`,
      scopeRevisions: [scopeReference],
      fallbackCounts: {},
      publishedAt: "2026-08-23T00:00:00.000Z",
    },
    documentIndex,
    scopes: [scope],
    binding: {
      stateNamespaceId: identity.stateNamespaceId,
      securityDomain: identity.securityDomain,
      documentIndexId: documentIndex.documentIndexId,
      indexVersion: documentIndex.indexVersion,
      connectorId: "vector.qdrant",
      accessHandle: "qdrant:v1:private-binding",
    },
  };
}

function dependencies(input: {
  readonly publication?: PublishedIndexVersion;
  readonly cards?: readonly ApprovedCard[];
  readonly rehydrate?: VectorIndexPort["rehydrate"];
}) {
  const cards = input.cards ?? [approvedCard()];
  const catalog: ApprovedCardCatalog = {
    listApprovedCards: async () => cards,
  };
  const publications: IndexPublicationStore = {
    findVersion: async () => undefined,
    current: async () => undefined,
    findScope: async () =>
      input.publication === undefined
        ? undefined
        : { publication: input.publication, scope: input.publication.scopes[0]! },
    commitCurrent: async () => {
      throw new Error("not used");
    },
  };
  const rehydrate =
    input.rehydrate ??
    vi.fn<VectorIndexPort["rehydrate"]>(async () => ({
      capabilities: { metadataPreFilter: true },
    }));
  const vectorIndexes: VectorIndexConnectorResolver = {
    resolve: () => ({ rehydrate } as VectorIndexPort),
  };
  return { stateIdentity, catalog, publications, vectorIndexes, rehydrate };
}

describe("daemon state readiness", () => {
  it("rehydrates every approved managed binding under the single identity", async () => {
    const input = dependencies({ publication: publishedIndex() });

    await expect(assertDaemonStateReady(input)).resolves.toBeUndefined();
    expect(input.rehydrate).toHaveBeenCalledWith(
      expect.objectContaining({
        accessHandle: "qdrant:v1:private-binding",
        compatibility: expect.objectContaining(stateIdentity),
      }),
    );
  });

  it("refuses an Index Catalog record from another state namespace", async () => {
    const input = dependencies({
      publication: publishedIndex({
        stateNamespaceId: "state_other",
        securityDomain: stateIdentity.securityDomain,
      }),
    });

    await expect(assertDaemonStateReady(input)).rejects.toMatchObject({
      code: "state_identity_mismatch",
      area: "index_catalog",
      retriable: false,
    });
    expect(input.rehydrate).not.toHaveBeenCalled();
  });

  it("refuses an approved Scope that the Index Catalog cannot resolve", async () => {
    await expect(
      assertDaemonStateReady(dependencies({})),
    ).rejects.toMatchObject({
      code: "scope_not_published",
      area: "index_catalog",
    });
  });

  it("does not disclose a physical binding when Qdrant rejects it", async () => {
    const input = dependencies({
      publication: publishedIndex(),
      rehydrate: async () => {
        throw new Error("secret endpoint and handle");
      },
    });

    const error = await assertDaemonStateReady(input).catch(
      (cause: unknown) => cause,
    );
    expect(error).toBeInstanceOf(DaemonStateReadinessError);
    expect(String(error)).toBe(
      "DaemonStateReadinessError: Daemon state is not ready: vector_index:index_binding_unavailable",
    );
    expect(String(error)).not.toContain("secret endpoint and handle");
    expect(String(error)).not.toContain("private-binding");
  });

  it("does not touch the Index Catalog or Qdrant when no managed Scope is approved", async () => {
    const catalog: ApprovedCardCatalog = { listApprovedCards: async () => [] };
    const findScope = vi.fn<IndexPublicationStore["findScope"]>();
    const resolve = vi.fn<VectorIndexConnectorResolver["resolve"]>();
    const publications: IndexPublicationStore = {
      findVersion: async () => undefined,
      current: async () => undefined,
      findScope,
      commitCurrent: async () => {
        throw new Error("not used");
      },
    };

    await expect(
      assertDaemonStateReady({
        stateIdentity,
        catalog,
        publications,
        vectorIndexes: { resolve },
      }),
    ).resolves.toBeUndefined();
    expect(findScope).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
  });
});
