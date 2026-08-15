import { describe, expect, it } from "vitest";

import { buildReachabilityReport } from "../../src/application/build-reachability-report.js";
import type { LifecycleEvent } from "../../src/domain/lifecycle-event.js";
import { reachabilityGateViolations } from "../../src/domain/scope-reachability.js";
import type { ScopeSighting } from "../../src/domain/scope-reachability.js";
import type { RetrievalScope } from "../../src/domain/retrieval-scope.js";
import type { Clock } from "../../src/ports/clock.js";
import type { ScopeReachabilityStore } from "../../src/ports/scope-reachability-store.js";

const generatedAt = "2026-08-15T00:00:00.000Z";

const clock: Clock = { now: () => generatedAt };

class FakeScopeReachabilityStore implements ScopeReachabilityStore {
  constructor(
    private readonly sightings: readonly ScopeSighting[],
    private readonly decisions: readonly LifecycleEvent[] = [],
  ) {}

  async listScopeSightings(): Promise<readonly ScopeSighting[]> {
    return this.sightings;
  }

  async listOperatorDecisions(): Promise<readonly LifecycleEvent[]> {
    return this.decisions;
  }
}

function documentScope(
  scopeVersion: string,
  indexVersion = `idxv_${scopeVersion}`,
): RetrievalScope {
  return {
    kind: "managed_document",
    reference: { scopeId: "scope_payment_failures", scopeVersion },
    documentIndex: {
      documentIndexId: "didx_payments",
      sourceId: "src_payments",
      documentId: "doc_payments",
      indexVersion,
      connectorId: "vector.local",
      accessHandle: `documents/payments/indexes/${scopeVersion}`,
    },
    selection: {
      kind: "semantic_units",
      semanticUnitIds: ["unit_payment_failures"],
    },
  };
}

function sighting(overrides: Partial<ScopeSighting> = {}): ScopeSighting {
  return {
    cardId: "card_payment_failures",
    versionId: "cv_1",
    publicationId: "pub_initial",
    scope: documentScope("scpv_aaaa"),
    validationState: "validated",
    isCurrent: true,
    createdAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

function withdrawal(note: string | undefined): LifecycleEvent {
  return {
    kind: "card_withdrawn",
    id: "evt_withdrawn",
    cardId: "card_payment_failures",
    occurredAt: "2026-08-02T00:00:00.000Z",
    withdrawnVersionId: "cv_1",
    decidedBy: "dayeon",
    note,
  };
}

describe("buildReachabilityReport", () => {
  it("counts each Scope version once and dates the report from the clock", async () => {
    const report = await buildReachabilityReport({
      scopes: new FakeScopeReachabilityStore([
        sighting(),
        sighting({
          versionId: "cv_2",
          isCurrent: false,
          validationState: "draft",
          scope: documentScope("scpv_bbbb"),
        }),
      ]),
      clock,
    });

    expect(report.generatedAt).toBe(generatedAt);
    expect(report.scopes).toHaveLength(2);
    expect(report.counts.reachable).toBe(1);
    expect(report.counts.pending_approval).toBe(1);
  });

  it("reports every Scope a Card Version carries, not just the first", async () => {
    // Reachability is derived from Card Versions, so a Scope that never lands
    // on one is invisible. That is exactly the blind spot this report exists to
    // remove: if a later change stops recording a unit's Scope, this fails.
    const both = sighting({
      scope: documentScope("scpv_aaaa"),
    });
    const second = sighting({
      scope: documentScope("scpv_bbbb"),
    });

    const report = await buildReachabilityReport({
      scopes: new FakeScopeReachabilityStore([both, second]),
      clock,
    });

    expect(
      report.scopes.map((scope) => scope.reference.scopeVersion).sort(),
    ).toEqual(["scpv_aaaa", "scpv_bbbb"]);
  });

  it("groups the Card Versions that share one Scope version into one verdict", async () => {
    const report = await buildReachabilityReport({
      scopes: new FakeScopeReachabilityStore([
        sighting({ versionId: "cv_1", isCurrent: true }),
        sighting({
          cardId: "card_refunds",
          versionId: "cv_2",
          isCurrent: false,
          validationState: "draft",
        }),
      ]),
      clock,
    });

    expect(report.scopes).toHaveLength(1);
    expect(report.scopes[0]?.state).toBe("reachable");
  });

  it("measures coverage against the Scopes that are meant to be exposed", async () => {
    const report = await buildReachabilityReport({
      scopes: new FakeScopeReachabilityStore(
        [
          sighting(),
          sighting({
            cardId: "card_refunds",
            versionId: "cv_2",
            isCurrent: false,
            validationState: "rejected",
            scope: documentScope("scpv_bbbb"),
          }),
        ],
        [
          {
            kind: "card_version_refused",
            id: "evt_refused",
            cardId: "card_refunds",
            occurredAt: "2026-08-02T00:00:00.000Z",
            versionId: "cv_2",
            decidedBy: "dayeon",
            note: "superseded by the policy handbook",
          },
        ],
      ),
      clock,
    });

    // One reachable, one deliberately unexposed: the deliberate one is not a
    // gap, so coverage is whole rather than a half.
    expect(report.counts.intentionally_unexposed).toBe(1);
    expect(report.currentReachabilityCoverage).toBe(1);
  });

  it("reports full coverage when there is nothing to expose", async () => {
    const report = await buildReachabilityReport({
      scopes: new FakeScopeReachabilityStore([]),
      clock,
    });

    expect(report.currentReachabilityCoverage).toBe(1);
    expect(report.scopes).toHaveLength(0);
  });

  it("passes the release gate when every Scope is reachable", async () => {
    const report = await buildReachabilityReport({
      scopes: new FakeScopeReachabilityStore([sighting()]),
      clock,
    });

    expect(reachabilityGateViolations(report)).toEqual([]);
  });

  it("fails the release gate on a Scope withdrawn with no reason", async () => {
    const report = await buildReachabilityReport({
      scopes: new FakeScopeReachabilityStore(
        [sighting({ isCurrent: false, validationState: "rejected" })],
        [withdrawal(undefined)],
      ),
      clock,
    });

    expect(report.counts.orphaned).toBe(1);
    expect(reachabilityGateViolations(report)).toEqual([
      {
        rule: "reachability.orphaned_without_reason",
        message:
          "1 scope version(s) are unreachable with no recorded reason",
      },
    ]);
  });

  it("passes the release gate once that withdrawal records a reason", async () => {
    const report = await buildReachabilityReport({
      scopes: new FakeScopeReachabilityStore(
        [sighting({ isCurrent: false, validationState: "rejected" })],
        [withdrawal("replaced by the refund policy card")],
      ),
      clock,
    });

    expect(report.counts.intentionally_unexposed).toBe(1);
    expect(reachabilityGateViolations(report)).toEqual([]);
  });

  it("fails the release gate on a broken Scope", async () => {
    const report = await buildReachabilityReport({
      scopes: new FakeScopeReachabilityStore([
        sighting({ versionId: "cv_1", isCurrent: true }),
        // Same scope version, different index version: one of the two is
        // pointing at something that is no longer what it claims to be.
        sighting({
          cardId: "card_refunds",
          versionId: "cv_2",
          isCurrent: false,
          scope: documentScope("scpv_aaaa", "idxv_drifted"),
        }),
      ]),
      clock,
    });

    expect(report.counts.broken).toBe(1);
    expect(reachabilityGateViolations(report)[0]?.rule).toBe(
      "reachability.broken",
    );
  });
});
