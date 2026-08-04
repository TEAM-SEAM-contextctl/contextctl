import { describe, expect, it } from "vitest";

import type {
  ApprovedCard,
  ApprovedCardMeaning,
} from "../../src/domain/card-catalog.js";
import {
  QUERY_SCORING_POLICY_VERSION,
  scoreCardsAgainstQuery,
  type CandidateScore,
} from "../../src/domain/query-scoring.js";
import {
  DEFAULT_SELECTION_THRESHOLDS,
  judgeCandidates,
} from "../../src/domain/selection-verdict.js";
import {
  createDemoCardSet,
  createRefundPolicyCard,
} from "../fixtures/approved-card.fixture.js";

const EMPTY_MEANING: ApprovedCardMeaning = {
  description: "",
  representativeQuestions: [],
  aliases: [],
  keywords: [],
};

/** A Card that differs from the demo fixture only in what it claims to mean. */
function cardMeaning(
  overrides: Partial<ApprovedCardMeaning>,
  versionId = "cardv_test_v1",
): ApprovedCard {
  return {
    ...createRefundPolicyCard(),
    cardId: "card_test",
    versionId,
    meaning: { ...EMPTY_MEANING, ...overrides },
  };
}

function scoreOne(queryText: string, card: ApprovedCard): CandidateScore {
  const [scored] = scoreCardsAgainstQuery(queryText, [card]);
  if (scored === undefined) {
    throw new Error("scoreCardsAgainstQuery dropped its only card");
  }
  return scored;
}

function scoreByCardId(
  scores: readonly CandidateScore[],
): ReadonlyMap<string, number> {
  return new Map(scores.map((scored) => [scored.cardId, scored.score]));
}

describe("scoreCardsAgainstQuery", () => {
  it("declares the policy version its scores were produced under", () => {
    expect(QUERY_SCORING_POLICY_VERSION).toBe("selection-scoring-v1");
  });

  it("reaches the admit band when a declared keyword appears in the query", () => {
    const scored = scoreOne(
      "환불 규정을 알려줘",
      cardMeaning({ keywords: ["환불"] }),
    );

    expect(scored.score).toBeGreaterThanOrEqual(0.9);
    expect(scored.score).toBeGreaterThanOrEqual(
      DEFAULT_SELECTION_THRESHOLDS.admit,
    );
  });

  it("matches a keyword that the query carries a Korean particle on", () => {
    const scored = scoreOne(
      "현재 재고를 알려줘",
      cardMeaning({ keywords: ["재고"] }),
    );

    expect(scored.score).toBeGreaterThanOrEqual(0.9);
    expect(scored.signals).toEqual([
      { field: "keyword", matched: "재고", contribution: scored.score },
    ]);
  });

  it("matches Latin keywords regardless of case", () => {
    const scored = scoreOne(
      "refund 정책이 궁금해",
      cardMeaning({ keywords: ["Refund"] }),
    );

    expect(scored.score).toBeGreaterThanOrEqual(0.9);
    expect(scored.signals[0]?.matched).toBe("Refund");
  });

  it("scores decomposed and composed Hangul identically", () => {
    const card = cardMeaning({ keywords: ["환불"] });
    const composed = "환불이 가능한가요";
    const decomposed = composed.normalize("NFD");

    expect(decomposed).not.toBe(composed);
    expect(scoreOne(decomposed, card).score).toBe(scoreOne(composed, card).score);
    expect(scoreOne(decomposed, card).score).toBeGreaterThanOrEqual(0.9);
  });

  it("scores a decomposed keyword declaration the same as a composed one", () => {
    const query = "환불이 가능한가요";
    const composed = cardMeaning({ keywords: ["환불"] });
    const decomposed = cardMeaning({ keywords: ["환불".normalize("NFD")] });

    expect(scoreOne(query, decomposed).score).toBe(
      scoreOne(query, composed).score,
    );
  });

  it("scores zero with no signals when nothing in the Card matches", () => {
    const scored = scoreOne(
      "zzzz",
      cardMeaning({
        description: "환불 정책 문서",
        representativeQuestions: ["환불이 가능한 기간은 며칠인가요?"],
        aliases: ["refund policy"],
        keywords: ["환불"],
      }),
    );

    expect(scored.score).toBe(0);
    expect(scored.signals).toEqual([]);
  });

  it("stays finite when the Card declares no keywords and no aliases", () => {
    const scored = scoreOne(
      "환불이 가능한가요",
      cardMeaning({ keywords: [], aliases: [] }),
    );

    expect(Number.isNaN(scored.score)).toBe(false);
    expect(Number.isFinite(scored.score)).toBe(true);
    expect(scored.score).toBeGreaterThanOrEqual(0);
    expect(scored.score).toBeLessThanOrEqual(1);
  });

  it("never exceeds one even when every declared term matches", () => {
    const scored = scoreOne(
      "환불 반품 refund 모두 알려줘",
      cardMeaning({ keywords: ["환불", "반품"], aliases: ["refund"] }),
    );

    expect(scored.score).toBe(1);
    expect(scored.signals).toHaveLength(3);
  });

  it("ignores an empty declared keyword instead of matching everything", () => {
    const scored = scoreOne("환불", cardMeaning({ keywords: [""] }));

    expect(scored.score).toBe(0);
    expect(scored.signals).toEqual([]);
  });

  it("lets a whitespace-only question or description produce no score", () => {
    const scored = scoreOne(
      "환불이 가능한 상품은 무엇인가요?",
      cardMeaning({
        description: "   ",
        representativeQuestions: ["  ", "\t\n"],
      }),
    );

    expect(scored.score).toBe(0);
    expect(scored.signals).toEqual([]);
  });

  it("survives an empty query without crashing, scoring every Card zero", () => {
    const scores = scoreCardsAgainstQuery("   ", createDemoCardSet());

    expect(scores.map((scored) => scored.score)).toEqual([0, 0, 0]);
    expect(scores.every((scored) => scored.signals.length === 0)).toBe(true);
  });

  it("records the field, the matched text, and the contribution of each signal", () => {
    const scored = scoreOne(
      "환불 정책이 궁금해",
      cardMeaning({
        description: "환불 정책 문서",
        aliases: ["환불 정책"],
        keywords: ["환불"],
      }),
    );

    expect(scored.signals.map((signal) => signal.field)).toEqual([
      "keyword",
      "alias",
      "description",
    ]);
    expect(scored.signals.map((signal) => signal.matched)).toEqual([
      "환불",
      "환불 정책",
      "환불 정책 문서",
    ]);
    for (const signal of scored.signals) {
      expect(Number.isFinite(signal.contribution)).toBe(true);
      expect(signal.contribution).toBeGreaterThan(0);
    }
  });

  it("keeps the input order and leaves the input untouched", () => {
    const cards = createDemoCardSet();
    const snapshot = JSON.stringify(cards);

    const scores = scoreCardsAgainstQuery("환불 가능한 상품", cards);

    expect(scores.map((scored) => scored.cardId)).toEqual(
      cards.map((card) => card.cardId),
    );
    expect(JSON.stringify(cards)).toBe(snapshot);
  });

  it("produces the same result twice and the same per-Card score in any order", () => {
    const query = "환불할 수 없는 상품과 현재 재고를 알려줘";
    const cards = createDemoCardSet();

    const first = scoreCardsAgainstQuery(query, cards);
    const second = scoreCardsAgainstQuery(query, cards);
    const reversed = scoreCardsAgainstQuery(query, [...cards].reverse());

    expect(second).toEqual(first);
    expect(scoreByCardId(reversed)).toEqual(scoreByCardId(first));
  });

  it("feeds judgeCandidates unchanged, carrying versionId through", () => {
    const cards = createDemoCardSet();
    const scores = scoreCardsAgainstQuery(
      "환불할 수 없는 상품과 현재 재고를 알려줘",
      cards,
    );

    const { outcomes, provenance } = judgeCandidates(scores);

    expect(provenance.consideredCount).toBe(cards.length);
    expect(new Set(outcomes.map((outcome) => outcome.versionId))).toEqual(
      new Set(cards.map((card) => card.versionId)),
    );
    for (const outcome of outcomes) {
      const source = cards.find((card) => card.versionId === outcome.versionId);
      expect(outcome.cardId).toBe(source?.cardId);
    }
  });

  it("pins the demo query: refund and inventory admit, payment rejects", () => {
    const scores = scoreByCardId(
      scoreCardsAgainstQuery(
        "환불할 수 없는 상품과 현재 재고를 알려줘",
        createDemoCardSet(),
      ),
    );

    expect(scores.get("card_refund_policy")).toBeGreaterThanOrEqual(0.85);
    expect(scores.get("card_inventory")).toBeGreaterThanOrEqual(0.85);
    expect(scores.get("card_payment_api")).toBeLessThan(0.35);
  });

  it("admits the inventory Card on its keyword, not on its description prose", () => {
    const inventory = createDemoCardSet().find(
      (card) => card.cardId === "card_inventory",
    );
    if (inventory === undefined) {
      throw new Error("demo card set no longer contains the inventory Card");
    }

    const scored = scoreOne("환불할 수 없는 상품과 현재 재고를 알려줘", inventory);
    const admitting = scored.signals.filter(
      (signal) => signal.contribution >= DEFAULT_SELECTION_THRESHOLDS.admit,
    );

    expect(admitting.map((signal) => signal.field)).toEqual(["keyword"]);
    expect(admitting[0]?.matched).toBe("재고");
  });

  it("gives the demo query a defer-or-lower score on prose overlap alone", () => {
    const scored = scoreOne(
      "환불할 수 없는 상품과 현재 재고를 알려줘",
      cardMeaning({
        description: "상품 재고 테이블 — 상품별 현재 재고 수량과 환불 가능 여부",
      }),
    );

    expect(scored.score).toBeLessThan(DEFAULT_SELECTION_THRESHOLDS.admit);
  });
});
