import type { DatabaseSync } from "node:sqlite";

import { beforeEach, describe, expect, it } from "vitest";

import {
  approveCardVersion,
  disableCard,
  rejectCardVersion,
  type CardDecisionPorts,
  type OperatorDecision,
} from "../../src/application/approve-card-version.js";
import { CardNotFoundError } from "../../src/application/errors.js";
import {
  appendCardVersion,
  type CardVersion,
} from "../../src/domain/card-version.js";
import {
  createContextCard,
  isCardApproved,
  withCardVersions,
  type ContextCard,
} from "../../src/domain/context-card.js";
import { CardVersionInvariantError } from "../../src/domain/errors.js";
import { openRegistryDatabase } from "../../src/infrastructure/sqlite/registry-database.js";
import { SqliteCardStore } from "../../src/infrastructure/sqlite/sqlite-card-store.js";
import { SqliteLifecycleEventStore } from "../../src/infrastructure/sqlite/sqlite-lifecycle-event-store.js";
import { createDocumentCardVersion } from "../fixtures/card-version.fixture.js";

const cardId = "unit_payment_failures";

const decision: OperatorDecision = {
  decidedBy: "operator@example.test",
  note: "문서 검토 완료",
};

const meaning = {
  description: "결제 실패 재시도 정책",
  representativeQuestions: ["결제가 실패하면 언제 재시도되나요?"],
  aliases: [],
  keywords: [],
};

const policy = { sensitive: false, allowedUsage: ["retrieval"] };

function version(
  id: string,
  validationState: CardVersion["validationState"],
): CardVersion {
  return { ...createDocumentCardVersion(), id, validationState };
}

/** Card holding the given versions, none of them current yet. */
function cardWith(versions: readonly CardVersion[]): ContextCard {
  const card = createContextCard(cardId, meaning, policy);
  let history = card.versions;
  for (const candidate of versions) {
    history = appendCardVersion(history, candidate);
  }
  return withCardVersions(card, history);
}

describe("operator card decisions", () => {
  let database: DatabaseSync;
  let ports: CardDecisionPorts;
  let events: SqliteLifecycleEventStore;

  beforeEach(() => {
    database = openRegistryDatabase(":memory:");
    let nextId = 0;
    ports = {
      cards: new SqliteCardStore(database),
      clock: { now: () => "2026-08-04T00:00:00.000Z" },
      ids: {
        nextId: () => {
          nextId += 1;
          return `ev_${nextId}`;
        },
      },
    };
    events = new SqliteLifecycleEventStore(database);
  });

  it("promotes a validated version and records who approved it", async () => {
    await ports.cards.saveCard(cardWith([version("cv_1", "validated")]), []);

    const approved = await approveCardVersion(ports, cardId, "cv_1", decision);

    expect(approved.versions.currentVersionId).toBe("cv_1");
    expect(isCardApproved(approved)).toBe(true);
    expect(await events.listForCard(cardId)).toEqual([
      {
        id: "ev_1",
        kind: "card_version_promoted",
        cardId,
        occurredAt: "2026-08-04T00:00:00.000Z",
        versionId: "cv_1",
        previousVersionId: undefined,
        decidedBy: "operator@example.test",
        note: "문서 검토 완료",
      },
    ]);
  });

  it("persists the approval so a fresh store sees the card serving", async () => {
    await ports.cards.saveCard(cardWith([version("cv_1", "validated")]), []);
    await approveCardVersion(ports, cardId, "cv_1", decision);

    const reopened = await new SqliteCardStore(database).findCard(cardId);
    expect(reopened?.versions.currentVersionId).toBe("cv_1");
  });

  it("refuses to approve a version that failed grounding", async () => {
    await ports.cards.saveCard(
      cardWith([version("cv_1", "validated"), version("cv_2", "rejected")]),
      [],
    );
    await approveCardVersion(ports, cardId, "cv_1", decision);

    await expect(
      approveCardVersion(ports, cardId, "cv_2", decision),
    ).rejects.toThrow(CardVersionInvariantError);

    // The last-known-good version keeps serving, and no event was written.
    const stored = await ports.cards.findCard(cardId);
    expect(stored?.versions.currentVersionId).toBe("cv_1");
    expect((await events.listForCard(cardId)).map((event) => event.id)).toEqual([
      "ev_1",
    ]);
  });

  it("refuses to approve a draft version", async () => {
    await ports.cards.saveCard(cardWith([version("cv_1", "draft")]), []);

    await expect(
      approveCardVersion(ports, cardId, "cv_1", decision),
    ).rejects.toThrow(CardVersionInvariantError);
    expect((await ports.cards.findCard(cardId))?.versions.currentVersionId).toBe(
      undefined,
    );
  });

  it("rolls back to a previous validated version", async () => {
    await ports.cards.saveCard(
      cardWith([version("cv_1", "validated"), version("cv_2", "validated")]),
      [],
    );
    await approveCardVersion(ports, cardId, "cv_1", decision);
    await approveCardVersion(ports, cardId, "cv_2", decision);

    const rolledBack = await approveCardVersion(
      ports,
      cardId,
      "cv_1",
      decision,
    );

    expect(rolledBack.versions.currentVersionId).toBe("cv_1");
    // The pointer moved back, and history still holds both versions.
    expect(rolledBack.versions.versions.map((entry) => entry.id)).toEqual([
      "cv_1",
      "cv_2",
    ]);
    const trail = await events.listForCard(cardId);
    expect(trail.at(-1)).toMatchObject({
      kind: "card_version_promoted",
      versionId: "cv_1",
      previousVersionId: "cv_2",
    });
  });

  it("records a refusal without promoting anything", async () => {
    await ports.cards.saveCard(
      cardWith([version("cv_1", "validated"), version("cv_2", "validated")]),
      [],
    );
    await approveCardVersion(ports, cardId, "cv_1", decision);

    const refused = await rejectCardVersion(ports, cardId, "cv_2", {
      decidedBy: "operator@example.test",
      note: "표현이 과장됨",
    });

    expect(refused.versions.currentVersionId).toBe("cv_1");
    expect((await events.listForCard(cardId)).at(-1)).toEqual({
      id: "ev_2",
      kind: "card_version_refused",
      cardId,
      occurredAt: "2026-08-04T00:00:00.000Z",
      versionId: "cv_2",
      decidedBy: "operator@example.test",
      note: "표현이 과장됨",
    });
  });

  it("rejects a refusal that names a version outside the card history", async () => {
    await ports.cards.saveCard(cardWith([version("cv_1", "validated")]), []);

    await expect(
      rejectCardVersion(ports, cardId, "cv_missing", decision),
    ).rejects.toThrow(CardNotFoundError);
  });

  it("takes a card out of service while keeping its history", async () => {
    await ports.cards.saveCard(cardWith([version("cv_1", "validated")]), []);
    await approveCardVersion(ports, cardId, "cv_1", decision);

    const disabled = await disableCard(ports, cardId, {
      decidedBy: "operator@example.test",
      note: "원본 문서 삭제됨",
    });

    expect(isCardApproved(disabled)).toBe(false);
    expect(disabled.versions.versions.map((entry) => entry.id)).toEqual([
      "cv_1",
    ]);
    expect((await events.listForCard(cardId)).at(-1)).toMatchObject({
      kind: "card_withdrawn",
      withdrawnVersionId: "cv_1",
      note: "원본 문서 삭제됨",
    });
    // The withdrawal is durable, not just in the returned object.
    expect((await ports.cards.findCard(cardId))?.versions.currentVersionId).toBe(
      undefined,
    );
  });

  it("can restore a withdrawn card by approving a version again", async () => {
    await ports.cards.saveCard(cardWith([version("cv_1", "validated")]), []);
    await approveCardVersion(ports, cardId, "cv_1", decision);
    await disableCard(ports, cardId, decision);

    const restored = await approveCardVersion(ports, cardId, "cv_1", decision);

    expect(isCardApproved(restored)).toBe(true);
  });

  it("reports a decision naming a card that does not exist", async () => {
    await expect(
      approveCardVersion(ports, "unit_missing", "cv_1", decision),
    ).rejects.toThrow(CardNotFoundError);
    await expect(
      disableCard(ports, "unit_missing", decision),
    ).rejects.toThrow(CardNotFoundError);
  });

  it("withdraws a card that was never approved without inventing a version", async () => {
    await ports.cards.saveCard(cardWith([version("cv_1", "validated")]), []);

    const disabled = await disableCard(ports, cardId, decision);

    expect(isCardApproved(disabled)).toBe(false);
    expect((await events.listForCard(cardId)).at(-1)).toEqual({
      id: "ev_1",
      kind: "card_withdrawn",
      cardId,
      occurredAt: "2026-08-04T00:00:00.000Z",
      // No version was current, so none is named as withdrawn.
      withdrawnVersionId: undefined,
      decidedBy: "operator@example.test",
      note: "문서 검토 완료",
    });
  });
});
