import {
  ManagedDocumentSearchError,
  type BatchManagedDocumentSearchCommand,
  type BatchManagedDocumentSearchItem,
  type DocumentSearchHit,
} from "@contextctl/ingestion-indexing";
import {
  DEFAULT_CONTEXT_BUDGET,
  InvalidContextBudgetError,
  type ApprovedCard,
  type ApprovedCardCatalog,
  type ContextResolution,
  type ContextResolutionItem,
} from "@contextctl/selection-delivery";
import { describe, expect, it } from "vitest";

import {
  DaemonContextApplication,
  type ManagedDocumentSearchPort,
} from "../src/context-application.js";

const QUERY = "환불 불가 상품";
const SECURITY_DOMAIN = "payments";

/** One approved Card over one managed document Scope. */
function documentCard(overrides: Partial<ApprovedCard> = {}): ApprovedCard {
  return {
    cardId: "card_refund_policy",
    versionId: "cardv_refund_policy_v1",
    meaning: {
      description: "환불 정책 문서",
      representativeQuestions: ["환불 불가 상품은 무엇인가요?"],
      aliases: [],
      keywords: ["환불", "환불 불가"],
    },
    policy: { sensitive: false, allowedUsage: ["retrieval"] },
    scopes: [
      {
        kind: "managed_document",
        reference: {
          scopeId: "scope_refund_policy_doc",
          scopeVersion: "scopev_0001",
        },
        documentIndex: {
          documentIndexId: "docidx_refund_policy",
          sourceId: "src_policy_docs",
          documentId: "doc_refund_policy",
          indexVersion: "idxv_0001",
        },
        selection: { kind: "document" },
      },
    ],
    ...overrides,
  };
}

/** One approved Card over a Scope nothing of ours executes. */
function sqlCard(): ApprovedCard {
  return {
    ...documentCard(),
    cardId: "card_payments_table",
    versionId: "cardv_payments_table_v1",
    scopes: [
      {
        kind: "sql_source",
        reference: {
          scopeId: "scope_payments_table",
          scopeVersion: "scopev_0001",
        },
        connector: "postgres.main",
        schema: "public",
        table: "payments",
        columns: ["payment_id"],
      },
    ],
  };
}

function catalogOf(cards: readonly ApprovedCard[]): ApprovedCardCatalog {
  return { listApprovedCards: () => Promise.resolve(cards) };
}

/** Records every command it was given and answers with what it was told to. */
class RecordingSearch implements ManagedDocumentSearchPort {
  readonly commands: BatchManagedDocumentSearchCommand[] = [];

  constructor(
    private readonly answer: (
      command: BatchManagedDocumentSearchCommand,
    ) => readonly BatchManagedDocumentSearchItem[],
  ) {}

  searchBatch(
    command: BatchManagedDocumentSearchCommand,
  ): Promise<readonly BatchManagedDocumentSearchItem[]> {
    this.commands.push(command);
    return Promise.resolve(this.answer(command));
  }
}

/** A search that throws before it answers for any target at all. */
class ThrowingSearch implements ManagedDocumentSearchPort {
  constructor(private readonly cause: unknown) {}

  searchBatch(): Promise<readonly BatchManagedDocumentSearchItem[]> {
    return Promise.reject(this.cause);
  }
}

function hit(rank: number, chunkRevisionId: string): DocumentSearchHit {
  return {
    rank,
    chunkId: `chunk_${chunkRevisionId}`,
    chunkRevisionId,
    semanticUnitId: `unit_${chunkRevisionId}`,
    documentId: "doc_refund_policy",
    text: "환불 불가 상품: 개봉한 식품.",
    contentDigest: `digest_${chunkRevisionId}`,
  };
}

function applicationOver(
  cards: readonly ApprovedCard[],
  search: ManagedDocumentSearchPort,
): DaemonContextApplication {
  return new DaemonContextApplication({
    catalog: catalogOf(cards),
    search,
    securityDomain: SECURITY_DOMAIN,
  });
}

function fulfilledItem(resolution: ContextResolution): ContextResolutionItem {
  const item = resolution.items[0];

  if (item === undefined) {
    throw new Error("expected one item");
  }
  return item;
}

describe("DaemonContextApplication", () => {
  it("names the selected Cards in the resolution rather than listing the catalog", async () => {
    const application = applicationOver(
      [documentCard()],
      new RecordingSearch((command) =>
        command.targets.map((target) => ({
          targetKey: target.targetKey,
          status: "fulfilled" as const,
          hits: [],
        })),
      ),
    );

    // `listApprovedCards` is gone from the interface, so a query surface cannot
    // enumerate the catalog at all. The Cards that answered a question still
    // travel — attributed to the query that selected them.
    const resolution = await application.resolveContext({ query: QUERY });

    expect(resolution.selection.selected.map((card) => card.cardId)).toEqual([
      "card_refund_policy",
    ]);
  });

  it("translates each planned target into a search target field for field", async () => {
    const search = new RecordingSearch((command) =>
      command.targets.map((target) => ({
        targetKey: target.targetKey,
        status: "fulfilled" as const,
        hits: [],
      })),
    );

    await applicationOver([documentCard()], search).resolveContext({
      query: QUERY,
    });

    expect(search.commands).toHaveLength(1);
    expect(search.commands[0]?.targets).toEqual([
      {
        targetKey: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u) as unknown,
        scopeRef: {
          scopeId: "scope_refund_policy_doc",
          scopeVersion: "scopev_0001",
        },
        limit: 8,
      },
    ]);
  });

  it("adds the security domain from its own configuration, not from the Card", async () => {
    const search = new RecordingSearch((command) =>
      command.targets.map((target) => ({
        targetKey: target.targetKey,
        status: "fulfilled" as const,
        hits: [],
      })),
    );

    await applicationOver([documentCard()], search).resolveContext({
      query: QUERY,
    });

    // At the top of the command, once, rather than on each target: it is a
    // property of who is asking, not of what is being asked for.
    expect(search.commands[0]?.securityDomain).toBe(SECURITY_DOMAIN);
    expect(search.commands[0]?.queryText).toBe(QUERY);
  });

  it("puts no physical binding into the command it sends", async () => {
    const search = new RecordingSearch((command) =>
      command.targets.map((target) => ({
        targetKey: target.targetKey,
        status: "fulfilled" as const,
        hits: [],
      })),
    );

    await applicationOver([documentCard()], search).resolveContext({
      query: QUERY,
    });

    // Translation is not the place to recover missing information: the search
    // resolves the binding itself under its own authority, and a command
    // carrying one would mean this side chose which store was read.
    //
    // The key names still matter even though `ApprovedDocumentIndexRef` no
    // longer carries the physical pair — the type change closes one route to
    // the wire, and this closes the rest, including anything the daemon could
    // synthesize on its own. The two literal values are kept alongside them so
    // that a fixture reintroducing the pair is caught here and not only by the
    // type checker.
    const wire = JSON.stringify(search.commands[0]?.targets);
    for (const forbidden of [
      "connectorId",
      "accessHandle",
      "documentIndexId",
      "vector.local",
      "documents/policies/indexes/refund",
    ]) {
      expect(wire).not.toContain(forbidden);
    }
  });

  it("does not search at all when the plan names no managed target", async () => {
    const search = new RecordingSearch(() => {
      throw new Error("the search must not be called");
    });

    const resolution = await applicationOver([sqlCard()], search).resolveContext({
      query: QUERY,
    });

    // An empty batch is `invalid_request` to the search, so sending one would
    // turn "this query selected no documents" into a failure report.
    expect(search.commands).toEqual([]);
    expect(resolution.items.map((item) => item.fulfillment.status)).toEqual([
      "delegated",
    ]);
  });

  it("does not search when nothing was admitted at all", async () => {
    const search = new RecordingSearch(() => {
      throw new Error("the search must not be called");
    });

    const resolution = await applicationOver(
      [documentCard()],
      search,
    ).resolveContext({ query: "사내 연차 규정과 휴가 신청 절차" });

    expect(search.commands).toEqual([]);
    expect(resolution.items).toEqual([]);
  });

  it("carries a hit's rank across unchanged rather than scoring it", async () => {
    const search = new RecordingSearch((command) =>
      command.targets.map((target) => ({
        targetKey: target.targetKey,
        status: "fulfilled" as const,
        hits: [hit(1, "rev_a"), hit(2, "rev_b")],
      })),
    );

    const resolution = await applicationOver([documentCard()], search).resolveContext({
      query: QUERY,
    });
    const item = fulfilledItem(resolution);

    if (item.fulfillment.status !== "fulfilled") {
      throw new Error("expected a fulfilled item");
    }
    // The retriever port this replaced turned a rank into `1 / rank` because
    // Selection needed a [0, 1] score. Fusion consumes positions directly now,
    // so the manufactured similarity is gone — and neither the per-target rank
    // nor the fused score reaches the response. What a consumer receives is the
    // position the two of them produced, once, across the whole answer.
    expect(
      item.fulfillment.context.chunks.map((chunk) => chunk.contextRank),
    ).toEqual([1, 2]);
    expect(item.fulfillment.context.chunks[0]).not.toHaveProperty("rank");
    expect(item.fulfillment.context.chunks[0]).not.toHaveProperty("score");
  });

  it("projects a failed target under the search's own code and flag", async () => {
    const search = new RecordingSearch((command) =>
      command.targets.map((target) => ({
        targetKey: target.targetKey,
        status: "failed" as const,
        failure: { code: "query_embedding_failed" as const, retriable: true },
      })),
    );

    const resolution = await applicationOver([documentCard()], search).resolveContext({
      query: QUERY,
    });
    const item = fulfilledItem(resolution);

    if (item.fulfillment.status !== "failed") {
      throw new Error("expected a failed item");
    }
    // Not folded into a smaller vocabulary and not re-diagnosed: the name and
    // the retriable flag are the search's to state.
    expect(item.fulfillment.failure).toEqual({
      stage: "managed_search",
      code: "query_embedding_failed",
      retriable: true,
    });
  });

  it.each([
    ["security_domain_mismatch", false],
    ["index_binding_unavailable", true],
    ["index_catalog_corrupt", false],
    ["scope_not_published", false],
    ["vector_search_unavailable", true],
  ] as const)(
    "passes %s through with retriable %s",
    async (code, retriable) => {
      const search = new RecordingSearch((command) =>
        command.targets.map((target) => ({
          targetKey: target.targetKey,
          status: "failed" as const,
          failure: { code, retriable },
        })),
      );

      const resolution = await applicationOver([documentCard()], search).resolveContext(
        { query: QUERY },
      );
      const item = fulfilledItem(resolution);

      if (item.fulfillment.status !== "failed") {
        throw new Error("expected a failed item");
      }
      expect(item.fulfillment.failure.code).toBe(code);
      expect(item.fulfillment.failure.retriable).toBe(retriable);
    },
  );

  it("fails every target when the whole batch is rejected", async () => {
    const application = applicationOver(
      [documentCard()],
      new ThrowingSearch(
        new ManagedDocumentSearchError("query_input_limit_exceeded", false),
      ),
    );

    const item = fulfilledItem(await application.resolveContext({ query: QUERY }));

    if (item.fulfillment.status !== "failed") {
      throw new Error("expected a failed item");
    }
    expect(item.fulfillment.failure).toEqual({
      stage: "managed_search",
      code: "query_input_limit_exceeded",
      retriable: false,
    });
  });

  it("reports a non-search exception as unexpected_failure, diagnosing nothing", async () => {
    const application = applicationOver(
      [documentCard()],
      new ThrowingSearch(new Error("connection refused to secret-host:6333")),
    );

    const resolution = await application.resolveContext({ query: QUERY });
    const item = fulfilledItem(resolution);

    if (item.fulfillment.status !== "failed") {
      throw new Error("expected a failed item");
    }
    // Inferring `index_binding_unavailable` from an arbitrary exception would
    // be a claim about infrastructure nobody checked.
    expect(item.fulfillment.failure.code).toBe("unexpected_failure");
    expect(JSON.stringify(resolution)).not.toContain("secret-host");
  });

  it("keeps a delegated item alive when the document read fails", async () => {
    const application = applicationOver(
      [documentCard(), sqlCard()],
      new ThrowingSearch(new ManagedDocumentSearchError("invalid_request")),
    );

    const resolution = await application.resolveContext({
      query: `${QUERY} 결제 payments`,
    });

    // The SQL Scope was never affected by a document search that did not run.
    expect(
      resolution.items.map((item) => item.fulfillment.status).sort(),
    ).toEqual([
      "delegated",
      "failed",
    ]);
  });

  it("fails a target the search answered for with nothing at all", async () => {
    const search = new RecordingSearch(() => []);

    const item = fulfilledItem(
      await applicationOver([documentCard()], search).resolveContext({
        query: QUERY,
      }),
    );

    if (item.fulfillment.status !== "failed") {
      throw new Error("expected a failed item");
    }
    // Reporting a gap as "the index answered and had nothing to say" would tell
    // a consumer the document is empty when nobody looked.
    expect(item.fulfillment.failure.code).toBe("unexpected_failure");
  });

  it("narrows the context budget when a request asks it to", async () => {
    const search = new RecordingSearch((command) =>
      command.targets.map((target) => ({
        targetKey: target.targetKey,
        status: "fulfilled" as const,
        hits: [hit(1, "rev_a")],
      })),
    );

    const resolution = await applicationOver([documentCard()], search).resolveContext(
      { query: QUERY, maxContextCharacters: 1 },
    );
    const item = fulfilledItem(resolution);

    // Only the character ceiling moves. `maxChunks` is an assembly decision
    // about how many separate citations an answer carries, and a caller was
    // never given control of it.
    expect(resolution.policy.budget).toEqual({
      maxTotalCharacters: 1,
      maxChunks: DEFAULT_CONTEXT_BUDGET.maxChunks,
    });
    if (item.fulfillment.status !== "fulfilled") {
      throw new Error("expected a fulfilled item");
    }
    expect(item.fulfillment.context.truncated).toBe(true);
  });

  it("applies the budget it was assembled with when a request states none", async () => {
    const application = new DaemonContextApplication({
      catalog: catalogOf([documentCard()]),
      search: new RecordingSearch((command) =>
        command.targets.map((target) => ({
          targetKey: target.targetKey,
          status: "fulfilled" as const,
          hits: [],
        })),
      ),
      securityDomain: SECURITY_DOMAIN,
      budget: { maxTotalCharacters: 500, maxChunks: 3 },
    });

    const resolution = await application.resolveContext({ query: QUERY });

    expect(resolution.policy.budget).toEqual({
      maxTotalCharacters: 500,
      maxChunks: 3,
    });
  });

  it("takes the lower of the configured ceiling and the requested one", async () => {
    const application = new DaemonContextApplication({
      catalog: catalogOf([documentCard()]),
      search: new RecordingSearch((command) =>
        command.targets.map((target) => ({
          targetKey: target.targetKey,
          status: "fulfilled" as const,
          hits: [],
        })),
      ),
      securityDomain: SECURITY_DOMAIN,
      budget: { maxTotalCharacters: 500, maxChunks: 3 },
    });

    const resolution = await application.resolveContext({
      query: QUERY,
      maxContextCharacters: 200,
    });

    expect(resolution.policy.budget.maxTotalCharacters).toBe(200);
  });

  it("refuses a ceiling above the configured one instead of clamping it", async () => {
    const search = new RecordingSearch(() => {
      throw new Error("the catalog must not be read for a refused request");
    });
    const application = new DaemonContextApplication({
      catalog: catalogOf([documentCard()]),
      search,
      securityDomain: SECURITY_DOMAIN,
      budget: { maxTotalCharacters: 500, maxChunks: 3 },
    });

    // Refused rather than clamped: a caller that asked for 5000 and silently
    // received 500 has no way to know its request was not honoured, and the
    // difference matters precisely when it is budgeting a context window.
    await expect(
      application.resolveContext({ query: QUERY, maxContextCharacters: 5000 }),
    ).rejects.toThrow(InvalidContextBudgetError);
  });

  it.each([0, -1, 12.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "refuses %s as a ceiling before it plans a single read",
    async (requested) => {
      const search = new RecordingSearch(() => {
        throw new Error("no read may be planned for a refused request");
      });

      await expect(
        applicationOver([documentCard()], search).resolveContext({
          query: QUERY,
          maxContextCharacters: requested,
        }),
      ).rejects.toThrow(InvalidContextBudgetError);
      expect(search.commands).toEqual([]);
    },
  );

  it("sends one batch for two Cards that authorise the same Scope", async () => {
    const search = new RecordingSearch((command) =>
      command.targets.map((target) => ({
        targetKey: target.targetKey,
        status: "fulfilled" as const,
        hits: [hit(1, "rev_a")],
      })),
    );

    const resolution = await applicationOver(
      [
        documentCard(),
        documentCard({ cardId: "card_twin", versionId: "cardv_twin" }),
      ],
      search,
    ).resolveContext({ query: QUERY });

    // One read, one item, both Cards named on it. Two targets here would mean a
    // consumer paid twice for the same evidence.
    expect(search.commands[0]?.targets).toHaveLength(1);
    expect(resolution.items).toHaveLength(1);
    expect(
      resolution.items[0]?.selectedBy.map((card) => card.cardId),
    ).toEqual(["card_refund_policy", "card_twin"]);
  });

  it("sends target keys that are unique within one batch", async () => {
    const search = new RecordingSearch((command) =>
      command.targets.map((target) => ({
        targetKey: target.targetKey,
        status: "fulfilled" as const,
        hits: [],
      })),
    );

    await applicationOver(
      [
        documentCard(),
        documentCard({ cardId: "card_twin", versionId: "cardv_twin" }),
      ],
      search,
    ).resolveContext({ query: QUERY });

    // The batch command refuses a repeated `targetKey` as `invalid_request`, so
    // the plan's own deduplication is what keeps the command valid.
    const keys = (search.commands[0]?.targets ?? []).map(
      (target) => target.targetKey,
    );
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("refuses an empty query before the catalog is read", async () => {
    let read = false;
    const application = new DaemonContextApplication({
      catalog: {
        listApprovedCards: () => {
          read = true;
          return Promise.resolve([]);
        },
      },
      search: new RecordingSearch(() => []),
      securityDomain: SECURITY_DOMAIN,
    });

    await expect(application.resolveContext({ query: "  " })).rejects.toThrow(
      /Query text/u,
    );
    expect(read).toBe(false);
  });
});
