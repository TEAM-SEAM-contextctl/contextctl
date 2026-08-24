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
  DEMO_QUERY,
  UNRELATED_QUERY,
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
    // `lexical`, and the name is a claim: everything this file compares is
    // normalized text and character bigrams, so a version that did not name
    // the family could not be paired with `selection.mode` in a response.
    expect(QUERY_SCORING_POLICY_VERSION).toBe("selection-lexical-v2");
  });

  it("reaches the admit band for a distinctive declared keyword", () => {
    const scored = scoreOne(
      "운송장번호 규정을 알려줘",
      cardMeaning({ keywords: ["운송장번호"] }),
    );

    expect(scored.score).toBeGreaterThanOrEqual(
      DEFAULT_SELECTION_THRESHOLDS.admit,
    );
  });

  it("matches a keyword that the query carries a Korean particle on", () => {
    const scored = scoreOne(
      "현재 재고를 알려줘",
      cardMeaning({ keywords: ["재고"] }),
    );

    expect(scored.score).toBeGreaterThan(DEFAULT_SELECTION_THRESHOLDS.reject);
    expect(scored.score).toBeLessThan(DEFAULT_SELECTION_THRESHOLDS.admit);
    expect(scored.signals).toContainEqual({
      field: "keyword",
      matched: "재고",
      contribution: scored.score,
    });
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
    const card = cardMeaning({ keywords: ["환불정책"] });
    const composed = "환불정책이 궁금합니다";
    const decomposed = composed.normalize("NFD");

    expect(decomposed).not.toBe(composed);
    expect(scoreOne(decomposed, card).score).toBe(scoreOne(composed, card).score);
    expect(scoreOne(decomposed, card).score).toBeGreaterThanOrEqual(
      DEFAULT_SELECTION_THRESHOLDS.admit,
    );
  });

  it("scores a decomposed keyword declaration the same as a composed one", () => {
    const query = "환불정책이 궁금합니다";
    const composed = cardMeaning({ keywords: ["환불정책"] });
    const decomposed = cardMeaning({ keywords: ["환불정책".normalize("NFD")] });

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

  it("drops incidental character overlap below the indirect evidence floor", () => {
    const cards = Array.from({ length: 128 }, (_, index) =>
      cardMeaning(
        {
          representativeQuestions: [
            `Where is synthetic topic ${String(index).padStart(5, "0")}?`,
          ],
        },
        `cardv_noise_${String(index)}`,
      ),
    );
    const scored = scoreCardsAgainstQuery(
      "What is today's dollar exchange rate?",
      cards,
    );

    expect(scored.every((candidate) => candidate.score === 0)).toBe(true);
    expect(scored.every((candidate) => candidate.signals.length === 0)).toBe(
      true,
    );

    const repeated = scoreCardsAgainstQuery(
      "What is today's dollar exchange rate?",
      cards,
    );
    expect(repeated[0]).toBe(scored[0]);
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
    expect(
      scored.signals.filter(
        (signal) => signal.field === "keyword" || signal.field === "alias",
      ),
    ).toHaveLength(3);
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

    expect(scored.signals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "keyword", matched: "환불" }),
        expect.objectContaining({ field: "alias", matched: "환불 정책" }),
        expect.objectContaining({ field: "bm25", matched: "catalog" }),
      ]),
    );
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
    const cards = createDemoCardSet();

    const first = scoreCardsAgainstQuery(DEMO_QUERY, cards);
    const second = scoreCardsAgainstQuery(DEMO_QUERY, cards);
    const reversed = scoreCardsAgainstQuery(DEMO_QUERY, [...cards].reverse());

    expect(second).toEqual(first);
    expect(scoreByCardId(reversed)).toEqual(scoreByCardId(first));
  });

  it("feeds judgeCandidates unchanged, carrying versionId through", () => {
    const cards = createDemoCardSet();
    const scores = scoreCardsAgainstQuery(DEMO_QUERY, cards);

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

  it("pins the demo query: every demo Card reaches the admit band", () => {
    const scores = scoreByCardId(
      scoreCardsAgainstQuery(DEMO_QUERY, createDemoCardSet()),
    );

    // Compared against the threshold constant rather than against the numbers
    // the heuristic currently produces. Pinning 0.9167 here would turn any
    // tuning of the scoring constants into a failure of a test that is not
    // about them: what the demo depends on is that each Card clears the bar.
    for (const cardId of [
      "card_refund_policy",
      "card_payments_table",
      "card_payment_api",
    ]) {
      expect(scores.get(cardId)).toBeGreaterThanOrEqual(
        DEFAULT_SELECTION_THRESHOLDS.admit,
      );
    }
  });

  it("admits no demo Card at all on a query from a domain none of them covers", () => {
    // The negative control, and the reason it is worth more than the positive
    // one above: widening a Card's keywords until it is admitted and a Card
    // being admitted because it can answer look identical from the admit side.
    // Only "nothing is admitted for an unrelated question" tells them apart,
    // and it fails the moment a declared term is broad enough to catch text the
    // Card cannot account for.
    const scores = scoreCardsAgainstQuery(UNRELATED_QUERY, createDemoCardSet());

    expect(scores).toHaveLength(3);
    for (const scored of scores) {
      expect(scored.score).toBeLessThan(DEFAULT_SELECTION_THRESHOLDS.admit);

      // And the scores are low for the right reason. A score alone cannot
      // separate "no declared term matched" from "a term matched but the
      // arithmetic happened to land low", so the direct signals are asserted
      // absent outright: not one keyword or alias of any demo Card occurs in
      // this query.
      expect(
        scored.signals.filter(
          (signal) => signal.field === "keyword" || signal.field === "alias",
        ),
      ).toEqual([]);
    }
  });

  it("admits the payments table Card on its keyword, not on its description prose", () => {
    const payments = createDemoCardSet().find(
      (card) => card.cardId === "card_payments_table",
    );
    if (payments === undefined) {
      throw new Error("demo card set no longer contains the payments table Card");
    }

    const scored = scoreOne(DEMO_QUERY, payments);
    const admitting = scored.signals.filter(
      (signal) => signal.contribution >= DEFAULT_SELECTION_THRESHOLDS.admit,
    );

    expect(admitting.map((signal) => signal.field)).toEqual([
      "keyword",
      "keyword",
    ]);
    expect(admitting.map((signal) => signal.matched)).toEqual([
      "결제 실패",
      "실패 내역",
    ]);
  });

  it("gives the demo query a defer-or-lower score on prose overlap alone", () => {
    const scored = scoreOne(
      DEMO_QUERY,
      cardMeaning({
        description: "결제 내역 테이블 — 결제별 상태와 실패 사유, 발생 시각",
      }),
    );

    // Non-vacuous on both sides: the prose really does resemble the query, and
    // resembling it is still not enough to be admitted.
    expect(scored.score).toBeGreaterThan(0);
    expect(scored.score).toBeLessThan(DEFAULT_SELECTION_THRESHOLDS.admit);
  });
});
