import { DatabaseSync } from "node:sqlite";

/**
 * The owner mark Registry stamps into its database file's header.
 *
 * "CTXR" as bytes. Deliberately different from Ingestion's `0x4354584C`
 * ("CTXL"): the whole point of the mark is to tell the two domains' files
 * apart, and a shared value would let one open the other's.
 */
export const REGISTRY_DATABASE_APPLICATION_ID = 0x43545852;

export type RegistryDatabaseIdentityErrorCode =
  | "identity_mismatch"
  | "foreign_schema";

/**
 * The file at the configured location belongs to something else.
 *
 * Refused before any write, because the alternative is worse than an error:
 * `CREATE TABLE IF NOT EXISTS` would quietly add Registry's tables into another
 * domain's file, and from then on two domains' states and transactions share
 * one database — the separation the whole architecture is built on, gone
 * without a message.
 */
export class RegistryDatabaseIdentityError extends Error {
  constructor(readonly code: RegistryDatabaseIdentityErrorCode) {
    super(`Registry database identity is incompatible: ${code}`);
    this.name = "RegistryDatabaseIdentityError";
  }
}

/**
 * Opens the Registry database and brings its schema up to date.
 *
 * The schema lives here rather than in a shared location: SQL dialects differ,
 * so another adapter must be free to define its own without negotiating with
 * this one. Scope collections are stored as JSON documents because Registry
 * never filters inside them in SQL — it reads whole read models back out.
 *
 * Ownership is checked before the first write and claimed after the schema is
 * in place, the same protocol `openIngestionDatabase` uses on its side.
 */
export function openRegistryDatabase(location: string): DatabaseSync {
  const database = new DatabaseSync(location);
  try {
    database.exec("PRAGMA foreign_keys = ON");
    assertDatabaseClaimable(database);
    migrate(database);
    claimDatabaseApplicationId(database);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

/**
 * Whether this file is Registry's to write into.
 *
 * Three cases. A file already marked with Registry's id is ours. A file marked
 * with any other id belongs to another application and is refused untouched. A
 * file with no mark (`0`) predates the mark — it is claimable only if it is
 * empty or already shaped like a Registry database (`cards` is the table every
 * Registry schema version has had). An unmarked file holding anything else is
 * some other database from before marks existed — an old ingestion.db, most
 * likely — and gets the same refusal.
 */
function assertDatabaseClaimable(database: DatabaseSync): void {
  const applicationId = readApplicationId(database);
  if (applicationId === REGISTRY_DATABASE_APPLICATION_ID) {
    return;
  }
  if (applicationId !== 0) {
    throw new RegistryDatabaseIdentityError("identity_mismatch");
  }

  const objects = database
    .prepare(
      "SELECT 1 AS present FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' LIMIT 1",
    )
    .get();
  if (objects === undefined) {
    return;
  }
  const cards = database
    .prepare(
      "SELECT 1 AS present FROM sqlite_schema WHERE type = 'table' AND name = 'cards'",
    )
    .get();
  if (cards === undefined) {
    throw new RegistryDatabaseIdentityError("foreign_schema");
  }
}

function claimDatabaseApplicationId(database: DatabaseSync): void {
  if (readApplicationId(database) === 0) {
    database.exec(
      `PRAGMA application_id = ${String(REGISTRY_DATABASE_APPLICATION_ID)}`,
    );
  }
  if (readApplicationId(database) !== REGISTRY_DATABASE_APPLICATION_ID) {
    throw new RegistryDatabaseIdentityError("identity_mismatch");
  }
}

function readApplicationId(database: DatabaseSync): number {
  const row = database.prepare("PRAGMA application_id").get() as
    | { readonly application_id?: unknown }
    | undefined;
  if (!Number.isSafeInteger(row?.application_id)) {
    throw new RegistryDatabaseIdentityError("identity_mismatch");
  }
  return row!.application_id as number;
}

function migrate(database: DatabaseSync): void {
  ensureGroundingColumns(database);
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
      append_order INTEGER NOT NULL,
      meaning TEXT,
      grounding TEXT,
      change_from_previous TEXT
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

/**
 * Adds the grounding-v1 columns to a `card_versions` table written before
 * they existed.
 *
 * `CREATE TABLE IF NOT EXISTS` only shapes a new database; a registry.db from
 * an earlier release keeps its old column set and every write would fail. The
 * columns are nullable on purpose — old versions genuinely have no recorded
 * meaning or grounding, and NULL is that fact, not a default to invent.
 */
function ensureGroundingColumns(database: DatabaseSync): void {
  const table = database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'card_versions'")
    .get();
  if (table === undefined) {
    return;
  }
  const columns = new Set(
    (database.prepare("PRAGMA table_info(card_versions)").all() as { name: string }[]).map(
      (row) => row.name,
    ),
  );
  for (const column of ["meaning", "grounding", "change_from_previous"]) {
    if (!columns.has(column)) {
      database.exec(`ALTER TABLE card_versions ADD COLUMN ${column} TEXT`);
    }
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
