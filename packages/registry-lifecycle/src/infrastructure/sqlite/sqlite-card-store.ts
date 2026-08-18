import type { DatabaseSync } from "node:sqlite";

import {
  toApprovedCardCatalogSnapshot,
  type ApprovedCardCatalogSnapshot,
  type CardCatalogEntry,
} from "../../domain/card-catalog.js";
import type {
  CardId,
  CardValidationState,
  CardVersion,
} from "../../domain/card-version.js";
import type {
  CardMeaning,
  CardPolicy,
  ContextCard,
} from "../../domain/context-card.js";
import type { LifecycleEvent } from "../../domain/lifecycle-event.js";
import type { RetrievalScope } from "../../domain/retrieval-scope.js";
import type { CardStore } from "../../ports/card-store.js";
import { appendLifecycleEvents } from "./lifecycle-event-rows.js";
import { inTransaction, nextAppendOrder } from "./registry-database.js";
import {
  readInteger,
  readJson,
  readOptionalText,
  readText,
  RegistryRowError,
  type SqlRow,
} from "./row-values.js";

export class SqliteCardStore implements CardStore {
  readonly #database: DatabaseSync;

  constructor(database: DatabaseSync) {
    this.#database = database;
  }

  async findCard(cardId: CardId): Promise<ContextCard | undefined> {
    const card = this.#database
      .prepare("SELECT * FROM cards WHERE card_id = ?")
      .get(cardId) as SqlRow | undefined;
    if (card === undefined) {
      return undefined;
    }

    const versions = this.#database
      .prepare(
        "SELECT * FROM card_versions WHERE card_id = ? ORDER BY append_order",
      )
      .all(cardId) as SqlRow[];
    const storedCardId = readText(card, "card_id");

    return {
      id: storedCardId,
      meaning: readMeaning(card),
      policy: readPolicy(card),
      versions: {
        cardId: storedCardId,
        versions: versions.map(toCardVersion),
        currentVersionId: readOptionalText(card, "current_version_id"),
      },
    };
  }

  async listCurrentVersions(): Promise<readonly CardVersion[]> {
    const rows = this.#database
      .prepare(
        `SELECT v.* FROM card_versions v
         JOIN cards c ON c.current_version_id = v.version_id
         ORDER BY v.append_order`,
      )
      .all() as SqlRow[];
    return rows.map(toCardVersion);
  }

  async listApprovedCards(): Promise<ApprovedCardCatalogSnapshot> {
    // One join, not one query per Card: the join to current_version_id both
    // pulls the meaning alongside the scopes and drops unapproved Cards.
    const rows = this.#database
      .prepare(
        `SELECT
           c.card_id, c.description, c.representative_questions, c.aliases,
           c.keywords, c.sensitive, c.allowed_usage,
           v.version_id, v.scopes
         FROM cards c
         JOIN card_versions v ON v.version_id = c.current_version_id
         ORDER BY v.append_order`,
      )
      .all() as SqlRow[];

    const cards: readonly CardCatalogEntry[] = rows.map((row) => ({
      cardId: readText(row, "card_id"),
      versionId: readText(row, "version_id"),
      meaning: readMeaning(row),
      policy: readPolicy(row),
      scopes: readJson<readonly RetrievalScope[]>(row, "scopes"),
    }));

    return toApprovedCardCatalogSnapshot(cards);
  }

  async saveCard(
    card: ContextCard,
    events: readonly LifecycleEvent[],
  ): Promise<void> {
    inTransaction(this.#database, () => {
      this.#database
        .prepare(
          `INSERT INTO cards (
             card_id, description, representative_questions, aliases, keywords,
             sensitive, allowed_usage, current_version_id
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (card_id) DO UPDATE SET
             description = excluded.description,
             representative_questions = excluded.representative_questions,
             aliases = excluded.aliases,
             keywords = excluded.keywords,
             sensitive = excluded.sensitive,
             allowed_usage = excluded.allowed_usage,
             current_version_id = excluded.current_version_id`,
        )
        .run(
          card.id,
          card.meaning.description,
          JSON.stringify(card.meaning.representativeQuestions),
          JSON.stringify(card.meaning.aliases),
          JSON.stringify(card.meaning.keywords),
          card.policy.sensitive ? 1 : 0,
          JSON.stringify(card.policy.allowedUsage),
          card.versions.currentVersionId ?? null,
        );

      // DO NOTHING keeps history append-only: a version already written is
      // never rewritten, so an earlier last-known-good cannot be clobbered.
      const insertVersion = this.#database.prepare(
        `INSERT INTO card_versions (
           version_id, card_id, publication_id, observation_id,
           knowledge_unit_id, scopes, validation_state, created_at, append_order
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (version_id) DO NOTHING`,
      );
      let appendOrder = nextAppendOrder(this.#database, "card_versions");
      for (const version of card.versions.versions) {
        insertVersion.run(
          version.id,
          version.cardId,
          version.lineage.publicationId,
          version.lineage.observationId,
          version.lineage.knowledgeUnitId,
          JSON.stringify(version.scopes),
          version.validationState,
          version.createdAt,
          appendOrder,
        );
        appendOrder += 1;
      }

      appendLifecycleEvents(this.#database, events);
    });
  }
}

function readMeaning(row: SqlRow): CardMeaning {
  return {
    description: readText(row, "description"),
    representativeQuestions: readJson<readonly string[]>(
      row,
      "representative_questions",
    ),
    aliases: readJson<readonly string[]>(row, "aliases"),
    keywords: readJson<readonly string[]>(row, "keywords"),
  };
}

function readPolicy(row: SqlRow): CardPolicy {
  return {
    sensitive: readInteger(row, "sensitive") === 1,
    allowedUsage: readJson<readonly string[]>(row, "allowed_usage"),
  };
}

function toCardVersion(row: SqlRow): CardVersion {
  return {
    id: readText(row, "version_id"),
    cardId: readText(row, "card_id"),
    lineage: {
      publicationId: readText(row, "publication_id"),
      observationId: readText(row, "observation_id"),
      knowledgeUnitId: readText(row, "knowledge_unit_id"),
    },
    scopes: readJson<readonly RetrievalScope[]>(row, "scopes"),
    validationState: readValidationState(row),
    createdAt: readText(row, "created_at"),
  };
}

const validationStates: readonly CardValidationState[] = [
  "draft",
  "validated",
  "rejected",
];

function readValidationState(row: SqlRow): CardValidationState {
  const value = readText(row, "validation_state");
  const state = validationStates.find((candidate) => candidate === value);
  if (state === undefined) {
    throw new RegistryRowError("validation_state", value);
  }
  return state;
}
