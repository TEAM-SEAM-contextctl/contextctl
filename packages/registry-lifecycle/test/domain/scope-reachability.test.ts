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
    introducedByPublicationId: "pub_initial",
    lastSeenPublicationId: "pub_initial",
    sourceId: "src_payments",
    processed: true,
    carriers: [],
    decisions: [],
    ...overrides,
  };
}

function decision(overrides: Partial<ScopeDecision> = {}): ScopeDecision {
  return {
    kind: "withdrawn",
    eventId: "evt_withdrawn",
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

  /**
   * The fields v2 added have to take part in the comparison, or two Scopes over
   * different things compare equal and `broken` stops meaning anything.
   *
   * Both cases below are one `scopeVersion` claimed by two Card Versions that
   * describe different ranges — the situation this judgement exists to catch.
   * They pass only because `schema` and `parameters` are part of the compared
   * shape; before v2 neither field existed and both pairs looked identical.
   */
  it("treats two schemas holding the same table name as different Scopes", () => {
    const publicSchema: RetrievalScope = {
      kind: "sql_source",
      reference,
      connector: "postgres.main",
      schema: "public",
      table: "payments",
      columns: ["failed_reason", "status"],
    };
    const analyticsSchema: RetrievalScope = {
      ...publicSchema,
      schema: "analytics",
    };

    const result = judgeScopeReachability(
      observe({
        carriers: [
          carrier({ versionId: "cv_1", isCurrent: true, scope: publicSchema }),
          carrier({
            cardId: "card_analytics",
            versionId: "cv_2",
            scope: analyticsSchema,
          }),
        ],
      }),
    );

    expect(result.state).toBe("broken");
  });

  it("treats two operations on one path with different parameters as different Scopes", () => {
    const byId: RetrievalScope = {
      kind: "http_source",
      reference,
      connector: "payments.api",
      method: "GET",
      path: "/payments",
      operationId: "listPayments",
      parameters: [{ location: "query", name: "id", required: false }],
    };
    const byStatus: RetrievalScope = {
      ...byId,
      parameters: [{ location: "query", name: "status", required: false }],
    };

    const result = judgeScopeReachability(
      observe({
        carriers: [
          carrier({ versionId: "cv_1", isCurrent: true, scope: byId }),
          carrier({ cardId: "card_by_status", versionId: "cv_2", scope: byStatus }),
        ],
      }),
    );

    expect(result.state).toBe("broken");
  });

  /**
   * A verdict names the audit entry it rests on, where a decision produced it.
   *
   * `stateSince` says when. On its own it leaves an operator searching the trail
   * for what happened at that moment, and the design puts `lifecycleEventId` in
   * the read model for exactly that reason.
   */
  describe("evidence", () => {
    it("names the promotion behind a reachable verdict", () => {
      const result = judgeScopeReachability(
        observe({
          carriers: [carrier({ isCurrent: true })],
          decisions: [decision({ kind: "promoted", eventId: "evt_promoted" })],
        }),
      );

      expect(result.state).toBe("reachable");
      expect(result.lifecycleEventId).toBe("evt_promoted");
    });

    it("names the refusal behind an intentionally_unexposed verdict", () => {
      const result = judgeScopeReachability(
        observe({
          carriers: [carrier({ validationState: "rejected" })],
          decisions: [
            decision({ kind: "refused", eventId: "evt_refused", note: "정책상 비노출" }),
          ],
        }),
      );

      expect(result.state).toBe("intentionally_unexposed");
      expect(result.lifecycleEventId).toBe("evt_refused");
    });

    it("carries no event for a Scope nothing has decided about", () => {
      // A Scope waiting to be processed has no decision behind it, and inventing
      // one would point an operator at an entry that says nothing about it.
      const result = judgeScopeReachability(observe({ processed: false }));

      expect(result.state).toBe("pending_registry");
      expect(result).not.toHaveProperty("lifecycleEventId");
    });
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
        introducedByPublicationId: "pub_second",
        lastSeenPublicationId: "pub_second",
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

  describe("an immutable Scope carried into a later Publication", () => {
    // The same Scope version reappears unchanged when an edit elsewhere in the
    // document republishes it. Treating that as new work would reset the clock on
    // a Scope nothing happened to, and an operator watching for a stale
    // pending_approval would see it restart every time the document was touched.
    it("keeps stateSince when only the last seen Publication moved", () => {
      const first = judgeScopeReachability(
        observe({ carriers: [carrier({ validationState: "draft" })] }),
      );
      const carriedForward = judgeScopeReachability(
        observe({
          lastSeenPublicationId: "pub_second",
          carriers: [carrier({ validationState: "draft" })],
        }),
      );

      expect(carriedForward.stateSince).toBe(first.stateSince);
      expect(carriedForward.state).toBe(first.state);
    });

    it("does not return a processed Scope to pending_registry", () => {
      const carriedForward = judgeScopeReachability(
        observe({
          lastSeenPublicationId: "pub_second",
          carriers: [carrier({ isCurrent: true })],
        }),
      );

      expect(carriedForward.state).toBe("reachable");
    });

    it("reports both ids so provenance is not collapsed", () => {
      const verdict = judgeScopeReachability(
        observe({
          introducedByPublicationId: "pub_first",
          lastSeenPublicationId: "pub_third",
          carriers: [carrier({ isCurrent: true })],
        }),
      );

      expect(verdict.introducedByPublicationId).toBe("pub_first");
      expect(verdict.lastSeenPublicationId).toBe("pub_third");
    });
  });
});
