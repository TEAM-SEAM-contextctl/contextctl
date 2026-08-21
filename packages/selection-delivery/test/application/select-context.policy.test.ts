import { describe, expect, it } from "vitest";

import { assembleContext } from "../../src/application/assemble-context.js";
import {
  resolveContextErrorStatus,
  toResolveContextErrorCode,
} from "../../src/application/errors.js";
import {
  selectContext,
  type SelectContextPorts,
} from "../../src/application/select-context.js";
import type { ApprovedCard } from "../../src/domain/card-catalog.js";
import { CardCatalogInvariantError } from "../../src/domain/errors.js";
import {
  DEFAULT_POLICY_CONTEXT,
  type PolicyContext,
} from "../../src/domain/policy-context.js";
import { InMemoryCardCandidateIndexStore } from "../../src/infrastructure/in-memory-card-candidate-index-store.js";
import { InMemoryCardCatalog } from "../../src/infrastructure/in-memory-card-catalog.js";
import type { CardEmbeddingPort } from "../../src/ports/card-embedding.js";
import {
  createDemoCardSet,
  createPaymentApiCard,
  createPaymentsTableCard,
  createRefundPolicyCard,
  DEMO_QUERY,
} from "../fixtures/approved-card.fixture.js";
import {
  ConceptCardEmbeddingAdapter,
  createLeavePolicyCard,
  createShippingCard,
  FailingCardEmbeddingAdapter,
  LEAVE_CONCEPTS,
  SYNONYM_QUERY,
  TEST_CARD_PROFILE,
} from "../fixtures/card-embedding.fixture.js";

const ALLOW: PolicyContext = { usage: "retrieval", sensitiveAccess: "allow" };

function withPolicy(
  card: ApprovedCard,
  policy: Partial<ApprovedCard["policy"]>,
): ApprovedCard {
  return { ...card, policy: { ...card.policy, ...policy } };
}

function lexicalPorts(cards: readonly ApprovedCard[]): SelectContextPorts {
  return { catalog: new InMemoryCardCatalog(cards) };
}

function semanticPorts(
  cards: readonly ApprovedCard[],
  embedding: CardEmbeddingPort = new ConceptCardEmbeddingAdapter(LEAVE_CONCEPTS),
): SelectContextPorts {
  return {
    catalog: new InMemoryCardCatalog(cards),
    semantic: {
      embedding,
      index: new InMemoryCardCandidateIndexStore(),
      profile: TEST_CARD_PROFILE,
    },
  };
}

function ids(list: readonly { readonly cardId: string }[]): readonly string[] {
  return list.map((each) => each.cardId);
}

describe("selectContext under the default policy", () => {
  it("changes nothing for a catalog approved for retrieval and not sensitive", async () => {
    const before = await selectContext(lexicalPorts(createDemoCardSet()), DEMO_QUERY);
    const explicit = await selectContext(lexicalPorts(createDemoCardSet()), DEMO_QUERY, {
      policy: DEFAULT_POLICY_CONTEXT,
    });

    expect(explicit).toEqual(before);
    expect(before.summary.policy).toEqual({
      context: DEFAULT_POLICY_CONTEXT,
      excluded: [],
    });
    expect(ids(before.summary.candidates)).toHaveLength(3);
  });
});

describe("selectContext keeps a Card out before it is scored", () => {
  it("excludes a Card not approved for retrieval, under lexical ranking", async () => {
    const summaryOnly = withPolicy(createPaymentApiCard(), {
      allowedUsage: ["summary"],
    });
    const cards = [createRefundPolicyCard(), createPaymentsTableCard(), summaryOnly];

    const plan = await selectContext(lexicalPorts(cards), DEMO_QUERY);

    expect(plan.summary.mode).toBe("lexical_degraded");
    // Absent from every layer downstream of the filter, not merely unadmitted.
    expect(ids(plan.summary.candidates)).not.toContain(summaryOnly.cardId);
    expect(ids(plan.summary.selection.outcomes)).not.toContain(summaryOnly.cardId);
    expect(ids(plan.summary.selection.provenance.ranked)).not.toContain(summaryOnly.cardId);
    expect(plan.summary.selection.provenance.consideredCount).toBe(2);
    expect(plan.items.every((item) => !ids(item.selectedBy).includes(summaryOnly.cardId))).toBe(true);
    expect(plan.summary.policy.excluded).toEqual([
      {
        cardId: summaryOnly.cardId,
        versionId: summaryOnly.versionId,
        reason: "usage_not_allowed",
      },
    ]);
  });

  it("excludes a sensitive Card under deny and admits it under allow", async () => {
    const sensitive = withPolicy(createRefundPolicyCard(), { sensitive: true });
    const cards = [sensitive, createPaymentsTableCard(), createPaymentApiCard()];

    const denied = await selectContext(lexicalPorts(cards), DEMO_QUERY);
    expect(ids(denied.summary.candidates)).not.toContain(sensitive.cardId);
    expect(denied.summary.policy.excluded).toEqual([
      { cardId: sensitive.cardId, versionId: sensitive.versionId, reason: "sensitive_denied" },
    ]);

    const allowed = await selectContext(lexicalPorts(cards), DEMO_QUERY, { policy: ALLOW });
    expect(allowed.summary.policy).toEqual({ context: ALLOW, excluded: [] });
    expect(
      allowed.summary.selection.outcomes.find((outcome) => outcome.cardId === sensitive.cardId)
        ?.verdict,
    ).toBe("admit");
  });

  it("excludes from the semantic search as well, without rebuilding the index per policy", async () => {
    const sensitiveLeave = withPolicy(createLeavePolicyCard(), { sensitive: true });
    const cards = [sensitiveLeave, createShippingCard()];
    const embedding = new ConceptCardEmbeddingAdapter(LEAVE_CONCEPTS);

    const plan = await selectContext(semanticPorts(cards, embedding), SYNONYM_QUERY);

    // The hybrid path ran — the index was prepared and the query embedded —
    // and the Card the semantic signal would have found is still absent.
    expect(plan.summary.mode).toBe("hybrid");
    expect(ids(plan.summary.candidates)).toEqual([createShippingCard().cardId]);
    expect(plan.summary.policy.excluded.map((each) => each.reason)).toEqual(["sensitive_denied"]);
    // The index was built over the whole approved catalog, sensitive Card
    // included: one batch of two Cards, then the query. Keying the index on
    // the eligible set would have embedded one Card and made the snapshot a
    // function of the policy.
    expect(embedding.batches[0]?.map((input) => input.key)).toEqual([
      "cardv_leave_policy_v1",
      "cardv_shipping_v1",
    ]);
    expect(embedding.calls).toBe(2);

    // Same catalog, same index, policy flipped: the Card the semantic path
    // reaches is admitted, and no Card was re-embedded.
    const allowed = await selectContext(semanticPorts(cards, embedding), SYNONYM_QUERY, {
      policy: ALLOW,
    });
    expect(
      allowed.summary.selection.outcomes.find((outcome) => outcome.cardId === sensitiveLeave.cardId)
        ?.verdict,
    ).toBe("admit");
  });

  it("fills the semantic top-K from eligible Cards rather than cutting first", async () => {
    // With a top-K of one, the sensitive Card is the closest and would be the
    // only hit; a post-filter would then return nothing semantic at all.
    const sensitiveLeave = withPolicy(createLeavePolicyCard(), { sensitive: true });
    const cards = [sensitiveLeave, createShippingCard()];

    const plan = await selectContext(semanticPorts(cards), SYNONYM_QUERY, {
      semantic: { lexicalTopK: 0, semanticTopK: 1 },
    });

    expect(plan.summary.mode).toBe("hybrid");
    expect(ids(plan.summary.candidates)).toEqual([createShippingCard().cardId]);
  });

  it("still applies when the semantic path degrades to lexical", async () => {
    const sensitiveLeave = withPolicy(createLeavePolicyCard(), { sensitive: true });
    const cards = [sensitiveLeave, createShippingCard()];

    const plan = await selectContext(
      semanticPorts(cards, new FailingCardEmbeddingAdapter()),
      SYNONYM_QUERY,
    );

    expect(plan.summary.mode).toBe("lexical_degraded");
    expect(ids(plan.summary.candidates)).toEqual([createShippingCard().cardId]);
    expect(plan.summary.policy.excluded.map((each) => each.cardId)).toEqual([
      sensitiveLeave.cardId,
    ]);
  });
});

describe("an excluded Card and a rejected Card are told apart", () => {
  it("records an exclusion with a reason and a rejection with findings, never both", async () => {
    const sensitive = withPolicy(createRefundPolicyCard(), { sensitive: true });
    const cards = [sensitive, createPaymentsTableCard(), createPaymentApiCard()];

    const plan = await selectContext(lexicalPorts(cards), "오늘 점심 메뉴 추천");

    const rejected = plan.summary.selection.outcomes.filter(
      (outcome) => outcome.verdict === "reject",
    );
    expect(rejected).toHaveLength(2);
    for (const outcome of rejected) {
      expect(outcome.verdict === "reject" && outcome.findings.length).toBeGreaterThan(0);
    }
    expect(plan.summary.policy.excluded).toEqual([
      { cardId: sensitive.cardId, versionId: sensitive.versionId, reason: "sensitive_denied" },
    ]);
    expect(ids(rejected)).not.toContain(sensitive.cardId);
  });

  it("leaves excluded Cards out of the counts a consumer sees", async () => {
    const summaryOnly = withPolicy(createPaymentApiCard(), { allowedUsage: ["summary"] });
    // SQL and HTTP Scopes only, so assembly needs no managed outcomes.
    const cards = [createPaymentsTableCard(), summaryOnly];

    const plan = await selectContext(lexicalPorts(cards), DEMO_QUERY);
    const resolution = assembleContext(plan, []);

    const { admitted, deferred, rejected } = resolution.selection.counts;
    expect(admitted + deferred + rejected).toBe(1);
    expect(resolution.selection.selected.map((each) => each.cardId)).not.toContain(
      summaryOnly.cardId,
    );
    // The response names the policy nowhere: the exclusion lives on the plan.
    expect(JSON.stringify(resolution)).not.toContain("usage_not_allowed");
    expect(JSON.stringify(resolution)).not.toContain(summaryOnly.cardId);
  });
});

describe("a policy that keeps every Card out", () => {
  const allSensitive = () =>
    [createLeavePolicyCard(), createShippingCard()].map((card) =>
      withPolicy(card, { sensitive: true }),
    );

  it("is an ordinary empty answer under lexical ranking", async () => {
    const plan = await selectContext(lexicalPorts(allSensitive()), SYNONYM_QUERY);
    const resolution = assembleContext(plan, []);

    expect(plan.summary.candidates).toEqual([]);
    expect(plan.items).toEqual([]);
    expect(plan.managedTargets).toEqual([]);
    expect(plan.summary.policy.excluded).toHaveLength(2);
    expect(resolution.selection.selected).toEqual([]);
    expect(resolution.selection.counts).toEqual({ admitted: 0, deferred: 0, rejected: 0 });
    expect(resolution.items).toEqual([]);
  });

  it("is an ordinary empty hybrid answer, with no query embedded and no degradation", async () => {
    const embedding = new ConceptCardEmbeddingAdapter(LEAVE_CONCEPTS);

    const plan = await selectContext(semanticPorts(allSensitive(), embedding), SYNONYM_QUERY, {
      // Forbidding lexical answers must not turn an empty answer into an error.
      semantic: { allowLexicalDegraded: false },
    });

    expect(plan.summary.mode).toBe("hybrid");
    expect(plan.summary.candidates).toEqual([]);
    expect(plan.items).toEqual([]);
    // Nothing eligible to compare against, so the user's text is not embedded.
    expect(embedding.calls).toBe(0);
    expect(() => assembleContext(plan, [])).not.toThrow();
  });
});

describe("a catalog whose policies cannot be read", () => {
  it("is refused as a whole as selection_catalog_invalid, not filtered", async () => {
    const cards = [
      createPaymentsTableCard(),
      {
        ...createPaymentApiCard(),
        policy: { sensitive: false, allowedUsage: [] },
      },
    ];

    let caught: unknown;
    try {
      await selectContext(lexicalPorts(cards), DEMO_QUERY);
    } catch (error: unknown) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(CardCatalogInvariantError);
    expect(toResolveContextErrorCode(caught)).toBe("selection_catalog_invalid");
    expect(resolveContextErrorStatus("selection_catalog_invalid")).toBe(500);
  });
});
