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
