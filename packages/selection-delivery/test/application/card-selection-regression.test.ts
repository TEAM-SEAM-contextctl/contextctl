import { beforeAll, describe, expect, it } from "vitest";

import { QUERY_SCORING_POLICY_VERSION } from "../../src/domain/query-scoring.js";
import {
  DEFAULT_SELECTION_THRESHOLDS,
  SELECTION_RANKING_POLICY_VERSION,
} from "../../src/domain/selection-verdict.js";
import {
  assertUsableDataset,
  loadRegressionBaseline,
  loadRegressionCards,
  loadRegressionQueries,
  scoreRegression,
  toApprovedCards,
  type RegressionBaseline,
  type RegressionGenerator,
  type RegressionReport,
} from "../fixtures/card-selection-regression.js";

/**
 * The SEAM-100 regression set, read in three tiers (SEAM-106 §6.2).
 *
 * 1. Invariant gates — properties that must hold whatever the scorer becomes.
 *    They pass today and a failure is a genuine regression.
 * 2. Baseline non-regression — the numbers in `baseline.json`, pinned to the
 *    policy versions and thresholds they were measured under. Changing a
 *    threshold without changing the version fails here first (SOT L794; §6.2:
 *    an input-side defect is not to be hidden by moving a threshold).
 * 3. Quality gates — the design's criteria that lexical v3 now meets. These
 *    stay as ordinary assertions so a later scorer cannot restore v1's broad
 *    substring admission or collapse the defer band.
 *
 * Lexical path only. The hybrid path needs the installed model and is outside
 * `npm test`; see the dataset README.
 */

const GENERATORS: readonly RegressionGenerator[] = ["llm", "deterministic"];
const UNRELATED_QUERY_IDS = ["none-01", "none-02", "none-03"] as const;

/** Invariant gate values. Not tuned to the baseline; see each assertion. */
const BODY_VOCABULARY_TOP1_FLOOR = 4 / 5;
const FULL_SET_RECALL_FLOOR = 4 / 5;
const ADMIT_RATIO_CEILING = 0.25;

/** Design targets, SOT L1452. */
const TARGET_WRONG_ADMIT_RATIO = 0.1;

describe.each(GENERATORS)("card-selection-regression-v1 · %s snapshot", (generator) => {
  let report: RegressionReport;
  let baseline: RegressionBaseline;
  let cardsDigest: string;
  let queriesDigest: string;

  beforeAll(async () => {
    const [cards, queries] = await Promise.all([
      loadRegressionCards(generator),
      loadRegressionQueries(),
    ]);
    assertUsableDataset(cards, queries);
    cardsDigest = cards.digest;
    queriesDigest = queries.digest;
    baseline = await loadRegressionBaseline();
    report = scoreRegression(toApprovedCards(cards), queries.queries);
  });

  describe("invariant gates", () => {
    it("admits nothing for a query no Card can answer", () => {
      // The product's own claim (README: an unrelated query returns nothing)
      // and the one gate that does not depend on which section of a document
      // the scorer prefers.
      for (const id of UNRELATED_QUERY_IDS) {
        const result = report.queries.find((each) => each.id === id);
        expect(result, id).toBeDefined();
        expect(result?.admitted, `${id}: ${result?.text}`).toEqual([]);
      }
    });

    it("ranks the right Card first for body-vocabulary queries", () => {
      // Words that live only in the section body reach the Card through
      // `keywords.derived` (SEAM-99). Losing this would mean the scorer no
      // longer reads the vocabulary Ingestion publishes for exactly this.
      const { top1Correct, queryCount } = report.byCategory.body_vocabulary;
      expect(queryCount).toBe(5);
      expect(top1Correct / queryCount).toBeGreaterThanOrEqual(BODY_VOCABULARY_TOP1_FLOOR);
    });

    it("admits the whole required set for multi-Card queries", () => {
      // Full-set recall: a query that needs two sections gets both. The
      // lexical scorer over-admits rather than under-admits, so this holds
      // today at 5/5; a change that tightens admission must not drop a
      // required Card to lose a wrong one.
      const { fullSetRecall, multiQueryCount } = report.byCategory.multiple_cards_required;
      expect(multiQueryCount).toBe(5);
      expect(fullSetRecall).not.toBeNull();
      expect(fullSetRecall as number).toBeGreaterThanOrEqual(FULL_SET_RECALL_FLOOR);
    });

    it("keeps the admitted share of all (Card, query) pairs under a ceiling", () => {
      // A ceiling on over-admission as a whole: today one pair in five is
      // admitted (LLM 0.193, deterministic 0.210), and most of those are
      // wrong. A scorer that admits more than a quarter of every pairing
      // has widened what a query may reach, whatever else it improved.
      expect(report.metrics.admitRatio).toBeLessThanOrEqual(ADMIT_RATIO_CEILING);
    });
  });

  describe("baseline non-regression", () => {
    it("is measured under the policy versions and thresholds the baseline records", () => {
      // Checked before any number is compared. A baseline measured under one
      // threshold band says nothing about a scorer running under another, and
      // a threshold moved without a version bump is exactly the change SOT
      // L794 forbids and SEAM-106 §6.2 warns against: it would hide the
      // input-side defect behind a number that merely looks better.
      expect(QUERY_SCORING_POLICY_VERSION).toBe(baseline.scoringPolicyVersion);
      expect(SELECTION_RANKING_POLICY_VERSION).toBe(baseline.rankingPolicyVersion);
      expect(DEFAULT_SELECTION_THRESHOLDS).toEqual(baseline.thresholds);
      // And over the same bytes: a dataset edit without a re-measure would
      // compare a new set against an old record.
      expect(cardsDigest).toBe(baseline.snapshots[generator].cardsDigest);
      expect(queriesDigest).toBe(baseline.snapshots[generator].queriesDigest);
    });

    it("does not rank the right Card first less often than the baseline", () => {
      expect(report.metrics.top1Accuracy).toBeGreaterThanOrEqual(
        baseline.snapshots[generator].metrics.top1Accuracy,
      );
    });

    it("does not admit a larger share of wrong Cards than the baseline", () => {
      const recorded = baseline.snapshots[generator].metrics.wrongAdmitRatio;
      expect(recorded).not.toBeNull();
      expect(report.metrics.wrongAdmitRatio).not.toBeNull();
      expect(report.metrics.wrongAdmitRatio as number).toBeLessThanOrEqual(recorded as number);
    });

    it("reproduces the recorded v3 baseline exactly", () => {
      expect(report.metrics).toEqual(baseline.snapshots[generator].metrics);
      expect(report.byCategory).toEqual(baseline.snapshots[generator].byCategory);
    });
  });

  describe("lexical v3 quality gates", () => {
    it("admits no forbidden Card (SOT L1452: 금지된 Card 수용 0)", () => {
      expect(report.metrics.forbiddenAdmits).toBe(0);
    });

    it("keeps the share of wrong admits at or under 0.10 (SOT L1452)", () => {
      expect(report.metrics.wrongAdmitRatio).not.toBeNull();
      expect(report.metrics.wrongAdmitRatio as number).toBeLessThanOrEqual(
        TARGET_WRONG_ADMIT_RATIO,
      );
    });

    it("places ambiguous evidence in the defer band", () => {
      expect(report.metrics.deferRatio).toBeGreaterThan(0);
    });
  });
});
