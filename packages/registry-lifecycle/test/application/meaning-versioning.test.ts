import {
  computePublishedKnowledgeUnitDigest,
  parseIngestionPublication,
  type IngestionPublication,
} from "@contextctl/contracts";
import { describe, expect, it } from "vitest";

import { approveCardVersion } from "../../src/application/approve-card-version.js";
import {
  intakePublication,
  type IntakePublicationPorts,
} from "../../src/application/intake-publication.js";
import {
  appendCardVersion,
  promoteCardVersion,
  type CardVersion,
} from "../../src/domain/card-version.js";
import {
  createContextCard,
  withCardVersions,
  type CardMeaning,
  type CardPolicy,
  type ContextCard,
} from "../../src/domain/context-card.js";
import type { GeneratedCardMeaning } from "../../src/ports/card-meaning-generator.js";
import type { PublicationIntake } from "../../src/ports/intake-store.js";
import { openRegistryDatabase } from "../../src/infrastructure/sqlite/registry-database.js";
import { SqliteCardStore } from "../../src/infrastructure/sqlite/sqlite-card-store.js";
import {
  createIngestionPublicationFixture,
  fixtureRootId,
} from "../fixtures/ingestion-publication.fixture.js";

/**
 * Meaning travels with the version, and the serving projection follows it.
 *
 * Before this, a Card's meaning was written once at creation and never again:
 * an updated unit produced a new version but the catalog kept describing the
 * Card with the first version's words. Now the version carries its own meaning,
 * intake records what changed against the predecessor, and a promotion carries
 * the promoted version's words into the projection the catalog serves.
 */

const POLICY: CardPolicy = { sensitive: false, allowedUsage: ["retrieval"] };
const UNIT_ID = "unit_01890f5c-7b1a-7684-8f82-b5950cf2b0dd";

const FIRST_MEANING: CardMeaning = {
  description: "결제 실패 재시도 정책",
  representativeQuestions: ["결제가 실패하면 언제 재시도되나요?"],
  aliases: ["payment retry"],
  keywords: ["payment", "retry"],
};

const SECOND_MEANING: CardMeaning = {
  description: "결제 실패 재시도와 환불 정책",
  representativeQuestions: ["결제가 실패하면 언제 재시도되나요?"],
  aliases: ["payment retry"],
  keywords: ["payment", "refund", "retry"],
};

/** The successor Publication: same unit, edited fact, valid chain link. */
function updatedPublication(): IngestionPublication {
  const base = createIngestionPublicationFixture(fixtureRootId("pub", "second"));
  const unit = base.knowledgeUnits[0];
  if (unit === undefined) {
    throw new Error("fixture must publish one knowledge unit");
  }
  const { contentDigest: previousDigest, ...content } = unit;
  const edited = {
    ...content,
    facts: [{ name: "section.label" as const, value: "Payment failures, revised" }],
  };
  const revised = {
    ...edited,
    contentDigest: computePublishedKnowledgeUnitDigest(edited),
  };
  return parseIngestionPublication({
    ...base,
    previousPublicationId: fixtureRootId("pub", "initial"),
    knowledgeUnits: [revised],
    changes: [
      {
        kind: "updated",
        knowledgeUnitId: unit.id,
        previousContentDigest: previousDigest,
        currentContentDigest: revised.contentDigest,
        changedFields: ["facts"],
      },
    ],
  });
}

/** Fake ports over an in-memory map; the generator's answer varies per call. */
function createPorts(
  publications: readonly IngestionPublication[],
  answers: readonly GeneratedCardMeaning[],
): IntakePublicationPorts & { readonly commits: PublicationIntake[] } {
  const byId = new Map(publications.map((p) => [p.publicationId, p]));
  const cards = new Map<string, ContextCard>();
  const processed = new Set<string>();
  const cursors = new Map<string, { sourceId: string; publicationId: string }>();
  const commits: PublicationIntake[] = [];
  const pending = [...answers];
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
      generate: async () => {
        const answer = pending.shift();
        if (answer === undefined) {
          throw new Error("test asked for more meanings than it provided");
        }
        return answer;
      },
    },
    clock: { now: () => "2026-08-22T00:00:00.000Z" },
    ids: {
      nextId: () => {
        nextId += 1;
        return `id_${nextId}`;
      },
    },
  };
}

describe("meaning travels with the version", () => {
  it("records what the second version changes against the first", async () => {
    const first = createIngestionPublicationFixture();
    const second = updatedPublication();
    const ports = createPorts(
      [first, second],
      [
        { meaning: FIRST_MEANING, origin: { generator: "deterministic" } },
        { meaning: SECOND_MEANING, origin: { generator: "deterministic" } },
      ],
    );

    await intakePublication(ports, first.publicationId, { policy: POLICY });
    await intakePublication(ports, second.publicationId, { policy: POLICY });

    const committed = ports.commits
      .flatMap((intake) => intake.cards)
      .filter(({ card }) => card.id === UNIT_ID)
      .at(-1)?.card;
    const [previous, latest] = committed?.versions.versions ?? [];

    expect(latest?.meaning).toEqual(SECOND_MEANING);
    expect(latest?.changeFromPrevious).toEqual({
      previousVersionId: previous?.id,
      changedFields: ["description", "keywords"],
      coverageLost: [],
      coverageGained: [],
    });
    // The first version has no predecessor, so it carries no comparison —
    // absence of history is stated, not invented.
    expect(previous?.changeFromPrevious).toBeUndefined();
  });

  it("serves the promoted version's words from the approved catalog", async () => {
    const store = new SqliteCardStore(openRegistryDatabase({ location: ":memory:", stateNamespaceId: "state_local", securityDomain: "local" }));
    const versionWith = (id: string, meaning: CardMeaning): CardVersion => ({
      id,
      cardId: UNIT_ID,
      lineage: {
        publicationId: fixtureRootId("pub", "initial"),
        observationId: fixtureRootId("obs", "initial"),
        knowledgeUnitId: UNIT_ID,
      },
      scopes: [
        {
          kind: "managed_document",
          reference: { scopeId: "scope_payment_failures", scopeVersion: "scpv_aaaa" },
          documentIndex: {
            documentIndexId: "didx_payments",
            sourceId: fixtureRootId("src", "payments"),
            documentId: fixtureRootId("doc", "payments"),
            indexVersion: "idxv_aaaa",
          },
          selection: { kind: "semantic_units", semanticUnitIds: [UNIT_ID] },
        },
      ],
      validationState: "validated",
      createdAt: "2026-08-01T00:00:00.000Z",
      meaning,
    });
    let history = appendCardVersion(
      { cardId: UNIT_ID, versions: [], currentVersionId: undefined },
      versionWith("cv_first", FIRST_MEANING),
    );
    history = appendCardVersion(history, versionWith("cv_second", SECOND_MEANING));
    history = promoteCardVersion(history, "cv_first");
    await store.saveCard(
      withCardVersions(createContextCard(UNIT_ID, FIRST_MEANING, POLICY), history),
      [],
    );

    await approveCardVersion(
      { cards: store, clock: { now: () => "2026-08-22T00:00:00.000Z" }, ids: { nextId: () => "ev_1" } },
      UNIT_ID,
      "cv_second",
      { decidedBy: "meaning-versioning-test" },
    );

    // The projection the catalog serves now says what the serving version says.
    // Without the promotion carrying the meaning, this would still read
    // "결제 실패 재시도 정책" while cv_second serves.
    const catalog = await store.listApprovedCards();
    expect(catalog.cards).toEqual([
      expect.objectContaining({
        versionId: "cv_second",
        meaning: SECOND_MEANING,
      }),
    ]);
  });
});
