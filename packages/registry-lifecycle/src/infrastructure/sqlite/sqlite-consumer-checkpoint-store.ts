import type { DatabaseSync } from "node:sqlite";

import type { PublicationId, SourceId } from "@contextctl/contracts";

import type { ChainCursor } from "../../domain/publication-chain.js";
import type { ConsumerCheckpointStore } from "../../ports/consumer-checkpoint-store.js";
import { inTransaction } from "./registry-database.js";
import { readText, type SqlRow } from "./row-values.js";

/**
 * Durable claim record and per-Source cursor. Because both survive a restart,
 * redelivery of a PublicationReady notification stays a no-op across process
 * lifetimes and a chain resumes where it stopped rather than at its head.
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

  async findCursor(sourceId: SourceId): Promise<ChainCursor | undefined> {
    const row = this.#database
      .prepare(
        "SELECT source_id, publication_id FROM consumer_source_cursors WHERE source_id = ?",
      )
      .get(sourceId) as SqlRow | undefined;
    return row === undefined ? undefined : toCursor(row);
  }

  async markProcessed(cursor: ChainCursor): Promise<void> {
    const processedAt = this.#now();
    // Both writes or neither: a claim without its cursor move would make every
    // successor look like a gap waiting on a Publication already consumed.
    inTransaction(this.#database, () => {
      this.#database
        .prepare(
          `INSERT INTO consumer_checkpoints (publication_id, source_id, processed_at)
           VALUES (?, ?, ?)
           ON CONFLICT (publication_id) DO NOTHING`,
        )
        .run(cursor.publicationId, cursor.sourceId, processedAt);
      this.#database
        .prepare(
          `INSERT INTO consumer_source_cursors (source_id, publication_id, processed_at)
           VALUES (?, ?, ?)
           ON CONFLICT (source_id) DO UPDATE SET
             publication_id = excluded.publication_id,
             processed_at = excluded.processed_at`,
        )
        .run(cursor.sourceId, cursor.publicationId, processedAt);
    });
  }

  async listCursors(): Promise<readonly ChainCursor[]> {
    const rows = this.#database
      .prepare(
        "SELECT source_id, publication_id FROM consumer_source_cursors ORDER BY source_id",
      )
      .all() as SqlRow[];
    return rows.map(toCursor);
  }
}

function toCursor(row: SqlRow): ChainCursor {
  return {
    sourceId: readText(row, "source_id"),
    publicationId: readText(row, "publication_id"),
  };
}
