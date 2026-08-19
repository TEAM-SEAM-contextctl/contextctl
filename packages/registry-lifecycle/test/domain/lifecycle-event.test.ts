import { describe, expect, it } from "vitest";

import {
  lifecycleEventsForCard,
  recordLifecycleEvent,
  type LifecycleEvent,
} from "../../src/domain/lifecycle-event.js";

const added: LifecycleEvent = {
  id: "ev_1",
  kind: "card_version_added",
  cardId: "card_1",
  occurredAt: "2026-08-03T00:00:00.000Z",
  versionId: "cv_1",
  publicationId: "pub_initial",
};

const promoted: LifecycleEvent = {
  id: "ev_2",
  kind: "card_version_promoted",
  cardId: "card_1",
  occurredAt: "2026-08-03T00:00:01.000Z",
  versionId: "cv_1",
  previousVersionId: undefined,
  decidedBy: "operator@example.test",
  note: undefined,
};

const otherCard: LifecycleEvent = {
  id: "ev_3",
  kind: "card_impact_assessed",
  cardId: "card_2",
  occurredAt: "2026-08-03T00:00:02.000Z",
  publicationId: "pub_second",
  decision: "disable",
  reasons: [{ rule: "change.removed", message: "unit is gone" }],
};

describe("lifecycle event trail", () => {
  it("appends events without mutating the existing trail", () => {
    const initial: readonly LifecycleEvent[] = [added];

    const next = recordLifecycleEvent(initial, promoted);

    expect(next).toEqual([added, promoted]);
    expect(initial).toEqual([added]);
  });

  it("preserves append order across several records", () => {
    let trail: readonly LifecycleEvent[] = [];
    trail = recordLifecycleEvent(trail, added);
    trail = recordLifecycleEvent(trail, promoted);
    trail = recordLifecycleEvent(trail, otherCard);

    expect(trail.map((event) => event.id)).toEqual(["ev_1", "ev_2", "ev_3"]);
  });

  it("filters the trail down to one card", () => {
    const trail = [added, promoted, otherCard];

    expect(lifecycleEventsForCard(trail, "card_1")).toEqual([added, promoted]);
    expect(lifecycleEventsForCard(trail, "card_2")).toEqual([otherCard]);
    expect(lifecycleEventsForCard(trail, "card_missing")).toEqual([]);
  });

  /**
   * The audit trail stays Card-scoped, and a consumption diagnostic is not one.
   *
   * A refused Publication is a fact about a Source, not about a Card, and the
   * temptation when the design asked for an operator diagnostic was to loosen
   * `cardId` so a Source-level event could be appended here. That would cost the
   * property this trail is built on: `lifecycleEventsForCard` reconstructs a
   * Card's whole life because nothing in the trail is unattached. Diagnostics
   * travel on the consumption result instead — see `publication-chain.ts`.
   */
  it("admits no event that names no card", () => {
    // @ts-expect-error every lifecycle event belongs to exactly one Card
    const unattached: LifecycleEvent = {
      id: "ev_unattached",
      kind: "card_version_added",
      occurredAt: "2026-08-19T00:00:00.000Z",
      versionId: "cv_1",
      publicationId: "pub_1",
    };

    // Also checked at runtime: the directive above proves the shape is refused,
    // and this proves the trail filter has no bucket such an event could land in.
    expect(lifecycleEventsForCard([added, promoted, otherCard], "")).toEqual([]);
    expect(unattached).not.toHaveProperty("cardId");
  });
});
