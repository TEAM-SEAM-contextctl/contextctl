import {
  assembleDocumentContext,
  CONTEXT_ASSEMBLY_POLICY_VERSION,
  CONTEXT_FUSION_POLICY_VERSION,
  DEFAULT_CONTEXT_BUDGET,
  toContextOmission,
  type ContextBudget,
  type ContextCandidate,
  type ContextChunk,
  type ContextOmission,
} from "../domain/context-assembly.js";
import type {
  ContextResolution,
  ContextResolutionItem,
  RetrievedDocumentChunk,
  RetrievedDocumentContext,
  SelectionCounts,
  SelectionSummary,
} from "../domain/context-resolution.js";
import {
  assertOpaqueFailure,
  type ManagedResolutionOutcome,
} from "../domain/managed-resolution.js";
import {
  assertSelectionScoringPairing,
  scoringPolicyVersionFor,
  type SelectionMode,
  type SelectionScoringPolicyVersion,
} from "../domain/hybrid-ranking.js";
import {
  isManagedPlannedItem,
  SELECTION_PLANNING_POLICY_VERSION,
  type ApprovedCardReference,
  type PlannedResolutionItem,
  type SelectionPlan,
} from "../domain/selection-plan.js";
import { SELECTION_RANKING_POLICY_VERSION } from "../domain/selection-verdict.js";

export interface AssembleContextOptions {
  readonly budget?: ContextBudget;
}

/**
 * The scoring family this response was produced under, taken from the plan.
 *
 * Derived rather than fixed, now that Card embeddings exist and both arms of the
 * branch are reachable. It is read off `plan.summary.mode` rather than inferred
 * here, and the difference matters: by assembly time the only evidence left is
 * the numbers, and a hybrid run whose Cards all scored on lexical signals alone
 * produces numbers identical to a degraded run's. Only the step that held the
 * ports knows which happened.
 *
 * `mode` and `ResolutionPolicy.scoring` are the two halves of one invariant:
 * `hybrid` pairs with `selection-hybrid-v1`, `lexical_degraded` with
 * `selection-lexical-v1`, and no other combination is a valid response. Deriving
 * the second from the first makes the pair unbreakable by construction, and the
 * assertion below is what catches a later edit that reintroduces two independent
 * assignments — it turns that edit into a `selection_invariant_violation` before
 * a response is emitted rather than into a payload a consumer has to distrust.
 */
function selectionScoringFor(mode: SelectionMode): SelectionScoringPolicyVersion {
  const scoring = scoringPolicyVersionFor(mode);
  assertSelectionScoringPairing(mode, scoring);
  return scoring;
}

/**
 * Turns a plan and the outcomes of its reads into the answer a consumer gets.
 *
 * Synchronous and total, and both properties are the point of this step
 * existing separately. Delivery holds no port, awaits nothing, and cannot cause
 * a read: by the time it runs, every access this query was going to make has
 * already happened. What is left is judgement about presentation — which chunks
 * survive fusion, deduplication and the budget, and how the losses are reported
 * — and that judgement is now testable without a search of any kind standing in.
 *
 * The whole response is built in memory and returned as one value. Nothing is
 * emitted incrementally, so there is no state in which a consumer has received
 * half an answer and then a failure: either this returns a complete
 * `ContextResolution`, or it throws and a surface reports a `ResolveContextError`
 * instead of a payload.
 *
 * An outcome for a target no item planned is ignored rather than refused. The
 * executor may legitimately answer for targets it was given in one batch across
 * several plans, and an answer nobody asked for costs nothing to drop.
 */
export function assembleContext(
  plan: SelectionPlan,
  outcomes: readonly ManagedResolutionOutcome[],
  options: AssembleContextOptions = {},
): ContextResolution {
  const budget = options.budget ?? DEFAULT_CONTEXT_BUDGET;
  const byTargetKey = indexOutcomes(outcomes);

  const candidates: ContextCandidate[] = [];
  for (const item of plan.items) {
    if (!isManagedPlannedItem(item)) {
      continue;
    }
    const outcome = byTargetKey.get(item.execution.targetKey);
    if (outcome?.status !== "fulfilled") {
      continue;
    }
    for (const chunk of outcome.chunks) {
      candidates.push({
        // Stamped on here because an executor answers per target and cannot
        // know which item the target was planned for. Assembly and the split
        // back into items both depend on it.
        itemKey: item.itemKey,
        scopeRef: item.guide.scopeRef,
        rank: chunk.rank,
        chunkId: chunk.chunkId,
        chunkRevisionId: chunk.chunkRevisionId,
        semanticUnitId: chunk.semanticUnitId,
        documentId: chunk.documentId,
        contentDigest: chunk.contentDigest,
        text: chunk.text,
      });
    }
  }

  const assembled = assembleDocumentContext(candidates, budget);
  const chunksByItem = groupBy(
    rankContext(assembled.chunks),
    (entry) => entry.itemKey,
  );
  const omissionsByItem = groupBy(
    assembled.omitted.map((omitted) => ({
      itemKey: omitted.chunk.itemKey,
      omission: toContextOmission(omitted),
    })),
    (entry) => entry.itemKey,
  );

  return {
    query: plan.query,
    policy: {
      payloadSchemaVersion: 3,
      scoring: selectionScoringFor(plan.summary.mode),
      ranking: SELECTION_RANKING_POLICY_VERSION,
      planning: SELECTION_PLANNING_POLICY_VERSION,
      fusion: CONTEXT_FUSION_POLICY_VERSION,
      assembly: CONTEXT_ASSEMBLY_POLICY_VERSION,
      // Copied field by field rather than aliased, for the reason
      // `buildRetrievalGuide` copies `columns` and `semanticUnitIds`: a value
      // handed to a consumer must not be a live window onto someone else's
      // object — here either the caller's own options or, when none were given,
      // the shared `DEFAULT_CONTEXT_BUDGET` constant. Named fields rather than
      // a spread, so a field added to `ContextBudget` has to be considered here
      // instead of being carried across unnoticed.
      budget: {
        maxTotalCharacters: budget.maxTotalCharacters,
        maxChunks: budget.maxChunks,
      },
    },
    selection: summarizeSelection(plan),
    items: plan.items.map((item) =>
      buildItem(item, byTargetKey, chunksByItem, omissionsByItem),
    ),
  };
}

/**
 * Numbers the surviving chunks 1, 2, 3 … in the order assembly left them.
 *
 * The one place `contextRank` is assigned, and it runs over the whole response
 * before anything is split back into items. Numbering per item instead would
 * give two items a chunk each called rank 1, which is not a rank at all: the
 * point of the field is that a consumer can order two chunks that landed in
 * different items against one another.
 *
 * The order is taken as given rather than re-derived. `assembleDocumentContext`
 * has already fused every target's positions into one ranking, dropped the
 * repeats and cut to the budget, so its output order *is* the answer's order —
 * re-sorting here would be a second ranking rule that could disagree with the
 * one the policy version names.
 *
 * This is also the projection boundary. Everything above it works in
 * `ContextChunk`, which carries `itemKey`, the best per-target `rank` and the
 * fused `score`; everything below receives `RetrievedDocumentChunk`, which
 * carries none of the three. Keeping the two types apart is what stops an
 * internal ordering signal from reaching a consumer by being spread into a
 * response object.
 */
function rankContext(
  chunks: readonly ContextChunk[],
): readonly RankedContextChunk[] {
  return chunks.map((chunk, index) => ({
    itemKey: chunk.itemKey,
    chunk: {
      contextRank: index + 1,
      chunkId: chunk.chunkId,
      chunkRevisionId: chunk.chunkRevisionId,
      semanticUnitId: chunk.semanticUnitId,
      documentId: chunk.documentId,
      text: chunk.text,
      contentDigest: chunk.contentDigest,
    },
  }));
}

/** One projected chunk, with the item it has to be filed under still attached. */
interface RankedContextChunk {
  readonly itemKey: string;
  readonly chunk: RetrievedDocumentChunk;
}

/**
 * Reduces the plan's own selection record to what a consumer receives.
 *
 * The plan carries every candidate's score and every verdict's findings; a
 * response carries the admitted Cards and three counts. That gap is the point.
 * A consumer needs to know which Cards answered and whether the catalog had more
 * to say, and it needs neither the score of a Card that lost nor the rule that
 * sank it — naming a rejected Card would publish which questions the catalog
 * declines to answer, which is a map of the catalog drawn one query at a time.
 * The counts stay because a bare empty `selected` cannot tell an empty catalog
 * from a strict threshold, and that is the one thing a caller can act on.
 *
 * `selected` walks `outcomes` rather than the plan's items, so it is in rank
 * order and lists every admitted Card — including one whose Scopes all merged
 * into an item another Card also selected.
 */
function summarizeSelection(plan: SelectionPlan): SelectionSummary {
  const selected: ApprovedCardReference[] = [];
  let admitted = 0;
  let deferred = 0;
  let rejected = 0;

  for (const outcome of plan.summary.selection.outcomes) {
    switch (outcome.verdict) {
      case "admit":
        admitted += 1;
        selected.push({ cardId: outcome.cardId, versionId: outcome.versionId });
        break;
      case "defer":
        deferred += 1;
        break;
      default:
        rejected += 1;
        break;
    }
  }

  const counts: SelectionCounts = { admitted, deferred, rejected };
  return { mode: plan.summary.mode, selected, counts };
}

/**
 * Indexes the outcomes and checks each failure is one Delivery may repeat.
 *
 * Validation happens once here rather than at the point each item is built, so
 * a malformed outcome for a target no item ended up using cannot slip through
 * on the strength of nobody having read it.
 */
function indexOutcomes(
  outcomes: readonly ManagedResolutionOutcome[],
): ReadonlyMap<string, ManagedResolutionOutcome> {
  const byTargetKey = new Map<string, ManagedResolutionOutcome>();

  for (const outcome of outcomes) {
    if (outcome.status === "failed") {
      assertOpaqueFailure(outcome.failure);
    }
    byTargetKey.set(outcome.targetKey, outcome);
  }

  return byTargetKey;
}

function buildItem(
  item: PlannedResolutionItem,
  byTargetKey: ReadonlyMap<string, ManagedResolutionOutcome>,
  chunksByItem: ReadonlyMap<string, readonly RankedContextChunk[]>,
  omissionsByItem: ReadonlyMap<
    string,
    readonly { readonly omission: ContextOmission }[]
  >,
): ContextResolutionItem {
  if (!isManagedPlannedItem(item)) {
    return {
      selectedBy: item.selectedBy,
      guide: item.guide,
      fulfillment: { status: "delegated", executor: "consumer" },
    };
  }

  const outcome = byTargetKey.get(item.execution.targetKey);
  if (outcome?.status === "failed") {
    return {
      selectedBy: item.selectedBy,
      guide: item.guide,
      fulfillment: {
        status: "failed",
        executor: "contextctl",
        failure: outcome.failure,
      },
    };
  }

  // A target with no outcome at all resolves to an empty context rather than
  // throwing. It means the executor answered for fewer targets than the plan
  // named, which is our own bookkeeping slipping; dropping the whole answer
  // over it would be a worse outcome than an item that honestly reports
  // nothing, and the item is still visibly present for anyone comparing the
  // response against the Cards that produced it.
  return {
    selectedBy: item.selectedBy,
    guide: item.guide,
    fulfillment: {
      status: "fulfilled",
      executor: "contextctl",
      context: contextFor(
        (chunksByItem.get(item.itemKey) ?? []).map((entry) => entry.chunk),
        (omissionsByItem.get(item.itemKey) ?? []).map((entry) => entry.omission),
      ),
    },
  };
}

/**
 * `truncated` is derived from this item's own omissions, not from the response
 * as a whole: an item that kept everything it retrieved must not be marked
 * clipped because a different item ran out of budget.
 *
 * Only `budget_exhausted` sets it. A chunk dropped as a repeat cost the answer
 * nothing — the surviving copy says the same thing, and in the
 * `duplicate_chunk_revision` case it is literally the same chunk revision — so
 * reporting a deduplicated item as clipped would tell a consumer to widen a
 * budget that was never the constraint.
 */
function contextFor(
  chunks: readonly RetrievedDocumentChunk[],
  omitted: readonly ContextOmission[],
): RetrievedDocumentContext {
  return {
    contentTrust: "untrusted",
    chunks,
    omitted,
    truncated: omitted.some(
      (omission) => omission.reason === "budget_exhausted",
    ),
  };
}

function groupBy<T>(
  values: readonly T[],
  keyOf: (value: T) => string,
): ReadonlyMap<string, readonly T[]> {
  const grouped = new Map<string, T[]>();

  for (const value of values) {
    const key = keyOf(value);
    const bucket = grouped.get(key);
    if (bucket === undefined) {
      grouped.set(key, [value]);
    } else {
      bucket.push(value);
    }
  }

  return grouped;
}
