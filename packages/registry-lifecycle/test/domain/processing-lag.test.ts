import { describe, expect, it } from "vitest";

import {
  judgeSourceProcessingLag,
  stalePendingRegistryScopes,
  STALE_PENDING_REGISTRY_MS,
  type SourceConsumptionSighting,
} from "../../src/domain/processing-lag.js";
import type {
  ReachabilityReport,
  ScopeReachability,
} from "../../src/domain/scope-reachability.js";

const NINE = "2026-08-19T09:00:00.000Z";
const TEN = "2026-08-19T10:00:00.000Z";
const ELEVEN = "2026-08-19T11:00:00.000Z";

function sight(overrides: Partial<SourceConsumptionSighting> = {}): SourceConsumptionSighting {
  return {
    sourceId: "src_payments",
    processed: { publicationId: "pub_1", producedAt: NINE },
    latestReady: { publicationId: "pub_3", producedAt: ELEVEN },
    ...overrides,
  };
}

describe("judgeSourceProcessingLag", () => {
  it("reports how far behind a Source is, in time", () => {
    const lag = judgeSourceProcessingLag(sight());

    expect(lag).toEqual({
      sourceId: "src_payments",
      processedPublicationId: "pub_1",
      latestReadyPublicationId: "pub_3",
      behind: true,
      freshnessLagMs: 2 * 60 * 60 * 1_000,
    });
  });

  it("reports a caught-up Source as not behind, with no lag", () => {
    const lag = judgeSourceProcessingLag(
      sight({
        processed: { publicationId: "pub_3", producedAt: ELEVEN },
      }),
    );

    expect(lag.behind).toBe(false);
    expect(lag.freshnessLagMs).toBe(0);
  });

  it("does not call a Source behind when nothing has been published", () => {
    // A Source whose documents were all removed reaches this state legitimately,
    // and so does one registered a second ago. Neither is late.
    const lag = judgeSourceProcessingLag(sight({ latestReady: undefined }));

    expect(lag.behind).toBe(false);
    expect(lag).not.toHaveProperty("latestReadyPublicationId");
    expect(lag).not.toHaveProperty("freshnessLagMs");
  });

  it("leaves the lag unknown rather than zero when nothing was consumed", () => {
    // Zero would say "caught up", which is the one answer a missing read must
    // not produce: a Source that has never been consumed is maximally behind.
    const lag = judgeSourceProcessingLag(sight({ processed: undefined }));

    expect(lag.behind).toBe(true);
    expect(lag).not.toHaveProperty("freshnessLagMs");
    expect(lag).not.toHaveProperty("processedPublicationId");
  });

  it("drops a negative difference instead of reporting it", () => {
    // A consumed Publication newer than the newest ready one is a contradiction,
    // not a lag — a retry produced after its successor, say. A negative "how
    // stale" would read as a clock fault wherever it is displayed.
    const lag = judgeSourceProcessingLag(
      sight({
        processed: { publicationId: "pub_1", producedAt: ELEVEN },
        latestReady: { publicationId: "pub_3", producedAt: NINE },
      }),
    );

    expect(lag.behind).toBe(true);
    expect(lag).not.toHaveProperty("freshnessLagMs");
  });

  it("ignores an unparsable timestamp on either end", () => {
    const lag = judgeSourceProcessingLag(
      sight({ processed: { publicationId: "pub_1", producedAt: "어제" } }),
    );

    expect(lag).not.toHaveProperty("freshnessLagMs");
  });
});

function scope(overrides: Partial<ScopeReachability> = {}): ScopeReachability {
  return {
    reference: { scopeId: "scope_payments", scopeVersion: "scpv_aaaa" },
    introducedByPublicationId: "pub_1",
    lastSeenPublicationId: "pub_1",
    state: "pending_registry",
    stateSince: TEN,
    cardVersionIds: [],
    reason: undefined,
    ...overrides,
  };
}

function report(scopes: readonly ScopeReachability[], generatedAt: string): ReachabilityReport {
  return {
    generatedAt,
    sourceCheckpoints: [],
    counts: {
      pending_registry: scopes.filter((each) => each.state === "pending_registry").length,
      broken: 0,
      reachable: 0,
      pending_approval: 0,
      intentionally_unexposed: 0,
      orphaned: 0,
    },
    currentReachabilityCoverage: 1,
    scopes,
  };
}

describe("stalePendingRegistryScopes", () => {
  it("finds a Scope that has waited longer than the standard allows", () => {
    const past = new Date(Date.parse(TEN) + STALE_PENDING_REGISTRY_MS + 1_000);

    expect(
      stalePendingRegistryScopes(report([scope()], past.toISOString())),
    ).toHaveLength(1);
  });

  it("leaves a Scope that has just arrived alone", () => {
    // `pending_registry` on its own is not a problem — a Publication that landed
    // seconds ago is supposed to be there. Waiting is what makes it one.
    const soon = new Date(Date.parse(TEN) + 30_000);

    expect(
      stalePendingRegistryScopes(report([scope()], soon.toISOString())),
    ).toEqual([]);
  });

  it("treats the boundary as not yet stale", () => {
    const exactly = new Date(Date.parse(TEN) + STALE_PENDING_REGISTRY_MS);

    expect(
      stalePendingRegistryScopes(report([scope()], exactly.toISOString())),
    ).toEqual([]);
  });

  it("ignores Scopes in every other state", () => {
    const past = new Date(Date.parse(TEN) + STALE_PENDING_REGISTRY_MS + 1_000);
    const others = (
      ["broken", "reachable", "pending_approval", "intentionally_unexposed", "orphaned"] as const
    ).map((state) => scope({ state }));

    expect(stalePendingRegistryScopes(report(others, past.toISOString()))).toEqual([]);
  });

  it("does not assume a Scope with no recorded time is stale", () => {
    // The timestamp comes from the audit trail, so its absence means nothing has
    // been recorded yet. Reporting a lane degraded on a missing value would be
    // reporting on the absence of evidence.
    const past = new Date(Date.parse(TEN) + STALE_PENDING_REGISTRY_MS + 1_000);

    expect(
      stalePendingRegistryScopes(report([scope({ stateSince: undefined })], past.toISOString())),
    ).toEqual([]);
  });
});
