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
    // Both writes or neither: a claim without its cursor move would make every
    // successor look like a gap waiting on a Publication already consumed.
    inTransaction(this.#database, () => {
      writeConsumption(this.#database, cursor, this.#now());
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

/**
 * Records the claim and moves the Source's cursor to it.
 *
 * Shared with the intake adapter so consumption can be committed in the same
 * transaction as the Cards it produced. No transaction here for the reason
 * `writeCard` gives: the boundary belongs to whoever is deciding what has to
 * succeed together.
 */
export function writeConsumption(
  database: DatabaseSync,
  cursor: ChainCursor,
  processedAt: string,
): void {
  database
    .prepare(
      `INSERT INTO consumer_checkpoints (publication_id, source_id, processed_at)
       VALUES (?, ?, ?)
       ON CONFLICT (publication_id) DO NOTHING`,
    )
    .run(cursor.publicationId, cursor.sourceId, processedAt);
  database
    .prepare(
      `INSERT INTO consumer_source_cursors (source_id, publication_id, processed_at)
       VALUES (?, ?, ?)
       ON CONFLICT (source_id) DO UPDATE SET
         publication_id = excluded.publication_id,
         processed_at = excluded.processed_at`,
    )
    .run(cursor.sourceId, cursor.publicationId, processedAt);
}

function toCursor(row: SqlRow): ChainCursor {
  return {
    sourceId: readText(row, "source_id"),
    publicationId: readText(row, "publication_id"),
  };
}
