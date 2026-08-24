import { describe, expect, it } from "vitest";

import type { ApprovedCard } from "../../src/domain/card-catalog.js";
import {
  assertUsableDataset,
  loadRegressionCards,
  loadRegressionQueries,
  median,
  REGRESSION_CATEGORIES,
  scoreRegression,
  toApprovedCards,
  type RegressionCardSet,
  type RegressionQuery,
  type RegressionQuerySet,
} from "../fixtures/card-selection-regression.js";

/** A Card whose only vocabulary is the keywords given. */
function card(label: string, keywords: readonly string[]): ApprovedCard {
  return {
    cardId: label,
    versionId: `${label}@v1`,
    meaning: { description: "", representativeQuestions: [], aliases: [], keywords },
    policy: { sensitive: false, allowedUsage: ["retrieval"] },
    scopes: [
      {
        kind: "managed_document",
        reference: { scopeId: `scope_${label}`, scopeVersion: "1" },
        documentIndex: { documentIndexId: "d", sourceId: "s", documentId: "doc", indexVersion: "1" },
        selection: { kind: "document" },
      },
    ],
  };
}

function query(
  id: string,
  text: string,
  required: readonly string[],
  forbidden: readonly string[] = [],
  extra: Partial<RegressionQuery> = {},
): RegressionQuery {
  return {
    id,
    category: "adjacent_wrong_section",
    text,
    required,
    optional: [],
    forbidden,
    note: "",
    ...extra,
  };
}

describe("scoreRegression", () => {
  const cards = [
    card("doc/§a", ["환불", "환불 승인 정책", "긴급"]),
    card("doc/§b", ["환불", "환불 승인 정책", "결제"]),
    card("doc/§c", ["연차", "연차 이월 정책"]),
  ];

  it("counts top-1, wrong and forbidden admits, and the margin", () => {
    const report = scoreRegression(cards, [
      query("q1", "긴급 환불 승인 정책", ["doc/§a"], ["doc/§b"]),
    ]);
    const [result] = report.queries;

    // Both refund Cards have enough contextual evidence to admit. §a also
    // declares the distinctive term "긴급", so it ranks first.
    expect(result?.top1).toBe("doc/§a");
    expect(result?.top1Correct).toBe(true);
    expect([...(result?.admitted ?? [])].sort()).toEqual(["doc/§a", "doc/§b"]);
    expect(result?.wrongAdmits).toEqual(["doc/§b"]);
    expect(result?.forbiddenAdmits).toEqual(["doc/§b"]);
    expect(result?.margin).toBeGreaterThan(0);
    expect(result?.margin).toBeLessThan(0.1);
    expect(report.metrics.wrongAdmitRatio).toBe(0.5);
    expect(report.metrics.forbiddenAdmits).toBe(1);
    expect(report.metrics.top1Accuracy).toBe(1);
  });

  it("does not count an optional Card as wrong", () => {
    const report = scoreRegression(cards, [
      query("q1", "긴급 환불 승인 정책", ["doc/§a"], [], { optional: ["doc/§b"] }),
    ]);

    expect(report.metrics.wrongAdmits).toBe(0);
    expect(report.metrics.forbiddenAdmits).toBe(0);
  });

  it("treats a no-answer query as correct only when nothing is admitted", () => {
    const quiet = scoreRegression(cards, [
      query("q1", "점심 메뉴", [], [], { category: "no_answer_or_low_confidence", confidence: "none" }),
    ]);
    const noisy = scoreRegression(cards, [
      query("q2", "연차 이월 정책", [], [], { category: "no_answer_or_low_confidence", confidence: "none" }),
    ]);

    expect(quiet.metrics.top1Correct).toBe(1);
    expect(noisy.metrics.top1Correct).toBe(0);
    expect(noisy.metrics.wrongAdmits).toBe(1);
    // No margin is read off a query that expected no answer.
    expect(quiet.metrics.marginMedian).toBeNull();
    expect(noisy.metrics.marginMedian).toBeNull();
  });

  it("measures full-set recall only over multi-Card queries", () => {
    const report = scoreRegression(cards, [
      query("m1", "긴급 환불 승인 정책과 연차 이월 정책", ["doc/§a", "doc/§c"], [], { category: "multiple_cards_required" }),
      query("m2", "환불 승인 정책과 결제", ["doc/§a", "doc/§b"], [], { category: "multiple_cards_required" }),
      query("s1", "연차 이월 정책", ["doc/§c"]),
    ]);

    expect(report.metrics.multiQueryCount).toBe(2);
    expect(report.metrics.fullSetRecall).toBe(1);
    expect(report.byCategory.adjacent_wrong_section.fullSetRecall).toBeNull();
  });

  it("folds every (Card, query) pair into the verdict ratios", () => {
    const report = scoreRegression(cards, [query("q1", "환불", ["doc/§a"]), query("q2", "점심", [])]);

    expect(report.metrics.pairCount).toBe(6);
    expect(
      report.metrics.admitRatio + report.metrics.deferRatio + report.metrics.rejectRatio,
    ).toBeCloseTo(1);
  });

  it("reports every category even when it holds no query", () => {
    const report = scoreRegression(cards, [query("q1", "환불", ["doc/§a"])]);

    for (const category of REGRESSION_CATEGORIES) {
      expect(report.byCategory[category]).toBeDefined();
    }
    expect(report.byCategory.body_vocabulary.queryCount).toBe(0);
    expect(report.byCategory.body_vocabulary.wrongAdmitRatio).toBeNull();
  });

  it("is a pure function of its inputs", () => {
    const queries = [query("q1", "환불", ["doc/§a"], ["doc/§b"])];

    expect(scoreRegression(cards, queries)).toEqual(scoreRegression(cards, queries));
  });
});

describe("median", () => {
  it("takes the middle of an odd list and the mean of the two middles of an even one", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });
});

describe("assertUsableDataset", () => {
  const baseCards = (): RegressionCardSet => ({
    datasetId: "t",
    version: "1",
    generator: "deterministic",
    generatorDetail: "",
    sourceCommit: "",
    generatedAt: "",
    documents: [],
    digest: "sha256:x",
    cards: ["doc/§a", "doc/§b"].map((label) => ({
      label,
      cardId: label,
      versionId: `${label}@v1`,
      meaning: { description: "", representativeQuestions: [], aliases: [], keywords: [] },
      policy: { sensitive: false, allowedUsage: ["retrieval"] },
      scope: { documentId: "doc", semanticUnitId: label },
    })),
  });
  const fullQueries = (overrides: Partial<RegressionQuery>[] = []): RegressionQuerySet => {
    const queries: RegressionQuery[] = [];
    for (let index = 0; index < 25; index += 1) {
      const category = REGRESSION_CATEGORIES[index % 5] as RegressionQuery["category"];
      const base: RegressionQuery = {
        id: `q${index}`,
        category,
        text: "x",
        required: category === "multiple_cards_required" ? ["doc/§a", "doc/§b"] : ["doc/§a"],
        optional: [],
        forbidden: [],
        note: "",
        ...(category === "no_answer_or_low_confidence" ? { confidence: "low" as const } : {}),
      };
      queries.push({ ...base, ...(overrides[index] ?? {}) });
    }
    return { datasetId: "t", version: "1", queries, digest: "sha256:y" };
  };

  it("accepts a complete set", () => {
    expect(() => assertUsableDataset(baseCards(), fullQueries())).not.toThrow();
  });

  it("refuses fewer than 25 queries", () => {
    const queries = fullQueries();
    expect(() =>
      assertUsableDataset(baseCards(), { ...queries, queries: queries.queries.slice(0, 24) }),
    ).toThrow(/fewer than 25/);
  });

  it("refuses a dangling reference on any side", () => {
    expect(() =>
      assertUsableDataset(baseCards(), fullQueries([{ required: ["doc/§zzz"] }])),
    ).toThrow(/unknown Card/);
    expect(() =>
      assertUsableDataset(baseCards(), fullQueries([{ forbidden: ["doc/§zzz"] }])),
    ).toThrow(/unknown Card/);
  });

  it("refuses a Card on two sides of one query", () => {
    expect(() =>
      assertUsableDataset(baseCards(), fullQueries([{ forbidden: ["doc/§a"] }])),
    ).toThrow(/two sides/);
  });

  it("refuses an empty category and a duplicate id", () => {
    const queries = fullQueries();
    const noBody = queries.queries.map((query) =>
      query.category === "body_vocabulary" ? { ...query, category: "adjacent_wrong_section" as const } : query,
    );
    expect(() => assertUsableDataset(baseCards(), { ...queries, queries: noBody })).toThrow(
      /body_vocabulary has no query/,
    );
    expect(() => assertUsableDataset(baseCards(), fullQueries([{ id: "q1" }]))).toThrow(
      /duplicate query id/,
    );
  });

  it("refuses a no-answer query that claims an answer", () => {
    expect(() =>
      assertUsableDataset(
        baseCards(),
        fullQueries([{}, {}, {}, { confidence: "none", required: ["doc/§a"] }]),
      ),
    ).toThrow(/confidence none/);
  });
});

describe("the committed dataset", () => {
  it("is usable, for both generators, and maps onto ApprovedCards", async () => {
    const queries = await loadRegressionQueries();
    for (const generator of ["llm", "deterministic"] as const) {
      const cards = await loadRegressionCards(generator);
      expect(() => assertUsableDataset(cards, queries)).not.toThrow();
      expect(cards.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(toApprovedCards(cards)).toHaveLength(12);
    }
    expect(queries.queries).toHaveLength(25);
  });
});
