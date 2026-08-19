import type { CardSimilarity } from "./card-candidate-index.js";
import type { CandidateScore } from "./query-scoring.js";
import { SelectionModeInvariantError } from "./errors.js";

/**
 * Identifies the scoring rules a candidate score was produced under when both
 * signals were available.
 *
 * The counterpart of `QUERY_SCORING_POLICY_VERSION`. Two names rather than one
 * versioned name because a consumer's question is "were these two answers
 * produced the same way", and a run that had no Card vectors is not the same way
 * as a run that had them — even under identical thresholds and an identical
 * catalog.
 */
export const HYBRID_SCORING_POLICY_VERSION = "selection-hybrid-v1" as const;

/** Which scoring family produced a ranking. Paired with `scoring` by invariant. */
export type SelectionMode = "hybrid" | "lexical_degraded";

export type SelectionScoringPolicyVersion =
  | typeof HYBRID_SCORING_POLICY_VERSION
  | "selection-lexical-v1";

/**
 * The one scoring version each mode is allowed to travel with.
 *
 * Stated as a function rather than as two constants a caller pairs by hand:
 * `mode` and `policy.scoring` are two views of one fact, and the only way to
 * keep them from drifting is for one to be derived from the other.
 */
export function scoringPolicyVersionFor(
  mode: SelectionMode,
): SelectionScoringPolicyVersion {
  return mode === "hybrid"
    ? HYBRID_SCORING_POLICY_VERSION
    : "selection-lexical-v1";
}

/** Refuses a `(mode, scoring)` pair that names two different families. */
export function assertSelectionScoringPairing(
  mode: SelectionMode,
  scoring: string,
): void {
  const expected = scoringPolicyVersionFor(mode);
  if (scoring !== expected) {
    throw new SelectionModeInvariantError(
      `selection mode ${mode} requires scoring ${expected}, received ${scoring}`,
    );
  }
}

/**
 * Below this cosine, a Card contributes no semantic evidence at all.
 *
 * The number is high because the model's own range is high, and that is not an
 * intuition. Measured against the installed granite-97m-multilingual-r2 fp32
 * artifact, over Card selection texts and queries from this repository's own
 * fixtures, every pair landed in [0.66, 0.86]:
 *
 *   0.79  a leave query against the leave Card          (the correct pairing)
 *   0.78  the same query against an unrelated refund Card
 *   0.76  the same query against an English C++ question
 *   0.72  the same query against an unrelated shipping Card
 *   0.67  a Korean weather question against an English C++ question
 *
 * Two things follow. The *ordering* is right — the correct pairing is top — so
 * the signal is real and worth using to rank. The *absolute* value carries
 * almost no information: nothing about "0.72" says "unrelated", because two
 * texts with no language, topic or script in common still score 0.67. An
 * encoder whose embeddings occupy a narrow cone does this, and it is why a naive
 * mapping of [-1, 1] onto [0, 1] is wrong here: at a floor of 0.5 the weather
 * question would have scored 0.33 against the refund Card, above the 0.35 reject
 * threshold, and a production catalog would have deferred every Card of every
 * query while rejecting none.
 *
 * At 0.75 the same measurements separate: the correct pairing scores 0.16, the
 * unrelated Card 0.10, and everything below the floor scores exactly 0. The
 * semantic path therefore *ranks* strongly and *admits* rarely on its own, which
 * is the conservative direction — a Card is never admitted because the encoder
 * was vague, only because the two signals agree or the lexical one was decisive.
 *
 * It is calibrated to one model on a handful of texts, which is a starting point
 * and not a tuning, exactly as `DEFAULT_SELECTION_THRESHOLDS` is. It belongs
 * with the profile once there is query data to tune it against; today a second
 * per-profile knob would be a parameter nobody has a number for.
 */
export const SEMANTIC_SIMILARITY_FLOOR = 0.75;

/**
 * How much agreement between the two signals is worth.
 *
 * Kept small on purpose: the combination below is "the stronger signal decides,
 * and agreement adds a little", not an average. An average is the obvious rule
 * and it is the wrong one here, because it makes each signal able to veto the
 * other — a Card that literally declares the query's words would be denied
 * admission by a mediocre cosine, and the direct-match guarantee
 * `query-scoring.ts` builds its whole score around (a declared term match lands
 * at or above 0.9, which is above the 0.85 admit threshold) would stop holding
 * the moment embeddings were switched on.
 */
export const HYBRID_AGREEMENT_BONUS = 0.1;

/** One Card's two signals and what they combined to. */
export interface HybridCandidateScore extends CandidateScore {
  /** The lexical score this Card would have had with no vectors at all. */
  readonly lexicalScore: number;
  /** Raw cosine, or `undefined` for a Card the semantic path did not reach. */
  readonly semanticSimilarity: number | undefined;
  /** `semanticSimilarity` mapped onto the admit band. Zero when unreached. */
  readonly semanticScore: number;
}

/**
 * Maps a raw cosine onto the [0, 1] band the thresholds are stated on.
 *
 * Linear above the floor, so a similarity of exactly 1 — the most the model can
 * say — maps onto 1, which is the same place a perfect lexical match lands.
 * That is the property that makes a semantic-only Card admissible at all: if the
 * top of the semantic range fell short of the admit threshold, the semantic path
 * could rank Cards but never admit one, and "reachable by meaning" would be a
 * claim the code did not actually support.
 */
export function semanticScoreFor(similarity: number): number {
  if (!Number.isFinite(similarity) || similarity <= SEMANTIC_SIMILARITY_FLOOR) {
    return 0;
  }
  const scaled =
    (similarity - SEMANTIC_SIMILARITY_FLOOR) / (1 - SEMANTIC_SIMILARITY_FLOOR);
  return Math.min(Math.max(scaled, 0), 1);
}

/**
 * The combined score, and the whole of the hybrid rule.
 *
 *     combined = clamp01( max(lexical, semantic) + 0.1 × min(lexical, semantic) )
 *
 * Three things follow from it, and each one is a requirement rather than a
 * pleasant consequence:
 *
 * 1. A Card whose declared terms appear in the query keeps its lexical score as
 *    a floor, so switching embeddings on never demotes a Card that was admitted
 *    without them.
 * 2. A Card that shares no term with the query reaches exactly its semantic
 *    score, so a paraphrase or a synonym can admit a Card that lexical matching
 *    cannot see. This is the case the whole step exists for.
 * 3. Two Cards that agree on both signals outrank one that is strong on a single
 *    signal, without either signal being able to veto the other.
 *
 * Symmetric in the two signals by construction, monotone in both, and total —
 * there is no input for which it is undefined, and a non-finite input scores 0
 * rather than propagating a NaN into a comparison that would silently be false.
 */
export function combineHybridScore(
  lexicalScore: number,
  semanticScore: number,
): number {
  const lexical = clampToUnitInterval(lexicalScore);
  const semantic = clampToUnitInterval(semanticScore);

  return clampToUnitInterval(
    Math.max(lexical, semantic) +
      HYBRID_AGREEMENT_BONUS * Math.min(lexical, semantic),
  );
}

export interface HybridRankingInput {
  readonly lexical: readonly CandidateScore[];
  /** The whole semantic result set, already `topK`'d over the entire index. */
  readonly semantic: readonly CardSimilarity[];
  /** How many Cards the lexical path contributes to the union. */
  readonly lexicalTopK: number;
}

/**
 * Merges the two paths into one score per Card.
 *
 * The union is the point. The lexical path contributes its own top K and the
 * semantic path contributes its own top K over the *entire* index, and a Card in
 * either one is ranked on both signals. A Card in neither keeps its lexical
 * score alone: it was retrieved by no path, so crediting it with a similarity
 * nobody put it in the running for would make the top-K bound decorative.
 *
 * Every Card the lexical path scored comes back, including the ones outside the
 * union. Dropping them would change what `counts.rejected` means — a response
 * would stop being able to say "the catalog had more to offer and none of it
 * qualified" — and the counts are the one part of the selection summary a caller
 * can act on.
 *
 * Signals travel unchanged from the lexical score. They explain where a lexical
 * number came from, and the semantic path has no comparable explanation to add:
 * "this vector was 0.83 away" names no field of the Card.
 */
export function rankHybridCandidates(
  input: HybridRankingInput,
): readonly HybridCandidateScore[] {
  const similarityByVersionId = new Map(
    input.semantic.map((entry) => [entry.cardVersionId, entry.similarity]),
  );
  const union = new Set<string>(similarityByVersionId.keys());
  for (const candidate of topLexical(input.lexical, input.lexicalTopK)) {
    union.add(candidate.versionId);
  }

  return input.lexical.map((candidate) => {
    const reached = union.has(candidate.versionId);
    const similarity = reached
      ? similarityByVersionId.get(candidate.versionId)
      : undefined;
    const semanticScore =
      similarity === undefined ? 0 : semanticScoreFor(similarity);

    return {
      cardId: candidate.cardId,
      versionId: candidate.versionId,
      score: combineHybridScore(candidate.score, semanticScore),
      signals: candidate.signals,
      lexicalScore: candidate.score,
      semanticSimilarity: similarity,
      semanticScore,
    };
  });
}

/** The strongest `limit` lexical candidates, ties broken on `versionId`. */
function topLexical(
  candidates: readonly CandidateScore[],
  limit: number,
): readonly CandidateScore[] {
  if (limit <= 0) {
    return [];
  }
  return [...candidates]
    .sort((left, right) => {
      if (left.score !== right.score) {
        return right.score - left.score;
      }
      if (left.versionId < right.versionId) {
        return -1;
      }
      return left.versionId > right.versionId ? 1 : 0;
    })
    .slice(0, limit);
}

function clampToUnitInterval(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(Math.max(value, 0), 1);
}
