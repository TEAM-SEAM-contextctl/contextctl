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
});
