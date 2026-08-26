import { describe, expect, it } from "vitest";

import { selectContext } from "../../src/application/select-context.js";
import type {
  ApprovedCard,
  ApprovedManagedDocumentScope,
} from "../../src/domain/card-catalog.js";
import { MINIMUM_SUFFICIENT_SET_POLICY_VERSION } from "../../src/domain/minimum-sufficient-set.js";
import {
  SELECTION_PLANNING_POLICY_VERSION,
  verifySelectionPlan,
} from "../../src/domain/selection-plan.js";
import { InMemoryCardCatalog } from "../../src/infrastructure/in-memory-card-catalog.js";

function scope(suffix: string): ApprovedManagedDocumentScope {
  return {
    kind: "managed_document",
    reference: {
      scopeId: `scope_${suffix}`,
      scopeVersion: "scopev_0001",
    },
    documentIndex: {
      documentIndexId: `docidx_${suffix}`,
      sourceId: "src_docs",
      documentId: `doc_${suffix}`,
      indexVersion: "idxv_0001",
    },
    selection: { kind: "document" },
  };
}

function card(
  suffix: string,
  keywords: readonly string[],
): ApprovedCard {
  return {
    cardId: `card_${suffix}`,
    versionId: `cardv_${suffix}`,
    meaning: {
      description: keywords.join(" "),
      representativeQuestions: [],
      aliases: [],
      keywords,
    },
    policy: { sensitive: false, allowedUsage: ["retrieval"] },
    scopes: [scope(suffix)],
  };
}

describe("selectContext with selection-planning-v2", () => {
  it("executes only the minimum sufficient admitted Card set", async () => {
    const broad = card("broad", ["refund delivery"]);
    const narrow = card("narrow", ["refund"]);
    const plan = await selectContext(
      { catalog: new InMemoryCardCatalog([broad, narrow]) },
      "refund delivery",
      { thresholds: { admit: 0.75, reject: 0.35 } },
    );

    expect(SELECTION_PLANNING_POLICY_VERSION).toBe("selection-planning-v2");
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]?.selectedBy).toEqual([
      { cardId: broad.cardId, versionId: broad.versionId },
    ]);
    expect(plan.summary.selection.outcomes).toContainEqual(
      expect.objectContaining({
        cardId: narrow.cardId,
        verdict: "defer",
        findings: [
          expect.objectContaining({ rule: "plan.covered_by_selected_set" }),
        ],
      }),
    );
    expect(plan.summary.planning).toEqual(
      expect.objectContaining({
        policyVersion: MINIMUM_SUFFICIENT_SET_POLICY_VERSION,
        removalCount: 1,
        costBefore: expect.objectContaining({ cardCount: 2 }),
        costAfter: expect.objectContaining({ cardCount: 1 }),
      }),
    );
  });

  it("refuses a planning audit changed after selection", async () => {
    const plan = await selectContext(
      { catalog: new InMemoryCardCatalog([card("single", ["refund"])]) },
      "refund",
    );
    const tampered = {
      ...plan,
      summary: {
        ...plan.summary,
        planning: {
          ...plan.summary.planning,
          removalCount: plan.summary.planning.removalCount + 1,
        },
      },
    };

    expect(() => verifySelectionPlan(tampered)).toThrow(
      /planning audit does not match its digest/u,
    );
  });
});
