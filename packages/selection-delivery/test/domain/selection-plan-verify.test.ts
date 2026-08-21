import { describe, expect, it } from "vitest";

import { assembleContext } from "../../src/application/assemble-context.js";
import {
  resolveContextErrorStatus,
  toResolveContextErrorCode,
} from "../../src/application/errors.js";
import { selectContext } from "../../src/application/select-context.js";
import { SelectionPlanInvariantError } from "../../src/domain/errors.js";
import {
  isManagedPlannedItem,
  verifySelectionPlan,
  type PlannedResolutionItem,
  type SelectionPlan,
} from "../../src/domain/selection-plan.js";
import { InMemoryCardCatalog } from "../../src/infrastructure/in-memory-card-catalog.js";
import {
  createDemoCardSet,
  createRefundPolicyCard,
  DEMO_QUERY,
} from "../fixtures/approved-card.fixture.js";

/** A plan the pipeline actually produced, so every tampering below starts from a valid one. */
function demoPlan(): Promise<SelectionPlan> {
  return selectContext({ catalog: new InMemoryCardCatalog(createDemoCardSet()) }, DEMO_QUERY);
}

function managedItem(plan: SelectionPlan) {
  const item = plan.items.find(isManagedPlannedItem);
  if (item === undefined) {
    throw new Error("expected a managed item");
  }
  return item;
}

function replaceItem(
  plan: SelectionPlan,
  target: PlannedResolutionItem,
  replacement: PlannedResolutionItem,
): SelectionPlan {
  return { ...plan, items: plan.items.map((item) => (item === target ? replacement : item)) };
}

describe("verifySelectionPlan", () => {
  it("accepts the plan the pipeline built", async () => {
    const plan = await demoPlan();

    expect(() => verifySelectionPlan(plan)).not.toThrow();
    expect(() => verifySelectionPlan(plan, { query: DEMO_QUERY })).not.toThrow();
  });

  it("refuses a plan whose query is not the one it was asked", async () => {
    const plan = await demoPlan();

    // Byte for byte: a trailing space is a different question.
    expect(() => verifySelectionPlan(plan, { query: `${DEMO_QUERY} ` })).toThrow(
      SelectionPlanInvariantError,
    );
  });

  it("refuses an item whose key no longer matches its guide", async () => {
    const plan = await demoPlan();
    const item = managedItem(plan);
    const tampered = replaceItem(plan, item, {
      ...item,
      guide: { ...item.guide, limit: item.guide.limit + 1 },
    });

    // The key exists and looks like a digest; it is just not the digest of
    // the guide beside it. Existence is not what is checked.
    expect(() => verifySelectionPlan(tampered)).toThrow(SelectionPlanInvariantError);
  });

  it("refuses an item whose target key no longer matches its scope and bound", async () => {
    const plan = await demoPlan();
    const item = managedItem(plan);
    const tampered = replaceItem(plan, item, {
      ...item,
      execution: { kind: "managed", targetKey: "sha256:" + "0".repeat(64) },
    });

    expect(() => verifySelectionPlan(tampered)).toThrow(SelectionPlanInvariantError);
  });

  it("refuses a Card listed twice on one item", async () => {
    const plan = await demoPlan();
    const item = managedItem(plan);
    const [first] = item.selectedBy;
    const tampered = replaceItem(plan, item, {
      ...item,
      selectedBy: [first, { ...first }],
    });

    expect(() => verifySelectionPlan(tampered)).toThrow(SelectionPlanInvariantError);
  });

  it("refuses an item selected by a Card the ranking did not admit", async () => {
    const plan = await demoPlan();
    const item = managedItem(plan);
    const tampered = replaceItem(plan, item, {
      ...item,
      selectedBy: [
        ...item.selectedBy,
        { cardId: "card_nobody_admitted", versionId: "cardv_nobody_admitted" },
      ],
    });

    // A Card that was deferred or rejected must not cause a read, and an item
    // that names it claims it did.
    expect(() => verifySelectionPlan(tampered)).toThrow(SelectionPlanInvariantError);
  });

  it("refuses an admitted Card that selects no item", async () => {
    const plan = await demoPlan();
    const tampered: SelectionPlan = {
      ...plan,
      summary: {
        ...plan.summary,
        selection: {
          ...plan.summary.selection,
          outcomes: [
            ...plan.summary.selection.outcomes,
            { verdict: "admit", cardId: "card_ghost", versionId: "cardv_ghost", score: 1 },
          ],
        },
      },
    };

    expect(() => verifySelectionPlan(tampered)).toThrow(SelectionPlanInvariantError);
  });

  it("refuses a candidate the policy excluded", async () => {
    const plan = await demoPlan();
    const [candidate] = plan.summary.candidates;
    if (candidate === undefined) {
      throw new Error("expected a candidate");
    }
    const tampered: SelectionPlan = {
      ...plan,
      summary: {
        ...plan.summary,
        policy: {
          ...plan.summary.policy,
          excluded: [
            { cardId: candidate.cardId, versionId: candidate.versionId, reason: "sensitive_denied" },
          ],
        },
      },
    };

    // A Card the policy kept out was never scored; a plan that both excludes
    // and scores it is lying about one of the two.
    expect(() => verifySelectionPlan(tampered)).toThrow(SelectionPlanInvariantError);
    expect(() => verifySelectionPlan(tampered)).toThrow(/scored although the policy excluded it/);
  });

  it("refuses an item selected by a Card the policy excluded", async () => {
    const plan = await demoPlan();
    const item = managedItem(plan);
    const [selector] = item.selectedBy;
    const tampered: SelectionPlan = {
      ...plan,
      summary: {
        ...plan.summary,
        // Scrubbed from the layers above so that only the item betrays it.
        candidates: plan.summary.candidates.filter((each) => each.cardId !== selector.cardId),
        selection: {
          ...plan.summary.selection,
          outcomes: plan.summary.selection.outcomes.filter(
            (each) => each.cardId !== selector.cardId,
          ),
        },
        policy: {
          ...plan.summary.policy,
          excluded: [{ ...selector, reason: "usage_not_allowed" }],
        },
      },
    };

    expect(() => verifySelectionPlan(tampered)).toThrow(SelectionPlanInvariantError);
  });

  it("refuses a policy context outside the type", async () => {
    const plan = await demoPlan();
    const tampered = {
      ...plan,
      summary: {
        ...plan.summary,
        policy: { ...plan.summary.policy, context: { usage: "retrieval", sensitiveAccess: "maybe" } },
      },
    } as unknown as SelectionPlan;

    expect(() => verifySelectionPlan(tampered)).toThrow();
  });

  it("refuses a target no item reads", async () => {
    const plan = await demoPlan();
    const [target] = plan.managedTargets;
    if (target === undefined) {
      throw new Error("expected a target");
    }
    const tampered: SelectionPlan = {
      ...plan,
      managedTargets: [
        ...plan.managedTargets,
        {
          targetKey: "sha256:" + "1".repeat(64),
          scopeRef: { scopeId: "scope_orphan", scopeVersion: "scopev_0001" },
          limit: target.limit,
        },
      ],
    };

    expect(() => verifySelectionPlan(tampered)).toThrow(SelectionPlanInvariantError);
  });

  it("refuses a target listed under a different bound than its item", async () => {
    const plan = await demoPlan();
    const tampered: SelectionPlan = {
      ...plan,
      managedTargets: plan.managedTargets.map((target) => ({
        ...target,
        limit: target.limit + 1,
      })),
    };

    expect(() => verifySelectionPlan(tampered)).toThrow(SelectionPlanInvariantError);
  });

  it("refuses the same item listed twice", async () => {
    const plan = await demoPlan();
    const item = managedItem(plan);
    const tampered: SelectionPlan = { ...plan, items: [...plan.items, item] };

    expect(() => verifySelectionPlan(tampered)).toThrow(SelectionPlanInvariantError);
  });
});

describe("a tampered plan is refused on both sides of the read", () => {
  it("assembleContext refuses it before filing a single outcome", async () => {
    const plan = await demoPlan();
    const item = managedItem(plan);
    const tampered = replaceItem(plan, item, {
      ...item,
      guide: { ...item.guide, limit: item.guide.limit + 1 },
    });

    expect(() => assembleContext(tampered, [])).toThrow(SelectionPlanInvariantError);
  });

  it("reports as a request-level selection_invariant_violation, HTTP 500", async () => {
    const plan = await demoPlan();
    const item = managedItem(plan);
    const tampered = replaceItem(plan, item, {
      ...item,
      guide: { ...item.guide, limit: item.guide.limit + 1 },
    });
    let thrown: unknown;
    try {
      assembleContext(tampered, []);
    } catch (cause) {
      thrown = cause;
    }

    const code = toResolveContextErrorCode(thrown);
    expect(code).toBe("selection_invariant_violation");
    expect(resolveContextErrorStatus(code)).toBe(500);
  });

  it("selectContext verifies the plan it returns", async () => {
    // Nothing to tamper with from outside; the check is that a plan the
    // pipeline built passes its own verification with the query it was asked.
    const plan = await selectContext(
      { catalog: new InMemoryCardCatalog([createRefundPolicyCard()]) },
      DEMO_QUERY,
    );

    expect(() => verifySelectionPlan(plan, { query: DEMO_QUERY })).not.toThrow();
  });
});
