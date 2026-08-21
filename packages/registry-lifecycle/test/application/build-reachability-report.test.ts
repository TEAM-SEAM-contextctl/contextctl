import { describe, expect, it } from "vitest";

import { buildReachabilityReport } from "../../src/application/build-reachability-report.js";
import type { LifecycleEvent } from "../../src/domain/lifecycle-event.js";
import { reachabilityGateViolations } from "../../src/domain/scope-reachability.js";
import type { ScopeSighting } from "../../src/domain/scope-reachability.js";
import type { RetrievalScope } from "../../src/domain/retrieval-scope.js";
import type { Clock } from "../../src/ports/clock.js";
import type { ConsumerCheckpointStore } from "../../src/ports/consumer-checkpoint-store.js";
import type { ScopeReachabilityStore } from "../../src/ports/scope-reachability-store.js";

const generatedAt = "2026-08-15T00:00:00.000Z";

const clock: Clock = { now: () => generatedAt };

/**
 * A reader that has nothing to report, for the cases that are not about lag.
 *
 * Required rather than omitted: `pending_registry` can only be found by reading
 * Ingestion, so a report built without a reader could not produce one of the six
 * states. "Nothing published" is a legitimate answer; "no reader" is not.
 */
const emptyFeed = {
  latestForSource: async () => undefined,
  findById: async () => undefined,
};

/** No cursor recorded, so the report carries no Source checkpoint. */
const noCursors: ConsumerCheckpointStore = {
  hasProcessed: async () => false,
  findCursor: async () => undefined,
  markProcessed: async () => {},
  listCursors: async () => [],
};

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
    },
    selection: {
      kind: "semantic_units",
      semanticUnitIds: ["unit_01890f5c-7b1a-7684-8f82-b5950cf2b0dd"],
    },
  };
}

function sighting(overrides: Partial<ScopeSighting> = {}): ScopeSighting {
  return {
    cardId: "card_payment_failures",
    versionId: "cv_1",
    publicationId: "pub_initial",
    sourceId: "src_payments",
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
      checkpoints: noCursors,
      clock,
      publications: emptyFeed,
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
      checkpoints: noCursors,
      clock,
      publications: emptyFeed,
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
      checkpoints: noCursors,
      clock,
      publications: emptyFeed,
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
      checkpoints: noCursors,
      clock,
      publications: emptyFeed,
    });

    // One reachable, one deliberately unexposed: the deliberate one is not a
    // gap, so coverage is whole rather than a half.
    expect(report.counts.intentionally_unexposed).toBe(1);
    expect(report.currentReachabilityCoverage).toBe(1);
  });

  it("reports full coverage when there is nothing to expose", async () => {
    const report = await buildReachabilityReport({
      scopes: new FakeScopeReachabilityStore([]),
      checkpoints: noCursors,
      clock,
      publications: emptyFeed,
    });

    expect(report.currentReachabilityCoverage).toBe(1);
    expect(report.scopes).toHaveLength(0);
  });

  it("passes the release gate when every Scope is reachable", async () => {
    const report = await buildReachabilityReport({
      scopes: new FakeScopeReachabilityStore([sighting()]),
      checkpoints: noCursors,
      clock,
      publications: emptyFeed,
    });

    expect(reachabilityGateViolations(report)).toEqual([]);
  });

  it("fails the release gate on a Scope withdrawn with no reason", async () => {
    const report = await buildReachabilityReport({
      scopes: new FakeScopeReachabilityStore(
        [sighting({ isCurrent: false, validationState: "rejected" })],
        [withdrawal(undefined)],
      ),
      checkpoints: noCursors,
      clock,
      publications: emptyFeed,
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
      checkpoints: noCursors,
      clock,
      publications: emptyFeed,
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
      checkpoints: noCursors,
      clock,
      publications: emptyFeed,
    });

    expect(report.counts.broken).toBe(1);
    expect(reachabilityGateViolations(report)[0]?.rule).toBe(
      "reachability.broken",
    );
  });
});

describe("scope provenance and source checkpoints", () => {
  function sightingIn(publicationId: string, scopeVersion: string): ScopeSighting {
    return sighting({
      publicationId,
      versionId: `cv_${publicationId}`,
      scope: documentScope(scopeVersion),
    });
  }

  it("keeps the introducing Publication fixed while the last seen one moves", async () => {
    // An immutable Scope carries forward: an edit elsewhere in the document
    // republishes it unchanged. Folding both ids into one would either lose when
    // the Scope appeared or claim it appeared later than it did.
    const report = await buildReachabilityReport({
      scopes: new FakeScopeReachabilityStore([
        sightingIn("pub_first", "scpv_aaaa"),
        sightingIn("pub_second", "scpv_aaaa"),
      ]),
      checkpoints: noCursors,
      clock,
      publications: emptyFeed,
    });

    expect(report.scopes).toHaveLength(1);
    expect(report.scopes[0]?.introducedByPublicationId).toBe("pub_first");
    expect(report.scopes[0]?.lastSeenPublicationId).toBe("pub_second");
  });

  it("gives a Scope seen once the same id twice", async () => {
    const report = await buildReachabilityReport({
      scopes: new FakeScopeReachabilityStore([
        sightingIn("pub_first", "scpv_aaaa"),
      ]),
      checkpoints: noCursors,
      clock,
      publications: emptyFeed,
    });

    expect(report.scopes[0]?.introducedByPublicationId).toBe("pub_first");
    expect(report.scopes[0]?.lastSeenPublicationId).toBe("pub_first");
  });

  it("reports one checkpoint per Source, in id order", async () => {
    // Per Source rather than one global position: no ordering exists between two
    // chains, so a single number would invent one and make a Source that is
    // behind look current whenever another moved.
    const report = await buildReachabilityReport({
      scopes: new FakeScopeReachabilityStore([sighting()]),
      checkpoints: {
        ...noCursors,
        listCursors: async () => [
          { sourceId: "src_refunds", publicationId: "pub_r2" },
          { sourceId: "src_payments", publicationId: "pub_p7" },
        ],
      },
      clock,
      publications: emptyFeed,
    });

    expect(report.sourceCheckpoints).toEqual([
      { sourceId: "src_payments", processedPublicationId: "pub_p7" },
      { sourceId: "src_refunds", processedPublicationId: "pub_r2" },
    ]);
    expect(report.sourceFreshnessLags.map((lag) => lag.sourceId)).toEqual([
      "src_payments",
      "src_refunds",
    ]);
  });

  it("leaves the latest ready Publication absent when no reader was assembled", async () => {
    // Absent is a legitimate composition: the reachability states need only
    // committed Card state, so a caller that wants them should not have to
    // assemble a publication reader. What must not happen is guessing the value
    // from the newest thing we happened to see, which would make a Source that is
    // behind look current.
    const report = await buildReachabilityReport({
      scopes: new FakeScopeReachabilityStore([sighting()]),
      checkpoints: {
        ...noCursors,
        listCursors: async () => [
          { sourceId: "src_payments", publicationId: "pub_p7" },
        ],
      },
      clock,
      publications: emptyFeed,
    });

    expect(report.sourceCheckpoints[0]?.latestReadyPublicationId).toBeUndefined();
    expect(report.sourceFreshnessLags[0]?.freshnessLagMs).toBeUndefined();
  });

  describe("with a publication reader assembled", () => {
    const consumed = {
      publicationId: "pub_p7",
      sourceId: "src_payments",
      producedAt: "2026-08-14T22:00:00.000Z",
      knowledgeUnits: [],
    };
    /**
     * The unconsumed Publication, carrying a Scope nothing has a Card for yet.
     *
     * The Scope matters as much as the timestamps: it is the only way a
     * `pending_registry` verdict can occur at all, because every other state is
     * derived from `card_versions` — which by definition holds Scopes that were
     * already consumed.
     */
    const newest = {
      publicationId: "pub_p9",
      sourceId: "src_payments",
      producedAt: "2026-08-15T00:00:00.000Z",
      knowledgeUnits: [
        {
          publishedScopes: [
            { scopeId: "scope_waiting", scopeVersion: "scpv_waiting" },
          ],
        },
      ],
    };

    /** Answers the two reads Registry performs, and refuses anything else. */
    function feed(latest: typeof newest | undefined) {
      return {
        latestForSource: async (sourceId: string) =>
          sourceId === "src_payments"
            ? (latest as unknown as undefined)
            : undefined,
        // Answers for the Publication the cursor names and for the one the
        // fixture's Card Version came from — the second is how a Scope observed
        // through a Card learns which Source published it.
        findById: async (publicationId: string) =>
          publicationId === consumed.publicationId
            ? (consumed as unknown as undefined)
            : publicationId === "pub_initial"
              ? ({
                  publicationId: "pub_initial",
                  sourceId: "src_payments",
                  producedAt: "2026-08-01T00:00:00.000Z",
                  knowledgeUnits: [],
                } as unknown as undefined)
              : undefined,
      };
    }

    const oneCursor: ConsumerCheckpointStore = {
      ...noCursors,
      listCursors: async () => [
        { sourceId: "src_payments", publicationId: "pub_p7" },
      ],
    };

    it("measures how far behind the Source is", async () => {
      const report = await buildReachabilityReport({
        scopes: new FakeScopeReachabilityStore([sighting()]),
        checkpoints: oneCursor,
        clock,
        publications: feed(newest),
      });

      // Two arrays, keyed by the same id: the design keeps the position and the
      // delay apart, and only the second is a judgement.
      expect(report.sourceCheckpoints).toEqual([
        {
          sourceId: "src_payments",
          processedPublicationId: "pub_p7",
          latestReadyPublicationId: "pub_p9",
        },
      ]);
      expect(report.sourceFreshnessLags).toEqual([
        {
          sourceId: "src_payments",
          behind: true,
          freshnessLagMs: 2 * 60 * 60 * 1_000,
        },
      ]);
    });

    it("reports a Scope waiting to be consumed as pending_registry", async () => {
      // The state existed in the type and in the priority order and nothing could
      // ever be in it: every other verdict is derived from `card_versions`, which
      // only holds Scopes Registry already consumed. Reading the unconsumed
      // Publication is what makes the state occur.
      const report = await buildReachabilityReport({
        scopes: new FakeScopeReachabilityStore([sighting()]),
        checkpoints: oneCursor,
        clock,
        publications: feed(newest),
      });

      const waiting = report.scopes.find(
        (scope) => scope.reference.scopeId === "scope_waiting",
      );
      expect(waiting?.state).toBe("pending_registry");
      // Dated from when Ingestion made it ready, not from when we looked — the
      // five-minute standard measures the wait, not the observation.
      expect(waiting?.stateSince).toBe(newest.producedAt);
      expect(report.counts.pending_registry).toBe(1);
    });

    it("does not send an already served Scope back to waiting", async () => {
      // An immutable Scope carries forward unchanged, so the same version can sit
      // in an unconsumed Publication while a Card is already serving it. The
      // design forbids moving it back: the new Publication's unprocessed state
      // shows up in the Source lag and the checkpoints, not in the Scope.
      const served = sighting();
      const report = await buildReachabilityReport({
        scopes: new FakeScopeReachabilityStore([served]),
        checkpoints: oneCursor,
        clock,
        publications: feed({
          ...newest,
          knowledgeUnits: [
            {
              publishedScopes: [
                {
                  scopeId: served.scope.reference.scopeId,
                  scopeVersion: served.scope.reference.scopeVersion,
                },
              ],
            },
          ],
        }),
      });

      expect(report.counts.pending_registry).toBe(0);
      expect(report.sourceFreshnessLags[0]?.behind).toBe(true);
    });

    it("excludes a waiting Scope from the coverage denominator", async () => {
      // Nothing has been decided about it yet, so counting it would move the
      // number for a reason that is not a problem.
      const report = await buildReachabilityReport({
        scopes: new FakeScopeReachabilityStore([sighting({ isCurrent: true })]),
        checkpoints: oneCursor,
        clock,
        publications: feed(newest),
      });

      expect(report.counts.pending_registry).toBe(1);
      expect(report.currentReachabilityCoverage).toBe(1);
    });

    it("reports how long the longest wait has been", async () => {
      // 설계안 1241행: the report carries the oldest state's elapsed time, so an
      // operator does not have to find the largest of six numbers themselves.
      const report = await buildReachabilityReport({
        scopes: new FakeScopeReachabilityStore([sighting()]),
        checkpoints: oneCursor,
        clock,
        publications: feed(newest),
      });

      // The waiting Scope became ready exactly at `generatedAt`, so the oldest
      // age is whatever the Card-derived Scope contributes — never negative, and
      // present because at least one Scope carries a timestamp.
      expect(report.oldestStateAgeMs).toBeGreaterThanOrEqual(0);
    });

    it("names the Source an observed Scope came from", async () => {
      // Read from our own claim record rather than from Ingestion: the store
      // joins `consumer_checkpoints`, which holds the Source beside every
      // Publication Registry consumed. Without it an operator reading
      // `--state orphaned` gets Scope ids and no way to act.
      const report = await buildReachabilityReport({
        scopes: new FakeScopeReachabilityStore([sighting()]),
        checkpoints: oneCursor,
        clock,
        publications: feed(newest),
      });

      const observed = report.scopes.find(
        (scope) => scope.reference.scopeId !== "scope_waiting",
      );
      expect(observed?.sourceId).toBe("src_payments");
    });

    it("names the Source of a Scope that is still waiting", async () => {
      const report = await buildReachabilityReport({
        scopes: new FakeScopeReachabilityStore([sighting()]),
        checkpoints: oneCursor,
        clock,
        publications: feed(newest),
      });

      const waiting = report.scopes.find(
        (scope) => scope.reference.scopeId === "scope_waiting",
      );
      // Known without any lookup: the Scope was found by asking that Source for
      // its newest Publication.
      expect(waiting?.sourceId).toBe("src_payments");
    });

    it("reports a Source that consumed the newest Publication as current", async () => {
      // The control case. Without it every assertion above would also hold for a
      // report that called every Source behind.
      const report = await buildReachabilityReport({
        scopes: new FakeScopeReachabilityStore([sighting()]),
        checkpoints: oneCursor,
        clock,
        publications: feed({ ...consumed } as typeof newest),
      });

      expect(report.sourceFreshnessLags[0]?.behind).toBe(false);
      expect(report.sourceFreshnessLags[0]?.freshnessLagMs).toBe(0);
    });
  });

  it("reports no checkpoint for a Source that consumed nothing", async () => {
    const report = await buildReachabilityReport({
      scopes: new FakeScopeReachabilityStore([sighting()]),
      checkpoints: noCursors,
      clock,
      publications: emptyFeed,
    });

    expect(report.sourceCheckpoints).toEqual([]);
  });
});
