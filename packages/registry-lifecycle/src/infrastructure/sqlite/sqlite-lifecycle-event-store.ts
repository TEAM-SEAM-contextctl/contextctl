import type { DatabaseSync } from "node:sqlite";

import type { CardId } from "../../domain/card-version.js";
import type { LifecycleEvent } from "../../domain/lifecycle-event.js";
import type { LifecycleEventStore } from "../../ports/lifecycle-event-store.js";
import {
  appendLifecycleEvents,
  readLifecycleEvents,
} from "./lifecycle-event-rows.js";
import { inTransaction } from "./registry-database.js";

export class SqliteLifecycleEventStore implements LifecycleEventStore {
  readonly #database: DatabaseSync;

  constructor(database: DatabaseSync) {
    this.#database = database;
  }

  async append(events: readonly LifecycleEvent[]): Promise<void> {
    inTransaction(this.#database, () => {
      appendLifecycleEvents(this.#database, events);
    });
  }

  async listForCard(cardId: CardId): Promise<readonly LifecycleEvent[]> {
    return readLifecycleEvents(this.#database, cardId);
  }
}
