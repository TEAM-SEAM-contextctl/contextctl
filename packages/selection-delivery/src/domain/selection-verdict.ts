import {
  SelectionCandidateInvariantError,
  SelectionThresholdsInvariantError,
} from "./errors.js";

/** Identifies the ranking rules a provenance record was produced under. */
export const SELECTION_RANKING_POLICY_VERSION = "selection-ranking-v1";

/** Deterministic selection outcome for one scored candidate. Never LLM-decided. */
export type SelectionVerdict = "admit" | "defer" | "reject";

/**
 * One Card Version already scored against a query. Scoring happens outside this
 * domain so that judgement itself stays deterministic: the same candidates and
 * the same thresholds always produce the same verdicts in the same order.
 */
export interface ScoredCandidate {
  readonly cardId: string;
  readonly versionId: string;
  readonly score: number;
}

/**
 * Boundaries of the admit/defer/reject band. Both boundaries are closed toward
 * the decisive side: a score exactly on a threshold is decided, never deferred.
 */
export interface SelectionThresholds {
  readonly admit: number;
  readonly reject: number;
}

/**
 * Starting band, tuned for a normalized [0, 1] score.
 *
 * `admit` reuses the 0.85 confidence bar that document capture already treats
 * as "certain enough to act on", so the repository does not carry two different
 * numbers for the same idea. `reject` is deliberately low, which keeps the
 * defer band wide: an ambiguous candidate should surface as defer rather than
 * be silently admitted or discarded. Both values are expected to move once real
 * query data exists.
 */
export const DEFAULT_SELECTION_THRESHOLDS: SelectionThresholds = {
  admit: 0.85,
  reject: 0.35,
};

/** Why a candidate was not admitted, for the audit trail. */
export interface SelectionFinding {
  readonly rule: string;
  readonly message: string;
}

export type SelectionOutcome =
  | {
      readonly verdict: "admit";
      readonly cardId: string;
      readonly versionId: string;
      readonly score: number;
    }
  | {
      readonly verdict: "defer" | "reject";
      readonly cardId: string;
      readonly versionId: string;
      readonly score: number;
      readonly findings: readonly SelectionFinding[];
    };

export interface RankedCandidate {
  readonly cardId: string;
  readonly versionId: string;
  readonly score: number;
}

/**
 * What the ranking saw and in which order, so a verdict can be reproduced.
 *
 * The outcomes alone are not reproducible: the same candidates rank differently
 * under a different rule set, a different band, or a different tie-break, so
 * the policy version, the thresholds actually applied, and the tie-break key
 * are recorded alongside the ordering.
 */
export interface RankingProvenance {
  readonly policyVersion: string;
  readonly thresholds: SelectionThresholds;
  readonly tieBreak: "cardVersionId";
  readonly consideredCount: number;
  readonly ranked: readonly RankedCandidate[];
}

export interface SelectionResult {
  readonly outcomes: readonly SelectionOutcome[];
  readonly provenance: RankingProvenance;
}

/**
 * Ranks candidates and decides each one against the threshold band.
 *
 * `outcomes` and `provenance.ranked` share one ordering, so the audit trail
 * describes exactly the sequence the caller received.
 */
export function judgeCandidates(
  candidates: readonly ScoredCandidate[],
  thresholds: SelectionThresholds = DEFAULT_SELECTION_THRESHOLDS,
): SelectionResult {
  assertUsableThresholds(thresholds);
  assertUniqueVersionIds(candidates);

  // The caller's array is never reordered: ranking is an observation, not a
  // mutation of the input.
  const ranked = [...candidates].sort(compareCandidates);

  return {
    outcomes: ranked.map((candidate) => judgeCandidate(candidate, thresholds)),
    provenance: {
      policyVersion: SELECTION_RANKING_POLICY_VERSION,
      thresholds,
      tieBreak: "cardVersionId",
      consideredCount: candidates.length,
      ranked: ranked.map(({ cardId, versionId, score }) => ({
        cardId,
        versionId,
        score,
      })),
    },
  };
}

function judgeCandidate(
  candidate: ScoredCandidate,
  thresholds: SelectionThresholds,
): SelectionOutcome {
  const { cardId, versionId, score } = candidate;

  // Checked before the band, for the same reason a NaN threshold is: every
  // comparison against a non-finite score is false, so it would otherwise fall
  // through both boundaries and land in defer as if it were merely ambiguous.
  if (!Number.isFinite(score)) {
    return {
      verdict: "reject",
      cardId,
      versionId,
      score,
      findings: [
        {
          rule: "score.not.finite",
          message: `score ${score} is not a finite number and cannot be ranked`,
        },
      ],
    };
  }
  if (score >= thresholds.admit) {
    return { verdict: "admit", cardId, versionId, score };
  }
  if (score <= thresholds.reject) {
    return {
      verdict: "reject",
      cardId,
      versionId,
      score,
      findings: [
        {
          rule: "score.at.or.below.reject",
          message: `score ${score} is at or below the reject threshold ${thresholds.reject}`,
        },
      ],
    };
  }
  return {
    verdict: "defer",
    cardId,
    versionId,
    score,
    findings: [
      {
        rule: "score.below.admit",
        message: `score ${score} is below the admit threshold ${thresholds.admit} and above the reject threshold ${thresholds.reject}`,
      },
    ],
  };
}

function compareCandidates(
  left: ScoredCandidate,
  right: ScoredCandidate,
): number {
  const leftFinite = Number.isFinite(left.score);
  const rightFinite = Number.isFinite(right.score);

  // A non-finite score always sinks to the bottom. Subtracting it would hand
  // the comparator a NaN, and a comparator that returns NaN makes the whole
  // ordering unspecified — the rejection verdict alone is not enough.
  if (leftFinite !== rightFinite) {
    return leftFinite ? -1 : 1;
  }
  if (leftFinite && left.score !== right.score) {
    return right.score - left.score;
  }
  // versionId ascending, compared with `<` / `>` rather than `localeCompare`.
  // `localeCompare` resolves against the runtime locale, so the same input can
  // rank differently on two machines and the verdict stops being reproducible.
  // Document capture in ingestion-indexing does use `localeCompare`, but that
  // is a block-matching heuristic, not a decision that has to be auditable.
  if (left.versionId < right.versionId) {
    return -1;
  }
  if (left.versionId > right.versionId) {
    return 1;
  }
  return 0;
}

/**
 * One Card may contribute several versions, so a repeated cardId is normal
 * input. A repeated versionId is not: two entries that tie on score would then
 * also tie on the tie-break key, and their order would fall back to input
 * order, which is exactly the determinism this ranking promises to remove.
 */
function assertUniqueVersionIds(candidates: readonly ScoredCandidate[]): void {
  const seen = new Set<string>();

  for (const candidate of candidates) {
    if (seen.has(candidate.versionId)) {
      throw new SelectionCandidateInvariantError(
        `card version ${candidate.versionId} appears more than once in one selection`,
      );
    }
    seen.add(candidate.versionId);
  }
}

function assertUsableThresholds(thresholds: SelectionThresholds): void {
  // Checked before the ordering invariant: `NaN <= NaN` is false, so a NaN
  // threshold would slip past the band check and then silently defer every
  // candidate, because every comparison against NaN is false too.
  if (
    !Number.isFinite(thresholds.admit) ||
    !Number.isFinite(thresholds.reject)
  ) {
    throw new SelectionThresholdsInvariantError(
      `thresholds must be finite, received admit ${thresholds.admit} and reject ${thresholds.reject}`,
    );
  }
  if (thresholds.admit <= thresholds.reject) {
    throw new SelectionThresholdsInvariantError(
      `admit threshold ${thresholds.admit} must be greater than reject threshold ${thresholds.reject}`,
    );
  }
}
