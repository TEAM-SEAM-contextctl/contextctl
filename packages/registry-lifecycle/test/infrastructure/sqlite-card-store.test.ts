import type { DatabaseSync } from "node:sqlite";

import { beforeEach, describe, expect, it } from "vitest";

import {
  appendCardVersion,
  promoteCardVersion,
} from "../../src/domain/card-version.js";
import {
  createContextCard,
  withCardVersions,
  type ContextCard,
} from "../../src/domain/context-card.js";
import type { LifecycleEvent } from "../../src/domain/lifecycle-event.js";
import { openRegistryDatabase } from "../../src/infrastructure/sqlite/registry-database.js";
import { SqliteCardStore } from "../../src/infrastructure/sqlite/sqlite-card-store.js";
import { SqliteLifecycleEventStore } from "../../src/infrastructure/sqlite/sqlite-lifecycle-event-store.js";
import { createDocumentCardVersion } from "../fixtures/card-version.fixture.js";
import { fixtureRootId } from "../fixtures/ingestion-publication.fixture.js";

const meaning = {
  description: "결제 실패 재시도 정책",
  representativeQuestions: ["결제가 실패하면 언제 재시도되나요?"],
  aliases: ["payment retry"],
  keywords: ["payment", "retry"],
};

const policy = { sensitive: false, allowedUsage: ["retrieval"] };

function addedEvent(versionId: string, id = "ev_added"): LifecycleEvent {
  return {
    id,
    kind: "card_version_added",
    cardId: "unit_payment_failures",
    occurredAt: "2026-08-04T00:00:00.000Z",
    versionId,
    publicationId: "pub_initial",
  };
}

/** Card carrying one validated version that is already current. */
function createServingCard(): ContextCard {
  const card = createContextCard("unit_payment_failures", meaning, policy);
  const version = createDocumentCardVersion();
  let history = appendCardVersion(card.versions, version);
  history = promoteCardVersion(history, version.id);
  return withCardVersions(card, history);
}

describe("SqliteCardStore", () => {
  let database: DatabaseSync;
  let store: SqliteCardStore;

  beforeEach(() => {
    database = openRegistryDatabase(":memory:");
    store = new SqliteCardStore(database);
  });

  it("restores a saved card unchanged, including its current pointer", async () => {
    const card = createServingCard();

    await store.saveCard(card, [addedEvent(card.versions.versions[0]?.id ?? "")]);

    expect(await store.findCard(card.id)).toEqual(card);
  });

  it("returns undefined for a card that was never saved", async () => {
    expect(await store.findCard("unit_missing")).toBeUndefined();
  });

  it("keeps history append-only when the same version is saved again", async () => {
    const card = createServingCard();
    await store.saveCard(card, []);

    // A later save replays the whole history; the stored row must survive as is.
    const rejected = {
      ...createDocumentCardVersion(),
      id: "cv_rejected",
      validationState: "rejected" as const,
    };
    const grown = withCardVersions(
      card,
      appendCardVersion(card.versions, rejected),
    );
    await store.saveCard(grown, []);
    await store.saveCard(grown, []);

    const restored = await store.findCard(card.id);
    expect(restored?.versions.versions.map((version) => version.id)).toEqual([
      "cv_document",
      "cv_rejected",
    ]);
    // The validated version is still current: a rejected one cannot take over.
    expect(restored?.versions.currentVersionId).toBe("cv_document");
  });

  it("preserves append order across separate saves", async () => {
    const card = createServingCard();
    await store.saveCard(card, []);

    const second = { ...createDocumentCardVersion(), id: "cv_second" };
    const third = { ...createDocumentCardVersion(), id: "cv_third" };
    let history = appendCardVersion(card.versions, second);
    await store.saveCard(withCardVersions(card, history), []);
    history = appendCardVersion(history, third);
    await store.saveCard(withCardVersions(card, history), []);

    const restored = await store.findCard(card.id);
    expect(restored?.versions.versions.map((version) => version.id)).toEqual([
      "cv_document",
      "cv_second",
      "cv_third",
    ]);
  });

  it("lists only the current version of each card", async () => {
    const serving = createServingCard();
    const extra = { ...createDocumentCardVersion(), id: "cv_not_current" };
    await store.saveCard(
      withCardVersions(serving, appendCardVersion(serving.versions, extra)),
      [],
    );

    const pending = createContextCard("unit_pending", meaning, policy);
    await store.saveCard(pending, []);

    const current = await store.listCurrentVersions();
    expect(current.map((version) => version.id)).toEqual(["cv_document"]);
  });

  it("restores retrieval scopes with their version-pinned references", async () => {
    const card = createServingCard();
    await store.saveCard(card, []);

    const restored = await store.findCard(card.id);
    expect(restored?.versions.versions[0]?.scopes).toEqual([
      {
        kind: "managed_document",
        reference: {
          scopeId: "scope_payment_failures",
          scopeVersion: "scpv_aaaa",
        },
        documentIndex: {
          documentIndexId: "didx_payments",
          sourceId: fixtureRootId("src", "payments"),
          documentId: fixtureRootId("doc", "payments"),
          indexVersion: "idxv_aaaa",
        },
        selection: {
          kind: "semantic_units",
          semanticUnitIds: ["unit_payment_failures"],
        },
      },
    ]);
  });

  it("writes the card and its events atomically", async () => {
    const card = createServingCard();
    const duplicated = addedEvent("cv_document");
    // Two events sharing an id: the second insert is a no-op, so this save
    // succeeds. Then force a failure and prove nothing from it survives.
    await store.saveCard(card, [duplicated, duplicated]);

    const broken = {
      ...createContextCard("unit_broken", meaning, policy),
    } as ContextCard;
    const orphanVersion = {
      ...createDocumentCardVersion(),
      id: "cv_orphan",
      cardId: "unit_elsewhere",
    };
    const invalid = withCardVersions(broken, {
      cardId: broken.id,
      versions: [orphanVersion],
      currentVersionId: undefined,
    });

    // card_versions.card_id has a foreign key to cards, and unit_elsewhere was
    // never inserted, so the version insert fails mid-transaction.
    await expect(
      store.saveCard(invalid, [
        { ...addedEvent("cv_orphan", "ev_orphan"), cardId: "unit_broken" },
      ]),
    ).rejects.toThrow();

    expect(await store.findCard("unit_broken")).toBeUndefined();
    const events = await new SqliteLifecycleEventStore(database).listForCard(
      "unit_broken",
    );
    expect(events).toEqual([]);
  });
});
