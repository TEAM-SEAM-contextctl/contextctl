import { DatabaseSync } from "node:sqlite";

/**
 * Opens the Registry database and brings its schema up to date.
 *
 * The schema lives here rather than in a shared location: SQL dialects differ,
 * so another adapter must be free to define its own without negotiating with
 * this one. Scope collections are stored as JSON documents because Registry
 * never filters inside them in SQL — it reads whole read models back out.
 */
export function openRegistryDatabase(location: string): DatabaseSync {
  const database = new DatabaseSync(location);
  database.exec("PRAGMA foreign_keys = ON");
  migrate(database);
  return database;
}

function migrate(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS cards (
      card_id TEXT PRIMARY KEY,
      description TEXT NOT NULL,
      representative_questions TEXT NOT NULL,
      aliases TEXT NOT NULL,
      keywords TEXT NOT NULL,
      sensitive INTEGER NOT NULL,
      allowed_usage TEXT NOT NULL,
      current_version_id TEXT
    );

    CREATE TABLE IF NOT EXISTS card_versions (
      version_id TEXT PRIMARY KEY,
      card_id TEXT NOT NULL REFERENCES cards (card_id),
      publication_id TEXT NOT NULL,
      observation_id TEXT NOT NULL,
      knowledge_unit_id TEXT NOT NULL,
      scopes TEXT NOT NULL,
      validation_state TEXT NOT NULL,
      created_at TEXT NOT NULL,
      append_order INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS card_versions_by_card
      ON card_versions (card_id, append_order);

    CREATE TABLE IF NOT EXISTS lifecycle_events (
      event_id TEXT PRIMARY KEY,
      card_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      payload TEXT NOT NULL,
      append_order INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS lifecycle_events_by_card
      ON lifecycle_events (card_id, append_order);

    CREATE TABLE IF NOT EXISTS consumer_checkpoints (
      publication_id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL,
      processed_at TEXT NOT NULL
    );

    -- How far each Source's Publication chain has been consumed. Separate from
    -- the claim record above because the two answer different questions: one
    -- says a Publication was handled, this one says which may be handled next.
    CREATE TABLE IF NOT EXISTS consumer_source_cursors (
      source_id TEXT PRIMARY KEY,
      publication_id TEXT NOT NULL,
      processed_at TEXT NOT NULL
    );
  `);
}

/**
 * Runs `work` inside a single transaction, rolling back if it throws so a
 * failed save leaves no partial state behind.
 */
export function inTransaction<T>(database: DatabaseSync, work: () => T): T {
  database.exec("BEGIN");
  try {
    const result = work();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

/** Next append position for an ordered table, so read order is write order. */
export function nextAppendOrder(
  database: DatabaseSync,
  table: "card_versions" | "lifecycle_events",
): number {
  const row = database
    .prepare(`SELECT COALESCE(MAX(append_order), 0) AS current FROM ${table}`)
    .get() as { current: number } | undefined;
  return (row?.current ?? 0) + 1;
}
