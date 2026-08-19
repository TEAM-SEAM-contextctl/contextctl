import { describe, expect, it } from "vitest";

import {
  catalogSnapshotVersion,
  type CardCandidateIndex,
} from "../../src/domain/card-candidate-index.js";
import { buildCardSelectionEntry } from "../../src/domain/card-selection-text.js";
import { CardSelectionInputLimitError } from "../../src/domain/errors.js";
import { InMemoryCardCandidateIndexStore } from "../../src/infrastructure/in-memory-card-candidate-index-store.js";
import type { ApprovedCard } from "../../src/domain/card-catalog.js";
import {
  CardEmbeddingFault,
  type CardEmbeddingPort,
} from "../../src/ports/card-embedding.js";
import {
  ConceptCardEmbeddingAdapter,
  createLeavePolicyCard,
  createShippingCard,
  FailingCardEmbeddingAdapter,
  LEAVE_CONCEPTS,
  TEST_CARD_PROFILE,
} from "../fixtures/card-embedding.fixture.js";

function acquire(
  store: InMemoryCardCandidateIndexStore,
  cards: readonly ApprovedCard[],
  embedding: CardEmbeddingPort = new ConceptCardEmbeddingAdapter(LEAVE_CONCEPTS),
): Promise<CardCandidateIndex> {
  const entries = cards.map(buildCardSelectionEntry);

  return store.acquire({
    entries,
    catalogSnapshotVersion: catalogSnapshotVersion(entries, TEST_CARD_PROFILE),
    profile: TEST_CARD_PROFILE,
    embedding,
  });
}

function edited(card: ApprovedCard): ApprovedCard {
  return {
    ...card,
    meaning: { ...card.meaning, keywords: [...card.meaning.keywords, "휴직"] },
  };
}

describe("InMemoryCardCandidateIndexStore", () => {
  it("builds an index covering every Card of the snapshot", async () => {
    const store = new InMemoryCardCandidateIndexStore();
    const cards = [createLeavePolicyCard(), createShippingCard()];
    const index = await acquire(store, cards);

    expect(index.size).toBe(2);
    for (const entry of cards.map(buildCardSelectionEntry)) {
      expect(index.covers(entry.cardVersionId, entry.selectionTextDigest)).toBe(
        true,
      );
    }
  });

  it("serves the same index again for an unchanged snapshot", async () => {
    const store = new InMemoryCardCandidateIndexStore();
    const embedding = new ConceptCardEmbeddingAdapter(LEAVE_CONCEPTS);
    const cards = [createLeavePolicyCard()];

    const first = await acquire(store, cards, embedding);
    const second = await acquire(store, cards, embedding);

    expect(second).toBe(first);
    expect(embedding.calls).toBe(1);
  });

  it("rebuilds when a Card's declared meaning changes", async () => {
    const store = new InMemoryCardCandidateIndexStore();
    const embedding = new ConceptCardEmbeddingAdapter(LEAVE_CONCEPTS);

    const before = await acquire(store, [createLeavePolicyCard()], embedding);
    const after = await acquire(
      store,
      [edited(createLeavePolicyCard())],
      embedding,
    );

    expect(after).not.toBe(before);
    expect(embedding.calls).toBe(2);
  });

  /**
   * The pointer swap, stated as what a reader can observe.
   *
   * A reader that took the previous index keeps a fully consistent snapshot: it
   * is an immutable value, so a rebuild cannot empty it, grow it, or leave it
   * half-populated while a query is scoring against it.
   */
  it("leaves an already-acquired index intact across a rebuild", async () => {
    const store = new InMemoryCardCandidateIndexStore();
    const held = await acquire(store, [createLeavePolicyCard()]);

    await acquire(store, [createLeavePolicyCard(), createShippingCard()]);

    expect(held.size).toBe(1);
    expect(store.current?.size).toBe(2);
  });

  it("shares one build between concurrent callers of one snapshot", async () => {
    const store = new InMemoryCardCandidateIndexStore();
    const embedding = new ConceptCardEmbeddingAdapter(LEAVE_CONCEPTS);
    const cards = [createLeavePolicyCard(), createShippingCard()];

    const [first, second] = await Promise.all([
      acquire(store, cards, embedding),
      acquire(store, cards, embedding),
    ]);

    // Two queries arriving together must not each embed the whole catalog.
    expect(first).toBe(second);
    expect(embedding.calls).toBe(1);
  });

  it("publishes nothing when the provider fails", async () => {
    const store = new InMemoryCardCandidateIndexStore();

    await expect(
      acquire(store, [createLeavePolicyCard()], new FailingCardEmbeddingAdapter()),
    ).rejects.toThrow(CardEmbeddingFault);
    expect(store.current).toBeUndefined();
  });

  it("retries after a failure rather than caching it", async () => {
    const store = new InMemoryCardCandidateIndexStore();
    const cards = [createLeavePolicyCard()];

    await expect(
      acquire(store, cards, new FailingCardEmbeddingAdapter()),
    ).rejects.toThrow(CardEmbeddingFault);
    // A rejected promise kept under the snapshot key would make every later
    // query replay one transient fault forever.
    const index = await acquire(store, cards);

    expect(index.size).toBe(1);
  });

  it("refuses a Card longer than the profile admits, before embedding it", async () => {
    const store = new InMemoryCardCandidateIndexStore();
    const embedding = new ConceptCardEmbeddingAdapter(LEAVE_CONCEPTS);
    const card = createLeavePolicyCard();
    const oversized: ApprovedCard = {
      ...card,
      meaning: {
        ...card.meaning,
        description: "가".repeat(
          TEST_CARD_PROFILE.admissionLimits.maxCardUnits + 1,
        ),
      },
    };

    await expect(acquire(store, [oversized], embedding)).rejects.toThrow(
      CardSelectionInputLimitError,
    );
    // An unusable catalog costs no inference at all.
    expect(embedding.calls).toBe(0);
  });

  it("builds an empty index for an empty snapshot without calling the provider", async () => {
    const store = new InMemoryCardCandidateIndexStore();
    const embedding = new ConceptCardEmbeddingAdapter(LEAVE_CONCEPTS);
    const index = await acquire(store, [], embedding);

    expect(index.size).toBe(0);
    expect(embedding.calls).toBe(0);
  });

  it("fails the build when the provider answers for fewer Cards than it was given", async () => {
    const store = new InMemoryCardCandidateIndexStore();
    const partial = {
      providerKind: "test" as const,
      embed: async () => [
        { key: "cardv_leave_policy_v1", vector: [1, 0, 0, 0] },
      ],
    };

    // A Card silently absent from the index is absent from every ranking, and
    // that is indistinguishable from a Card that scored badly.
    await expect(
      acquire(
        store,
        [createLeavePolicyCard(), createShippingCard()],
        partial as never,
      ),
    ).rejects.toThrow(CardEmbeddingFault);
  });
});
