import type { ApprovedCard, ApprovedScopeReference } from "./card-catalog.js";
import { canonicalDigest } from "./canonical-digest.js";
import { SelectionScopeInvariantError } from "./errors.js";
import type { SelectionMode } from "./hybrid-ranking.js";
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
