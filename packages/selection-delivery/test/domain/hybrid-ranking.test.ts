import { describe, expect, it } from "vitest";

import { SelectionModeInvariantError } from "../../src/domain/errors.js";
import {
  assertSelectionScoringPairing,
  combineHybridScore,
  HYBRID_AGREEMENT_BONUS,
  HYBRID_SCORING_POLICY_VERSION,
  rankHybridCandidateScores,
  rankHybridCandidates,
  scoringPolicyVersionFor,
  SEMANTIC_SIMILARITY_FLOOR,
  SEMANTIC_CONFIDENT_MARGIN,
  SEMANTIC_CONFIDENT_SCORE,
  SEMANTIC_CONFIDENT_SIMILARITY_FLOOR,
  SEMANTIC_LEXICAL_SUPPORT_FLOOR,
  LEXICAL_SEMANTIC_AGREEMENT_FLOOR,
  LEXICAL_SEMANTIC_AGREEMENT_MARGIN,
  SEMANTIC_SECONDARY_SCORE_CEILING,
  semanticScoreFor,
} from "../../src/domain/hybrid-ranking.js";
import type { CandidateScore } from "../../src/domain/query-scoring.js";
import { DEFAULT_SELECTION_THRESHOLDS } from "../../src/domain/selection-verdict.js";

function candidate(versionId: string, score: number): CandidateScore {
  return {
    cardId: `card_${versionId}`,
    versionId,
    score,
    signals: [],
  };
}

describe("semanticScoreFor", () => {
  it("is 0 at and below the floor", () => {
    expect(semanticScoreFor(SEMANTIC_SIMILARITY_FLOOR)).toBe(0);
    expect(semanticScoreFor(0)).toBe(0);
    expect(semanticScoreFor(-1)).toBe(0);
  });

  it("is 1 at a perfect similarity", () => {
    // The property that makes a semantic-only Card admissible at all: if the top
    // of the range fell short of the admit threshold, the semantic path could
    // rank Cards but never admit one.
    expect(semanticScoreFor(1)).toBe(1);
    expect(semanticScoreFor(1)).toBeGreaterThanOrEqual(
      DEFAULT_SELECTION_THRESHOLDS.admit,
    );
  });

  it("preserves the raw cosine above the calibrated floor", () => {
    const midpoint = SEMANTIC_SIMILARITY_FLOOR + (1 - SEMANTIC_SIMILARITY_FLOOR) / 2;

    expect(semanticScoreFor(midpoint)).toBeCloseTo(midpoint, 10);
  });

  it("treats a non-finite similarity as no evidence", () => {
    expect(semanticScoreFor(Number.NaN)).toBe(0);
    expect(semanticScoreFor(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe("combineHybridScore", () => {
  /**
   * The invariant every existing Card in the repository depends on.
   *
   * `query-scoring.ts` puts a declared-term match at or above 0.9, which is
   * above the 0.85 admit threshold by construction, and the whole split between
   * direct and indirect signals rests on it. An averaging rule would let a
   * mediocre cosine veto that, and switching embeddings on would demote Cards
   * that were admitted without them.
   */
  it("never demotes a Card below its lexical score", () => {
    for (const lexical of [0, 0.35, 0.5, 0.85, 0.9, 1]) {
      for (const semantic of [0, 0.2, 0.5, 1]) {
        expect(combineHybridScore(lexical, semantic)).toBeGreaterThanOrEqual(
          lexical,
        );
      }
    }
  });

  it("lets a Card with no lexical signal reach its semantic score", () => {
    expect(combineHybridScore(0, 1)).toBe(1);
    expect(combineHybridScore(0, 0.9)).toBe(0.9);
  });

  it("admits a semantic-only Card the lexical path rejects", () => {
    expect(combineHybridScore(0.1, 1)).toBeGreaterThanOrEqual(
      DEFAULT_SELECTION_THRESHOLDS.admit,
    );
  });

  it("does not turn two weak signals into an admission bonus", () => {
    const agreeing = combineHybridScore(0.6, 0.6);
    const oneSided = combineHybridScore(0.6, 0);

    expect(agreeing).toBeCloseTo(0.6 + HYBRID_AGREEMENT_BONUS * 0.6, 10);
    expect(agreeing).toBe(oneSided);
  });

  it("is symmetric in its two signals", () => {
    expect(combineHybridScore(0.3, 0.8)).toBe(combineHybridScore(0.8, 0.3));
  });

  it("stays inside [0, 1]", () => {
    expect(combineHybridScore(1, 1)).toBe(1);
    expect(combineHybridScore(2, 2)).toBe(1);
    expect(combineHybridScore(-1, -1)).toBe(0);
  });

  it("scores a non-finite input as no evidence rather than propagating it", () => {
    // A NaN reaching the verdict would make every comparison against it false
    // and the Card would land in defer as if it were merely ambiguous.
    expect(combineHybridScore(Number.NaN, 0.5)).toBe(0.5);
    expect(combineHybridScore(0.5, Number.NaN)).toBe(0.5);
  });
});

describe("rankHybridCandidates", () => {
  const lexical = [
    candidate("a", 0.9),
    candidate("b", 0.4),
    candidate("c", 0),
  ];

  it("credits a Card the semantic path reached", () => {
    const ranked = rankHybridCandidates({
      lexical,
      semantic: [{ cardId: "card_c", cardVersionId: "c", similarity: 1 }],
      lexicalTopK: 3,
    });

    expect(ranked.find((entry) => entry.versionId === "c")).toMatchObject({
      lexicalScore: 0,
      semanticSimilarity: 1,
      semanticScore: 1,
      score: 1,
    });
  });

  it("admits a clearly separated leading semantic candidate", () => {
    expect(SEMANTIC_CONFIDENT_SCORE).toBe(DEFAULT_SELECTION_THRESHOLDS.admit);
    const ranked = rankHybridCandidates({
      lexical: [candidate("a", 0), candidate("b", 0)],
      semantic: [
        {
          cardId: "card_a",
          cardVersionId: "a",
          similarity: SEMANTIC_CONFIDENT_SIMILARITY_FLOOR + 0.01,
        },
        {
          cardId: "card_b",
          cardVersionId: "b",
          similarity:
            SEMANTIC_CONFIDENT_SIMILARITY_FLOOR + 0.01 - SEMANTIC_CONFIDENT_MARGIN,
        },
      ],
      lexicalTopK: 2,
    });

    expect(
      ranked.find((entry) => entry.versionId === "a")?.score,
    ).toBeGreaterThanOrEqual(DEFAULT_SELECTION_THRESHOLDS.admit);
  });

  it("keeps every non-leading neighbour below reject", () => {
    const ranked = rankHybridCandidates({
      lexical: [candidate("a", 0), candidate("b", 0)],
      semantic: [
        { cardId: "card_a", cardVersionId: "a", similarity: 0.91 },
        { cardId: "card_b", cardVersionId: "b", similarity: 0.9 },
      ],
      lexicalTopK: 2,
    });

    expect(ranked.find((entry) => entry.versionId === "a")?.semanticScore).toBe(0.91);
    expect(ranked.find((entry) => entry.versionId === "b")?.semanticScore).toBe(
      SEMANTIC_SECONDARY_SCORE_CEILING,
    );
    expect(SEMANTIC_SECONDARY_SCORE_CEILING).toBeLessThan(
      DEFAULT_SELECTION_THRESHOLDS.reject,
    );
  });

  it("refuses a close semantic leader without lexical corroboration", () => {
    const ranked = rankHybridCandidates({
      lexical: [candidate("a", 0.2), candidate("b", 0.7)],
      semantic: [
        { cardId: "card_a", cardVersionId: "a", similarity: 0.86 },
        { cardId: "card_b", cardVersionId: "b", similarity: 0.855 },
      ],
      lexicalTopK: 2,
    });

    expect(ranked.find((entry) => entry.versionId === "a")?.semanticScore).toBe(
      SEMANTIC_SECONDARY_SCORE_CEILING,
    );
    expect(ranked.find((entry) => entry.versionId === "a")?.score).toBeLessThan(
      DEFAULT_SELECTION_THRESHOLDS.reject,
    );
  });

  it("lets stronger direct evidence override only a close semantic leader", () => {
    const ranked = rankHybridCandidates({
      lexical: [candidate("direct", 0.91), candidate("semantic", 0.84)],
      semantic: [
        { cardId: "card_semantic", cardVersionId: "semantic", similarity: 0.87 },
        { cardId: "card_direct", cardVersionId: "direct", similarity: 0.865 },
      ],
      lexicalTopK: 2,
    });

    expect(ranked.find((entry) => entry.versionId === "direct")).toMatchObject({
      score: 0.91,
      semanticScore: SEMANTIC_SECONDARY_SCORE_CEILING,
    });
    expect(ranked.find((entry) => entry.versionId === "semantic")).toMatchObject({
      score: 0.84,
      semanticScore: SEMANTIC_SECONDARY_SCORE_CEILING,
    });
  });

  it("keeps a close semantic leader when lexical evidence corroborates it", () => {
    const ranked = rankHybridCandidates({
      lexical: [
        candidate("a", SEMANTIC_LEXICAL_SUPPORT_FLOOR),
        candidate("b", 0.2),
      ],
      semantic: [
        { cardId: "card_a", cardVersionId: "a", similarity: 0.86 },
        { cardId: "card_b", cardVersionId: "b", similarity: 0.855 },
      ],
      lexicalTopK: 2,
    });

    expect(
      ranked.find((entry) => entry.versionId === "a")?.score,
    ).toBeGreaterThanOrEqual(DEFAULT_SELECTION_THRESHOLDS.admit);
  });

  it("recovers a unique lexical leader when both rankings nearly agree", () => {
    const ranked = rankHybridCandidates({
      lexical: [candidate("lexical", 0.84), candidate("semantic", 0.72)],
      semantic: [
        {
          cardId: "card_semantic",
          cardVersionId: "semantic",
          similarity: LEXICAL_SEMANTIC_AGREEMENT_FLOOR + 0.003,
        },
        {
          cardId: "card_lexical",
          cardVersionId: "lexical",
          similarity: LEXICAL_SEMANTIC_AGREEMENT_FLOOR,
        },
      ],
      lexicalTopK: 2,
    });

    expect(
      ranked.find((entry) => entry.versionId === "lexical")?.score,
    ).toBe(DEFAULT_SELECTION_THRESHOLDS.admit);
  });

  it("does not recover a lexical leader outside the rank-agreement margin", () => {
    const ranked = rankHybridCandidates({
      lexical: [candidate("lexical", 0.84), candidate("semantic", 0.72)],
      semantic: [
        {
          cardId: "card_semantic",
          cardVersionId: "semantic",
          similarity:
            LEXICAL_SEMANTIC_AGREEMENT_FLOOR +
            LEXICAL_SEMANTIC_AGREEMENT_MARGIN +
            0.001,
        },
        {
          cardId: "card_lexical",
          cardVersionId: "lexical",
          similarity: LEXICAL_SEMANTIC_AGREEMENT_FLOOR,
        },
      ],
      lexicalTopK: 2,
    });

    expect(
      ranked.find((entry) => entry.versionId === "lexical")?.score,
    ).toBeLessThan(DEFAULT_SELECTION_THRESHOLDS.admit);
  });

  it("leaves a Card outside both top-K sets on its lexical score alone", () => {
    const ranked = rankHybridCandidates({
      lexical,
      // The semantic path returned only "a", so "b" was retrieved by nobody.
      semantic: [{ cardId: "card_a", cardVersionId: "a", similarity: 1 }],
      lexicalTopK: 1,
    });
    const outsider = ranked.find((entry) => entry.versionId === "b");

    expect(outsider?.semanticSimilarity).toBeUndefined();
    expect(outsider?.score).toBe(0.4);
  });

  it("reuses an unchanged base candidate in the SelectionPlan projection", () => {
    const projected = rankHybridCandidateScores({
      lexical,
      semantic: [{ cardId: "card_a", cardVersionId: "a", similarity: 1 }],
      lexicalTopK: 1,
    });

    expect(projected[0]).not.toBe(lexical[0]);
    expect(projected[0]?.score).toBe(1);
    expect(projected[1]).toBe(lexical[1]);
    expect(projected[2]).toBe(lexical[2]);
  });

  it("returns every scored Card, union or not", () => {
    const ranked = rankHybridCandidates({
      lexical,
      semantic: [],
      lexicalTopK: 1,
    });

    // Dropping the rest would change what `counts.rejected` means.
    expect(ranked.map((entry) => entry.versionId)).toEqual(["a", "b", "c"]);
  });

  it("keeps the caller's order rather than re-ranking", () => {
    // Ranking belongs to `judgeCandidates`, which sorts and breaks ties itself.
    // A second ordering here could disagree with the one the policy names.
    const ranked = rankHybridCandidates({
      lexical,
      semantic: [{ cardId: "card_c", cardVersionId: "c", similarity: 1 }],
      lexicalTopK: 3,
    });

    expect(ranked.map((entry) => entry.versionId)).toEqual(["a", "b", "c"]);
  });

  it("carries the lexical signals across unchanged", () => {
    const withSignal: CandidateScore = {
      cardId: "card_a",
      versionId: "a",
      score: 0.9,
      signals: [{ field: "keyword", matched: "환불", contribution: 0.9 }],
    };
    const [ranked] = rankHybridCandidates({
      lexical: [withSignal],
      semantic: [],
      lexicalTopK: 1,
    });

    expect(ranked?.signals).toEqual(withSignal.signals);
  });

  it("takes only lexicalTopK Cards into the union", () => {
    const ranked = rankHybridCandidates({
      lexical,
      semantic: [],
      lexicalTopK: 0,
    });

    // Nothing was retrieved by either path, so nothing is credited — every Card
    // keeps exactly its lexical score.
    expect(ranked.map((entry) => entry.score)).toEqual([0.9, 0.4, 0]);
  });
});

describe("the mode and scoring pairing", () => {
  it("pairs each mode with exactly one scoring family", () => {
    expect(scoringPolicyVersionFor("hybrid")).toBe(
      HYBRID_SCORING_POLICY_VERSION,
    );
    expect(scoringPolicyVersionFor("lexical_degraded")).toBe(
      "selection-lexical-v4",
    );
  });

  it("accepts the two valid pairs", () => {
    expect(() =>
      assertSelectionScoringPairing("hybrid", "selection-hybrid-v4"),
    ).not.toThrow();
    expect(() =>
      assertSelectionScoringPairing("lexical_degraded", "selection-lexical-v4"),
    ).not.toThrow();
  });

  it("refuses every other combination", () => {
    expect(() =>
      assertSelectionScoringPairing("hybrid", "selection-lexical-v4"),
    ).toThrow(SelectionModeInvariantError);
    expect(() =>
      assertSelectionScoringPairing("lexical_degraded", "selection-hybrid-v4"),
    ).toThrow(SelectionModeInvariantError);
    expect(() =>
      assertSelectionScoringPairing("hybrid", "selection-hybrid-v1"),
    ).toThrow(SelectionModeInvariantError);
  });
});
