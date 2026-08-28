import { describe, expect, it } from "vitest";

import { assembleContext } from "../../src/application/assemble-context.js";
import {
  selectContext,
  type SelectContextOptions,
  type SelectContextPorts,
} from "../../src/application/select-context.js";
import type { ApprovedCard } from "../../src/domain/card-catalog.js";
import type {
  ContextResolution,
  ContextResolutionItem,
} from "../../src/domain/context-resolution.js";
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

function planFor(
  cards: readonly ApprovedCard[],
  options: SelectContextOptions = {},
): Promise<SelectionPlan> {
  return selectContext(portsFor(cards), DEMO_QUERY, options);
}

/** The failure assembly itself reports, restated rather than imported. */
const ASSEMBLY_FAILURE = {
  stage: "assembly",
  code: "resolution_outcome_invalid",
  retriable: false,
} as const;

/** The one managed item of a single-document plan, whatever became of it. */
function managedItem(resolution: ContextResolution): ContextResolutionItem {
  const found = resolution.items.find((item) => item.guide.kind === "managed_document");

  if (found === undefined) {
    throw new Error("expected one managed item");
  }
  return found;
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

/**
 * A second Card over a second managed Scope, so a plan names two targets.
 *
 * Same document shape as the refund policy Card, different Scope and index
 * identity: the two reads are distinct, and whether their answers overlap is
 * up to the test that uses them.
 */
function secondDocumentCard(): ApprovedCard {
  const first = createRefundPolicyCard();

  return {
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

  it("fails a target the executor never answered for in assembly, and keeps the item", async () => {
    const plan = await planFor([createRefundPolicyCard()]);
    const resolution = assembleContext(plan, []);
    const [item] = resolution.items;

    // Nobody looked, so "the index answered and had nothing to say" would be a
    // claim about the document that no read supports. The item stays visible
    // — a consumer comparing the answer against the Cards that produced it
    // still finds the Scope — but it says the read did not happen.
    expect(resolution.items).toHaveLength(1);
    expect(item?.fulfillment.status).toBe("failed");
    if (item?.fulfillment.status !== "failed") {
      throw new Error("expected a failed item");
    }
    expect(item.fulfillment.failure).toEqual(ASSEMBLY_FAILURE);
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

  it("refuses a fulfilled outcome for a target the plan did not name", async () => {
    const plan = await planFor([createRefundPolicyCard()]);

    // An answer nobody asked for is evidence that the executor and assembly
    // disagree about which reads happened. There is no item it could be charged
    // to, so it is refused at request level rather than quietly dropped — and
    // the well-formed outcome beside it does not buy it a pass.
    expect(() =>
      assembleContext(plan, [
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
      ]),
    ).toThrow(ManagedResolutionInvariantError);
  });

  it("refuses a target that was answered twice, whichever copy came first", async () => {
    const plan = await planFor([createRefundPolicyCard()]);
    const targetKey = soleTargetKey(plan);
    const [first, ...rest] = chunksWithRanks();
    if (first === undefined) {
      throw new Error("expected chunks");
    }
    const fuller = { targetKey, status: "fulfilled" as const, chunks: [first, ...rest] };
    const emptier = { targetKey, status: "fulfilled" as const, chunks: [] };

    // `Map.set` used to keep whichever answer came last, so the consumer's
    // evidence depended on the executor's array order. Neither copy is the one
    // to keep: an executor answering one read twice has lost track of the read.
    expect(() => assembleContext(plan, [fuller, emptier])).toThrow(
      ManagedResolutionInvariantError,
    );
    expect(() => assembleContext(plan, [emptier, fuller])).toThrow(
      ManagedResolutionInvariantError,
    );
  });

  it("refuses a target answered twice even when both copies agree", async () => {
    const plan = await planFor([createRefundPolicyCard()]);
    const outcome = {
      targetKey: soleTargetKey(plan),
      status: "fulfilled" as const,
      chunks: chunksWithRanks(),
    };

    expect(() => assembleContext(plan, [outcome, outcome])).toThrow(
      ManagedResolutionInvariantError,
    );
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
      "selection-lexical-v4",
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
    const plan = await planFor([createRefundPolicyCard(), secondDocumentCard()]);

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
    // Two distinct Scopes over the same document both return the same three
    // revisions. One target cannot list a revision twice any more — that is an
    // invalid outcome — so the repeat has to come from a second target, which
    // is also the case fusion exists for. The losing item records three
    // `duplicate_chunk_revision` omissions without any budget being spent.
    const plan = await planFor([createRefundPolicyCard(), secondDocumentCard()]);
    expect(plan.managedTargets).toHaveLength(2);

    const resolution = assembleContext(
      plan,
      plan.managedTargets.map((target) => ({
        targetKey: target.targetKey,
        status: "fulfilled" as const,
        chunks: chunksWithRanks(),
      })),
    );

    const reasons = resolution.items.flatMap((item) =>
      item.fulfillment.status === "fulfilled"
        ? item.fulfillment.context.omitted.map((omission) => omission.reason)
        : [],
    );
    expect(reasons).toEqual([
      "duplicate_chunk_revision",
      "duplicate_chunk_revision",
      "duplicate_chunk_revision",
    ]);
    for (const item of resolution.items) {
      if (item.fulfillment.status !== "fulfilled") {
        throw new Error("expected every item to be fulfilled");
      }
      expect(item.fulfillment.context.truncated).toBe(false);
    }
  });

  describe("holds a fulfilled outcome against the plan before fusing it", () => {
    /** The three demo chunks under the ranks a test states. */
    function chunksRanked(ranks: readonly number[]) {
      return createRefundPolicyChunks()
        .slice(0, ranks.length)
        .map((chunk, index) => ({ ...chunk, rank: ranks[index] ?? 0 }));
    }

    async function assembleWith(
      chunks: readonly ResolvedDocumentChunk[],
      options: SelectContextOptions = {},
    ): Promise<ContextResolutionItem> {
      const plan = await planFor([createRefundPolicyCard()], options);
      return managedItem(
        assembleContext(plan, [
          { targetKey: soleTargetKey(plan), status: "fulfilled", chunks },
        ]),
      );
    }

    it("fails a read that returned more hits than its bound", async () => {
      // The bound travelled on the guide and on the target alike; an executor
      // that returned past it has read more than the plan authorised.
      const item = await assembleWith(chunksWithRanks(), { chunkLimitPerScope: 2 });

      expect(item.fulfillment.status).toBe("failed");
      if (item.fulfillment.status !== "failed") {
        throw new Error("expected a failed item");
      }
      expect(item.fulfillment.failure).toEqual(ASSEMBLY_FAILURE);
    });

    it("accepts a read that returned exactly its bound", async () => {
      const item = await assembleWith(chunksWithRanks(), { chunkLimitPerScope: 3 });

      expect(item.fulfillment.status).toBe("fulfilled");
    });

    it("fails ranks with a gap in them", async () => {
      const item = await assembleWith(chunksRanked([1, 2, 4]));

      expect(item.fulfillment.status).toBe("failed");
    });

    it("fails a rank that appears twice", async () => {
      const item = await assembleWith(chunksRanked([1, 2, 2]));

      expect(item.fulfillment.status).toBe("failed");
    });

    it("fails a rank below one instead of scoring it zero", async () => {
      // A zero rank breaks the 1-based contract. It used to sink to a score of
      // zero and still travel; now the target that reported it is not trusted.
      const item = await assembleWith(chunksRanked([0, 1, 2]));

      expect(item.fulfillment.status).toBe("failed");
    });

    it("fails a rank that is not an integer", async () => {
      const item = await assembleWith(chunksRanked([1, 1.5, 2]));

      expect(item.fulfillment.status).toBe("failed");
    });

    it("fails a non-finite rank instead of sinking it", async () => {
      const item = await assembleWith(chunksRanked([1, Number.NaN, 3]));

      expect(item.fulfillment.status).toBe("failed");
    });

    it("accepts ranks that are 1..N in any order", async () => {
      const item = await assembleWith(chunksRanked([3, 1, 2]));

      expect(item.fulfillment.status).toBe("fulfilled");
    });

    it("fails a target that lists one chunk revision twice", async () => {
      const [first, second] = chunksWithRanks();
      if (first === undefined || second === undefined) {
        throw new Error("expected two chunks");
      }
      const item = await assembleWith([
        first,
        { ...second, chunkRevisionId: first.chunkRevisionId },
      ]);

      // One revision is one chunk; a target naming it twice reports one read as
      // two, and fusing that would count the same evidence twice.
      expect(item.fulfillment.status).toBe("failed");
    });

    it.each([
      "chunkId",
      "chunkRevisionId",
      "semanticUnitId",
      "documentId",
      "text",
      "contentDigest",
    ] as const)("fails a chunk whose %s is empty", async (field) => {
      const chunks = chunksWithRanks().map((chunk, index) =>
        index === 1 ? { ...chunk, [field]: "" } : chunk,
      );
      const item = await assembleWith(chunks);

      // An empty citation cannot be checked against anything and an empty text
      // cannot be evidence; either way the whole target is not trusted, not
      // just the one chunk.
      expect(item.fulfillment.status).toBe("failed");
      if (item.fulfillment.status !== "failed") {
        throw new Error("expected a failed item");
      }
      expect(item.fulfillment.failure).toEqual(ASSEMBLY_FAILURE);
    });

    it("lets an assembly failure cost one item and no other", async () => {
      const plan = await planFor(createDemoCardSet(), { chunkLimitPerScope: 2 });
      const resolution = assembleContext(plan, [
        {
          targetKey: soleTargetKey(plan),
          status: "fulfilled",
          chunks: chunksWithRanks(),
        },
      ]);

      expect(resolution.items).toHaveLength(3);
      expect(
        resolution.items.map((item) => item.fulfillment.status).sort(),
      ).toEqual(["delegated", "delegated", "failed"]);
      expect(managedItem(resolution).fulfillment).toEqual({
        status: "failed",
        executor: "contextctl",
        failure: ASSEMBLY_FAILURE,
      });
    });
  });

  describe("fails the reads that contradict one another and keeps the rest", () => {
    it("fails both items when two reads disagree about one chunk revision", async () => {
      const plan = await planFor([
        ...createDemoCardSet(),
        secondDocumentCard(),
      ]);
      const [first, second] = plan.managedTargets;
      if (first === undefined || second === undefined) {
        throw new Error("expected two managed targets");
      }
      const resolution = assembleContext(plan, [
        { targetKey: first.targetKey, status: "fulfilled", chunks: chunksWithRanks() },
        {
          targetKey: second.targetKey,
          status: "fulfilled",
          chunks: chunksWithRanks().map((chunk, index) =>
            index === 0 ? { ...chunk, text: `${chunk.text} — but reworded` } : chunk,
          ),
        },
      ]);

      const managed = resolution.items.filter(
        (item) => item.guide.kind === "managed_document",
      );
      const delegated = resolution.items.filter(
        (item) => item.guide.kind !== "managed_document",
      );
      expect(managed).toHaveLength(2);
      for (const item of managed) {
        expect(item.fulfillment).toEqual({
          status: "failed",
          executor: "contextctl",
          failure: ASSEMBLY_FAILURE,
        });
      }
      // The SQL and HTTP items never touched the contradiction.
      expect(delegated).toHaveLength(2);
      expect(delegated.every((item) => item.fulfillment.status === "delegated")).toBe(
        true,
      );
    });

    it("keeps a third read that agreed with nobody's contradiction", async () => {
      const third: ApprovedCard = {
        ...secondDocumentCard(),
        cardId: "card_third_document",
        versionId: "cardv_third_document",
        scopes: secondDocumentCard().scopes.map((scope) =>
          scope.kind === "managed_document"
            ? {
                ...scope,
                reference: { scopeId: "scope_third_document", scopeVersion: "scopev_0001" },
              }
            : scope,
        ),
      };
      const plan = await planFor([createRefundPolicyCard(), secondDocumentCard(), third]);
      const targetFor = (scopeId: string): string => {
        const target = plan.managedTargets.find((candidate) => candidate.scopeRef.scopeId === scopeId);
        if (target === undefined) {
          throw new Error(`no target for ${scopeId}`);
        }
        return target.targetKey;
      };
      const resolution = assembleContext(plan, [
        {
          targetKey: targetFor("scope_refund_policy_doc"),
          status: "fulfilled",
          chunks: chunksWithRanks(),
        },
        {
          targetKey: targetFor("scope_second_document"),
          status: "fulfilled",
          chunks: chunksWithRanks().map((chunk, index) =>
            index === 0 ? { ...chunk, contentDigest: "digest_forged" } : chunk,
          ),
        },
        {
          targetKey: targetFor("scope_third_document"),
          status: "fulfilled",
          chunks: chunksWithRanks().map((chunk) => ({
            ...chunk,
            chunkId: `${chunk.chunkId}_third`,
            chunkRevisionId: `${chunk.chunkRevisionId}_third`,
            contentDigest: `${chunk.contentDigest}_third`,
          })),
        },
      ]);

      const statuses = new Map(
        resolution.items.map((item) => [item.guide.scopeRef.scopeId, item.fulfillment.status]),
      );
      expect(statuses.get("scope_refund_policy_doc")).toBe("failed");
      expect(statuses.get("scope_second_document")).toBe("failed");
      expect(statuses.get("scope_third_document")).toBe("fulfilled");

      const survivor = itemFor(resolution.items, "scope_third_document");
      if (survivor.fulfillment.status !== "fulfilled") {
        throw new Error("expected the third item to be fulfilled");
      }
      // Numbered 1..3 over the whole response: the failed reads contributed no
      // chunk to the order, so nothing of theirs occupies a rank.
      expect(survivor.fulfillment.context.chunks.map((chunk) => chunk.contextRank)).toEqual([
        1, 2, 3,
      ]);
    });
  });

  describe("projects the executor's failure into the consumer's", () => {
    it("reports a deadline under the one fixed code and flag", async () => {
      const plan = await planFor([createRefundPolicyCard()]);
      const item = managedItem(
        assembleContext(plan, [
          {
            targetKey: soleTargetKey(plan),
            status: "failed",
            failure: { stage: "deadline", code: "deadline_exceeded", retriable: true },
          },
        ]),
      );

      if (item.fulfillment.status !== "failed") {
        throw new Error("expected a failed item");
      }
      expect(item.fulfillment.failure).toEqual({
        stage: "deadline",
        code: "deadline_exceeded",
        retriable: true,
      });
    });

    it("refuses a deadline reported under a search's code", async () => {
      const plan = await planFor([createRefundPolicyCard()]);

      // A deadline means the search never answered; a search code on it would
      // claim it did. That confusion is ours, not a failure mode of the read.
      expect(() =>
        assembleContext(plan, [
          {
            targetKey: soleTargetKey(plan),
            status: "failed",
            failure: { stage: "deadline", code: "cancelled", retriable: true },
          },
        ]),
      ).toThrow(ManagedResolutionInvariantError);
    });

    it("refuses a deadline marked not retriable", async () => {
      const plan = await planFor([createRefundPolicyCard()]);

      expect(() =>
        assembleContext(plan, [
          {
            targetKey: soleTargetKey(plan),
            status: "failed",
            failure: { stage: "deadline", code: "deadline_exceeded", retriable: false },
          },
        ]),
      ).toThrow(ManagedResolutionInvariantError);
    });
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
