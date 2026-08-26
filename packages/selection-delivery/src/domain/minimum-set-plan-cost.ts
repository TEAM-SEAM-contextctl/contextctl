import type { ApprovedCard } from "./card-catalog.js";
import { canonicalJson } from "./canonical-digest.js";
import {
  isManagedPlannedItem,
  planSelectedScopes,
} from "./selection-plan.js";
import { utf8ByteLength } from "./transport-policy.js";

export interface PlanCost {
  readonly managedTargetCount: number;
  readonly managedChunkLimitTotal: number;
  readonly delegatedItemCount: number;
  readonly guideBytes: number;
  readonly selectedByTotal: number;
  readonly cardCount: number;
}

const PLAN_COST_KEYS = [
  "managedTargetCount",
  "managedChunkLimitTotal",
  "delegatedItemCount",
  "guideBytes",
  "selectedByTotal",
  "cardCount",
] as const satisfies readonly (keyof PlanCost)[];

const EXECUTION_COST_KEYS = [
  "managedTargetCount",
  "managedChunkLimitTotal",
  "delegatedItemCount",
  "guideBytes",
] as const satisfies readonly (keyof PlanCost)[];

export function measurePlanCost(
  cards: readonly ApprovedCard[],
  chunkLimitPerScope: number,
): PlanCost {
  const plan = planSelectedScopes(cards, chunkLimitPerScope);
  return measurePreparedPlanCost(cards.length, plan);
}

/**
 * Computes every one-Card removal delta from one prepared Scope plan.
 *
 * Replanning once per candidate makes reverse greedy planning quadratic in
 * expensive guide construction. An item disappears exactly when the removed
 * Card is its sole `selectedBy`; otherwise only one attribution disappears.
 * That lets all exact deltas be derived from the current merged plan in one
 * pass without approximating shared Scopes or managed target costs.
 */
export function measureCardRemovalSavings(
  cards: readonly ApprovedCard[],
  chunkLimitPerScope: number,
): ReadonlyMap<string, PlanCost> {
  const plan = planSelectedScopes(cards, chunkLimitPerScope);
  const mutable = new Map(
    cards.map((card) => [card.versionId, emptyRemovalSavings()]),
  );
  const managedTargetByKey = new Map(
    plan.managedTargets.map((target) => [target.targetKey, target]),
  );
  const managedItemCountByTargetKey = new Map<string, number>();
  for (const item of plan.items) {
    if (!isManagedPlannedItem(item)) continue;
    managedItemCountByTargetKey.set(
      item.execution.targetKey,
      (managedItemCountByTargetKey.get(item.execution.targetKey) ?? 0) + 1,
    );
  }
  const removedManagedTargets = new Map<string, Set<string>>();

  for (const item of plan.items) {
    for (const reference of item.selectedBy) {
      const savings = mutable.get(reference.versionId);
      if (savings !== undefined) savings.selectedByTotal += 1;
    }
    if (item.selectedBy.length !== 1) continue;
    const only = item.selectedBy[0];
    const savings = only === undefined ? undefined : mutable.get(only.versionId);
    if (savings === undefined) continue;
    savings.guideBytes += utf8ByteLength(canonicalJson(item.guide));
    if (!isManagedPlannedItem(item)) {
      savings.delegatedItemCount += 1;
      continue;
    }
    let targetKeys = removedManagedTargets.get(only.versionId);
    if (targetKeys === undefined) {
      targetKeys = new Set<string>();
      removedManagedTargets.set(only.versionId, targetKeys);
    }
    if (targetKeys.has(item.execution.targetKey)) continue;
    if (managedItemCountByTargetKey.get(item.execution.targetKey) !== 1) {
      continue;
    }
    const target = managedTargetByKey.get(item.execution.targetKey);
    if (target === undefined) continue;
    targetKeys.add(item.execution.targetKey);
    savings.managedTargetCount += 1;
    savings.managedChunkLimitTotal += target.limit;
  }

  return new Map(
    [...mutable].map(([versionId, savings]) => [
      versionId,
      { ...savings, cardCount: 1 } satisfies PlanCost,
    ]),
  );
}

function measurePreparedPlanCost(
  cardCount: number,
  plan: ReturnType<typeof planSelectedScopes>,
): PlanCost {
  return {
    managedTargetCount: plan.managedTargets.length,
    managedChunkLimitTotal: plan.managedTargets.reduce(
      (total, target) => total + target.limit,
      0,
    ),
    delegatedItemCount: plan.items.filter(
      (item) => !isManagedPlannedItem(item),
    ).length,
    guideBytes: plan.items.reduce(
      (total, item) => total + utf8ByteLength(canonicalJson(item.guide)),
      0,
    ),
    selectedByTotal: plan.items.reduce(
      (total, item) => total + item.selectedBy.length,
      0,
    ),
    cardCount,
  };
}

function emptyRemovalSavings(): {
  managedTargetCount: number;
  managedChunkLimitTotal: number;
  delegatedItemCount: number;
  guideBytes: number;
  selectedByTotal: number;
} {
  return {
    managedTargetCount: 0,
    managedChunkLimitTotal: 0,
    delegatedItemCount: 0,
    guideBytes: 0,
    selectedByTotal: 0,
  };
}

export function comparePlanCost(left: PlanCost, right: PlanCost): number {
  return compareByKeys(left, right, PLAN_COST_KEYS);
}

/** Attribution and Card counts are observations, not execution savings. */
export function compareExecutionCost(left: PlanCost, right: PlanCost): number {
  return compareByKeys(left, right, EXECUTION_COST_KEYS);
}

export function subtractPlanCost(before: PlanCost, after: PlanCost): PlanCost {
  return {
    managedTargetCount:
      before.managedTargetCount - after.managedTargetCount,
    managedChunkLimitTotal:
      before.managedChunkLimitTotal - after.managedChunkLimitTotal,
    delegatedItemCount: before.delegatedItemCount - after.delegatedItemCount,
    guideBytes: before.guideBytes - after.guideBytes,
    selectedByTotal: before.selectedByTotal - after.selectedByTotal,
    cardCount: before.cardCount - after.cardCount,
  };
}

/** Sorts greater execution savings before smaller savings. */
export function compareExecutionSavings(
  left: PlanCost,
  right: PlanCost,
): number {
  return compareByKeys(right, left, EXECUTION_COST_KEYS);
}

function compareByKeys(
  left: PlanCost,
  right: PlanCost,
  keys: readonly (keyof PlanCost)[],
): number {
  for (const key of keys) {
    const difference = left[key] - right[key];
    if (difference !== 0) return difference;
  }
  return 0;
}
