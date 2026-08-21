import type { ApprovedCard, ApprovedScopeReference } from "./card-catalog.js";
import { canonicalDigest, canonicalJson } from "./canonical-digest.js";
import {
  SelectionPlanInvariantError,
  SelectionScopeInvariantError,
} from "./errors.js";
import type { SelectionMode } from "./hybrid-ranking.js";
import {
  assertValidPolicyContext,
  type PolicyContext,
  type PolicyExclusion,
} from "./policy-context.js";
import type { CandidateScore } from "./query-scoring.js";
import {
  buildRetrievalGuide,
  retrievalGuideKey,
  type HttpRetrievalGuide,
  type ManagedDocumentGuide,
  type RetrievalGuide,
  type SqlRetrievalGuide,
} from "./retrieval-guide.js";
import type { SelectionResult } from "./selection-verdict.js";

/**
 * Identifies the rules that turn admitted Cards into items and reads.
 *
 * Named separately from the ranking policy because the two change for different
 * reasons and a consumer comparing two responses has to be able to tell which
 * one moved: ranking decides which Cards answer, planning decides how their
 * Scopes are merged into items and which reads that costs. A single Scope
 * authorised by two Cards became one item under this version and could become
 * two under another, without any Card's verdict changing.
 */
export const SELECTION_PLANNING_POLICY_VERSION = "selection-planning-v1" as const;

/**
 * The absolute ceilings of `selection-planning-v1`, which no caller can raise.
 *
 * A plan is a read plan, and each ceiling bounds one dimension of what a
 * single query may cause: how many Cards may answer it, how many items the
 * answer may carry, how many managed reads it may issue, how many chunks each
 * read may return, how many Card–item associations travel in `selectedBy`, and
 * how many bytes of public guide the answer may serialize. They are stated as
 * one record so that raising any of them is a change to the policy version
 * rather than to a number somebody found in a function.
 *
 * `guideBytes` is measured over RFC 8785 canonical JSON in UTF-8, summed across
 * every item's public guide — the bytes the guides actually occupy on the wire,
 * not a character count that would undercount anything outside ASCII.
 *
 * The values are the SOT's (L1470): 32 / 128 / 64 / 8 / 256 / 64 KiB.
 */
export const SELECTION_PLANNING_LIMITS = {
  admittedCards: 32,
  items: 128,
  managedTargets: 64,
  chunksPerTarget: 8,
  selectedByTotal: 256,
  guideBytes: 64 * 1024,
} as const;

export type SelectionPlanningLimit = keyof typeof SELECTION_PLANNING_LIMITS;

/** One ceiling a plan crossed, with the number it reached. */
export interface PlanningLimitViolation {
  readonly limit: SelectionPlanningLimit;
  readonly allowed: number;
  readonly actual: number;
}

/**
 * What one query selected, and what still has to be executed to answer it.
 *
 * A plan is a value, not a result: it names reads without performing any, so it
 * can be produced without a search port anywhere in this package and handed to
 * whoever is entitled to execute it. That is the whole shape of the pipeline —
 * Selection plans, the Composition Root executes, Delivery assembles — and each
 * of the three can be tested without standing in the other two.
 *
 * It never leaves the process it was built in. `managedTargets` in particular
 * is bookkeeping between Selection and the executor, and serializing it would
 * publish the read plan of a query to whoever received the answer.
 */
export interface SelectionPlan {
  /** Echoed exactly as received, so a caller can pair result with request. */
  readonly query: string;
  readonly summary: SelectionPlanSummary;
  readonly items: readonly PlannedResolutionItem[];
  /**
   * Every distinct managed read this plan requires, once each.
   *
   * Distinct by `targetKey`, so two items that authorise the same Scope under
   * the same bound produce one read rather than two. An empty list is a
   * complete plan and not a degenerate one: a query may select only SQL and
   * HTTP Scopes, or none at all.
   */
  readonly managedTargets: readonly ManagedDocumentResolutionTarget[];
}

/**
 * What the selection saw and what it decided.
 *
 * Both halves travel because they answer different questions — "what was looked
 * at" and "what was decided" — and a consumer that receives only the second
 * cannot tell a narrow catalog from a strict threshold.
 */
export interface SelectionPlanSummary {
  readonly candidates: readonly CandidateScore[];
  readonly selection: SelectionResult;
  /**
   * Which scoring family produced `candidates`.
   *
   * Recorded on the plan rather than recomputed at assembly, because by the time
   * a response is built the evidence is gone: a hybrid run whose Cards all
   * happened to score on lexical signals alone is indistinguishable, from the
   * numbers, from a degraded one. Only the step that had the ports knows which
   * it was, so it says so once and the response transcribes it.
   */
  readonly mode: SelectionMode;
  /**
   * The policy this selection ran under and the Cards it kept out of scoring.
   *
   * On the plan and not on the response: the response's counts describe the
   * Cards that were evaluated, and a Card the policy excluded was not (SOT
   * L2486). The exclusions are named here so that an operator reading the plan
   * can tell a Card the policy refused from a Card the threshold rejected —
   * the two look identical from the outside, and only one of them is a
   * question about the catalog.
   */
  readonly policy: SelectionPolicySummary;
}

/** Which policy applied, and what it decided before any score existed. */
export interface SelectionPolicySummary {
  readonly context: PolicyContext;
  /** Cards kept out before scoring, in catalog order. Empty when none were. */
  readonly excluded: readonly PolicyExclusion[];
}

/**
 * One read to perform, reduced to the three fields that identify and bound it.
 *
 * There is no `connectorId`, no `accessHandle` and no `securityDomain` here.
 * The first two are absent from the approved read model itself, so this target
 * could not name them if it wanted to; the third is the executor's own to state.
 * Either way the property is the same one, and it is structural rather than an
 * omission to be reviewed. A Scope
 * reference plus a bound is everything an executor needs to look the physical
 * binding up for itself under its own authority; handing it one instead would
 * make Selection the party that decided which store is read and under whose
 * isolation, which is a security judgement Selection is in no position to make.
 */
export interface ManagedDocumentResolutionTarget {
  readonly targetKey: string;
  readonly scopeRef: ApprovedScopeReference;
  readonly limit: number;
}

/**
 * One Scope this query selected, with every Card that selected it.
 *
 * `execution` is a state rather than a flag, and it carries exactly what that
 * state needs: a managed document names the target whose outcome completes it,
 * while a SQL or HTTP Scope is handed to the consumer and has no outcome of
 * ours to wait for. Two things are unrepresentable at compile time as a result —
 * a managed document with no target, and a delegated Scope carrying one.
 */
export type PlannedResolutionItem = PlannedManagedItem | PlannedDelegatedItem;

/** One read this process performs, and the target whose outcome completes it. */
export interface PlannedManagedItem {
  readonly itemKey: string;
  readonly selectedBy: SelectedByList;
  readonly guide: ManagedDocumentGuide;
  readonly execution: { readonly kind: "managed"; readonly targetKey: string };
}

/** One coordinate handed to the consumer. Nothing of ours executes it. */
export interface PlannedDelegatedItem {
  readonly itemKey: string;
  readonly selectedBy: SelectedByList;
  readonly guide: SqlRetrievalGuide | HttpRetrievalGuide;
  readonly execution: { readonly kind: "delegated" };
}

/**
 * Whether this item names a read we perform.
 *
 * A predicate rather than an inline `item.execution.kind === "managed"` because
 * TypeScript narrows a union on a direct discriminant only: `execution` is one
 * property deeper, so the comparison alone leaves `guide` at the full union and
 * every use of it needs a cast. The predicate states the correspondence once,
 * in the file that declares both halves of it.
 */
export function isManagedPlannedItem(
  item: PlannedResolutionItem,
): item is PlannedManagedItem {
  return item.execution.kind === "managed";
}

/**
 * At least one Card, always.
 *
 * A non-empty tuple rather than a plain array: an item exists because a Card
 * selected it, so an empty `selectedBy` is not a sparse record but a
 * contradiction, and the type says so instead of a test having to.
 */
export type SelectedByList = readonly [
  ApprovedCardReference,
  ...ApprovedCardReference[],
];

/** Which Card Version selected a Scope. */
export interface ApprovedCardReference {
  readonly cardId: string;
  readonly versionId: string;
}

/**
 * The identity of one managed read: the canonical digest of what bounds it.
 *
 * Over the Scope reference and the bound alone, which is exactly the tuple an
 * executor is given. Deriving it from the guide instead would make the key
 * depend on fields the executor never receives, and it could then neither
 * reproduce the key nor verify the one it was handed.
 */
export function managedTargetKey(
  scopeRef: ApprovedScopeReference,
  limit: number,
): string {
  return canonicalDigest({
    scopeId: scopeRef.scopeId,
    scopeVersion: scopeRef.scopeVersion,
    limit,
  });
}

/**
 * Turns the admitted Cards into the items and reads one answer needs.
 *
 * Merging is the behaviour worth stating. Two admitted Cards that authorise the
 * same Scope under the same bound produce one item carrying both Cards, not two
 * items carrying the same evidence twice. Before this, a consumer received the
 * same chunks once per Card that happened to point at the document and had no
 * way to tell that from a document genuinely saying the same thing twice.
 *
 * Merging is by the whole guide, and that is also where the one refusal lives.
 * A Scope reference — `(scopeId, scopeVersion)` — names exactly one immutable
 * definition, so two Cards that carry the same reference must carry the same
 * guide. When they do not, the catalog is contradicting itself about what the
 * Scope *is*: a different selector, a different index snapshot, a different
 * table or path under one name. Picking either definition would widen one
 * Card's access to whatever the other Card was approved for, so neither is
 * picked and the request fails as a whole (SOT L1635, "중복 제거 우선순위를
 * 정하지 않고 요청 단위 `selection_invariant_violation`으로 실패한다").
 *
 * `admitted` arrives in ranked order, so first appearance is rank order and
 * `selectedBy` inherits it by construction. That ordering is total already —
 * `judgeCandidates` breaks a score tie on `versionId` — so the "ties by cardId
 * then versionId" rule is satisfied without a second sort that could disagree
 * with the ranking it is meant to refine.
 */
export function planSelectedScopes(
  admitted: readonly ApprovedCard[],
  limit: number,
): {
  readonly items: readonly PlannedResolutionItem[];
  readonly managedTargets: readonly ManagedDocumentResolutionTarget[];
} {
  const byItemKey = new Map<string, MutableItem>();
  const itemKeyByScopeRef = new Map<string, string>();
  const targets = new Map<string, ManagedDocumentResolutionTarget>();

  for (const card of admitted) {
    for (const scope of card.scopes) {
      const guide = buildRetrievalGuide(scope, limit);
      const itemKey = retrievalGuideKey(guide);
      const existing = byItemKey.get(itemKey);

      // Checked before the merge, so a Card that contradicts an earlier Card
      // about a Scope is refused rather than filed as a second item. The key
      // is the reference alone, deliberately: that is the identity the SOT
      // says must be unique, and the guide digest is too fine to notice two
      // definitions sharing it.
      const scopeKey = scopeRefKey(guide.scopeRef);
      const knownItemKey = itemKeyByScopeRef.get(scopeKey);
      if (knownItemKey !== undefined && knownItemKey !== itemKey) {
        throw new SelectionScopeInvariantError(
          `scope ${guide.scopeRef.scopeId}@${guide.scopeRef.scopeVersion} appears with two different definitions in one catalog snapshot (card ${card.cardId} version ${card.versionId} disagrees with an earlier card)`,
        );
      }
      itemKeyByScopeRef.set(scopeKey, itemKey);

      if (existing !== undefined) {
        // Guarded rather than assumed: one Card may legitimately declare the
        // same Scope twice, and a Card counted twice in its own item's
        // `selectedBy` would misreport how many Cards agreed on it.
        if (
          !existing.selectedBy.some(
            (reference) =>
              reference.cardId === card.cardId &&
              reference.versionId === card.versionId,
          )
        ) {
          existing.selectedBy.push({
            cardId: card.cardId,
            versionId: card.versionId,
          });
        }
        continue;
      }

      byItemKey.set(itemKey, {
        itemKey,
        selectedBy: [{ cardId: card.cardId, versionId: card.versionId }],
        guide,
      });

      if (guide.kind === "managed_document") {
        const targetKey = managedTargetKey(guide.scopeRef, guide.limit);
        if (!targets.has(targetKey)) {
          targets.set(targetKey, {
            targetKey,
            scopeRef: guide.scopeRef,
            limit: guide.limit,
          });
        }
      }
    }
  }

  return {
    items: [...byItemKey.values()].map(freezeItem).sort(compareItems),
    managedTargets: [...targets.values()].sort(compareTargets),
  };
}

/**
 * Every `selection-planning-v1` ceiling the plan is over, after merging.
 *
 * Measured on the merged plan rather than on the raw Card list, because the
 * SOT bounds what a query *causes* and merging is what decides that: two
 * Cards on one Scope are one item and one read. `admittedCount` is the one
 * figure the plan itself no longer shows — admitted Cards that merged onto
 * shared items are not countable from the items — so it is handed in.
 *
 * A list rather than a boolean or a first hit, so an operator reading the
 * refusal sees every dimension that was crossed in one message instead of
 * fixing one and discovering the next. An empty list is a plan within policy.
 * Nothing is trimmed to fit: the caller either executes the plan or refuses
 * it whole, which is the SOT's rule — "Guide, selectedBy나 대상을 조용히
 * 자르지 않고 Plan 실행 전에 selection_plan_limit_exceeded로 실패한다".
 */
export function planningLimitViolations(
  admittedCount: number,
  plan: Pick<SelectionPlan, "items" | "managedTargets">,
): readonly PlanningLimitViolation[] {
  const selectedByTotal = plan.items.reduce(
    (total, item) => total + item.selectedBy.length,
    0,
  );
  const guideBytes = plan.items.reduce(
    (total, item) => total + utf8ByteLength(canonicalJson(item.guide)),
    0,
  );
  const widestTarget = plan.managedTargets.reduce(
    (widest, target) => Math.max(widest, target.limit),
    0,
  );

  const measured: readonly [SelectionPlanningLimit, number][] = [
    ["admittedCards", admittedCount],
    ["items", plan.items.length],
    ["managedTargets", plan.managedTargets.length],
    ["chunksPerTarget", widestTarget],
    ["selectedByTotal", selectedByTotal],
    ["guideBytes", guideBytes],
  ];

  return measured
    .filter(([limit, actual]) => actual > SELECTION_PLANNING_LIMITS[limit])
    .map(([limit, actual]) => ({
      limit,
      allowed: SELECTION_PLANNING_LIMITS[limit],
      actual,
    }));
}

/** UTF-8 length without `Buffer`, which this package does not otherwise touch. */
function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * Re-derives every key and every correspondence a finished plan claims, and
 * refuses the plan if any of them does not hold (SOT L2358).
 *
 * Checking the *existence* of keys is not enough: a plan whose `itemKey` was
 * computed from one guide and whose `guide` was later replaced still has a
 * key. So each key is recomputed from the fields it is defined over —
 * `itemKey` from the guide, `targetKey` from the reference and the bound — and
 * compared. Beyond the keys: every item's `selectedBy` is non-empty and free of
 * repeats, the union of all `selectedBy` is exactly the set of Cards the
 * ranking admitted (no item selected by a Card that was deferred or rejected,
 * no admitted Card that selects nothing), every managed item points at a target
 * the plan lists with the same reference and bound, every listed target is
 * pointed at, and no Scope reference appears under two definitions. When the
 * caller knows the query it was asked, the plan has to echo it byte for byte.
 *
 * Run by Selection before a plan leaves it and by Delivery before a plan is
 * assembled, so the same rules stand on both sides of the read the plan
 * authorises. Nothing here repairs a plan; a plan that fails is refused whole,
 * because the fix for a key that does not match is not a better key but a
 * plan built correctly.
 */
export function verifySelectionPlan(
  plan: SelectionPlan,
  expected: { readonly query?: string } = {},
): void {
  if (expected.query !== undefined && plan.query !== expected.query) {
    throw new SelectionPlanInvariantError(
      "plan query does not match the query it was asked",
    );
  }

  const itemKeys = new Set<string>();
  const itemKeyByScopeRef = new Map<string, string>();
  const referencedTargetKeys = new Set<string>();
  const selectedUnion = new Set<string>();

  for (const item of plan.items) {
    const itemKey = retrievalGuideKey(item.guide);
    if (itemKey !== item.itemKey) {
      throw new SelectionPlanInvariantError(
        `item ${item.itemKey} does not match the digest of its guide`,
      );
    }
    if (itemKeys.has(item.itemKey)) {
      throw new SelectionPlanInvariantError(
        `item ${item.itemKey} appears twice in one plan`,
      );
    }
    itemKeys.add(item.itemKey);

    const scopeKey = scopeRefKey(item.guide.scopeRef);
    const known = itemKeyByScopeRef.get(scopeKey);
    if (known !== undefined && known !== item.itemKey) {
      throw new SelectionPlanInvariantError(
        `scope ${item.guide.scopeRef.scopeId}@${item.guide.scopeRef.scopeVersion} appears under two definitions in one plan`,
      );
    }
    itemKeyByScopeRef.set(scopeKey, item.itemKey);

    if (item.selectedBy.length === 0) {
      throw new SelectionPlanInvariantError(
        `item ${item.itemKey} was selected by no Card`,
      );
    }
    const seenOnItem = new Set<string>();
    for (const reference of item.selectedBy) {
      const key = cardRefKey(reference);
      if (seenOnItem.has(key)) {
        throw new SelectionPlanInvariantError(
          `card ${reference.cardId} version ${reference.versionId} is listed twice on item ${item.itemKey}`,
        );
      }
      seenOnItem.add(key);
      selectedUnion.add(key);
    }

    if (isManagedPlannedItem(item)) {
      const targetKey = managedTargetKey(item.guide.scopeRef, item.guide.limit);
      if (targetKey !== item.execution.targetKey) {
        throw new SelectionPlanInvariantError(
          `item ${item.itemKey} names target ${item.execution.targetKey}, but its guide digests to ${targetKey}`,
        );
      }
      const target = plan.managedTargets.find(
        (candidate) => candidate.targetKey === targetKey,
      );
      if (
        target === undefined ||
        target.limit !== item.guide.limit ||
        target.scopeRef.scopeId !== item.guide.scopeRef.scopeId ||
        target.scopeRef.scopeVersion !== item.guide.scopeRef.scopeVersion
      ) {
        throw new SelectionPlanInvariantError(
          `item ${item.itemKey} points at target ${targetKey}, which the plan does not list with the same scope and bound`,
        );
      }
      referencedTargetKeys.add(targetKey);
    }
  }

  const targetKeys = new Set<string>();
  for (const target of plan.managedTargets) {
    if (managedTargetKey(target.scopeRef, target.limit) !== target.targetKey) {
      throw new SelectionPlanInvariantError(
        `target ${target.targetKey} does not match the digest of its scope and bound`,
      );
    }
    if (targetKeys.has(target.targetKey)) {
      throw new SelectionPlanInvariantError(
        `target ${target.targetKey} appears twice in one plan`,
      );
    }
    targetKeys.add(target.targetKey);
    if (!referencedTargetKeys.has(target.targetKey)) {
      throw new SelectionPlanInvariantError(
        `target ${target.targetKey} is listed but no item reads it`,
      );
    }
  }

  const admitted = new Set<string>();
  for (const outcome of plan.summary.selection.outcomes) {
    if (outcome.verdict === "admit") {
      admitted.add(cardRefKey(outcome));
    }
  }
  for (const key of selectedUnion) {
    if (!admitted.has(key)) {
      throw new SelectionPlanInvariantError(
        `an item is selected by ${key.replace("\u0000", " version ")}, which the ranking did not admit`,
      );
    }
  }
  for (const key of admitted) {
    if (!selectedUnion.has(key)) {
      throw new SelectionPlanInvariantError(
        `admitted ${key.replace("\u0000", " version ")} selects no item`,
      );
    }
  }

  // A Card the policy kept out must be absent from everything downstream of
  // the filter: it was never scored, so it cannot be a candidate; never
  // judged, so it cannot have a verdict; and never admitted, so it cannot
  // select an item. Each of the three is checked rather than inferred from
  // the one before, because a tampered plan can break them independently.
  assertValidPolicyContext(plan.summary.policy.context);
  const excluded = new Set(plan.summary.policy.excluded.map(cardRefKey));
  for (const candidate of plan.summary.candidates) {
    if (excluded.has(cardRefKey(candidate))) {
      throw new SelectionPlanInvariantError(
        `card ${candidate.cardId} version ${candidate.versionId} was scored although the policy excluded it`,
      );
    }
  }
  for (const outcome of plan.summary.selection.outcomes) {
    if (excluded.has(cardRefKey(outcome))) {
      throw new SelectionPlanInvariantError(
        `card ${outcome.cardId} version ${outcome.versionId} was judged although the policy excluded it`,
      );
    }
  }
  for (const key of selectedUnion) {
    if (excluded.has(key)) {
      throw new SelectionPlanInvariantError(
        `an item is selected by ${key.replace("\u0000", " version ")}, which the policy excluded`,
      );
    }
  }
}

function cardRefKey(reference: ApprovedCardReference): string {
  return `${reference.cardId}\u0000${reference.versionId}`;
}

/**
 * The reference as a map key. The two ids are joined with a separator no id
 * can contain — ids are bounded tokens without control characters — so two
 * distinct references cannot collide on the joined string.
 */
function scopeRefKey(reference: ApprovedScopeReference): string {
  return `${reference.scopeId}\u0000${reference.scopeVersion}`;
}

/** One item while `selectedBy` is still being accumulated. */
interface MutableItem {
  readonly itemKey: string;
  readonly selectedBy: ApprovedCardReference[];
  readonly guide: RetrievalGuide;
}

function freezeItem(item: MutableItem): PlannedResolutionItem {
  const [first, ...rest] = item.selectedBy;
  if (first === undefined) {
    // Unreachable: an item is created with exactly one reference and only ever
    // grows. Stated as a branch rather than a cast so the tuple type is proven
    // rather than asserted.
    throw new TypeError(`planned item ${item.itemKey} has no selecting Card`);
  }
  const selectedBy: SelectedByList = [first, ...rest];

  if (item.guide.kind === "managed_document") {
    return {
      itemKey: item.itemKey,
      selectedBy,
      guide: item.guide,
      execution: {
        kind: "managed",
        targetKey: managedTargetKey(item.guide.scopeRef, item.guide.limit),
      },
    };
  }
  return {
    itemKey: item.itemKey,
    selectedBy,
    guide: item.guide,
    execution: { kind: "delegated" },
  };
}

/**
 * scopeId, then scopeVersion, then itemKey — all ascending.
 *
 * Items are built in ranked order, which depends on the query's scores, so two
 * runs over the same catalog can list the same Scopes in a different sequence.
 * Ordering them by identity instead makes two responses directly comparable.
 * `itemKey` is the last resort rather than the first because it is a digest: it
 * orders deterministically but unreadably, and a reader scanning a response
 * should meet the Scope ids first.
 *
 * `<` / `>` rather than `localeCompare`, matching every other ordering in this
 * domain: `localeCompare` resolves against the runtime locale, and the same
 * resolution has to serialize identically on every machine.
 */
function compareItems(
  left: PlannedResolutionItem,
  right: PlannedResolutionItem,
): number {
  return (
    compareText(left.guide.scopeRef.scopeId, right.guide.scopeRef.scopeId) ||
    compareText(
      left.guide.scopeRef.scopeVersion,
      right.guide.scopeRef.scopeVersion,
    ) ||
    compareText(left.itemKey, right.itemKey)
  );
}

/** targetKey ascending; the key is the target's whole identity. */
function compareTargets(
  left: ManagedDocumentResolutionTarget,
  right: ManagedDocumentResolutionTarget,
): number {
  return compareText(left.targetKey, right.targetKey);
}

function compareText(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  return left > right ? 1 : 0;
}
