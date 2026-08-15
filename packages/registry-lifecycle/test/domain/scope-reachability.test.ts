import { describe, expect, it } from "vitest";

import { ScopeReachabilityInvariantError } from "../../src/domain/errors.js";
import type { RetrievalScope } from "../../src/domain/retrieval-scope.js";
import {
  judgeScopeReachability,
  type ScopeCarrier,
  type ScopeDecision,
  type ScopeObservation,
} from "../../src/domain/scope-reachability.js";

const reference = {
  scopeId: "scope_payment_failures",
  scopeVersion: "scpv_aaaa",
} as const;

function documentScope(
  overrides: { readonly indexVersion?: string; readonly scopeVersion?: string } = {},
): RetrievalScope {
  return {
    kind: "managed_document",
    reference: {
      scopeId: reference.scopeId,
      scopeVersion: overrides.scopeVersion ?? reference.scopeVersion,
    },
    documentIndex: {
      documentIndexId: "didx_payments",
      sourceId: "src_payments",
      documentId: "doc_payments",
      indexVersion: overrides.indexVersion ?? "idxv_aaaa",
      connectorId: "vector.local",
      accessHandle: "documents/payments/indexes/aaaa",
    },
    selection: {
      kind: "semantic_units",
      semanticUnitIds: ["unit_payment_failures"],
    },
  };
}

function carrier(overrides: Partial<ScopeCarrier> = {}): ScopeCarrier {
  return {
    cardId: "card_payment_failures",
    versionId: "cv_1",
    scope: documentScope(),
    validationState: "validated",
    isCurrent: false,
    createdAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

function observe(overrides: Partial<ScopeObservation> = {}): ScopeObservation {
  return {
    reference,
    publicationId: "pub_initial",
    processed: true,
    carriers: [],
    decisions: [],
    ...overrides,
  };
}

function decision(overrides: Partial<ScopeDecision> = {}): ScopeDecision {
  return {
    kind: "withdrawn",
    cardId: "card_payment_failures",
    versionId: "cv_1",
    occurredAt: "2026-08-02T00:00:00.000Z",
    note: undefined,
    ...overrides,
  };
}

describe("judgeScopeReachability", () => {
  it("reports a Scope its Publication has not been processed yet as pending_registry", () => {
    const result = judgeScopeReachability(
      observe({ processed: false, carriers: [], decisions: [] }),
    );

    expect(result.state).toBe("pending_registry");
  });

  it("reports a Scope a current approved Card references as reachable", () => {
    const result = judgeScopeReachability(
      observe({ carriers: [carrier({ isCurrent: true })] }),
    );

    expect(result.state).toBe("reachable");
    expect(result.cardVersionIds).toEqual(["cv_1"]);
  });

  it("reports a Scope only a draft references as pending_approval", () => {
    const result = judgeScopeReachability(
      observe({ carriers: [carrier({ validationState: "draft" })] }),
    );

    expect(result.state).toBe("pending_approval");
  });

  it("reports carriers that describe the same Scope version differently as broken", () => {
    const result = judgeScopeReachability(
      observe({
        carriers: [
          carrier({ versionId: "cv_1", isCurrent: true }),
          carrier({
            cardId: "card_refunds",
            versionId: "cv_2",
            scope: documentScope({ indexVersion: "idxv_bbbb" }),
          }),
        ],
      }),
    );

    expect(result.state).toBe("broken");
  });

  it("reports a refusal that recorded a reason as intentionally_unexposed", () => {
    const result = judgeScopeReachability(
      observe({
        carriers: [carrier({ validationState: "rejected" })],
        decisions: [
          decision({ kind: "refused", note: "superseded by the policy handbook" }),
        ],
      }),
    );

    expect(result.state).toBe("intentionally_unexposed");
    expect(result.reason).toBe("superseded by the policy handbook");
  });

  it("reports a refusal that recorded no reason as orphaned", () => {
    const result = judgeScopeReachability(
      observe({
        carriers: [carrier({ validationState: "rejected" })],
        decisions: [decision({ kind: "refused", note: undefined })],
      }),
    );

    expect(result.state).toBe("orphaned");
    expect(result.reason).toBeUndefined();
  });

  it("treats a blank reason as no reason, so it cannot pass the gate", () => {
    const result = judgeScopeReachability(
      observe({
        carriers: [carrier({ validationState: "rejected" })],
        decisions: [decision({ kind: "withdrawn", note: "   " })],
      }),
    );

    expect(result.state).toBe("orphaned");
  });

  it("reports a processed Scope nobody decided anything about as orphaned", () => {
    const result = judgeScopeReachability(observe());

    expect(result.state).toBe("orphaned");
  });

  it("leaves a withdrawn Card's Scope no longer reachable", () => {
    const serving = observe({ carriers: [carrier({ isCurrent: true })] });
    expect(judgeScopeReachability(serving).state).toBe("reachable");

    const withdrawn = observe({
      carriers: [carrier({ isCurrent: false, validationState: "rejected" })],
      decisions: [decision({ kind: "withdrawn" })],
    });

    expect(judgeScopeReachability(withdrawn).state).not.toBe("reachable");
  });

  it("does not read a withdrawn version as awaiting approval", () => {
    // Withdrawing moves the current pointer and leaves the version validated,
    // so its state alone reads as promotable. Treating that as pending_approval
    // would hide a Scope nobody serves behind a review that is not happening.
    const result = judgeScopeReachability(
      observe({
        carriers: [carrier({ validationState: "validated", isCurrent: false })],
        decisions: [decision({ kind: "withdrawn", versionId: "cv_1" })],
      }),
    );

    expect(result.state).toBe("orphaned");
  });

  it("still awaits approval for a fresh draft added after a withdrawal", () => {
    const result = judgeScopeReachability(
      observe({
        carriers: [
          carrier({ versionId: "cv_1", validationState: "validated" }),
          carrier({
            versionId: "cv_2",
            validationState: "draft",
            createdAt: "2026-08-03T00:00:00.000Z",
          }),
        ],
        decisions: [decision({ kind: "withdrawn", versionId: "cv_1" })],
      }),
    );

    expect(result.state).toBe("pending_approval");
    expect(result.cardVersionIds).toEqual(["cv_2"]);
  });

  it("keeps a Scope out of pending_approval once it is reachable", () => {
    // A Card being revised while an approved version still serves the same
    // Scope version must not be reported as both at once.
    const result = judgeScopeReachability(
      observe({
        carriers: [
          carrier({ versionId: "cv_1", isCurrent: true }),
          carrier({
            versionId: "cv_2",
            validationState: "draft",
            createdAt: "2026-08-03T00:00:00.000Z",
          }),
        ],
      }),
    );

    expect(result.state).toBe("reachable");
  });

  it("judges an older Scope version independently of a newer one", () => {
    const older = judgeScopeReachability(
      observe({ carriers: [carrier({ isCurrent: true })] }),
    );
    const newer = judgeScopeReachability(
      observe({
        reference: { scopeId: reference.scopeId, scopeVersion: "scpv_bbbb" },
        publicationId: "pub_second",
        carriers: [],
      }),
    );

    expect(older.state).toBe("reachable");
    expect(newer.state).toBe("orphaned");
  });

  it("applies no state other than pending_registry before processing", () => {
    // Carriers cannot exist before the checkpoint, but an unprocessed
    // observation must stay pending even if a caller supplies decisions.
    const result = judgeScopeReachability(
      observe({
        processed: false,
        decisions: [decision({ kind: "refused", note: "not wanted" })],
      }),
    );

    expect(result.state).toBe("pending_registry");
    expect(result.reason).toBeUndefined();
  });

  it("dates reachable from the promotion that made it serve", () => {
    const result = judgeScopeReachability(
      observe({
        carriers: [carrier({ isCurrent: true })],
        decisions: [
          decision({ kind: "promoted", occurredAt: "2026-08-04T00:00:00.000Z" }),
        ],
      }),
    );

    expect(result.stateSince).toBe("2026-08-04T00:00:00.000Z");
  });

  it("refuses to judge an observation whose carrier names another Scope version", () => {
    expect(() =>
      judgeScopeReachability(
        observe({
          carriers: [carrier({ scope: documentScope({ scopeVersion: "scpv_zzzz" }) })],
        }),
      ),
    ).toThrow(ScopeReachabilityInvariantError);
  });
});
