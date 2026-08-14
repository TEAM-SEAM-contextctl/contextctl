import { describe, expect, it } from "vitest";

import {
  resolveContext,
  type ResolveContextPorts,
} from "../../src/application/resolve-context.js";
import { EmptyQueryError } from "../../src/application/errors.js";
import type {
  ApprovedCard,
  ApprovedDocumentSelection,
  ApprovedManagedDocumentScope,
} from "../../src/domain/card-catalog.js";
import type {
  ContextResolution,
  ResolutionItem,
} from "../../src/domain/context-resolution.js";
import {
  DEFAULT_EVIDENCE_BUDGET,
  type EvidenceBudget,
  type EvidenceChunk,
} from "../../src/domain/evidence-assembly.js";
import { FixtureDocumentRetriever } from "../../src/infrastructure/fixture-document-retriever.js";
import { InMemoryCardCatalog } from "../../src/infrastructure/in-memory-card-catalog.js";
import type { ApprovedCardCatalog } from "../../src/ports/approved-card-catalog.js";
import {
  DocumentRetrievalFault,
  type DocumentChunkQuery,
  type DocumentRetrievalFaultCode,
  type ManagedDocumentRetriever,
  type RetrievedChunk,
} from "../../src/ports/managed-document-retriever.js";
import {
  createDemoCardSet,
  DEMO_QUERY,
} from "../fixtures/approved-card.fixture.js";
import { createRefundPolicyChunkMap } from "../fixtures/document-chunk.fixture.js";

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

function createDemoPorts(): ResolveContextPorts {
  return {
    catalog: new InMemoryCardCatalog(createDemoCardSet()),
    retriever: new FixtureDocumentRetriever(createRefundPolicyChunkMap()),
  };
}

function portsFor(
  cards: readonly ApprovedCard[],
  retriever: ManagedDocumentRetriever,
): ResolveContextPorts {
  return { catalog: new InMemoryCardCatalog(cards), retriever };
}

/** `versionId/scopeId` for every item, in the order they were returned. */
function coordinates(resolution: ContextResolution): readonly string[] {
  return resolution.items.map(
    (item) => `${item.versionId}/${item.guide.scopeRef.scopeId}`,
  );
}

function itemFor(resolution: ContextResolution, scopeId: string): ResolutionItem {
  const found = resolution.items.find(
    (item) => item.guide.scopeRef.scopeId === scopeId,
  );

  if (found === undefined) {
    throw new Error(`no item for ${scopeId}`);
  }
  return found;
}

/** Every chunk the whole response carries, across all items. */
function allChunks(resolution: ContextResolution): readonly EvidenceChunk[] {
  return resolution.items.flatMap((item) =>
    item.fulfillment === "fulfilled" ? [...item.context.chunks] : [],
  );
}

function totalCharacters(resolution: ContextResolution): number {
  return allChunks(resolution).reduce(
    (total, chunk) => total + chunk.text.length,
    0,
  );
}

/**
 * A retriever that answers every Scope with `perScope` chunks of an exact size,
 * each carrying identity derived from the index it came from — so no chunk of
 * one Scope is ever mistaken for a repeat of another's.
 */
function createSizedRetriever(
  perScope: number,
  characters: number,
): RetrieverSpy {
  return createSpyRetriever((query) => {
    const name = query.documentIndex.documentIndexId;

    return Array.from({ length: perScope }, (_, index) =>
      createChunk(`${name}_${index}`, {
        text: "x".repeat(characters),
        score: 0.9 - index * 0.1,
      }),
    );
  });
}

describe("resolveContext", () => {
  it("resolves document evidence and consumer guides for the demo query", async () => {
    const resolution = await resolveContext(createDemoPorts(), DEMO_QUERY);

    expect(resolution.query).toBe(DEMO_QUERY);
    expect(resolution.policy).toEqual({
      payloadSchemaVersion: 2,
      scoring: "selection-scoring-v1",
      ranking: "selection-ranking-v1",
      evidence: "evidence-assembly-v1",
      budget: DEFAULT_EVIDENCE_BUDGET,
    });
    // The default is a shared module constant, so reporting it by reference
    // would let a consumer that mutates its own response change the ceiling
    // every later resolution runs under.
    expect(resolution.policy.budget).not.toBe(DEFAULT_EVIDENCE_BUDGET);

    // Only the refund Card owns a managed document Scope, so every chunk has to
    // carry its coordinates.
    const document = itemFor(resolution, "scope_refund_policy_doc");
    expect(document.fulfillment).toBe("fulfilled");
    if (document.fulfillment !== "fulfilled") {
      throw new Error("expected a fulfilled document item");
    }
    expect(document.context.chunks.length).toBeGreaterThan(0);
    for (const chunk of document.context.chunks) {
      expect(chunk.cardId).toBe("card_refund_policy");
      expect(chunk.scopeRef).toEqual({
        scopeId: "scope_refund_policy_doc",
        scopeVersion: "scopev_0001",
      });
    }

    // The other two Cards name sources we do not own, so each is answered with
    // a coordinate the consumer can act on rather than with rows or a body.
    const payments = itemFor(resolution, "scope_payments_table");
    expect(payments.fulfillment).toBe("delegated");
    expect(payments.guide).toMatchObject({
      kind: "sql",
      table: "payments",
      columns: ["created_at", "failed_reason", "payment_id", "status"],
      allowedOperations: ["select"],
    });

    const api = itemFor(resolution, "scope_payment_get");
    expect(api.fulfillment).toBe("delegated");
    expect(api.guide).toMatchObject({
      kind: "http",
      method: "GET",
      path: "/payments/{paymentId}",
    });

    expect(coordinates(resolution)).toEqual([
      "cardv_payment_api_v1/scope_payment_get",
      "cardv_payments_table_v1/scope_payments_table",
      "cardv_refund_policy_v1/scope_refund_policy_doc",
    ]);
    for (const outcome of resolution.selection.outcomes) {
      expect(outcome.verdict).toBe("admit");
    }
  });

  it("rejects an empty query before the catalog is read", async () => {
    for (const queryText of ["", "   "]) {
      const catalog = createSpyCatalog(createDemoCardSet());
      const retriever = createSpyRetriever();

      await expect(
        resolveContext(
          { catalog: catalog.catalog, retriever: retriever.retriever },
          queryText,
        ),
      ).rejects.toBeInstanceOf(EmptyQueryError);

      expect(catalog.calls).toHaveLength(0);
      expect(retriever.calls).toHaveLength(0);
    }
  });

  it("resolves an empty result for an empty catalog without failing", async () => {
    const retriever = createSpyRetriever();

    const resolution = await resolveContext(
      { catalog: new InMemoryCardCatalog([]), retriever: retriever.retriever },
      DEMO_QUERY,
    );

    expect(resolution.items).toEqual([]);
    expect(resolution.candidates).toEqual([]);
    expect(resolution.selection.outcomes).toEqual([]);
    expect(resolution.selection.provenance.consideredCount).toBe(0);
    expect(retriever.calls).toHaveLength(0);
  });

  it("never reaches the retriever when every Card is rejected", async () => {
    const retriever = createSpyRetriever(() => [createChunk("unreachable")]);

    const resolution = await resolveContext(
      portsFor(createDemoCardSet(), retriever.retriever),
      "오늘 서울 날씨 어때",
    );

    expect(retriever.calls).toHaveLength(0);
    expect(resolution.items).toEqual([]);
    expect(
      resolution.selection.outcomes.map((outcome) => outcome.verdict),
    ).toEqual(["reject", "reject", "reject"]);
  });

  it("tolerates an admitted Card that declares no Scope at all", async () => {
    const retriever = createSpyRetriever();

    const resolution = await resolveContext(
      portsFor([createManagedCard("bare", [])], retriever.retriever),
      ADMITTING_QUERY,
    );

    expect(resolution.selection.outcomes[0]?.verdict).toBe("admit");
    expect(retriever.calls).toHaveLength(0);
    expect(resolution.items).toEqual([]);
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

    await resolveContext(
      portsFor([card], retriever.retriever),
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

  it("requests eight chunks per Scope unless the caller says otherwise", async () => {
    const card = createManagedCard("limited", [createManagedScope("limited")]);

    const defaulted = createSpyRetriever();
    await resolveContext(
      portsFor([card], defaulted.retriever),
      ADMITTING_QUERY,
    );
    expect(defaulted.calls[0]?.limit).toBe(8);

    const overridden = createSpyRetriever();
    await resolveContext(
      portsFor([card], overridden.retriever),
      ADMITTING_QUERY,
      { chunkLimitPerScope: 3 },
    );
    expect(overridden.calls[0]?.limit).toBe(3);
  });

  it("records a deferred Card without retrieving anything for it", async () => {
    const retriever = createSpyRetriever();

    const resolution = await resolveContext(
      portsFor(createDemoCardSet(), retriever.retriever),
      DEMO_QUERY,
      { thresholds: { admit: 0.99, reject: 0.01 } },
    );

    expect(retriever.calls).toHaveLength(0);
    expect(resolution.candidates).toHaveLength(3);
    expect(
      resolution.selection.outcomes.find(
        (outcome) => outcome.cardId === "card_refund_policy",
      )?.verdict,
    ).toBe("defer");
    expect(resolution.items).toEqual([]);
  });

  it("carries the caller's thresholds and budget into the result", async () => {
    const thresholds = { admit: 0.5, reject: 0.1 };
    const budget: EvidenceBudget = { maxTotalCharacters: 60, maxChunks: 1 };

    const resolution = await resolveContext(createDemoPorts(), DEMO_QUERY, {
      thresholds,
      budget,
    });

    expect(resolution.selection.provenance.thresholds).toEqual(thresholds);
    expect(resolution.policy.budget).toEqual(budget);
    // Reported, not aliased: the response must not hand a consumer a live
    // window onto the object the caller passed in.
    expect(resolution.policy.budget).not.toBe(budget);
    expect(allChunks(resolution)).toHaveLength(1);
    expect(itemFor(resolution, "scope_refund_policy_doc")).toMatchObject({
      fulfillment: "fulfilled",
      context: { truncated: true },
    });
  });
});

describe("resolveContext splits one assembly across items", () => {
  it("gives every item only the chunks of its own Scope", async () => {
    // The regression this whole type exists to prevent: two document Scopes
    // used to be merged into one evidence record, and a consumer could not tell
    // which Scope a chunk came from without re-joining by coordinates.
    const card = createManagedCard("split", [
      createManagedScope("alpha"),
      createManagedScope("beta"),
    ]);
    const retriever = createSizedRetriever(2, 10);

    const resolution = await resolveContext(
      portsFor([card], retriever.retriever),
      ADMITTING_QUERY,
      { budget: { maxTotalCharacters: 1000, maxChunks: 10 } },
    );

    expect(resolution.items).toHaveLength(2);
    for (const item of resolution.items) {
      if (item.fulfillment !== "fulfilled") {
        throw new Error("expected every item to be fulfilled");
      }
      expect(item.context.chunks.length).toBeGreaterThan(0);
      for (const chunk of item.context.chunks) {
        expect(chunk.scopeRef.scopeId).toBe(item.guide.scopeRef.scopeId);
        expect(chunk.versionId).toBe(item.versionId);
      }
    }
    // And nothing was lost in the split.
    expect(allChunks(resolution)).toHaveLength(4);
  });

  it("does not grow the response in proportion to the number of Scopes", async () => {
    const budget: EvidenceBudget = { maxTotalCharacters: 100, maxChunks: 4 };
    // Four 30-character chunks per Scope: one Scope alone already overruns the
    // character ceiling, so the comparison below is never vacuous.
    const one = await resolveContext(
      portsFor(
        [createManagedCard("one", [createManagedScope("alpha")])],
        createSizedRetriever(4, 30).retriever,
      ),
      ADMITTING_QUERY,
      { budget },
    );
    const two = await resolveContext(
      portsFor(
        [
          createManagedCard("two", [
            createManagedScope("alpha"),
            createManagedScope("beta"),
          ]),
        ],
        createSizedRetriever(4, 30).retriever,
      ),
      ADMITTING_QUERY,
      { budget },
    );

    // The budget really bound in both runs.
    expect(
      one.items.some(
        (item) => item.fulfillment === "fulfilled" && item.context.truncated,
      ),
    ).toBe(true);

    expect(allChunks(two).length).not.toBe(allChunks(one).length * 2);
    expect(totalCharacters(two)).not.toBe(totalCharacters(one) * 2);
    expect(allChunks(two).length).toBeLessThanOrEqual(budget.maxChunks);
    expect(totalCharacters(two)).toBeLessThanOrEqual(budget.maxTotalCharacters);
  });

  it("keeps a Scope fulfilled when the budget left it nothing", async () => {
    // Losing every chunk to a higher-ranked Scope is not a failure: the index
    // answered, and reporting it as `failed` would tell a consumer the source
    // is broken when it is merely outranked.
    const card = createManagedCard("starved", [
      createManagedScope("rich"),
      createManagedScope("poor"),
    ]);
    const retriever = createSpyRetriever((query) =>
      query.documentIndex.documentIndexId === "docidx_rich"
        ? [createChunk("rich", { score: 0.9 })]
        : [createChunk("poor", { score: 0.1 })],
    );

    const resolution = await resolveContext(
      portsFor([card], retriever.retriever),
      ADMITTING_QUERY,
      { budget: { maxTotalCharacters: 1000, maxChunks: 1 } },
    );

    const poor = itemFor(resolution, "scope_poor");
    expect(poor.fulfillment).toBe("fulfilled");
    if (poor.fulfillment !== "fulfilled") {
      throw new Error("expected a fulfilled item");
    }
    expect(poor.context.chunks).toEqual([]);
    expect(poor.context.truncated).toBe(true);
    expect(poor.context.omitted).toEqual([
      {
        chunkId: "chunk_poor",
        chunkRevisionId: "chunkrev_poor",
        reason: "budget_exhausted",
      },
    ]);

    const rich = itemFor(resolution, "scope_rich");
    if (rich.fulfillment !== "fulfilled") {
      throw new Error("expected a fulfilled item");
    }
    // The Scope that kept everything it retrieved is not marked clipped because
    // a different Scope ran out of budget.
    expect(rich.context.chunks).toHaveLength(1);
    expect(rich.context.truncated).toBe(false);
  });

  it("keeps a Scope fulfilled when the index simply had nothing to say", async () => {
    const card = createManagedCard("quiet", [createManagedScope("quiet")]);

    const resolution = await resolveContext(
      portsFor([card], createSpyRetriever(() => []).retriever),
      ADMITTING_QUERY,
    );

    expect(resolution.items).toEqual([
      {
        fulfillment: "fulfilled",
        cardId: "card_quiet",
        versionId: "cardv_quiet",
        guide: itemFor(resolution, "scope_quiet").guide,
        context: { chunks: [], omitted: [], truncated: false },
      },
    ]);
  });

  it("deduplicates across Scopes and records the loss on the losing Scope", async () => {
    // Assembling each Scope under its own budget would either miss this repeat
    // or catch it in whichever Scope happened to be processed second.
    const card = createManagedCard("echo", [
      createManagedScope("loud"),
      createManagedScope("faint"),
    ]);
    const retriever = createSpyRetriever((query) =>
      query.documentIndex.documentIndexId === "docidx_loud"
        ? [createChunk("loud", { score: 0.9, contentDigest: "digest_same" })]
        : [createChunk("faint", { score: 0.2, contentDigest: "digest_same" })],
    );

    const resolution = await resolveContext(
      portsFor([card], retriever.retriever),
      ADMITTING_QUERY,
    );

    const loud = itemFor(resolution, "scope_loud");
    const faint = itemFor(resolution, "scope_faint");
    if (loud.fulfillment !== "fulfilled" || faint.fulfillment !== "fulfilled") {
      throw new Error("expected both items to be fulfilled");
    }
    expect(loud.context.chunks).toHaveLength(1);
    expect(loud.context.omitted).toEqual([]);
    expect(faint.context.chunks).toEqual([]);
    expect(faint.context.omitted).toEqual([
      {
        chunkId: "chunk_faint",
        chunkRevisionId: "chunkrev_faint",
        reason: "duplicate_content",
      },
    ]);
    // A repeat is not a budget problem, so the losing Scope is not "clipped".
    expect(faint.context.truncated).toBe(false);
  });

  it("keeps one copy when two Scopes return the same chunk revision", async () => {
    const card = createManagedCard("twin", [
      createManagedScope("left"),
      createManagedScope("right"),
    ]);
    const retriever = createSpyRetriever(() => [createChunk("shared")]);

    const resolution = await resolveContext(
      portsFor([card], retriever.retriever),
      ADMITTING_QUERY,
    );

    expect(retriever.calls).toHaveLength(2);
    expect(allChunks(resolution)).toHaveLength(1);
    expect(
      resolution.items.flatMap((item) =>
        item.fulfillment === "fulfilled" ? [...item.context.omitted] : [],
      ),
    ).toEqual([
      {
        chunkId: "chunk_shared",
        chunkRevisionId: "chunkrev_shared",
        reason: "duplicate_chunk_revision",
      },
    ]);
  });
});

describe("resolveContext reports a failed Scope without losing the others", () => {
  const codes: readonly DocumentRetrievalFaultCode[] = [
    "index_unavailable",
    "index_version_mismatch",
    "access_denied",
  ];

  for (const code of codes) {
    it(`reports ${code} on the Scope that raised it`, async () => {
      const card = createManagedCard("multi", [
        createManagedScope("bad"),
        createManagedScope("good"),
      ]);
      const retriever = createSpyRetriever((query) => {
        if (query.documentIndex.documentIndexId === "docidx_bad") {
          throw new DocumentRetrievalFault(code);
        }
        return [createChunk("good")];
      });

      const resolution = await resolveContext(
        portsFor([card], retriever.retriever),
        ADMITTING_QUERY,
      );

      expect(itemFor(resolution, "scope_bad")).toMatchObject({
        fulfillment: "failed",
        cardId: "card_multi",
        versionId: "cardv_multi",
        code,
      });
      // The other Scope is untouched by its neighbour's failure.
      expect(itemFor(resolution, "scope_good")).toMatchObject({
        fulfillment: "fulfilled",
      });
      expect(allChunks(resolution)).toHaveLength(1);
      expect(JSON.stringify(resolution)).not.toContain(
        "Document retrieval failed",
      );
    });
  }

  it("reduces an unexpected retriever exception to retriever_error", async () => {
    const card = createManagedCard("broken", [createManagedScope("broken")]);
    const retriever = createSpyRetriever(() => {
      throw new Error("socket hang up at internal-vector-host:6333");
    });

    const resolution = await resolveContext(
      portsFor([card], retriever.retriever),
      ADMITTING_QUERY,
    );

    expect(resolution.items).toHaveLength(1);
    expect(resolution.items[0]).toMatchObject({
      fulfillment: "failed",
      cardId: "card_broken",
      versionId: "cardv_broken",
      code: "retriever_error",
    });
    expect(allChunks(resolution)).toEqual([]);
    expect(JSON.stringify(resolution)).not.toContain("internal-vector-host");
  });

  it("never attaches a failure state to a delegated Scope", async () => {
    // We have not run the consumer's database or endpoint, so we are in no
    // position to say whether it would have succeeded.
    //
    // Resolved under the shipped thresholds. This used to pass a band of its own
    // to drag both delegated kinds into one response; the demo Cards now reach
    // both on the demo query, so the claim is made about the default path.
    const resolution = await resolveContext(createDemoPorts(), DEMO_QUERY);

    const delegated = resolution.items.filter(
      (item) => item.guide.kind === "sql" || item.guide.kind === "http",
    );

    // Item order is ascending versionId, and `cardv_payment_api_v1` sorts
    // before `cardv_payments_table_v1`, so the HTTP guide comes first.
    expect(delegated.map((item) => item.guide.kind)).toEqual(["http", "sql"]);
    for (const item of delegated) {
      expect(item.fulfillment).toBe("delegated");
      expect(Object.hasOwn(item, "code")).toBe(false);
      expect(Object.hasOwn(item, "context")).toBe(false);
      // Nor anywhere else in the response: there is no side channel of failures
      // a delegated Scope could still be named in.
      expect(JSON.stringify(resolution)).not.toContain(
        `"${item.guide.scopeRef.scopeId}","reason"`,
      );
    }
    expect(JSON.stringify(resolution)).not.toContain("retriever_error");
  });
});

describe("resolveContext orders items deterministically", () => {
  const expected = [
    "cardv_a/scope_m",
    "cardv_b/scope_a",
    "cardv_b/scope_z",
  ];

  function orderingCards(): readonly ApprovedCard[] {
    return [
      createManagedCard("b", [
        createManagedScope("z"),
        createManagedScope("a"),
      ]),
      createManagedCard("a", [createManagedScope("m")]),
    ];
  }

  it("orders by ascending versionId, then by ascending scopeId", async () => {
    const resolution = await resolveContext(
      portsFor(orderingCards(), createSpyRetriever().retriever),
      ADMITTING_QUERY,
    );

    expect(coordinates(resolution)).toEqual(expected);
  });

  it("orders identically whatever order the Cards arrive in", async () => {
    const reversed = [...orderingCards()].reverse();

    const resolution = await resolveContext(
      portsFor(reversed, createSpyRetriever().retriever),
      ADMITTING_QUERY,
    );

    expect(coordinates(resolution)).toEqual(expected);
  });

  it("returns the same resolution for the same input twice", async () => {
    const cards = orderingCards();
    const first = await resolveContext(
      portsFor(cards, createSizedRetriever(2, 10).retriever),
      ADMITTING_QUERY,
    );
    const second = await resolveContext(
      portsFor(cards, createSizedRetriever(2, 10).retriever),
      ADMITTING_QUERY,
    );

    expect(first).toEqual(second);
  });

  it("does not mutate the Cards the catalog handed it", async () => {
    const cards = orderingCards();
    const before = structuredClone(cards);

    await resolveContext(
      portsFor(cards, createSizedRetriever(2, 10).retriever),
      ADMITTING_QUERY,
    );

    expect(cards).toEqual(before);
  });
});
