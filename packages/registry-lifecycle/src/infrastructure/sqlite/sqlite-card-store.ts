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
  MeaningChangeComparison,
} from "../../domain/card-version.js";
import type { GroundingReport } from "../../domain/fact-grounding.js";
import type {
  CardMeaning,
  CardPolicy,
  ContextCard,
} from "../../domain/context-card.js";
import type { LifecycleEvent } from "../../domain/lifecycle-event.js";
import type { RetrievalScope } from "../../domain/retrieval-scope.js";
import type { CardStore } from "../../ports/card-store.js";
import { writeCard } from "./card-rows.js";
import { inTransaction } from "./registry-database.js";
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
      writeCard(this.#database, card, events);
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
    // NULL means the version predates grounding-v1: nothing was recorded, and
    // the read model says so instead of inventing a report.
    ...optionalJson<CardMeaning>(row, "meaning", "meaning"),
    ...optionalJson<GroundingReport>(row, "grounding", "grounding"),
    ...optionalJson<MeaningChangeComparison>(
      row,
      "change_from_previous",
      "changeFromPrevious",
    ),
  };
}

/**
 * A `{key: parsed}` object when the column holds JSON, `{}` when it is NULL —
 * spreadable under `exactOptionalPropertyTypes`, where assigning an explicit
 * `undefined` is not the same as leaving the key absent.
 */
function optionalJson<T>(
  row: SqlRow,
  column: string,
  key: string,
): Record<string, T> {
  const value = row[column];
  return value === null || value === undefined
    ? {}
    : { [key]: JSON.parse(String(value)) as T };
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
