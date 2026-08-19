import { describe, expect, it } from "vitest";

import { assembleContext } from "../../src/application/assemble-context.js";
import {
  selectContext,
  type SelectContextPorts,
} from "../../src/application/select-context.js";
import type { ApprovedCard } from "../../src/domain/card-catalog.js";
import type { ContextResolutionItem } from "../../src/domain/context-resolution.js";
import { ManagedResolutionInvariantError } from "../../src/domain/errors.js";
import {
  CONTEXT_ASSEMBLY_POLICY_VERSION,
  CONTEXT_FUSION_POLICY_VERSION,
} from "../../src/domain/context-assembly.js";
import type {
  ManagedResolutionOutcome,
  ResolvedDocumentChunk,
} from "../../src/domain/managed-resolution.js";
import { QUERY_SCORING_POLICY_VERSION } from "../../src/domain/query-scoring.js";
import { SELECTION_RANKING_POLICY_VERSION } from "../../src/domain/selection-verdict.js";
import {
  isManagedPlannedItem,
  SELECTION_PLANNING_POLICY_VERSION,
  type SelectionPlan,
} from "../../src/domain/selection-plan.js";
import { InMemoryCardCatalog } from "../../src/infrastructure/in-memory-card-catalog.js";
import {
  createDemoCardSet,
  createRefundPolicyCard,
  DEMO_QUERY,
} from "../fixtures/approved-card.fixture.js";
import { createRefundPolicyChunks } from "../fixtures/document-chunk.fixture.js";

function portsFor(cards: readonly ApprovedCard[]): SelectContextPorts {
  return { catalog: new InMemoryCardCatalog(cards) };
}

function planFor(cards: readonly ApprovedCard[]): Promise<SelectionPlan> {
  return selectContext(portsFor(cards), DEMO_QUERY);
}

/** The one target a single-document plan names. */
function soleTargetKey(plan: SelectionPlan): string {
  const key = plan.managedTargets[0]?.targetKey;

  if (key === undefined) {
    throw new Error("expected the plan to name one managed target");
  }
  return key;
}

function chunksWithRanks(): ResolvedDocumentChunk[] {
  return createRefundPolicyChunks().map((chunk, index) => ({
    ...chunk,
    rank: index + 1,
  }));
}

function itemFor(
  items: readonly ContextResolutionItem[],
  scopeId: string,
): ContextResolutionItem {
  const found = items.find((item) => item.guide.scopeRef.scopeId === scopeId);

  if (found === undefined) {
    throw new Error(`no item for ${scopeId}`);
  }
  return found;
}

describe("assembleContext", () => {
  it("reports a fulfilled read with the chunks it returned", async () => {
    const plan = await planFor([createRefundPolicyCard()]);
    const resolution = assembleContext(plan, [
      {
        targetKey: soleTargetKey(plan),
        status: "fulfilled",
        chunks: chunksWithRanks(),
      },
    ]);
    const [item] = resolution.items;

    expect(item?.fulfillment.status).toBe("fulfilled");
    if (item?.fulfillment.status !== "fulfilled") {
      throw new Error("expected a fulfilled item");
    }
    expect(item.fulfillment.context.chunks).toHaveLength(3);
    // The fused score placed this chunk first and then stayed behind: a
    // consumer receives the position, not the number that produced it.
    expect(item.fulfillment.context.chunks[0]?.contextRank).toBe(1);
    expect(item.fulfillment.context.chunks[0]).not.toHaveProperty("score");
    expect(item.fulfillment.context.chunks[0]).not.toHaveProperty("rank");
    expect(item.fulfillment.context.truncated).toBe(false);
    expect(item.fulfillment.context.contentTrust).toBe("untrusted");
  });

  it("reports a read that answered with nothing as fulfilled, not failed", async () => {
    const plan = await planFor([createRefundPolicyCard()]);
    const resolution = assembleContext(plan, [
      { targetKey: soleTargetKey(plan), status: "fulfilled", chunks: [] },
    ]);
    const [item] = resolution.items;

    // The index answered; it had nothing to say. Reporting that as a failure
    // would tell a consumer the source is broken when it is merely quiet.
    expect(item?.fulfillment.status).toBe("fulfilled");
  });

  it("reports a failed read with the executor's own code and flag", async () => {
    const plan = await planFor([createRefundPolicyCard()]);
    const resolution = assembleContext(plan, [
      {
        targetKey: soleTargetKey(plan),
        status: "failed",
        failure: {
          stage: "managed_search",
          code: "vector_search_unavailable",
          retriable: true,
        },
      },
    ]);
    const [item] = resolution.items;

    if (item?.fulfillment.status !== "failed") {
      throw new Error("expected a failed item");
    }
    expect(item.fulfillment.failure).toEqual({
      stage: "managed_search",
      code: "vector_search_unavailable",
      retriable: true,
    });
  });

  it("reports a target the executor never answered for as an empty fulfilment", async () => {
    const plan = await planFor([createRefundPolicyCard()]);
    const resolution = assembleContext(plan, []);
    const [item] = resolution.items;

    // Our own bookkeeping slipping, not an upstream failure. The item stays
    // visible rather than the whole answer being dropped over it.
    expect(item?.fulfillment.status).toBe("fulfilled");
    if (item?.fulfillment.status !== "fulfilled") {
      throw new Error("expected a fulfilled item");
    }
    expect(item.fulfillment.context.chunks).toEqual([]);
  });

  it("refuses an outcome whose failure code is not an opaque token", async () => {
    const plan = await planFor([createRefundPolicyCard()]);

    expect(() =>
      assembleContext(plan, [
        {
          targetKey: soleTargetKey(plan),
          status: "failed",
          failure: {
            stage: "managed_search",
            code: "Index Unavailable!",
            retriable: false,
          },
        },
      ]),
    ).toThrow(ManagedResolutionInvariantError);
  });

  it("refuses a malformed failure even for a target no item uses", async () => {
    const plan = await planFor([createRefundPolicyCard()]);

    // Validated on the way in rather than at the point of use, so a bad outcome
    // cannot pass on the strength of nobody having read it.
    expect(() =>
      assembleContext(plan, [
        {
          targetKey: "sha256:not-a-planned-target",
          status: "failed",
          failure: { stage: "deadline", code: "NOPE", retriable: false },
        },
      ]),
    ).toThrow(ManagedResolutionInvariantError);
  });

  it("ignores a fulfilled outcome for a target the plan did not name", async () => {
    const plan = await planFor([createRefundPolicyCard()]);
    const resolution = assembleContext(plan, [
      {
        targetKey: soleTargetKey(plan),
        status: "fulfilled",
        chunks: chunksWithRanks(),
      },
      {
        targetKey: "sha256:someone-elses-target",
        status: "fulfilled",
        chunks: chunksWithRanks(),
      },
    ]);

    expect(resolution.items).toHaveLength(1);
    const [item] = resolution.items;
    if (item?.fulfillment.status !== "fulfilled") {
      throw new Error("expected a fulfilled item");
    }
    expect(item.fulfillment.context.chunks).toHaveLength(3);
  });

  it("delegates a SQL or HTTP Scope and attaches no outcome to it", async () => {
    const plan = await planFor(createDemoCardSet());
    const resolution = assembleContext(plan, []);

    for (const scopeId of ["scope_payments_table", "scope_payment_get"]) {
      const item = itemFor(resolution.items, scopeId);
      expect(item.fulfillment).toEqual({
        status: "delegated",
        executor: "consumer",
      });
    }
  });

  it("does not let one failed read take the others down with it", async () => {
    const plan = await planFor(createDemoCardSet());
    const resolution = assembleContext(plan, [
      {
        targetKey: soleTargetKey(plan),
        status: "failed",
        failure: {
          stage: "managed_search",
          code: "scope_not_published",
          retriable: false,
        },
      },
    ]);

    expect(resolution.items).toHaveLength(3);
    expect(
      resolution.items.map((item) => item.fulfillment.status).sort(),
    ).toEqual(["delegated", "delegated", "failed"]);
  });

  it("gives every merged Card the same context exactly once", async () => {
    const scope = createRefundPolicyCard().scopes;
    const plan = await planFor([
      { ...createRefundPolicyCard(), cardId: "card_one", versionId: "cardv_one", scopes: scope },
      { ...createRefundPolicyCard(), cardId: "card_two", versionId: "cardv_two", scopes: scope },
    ]);
    const resolution = assembleContext(plan, [
      {
        targetKey: soleTargetKey(plan),
        status: "fulfilled",
        chunks: chunksWithRanks(),
      },
    ]);

    expect(resolution.items).toHaveLength(1);
    const [item] = resolution.items;
    if (item?.fulfillment.status !== "fulfilled") {
      throw new Error("expected one fulfilled item");
    }
    expect(item.selectedBy.map((card) => card.cardId)).toEqual([
      "card_one",
      "card_two",
    ]);
    // Once, not once per Card: the same chunks repeated would be indistinguishable
    // from a document that really says the same thing twice.
    expect(item.fulfillment.context.chunks).toHaveLength(3);
  });

  it("states the whole comparability block once, at the root", async () => {
    const plan = await planFor([createRefundPolicyCard()]);
    const resolution = assembleContext(plan, [], {
      budget: { maxTotalCharacters: 500, maxChunks: 4 },
    });

    expect(resolution.policy).toEqual({
      payloadSchemaVersion: 3,
      scoring: QUERY_SCORING_POLICY_VERSION,
      ranking: SELECTION_RANKING_POLICY_VERSION,
      planning: SELECTION_PLANNING_POLICY_VERSION,
      fusion: CONTEXT_FUSION_POLICY_VERSION,
      assembly: CONTEXT_ASSEMBLY_POLICY_VERSION,
      budget: { maxTotalCharacters: 500, maxChunks: 4 },
    });
    for (const item of resolution.items) {
      expect(item).not.toHaveProperty("budget");
      expect(item).not.toHaveProperty("policyVersion");
    }
  });

  it("copies the budget rather than aliasing the caller's object", async () => {
    const plan = await planFor([createRefundPolicyCard()]);
    const budget = { maxTotalCharacters: 500, maxChunks: 4 };
    const resolution = assembleContext(plan, [], { budget });

    budget.maxChunks = 999;

    expect(resolution.policy.budget.maxChunks).toBe(4);
  });

  it("carries the plan's query straight through and summarizes its selection", async () => {
    const plan = await planFor(createDemoCardSet());
    const resolution = assembleContext(plan, []);

    expect(resolution.query).toBe(plan.query);
    // Derived from the plan's own verdicts rather than copied: the plan carries
    // every score and finding, and none of them may reach a consumer.
    expect(resolution.selection.counts.admitted).toBe(
      plan.summary.selection.outcomes.filter(
        (outcome) => outcome.verdict === "admit",
      ).length,
    );
    expect(resolution.selection.selected).toEqual(
      plan.summary.selection.outcomes
        .filter((outcome) => outcome.verdict === "admit")
        .map((outcome) => ({
          cardId: outcome.cardId,
          versionId: outcome.versionId,
        })),
    );
    expect(resolution.selection.mode).toBe("lexical_degraded");
  });

  it("counts every candidate the plan judged, in exactly one bucket", async () => {
    const plan = await planFor(createDemoCardSet());
    const { counts } = assembleContext(plan, []).selection;

    expect(counts.admitted + counts.deferred + counts.rejected).toBe(
      plan.summary.selection.outcomes.length,
    );
  });

  it("declares the scoring family its mode claims", async () => {
    const plan = await planFor(createDemoCardSet());
    const resolution = assembleContext(plan, []);

    // The pair, not either half. `hybrid` with a lexical scoring version would
    // tell a consumer the ranking used Card embeddings that do not exist.
    expect([resolution.selection.mode, resolution.policy.scoring]).toEqual([
      "lexical_degraded",
      "selection-lexical-v1",
    ]);
  });

  it("marks an item clipped only when that item lost something to the budget", async () => {
    const plan = await planFor([createRefundPolicyCard()]);
    const resolution = assembleContext(
      plan,
      [
        {
          targetKey: soleTargetKey(plan),
          status: "fulfilled",
          chunks: chunksWithRanks(),
        },
      ],
      { budget: { maxTotalCharacters: 1, maxChunks: 12 } },
    );
    const [item] = resolution.items;

    if (item?.fulfillment.status !== "fulfilled") {
      throw new Error("expected a fulfilled item");
    }
    expect(item.fulfillment.context.chunks).toEqual([]);
    expect(item.fulfillment.context.truncated).toBe(true);
    expect(item.fulfillment.context.omitted).toHaveLength(3);
  });

  it("files every surviving chunk under the item that planned the read", async () => {
    const plan = await planFor([createRefundPolicyCard()]);
    const [planned] = plan.items;

    if (planned === undefined || !isManagedPlannedItem(planned)) {
      throw new Error("expected one managed item");
    }
    const resolution = assembleContext(plan, [
      {
        targetKey: planned.execution.targetKey,
        status: "fulfilled",
        chunks: chunksWithRanks(),
      },
    ]);
    const [item] = resolution.items;

    if (item?.fulfillment.status !== "fulfilled") {
      throw new Error("expected a fulfilled item");
    }
    // The attribution is the item the chunks landed in; the chunk itself no
    // longer repeats `itemKey` or `scopeRef`, which are stated once above it.
    expect(item.guide.scopeRef).toEqual(planned.guide.scopeRef);
    for (const chunk of item.fulfillment.context.chunks) {
      expect(chunk).not.toHaveProperty("itemKey");
      expect(chunk).not.toHaveProperty("scopeRef");
    }
  });

  it("numbers context 1..n once across the whole response", async () => {
    const scope = createRefundPolicyCard().scopes;
    const plan = await planFor([
      {
        ...createRefundPolicyCard(),
        cardId: "card_one",
        versionId: "cardv_one",
        scopes: scope,
      },
    ]);
    const resolution = assembleContext(plan, [
      {
        targetKey: soleTargetKey(plan),
        status: "fulfilled",
        chunks: chunksWithRanks(),
      },
    ]);
    const [item] = resolution.items;

    if (item?.fulfillment.status !== "fulfilled") {
      throw new Error("expected a fulfilled item");
    }
    expect(
      item.fulfillment.context.chunks.map((chunk) => chunk.contextRank),
    ).toEqual([1, 2, 3]);
  });

  it("does not restart the numbering for a chunk in a different item", async () => {
    // Two Cards, two distinct managed Scopes, both answered. Per-item numbering
    // would give each item a chunk called 1, and the two chunks would then have
    // no order relative to one another — which is the whole point of the field.
    const first = createRefundPolicyCard();
    const second: ApprovedCard = {
      ...first,
      cardId: "card_second_document",
      versionId: "cardv_second_document",
      scopes: first.scopes.map((scope) =>
        scope.kind === "managed_document"
          ? {
              ...scope,
              reference: {
                scopeId: "scope_second_document",
                scopeVersion: "scopev_0001",
              },
              documentIndex: {
                ...scope.documentIndex,
                documentIndexId: "docidx_second",
                documentId: "doc_second",
              },
            }
          : scope,
      ),
    };
    const plan = await planFor([first, second]);

    expect(plan.managedTargets).toHaveLength(2);
    const resolution = assembleContext(
      plan,
      plan.managedTargets.map((target, index) => ({
        targetKey: target.targetKey,
        status: "fulfilled" as const,
        chunks: chunksWithRanks().map((chunk) => ({
          ...chunk,
          // Distinct identities per target, so nothing is deduplicated away and
          // both items really do keep chunks.
          chunkId: `${chunk.chunkId}_${index}`,
          chunkRevisionId: `${chunk.chunkRevisionId}_${index}`,
          contentDigest: `${chunk.contentDigest}${index}`,
        })),
      })),
    );

    const ranks = resolution.items.flatMap((item) =>
      item.fulfillment.status === "fulfilled"
        ? item.fulfillment.context.chunks.map((chunk) => chunk.contextRank)
        : [],
    );

    expect(ranks).toHaveLength(6);
    expect([...ranks].sort((left, right) => left - right)).toEqual([
      1, 2, 3, 4, 5, 6,
    ]);
  });

  it("marks an item clipped for the budget but never for a repeat", async () => {
    // Two Cards on the same Scope merge into one item, so the duplicate chunk
    // revisions land as omissions on that item without any budget being spent.
    const plan = await planFor([createRefundPolicyCard()]);
    const targetKey = soleTargetKey(plan);
    const chunks = chunksWithRanks();
    const resolution = assembleContext(plan, [
      {
        targetKey,
        status: "fulfilled",
        // The same three chunks under two different content digests would be
        // deduplicated as content; repeating one revision is what produces a
        // `duplicate_chunk_revision` without touching the budget.
        chunks: [...chunks, ...chunks.map((chunk) => ({ ...chunk, rank: 9 }))],
      },
    ]);
    const [item] = resolution.items;

    if (item?.fulfillment.status !== "fulfilled") {
      throw new Error("expected a fulfilled item");
    }
    expect(
      item.fulfillment.context.omitted.map((omission) => omission.reason),
    ).toEqual([
      "duplicate_chunk_revision",
      "duplicate_chunk_revision",
      "duplicate_chunk_revision",
    ]);
    expect(item.fulfillment.context.truncated).toBe(false);
  });

  it("assembles the same resolution for the same plan and outcomes twice", async () => {
    const plan = await planFor(createDemoCardSet());
    const outcomes: readonly ManagedResolutionOutcome[] = [
      {
        targetKey: soleTargetKey(plan),
        status: "fulfilled",
        chunks: chunksWithRanks(),
      },
    ];

    expect(assembleContext(plan, outcomes)).toEqual(
      assembleContext(plan, outcomes),
    );
  });
});
