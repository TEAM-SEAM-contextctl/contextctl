import { performance } from "node:perf_hooks";

import { describe, expect, it } from "vitest";

import { scoreCardsAgainstQuery } from "../../src/domain/query-scoring.js";
import { evaluateSelection, assertSelectionEvalDataset } from "../fixtures/selection-eval.js";
import {
  SELECTION_EVAL_CARDS,
  SELECTION_EVAL_DATASET_DIGEST,
  SELECTION_EVAL_SPLIT_DIGEST,
} from "../fixtures/selection-eval-v1.js";

describe("selection-eval-v1", () => {
  it("freezes the required corpus shape and deterministic split", () => {
    expect(assertSelectionEvalDataset).not.toThrow();
    expect(SELECTION_EVAL_DATASET_DIGEST).toBe("sha256:d1fadb87cd55331e8f1fc9855ed171ad46758d13647bbc32b432aa7879e33cb4");
    expect(SELECTION_EVAL_SPLIT_DIGEST).toBe("sha256:3ab829dc857adf5f0b7f06df27f7113b6348227b887e1f1e7b8b7f9ec89efcdb");
  });

  it("records the lexical-v2 release baseline over all 50 fixed queries", async () => {
    const report = await evaluateSelection(async (query) => {
      const started = performance.now();
      const candidates = scoreCardsAgainstQuery(query, SELECTION_EVAL_CARDS);
      return { candidates, elapsedMs: performance.now() - started, embeddingCalls: 0 };
    });

    expect(report.cases.filter((entry) => entry.forbiddenAdmits.length > 0)).toEqual([]);
    expect({ ...report.holdout, p95LatencyMs: 0 }).toEqual({
      queryCount: 20,
      requiredRecallAt5: 1,
      admittedRequiredRecall: 0.9047619047619048,
      multiFullSetRecall: 0.8333333333333334,
      verdictMacroF1: 0.9514687100893998,
      ambiguousAdmitDeferMacroF1: 0.9,
      unrelatedFalseAdmitRate: 0,
      forbiddenAdmits: 0,
      averageCandidateCount: 15,
      p95LatencyMs: 0,
      embeddingCalls: 0,
      maxEmbeddingCallsPerQuery: 0,
    });
    expect(report.calibration.queryCount).toBe(30);
    expect(report.holdout.queryCount).toBe(20);
    expect(report.all.queryCount).toBe(50);
    expect(report.holdout.maxEmbeddingCallsPerQuery).toBe(0);
    expect(report.holdout.forbiddenAdmits).toBe(0);
    expect(report.holdout.requiredRecallAt5).toBeGreaterThanOrEqual(0.9);
    expect(report.holdout.admittedRequiredRecall).toBeGreaterThanOrEqual(0.8);
    expect(report.holdout.multiFullSetRecall).toBeGreaterThanOrEqual(0.75);
    expect(report.holdout.unrelatedFalseAdmitRate).toBeLessThanOrEqual(0.1);
  });
});
