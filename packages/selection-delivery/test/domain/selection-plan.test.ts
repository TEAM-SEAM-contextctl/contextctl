import { describe, expect, it } from "vitest";

import type { ApprovedCard, ApprovedScope } from "../../src/domain/card-catalog.js";
import { canonicalDigest } from "../../src/domain/canonical-digest.js";
import {
  isManagedPlannedItem,
  managedTargetKey,
  planSelectedScopes,
} from "../../src/domain/selection-plan.js";
import {
  createPaymentApiCard,
  createPaymentsTableCard,
  createRefundPolicyCard,
} from "../fixtures/approved-card.fixture.js";

const LIMIT = 8;

function scopeOfKind<K extends ApprovedScope["kind"]>(
  card: ApprovedCard,
  kind: K,
): Extract<ApprovedScope, { kind: K }> {
  const found = card.scopes.find((scope) => scope.kind === kind);

  if (found === undefined) {
    throw new Error(`fixture ${card.cardId} carries no ${kind} scope`);
  }
  return found as Extract<ApprovedScope, { kind: K }>;
}

/** A Card built around a chosen identity and one borrowed Scope. */
function cardWith(
  cardId: string,
  versionId: string,
  scopes: readonly ApprovedScope[],
): ApprovedCard {
  return { ...createRefundPolicyCard(), cardId, versionId, scopes };
}

/** The refund policy document Scope, shared by every merge test below. */
function documentScope(): ApprovedScope {
  return scopeOfKind(createRefundPolicyCard(), "managed_document");
}

describe("managedTargetKey", () => {
  it("is a canonical digest of the scope reference and the bound", () => {
    const key = managedTargetKey(
      { scopeId: "scope_a", scopeVersion: "scopev_0001" },
      LIMIT,
    );

    // Restated from the rule rather than pinned to a literal: an executor has
    // to be able to reproduce the key from the three fields it receives.
    expect(key).toBe(
      canonicalDigest({
        scopeId: "scope_a",
        scopeVersion: "scopev_0001",
        limit: LIMIT,
      }),
    );
  });

  it("changes with the bound, so two bounds are two reads", () => {
    const scopeRef = { scopeId: "scope_a", scopeVersion: "scopev_0001" };

    expect(managedTargetKey(scopeRef, 8)).not.toBe(
      managedTargetKey(scopeRef, 9),
    );
  });

  it("changes with the scope version", () => {
    expect(
      managedTargetKey({ scopeId: "scope_a", scopeVersion: "scopev_0001" }, LIMIT),
    ).not.toBe(
      managedTargetKey({ scopeId: "scope_a", scopeVersion: "scopev_0002" }, LIMIT),
    );
  });
});

describe("planSelectedScopes", () => {
  it("plans nothing for no admitted Cards", () => {
    expect(planSelectedScopes([], LIMIT)).toEqual({
      items: [],
      managedTargets: [],
    });
  });

  it("produces one item and one target per managed document Scope", () => {
    const plan = planSelectedScopes([createRefundPolicyCard()], LIMIT);

    expect(plan.items).toHaveLength(1);
    expect(plan.managedTargets).toEqual([
      {
        targetKey: managedTargetKey(
          { scopeId: "scope_refund_policy_doc", scopeVersion: "scopev_0001" },
          LIMIT,
        ),
        scopeRef: {
          scopeId: "scope_refund_policy_doc",
          scopeVersion: "scopev_0001",
        },
        limit: LIMIT,
      },
    ]);
  });

  it("plans no target for a delegated Scope, which nothing of ours executes", () => {
    const plan = planSelectedScopes(
      [createPaymentsTableCard(), createPaymentApiCard()],
      LIMIT,
    );

    expect(plan.items).toHaveLength(2);
    expect(plan.managedTargets).toEqual([]);
    expect(plan.items.every((item) => !isManagedPlannedItem(item))).toBe(true);
  });

  it("carries no physical binding or security domain on a target", () => {
    const plan = planSelectedScopes([createRefundPolicyCard()], LIMIT);
    const wire = JSON.stringify(plan.managedTargets);

    for (const forbidden of [
      "connectorId",
      "accessHandle",
      "securityDomain",
      "vector.local",
      "documents/policies/indexes/refund",
      "documentIndexId",
    ]) {
      expect(wire).not.toContain(forbidden);
    }
    expect(Object.keys(plan.managedTargets[0] ?? {}).sort()).toEqual([
      "limit",
      "scopeRef",
      "targetKey",
    ]);
  });

  it("merges two Cards that authorise the same Scope into one item", () => {
    const plan = planSelectedScopes(
      [
        cardWith("card_first", "cardv_first", [documentScope()]),
        cardWith("card_second", "cardv_second", [documentScope()]),
      ],
      LIMIT,
    );

    // One Scope under one bound is one read, so a consumer receives the
    // evidence once rather than once per Card that happened to point at it.
    expect(plan.items).toHaveLength(1);
    expect(plan.managedTargets).toHaveLength(1);
    expect(plan.items[0]?.selectedBy).toEqual([
      { cardId: "card_first", versionId: "cardv_first" },
      { cardId: "card_second", versionId: "cardv_second" },
    ]);
  });

  it("orders selectedBy by the rank order the admitted Cards arrive in", () => {
    const plan = planSelectedScopes(
      [
        cardWith("card_zulu", "cardv_zulu", [documentScope()]),
        cardWith("card_alpha", "cardv_alpha", [documentScope()]),
      ],
      LIMIT,
    );

    // Not sorted by cardId: the caller hands them over already ranked, and
    // re-sorting here would discard the ranking it is meant to reflect.
    expect(plan.items[0]?.selectedBy.map((card) => card.cardId)).toEqual([
      "card_zulu",
      "card_alpha",
    ]);
  });

  it("counts one Card once even if it declares the same Scope twice", () => {
    const plan = planSelectedScopes(
      [cardWith("card_dup", "cardv_dup", [documentScope(), documentScope()])],
      LIMIT,
    );

    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]?.selectedBy).toHaveLength(1);
  });

  it("does not merge two Cards that authorise different Scopes", () => {
    const plan = planSelectedScopes(
      [createRefundPolicyCard(), createPaymentsTableCard()],
      LIMIT,
    );

    expect(plan.items).toHaveLength(2);
    for (const item of plan.items) {
      expect(item.selectedBy).toHaveLength(1);
    }
  });

  it("gives a managed item the target key its own guide implies", () => {
    const plan = planSelectedScopes([createRefundPolicyCard()], LIMIT);
    const [item] = plan.items;

    if (item === undefined || !isManagedPlannedItem(item)) {
      throw new Error("expected one managed item");
    }
    expect(item.execution.targetKey).toBe(plan.managedTargets[0]?.targetKey);
    expect(item.execution.targetKey).toBe(
      managedTargetKey(item.guide.scopeRef, item.guide.limit),
    );
  });

  it("orders items by scope identity rather than by the ranking", () => {
    const forward = planSelectedScopes(
      [createRefundPolicyCard(), createPaymentsTableCard(), createPaymentApiCard()],
      LIMIT,
    );
    const reversed = planSelectedScopes(
      [createPaymentApiCard(), createPaymentsTableCard(), createRefundPolicyCard()],
      LIMIT,
    );

    const scopeIds = (plan: typeof forward): string[] =>
      plan.items.map((item) => item.guide.scopeRef.scopeId);

    // Two runs over the same catalog list the same Scopes in the same order
    // whatever the scores did, which is what makes two responses comparable.
    expect(scopeIds(forward)).toEqual([
      "scope_payment_get",
      "scope_payments_table",
      "scope_refund_policy_doc",
    ]);
    expect(scopeIds(reversed)).toEqual(scopeIds(forward));
  });

  it("produces the same plan for the same input twice", () => {
    const build = (): readonly ApprovedCard[] => [
      createRefundPolicyCard(),
      createPaymentsTableCard(),
    ];

    expect(planSelectedScopes(build(), LIMIT)).toEqual(
      planSelectedScopes(build(), LIMIT),
    );
  });

  it("keys every item with a canonical digest", () => {
    const plan = planSelectedScopes(
      [createRefundPolicyCard(), createPaymentsTableCard()],
      LIMIT,
    );

    for (const item of plan.items) {
      expect(item.itemKey).toMatch(/^sha256:[0-9a-f]{64}$/u);
    }
    expect(new Set(plan.items.map((item) => item.itemKey)).size).toBe(2);
  });
});
