import { DatabaseSync } from "node:sqlite";

/** Opens the Ingestion control-plane database and applies additive migrations. */
export function openIngestionDatabase(location: string): DatabaseSync {
  const database = new DatabaseSync(location);
  database.exec("PRAGMA foreign_keys = ON");
  database.exec("PRAGMA busy_timeout = 5000");
  if (location !== ":memory:") {
    database.exec("PRAGMA journal_mode = WAL");
    database.exec("PRAGMA synchronous = NORMAL");
  }
  migrate(database);
  return database;
}

function migrate(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS index_versions (
      document_index_id TEXT NOT NULL,
      index_version TEXT NOT NULL,
      payload_schema_version INTEGER NOT NULL,
      publication_json TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      published_at TEXT NOT NULL,
      PRIMARY KEY (document_index_id, index_version)
    );

    CREATE TABLE IF NOT EXISTS current_index_versions (
      document_index_id TEXT PRIMARY KEY,
      index_version TEXT NOT NULL,
      FOREIGN KEY (document_index_id, index_version)
        REFERENCES index_versions (document_index_id, index_version)
    );

    CREATE TABLE IF NOT EXISTS ingestion_publications (
      publication_id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL,
      previous_publication_id TEXT,
      publication_json TEXT NOT NULL,
      produced_at TEXT NOT NULL,
      ready_notified INTEGER NOT NULL DEFAULT 0 CHECK (ready_notified IN (0, 1))
    );

    CREATE INDEX IF NOT EXISTS ingestion_publications_by_source
      ON ingestion_publications (source_id, produced_at, publication_id);

    CREATE TABLE IF NOT EXISTS latest_ingestion_publications (
      source_id TEXT PRIMARY KEY,
      publication_id TEXT NOT NULL REFERENCES ingestion_publications (publication_id)
    );

    CREATE TABLE IF NOT EXISTS markdown_publication_checkpoints (
      source_id TEXT PRIMARY KEY,
      target_key TEXT NOT NULL UNIQUE,
      source_type TEXT NOT NULL,
      document_id TEXT NOT NULL,
      checkpoint_json TEXT NOT NULL
    );
  `);
}

/** Runs one synchronous SQLite transaction and rolls back on every failure. */
export function inIngestionTransaction<T>(
  database: DatabaseSync,
  work: () => T,
): T {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}
