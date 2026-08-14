import { describe, expect, it } from "vitest";

import type { ApprovedCard } from "../../src/domain/card-catalog.js";
import { InMemoryCardCatalog } from "../../src/infrastructure/in-memory-card-catalog.js";
import {
  createDemoCardSet,
  createPaymentsTableCard,
  createRefundPolicyCard,
} from "../fixtures/approved-card.fixture.js";

function cardIdsOf(cards: readonly ApprovedCard[]): string[] {
  return cards.map((card) => card.cardId);
}

describe("InMemoryCardCatalog", () => {
  it("lists exactly the Cards it was built from, in order", async () => {
    const catalog = new InMemoryCardCatalog(createDemoCardSet());

    expect(cardIdsOf(await catalog.listApprovedCards())).toEqual([
      "card_refund_policy",
      "card_payments_table",
      "card_payment_api",
    ]);
  });

  it("hands out a fresh array per call, so a caller mutating one cannot change the next", async () => {
    const catalog = new InMemoryCardCatalog(createDemoCardSet());

    const first = await catalog.listApprovedCards();
    const second = await catalog.listApprovedCards();
    expect(first).not.toBe(second);

    // A JavaScript caller can ignore `readonly`, so the guarantee has to hold
    // against mutation, not merely against the type.
    (first as ApprovedCard[]).length = 0;

    expect(cardIdsOf(await catalog.listApprovedCards())).toEqual([
      "card_refund_policy",
      "card_payments_table",
      "card_payment_api",
    ]);
  });

  it("copies its input, so mutating the source array after construction changes nothing", async () => {
    const source: ApprovedCard[] = [createRefundPolicyCard()];
    const catalog = new InMemoryCardCatalog(source);

    source.push(createPaymentsTableCard());

    expect(cardIdsOf(await catalog.listApprovedCards())).toEqual([
      "card_refund_policy",
    ]);
  });

  it("lists nothing when built from no Cards", async () => {
    const catalog = new InMemoryCardCatalog([]);

    expect(await catalog.listApprovedCards()).toEqual([]);
  });
});
