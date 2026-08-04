import type { DatabaseSync } from "node:sqlite";

import type { PublicationId } from "@contextctl/contracts";

import type { ConsumerCheckpointStore } from "../../ports/consumer-checkpoint-store.js";

/**
 * Durable claim record. Because it survives a restart, redelivery of a
 * PublicationReady notification stays a no-op across process lifetimes.
 */
export class SqliteConsumerCheckpointStore implements ConsumerCheckpointStore {
  readonly #database: DatabaseSync;
  readonly #now: () => string;

  constructor(database: DatabaseSync, now: () => string) {
    this.#database = database;
    this.#now = now;
  }

  async hasProcessed(publicationId: PublicationId): Promise<boolean> {
    const row = this.#database
      .prepare(
        "SELECT 1 AS present FROM consumer_checkpoints WHERE publication_id = ?",
      )
      .get(publicationId);
    return row !== undefined;
  }

  async markProcessed(publicationId: PublicationId): Promise<void> {
    this.#database
      .prepare(
        `INSERT INTO consumer_checkpoints (publication_id, processed_at)
         VALUES (?, ?)
         ON CONFLICT (publication_id) DO NOTHING`,
      )
      .run(publicationId, this.#now());
  }
}
