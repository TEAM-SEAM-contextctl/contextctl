import { describe, expect, it } from "vitest";

import {
  CardEmbeddingUnavailableError,
  QueryInputLimitExceededError,
} from "../../src/application/errors.js";
import {
  selectContext,
  type SelectContextPorts,
  type SemanticSelectionPorts,
} from "../../src/application/select-context.js";
import type { ApprovedCard } from "../../src/domain/card-catalog.js";
import { CardSelectionInputLimitError } from "../../src/domain/errors.js";
import { InMemoryCardCandidateIndexStore } from "../../src/infrastructure/in-memory-card-candidate-index-store.js";
import { InMemoryCardCatalog } from "../../src/infrastructure/in-memory-card-catalog.js";
import type { CardEmbeddingPort } from "../../src/ports/card-embedding.js";
import {
  ConceptCardEmbeddingAdapter,
  createLeavePolicyCard,
  createShippingCard,
  FailingCardEmbeddingAdapter,
  LEAVE_CONCEPTS,
  SYNONYM_QUERY,
  TEST_CARD_PROFILE,
} from "../fixtures/card-embedding.fixture.js";

function cards(): readonly ApprovedCard[] {
  return [createLeavePolicyCard(), createShippingCard()];
}

function lexicalPorts(): SelectContextPorts {
  return { catalog: new InMemoryCardCatalog(cards()) };
}

function semanticPorts(
  embedding: CardEmbeddingPort = new ConceptCardEmbeddingAdapter(LEAVE_CONCEPTS),
): SemanticSelectionPorts {
  return {
    embedding,
    index: new InMemoryCardCandidateIndexStore(),
    profile: TEST_CARD_PROFILE,
  };
}

function admittedIds(outcomes: readonly { verdict: string; cardId: string }[]) {
  return outcomes
    .filter((outcome) => outcome.verdict === "admit")
    .map((outcome) => outcome.cardId);
}

describe("selectContext under a hybrid ranking", () => {
  /**
   * The case the whole step exists for, in two halves that differ in one thing.
   *
   * The query asks about "휴가". The Card declares "연차" and "annual leave" and
   * neither string occurs in the query, so lexical matching can only reach its
   * indirect bigram signal — which is what the first half asserts, by leaving
   * the Card unadmitted. The second half changes nothing but the presence of the
   * Card embedding ports, and the same Card is admitted. Neither half touches a
   * threshold, so "admitted" cannot be an artefact of a widened band.
   */
  it("admits a Card the query means but never names", async () => {
    const lexicalOnly = await selectContext(lexicalPorts(), SYNONYM_QUERY);

    expect(lexicalOnly.summary.mode).toBe("lexical_degraded");
    expect(admittedIds(lexicalOnly.summary.selection.outcomes)).toEqual([]);
    // Not merely unadmitted: the lexical signal is genuinely weak, so the gap
    // being closed is a real one rather than a Card sitting a hair under the
    // threshold.
    const lexicalScore = lexicalOnly.summary.candidates.find(
      (candidate) => candidate.cardId === "card_leave_policy",
    )?.score;
    expect(lexicalScore).toBeLessThan(0.85);

    const hybrid = await selectContext(
      { catalog: new InMemoryCardCatalog(cards()), semantic: semanticPorts() },
      SYNONYM_QUERY,
    );

    expect(hybrid.summary.mode).toBe("hybrid");
    expect(admittedIds(hybrid.summary.selection.outcomes)).toEqual([
      "card_leave_policy",
    ]);
    // The Scope of the Card that was reached only by meaning is planned, so the
    // semantic path reaches all the way into the answer rather than only into
    // the ranking.
    expect(hybrid.items.map((item) => item.guide.scopeRef.scopeId)).toEqual([
      "scope_leave_api",
    ]);
  });

  /**
   * The other half of the same claim. A semantic path that admitted everything
   * would satisfy the test above, so the control Card has to stay out.
   */
  it("leaves a Card the query neither names nor means unadmitted", async () => {
    const plan = await selectContext(
      { catalog: new InMemoryCardCatalog(cards()), semantic: semanticPorts() },
      SYNONYM_QUERY,
    );
    const shipping = plan.summary.selection.outcomes.find(
      (outcome) => outcome.cardId === "card_shipping",
    );

    expect(shipping?.verdict).not.toBe("admit");
  });

  /**
   * The bound the requirement is actually about: a Card must be able to enter
   * the ranking through the semantic path *alone*.
   *
   * `lexicalTopK: 0` empties the lexical contribution to the union entirely, so
   * every Card in it arrived by cosine. If the semantic path only ever reranked
   * a lexical shortlist, this would admit nothing.
   */
  it("reaches a Card through the semantic path with no lexical contribution", async () => {
    const plan = await selectContext(
      { catalog: new InMemoryCardCatalog(cards()), semantic: semanticPorts() },
      SYNONYM_QUERY,
      { semantic: { lexicalTopK: 0, semanticTopK: 1 } },
    );

    expect(plan.summary.mode).toBe("hybrid");
    expect(admittedIds(plan.summary.selection.outcomes)).toEqual([
      "card_leave_policy",
    ]);
  });

  it("keeps every scored Card in the counts, union or not", async () => {
    const plan = await selectContext(
      { catalog: new InMemoryCardCatalog(cards()), semantic: semanticPorts() },
      SYNONYM_QUERY,
      { semantic: { lexicalTopK: 0, semanticTopK: 1 } },
    );

    // Two Cards were considered even though the union held one. A response that
    // counted only the union could not tell "the catalog had nothing else" from
    // "the catalog had more and none of it qualified".
    expect(plan.summary.candidates).toHaveLength(2);
    expect(plan.summary.selection.provenance.consideredCount).toBe(2);
  });

  it("embeds the query exactly once per resolution", async () => {
    const embedding = new ConceptCardEmbeddingAdapter(LEAVE_CONCEPTS);
    const semantic = semanticPorts(embedding);

    await selectContext(
      { catalog: new InMemoryCardCatalog(cards()), semantic },
      SYNONYM_QUERY,
    );

    // One batch for the two Cards, one for the query.
    expect(embedding.calls).toBe(2);
    expect(embedding.batches[0]?.map((input) => input.key)).toEqual([
      "cardv_leave_policy_v1",
      "cardv_shipping_v1",
    ]);
    expect(embedding.batches[1]?.map((input) => input.key)).toEqual(["query"]);
  });

  it("reuses the prepared index across resolutions of one snapshot", async () => {
    const embedding = new ConceptCardEmbeddingAdapter(LEAVE_CONCEPTS);
    const semantic = semanticPorts(embedding);
    const ports = { catalog: new InMemoryCardCatalog(cards()), semantic };

    await selectContext(ports, SYNONYM_QUERY);
    await selectContext(ports, SYNONYM_QUERY);

    // Two queries, one Card batch. Re-embedding the catalog per query would
    // make the semantic path cost more than the answer it produces.
    expect(embedding.batches.filter((batch) => batch.length === 2)).toHaveLength(
      1,
    );
    expect(embedding.calls).toBe(3);
  });
});

describe("selectContext when the semantic path is unusable", () => {
  it("answers lexically when no embedding port is bound", async () => {
    const plan = await selectContext(lexicalPorts(), SYNONYM_QUERY);

    expect(plan.summary.mode).toBe("lexical_degraded");
  });

  it("answers lexically when the provider fails and the policy allows it", async () => {
    const plan = await selectContext(
      {
        catalog: new InMemoryCardCatalog(cards()),
        semantic: semanticPorts(new FailingCardEmbeddingAdapter()),
      },
      SYNONYM_QUERY,
    );

    expect(plan.summary.mode).toBe("lexical_degraded");
    // Degradation removes a signal; it never relaxes a threshold. The Card the
    // semantic path would have found stays out rather than being waved through.
    expect(admittedIds(plan.summary.selection.outcomes)).toEqual([]);
  });

  it("refuses the query when the provider fails and the policy forbids it", async () => {
    await expect(
      selectContext(
        {
          catalog: new InMemoryCardCatalog(cards()),
          semantic: semanticPorts(new FailingCardEmbeddingAdapter()),
        },
        SYNONYM_QUERY,
        { semantic: { allowLexicalDegraded: false } },
      ),
    ).rejects.toThrow(CardEmbeddingUnavailableError);
  });

  it("reports an unavailable provider as a retriable service failure", async () => {
    try {
      await selectContext(
        {
          catalog: new InMemoryCardCatalog(cards()),
          semantic: semanticPorts(new FailingCardEmbeddingAdapter()),
        },
        SYNONYM_QUERY,
        { semantic: { allowLexicalDegraded: false } },
      );
      throw new Error("expected the resolution to be refused");
    } catch (cause) {
      expect(cause).toBeInstanceOf(CardEmbeddingUnavailableError);
      expect((cause as CardEmbeddingUnavailableError).code).toBe(
        "selection_embedding_unavailable",
      );
      expect((cause as CardEmbeddingUnavailableError).retriable).toBe(true);
    }
  });

  it("degrades rather than fails on an empty catalog, and admits nothing", async () => {
    const plan = await selectContext(
      { catalog: new InMemoryCardCatalog([]), semantic: semanticPorts() },
      SYNONYM_QUERY,
    );

    expect(plan.summary.mode).toBe("lexical_degraded");
    expect(plan.summary.candidates).toEqual([]);
  });

  it("refuses an empty catalog when the policy forbids degrading", async () => {
    await expect(
      selectContext(
        { catalog: new InMemoryCardCatalog([]), semantic: semanticPorts() },
        SYNONYM_QUERY,
        { semantic: { allowLexicalDegraded: false } },
      ),
    ).rejects.toThrow(CardEmbeddingUnavailableError);
  });
});

describe("selectContext input limits", () => {
  /**
   * Refused rather than truncated, and refused even though degrading is
   * permitted. A provider that is down is our problem; a query that is too long
   * is one the caller can fix, and answering it under a quieter scoring family
   * would hide the only fact it needs.
   */
  it("refuses a query longer than the profile admits", async () => {
    const overLong = "휴".repeat(TEST_CARD_PROFILE.admissionLimits.maxQueryUnits + 1);

    await expect(
      selectContext(
        { catalog: new InMemoryCardCatalog(cards()), semantic: semanticPorts() },
        overLong,
      ),
    ).rejects.toThrow(QueryInputLimitExceededError);
  });

  it("admits a query exactly at the limit", async () => {
    const exact = "휴".repeat(TEST_CARD_PROFILE.admissionLimits.maxQueryUnits);
    const plan = await selectContext(
      { catalog: new InMemoryCardCatalog(cards()), semantic: semanticPorts() },
      exact,
    );

    expect(plan.summary.mode).toBe("hybrid");
  });

  it("measures the query in code points rather than UTF-16 units", async () => {
    // Every one of these is a single code point stored as a surrogate pair, so
    // a `length`-based measure would call this twice its true size and refuse a
    // query that fits.
    const astral = "𝕏".repeat(TEST_CARD_PROFILE.admissionLimits.maxQueryUnits);
    const plan = await selectContext(
      { catalog: new InMemoryCardCatalog(cards()), semantic: semanticPorts() },
      astral,
    );

    expect(plan.summary.mode).toBe("hybrid");
  });

  /**
   * A Card over the limit fails the request outright rather than degrading.
   *
   * It is not a provider that went away, and no later query would find it
   * usable: the catalog holds a Card this profile cannot index, and only an
   * operator can fix that.
   */
  it("refuses a catalog holding a Card longer than the profile admits", async () => {
    const huge = createLeavePolicyCard();
    const oversized: ApprovedCard = {
      ...huge,
      meaning: {
        ...huge.meaning,
        description: "가".repeat(
          TEST_CARD_PROFILE.admissionLimits.maxCardUnits + 1,
        ),
      },
    };

    await expect(
      selectContext(
        {
          catalog: new InMemoryCardCatalog([oversized]),
          semantic: semanticPorts(),
        },
        SYNONYM_QUERY,
      ),
    ).rejects.toThrow(CardSelectionInputLimitError);
  });
});
