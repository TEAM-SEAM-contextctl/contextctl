import type { DatabaseSync } from "node:sqlite";

import type {
  IntakeStore,
  PublicationIntake,
} from "../../ports/intake-store.js";
import { writeCard } from "./card-rows.js";
import { writeConsumption } from "./sqlite-consumer-checkpoint-store.js";
import { inTransaction } from "./registry-database.js";

/**
 * Commits a Publication's whole effect in one SQLite transaction.
 *
 * Both halves are possible in one transaction because Cards and consumer
 * cursors live in the same database. That is not incidental — it is why the
 * design can require the two to land together at all, and an adapter putting
 * them in separate stores would owe an answer this one does not.
 *
 * The row writing is the same code the individual stores use: `writeCard` and
 * `writeConsumption` were extracted from `saveCard` and `markProcessed` rather
 * than reimplemented here. Two copies of an upsert drift, and the drift would
 * show up as a Card that reads differently depending on which path stored it.
 */
export class SqliteIntakeStore implements IntakeStore {
  readonly #database: DatabaseSync;
  readonly #now: () => string;

  constructor(database: DatabaseSync, now: () => string) {
    this.#database = database;
    this.#now = now;
  }

  async commit(intake: PublicationIntake): Promise<void> {
    // `node:sqlite` is synchronous and so is this callback: there is no await
    // inside the transaction, so it cannot be left open by a pending promise.
    // Everything asynchronous — the meaning generator, the Card reads — already
    // happened in the use case that assembled `intake`.
    inTransaction(this.#database, () => {
      const processedAt = this.#now();
      for (const { card, events } of intake.cards) {
        writeCard(this.#database, card, events);
      }
      writeConsumption(this.#database, intake.cursor, processedAt);
    });
  }
}
