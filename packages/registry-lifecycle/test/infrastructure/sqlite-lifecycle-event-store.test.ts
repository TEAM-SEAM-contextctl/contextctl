import { describe, expect, it } from "vitest";

import type { LifecycleEvent } from "../../src/domain/lifecycle-event.js";
import { openRegistryDatabase } from "../../src/infrastructure/sqlite/registry-database.js";
import { SqliteLifecycleEventStore } from "../../src/infrastructure/sqlite/sqlite-lifecycle-event-store.js";

const added: LifecycleEvent = {
  id: "ev_1",
  kind: "card_version_added",
  cardId: "card_1",
  occurredAt: "2026-08-04T00:00:00.000Z",
  versionId: "cv_1",
  publicationId: "pub_initial",
};

const promoted: LifecycleEvent = {
  id: "ev_2",
  kind: "card_version_promoted",
  cardId: "card_1",
  occurredAt: "2026-08-04T00:00:01.000Z",
  versionId: "cv_1",
  previousVersionId: undefined,
  decidedBy: "operator@example.test",
  note: undefined,
};

const assessed: LifecycleEvent = {
  id: "ev_3",
  kind: "card_impact_assessed",
  cardId: "card_1",
  occurredAt: "2026-08-04T00:00:02.000Z",
  publicationId: "pub_second",
  decision: "review",
  reasons: [{ rule: "change.updated", message: "content changed" }],
};

const otherCard: LifecycleEvent = {
  ...assessed,
  id: "ev_4",
  cardId: "card_2",
  decision: "disable",
};

function createStore(): SqliteLifecycleEventStore {
  return new SqliteLifecycleEventStore(openRegistryDatabase({ location: ":memory:", stateNamespaceId: "state_local", securityDomain: "local" }));
}

describe("SqliteLifecycleEventStore", () => {
  it("restores events in append order across separate appends", async () => {
    const store = createStore();

    await store.append([added]);
    await store.append([promoted, assessed]);

    expect(
      (await store.listForCard("card_1")).map((event) => event.id),
    ).toEqual(["ev_1", "ev_2", "ev_3"]);
  });

  it("restores each event kind with its full payload", async () => {
    const store = createStore();

    await store.append([added, promoted, assessed]);

    expect(await store.listForCard("card_1")).toEqual([
      added,
      // previousVersionId was undefined, so it is absent rather than null.
      { ...promoted, previousVersionId: undefined },
      assessed,
    ]);
  });

  it("scopes the trail to one card", async () => {
    const store = createStore();

    await store.append([added, otherCard]);

    expect((await store.listForCard("card_2")).map((event) => event.id)).toEqual(
      ["ev_4"],
    );
    expect(await store.listForCard("card_missing")).toEqual([]);
  });

  it("ignores a replayed event instead of duplicating the trail", async () => {
    const store = createStore();

    await store.append([added]);
    await store.append([added]);

    expect(await store.listForCard("card_1")).toHaveLength(1);
  });
});
