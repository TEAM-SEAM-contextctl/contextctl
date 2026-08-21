import { describe, expect, it } from "vitest";

import type { ApprovedCard } from "../../src/domain/card-catalog.js";
import {
  CardCatalogInvariantError,
  PolicyContextInvariantError,
} from "../../src/domain/errors.js";
import {
  applyPolicyContext,
  assertValidPolicyContext,
  DEFAULT_POLICY_CONTEXT,
  validateCatalogPolicies,
  type PolicyContext,
} from "../../src/domain/policy-context.js";
import {
  createPaymentApiCard,
  createPaymentsTableCard,
  createRefundPolicyCard,
} from "../fixtures/approved-card.fixture.js";

function withPolicy(
  card: ApprovedCard,
  policy: Partial<ApprovedCard["policy"]>,
): ApprovedCard {
  return { ...card, policy: { ...card.policy, ...policy } };
}

/** A policy the type forbids, for the checks that refuse it at runtime. */
function malformed(policy: unknown): ApprovedCard {
  return { ...createRefundPolicyCard(), policy: policy as ApprovedCard["policy"] };
}

const ALLOW: PolicyContext = { usage: "retrieval", sensitiveAccess: "allow" };

describe("DEFAULT_POLICY_CONTEXT", () => {
  it("is retrieval with sensitive access denied", () => {
    expect(DEFAULT_POLICY_CONTEXT).toEqual({
      usage: "retrieval",
      sensitiveAccess: "deny",
    });
  });
});

describe("applyPolicyContext", () => {
  it("admits every Card of a catalog approved for retrieval and not sensitive", () => {
    const cards = [
      createRefundPolicyCard(),
      createPaymentsTableCard(),
      createPaymentApiCard(),
    ];

    const applied = applyPolicyContext(cards, DEFAULT_POLICY_CONTEXT);

    expect(applied.context).toBe(DEFAULT_POLICY_CONTEXT);
    expect(applied.eligible).toEqual(cards);
    expect(applied.excluded).toEqual([]);
  });

  it("keeps out a Card whose allowedUsage does not name the policy's usage", () => {
    const summaryOnly = withPolicy(createPaymentsTableCard(), {
      allowedUsage: ["summary"],
    });
    const cards = [createRefundPolicyCard(), summaryOnly, createPaymentApiCard()];

    const applied = applyPolicyContext(cards, DEFAULT_POLICY_CONTEXT);

    expect(applied.eligible.map((card) => card.cardId)).toEqual([
      "card_refund_policy",
      "card_payment_api",
    ]);
    expect(applied.excluded).toEqual([
      {
        cardId: summaryOnly.cardId,
        versionId: summaryOnly.versionId,
        reason: "usage_not_allowed",
      },
    ]);
  });

  it("requires exact membership, not a prefix or a superset", () => {
    const near = withPolicy(createRefundPolicyCard(), {
      allowedUsage: ["retrieval-audit", "Retrieval"],
    });

    expect(applyPolicyContext([near], DEFAULT_POLICY_CONTEXT).excluded).toEqual([
      { cardId: near.cardId, versionId: near.versionId, reason: "usage_not_allowed" },
    ]);
  });

  it("keeps a sensitive Card out under deny and lets it through under allow", () => {
    const sensitive = withPolicy(createPaymentApiCard(), { sensitive: true });
    const cards = [createRefundPolicyCard(), sensitive];

    const denied = applyPolicyContext(cards, DEFAULT_POLICY_CONTEXT);
    expect(denied.eligible.map((card) => card.cardId)).toEqual(["card_refund_policy"]);
    expect(denied.excluded).toEqual([
      {
        cardId: sensitive.cardId,
        versionId: sensitive.versionId,
        reason: "sensitive_denied",
      },
    ]);

    const allowed = applyPolicyContext(cards, ALLOW);
    expect(allowed.eligible).toEqual(cards);
    expect(allowed.excluded).toEqual([]);
  });

  it("does not let allow widen usage: a sensitive Card approved for another purpose stays out", () => {
    const card = withPolicy(createPaymentApiCard(), {
      sensitive: true,
      allowedUsage: ["summary"],
    });

    const applied = applyPolicyContext([card], ALLOW);

    // Usage is the broader gate and is the reason reported when both fail.
    expect(applied.eligible).toEqual([]);
    expect(applied.excluded[0]?.reason).toBe("usage_not_allowed");
  });

  it("preserves catalog order on both sides", () => {
    const a = withPolicy(createRefundPolicyCard(), { sensitive: true });
    const b = createPaymentsTableCard();
    const c = withPolicy(createPaymentApiCard(), { allowedUsage: ["summary"] });

    const applied = applyPolicyContext([a, b, c], DEFAULT_POLICY_CONTEXT);

    expect(applied.eligible.map((card) => card.cardId)).toEqual([b.cardId]);
    expect(applied.excluded.map((each) => each.cardId)).toEqual([a.cardId, c.cardId]);
  });

  it("does not mutate or reorder the catalog it was given", () => {
    const cards = [
      withPolicy(createRefundPolicyCard(), { sensitive: true }),
      createPaymentsTableCard(),
    ];
    const before = cards.map((card) => card.cardId);

    applyPolicyContext(cards, DEFAULT_POLICY_CONTEXT);

    expect(cards.map((card) => card.cardId)).toEqual(before);
  });

  it("refuses the whole catalog before deciding anything when a policy is unreadable", () => {
    const cards = [createRefundPolicyCard(), malformed({ sensitive: false, allowedUsage: [] })];

    expect(() => applyPolicyContext(cards, DEFAULT_POLICY_CONTEXT)).toThrow(
      CardCatalogInvariantError,
    );
  });

  it("refuses a context outside the type rather than reading it as deny", () => {
    expect(() =>
      applyPolicyContext(
        [createRefundPolicyCard()],
        { usage: "retrieval", sensitiveAccess: "allw" } as unknown as PolicyContext,
      ),
    ).toThrow(PolicyContextInvariantError);
    expect(() =>
      applyPolicyContext(
        [createRefundPolicyCard()],
        { usage: "summary", sensitiveAccess: "deny" } as unknown as PolicyContext,
      ),
    ).toThrow(PolicyContextInvariantError);
  });
});

describe("validateCatalogPolicies", () => {
  it("accepts a well-formed catalog", () => {
    expect(() =>
      validateCatalogPolicies([
        createRefundPolicyCard(),
        withPolicy(createPaymentApiCard(), {
          sensitive: true,
          allowedUsage: ["retrieval", "summary"],
        }),
      ]),
    ).not.toThrow();
  });

  it.each([
    ["an empty allowedUsage", { sensitive: false, allowedUsage: [] }, "empty"],
    [
      "a duplicated usage",
      { sensitive: false, allowedUsage: ["retrieval", "retrieval"] },
      "duplicate",
    ],
    [
      "a non-string usage",
      { sensitive: false, allowedUsage: ["retrieval", 7] },
      "non-string or blank",
    ],
    [
      "a blank usage",
      { sensitive: false, allowedUsage: ["retrieval", "  "] },
      "non-string or blank",
    ],
    [
      "a non-array allowedUsage",
      { sensitive: false, allowedUsage: "retrieval" },
      "not an array",
    ],
    [
      "a truthy non-boolean sensitive",
      { sensitive: 1, allowedUsage: ["retrieval"] },
      "not a boolean",
    ],
    [
      "a missing sensitive",
      { allowedUsage: ["retrieval"] },
      "not a boolean",
    ],
    ["a policy that is not an object", null, "not an object"],
  ])("refuses %s", (_label, policy, fragment) => {
    expect(() =>
      validateCatalogPolicies([createPaymentsTableCard(), malformed(policy)]),
    ).toThrow(fragment);
  });

  it("names every offending Card rather than stopping at the first", () => {
    const first = { ...malformed({ sensitive: false, allowedUsage: [] }), cardId: "first" };
    const second = {
      ...malformed({ sensitive: "yes", allowedUsage: ["retrieval"] }),
      cardId: "second",
    };

    let caught: unknown;
    try {
      validateCatalogPolicies([first, createRefundPolicyCard(), second]);
    } catch (error: unknown) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(CardCatalogInvariantError);
    const message = (caught as Error).message;
    expect(message).toContain("2 unreadable Card policies");
    expect(message).toContain("first/");
    expect(message).toContain("second/");
  });
});

describe("assertValidPolicyContext", () => {
  it("accepts both defined values of sensitiveAccess", () => {
    expect(() => assertValidPolicyContext(DEFAULT_POLICY_CONTEXT)).not.toThrow();
    expect(() => assertValidPolicyContext(ALLOW)).not.toThrow();
  });
});
