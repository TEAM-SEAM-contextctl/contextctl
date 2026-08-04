import type { DatabaseSync } from "node:sqlite";

import type { LifecycleEvent } from "../../domain/lifecycle-event.js";
import { nextAppendOrder } from "./registry-database.js";
import { readJson, readText, type SqlRow } from "./row-values.js";

/**
 * Appends events in the given order. Shared by the Card store, so a Card write
 * and the events describing it land inside one transaction.
 */
export function appendLifecycleEvents(
  database: DatabaseSync,
  events: readonly LifecycleEvent[],
): void {
  const insert = database.prepare(
    `INSERT INTO lifecycle_events (
       event_id, card_id, kind, occurred_at, payload, append_order
     ) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (event_id) DO NOTHING`,
  );
  let appendOrder = nextAppendOrder(database, "lifecycle_events");
  for (const event of events) {
    const { id, cardId, kind, occurredAt, ...payload } = event;
    insert.run(
      id,
      cardId,
      kind,
      occurredAt,
      JSON.stringify(payload),
      appendOrder,
    );
    appendOrder += 1;
  }
}

export function readLifecycleEvents(
  database: DatabaseSync,
  cardId: string,
): readonly LifecycleEvent[] {
  const rows = database
    .prepare(
      "SELECT * FROM lifecycle_events WHERE card_id = ? ORDER BY append_order",
    )
    .all(cardId) as SqlRow[];

  return rows.map((row) => toLifecycleEvent(row));
}

function toLifecycleEvent(row: SqlRow): LifecycleEvent {
  // The discriminant and the per-kind payload are reunited here; the payload
  // was split out on write so the shared columns stay queryable.
  const event = {
    id: readText(row, "event_id"),
    cardId: readText(row, "card_id"),
    kind: readText(row, "kind"),
    occurredAt: readText(row, "occurred_at"),
    ...readJson<Record<string, unknown>>(row, "payload"),
  };
  return event as unknown as LifecycleEvent;
}
