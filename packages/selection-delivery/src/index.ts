export {
  DEFAULT_SELECTION_THRESHOLDS,
  judgeCandidates,
  SELECTION_RANKING_POLICY_VERSION,
  type RankedCandidate,
  type RankingProvenance,
  type ScoredCandidate,
  type SelectionFinding,
  type SelectionOutcome,
  type SelectionResult,
  type SelectionThresholds,
  type SelectionVerdict,
} from "./domain/selection-verdict.js";
export {
  SelectionCandidateInvariantError,
  SelectionThresholdsInvariantError,
} from "./domain/errors.js";
