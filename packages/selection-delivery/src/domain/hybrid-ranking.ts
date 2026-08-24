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
export const HYBRID_SCORING_POLICY_VERSION = "selection-hybrid-v2" as const;

/** Which scoring family produced a ranking. Paired with `scoring` by invariant. */
export type SelectionMode = "hybrid" | "lexical_degraded";

export type SelectionScoringPolicyVersion =
  | typeof HYBRID_SCORING_POLICY_VERSION
  | "selection-lexical-v2";

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
    : "selection-lexical-v2";
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
 * Below this cosine, an isolated similarity is not evidence for a verdict.
 *
 * `selection-eval-v1` calibration measured relevant pairs from 0.796 to 0.905,
 * forbidden pairs up to 0.876 and unrelated pairs up to 0.852. The overlap
 * means no single lower absolute threshold is safe. A value above this floor is
 * retained as-is; a lower value can become decisive only through the separate
 * top-versus-runner-up confidence rule below.
 */
export const SEMANTIC_SIMILARITY_FLOOR = 0.85;

/**
 * v2 gives no numerical bonus merely because two weak signals coexist.
 * The former 0.1 bonus admitted forbidden Cards in the fixed Granite corpus.
 * Kept as an exported policy value so a report can state the rule explicitly.
 */
export const HYBRID_AGREEMENT_BONUS = 0;

/** A non-leading semantic neighbour may reorder, but cannot defer or admit alone. */
export const SEMANTIC_SECONDARY_SCORE_CEILING = 0.34;
export const SEMANTIC_CONFIDENT_SIMILARITY_FLOOR = 0.8;
export const SEMANTIC_CONFIDENT_MARGIN = 0.03;
export const SEMANTIC_CONFIDENT_SCORE = 0.85;

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
 * Keeps a raw cosine only when its absolute value cleared calibration.
 * Rescaling the narrow Granite cone made ordinary neighbours look decisive;
 * preserving the cosine keeps the output auditable and bounded.
 */
export function semanticScoreFor(similarity: number): number {
  if (!Number.isFinite(similarity) || similarity <= SEMANTIC_SIMILARITY_FLOOR) {
    return 0;
  }
  return Math.min(Math.max(similarity, 0), 1);
}

/**
 * The combined score, and the whole of the hybrid rule.
 *
 *     combined = clamp01(max(lexical, semantic))
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
 * 3. Two sub-threshold signals cannot add up to an admission. This is what keeps
 *    a common term plus an ordinary cosine from widening access.
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

  return clampToUnitInterval(Math.max(lexical, semantic));
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
  const context = prepareHybridRanking(input);

  return input.lexical.map((candidate) => {
    const similarity = semanticSimilarityForCandidate(candidate, context);
    const semantic = semanticScoreForCandidate(candidate, context, similarity);
    return {
      cardId: candidate.cardId,
      versionId: candidate.versionId,
      score: combineHybridScore(candidate.score, semantic),
      signals: candidate.signals,
      lexicalScore: candidate.score,
      semanticSimilarity: similarity,
      semanticScore: semantic,
    };
  });
}

/**
 * Produces the SelectionPlan's declared base candidate shape without copying
 * every lexical-only record into a wider diagnostic object.
 *
 * `rankHybridCandidates` above remains the detailed audit API. The application
 * plan promises only `CandidateScore`, and an entry whose hybrid score did not
 * move is already that exact value. Reusing it avoids one catalog-sized object
 * population on every Resolve while preserving order, identity fields, score
 * and signals.
 */
export function rankHybridCandidateScores(
  input: HybridRankingInput,
): readonly CandidateScore[] {
  const context = prepareHybridRanking(input);

  return input.lexical.map((candidate) => {
    const similarity = semanticSimilarityForCandidate(candidate, context);
    const semantic = semanticScoreForCandidate(candidate, context, similarity);
    const score = combineHybridScore(candidate.score, semantic);
    return score === candidate.score ? candidate : { ...candidate, score };
  });
}

interface PreparedHybridRanking {
  readonly similarityByVersionId: ReadonlyMap<string, number>;
  readonly leadingSemanticVersionId: string | undefined;
  readonly leadingSemanticSimilarity: number | undefined;
  readonly runnerUpSemanticSimilarity: number | undefined;
  readonly union: ReadonlySet<string>;
}

function prepareHybridRanking(input: HybridRankingInput): PreparedHybridRanking {
  const similarityByVersionId = new Map(
    input.semantic.map((entry) => [entry.cardVersionId, entry.similarity]),
  );
  // `CardCandidateIndex.topK` already guarantees this order. Sorting a copy on
  // every request adds short-lived allocations without changing one result.
  const leadingSemantic = input.semantic[0];
  const runnerUpSemantic = input.semantic[1];
  const leadingSemanticVersionId = leadingSemantic?.cardVersionId;
  const union = new Set<string>(similarityByVersionId.keys());
  for (const candidate of topLexical(input.lexical, input.lexicalTopK)) {
    union.add(candidate.versionId);
  }

  return {
    similarityByVersionId,
    leadingSemanticVersionId,
    leadingSemanticSimilarity: leadingSemantic?.similarity,
    runnerUpSemanticSimilarity: runnerUpSemantic?.similarity,
    union,
  };
}

function semanticSimilarityForCandidate(
  candidate: CandidateScore,
  context: PreparedHybridRanking,
): number | undefined {
  return context.union.has(candidate.versionId)
    ? context.similarityByVersionId.get(candidate.versionId)
    : undefined;
}

function semanticScoreForCandidate(
  candidate: CandidateScore,
  context: PreparedHybridRanking,
  similarity: number | undefined,
): number {
  const rawSemanticScore =
    similarity === undefined ? 0 : semanticScoreFor(similarity);
  return candidate.versionId === context.leadingSemanticVersionId &&
    context.leadingSemanticSimilarity !== undefined
    ? confidentLeadingSemanticScore(
        rawSemanticScore,
        context.leadingSemanticSimilarity,
        context.runnerUpSemanticSimilarity,
      )
    : Math.min(rawSemanticScore, SEMANTIC_SECONDARY_SCORE_CEILING);
}

function confidentLeadingSemanticScore(
  rawScore: number,
  similarity: number,
  runnerUpSimilarity: number | undefined,
): number {
  const margin = similarity - (runnerUpSimilarity ?? 0);
  if (
    similarity >= SEMANTIC_CONFIDENT_SIMILARITY_FLOOR &&
    margin >= SEMANTIC_CONFIDENT_MARGIN
  ) {
    return Math.max(rawScore, SEMANTIC_CONFIDENT_SCORE);
  }
  return rawScore;
}

/** The strongest `limit` lexical candidates, ties broken on `versionId`. */
function topLexical(
  candidates: readonly CandidateScore[],
  limit: number,
): readonly CandidateScore[] {
  if (limit <= 0 || Number.isNaN(limit)) return [];
  const strongest: CandidateScore[] = [];
  for (const candidate of candidates) {
    if (
      strongest.length === limit &&
      compareLexical(candidate, strongest[strongest.length - 1]!) >= 0
    ) {
      continue;
    }
    let low = 0;
    let high = strongest.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (compareLexical(candidate, strongest[middle]!) < 0) {
        high = middle;
      } else {
        low = middle + 1;
      }
    }
    strongest.splice(low, 0, candidate);
    if (strongest.length > limit) strongest.pop();
  }
  return strongest;
}

function compareLexical(
  left: CandidateScore,
  right: CandidateScore,
): number {
  if (left.score !== right.score) return right.score - left.score;
  if (left.versionId < right.versionId) return -1;
  return left.versionId > right.versionId ? 1 : 0;
}

function clampToUnitInterval(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(Math.max(value, 0), 1);
}
