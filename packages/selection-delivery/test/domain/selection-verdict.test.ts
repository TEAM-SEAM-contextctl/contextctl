import { describe, expect, it } from "vitest";

import {
  SelectionCandidateInvariantError,
  SelectionThresholdsInvariantError,
} from "../../src/domain/errors.js";
import {
  applySetPlanningDecision,
  DEFAULT_SELECTION_THRESHOLDS,
  judgeCandidates,
  SELECTION_RANKING_POLICY_VERSION,
  type ScoredCandidate,
  type SelectionOutcome,
  type SelectionThresholds,
} from "../../src/domain/selection-verdict.js";

const thresholds: SelectionThresholds = { admit: 0.8, reject: 0.2 };

function candidate(versionId: string, score: number): ScoredCandidate {
  return { cardId: `card_${versionId}`, versionId, score };
}

function verdicts(candidates: readonly ScoredCandidate[]): string[] {
  return judgeCandidates(candidates, thresholds).outcomes.map(
    (outcome) => outcome.verdict,
  );
}

function rulesOf(outcome: SelectionOutcome): string[] {
  return "findings" in outcome
    ? outcome.findings.map((finding) => finding.rule)
    : [];
}

describe("judgeCandidates", () => {
  it("admits a score that sits exactly on the admit threshold", () => {
    expect(verdicts([candidate("cv_1", 0.8)])).toEqual(["admit"]);
  });

  it("rejects a score that sits exactly on the reject threshold", () => {
    expect(verdicts([candidate("cv_1", 0.2)])).toEqual(["reject"]);
  });

  it("defers a score between the two thresholds", () => {
    expect(verdicts([candidate("cv_1", 0.5)])).toEqual(["defer"]);
  });

  it("defers a score just under the admit threshold", () => {
    expect(verdicts([candidate("cv_1", 0.79)])).toEqual(["defer"]);
  });

  it("defers a score just over the reject threshold", () => {
    expect(verdicts([candidate("cv_1", 0.21)])).toEqual(["defer"]);
  });

  it("returns no outcomes for an empty candidate list", () => {
    const result = judgeCandidates([], thresholds);

    expect(result.outcomes).toEqual([]);
    expect(result.provenance.consideredCount).toBe(0);
    expect(result.provenance.ranked).toEqual([]);
  });

  it("rejects every candidate when all scores are at or below reject", () => {
    expect(
      verdicts([
        candidate("cv_1", 0.2),
        candidate("cv_2", 0.05),
        candidate("cv_3", 0),
      ]),
    ).toEqual(["reject", "reject", "reject"]);
  });

  it("admits every candidate when all scores are at or above admit", () => {
    expect(
      verdicts([
        candidate("cv_1", 0.8),
        candidate("cv_2", 0.95),
        candidate("cv_3", 1),
      ]),
    ).toEqual(["admit", "admit", "admit"]);
  });

  it("breaks a two-way score tie by ascending versionId", () => {
    const result = judgeCandidates(
      [candidate("cv_b", 0.9), candidate("cv_a", 0.9)],
      thresholds,
    );

    expect(result.outcomes.map((outcome) => outcome.versionId)).toEqual([
      "cv_a",
      "cv_b",
    ]);
  });

  it("orders three tied candidates identically for any input order", () => {
    const expected = ["cv_a", "cv_b", "cv_c"];
    const permutations: readonly (readonly ScoredCandidate[])[] = [
      [candidate("cv_a", 0.9), candidate("cv_b", 0.9), candidate("cv_c", 0.9)],
      [candidate("cv_c", 0.9), candidate("cv_b", 0.9), candidate("cv_a", 0.9)],
      [candidate("cv_b", 0.9), candidate("cv_c", 0.9), candidate("cv_a", 0.9)],
      [candidate("cv_c", 0.9), candidate("cv_a", 0.9), candidate("cv_b", 0.9)],
    ];

    for (const permutation of permutations) {
      const result = judgeCandidates(permutation, thresholds);
      expect(result.outcomes.map((outcome) => outcome.versionId)).toEqual(
        expected,
      );
      expect(result.provenance.ranked.map((entry) => entry.versionId)).toEqual(
        expected,
      );
    }
  });

  it("omits the findings field entirely on an admitted candidate", () => {
    const outcome = judgeCandidates(
      [candidate("cv_1", 0.9)],
      thresholds,
    ).outcomes.at(0);

    expect(outcome?.verdict).toBe("admit");
    expect(outcome !== undefined && "findings" in outcome).toBe(false);
  });

  it("names the rule that produced a defer or a reject", () => {
    const outcomes = judgeCandidates(
      [candidate("cv_1", 0.5), candidate("cv_2", 0.1)],
      thresholds,
    ).outcomes;

    expect(outcomes.map(rulesOf)).toEqual([
      ["score.below.admit"],
      ["score.at.or.below.reject"],
    ]);
  });

  it("puts the score and the threshold into the finding message", () => {
    const outcome = judgeCandidates(
      [candidate("cv_1", 0.5)],
      thresholds,
    ).outcomes.at(0);
    const message =
      outcome !== undefined && "findings" in outcome
        ? (outcome.findings.at(0)?.message ?? "")
        : "";

    expect(message).toContain("0.5");
    expect(message).toContain("0.8");
  });

  it("does not allocate finding caches for an ordinary small catalog", () => {
    const outcomes = judgeCandidates(
      [candidate("cv_1", 0.1), candidate("cv_2", 0.1)],
      thresholds,
    ).outcomes;
    const first = outcomes[0];
    const second = outcomes[1];

    expect(first !== undefined && "findings" in first).toBe(true);
    expect(second !== undefined && "findings" in second).toBe(true);
    if (
      first === undefined ||
      second === undefined ||
      !("findings" in first) ||
      !("findings" in second)
    ) {
      throw new Error("fixtures must be rejected");
    }
    expect(first.findings).not.toBe(second.findings);
  });

  it("shares identical finding values across a large catalog judgement", () => {
    const outcomes = judgeCandidates(
      Array.from({ length: 128 }, (_, index) =>
        candidate(`cv_${index}`, 0.1),
      ),
      thresholds,
    ).outcomes;
    const first = outcomes[0];
    const last = outcomes.at(-1);

    if (
      first === undefined ||
      last === undefined ||
      !("findings" in first) ||
      !("findings" in last)
    ) {
      throw new Error("fixtures must be rejected");
    }
    expect(first.findings).toBe(last.findings);
  });

  it("counts every candidate it was given", () => {
    const candidates = [
      candidate("cv_1", 0.9),
      candidate("cv_2", 0.5),
      candidate("cv_3", 0.1),
    ];

    expect(
      judgeCandidates(candidates, thresholds).provenance.consideredCount,
    ).toBe(candidates.length);
  });

  it("keeps provenance.ranked in the same order as outcomes", () => {
    const result = judgeCandidates(
      [
        candidate("cv_b", 0.1),
        candidate("cv_a", 0.95),
        candidate("cv_c", 0.5),
      ],
      thresholds,
    );

    expect(result.provenance.ranked.map((entry) => entry.versionId)).toEqual(
      result.outcomes.map((outcome) => outcome.versionId),
    );
    expect(result.provenance.ranked.map((entry) => entry.versionId)).toEqual([
      "cv_a",
      "cv_c",
      "cv_b",
    ]);
  });

  it("does not reorder the caller's array", () => {
    const candidates = [
      candidate("cv_b", 0.1),
      candidate("cv_a", 0.95),
      candidate("cv_c", 0.5),
    ];
    const before = candidates.map((entry) => entry.versionId);

    judgeCandidates(candidates, thresholds);

    expect(candidates.map((entry) => entry.versionId)).toEqual(before);
  });

  it("refuses thresholds where admit equals reject", () => {
    expect(() => judgeCandidates([], { admit: 0.5, reject: 0.5 })).toThrow(
      SelectionThresholdsInvariantError,
    );
  });

  it("refuses thresholds where admit is below reject", () => {
    expect(() => judgeCandidates([], { admit: 0.3, reject: 0.7 })).toThrow(
      SelectionThresholdsInvariantError,
    );
  });

  it("refuses thresholds that are not finite", () => {
    expect(() =>
      judgeCandidates([], { admit: Number.NaN, reject: 0.2 }),
    ).toThrow(SelectionThresholdsInvariantError);
    expect(() =>
      judgeCandidates([], { admit: 0.8, reject: Number.NEGATIVE_INFINITY }),
    ).toThrow(SelectionThresholdsInvariantError);
  });

  it("stamps the ranking policy version onto the provenance", () => {
    expect(
      judgeCandidates([candidate("cv_1", 0.9)], thresholds).provenance
        .policyVersion,
    ).toBe(SELECTION_RANKING_POLICY_VERSION);
  });

  it("records the thresholds that were actually applied", () => {
    expect(
      judgeCandidates([candidate("cv_1", 0.9)], thresholds).provenance
        .thresholds,
    ).toBe(thresholds);
  });

  it("records the default band when thresholds were omitted", () => {
    expect(
      judgeCandidates([candidate("cv_1", 0.9)]).provenance.thresholds,
    ).toBe(DEFAULT_SELECTION_THRESHOLDS);
  });

  it("names the tie-break key it ranked under", () => {
    expect(judgeCandidates([], thresholds).provenance.tieBreak).toBe(
      "cardVersionId",
    );
  });

  it("rejects a NaN score instead of deferring it", () => {
    const outcomes = judgeCandidates(
      [candidate("cv_1", Number.NaN)],
      thresholds,
    ).outcomes;

    expect(outcomes.map((outcome) => outcome.verdict)).toEqual(["reject"]);
    expect(outcomes.map(rulesOf)).toEqual([["score.not.finite"]]);
  });

  it("rejects an infinite score in either direction", () => {
    const outcomes = judgeCandidates(
      [
        candidate("cv_1", Number.POSITIVE_INFINITY),
        candidate("cv_2", Number.NEGATIVE_INFINITY),
      ],
      thresholds,
    ).outcomes;

    expect(outcomes.map((outcome) => outcome.verdict)).toEqual([
      "reject",
      "reject",
    ]);
    expect(outcomes.map(rulesOf)).toEqual([
      ["score.not.finite"],
      ["score.not.finite"],
    ]);
  });

  it("sinks every non-finite score below the finite ones", () => {
    const result = judgeCandidates(
      [
        candidate("cv_nan", Number.NaN),
        candidate("cv_low", 0.1),
        candidate("cv_inf", Number.POSITIVE_INFINITY),
        candidate("cv_high", 0.95),
      ],
      thresholds,
    );

    expect(result.outcomes.map((outcome) => outcome.versionId)).toEqual([
      "cv_high",
      "cv_low",
      "cv_inf",
      "cv_nan",
    ]);
    expect(result.provenance.ranked.map((entry) => entry.versionId)).toEqual([
      "cv_high",
      "cv_low",
      "cv_inf",
      "cv_nan",
    ]);
  });

  it("orders non-finite scores among themselves by ascending versionId", () => {
    const expected = ["cv_a", "cv_b", "cv_c"];
    const permutations: readonly (readonly ScoredCandidate[])[] = [
      [
        candidate("cv_c", Number.NaN),
        candidate("cv_a", Number.POSITIVE_INFINITY),
        candidate("cv_b", Number.NEGATIVE_INFINITY),
      ],
      [
        candidate("cv_b", Number.NEGATIVE_INFINITY),
        candidate("cv_c", Number.NaN),
        candidate("cv_a", Number.POSITIVE_INFINITY),
      ],
    ];

    for (const permutation of permutations) {
      expect(
        judgeCandidates(permutation, thresholds).outcomes.map(
          (outcome) => outcome.versionId,
        ),
      ).toEqual(expected);
    }
  });

  it("refuses a candidate set that repeats a versionId", () => {
    expect(() =>
      judgeCandidates(
        [candidate("cv_1", 0.9), candidate("cv_2", 0.5), candidate("cv_1", 0.1)],
        thresholds,
      ),
    ).toThrow(SelectionCandidateInvariantError);
  });

  it("names the repeated versionId in the failure", () => {
    expect(() =>
      judgeCandidates(
        [candidate("cv_dup", 0.9), candidate("cv_dup", 0.1)],
        thresholds,
      ),
    ).toThrow(/cv_dup/);
  });

  it("accepts several versions of the same card", () => {
    const candidates: readonly ScoredCandidate[] = [
      { cardId: "card_1", versionId: "cv_1", score: 0.9 },
      { cardId: "card_1", versionId: "cv_2", score: 0.5 },
      { cardId: "card_1", versionId: "cv_3", score: 0.1 },
    ];

    expect(
      judgeCandidates(candidates, thresholds).outcomes.map(
        (outcome) => outcome.verdict,
      ),
    ).toEqual(["admit", "defer", "reject"]);
  });

  it("falls back to the default band when thresholds are omitted", () => {
    const result = judgeCandidates([
      candidate("cv_1", DEFAULT_SELECTION_THRESHOLDS.admit),
      candidate("cv_2", 0.5),
      candidate("cv_3", DEFAULT_SELECTION_THRESHOLDS.reject),
    ]);

    expect(result.outcomes.map((outcome) => outcome.verdict)).toEqual([
      "admit",
      "defer",
      "reject",
    ]);
  });

  it("can project an independently admitted set into a smaller plan verdict", () => {
    const independent = judgeCandidates(
      [candidate("cv_a", 0.95), candidate("cv_b", 0.9)],
      thresholds,
    );

    const planned = applySetPlanningDecision(independent, new Set(["cv_a"]));

    expect(planned.outcomes.map((outcome) => outcome.verdict)).toEqual([
      "admit",
      "defer",
    ]);
    expect(rulesOf(planned.outcomes[1]!)).toEqual([
      "plan.covered_by_selected_set",
    ]);
    expect(planned.provenance).toBe(independent.provenance);
  });

  it("does not promote a Card that missed the independent admit band", () => {
    const independent = judgeCandidates(
      [candidate("cv_a", 0.95), candidate("cv_b", 0.5)],
      thresholds,
    );

    expect(() =>
      applySetPlanningDecision(independent, new Set(["cv_b"])),
    ).toThrow(SelectionCandidateInvariantError);
  });

  it("does not remove the entire independently admitted set", () => {
    const independent = judgeCandidates(
      [candidate("cv_a", 0.95)],
      thresholds,
    );

    expect(() => applySetPlanningDecision(independent, new Set())).toThrow(
      SelectionCandidateInvariantError,
    );
  });
});
