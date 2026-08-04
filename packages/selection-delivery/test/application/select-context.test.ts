import { describe, expect, it } from "vitest";

import {
  selectContext,
  type SelectContextPorts,
} from "../../src/application/select-context.js";
import { EmptyQueryError } from "../../src/application/errors.js";
import type {
  ApprovedCard,
  ApprovedDocumentSelection,
  ApprovedManagedDocumentScope,
} from "../../src/domain/card-catalog.js";
import { FixtureDocumentRetriever } from "../../src/infrastructure/fixture-document-retriever.js";
import { InMemoryCardCatalog } from "../../src/infrastructure/in-memory-card-catalog.js";
import type { ApprovedCardCatalog } from "../../src/ports/approved-card-catalog.js";
import {
  DocumentRetrievalFault,
  type DocumentChunkQuery,
  type ManagedDocumentRetriever,
  type RetrievedChunk,
} from "../../src/ports/managed-document-retriever.js";
import { createDemoCardSet } from "../fixtures/approved-card.fixture.js";
import { createRefundPolicyChunkMap } from "../fixtures/document-chunk.fixture.js";

/** The demo question: it names refund wording and stock wording at once. */
const DEMO_QUERY = "환불할 수 없는 상품과 현재 재고를 알려줘";

/** Matches the single keyword the hand-built Cards below declare. */
const ADMITTING_QUERY = "재고 알려줘";

interface CatalogSpy {
  readonly catalog: ApprovedCardCatalog;
  readonly calls: readonly unknown[];
}

function createSpyCatalog(cards: readonly ApprovedCard[]): CatalogSpy {
  const calls: unknown[] = [];

  return {
    calls,
    catalog: {
      listApprovedCards: async () => {
        calls.push({});
        return cards;
      },
    },
  };
}

interface RetrieverSpy {
  readonly retriever: ManagedDocumentRetriever;
  readonly calls: readonly DocumentChunkQuery[];
}

function createSpyRetriever(
  respond: (
    query: DocumentChunkQuery,
  ) => readonly RetrievedChunk[] | Promise<readonly RetrievedChunk[]> = () => [],
): RetrieverSpy {
  const calls: DocumentChunkQuery[] = [];

  return {
    calls,
    retriever: {
      searchChunks: async (query) => {
        calls.push(query);
        return respond(query);
      },
    },
  };
}

function createManagedScope(
  name: string,
  selection: ApprovedDocumentSelection = { kind: "document" },
): ApprovedManagedDocumentScope {
  return {
    kind: "managed_document",
    reference: { scopeId: `scope_${name}`, scopeVersion: "scopev_0001" },
    documentIndex: {
      documentIndexId: `docidx_${name}`,
      sourceId: "src_test",
      documentId: `doc_${name}`,
      indexVersion: "idxv_0001",
      connectorId: "vector.local",
      accessHandle: `documents/${name}`,
    },
    selection,
  };
}

/**
 * A Card that `ADMITTING_QUERY` admits, carrying exactly the Scopes a test
 * needs. It declares one keyword and no prose, so its score is a direct match
 * and never depends on the similarity heuristic.
 */
function createManagedCard(
  name: string,
  scopes: readonly ApprovedManagedDocumentScope[],
): ApprovedCard {
  return {
    cardId: `card_${name}`,
    versionId: `cardv_${name}`,
    meaning: {
      description: "",
      representativeQuestions: [],
      aliases: [],
      keywords: ["재고"],
    },
    policy: { sensitive: false, allowedUsage: ["retrieval"] },
    scopes,
  };
}

function createChunk(
  name: string,
  overrides: Partial<RetrievedChunk> = {},
): RetrievedChunk {
  return {
    chunkId: `chunk_${name}`,
    chunkRevisionId: `chunkrev_${name}`,
    semanticUnitId: `unit_${name}`,
    documentId: "doc_test",
    contentDigest: `digest_${name}`,
    text: `${name} 본문`,
    score: 0.5,
    ...overrides,
  };
}

function createDemoPorts(): SelectContextPorts {
  return {
    catalog: new InMemoryCardCatalog(createDemoCardSet()),
    retriever: new FixtureDocumentRetriever(createRefundPolicyChunkMap()),
  };
}

describe("selectContext", () => {
  it("delivers document evidence and consumer contracts for the demo query", async () => {
    const result = await selectContext(createDemoPorts(), DEMO_QUERY);

    expect(result.query).toBe(DEMO_QUERY);
    expect(result.scoringPolicyVersion).toBe("selection-scoring-v1");
    expect(result.retrievalFailures).toEqual([]);

    // Only the refund Card owns a managed document Scope, so every chunk has to
    // carry its coordinates.
    expect(result.evidence.chunks.length).toBeGreaterThan(0);
    for (const chunk of result.evidence.chunks) {
      expect(chunk.cardId).toBe("card_refund_policy");
      expect(chunk.scopeRef).toEqual({
        scopeId: "scope_refund_policy_doc",
        scopeVersion: "scopev_0001",
      });
    }

    // The inventory Card is admitted and answered with coordinates; the payment
    // Card is rejected, so it authorises nothing.
    expect(result.contracts).toHaveLength(1);
    expect(result.contracts[0]).toMatchObject({
      kind: "sql",
      cardId: "card_inventory",
      table: "inventory",
      allowedOperations: ["select"],
    });
    expect(
      result.selection.outcomes.find(
        (outcome) => outcome.cardId === "card_payment_api",
      )?.verdict,
    ).toBe("reject");
  });

  it("rejects an empty query before the catalog is read", async () => {
    for (const queryText of ["", "   "]) {
      const catalog = createSpyCatalog(createDemoCardSet());
      const retriever = createSpyRetriever();

      await expect(
        selectContext(
          { catalog: catalog.catalog, retriever: retriever.retriever },
          queryText,
        ),
      ).rejects.toBeInstanceOf(EmptyQueryError);

      expect(catalog.calls).toHaveLength(0);
      expect(retriever.calls).toHaveLength(0);
    }
  });

  it("delivers an empty result for an empty catalog without failing", async () => {
    const retriever = createSpyRetriever();

    const result = await selectContext(
      { catalog: new InMemoryCardCatalog([]), retriever: retriever.retriever },
      DEMO_QUERY,
    );

    expect(result.candidates).toEqual([]);
    expect(result.selection.outcomes).toEqual([]);
    expect(result.selection.provenance.consideredCount).toBe(0);
    expect(result.evidence.chunks).toEqual([]);
    expect(result.contracts).toEqual([]);
    expect(result.retrievalFailures).toEqual([]);
    expect(retriever.calls).toHaveLength(0);
  });

  it("never reaches the retriever when every Card is rejected", async () => {
    const retriever = createSpyRetriever(() => [createChunk("unreachable")]);

    const result = await selectContext(
      {
        catalog: new InMemoryCardCatalog(createDemoCardSet()),
        retriever: retriever.retriever,
      },
      "오늘 서울 날씨 어때",
    );

    expect(retriever.calls).toHaveLength(0);
    expect(result.evidence.chunks).toEqual([]);
    expect(
      result.selection.outcomes.map((outcome) => outcome.verdict),
    ).toEqual(["reject", "reject", "reject"]);
  });

  it("isolates a faulting Scope and keeps the other Scope's chunks", async () => {
    const card = createManagedCard("multi", [
      createManagedScope("denied"),
      createManagedScope("open"),
    ]);
    const retriever = createSpyRetriever((query) => {
      if (query.documentIndex.documentIndexId === "docidx_denied") {
        throw new DocumentRetrievalFault("access_denied");
      }
      return [createChunk("open")];
    });

    const result = await selectContext(
      {
        catalog: new InMemoryCardCatalog([card]),
        retriever: retriever.retriever,
      },
      ADMITTING_QUERY,
    );

    expect(result.retrievalFailures).toEqual([
      {
        cardId: "card_multi",
        versionId: "cardv_multi",
        scopeRef: { scopeId: "scope_denied", scopeVersion: "scopev_0001" },
        code: "access_denied",
      },
    ]);
    expect(result.evidence.chunks).toHaveLength(1);
    expect(result.evidence.chunks[0]?.chunkId).toBe("chunk_open");
    expect(JSON.stringify(result)).not.toContain("Document retrieval failed");
  });

  it("reduces an unexpected retriever exception to retriever_error", async () => {
    const card = createManagedCard("broken", [createManagedScope("broken")]);
    const retriever = createSpyRetriever(() => {
      throw new Error("socket hang up at internal-vector-host:6333");
    });

    const result = await selectContext(
      {
        catalog: new InMemoryCardCatalog([card]),
        retriever: retriever.retriever,
      },
      ADMITTING_QUERY,
    );

    expect(result.retrievalFailures).toEqual([
      {
        cardId: "card_broken",
        versionId: "cardv_broken",
        scopeRef: { scopeId: "scope_broken", scopeVersion: "scopev_0001" },
        code: "retriever_error",
      },
    ]);
    expect(result.evidence.chunks).toEqual([]);
    expect(JSON.stringify(result)).not.toContain("internal-vector-host");
  });

  it("keeps one copy when two Scopes return the same chunk revision", async () => {
    const card = createManagedCard("twin", [
      createManagedScope("left"),
      createManagedScope("right"),
    ]);
    const retriever = createSpyRetriever(() => [createChunk("shared")]);

    const result = await selectContext(
      {
        catalog: new InMemoryCardCatalog([card]),
        retriever: retriever.retriever,
      },
      ADMITTING_QUERY,
    );

    expect(retriever.calls).toHaveLength(2);
    expect(result.evidence.chunks).toHaveLength(1);
    expect(result.evidence.omitted).toEqual([
      {
        chunkId: "chunk_shared",
        chunkRevisionId: "chunkrev_shared",
        reason: "duplicate_chunk_revision",
      },
    ]);
  });

  it("carries the caller's thresholds and budget into the result", async () => {
    const thresholds = { admit: 0.5, reject: 0.1 };
    const budget = { maxTotalCharacters: 60, maxChunks: 1 };

    const result = await selectContext(createDemoPorts(), DEMO_QUERY, {
      thresholds,
      budget,
    });

    expect(result.selection.provenance.thresholds).toEqual(thresholds);
    expect(result.evidence.budget).toEqual(budget);
    expect(result.evidence.chunks).toHaveLength(1);
    expect(result.evidence.truncated).toBe(true);
  });

  it("searches every managed document Scope of an admitted Card once", async () => {
    const card = createManagedCard("paired", [
      createManagedScope("whole"),
      createManagedScope("partial", {
        kind: "semantic_units",
        semanticUnitIds: ["unit_partial"],
      }),
    ]);
    const retriever = createSpyRetriever();

    await selectContext(
      {
        catalog: new InMemoryCardCatalog([card]),
        retriever: retriever.retriever,
      },
      ADMITTING_QUERY,
    );

    expect(retriever.calls).toHaveLength(2);
    expect(retriever.calls[0]?.documentIndex.documentIndexId).toBe(
      "docidx_whole",
    );
    expect(retriever.calls[0]?.selection).toEqual({ kind: "document" });
    expect(retriever.calls[1]?.documentIndex.documentIndexId).toBe(
      "docidx_partial",
    );
    expect(retriever.calls[1]?.selection).toEqual({
      kind: "semantic_units",
      semanticUnitIds: ["unit_partial"],
    });
    expect(retriever.calls[0]?.queryText).toBe(ADMITTING_QUERY);
  });

  it("tolerates an admitted Card that declares no Scope at all", async () => {
    const retriever = createSpyRetriever();

    const result = await selectContext(
      {
        catalog: new InMemoryCardCatalog([createManagedCard("bare", [])]),
        retriever: retriever.retriever,
      },
      ADMITTING_QUERY,
    );

    expect(result.selection.outcomes[0]?.verdict).toBe("admit");
    expect(retriever.calls).toHaveLength(0);
    expect(result.evidence.chunks).toEqual([]);
    expect(result.contracts).toEqual([]);
    expect(result.retrievalFailures).toEqual([]);
  });

  it("requests eight chunks per Scope unless the caller says otherwise", async () => {
    const card = createManagedCard("limited", [createManagedScope("limited")]);
    const catalog = new InMemoryCardCatalog([card]);

    const defaulted = createSpyRetriever();
    await selectContext({ catalog, retriever: defaulted.retriever }, ADMITTING_QUERY);
    expect(defaulted.calls[0]?.limit).toBe(8);

    const overridden = createSpyRetriever();
    await selectContext(
      { catalog, retriever: overridden.retriever },
      ADMITTING_QUERY,
      { chunkLimitPerScope: 3 },
    );
    expect(overridden.calls[0]?.limit).toBe(3);
  });

  it("records a deferred Card without retrieving anything for it", async () => {
    const retriever = createSpyRetriever();

    const result = await selectContext(
      {
        catalog: new InMemoryCardCatalog(createDemoCardSet()),
        retriever: retriever.retriever,
      },
      DEMO_QUERY,
      { thresholds: { admit: 0.99, reject: 0.01 } },
    );

    expect(retriever.calls).toHaveLength(0);
    expect(result.candidates).toHaveLength(3);
    expect(
      result.selection.outcomes.find(
        (outcome) => outcome.cardId === "card_refund_policy",
      )?.verdict,
    ).toBe("defer");
    expect(result.evidence.chunks).toEqual([]);
  });
});
