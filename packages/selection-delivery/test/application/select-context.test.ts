import { describe, expect, it } from "vitest";

import {
  EmptyQueryError,
  resolveContextErrorStatus,
  toResolveContextErrorCode,
} from "../../src/application/errors.js";
import {
  DEFAULT_CHUNK_LIMIT_PER_SCOPE,
  selectContext,
  type SelectContextPorts,
} from "../../src/application/select-context.js";
import type { ApprovedCard, ApprovedScope } from "../../src/domain/card-catalog.js";
import { SelectionScopeInvariantError } from "../../src/domain/errors.js";
import { isManagedPlannedItem } from "../../src/domain/selection-plan.js";
import { InMemoryCardCatalog } from "../../src/infrastructure/in-memory-card-catalog.js";
import {
  createDemoCardSet,
  createRefundPolicyCard,
  DEMO_QUERY,
  UNRELATED_QUERY,
} from "../fixtures/approved-card.fixture.js";

function portsFor(cards: readonly ApprovedCard[]): SelectContextPorts {
  return { catalog: new InMemoryCardCatalog(cards) };
}

function demoPorts(): SelectContextPorts {
  return portsFor(createDemoCardSet());
}

describe("selectContext", () => {
  it("refuses an empty query before the catalog is read", async () => {
    let read = false;
    const ports: SelectContextPorts = {
      catalog: {
        listApprovedCards: () => {
          read = true;
          return Promise.resolve([]);
        },
      },
    };

    await expect(selectContext(ports, "   ")).rejects.toThrow(EmptyQueryError);
    // Reading the catalog for a query that cannot select anything would be an
    // access with no possible use.
    expect(read).toBe(false);
  });

  it("echoes the query back exactly as received", async () => {
    const plan = await selectContext(demoPorts(), `  ${DEMO_QUERY}  `);

    expect(plan.query).toBe(`  ${DEMO_QUERY}  `);
  });

  it("plans one item per Scope of every admitted Card", async () => {
    const plan = await selectContext(demoPorts(), DEMO_QUERY);

    expect(plan.items.map((item) => item.guide.kind).sort()).toEqual([
      "http",
      "managed_document",
      "sql",
    ]);
  });

  it("plans nothing for a query no Card can answer", async () => {
    const plan = await selectContext(demoPorts(), UNRELATED_QUERY);

    expect(plan.items).toEqual([]);
    expect(plan.managedTargets).toEqual([]);
    // The candidates are still reported: "nothing matched" and "nothing was
    // looked at" are different answers and a consumer has to tell them apart.
    expect(plan.summary.candidates).toHaveLength(3);
  });

  it("plans no read for a Card that was deferred or rejected", async () => {
    const plan = await selectContext(demoPorts(), UNRELATED_QUERY);
    const admitted = plan.summary.selection.outcomes.filter(
      (outcome) => outcome.verdict === "admit",
    );

    // The invariant behind the ordering of the steps: a Card that was not
    // admitted must not cause a read, because the read itself is an access.
    expect(admitted).toEqual([]);
    expect(plan.managedTargets).toEqual([]);
  });

  it("carries both halves of the audit trail on the summary", async () => {
    const plan = await selectContext(demoPorts(), DEMO_QUERY);

    expect(plan.summary.candidates.map((candidate) => candidate.cardId)).toEqual([
      "card_refund_policy",
      "card_payments_table",
      "card_payment_api",
    ]);
    expect(plan.summary.selection.provenance.consideredCount).toBe(3);
  });

  it("bounds every managed read at the default when none is stated", async () => {
    const plan = await selectContext(portsFor([createRefundPolicyCard()]), DEMO_QUERY);

    expect(plan.managedTargets[0]?.limit).toBe(DEFAULT_CHUNK_LIMIT_PER_SCOPE);
  });

  it("carries a caller's bound onto the guide and the target alike", async () => {
    const plan = await selectContext(
      portsFor([createRefundPolicyCard()]),
      DEMO_QUERY,
      { chunkLimitPerScope: 3 },
    );
    const [item] = plan.items;

    if (item === undefined || !isManagedPlannedItem(item)) {
      throw new Error("expected one managed item");
    }
    expect(item.guide.limit).toBe(3);
    expect(plan.managedTargets[0]?.limit).toBe(3);
  });

  it("plans a different item under a different bound", async () => {
    const wide = await selectContext(
      portsFor([createRefundPolicyCard()]),
      DEMO_QUERY,
      { chunkLimitPerScope: 3 },
    );
    const narrow = await selectContext(
      portsFor([createRefundPolicyCard()]),
      DEMO_QUERY,
      { chunkLimitPerScope: 4 },
    );

    // Two bounds are two requests, so they are two identities. Merging them
    // would give one of the two an answer it did not ask for.
    expect(wide.items[0]?.itemKey).not.toBe(narrow.items[0]?.itemKey);
    expect(wide.managedTargets[0]?.targetKey).not.toBe(
      narrow.managedTargets[0]?.targetKey,
    );
  });

  it("honours a caller's thresholds without restating the default band", async () => {
    const plan = await selectContext(demoPorts(), UNRELATED_QUERY, {
      thresholds: { admit: 0.000_1, reject: 0 },
    });

    expect(plan.items.length).toBeGreaterThan(0);
    expect(plan.summary.selection.provenance.thresholds).toEqual({
      admit: 0.000_1,
      reject: 0,
    });
  });

  it("reads the catalog exactly once", async () => {
    let reads = 0;
    const ports: SelectContextPorts = {
      catalog: {
        listApprovedCards: () => {
          reads += 1;
          return Promise.resolve(createDemoCardSet());
        },
      },
    };

    await selectContext(ports, DEMO_QUERY);

    expect(reads).toBe(1);
  });

  it("produces the same plan for the same catalog twice", async () => {
    expect(await selectContext(demoPorts(), DEMO_QUERY)).toEqual(
      await selectContext(demoPorts(), DEMO_QUERY),
    );
  });
});

describe("selectContext over a catalog that contradicts itself about a Scope", () => {
  function conflictingCatalog(): readonly ApprovedCard[] {
    const first = createRefundPolicyCard();
    const whole = first.scopes.find((scope) => scope.kind === "managed_document");
    if (whole === undefined || whole.kind !== "managed_document") {
      throw new Error("fixture carries no managed document scope");
    }
    const narrowed: ApprovedScope = {
      ...whole,
      selection: { kind: "semantic_units", semanticUnitIds: ["unit_01890f5c-7b1a-7989-86c3-07e34e599ac5"] },
    };
    return [
      first,
      { ...first, cardId: "card_refund_policy_b", versionId: "cardv_refund_policy_b", scopes: [narrowed] },
    ];
  }

  it("refuses the request instead of planning either definition", async () => {
    await expect(
      selectContext(portsFor(conflictingCatalog()), DEMO_QUERY),
    ).rejects.toThrow(SelectionScopeInvariantError);
  });

  it("reports the refusal as a request-level selection_invariant_violation, HTTP 500", async () => {
    let thrown: unknown;
    try {
      await selectContext(portsFor(conflictingCatalog()), DEMO_QUERY);
    } catch (cause) {
      thrown = cause;
    }

    // The existing ladder already maps the domain invariant; nothing new had
    // to be taught to the surfaces for the defined error code to come out.
    const code = toResolveContextErrorCode(thrown);
    expect(code).toBe("selection_invariant_violation");
    expect(resolveContextErrorStatus(code)).toBe(500);
  });
});
