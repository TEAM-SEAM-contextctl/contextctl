import {
  parseIngestionPublication,
  type IngestionPublication,
} from "@contextctl/contracts";
import { describe, expect, it } from "vitest";

import {
  intakePublication,
  type IntakePublicationPorts,
} from "../../src/application/intake-publication.js";
import type { CardVersion } from "../../src/domain/card-version.js";
import {
  createContextCard,
  withCardVersions,
  type CardMeaning,
  type CardPolicy,
  type ContextCard,
} from "../../src/domain/context-card.js";
import type { LifecycleEvent } from "../../src/domain/lifecycle-event.js";
import type { RetrievalScope } from "../../src/domain/retrieval-scope.js";
import type { PublicationIntake } from "../../src/ports/intake-store.js";
import {
  createIngestionPublicationFixture,
  fixtureRootId,
} from "../fixtures/ingestion-publication.fixture.js";

/**
 * What a Publication's changes do to the Cards already serving.
 *
 * Before this, Registry read `knowledgeUnits` and ignored `changes` — so a
 * section deleted from a document left its approved Card current, and a query
 * kept answering from knowledge the source no longer had. The impact rules
 * existed and nothing called them.
 *
 * The pointer is the whole subject here. A Card serves exactly what
 * `currentVersionId` names, so "withdrawn" and "still serving" are both read off
 * that one field, and every assertion below is about which of the two happened.
 */

const POLICY: CardPolicy = { sensitive: false, allowedUsage: ["retrieval"] };
const SOURCE_ID = fixtureRootId("src", "payments");
const UNIT_ID = "unit_01890f5c-7b1a-7684-8f82-b5950cf2b0dd";
const OTHER_UNIT_ID = "unit_01890f5c-7b1a-7684-8f82-b5950cf2b0de";

/**
 * The Publication these tests' successors follow.
 *
 * A change other than `added` only exists on a successor — v2 refuses `removed`
 * and `updated` on a chain's first link — so every fixture here names a
 * predecessor, and the ports below put the Source's cursor on it.
 */
const PREVIOUS_PUBLICATION_ID = fixtureRootId("pub", "earlier");

/** A well-formed digest that differs from the fixture's, for `updated` changes. */
const PREVIOUS_DIGEST =
  "sha256:0000000000000000000000000000000000000000000000000000000000000001";

const meaning: CardMeaning = {
  description: "결제 실패 재시도 정책",
  representativeQuestions: ["결제가 실패하면 언제 재시도되나요?"],
  aliases: ["payment retry"],
  keywords: ["payment", "retry"],
};

/** The Scope the fixture's unit publishes, as a Card carries it. */
const SERVING_SCOPE: RetrievalScope = {
  kind: "managed_document",
  reference: { scopeId: "scope_payment_failures", scopeVersion: "scpv_aaaa" },
  documentIndex: {
    documentIndexId: "didx_payments",
    sourceId: SOURCE_ID,
    documentId: fixtureRootId("doc", "payments"),
    indexVersion: "idxv_aaaa",
  },
  selection: { kind: "semantic_units", semanticUnitIds: [UNIT_ID] },
};

/** A Card already approved and serving, as the store would return it. */
function servingCard(
  cardId: string,
  scope: RetrievalScope = SERVING_SCOPE,
): ContextCard {
  const version: CardVersion = {
    id: `serving_${cardId}`,
    cardId,
    lineage: {
      publicationId: fixtureRootId("pub", "earlier"),
      observationId: fixtureRootId("obs", "initial"),
      knowledgeUnitId: cardId,
    },
    scopes: [scope],
    validationState: "validated",
    createdAt: "2026-08-01T00:00:00.000Z",
  };
  return withCardVersions(createContextCard(cardId, meaning, POLICY), {
    cardId,
    versions: [version],
    currentVersionId: version.id,
  });
}

/**
 * A Publication that removes the fixture's unit.
 *
 * A removal publishes no unit for it — that absence is what `removed` means —
 * so the Publication carries a different unit to stay a valid record, and the
 * change names the one that went away.
 */
function removalPublication(): IngestionPublication {
  const base = createIngestionPublicationFixture(fixtureRootId("pub", "second"));
  const digest = base.knowledgeUnits[0]?.contentDigest;
  if (digest === undefined) {
    throw new Error("fixture must publish one knowledge unit");
  }
  return parseIngestionPublication({
    ...base,
    previousPublicationId: PREVIOUS_PUBLICATION_ID,
    knowledgeUnits: [],
    changes: [
      {
        kind: "removed",
        knowledgeUnitId: UNIT_ID,
        // The digest of what went away: the contract requires a removal to name
        // the content it removed, so the trail says which revision was dropped.
        previousContentDigest: digest,
      },
    ],
  });
}

/** A Publication that updates the fixture's unit, declaring changed facts. */
function updatePublication(): IngestionPublication {
  const base = createIngestionPublicationFixture(fixtureRootId("pub", "second"));
  const unit = base.knowledgeUnits[0];
  if (unit === undefined) {
    throw new Error("fixture must publish one knowledge unit");
  }
  return parseIngestionPublication({
    ...base,
    previousPublicationId: PREVIOUS_PUBLICATION_ID,
    changes: [
      {
        kind: "updated",
        knowledgeUnitId: unit.id,
        previousContentDigest: PREVIOUS_DIGEST,
        currentContentDigest: unit.contentDigest,
        changedFields: ["facts"],
      },
    ],
  });
}

interface Recorder {
  readonly commits: PublicationIntake[];
}

function createPorts(
  publications: readonly IngestionPublication[],
  stored: readonly ContextCard[] = [],
): IntakePublicationPorts & Recorder {
  const byId = new Map(publications.map((p) => [p.publicationId, p]));
  const cards = new Map(stored.map((card) => [card.id, card]));
  const processed = new Set<string>();
  const cursors = new Map<string, { sourceId: string; publicationId: string }>(
    // Consuming a successor requires the predecessor to be behind the cursor;
    // without it the claim answers `deferred` and nothing is asserted.
    publications.some((p) => p.previousPublicationId !== undefined)
      ? [[SOURCE_ID, { sourceId: SOURCE_ID, publicationId: PREVIOUS_PUBLICATION_ID }]]
      : [],
  );
  const commits: PublicationIntake[] = [];
  let nextId = 0;

  return {
    commits,
    publications: { findById: async (id) => byId.get(id) },
    checkpoints: {
      hasProcessed: async (id) => processed.has(id),
      findCursor: async (sourceId) => cursors.get(sourceId),
      markProcessed: async (cursor) => {
        processed.add(cursor.publicationId);
        cursors.set(cursor.sourceId, cursor);
      },
      listCursors: async () => [...cursors.values()],
    },
    cards: {
      findCard: async (cardId) => cards.get(cardId),
      listCurrentVersions: async () =>
        [...cards.values()].flatMap((card) => {
          const current = card.versions.versions.find(
            (version) => version.id === card.versions.currentVersionId,
          );
          return current === undefined ? [] : [current];
        }),
      listApprovedCards: async () => ({
        catalogSnapshotVersion: "snapshot",
        cards: [],
      }),
      saveCard: async () => undefined,
    },
    intake: {
      commit: async (intake) => {
        commits.push(intake);
        for (const { card } of intake.cards) {
          cards.set(card.id, card);
        }
        processed.add(intake.cursor.publicationId);
        cursors.set(intake.cursor.sourceId, intake.cursor);
      },
    },
    meanings: {
      generate: async () => ({ meaning, origin: { generator: "deterministic" } }),
    },
    clock: { now: () => "2026-08-21T00:00:00.000Z" },
    ids: {
      nextId: () => {
        nextId += 1;
        return `id_${nextId}`;
      },
    },
  };
}

/** The committed Card for `cardId`, or a failure naming what was committed. */
function committed(ports: Recorder, cardId: string): ContextCard {
  const entry = ports.commits
    .flatMap((intake) => intake.cards)
    .find(({ card }) => card.id === cardId);
  if (entry === undefined) {
    throw new Error(
      `no commit for ${cardId}; committed: ${ports.commits
        .flatMap((intake) => intake.cards.map(({ card }) => card.id))
        .join(", ")}`,
    );
  }
  return entry.card;
}

function eventsFor(ports: Recorder, cardId: string): readonly LifecycleEvent[] {
  return ports.commits
    .flatMap((intake) => intake.cards)
    .filter(({ card }) => card.id === cardId)
    .flatMap(({ events }) => events);
}

describe("intakePublication propagating changes", () => {
  it("withdraws a Card whose knowledge was removed", async () => {
    const publication = removalPublication();
    const ports = createPorts([publication], [servingCard(UNIT_ID)]);

    await intakePublication(ports, publication.publicationId, {
      policy: POLICY,
    });

    // The pointer is gone, so the Card leaves the approved catalog and stops
    // being selectable. ADR 0005: immediately, with no grace period.
    expect(committed(ports, UNIT_ID).versions.currentVersionId).toBeUndefined();
  });

  it("keeps the withdrawn version in history", async () => {
    // Withdrawal is a pointer move, not a deletion — an operator can promote it
    // again if the source comes back.
    const publication = removalPublication();
    const ports = createPorts([publication], [servingCard(UNIT_ID)]);

    await intakePublication(ports, publication.publicationId, {
      policy: POLICY,
    });

    expect(committed(ports, UNIT_ID).versions.versions).toHaveLength(1);
  });

  it("records the rule that withdrew it, and claims no operator decided", async () => {
    const publication = removalPublication();
    const ports = createPorts([publication], [servingCard(UNIT_ID)]);

    await intakePublication(ports, publication.publicationId, {
      policy: POLICY,
    });

    const events = eventsFor(ports, UNIT_ID);
    expect(events).toEqual([
      expect.objectContaining({
        kind: "card_impact_assessed",
        decision: "disable",
        reasons: [expect.objectContaining({ rule: "change.removed" })],
      }),
    ]);
    // `card_withdrawn` would be a lie twice over: it names the operator who
    // decided, and reachability reads it as a deliberate exclusion. See ADR 0005.
    expect(events.map((event) => event.kind)).not.toContain("card_withdrawn");
  });

  it("leaves a Card the change did not name alone", async () => {
    const publication = removalPublication();
    const ports = createPorts(
      [publication],
      [servingCard(UNIT_ID), servingCard(OTHER_UNIT_ID)],
    );

    await intakePublication(ports, publication.publicationId, {
      policy: POLICY,
    });

    // Not re-evaluated, not re-written: an intake touches the Cards a change
    // names and nothing else.
    expect(
      ports.commits
        .flatMap((intake) => intake.cards.map(({ card }) => card.id)),
    ).not.toContain(OTHER_UNIT_ID);
  });

  it("keeps serving a Card whose paragraph was edited", async () => {
    // `review`, not withdrawal. The source still says what the serving version
    // claims — it just says more now, and the new draft waits for an operator.
    const publication = updatePublication();
    const ports = createPorts([publication], [servingCard(UNIT_ID)]);

    await intakePublication(ports, publication.publicationId, {
      policy: POLICY,
    });

    const card = committed(ports, UNIT_ID);
    expect(card.versions.currentVersionId).toBe(`serving_${UNIT_ID}`);
    expect(card.versions.versions).toHaveLength(2);
  });

  it("reports the review without changing what is served", async () => {
    const publication = updatePublication();
    const ports = createPorts([publication], [servingCard(UNIT_ID)]);

    await intakePublication(ports, publication.publicationId, {
      policy: POLICY,
    });

    expect(eventsFor(ports, UNIT_ID)).toEqual([
      expect.objectContaining({ kind: "card_version_added" }),
      expect.objectContaining({
        kind: "card_impact_assessed",
        decision: "review",
      }),
    ]);
  });

  it("withdraws a Card whose coordinate is gone while adding the new draft", async () => {
    // `block`: the update kept the unit but moved a coordinate the Card named.
    // The Card is on both sides at once — it gains a version and loses the
    // pointer — and both have to land on one committed Card.
    const publication = updatePublication();
    const strandedScope: RetrievalScope = {
      ...SERVING_SCOPE,
      documentIndex: {
        ...SERVING_SCOPE.documentIndex,
        documentId: fixtureRootId("doc", "removed"),
      },
    };
    const ports = createPorts(
      [publication],
      [servingCard(UNIT_ID, strandedScope)],
    );

    await intakePublication(ports, publication.publicationId, {
      policy: POLICY,
    });

    const card = committed(ports, UNIT_ID);
    expect(card.versions.currentVersionId).toBeUndefined();
    expect(card.versions.versions).toHaveLength(2);
    expect(eventsFor(ports, UNIT_ID)).toEqual([
      expect.objectContaining({ kind: "card_version_added" }),
      expect.objectContaining({
        kind: "card_impact_assessed",
        decision: "block",
      }),
    ]);
  });

  it("commits the withdrawal in the same intake as the cursor", async () => {
    // SEAM-110's transaction is what makes this safe: a crash cannot leave the
    // Card withdrawn with the Publication unconsumed, or the reverse.
    const publication = removalPublication();
    const ports = createPorts([publication], [servingCard(UNIT_ID)]);

    await intakePublication(ports, publication.publicationId, {
      policy: POLICY,
    });

    expect(ports.commits).toHaveLength(1);
    expect(ports.commits[0]?.cursor).toEqual({
      sourceId: publication.sourceId,
      publicationId: publication.publicationId,
    });
  });

  it("does not withdraw twice when the Publication is redelivered", async () => {
    const publication = removalPublication();
    const ports = createPorts([publication], [servingCard(UNIT_ID)]);
    await intakePublication(ports, publication.publicationId, {
      policy: POLICY,
    });

    const again = await intakePublication(ports, publication.publicationId, {
      policy: POLICY,
    });

    expect(again.status).toBe("already_claimed");
    expect(ports.commits).toHaveLength(1);
  });

  it("does not touch existing Cards when a unit is added", async () => {
    // `added` has no transition of its own — the new Card *is* the effect. The
    // Card already serving another unit must not be dragged into it.
    const publication = createIngestionPublicationFixture();
    const ports = createPorts([publication], [servingCard(OTHER_UNIT_ID)]);

    await intakePublication(ports, publication.publicationId, {
      policy: POLICY,
    });

    expect(
      ports.commits.flatMap((intake) => intake.cards.map(({ card }) => card.id)),
    ).toEqual([UNIT_ID]);
  });
});
