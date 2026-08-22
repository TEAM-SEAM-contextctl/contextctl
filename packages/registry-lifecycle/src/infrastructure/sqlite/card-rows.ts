import type { DatabaseSync } from "node:sqlite";

import type { ContextCard } from "../../domain/context-card.js";
import type { LifecycleEvent } from "../../domain/lifecycle-event.js";
import { appendLifecycleEvents } from "./lifecycle-event-rows.js";
import { nextAppendOrder } from "./registry-database.js";

/**
 * Writes one Card, its versions, and the events describing the change.
 *
 * Extracted from `SqliteCardStore.saveCard` so the intake adapter can put
 * several Cards and the consumer cursor inside one transaction. Deliberately
 * not wrapped in a transaction here: the caller owns the boundary, because the
 * whole point of sharing this function is that two callers draw it differently
 * — `saveCard` around one Card, intake around a whole Publication.
 */
export function writeCard(
  database: DatabaseSync,
  card: ContextCard,
  events: readonly LifecycleEvent[],
): void {
  database
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
  const insertVersion = database.prepare(
    `INSERT INTO card_versions (
       version_id, card_id, publication_id, observation_id,
       knowledge_unit_id, scopes, validation_state, created_at, append_order,
       meaning, grounding, change_from_previous
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (version_id) DO NOTHING`,
  );
  let appendOrder = nextAppendOrder(database, "card_versions");
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
      version.meaning === undefined ? null : JSON.stringify(version.meaning),
      version.grounding === undefined ? null : JSON.stringify(version.grounding),
      version.changeFromPrevious === undefined
        ? null
        : JSON.stringify(version.changeFromPrevious),
    );
    appendOrder += 1;
  }

  appendLifecycleEvents(database, events);
}
