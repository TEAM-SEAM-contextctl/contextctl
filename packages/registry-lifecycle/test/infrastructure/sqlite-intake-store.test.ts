import type { DatabaseSync } from "node:sqlite";

import { beforeEach, describe, expect, it } from "vitest";

import { appendCardVersion } from "../../src/domain/card-version.js";
import {
  createContextCard,
  withCardVersions,
  type ContextCard,
} from "../../src/domain/context-card.js";
import type { LifecycleEvent } from "../../src/domain/lifecycle-event.js";
import { openRegistryDatabase } from "../../src/infrastructure/sqlite/registry-database.js";
import { SqliteCardStore } from "../../src/infrastructure/sqlite/sqlite-card-store.js";
import { SqliteConsumerCheckpointStore } from "../../src/infrastructure/sqlite/sqlite-consumer-checkpoint-store.js";
import { SqliteIntakeStore } from "../../src/infrastructure/sqlite/sqlite-intake-store.js";
import type { IntakenCard } from "../../src/ports/intake-store.js";
import { createDocumentCardVersion } from "../fixtures/card-version.fixture.js";
import { fixtureRootId } from "../fixtures/ingestion-publication.fixture.js";

/**
 * The transaction, asserted by breaking it.
 *
 * Cards and consumer cursors live in the same database, which is what makes one
 * transaction possible at all — so the thing worth testing is that the boundary
 * really encloses both. A commit that fails halfway must leave neither the first
 * Card nor the cursor, because the failure mode this replaced was exactly that:
 * drafts stored with the Publication still unconsumed.
 */

const SOURCE_ID = fixtureRootId("src", "payments");
const PUBLICATION_ID = fixtureRootId("pub", "initial");

const meaning = {
  description: "결제 실패 재시도 정책",
  representativeQuestions: ["결제가 실패하면 언제 재시도되나요?"],
  aliases: ["payment retry"],
  keywords: ["payment", "retry"],
};

const policy = { sensitive: false, allowedUsage: ["retrieval"] };

let database: DatabaseSync;
let intake: SqliteIntakeStore;
let cards: SqliteCardStore;
let checkpoints: SqliteConsumerCheckpointStore;

beforeEach(() => {
  database = openRegistryDatabase(":memory:");
  intake = new SqliteIntakeStore(database, () => "2026-08-21T00:00:00.000Z");
  cards = new SqliteCardStore(database);
  checkpoints = new SqliteConsumerCheckpointStore(
    database,
    () => "2026-08-21T00:00:00.000Z",
  );
});

/** One Card with one version and the event describing it. */
function intaken(cardId: string, versionId: string): IntakenCard {
  const card = createContextCard(cardId, meaning, policy);
  const version = {
    ...createDocumentCardVersion(),
    id: versionId,
    cardId,
    lineage: {
      publicationId: PUBLICATION_ID,
      observationId: fixtureRootId("obs", "initial"),
      knowledgeUnitId: cardId,
    },
  };
  const event: LifecycleEvent = {
    id: `evt_${versionId}`,
    kind: "card_version_added",
    cardId,
    occurredAt: "2026-08-21T00:00:00.000Z",
    versionId,
    publicationId: PUBLICATION_ID,
  };
  return {
    card: withCardVersions(card, appendCardVersion(card.versions, version)),
    events: [event],
  };
}

const cursor = { sourceId: SOURCE_ID, publicationId: PUBLICATION_ID };

describe("SqliteIntakeStore", () => {
  it("commits every Card, its events and the cursor together", async () => {
    await intake.commit({
      cards: [intaken("card_one", "ver_one"), intaken("card_two", "ver_two")],
      cursor,
    });

    expect(await cards.findCard("card_one")).toBeDefined();
    expect(await cards.findCard("card_two")).toBeDefined();
    expect(await checkpoints.hasProcessed(PUBLICATION_ID)).toBe(true);
    expect(await checkpoints.findCursor(SOURCE_ID)).toEqual(cursor);
  });

  it("stores no Card and no cursor when one Card fails", async () => {
    await expect(
      intake.commit({
        cards: [
          intaken("card_one", "ver_one"),
          corruptCard(intaken("card_two", "ver_two")),
        ],
        cursor,
      }),
    ).rejects.toThrow();

    // The first Card was written before the failure and has to be gone.
    expect(await cards.findCard("card_one")).toBeUndefined();
    expect(await checkpoints.hasProcessed(PUBLICATION_ID)).toBe(false);
    expect(await checkpoints.findCursor(SOURCE_ID)).toBeUndefined();
  });

  it("leaves an earlier commit alone when a later one fails", async () => {
    await intake.commit({ cards: [intaken("card_one", "ver_one")], cursor });

    await expect(
      intake.commit({
        cards: [corruptCard(intaken("card_two", "ver_two"))],
        cursor: { sourceId: SOURCE_ID, publicationId: fixtureRootId("pub", "second") },
      }),
    ).rejects.toThrow();

    // Rollback is scoped to the failing commit, not to the database.
    expect(await cards.findCard("card_one")).toBeDefined();
    expect(await checkpoints.findCursor(SOURCE_ID)).toEqual(cursor);
  });

  it("is idempotent for a Publication committed twice", async () => {
    const entry = intaken("card_one", "ver_one");

    await intake.commit({ cards: [entry], cursor });
    await intake.commit({ cards: [entry], cursor });

    const card = await cards.findCard("card_one");
    // Append-only: the same version id cannot land twice, so a redelivered
    // Publication does not grow the history.
    expect(card?.versions.versions).toHaveLength(1);
  });
});

/**
 * Makes a Card whose write fails inside the transaction.
 *
 * The `card_id` column is `NOT NULL`, so an empty id reaches the insert and
 * SQLite refuses it. Breaking the row rather than throwing from JavaScript keeps
 * the failure where a real one would happen — inside the statement, after the
 * previous statements in the same transaction already ran.
 */
function corruptCard(entry: IntakenCard): IntakenCard {
  return {
    ...entry,
    card: { ...entry.card, id: null as unknown as string } satisfies ContextCard,
  };
}
