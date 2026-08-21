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
  ManagedFulfillmentFailure,
  RetrievedDocumentChunk,
  RetrievedDocumentContext,
  SelectionCounts,
  SelectionSummary,
} from "../domain/context-resolution.js";
import { ManagedResolutionInvariantError } from "../domain/errors.js";
import {
  assertOpaqueFailure,
  type ManagedResolutionFailure,
  type ManagedResolutionOutcome,
  type ResolvedDocumentChunk,
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
  verifySelectionPlan,
  type ApprovedCardReference,
  type PlannedManagedItem,
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
 * Before anything is fused, every outcome is held against the plan that asked
 * for it (SOT L1534, L1637, L1639). Two kinds of defect are told apart by where
 * they are reported. An outcome that cannot be matched to the plan at all — a
 * target nobody planned, a target answered twice — is a fault in the
 * bookkeeping between Selection, the executor and this step, and it refuses the
 * whole assembly, because there is no item it could honestly be charged to. An
 * outcome that matches its item but does not hold together — too many hits,
 * ranks with gaps, an empty text — fails *that item* as
 * `resolution_outcome_invalid` and leaves every other item standing. The second
 * rule is the one a consumer feels: one broken read costs one Scope, never the
 * answer.
 */
export function assembleContext(
  plan: SelectionPlan,
  outcomes: readonly ManagedResolutionOutcome[],
  options: AssembleContextOptions = {},
): ContextResolution {
  const budget = options.budget ?? DEFAULT_CONTEXT_BUDGET;
  // The plan is re-verified here as well as where it was built. Assembly files
  // results by the plan's keys, so a key that no longer matches its fields
  // would file evidence under the wrong Scope; the check is cheap and the
  // plan crossed an executor boundary in between (SOT L2358).
  verifySelectionPlan(plan);
  const byTargetKey = indexOutcomes(plan, outcomes);

  const verdicts = new Map<string, ItemVerdict>();
  const candidates: ContextCandidate[] = [];
  for (const item of plan.items) {
    if (!isManagedPlannedItem(item)) {
      continue;
    }
    const verdict = judgeOutcome(item, byTargetKey.get(item.execution.targetKey));
    verdicts.set(item.itemKey, verdict);
    if (verdict.kind !== "fulfilled") {
      continue;
    }
    for (const chunk of verdict.chunks) {
      candidates.push({
        // Stamped on here because an executor answers per target and cannot
        // know which item the target was planned for. Assembly and the split
        // back into items both depend on it.
        itemKey: item.itemKey,
        targetKey: item.execution.targetKey,
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
  // A read that contradicted another read was set aside whole. The items that
  // planned it have no chunks to file and report the contradiction instead;
  // nothing else about the response changes (SOT L1534, L1639).
  for (const [itemKey, verdict] of verdicts) {
    if (verdict.kind === "fulfilled" && assembled.failedTargetKeys.includes(verdict.targetKey)) {
      verdicts.set(itemKey, { kind: "failed", failure: ASSEMBLY_FAILURE });
    }
  }
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
      buildItem(item, verdicts, chunksByItem, omissionsByItem),
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
 * Indexes the outcomes by target and refuses any the plan cannot account for.
 *
 * Validation happens once here rather than at the point each item is built, so
 * a malformed outcome for a target nobody ended up reading cannot slip through
 * on the strength of nobody having looked at it.
 *
 * An outcome for a target the plan never named is refused, not dropped (SOT
 * L1637: "알 수 없는 결과 … 조립 실패로 처리하며 다른 Guide에 귀속시키지
 * 않는다"). It used to be ignored on the theory that an executor might answer
 * for several plans in one batch; but an answer nobody asked for is evidence
 * that the executor and this step disagree about which reads happened, and an
 * assembly that quietly discards that evidence is an assembly that cannot tell
 * a stray answer from a misrouted one. There is no item it could be charged to,
 * so it is refused at request level.
 *
 * A target answered twice is refused for the same reason (SOT L1637: "중복
 * 대상 … 조립 실패"). `Map.set` used to let the later answer overwrite the
 * earlier one, which made "which of two answers did the consumer get" depend on
 * the executor's array order — and an executor that answers one read twice has
 * lost track of which read it performed, so neither copy is the one to keep.
 */
function indexOutcomes(
  plan: SelectionPlan,
  outcomes: readonly ManagedResolutionOutcome[],
): ReadonlyMap<string, ManagedResolutionOutcome> {
  const planned = new Set<string>();
  for (const item of plan.items) {
    if (isManagedPlannedItem(item)) {
      planned.add(item.execution.targetKey);
    }
  }

  const byTargetKey = new Map<string, ManagedResolutionOutcome>();
  for (const outcome of outcomes) {
    if (outcome.status === "failed") {
      assertOpaqueFailure(outcome.failure);
    }
    if (!planned.has(outcome.targetKey)) {
      throw new ManagedResolutionInvariantError(
        `outcome for target ${outcome.targetKey} matches no planned read`,
      );
    }
    if (byTargetKey.has(outcome.targetKey)) {
      throw new ManagedResolutionInvariantError(
        `target ${outcome.targetKey} was answered more than once`,
      );
    }
    byTargetKey.set(outcome.targetKey, outcome);
  }

  return byTargetKey;
}

/**
 * What one managed item's outcome amounts to, once it has been held against the
 * plan: either chunks assembly may fuse, or a failure the item reports as-is.
 */
type ItemVerdict =
  | {
      readonly kind: "fulfilled";
      readonly targetKey: string;
      readonly chunks: readonly ResolvedDocumentChunk[];
    }
  | { readonly kind: "failed"; readonly failure: ManagedFulfillmentFailure };

/**
 * Decides, for one planned read, whether its outcome may enter assembly.
 *
 * Three outcomes are failures and each says why. A read the executor never
 * answered for is not "a document with nothing in it" — nobody looked — so it
 * fails in assembly rather than reporting an empty context (SOT L1534: "Plan↔
 * 결과 1:1 대응"). A read the executor failed is reported in the executor's own
 * words. A read the executor fulfilled is checked against the plan's bound and
 * against its own internal consistency before a single chunk of it is trusted
 * (SOT L1639), and fails as `resolution_outcome_invalid` if it does not hold.
 */
function judgeOutcome(
  item: PlannedManagedItem,
  outcome: ManagedResolutionOutcome | undefined,
): ItemVerdict {
  if (outcome === undefined) {
    return { kind: "failed", failure: ASSEMBLY_FAILURE };
  }
  if (outcome.status === "failed") {
    return { kind: "failed", failure: toFulfillmentFailure(outcome.failure) };
  }
  if (!outcomeHoldsTogether(item.guide.limit, outcome.chunks)) {
    return { kind: "failed", failure: ASSEMBLY_FAILURE };
  }
  return {
    kind: "fulfilled",
    targetKey: item.execution.targetKey,
    chunks: outcome.chunks,
  };
}

/**
 * The checks SOT L1639 names for a fulfilled outcome, and nothing beyond them.
 *
 * - at most `limit` hits: the bound travelled on the guide and the target
 *   alike, and an executor that returned more has read past what was planned;
 * - `rank` is exactly the integers `1..N` with no gap and no repeat: a rank is a
 *   position in this target's own answer, and an answer with two third places
 *   or none has no order to fuse;
 * - `chunkRevisionId` is unique within the target: one revision is one chunk,
 *   and a target listing it twice is reporting one read as two;
 * - every identifier, the text and the digest are non-empty: an empty citation
 *   cannot be checked against anything, and an empty text cannot be evidence.
 *
 * A boolean rather than a reason, on purpose. The reason is operator-facing
 * diagnosis and the SOT keeps that off the consumer response; what the item
 * reports is the one code that says "do not trust this", and that is enough.
 */
function outcomeHoldsTogether(
  limit: number,
  chunks: readonly ResolvedDocumentChunk[],
): boolean {
  if (chunks.length > limit) {
    return false;
  }

  const ranks = new Set<number>();
  const revisions = new Set<string>();
  for (const chunk of chunks) {
    if (
      !Number.isSafeInteger(chunk.rank) ||
      chunk.rank < 1 ||
      chunk.rank > chunks.length ||
      ranks.has(chunk.rank)
    ) {
      return false;
    }
    ranks.add(chunk.rank);

    if (revisions.has(chunk.chunkRevisionId)) {
      return false;
    }
    revisions.add(chunk.chunkRevisionId);

    if (
      chunk.chunkId.length === 0 ||
      chunk.chunkRevisionId.length === 0 ||
      chunk.semanticUnitId.length === 0 ||
      chunk.documentId.length === 0 ||
      chunk.text.length === 0 ||
      chunk.contentDigest.length === 0
    ) {
      return false;
    }
  }
  // N distinct ranks all inside [1, N] is exactly 1..N.
  return true;
}

function buildItem(
  item: PlannedResolutionItem,
  verdicts: ReadonlyMap<string, ItemVerdict>,
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

  const verdict = verdicts.get(item.itemKey);
  if (verdict === undefined) {
    // Unreachable: every managed item was judged above. Refused rather than
    // defaulted, because a default here would be a fourth way to produce an
    // item that nobody decided on.
    throw new ManagedResolutionInvariantError(
      `planned item ${item.itemKey} was never judged`,
    );
  }
  if (verdict.kind === "failed") {
    return failedItem(item, verdict.failure);
  }

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
 * One managed item that produced no context, with the reason attached.
 *
 * The one constructor for a `failed` item, so every failure — the executor's,
 * the deadline's and assembly's own — leaves through the same door and carries
 * the same shape. An item fails on its own: nothing here touches any other
 * item, which is what lets one broken read leave the rest of the answer
 * standing (SOT L1639).
 */
function failedItem(
  item: PlannedManagedItem,
  failure: ManagedFulfillmentFailure,
): ContextResolutionItem {
  return {
    selectedBy: item.selectedBy,
    guide: item.guide,
    fulfillment: { status: "failed", executor: "contextctl", failure },
  };
}

/**
 * The failure assembly itself reports, for a read whose answer cannot be
 * trusted as it stands.
 *
 * One code and one flag, fixed. `resolution_outcome_invalid` is not retriable
 * because nothing about retrying changes what was already answered: the
 * executor would have to answer differently, and a consumer cannot make it.
 * The SOT names this exact pair (L1639, L2457-2461).
 */
const ASSEMBLY_FAILURE: ManagedFulfillmentFailure = {
  stage: "assembly",
  code: "resolution_outcome_invalid",
  retriable: false,
};

/**
 * Projects the executor's failure into the one a consumer receives.
 *
 * `managed_search` crosses as stated — code and flag untouched, for the reason
 * `assertOpaqueFailure` gives. `deadline` is checked rather than copied: the
 * SOT fixes a deadline to `deadline_exceeded` and `retriable: true` (L2370),
 * so an executor reporting a deadline under any other code has confused two
 * different facts, and projecting its wording would put that confusion in
 * front of a consumer. That is our translation step's bug, not a failure mode
 * of the read, which is why it is refused as an invariant rather than reported
 * as an item.
 */
function toFulfillmentFailure(
  failure: ManagedResolutionFailure,
): ManagedFulfillmentFailure {
  switch (failure.stage) {
    case "managed_search":
      return {
        stage: "managed_search",
        code: failure.code,
        retriable: failure.retriable,
      };
    case "deadline":
      if (failure.code !== "deadline_exceeded" || failure.retriable !== true) {
        throw new ManagedResolutionInvariantError(
          `a deadline failure must be deadline_exceeded and retriable, received ${failure.code} with retriable ${String(failure.retriable)}`,
        );
      }
      return { stage: "deadline", code: "deadline_exceeded", retriable: true };
  }
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
