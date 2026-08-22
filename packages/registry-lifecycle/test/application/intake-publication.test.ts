import {
  parseIngestionPublication,
  type IngestionPublication,
} from "@contextctl/contracts";
import { describe, expect, it } from "vitest";

import {
  intakePublication,
  type IntakePublicationPorts,
} from "../../src/application/intake-publication.js";
import {
  createContextCard,
  withCardVersions,
  type CardMeaning,
  type CardPolicy,
  type ContextCard,
} from "../../src/domain/context-card.js";
import type { PublicationIntake } from "../../src/ports/intake-store.js";
import {
  createIngestionPublicationFixture,
  fixtureRootId,
} from "../fixtures/ingestion-publication.fixture.js";

/**
 * Consumption as one commit, asserted at the use case rather than the adapter.
 *
 * The failure this closes is a shape rather than a query: Cards used to be
 * stored one at a time and the cursor moved afterwards, so a crash in between
 * left drafts with the Publication still unconsumed. What has to be true now is
 * that the two reach the store together, and that nothing reaches it at all when
 * the Publication was refused. A fake store makes both observable — the SQLite
 * adapter's own test proves the transaction, this one proves what is handed to it.
 */

const POLICY: CardPolicy = { sensitive: false, allowedUsage: ["retrieval"] };

const meaning: CardMeaning = {
  description: "결제 실패 재시도 정책",
  representativeQuestions: ["결제가 실패하면 언제 재시도되나요?"],
  aliases: ["payment retry"],
  keywords: ["payment", "retry"],
};

interface Recorder {
  readonly commits: PublicationIntake[];
  readonly processedCalls: string[];
  readonly savedCards: string[];
}

function createPorts(
  publications: readonly IngestionPublication[],
  options: {
    readonly stored?: readonly ContextCard[];
    readonly failCommit?: boolean;
    /** Distinguishes ids across two sets of ports in one test. */
    readonly idPrefix?: string;
  } = {},
): IntakePublicationPorts & Recorder {
  const byId = new Map(publications.map((p) => [p.publicationId, p]));
  const cards = new Map((options.stored ?? []).map((card) => [card.id, card]));
  const processed = new Set<string>();
  const cursors = new Map<string, { sourceId: string; publicationId: string }>();
  const commits: PublicationIntake[] = [];
  const processedCalls: string[] = [];
  const savedCards: string[] = [];
  let nextId = 0;

  return {
    commits,
    processedCalls,
    savedCards,
    publications: { findById: async (id) => byId.get(id) },
    checkpoints: {
      hasProcessed: async (id) => processed.has(id),
      findCursor: async (sourceId) => cursors.get(sourceId),
      markProcessed: async (cursor) => {
        processedCalls.push(cursor.publicationId);
        processed.add(cursor.publicationId);
        cursors.set(cursor.sourceId, cursor);
      },
      listCursors: async () => [...cursors.values()],
    },
    cards: {
      findCard: async (cardId) => cards.get(cardId),
      listCurrentVersions: async () => [],
      listApprovedCards: async () => ({
        catalogSnapshotVersion: "snapshot",
        cards: [],
      }),
      saveCard: async (card) => {
        savedCards.push(card.id);
      },
    },
    intake: {
      commit: async (intake) => {
        if (options.failCommit === true) {
          throw new Error("commit failed");
        }
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
        return `${options.idPrefix ?? "id"}_${nextId}`;
      },
    },
  };
}

describe("intakePublication", () => {
  it("commits every Card and the cursor in one call", async () => {
    const publication = createIngestionPublicationFixture();
    const ports = createPorts([publication]);

    const result = await intakePublication(
      ports,
      publication.publicationId,
      { policy: POLICY },
    );

    expect(result.status).toBe("claimed");
    // One commit, carrying both halves. Before this the Cards went in one at a
    // time and the cursor moved in a separate call afterwards.
    expect(ports.commits).toHaveLength(1);
    const [intake] = ports.commits;
    expect(intake?.cards.map(({ card }) => card.id)).toEqual([
      publication.knowledgeUnits[0]?.id,
    ]);
    expect(intake?.cursor).toEqual({
      sourceId: publication.sourceId,
      publicationId: publication.publicationId,
    });
  });

  it("never stores a Card outside that commit", async () => {
    // `saveCard` is still on the port for the operator decisions, and this is
    // the assertion that intake stopped using it: a Card written there would be
    // a Card written outside the transaction the cursor moves in.
    const ports = createPorts([createIngestionPublicationFixture()]);

    await intakePublication(ports, fixtureRootId("pub", "initial"), {
      policy: POLICY,
    });

    expect(ports.savedCards).toEqual([]);
    expect(ports.processedCalls).toEqual([]);
  });

  it("carries the version and the lifecycle event that describes it", async () => {
    const ports = createPorts([createIngestionPublicationFixture()]);

    await intakePublication(ports, fixtureRootId("pub", "initial"), {
      policy: POLICY,
    });

    const [entry] = ports.commits[0]?.cards ?? [];
    expect(entry?.card.versions.versions).toHaveLength(1);
    expect(entry?.events).toEqual([
      expect.objectContaining({ kind: "card_version_added" }),
    ]);
    // No current pointer: a claimed version is a draft until an operator
    // promotes it, and intake must not promote on its own.
    expect(entry?.card.versions.currentVersionId).toBeUndefined();
  });

  it("appends to a Card that already exists instead of replacing it", async () => {
    const publication = createIngestionPublicationFixture();
    const first = createPorts([publication]);
    await intakePublication(first, publication.publicationId, {
      policy: POLICY,
    });
    const stored = first.commits[0]?.cards[0]?.card;
    if (stored === undefined) {
      throw new Error("expected the first intake to produce a Card");
    }

    // A second Publication for the same unit — the append-only history has to
    // grow rather than the Card being recreated from scratch.
    const second = createPorts([publication], {
      stored: [stored],
      idPrefix: "second",
    });
    // The claim record lives in the fake checkpoints, which this second set of
    // ports does not share, so the same Publication is claimable again.
    await intakePublication(second, publication.publicationId, {
      policy: POLICY,
    });

    expect(second.commits[0]?.cards[0]?.card.versions.versions).toHaveLength(2);
  });

  it("leaves an approved Card serving when a new version arrives", async () => {
    // SEAM-106 §9.1: re-processing must not change the current pointer. This is
    // the case where it would matter — a Card an operator already approved gains
    // a draft, and if intake carried a cleared pointer through the upsert the
    // Card would silently stop being served while looking untouched.
    const publication = createIngestionPublicationFixture();
    const cardId = publication.knowledgeUnits[0]?.id ?? "";
    const approved = withCardVersions(
      createContextCard(cardId, meaning, POLICY),
      {
        cardId,
        versions: [
          {
            id: "approved_version",
            cardId,
            lineage: {
              publicationId: fixtureRootId("pub", "earlier"),
              observationId: fixtureRootId("obs", "initial"),
              knowledgeUnitId: cardId,
            },
            scopes: [],
            validationState: "validated",
            createdAt: "2026-08-01T00:00:00.000Z",
          },
        ],
        currentVersionId: "approved_version",
      },
    );
    const ports = createPorts([publication], { stored: [approved] });

    await intakePublication(ports, publication.publicationId, {
      policy: POLICY,
    });

    const committed = ports.commits[0]?.cards[0]?.card;
    expect(committed?.versions.currentVersionId).toBe("approved_version");
    expect(committed?.versions.versions).toHaveLength(2);
  });

  it("commits nothing when the claim was refused", async () => {
    // A gap: the Publication names a predecessor nobody consumed.
    const first = createIngestionPublicationFixture(fixtureRootId("pub", "first"));
    const second = parseIngestionPublication({
      ...first,
      publicationId: fixtureRootId("pub", "second"),
      previousPublicationId: first.publicationId,
    });
    const ports = createPorts([second]);
    const publication = second;

    const result = await intakePublication(
      ports,
      publication.publicationId,
      { policy: POLICY },
    );

    expect(result.status).toBe("deferred");
    expect(ports.commits).toEqual([]);
  });

  it("leaves the Publication unconsumed when the commit fails", async () => {
    // The recoverable side of the failure. Nothing is stored and the cursor did
    // not move, so a retry re-produces the same versions rather than the
    // Publication counting as consumed with no Card to show for it.
    const publication = createIngestionPublicationFixture();
    const ports = createPorts([publication], { failCommit: true });

    await expect(
      intakePublication(ports, publication.publicationId, { policy: POLICY }),
    ).rejects.toThrow("commit failed");

    expect(await ports.checkpoints.hasProcessed(publication.publicationId)).toBe(
      false,
    );
    expect(ports.savedCards).toEqual([]);
  });

  it("is a no-op for a Publication already claimed", async () => {
    const publication = createIngestionPublicationFixture();
    const ports = createPorts([publication]);
    await intakePublication(ports, publication.publicationId, {
      policy: POLICY,
    });

    const again = await intakePublication(ports, publication.publicationId, {
      policy: POLICY,
    });

    expect(again.status).toBe("already_claimed");
    expect(ports.commits).toHaveLength(1);
  });
});
