import type { ApprovedCard } from "./card-catalog.js";
import { canonicalDigest } from "./canonical-digest.js";
import { SelectionCandidateInvariantError } from "./errors.js";
import type { SelectionMode } from "./hybrid-ranking.js";
import {
  compareExecutionCost,
  compareExecutionSavings,
  measureCardRemovalSavings,
  measurePlanCost,
  subtractPlanCost,
  type PlanCost,
} from "./minimum-set-plan-cost.js";
import {
  extractQueryFacets,
  type QueryFacet,
  type QueryFacetResult,
} from "./query-facet.js";
import {
  buildFacetSupports,
  coverageForCards,
  isSuperset,
  preservesFacetCoverage,
  protectedCandidateReasons,
  type CardSupport,
  type FacetCoverage,
  type ProtectedCardReason,
} from "./query-facet-support.js";
import type { CandidateScore } from "./query-scoring.js";
import type {
  SelectionOutcome,
  SelectionResult,
} from "./selection-verdict.js";

export { comparePlanCost } from "./minimum-set-plan-cost.js";
export type { PlanCost } from "./minimum-set-plan-cost.js";
export type { FacetCoverage } from "./query-facet-support.js";

/**
 * The joint Card reduction rule used by `selection-planning-v2`.
 *
 * Keeping the planner pure lets the product path, scale gate and holdouts run
 * the exact same implementation without a second orchestration-specific rule.
 */
export const MINIMUM_SUFFICIENT_SET_POLICY_VERSION =
  "minimum-sufficient-set-v1" as const;

export type CardPlanningDecisionReason =
  | "unique_facet_support"
  | "explicit_source_intent"
  | ProtectedCardReason
  | "no_execution_saving"
  | "covered_by_selected_set";

export interface CardPlanningDecision {
  readonly cardId: string;
  readonly versionId: string;
  readonly decision: "selected" | "not_planned" | "protected";
  readonly reason: CardPlanningDecisionReason;
  readonly coveredFacetIds: readonly string[];
  readonly replacementCardVersionIds: readonly string[];
}

export interface MinimumSufficientSetAudit {
  readonly policyVersion: typeof MINIMUM_SUFFICIENT_SET_POLICY_VERSION;
  readonly queryFacetPolicyVersion: QueryFacetResult["policyVersion"];
  readonly ambiguous: boolean;
  readonly facets: readonly QueryFacet[];
  readonly decisions: readonly CardPlanningDecision[];
  readonly baselineCoverage: readonly FacetCoverage[];
  readonly selectedCoverage: readonly FacetCoverage[];
  readonly costBefore: PlanCost;
  readonly costAfter: PlanCost;
  readonly removalCount: number;
  readonly auditDigest: string;
}

export interface MinimumSufficientSetInput {
  readonly query: string;
  readonly eligibleCards: readonly ApprovedCard[];
  readonly lexicalScores: readonly CandidateScore[];
  readonly rankedScores: readonly CandidateScore[];
  readonly initialSelection: SelectionResult;
  readonly mode: SelectionMode;
  readonly chunkLimitPerScope: number;
}

export interface MinimumSufficientSetResult {
  readonly selectedCards: readonly ApprovedCard[];
  readonly audit: MinimumSufficientSetAudit;
}

interface RemovalCandidate {
  readonly card: ApprovedCard;
  readonly next: readonly ApprovedCard[];
  readonly nextCost: PlanCost;
  readonly savings: PlanCost;
  readonly score: number;
}

/**
 * Removes one independently strong Card at a time only when query support is
 * preserved and the resulting plan performs less work.
 */
export function planMinimumSufficientCardSet(
  input: MinimumSufficientSetInput,
): MinimumSufficientSetResult {
  const cardsByVersionId = assertPlannerInput(input);
  const initialStrong = input.initialSelection.outcomes
    .filter(isAdmitted)
    .map((outcome) => cardsByVersionId.get(outcome.versionId))
    .filter((card): card is ApprovedCard => card !== undefined);
  const facets = extractQueryFacets(input.query);
  const supports = buildFacetSupports(
    initialStrong,
    input.eligibleCards,
    facets.facets,
  );
  const protectedReasons = protectedCandidateReasons({
    strongCards: initialStrong,
    lexicalByVersionId: new Map(
      input.lexicalScores.map((score) => [score.versionId, score.score]),
    ),
    selection: input.initialSelection,
    mode: input.mode,
    facets,
    supports,
    chunkLimitPerScope: input.chunkLimitPerScope,
  });
  const baselineCoverage = coverageForCards(
    initialStrong,
    supports,
    facets.facets,
  );
  const costBefore = measurePlanCost(
    initialStrong,
    input.chunkLimitPerScope,
  );
  const scoreByVersionId = new Map(
    input.rankedScores.map((score) => [score.versionId, score.score]),
  );

  let selected: readonly ApprovedCard[] = initialStrong;
  let currentCost = costBefore;
  let removalCount = 0;
  if (!facets.ambiguous) {
    while (selected.length > 1) {
      const removable = findRemovableCards({
        selected,
        currentCost,
        supports,
        facets: facets.facets,
        baselineCoverage,
        protectedReasons,
        scoreByVersionId,
        chunkLimitPerScope: input.chunkLimitPerScope,
      });
      const chosen = removable.sort(compareRemovalCandidates)[0];
      if (chosen === undefined) break;
      selected = chosen.next;
      currentCost = chosen.nextCost;
      removalCount += 1;
    }
  }

  const selectedVersionIds = new Set(
    selected.map((card) => card.versionId),
  );
  const auditBody = {
    policyVersion: MINIMUM_SUFFICIENT_SET_POLICY_VERSION,
    queryFacetPolicyVersion: facets.policyVersion,
    ambiguous: facets.ambiguous,
    facets: facets.facets,
    decisions: decisionsFor({
      initialStrong,
      selectedCards: selected,
      selectedVersionIds,
      supports,
      protectedReasons,
      facets: facets.facets,
      baselineCoverage,
      chunkLimitPerScope: input.chunkLimitPerScope,
    }),
    baselineCoverage,
    selectedCoverage: coverageForCards(selected, supports, facets.facets),
    costBefore,
    costAfter: currentCost,
    removalCount,
  };
  return {
    selectedCards: selected,
    audit: {
      ...auditBody,
      auditDigest: canonicalDigest(auditBody),
    },
  };
}

function findRemovableCards(input: {
  readonly selected: readonly ApprovedCard[];
  readonly currentCost: PlanCost;
  readonly supports: ReadonlyMap<string, CardSupport>;
  readonly facets: readonly QueryFacet[];
  readonly baselineCoverage: readonly FacetCoverage[];
  readonly protectedReasons: ReadonlyMap<string, ProtectedCardReason>;
  readonly scoreByVersionId: ReadonlyMap<string, number>;
  readonly chunkLimitPerScope: number;
}): RemovalCandidate[] {
  const removable: RemovalCandidate[] = [];
  const savingsByVersionId = measureCardRemovalSavings(
    input.selected,
    input.chunkLimitPerScope,
  );
  for (const card of input.selected) {
    if (input.protectedReasons.has(card.versionId)) continue;
    const next = input.selected.filter(
      (candidate) => candidate.versionId !== card.versionId,
    );
    if (
      !preservesFacetCoverage(
        next,
        input.supports,
        input.facets,
        input.baselineCoverage,
      )
    ) {
      continue;
    }
    const savings = savingsByVersionId.get(card.versionId);
    if (savings === undefined) continue;
    const nextCost = subtractPlanCost(input.currentCost, savings);
    if (compareExecutionCost(nextCost, input.currentCost) >= 0) continue;
    removable.push({
      card,
      next,
      nextCost,
      savings,
      score: input.scoreByVersionId.get(card.versionId) ?? 0,
    });
  }
  return removable;
}

function decisionsFor(input: {
  readonly initialStrong: readonly ApprovedCard[];
  readonly selectedCards: readonly ApprovedCard[];
  readonly selectedVersionIds: ReadonlySet<string>;
  readonly supports: ReadonlyMap<string, CardSupport>;
  readonly protectedReasons: ReadonlyMap<string, ProtectedCardReason>;
  readonly facets: readonly QueryFacet[];
  readonly baselineCoverage: readonly FacetCoverage[];
  readonly chunkLimitPerScope: number;
}): readonly CardPlanningDecision[] {
  const selectedCost = measurePlanCost(
    input.selectedCards,
    input.chunkLimitPerScope,
  );
  return input.initialStrong.map((card) => {
    const support = input.supports.get(card.versionId);
    const coveredFacetIds =
      support?.supports
        .filter(
          (entry) =>
            entry.lexicalScore > 0 ||
            entry.supportedTokens.length > 0 ||
            entry.supportedSourceKinds.length > 0,
        )
        .map((entry) => entry.facetId) ?? [];
    const protectedReason = input.protectedReasons.get(card.versionId);
    if (input.selectedVersionIds.has(card.versionId)) {
      return {
        cardId: card.cardId,
        versionId: card.versionId,
        decision: protectedReason === undefined ? "selected" : "protected",
        reason:
          protectedReason ?? selectedReason(card, input, selectedCost),
        coveredFacetIds,
        replacementCardVersionIds: [],
      };
    }
    return {
      cardId: card.cardId,
      versionId: card.versionId,
      decision: "not_planned",
      reason: "covered_by_selected_set",
      coveredFacetIds,
      replacementCardVersionIds: replacementCards(
        card.versionId,
        input.selectedVersionIds,
        input.supports,
      ),
    };
  });
}

function selectedReason(
  card: ApprovedCard,
  input: {
    readonly selectedCards: readonly ApprovedCard[];
    readonly supports: ReadonlyMap<string, CardSupport>;
    readonly facets: readonly QueryFacet[];
    readonly baselineCoverage: readonly FacetCoverage[];
    readonly chunkLimitPerScope: number;
  },
  selectedCost: PlanCost,
): CardPlanningDecisionReason {
  const without = input.selectedCards.filter(
    (candidate) => candidate.versionId !== card.versionId,
  );
  const withoutCoverage = coverageForCards(
    without,
    input.supports,
    input.facets,
  );
  if (
    preservesFacetCoverage(
      without,
      input.supports,
      input.facets,
      input.baselineCoverage,
    ) &&
    compareExecutionCost(
      measurePlanCost(without, input.chunkLimitPerScope),
      selectedCost,
    ) >= 0
  ) {
    return "no_execution_saving";
  }
  const lostExplicitKind = input.baselineCoverage.some((expected) => {
    const actual = withoutCoverage.find(
      (entry) => entry.facetId === expected.facetId,
    );
    return (
      actual !== undefined &&
      !isSuperset(
        actual.supportedSourceKinds,
        expected.supportedSourceKinds,
      )
    );
  });
  return lostExplicitKind ? "explicit_source_intent" : "unique_facet_support";
}

function replacementCards(
  removedVersionId: string,
  selectedVersionIds: ReadonlySet<string>,
  supports: ReadonlyMap<string, CardSupport>,
): readonly string[] {
  const removed = supports.get(removedVersionId);
  if (removed === undefined) return [];
  const replacements: string[] = [];
  for (const selectedVersionId of selectedVersionIds) {
    const selected = supports.get(selectedVersionId);
    if (
      selected !== undefined &&
      removed.supports.some((removedSupport) => {
        const selectedSupport = selected.supports.find(
          (entry) => entry.facetId === removedSupport.facetId,
        );
        return (
          selectedSupport !== undefined &&
          selectedSupport.lexicalScore >= removedSupport.lexicalScore &&
          isSuperset(
            selectedSupport.supportedTokens,
            removedSupport.supportedTokens,
          ) &&
          isSuperset(
            selectedSupport.supportedSourceKinds,
            removedSupport.supportedSourceKinds,
          )
        );
      })
    ) {
      replacements.push(selectedVersionId);
    }
  }
  return replacements.sort(compareText);
}

function assertPlannerInput(
  input: MinimumSufficientSetInput,
): ReadonlyMap<string, ApprovedCard> {
  if (input.query.trim() === "") {
    throw new SelectionCandidateInvariantError(
      "minimum-sufficient set planning requires a non-empty query",
    );
  }
  const ranked = uniqueReferences("ranked score", input.rankedScores);
  const outcomes = uniqueReferences(
    "selection outcome",
    input.initialSelection.outcomes,
  );
  const provenance = uniqueReferences(
    "ranking provenance",
    input.initialSelection.provenance.ranked,
  );
  const seenEligibleVersions = new Set<string>();
  for (const card of input.eligibleCards) {
    if (seenEligibleVersions.has(card.versionId)) {
      throw new SelectionCandidateInvariantError(
        `eligible Card repeats card version ${card.versionId}`,
      );
    }
    seenEligibleVersions.add(card.versionId);
  }
  if (input.eligibleCards.length !== input.lexicalScores.length) {
    throw new SelectionCandidateInvariantError(
      "lexical scores do not describe the complete eligible Card snapshot",
    );
  }
  const cardsByRankedVersionId = new Map<string, ApprovedCard>();
  for (let index = 0; index < input.eligibleCards.length; index += 1) {
    const card = input.eligibleCards[index];
    const score = input.lexicalScores[index];
    if (card === undefined || score === undefined) {
      throw new SelectionCandidateInvariantError(
        "lexical scores do not describe the complete eligible Card snapshot",
      );
    }
    if (
      score.versionId !== card.versionId ||
      score.cardId !== card.cardId
    ) {
      throw new SelectionCandidateInvariantError(
        `card version ${card.versionId} is inconsistent between the eligible snapshot and lexical scores`,
      );
    }
    if (ranked.has(card.versionId)) {
      cardsByRankedVersionId.set(card.versionId, card);
    }
  }
  if (
    !sameKeys(ranked, outcomes) ||
    !sameKeys(ranked, provenance) ||
    input.initialSelection.provenance.consideredCount !== ranked.size
  ) {
    throw new SelectionCandidateInvariantError(
      "ranked scores, outcomes and ranking provenance do not describe one candidate set",
    );
  }
  for (const [versionId, score] of ranked) {
    const card = cardsByRankedVersionId.get(versionId);
    const outcome = outcomes.get(versionId);
    const provenanceEntry = provenance.get(versionId);
    if (
      card === undefined ||
      card.cardId !== score.cardId ||
      outcome?.cardId !== score.cardId ||
      provenanceEntry?.cardId !== score.cardId ||
      outcome.score !== score.score ||
      provenanceEntry.score !== score.score
    ) {
      throw new SelectionCandidateInvariantError(
        `card version ${versionId} is inconsistent across planner inputs`,
      );
    }
  }
  return cardsByRankedVersionId;
}

function uniqueReferences<
  T extends { readonly cardId: string; readonly versionId: string },
>(label: string, values: readonly T[]): ReadonlyMap<string, T> {
  const byVersionId = new Map<string, T>();
  for (const value of values) {
    if (byVersionId.has(value.versionId)) {
      throw new SelectionCandidateInvariantError(
        `${label} repeats card version ${value.versionId}`,
      );
    }
    byVersionId.set(value.versionId, value);
  }
  return byVersionId;
}

function sameKeys<T, U>(
  left: ReadonlyMap<string, T>,
  right: ReadonlyMap<string, U>,
): boolean {
  return (
    left.size === right.size &&
    [...left.keys()].every((key) => right.has(key))
  );
}

function compareRemovalCandidates(
  left: RemovalCandidate,
  right: RemovalCandidate,
): number {
  const savings = compareExecutionSavings(left.savings, right.savings);
  if (savings !== 0) return savings;
  if (left.score !== right.score) return left.score - right.score;
  return left.card.versionId > right.card.versionId
    ? -1
    : left.card.versionId < right.card.versionId
      ? 1
      : 0;
}

function isAdmitted(
  outcome: SelectionOutcome,
): outcome is Extract<SelectionOutcome, { verdict: "admit" }> {
  return outcome.verdict === "admit";
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
