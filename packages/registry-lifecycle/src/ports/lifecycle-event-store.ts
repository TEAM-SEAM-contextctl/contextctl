import type { CardId } from "../domain/card-version.js";
import type { LifecycleEvent } from "../domain/lifecycle-event.js";

/**
 * Append-only audit trail. Events recorded alongside a Card write go through
 * `CardStore.saveCard` so they share its atomicity; this port covers events
 * that stand alone, such as an impact assessment that changed no Card yet.
 */
export interface LifecycleEventStore {
  append(events: readonly LifecycleEvent[]): Promise<void>;

  /** Events for one Card, in the order they were appended. */
  listForCard(cardId: CardId): Promise<readonly LifecycleEvent[]>;
}
