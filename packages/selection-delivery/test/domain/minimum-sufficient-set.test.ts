import { describe, expect, it } from "vitest";

import type {
  ApprovedCard,
  ApprovedManagedDocumentScope,
} from "../../src/domain/card-catalog.js";
import { planMinimumSufficientCardSet } from "../../src/domain/minimum-sufficient-set.js";
import {
  measureCardRemovalSavings,
  measurePlanCost,
  subtractPlanCost,
} from "../../src/domain/minimum-set-plan-cost.js";
import {
  scoreCardSubsetAgainstQuery,
  scoreCardsAgainstQuery,
} from "../../src/domain/query-scoring.js";
import { judgeCandidates } from "../../src/domain/selection-verdict.js";

function scope(scopeId: string): ApprovedManagedDocumentScope {
  return {
    kind: "managed_document",
    reference: { scopeId, scopeVersion: "scopev_0001" },
    documentIndex: {
      documentIndexId: `docidx_${scopeId}`,
      sourceId: "src_docs",
      documentId: `doc_${scopeId}`,
      indexVersion: "idxv_0001",
    },
    selection: { kind: "document" },
  };
}

function card(
  suffix: string,
  keywords: readonly string[],
  scopeId = `scope_${suffix}`,
): ApprovedCard {
  return {
    cardId: `card_${suffix}`,
    versionId: `cardv_${suffix}`,
    meaning: {
      description: keywords.join(" "),
      representativeQuestions: [],
      aliases: [],
      keywords,
    },
    policy: { sensitive: false, allowedUsage: ["retrieval"] },
    scopes: [scope(scopeId)],
  };
}

function plan(
  query: string,
  cards: readonly ApprovedCard[],
  mode: "hybrid" | "lexical_degraded" = "lexical_degraded",
  scores: readonly number[] = cards.map(() => 0.95),
) {
  const rankedScores = cards.map((entry, index) => ({
    cardId: entry.cardId,
    versionId: entry.versionId,
    score: scores[index] ?? 0,
    signals: [],
  }));
  return planMinimumSufficientCardSet({
    query,
    eligibleCards: cards,
    lexicalScores: scoreCardsAgainstQuery(query, cards),
    rankedScores,
    initialSelection: judgeCandidates(rankedScores),
    mode,
    chunkLimitPerScope: 8,
  });
}

describe("minimum-sufficient-set-v1", () => {
  it("derives exact one-Card removal costs from one merged plan", () => {
    const first = card("first", ["refund delivery"], "scope_shared");
    const second = card("second", ["refund"], "scope_shared");
    const third = card("third", ["delivery"], "scope_unique");
    const cards = [first, second, third];
    const current = measurePlanCost(cards, 8);
    const savings = measureCardRemovalSavings(cards, 8);

    for (const candidate of cards) {
      const measured = measurePlanCost(
        cards.filter((entry) => entry.versionId !== candidate.versionId),
        8,
      );
      expect(
        subtractPlanCost(current, savings.get(candidate.versionId)!),
      ).toEqual(measured);
    }
  });

  it("scores strong subsets with the complete catalog statistics", () => {
    const first = card("first", ["refund delivery"]);
    const second = card("second", ["refund"]);
    const unrelated = card("unrelated", ["astronomy telescope"]);
    const catalog = [first, second, unrelated];
    const complete = scoreCardsAgainstQuery("refund delivery", catalog);

    expect(
      scoreCardSubsetAgainstQuery("refund delivery", catalog, [second, first]),
    ).toEqual([
      complete.find((score) => score.versionId === second.versionId),
      complete.find((score) => score.versionId === first.versionId),
    ]);
  });

  it("removes a lower-support Card only when that removes a real read", () => {
    const broad = card("broad", ["refund delivery"]);
    const narrow = card("narrow", ["refund"]);

    const result = plan("refund delivery", [broad, narrow]);

    expect(result.selectedCards.map((entry) => entry.versionId)).toEqual([
      broad.versionId,
    ]);
    expect(result.audit.costBefore.managedTargetCount).toBe(2);
    expect(result.audit.costAfter.managedTargetCount).toBe(1);
    expect(result.audit.decisions).toContainEqual(
      expect.objectContaining({
        versionId: narrow.versionId,
        decision: "not_planned",
        reason: "covered_by_selected_set",
      }),
    );
  });

  it("protects query-indistinguishable Cards that lead to different reads", () => {
    const first = card("first", ["refund delivery"]);
    const second = card("second", ["refund delivery"]);

    const result = plan("refund delivery", [first, second]);

    expect(result.selectedCards).toHaveLength(2);
    expect(result.audit.decisions.every(
      (decision) =>
        decision.decision === "protected" &&
        decision.reason === "complementarity_unknown",
    )).toBe(true);
  });

  it("keeps shared-Scope attribution when removing a Card saves no read", () => {
    const first = card("first", ["refund delivery"], "scope_shared");
    const second = card("second", ["refund"], "scope_shared");

    const result = plan("refund delivery", [first, second]);

    expect(result.selectedCards).toHaveLength(2);
    expect(result.audit.costBefore.managedTargetCount).toBe(1);
    expect(result.audit.costAfter).toEqual(result.audit.costBefore);
    expect(result.audit.decisions).toContainEqual(
      expect.objectContaining({
        versionId: second.versionId,
        decision: "selected",
        reason: "no_execution_saving",
      }),
    );
  });

  it("preserves the strongest support for every explicit facet", () => {
    const refund = card("refund", ["refund"]);
    const delivery = card("delivery", ["delivery"]);

    const result = plan("refund and delivery", [refund, delivery]);

    expect(result.audit.facets).toHaveLength(2);
    expect(result.selectedCards).toHaveLength(2);
    expect(result.audit.baselineCoverage).toEqual(
      result.audit.selectedCoverage,
    );
  });

  it("protects a Card admitted only by semantic evidence", () => {
    const lexical = card("lexical", ["refund delivery"]);
    const semantic = card("semantic", ["unrelated phrase"]);

    const result = plan(
      "refund delivery",
      [lexical, semantic],
      "hybrid",
      [0.95, 0.9],
    );

    expect(result.selectedCards.map((entry) => entry.versionId)).toContain(
      semantic.versionId,
    );
    expect(result.audit.decisions).toContainEqual(
      expect.objectContaining({
        versionId: semantic.versionId,
        decision: "protected",
        reason: "semantic_only_evidence",
      }),
    );
  });

  it("produces the same result for the same inputs", () => {
    const cards = [
      card("broad", ["refund delivery"]),
      card("narrow", ["refund"]),
    ];

    expect(plan("refund delivery", cards)).toEqual(
      plan("refund delivery", cards),
    );
  });

  it("produces the same selected set and audit for reversed catalog input", () => {
    const cards = [
      card("broad", ["refund delivery"]),
      card("narrow", ["refund"]),
      card("delivery", ["delivery"]),
    ];

    const forward = plan("refund delivery", cards);
    const reverse = plan("refund delivery", [...cards].reverse());

    expect(reverse).toEqual(forward);
    expect(forward.audit.auditDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
  });

  it("keeps every strong Card when the query cannot be safely decomposed", () => {
    const cards = [
      card("one", ["refund"]),
      card("two", ["delivery"]),
    ];

    const result = plan('refund and "delivery', cards);

    expect(result.audit.ambiguous).toBe(true);
    expect(result.audit.removalCount).toBe(0);
    expect(result.selectedCards).toHaveLength(2);
    expect(
      result.audit.decisions.every(
        (decision) =>
          decision.decision === "protected" &&
          decision.reason === "ambiguous_query",
      ),
    ).toBe(true);
  });

  it("refuses an input snapshot that repeats a Card Version", () => {
    const repeated = card("repeated", ["refund delivery"]);
    const rankedScores = [
      {
        cardId: repeated.cardId,
        versionId: repeated.versionId,
        score: 0.95,
        signals: [],
      },
    ];

    expect(() =>
      planMinimumSufficientCardSet({
        query: "refund delivery",
        eligibleCards: [repeated, repeated],
        lexicalScores: scoreCardsAgainstQuery("refund delivery", [repeated]),
        rankedScores,
        initialSelection: judgeCandidates(rankedScores),
        mode: "lexical_degraded",
        chunkLimitPerScope: 8,
      }),
    ).toThrow(/repeats card version/);
  });

  it("refuses an empty query even when candidates were supplied", () => {
    expect(() => plan(" ", [card("one", ["refund"])])).toThrow(
      /non-empty query/,
    );
  });
});
