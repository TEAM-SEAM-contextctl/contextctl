import { DatabaseSync } from "node:sqlite";

export const INGESTION_DATABASE_SCHEMA_VERSION = 3;

export interface OpenIngestionDatabaseOptions {
  readonly location: string;
  readonly stateNamespaceId: string;
  readonly securityDomain: string;
}

export type IngestionDatabaseSchemaErrorCode =
  | "identity_mismatch"
  | "schema_invalid"
  | "schema_newer";

export class IngestionDatabaseSchemaError extends Error {
  constructor(readonly code: IngestionDatabaseSchemaErrorCode) {
    super(`Ingestion database schema is incompatible: ${code}`);
    this.name = "IngestionDatabaseSchemaError";
  }
}

/** Opens the Ingestion control-plane database and validates its schema. */
export function openIngestionDatabase(
  options: OpenIngestionDatabaseOptions,
): DatabaseSync {
  const { location, stateNamespaceId, securityDomain } = options;
  if (location.trim() === "") {
    throw new TypeError("Ingestion database location is invalid");
  }
  const database = new DatabaseSync(location);
  try {
    database.exec("PRAGMA foreign_keys = ON");
    database.exec("PRAGMA busy_timeout = 5000");
    if (location !== ":memory:") {
      database.exec("PRAGMA journal_mode = WAL");
      database.exec("PRAGMA synchronous = NORMAL");
    }
    if (stateNamespaceId.trim() === "" || securityDomain.trim() === "") {
      throw new TypeError("Ingestion database identity is invalid");
    }
    migrate(database, stateNamespaceId, securityDomain);
    assertHealthy(database);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

function migrate(
  database: DatabaseSync,
  stateNamespaceId: string,
  securityDomain: string,
): void {
  const version = readSchemaVersion(database);
  if (version > INGESTION_DATABASE_SCHEMA_VERSION) {
    throw new IngestionDatabaseSchemaError("schema_newer");
  }
  if (version === INGESTION_DATABASE_SCHEMA_VERSION) {
    assertExpectedSchema(database);
    assertDatabaseIdentity(database, stateNamespaceId, securityDomain);
    return;
  }
  if (version === 2) {
    assertExpectedSchema(database, EXPECTED_SCHEMA_V2);
    assertDatabaseIdentity(database, stateNamespaceId, securityDomain);
    inIngestionTransaction(database, () => {
      createSchemaV3(database);
      assertExpectedSchema(database);
      database.exec(
        `PRAGMA user_version = ${String(INGESTION_DATABASE_SCHEMA_VERSION)}`,
      );
    });
    return;
  }
  inIngestionTransaction(database, () => {
    createSchemaV1(database);
    if (version === 1 && hasLegacyState(database)) {
      throw new IngestionDatabaseSchemaError("schema_invalid");
    }
    createSchemaV2(database);
    createSchemaV3(database);
    database
      .prepare(
        `INSERT INTO ingestion_metadata (
           singleton, state_namespace_id, security_domain
         ) VALUES (1, ?, ?)`,
      )
      .run(stateNamespaceId, securityDomain);
    assertExpectedSchema(database);
    database.exec(
      `PRAGMA user_version = ${String(INGESTION_DATABASE_SCHEMA_VERSION)}`,
    );
  });
}

function createSchemaV3(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS index_staging_attempts (
      document_index_id TEXT NOT NULL,
      index_version TEXT NOT NULL,
      connector_id TEXT NOT NULL,
      access_handle TEXT NOT NULL,
      first_attempted_at TEXT NOT NULL,
      last_attempted_at TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('pending', 'publishing', 'cleaning')),
      owner_lease_id TEXT,
      owner_expires_at TEXT,
      PRIMARY KEY (document_index_id, index_version),
      CHECK (
        (state = 'pending' AND owner_lease_id IS NULL AND owner_expires_at IS NULL)
        OR
        (state <> 'pending' AND owner_lease_id IS NOT NULL AND owner_expires_at IS NOT NULL)
      )
    );

    CREATE INDEX IF NOT EXISTS index_staging_attempts_by_eligibility
      ON index_staging_attempts (last_attempted_at, state, owner_expires_at);
  `);
}

function createSchemaV2(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS ingestion_metadata (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      state_namespace_id TEXT NOT NULL,
      security_domain TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS published_scope_catalog (
      scope_id TEXT NOT NULL,
      scope_version TEXT NOT NULL,
      document_index_id TEXT NOT NULL,
      index_version TEXT NOT NULL,
      scope_json TEXT NOT NULL,
      publication_fingerprint TEXT NOT NULL,
      PRIMARY KEY (scope_id, scope_version),
      FOREIGN KEY (document_index_id, index_version)
        REFERENCES index_versions (document_index_id, index_version)
    );

    CREATE TABLE IF NOT EXISTS publication_scope_definitions (
      scope_id TEXT NOT NULL,
      scope_version TEXT NOT NULL,
      scope_json TEXT NOT NULL,
      PRIMARY KEY (scope_id, scope_version)
    );
  `);
}

function hasLegacyState(database: DatabaseSync): boolean {
  for (const table of [
    "index_versions",
    "ingestion_publications",
    "markdown_publication_checkpoints",
  ]) {
    const row = database.prepare(`SELECT 1 AS present FROM ${table} LIMIT 1`).get();
    if (row !== undefined) return true;
  }
  return false;
}

function assertDatabaseIdentity(
  database: DatabaseSync,
  stateNamespaceId: string,
  securityDomain: string,
): void {
  const row = database
    .prepare(
      "SELECT state_namespace_id, security_domain FROM ingestion_metadata WHERE singleton = 1",
    )
    .get() as
    | { readonly state_namespace_id?: unknown; readonly security_domain?: unknown }
    | undefined;
  if (
    row?.state_namespace_id !== stateNamespaceId ||
    row.security_domain !== securityDomain
  ) {
    throw new IngestionDatabaseSchemaError("identity_mismatch");
  }
}

function createSchemaV1(database: DatabaseSync): void {
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

function readSchemaVersion(database: DatabaseSync): number {
  const row = database.prepare("PRAGMA user_version").get() as
    | { readonly user_version?: unknown }
    | undefined;
  if (!Number.isSafeInteger(row?.user_version) || (row!.user_version as number) < 0) {
    throw new IngestionDatabaseSchemaError("schema_invalid");
  }
  return row!.user_version as number;
}

const EXPECTED_SCHEMA_V2 = {
  ingestion_metadata: [
    ["singleton", "INTEGER", 0, 1],
    ["state_namespace_id", "TEXT", 1, 0],
    ["security_domain", "TEXT", 1, 0],
  ],
  index_versions: [
    ["document_index_id", "TEXT", 1, 1],
    ["index_version", "TEXT", 1, 2],
    ["payload_schema_version", "INTEGER", 1, 0],
    ["publication_json", "TEXT", 1, 0],
    ["fingerprint", "TEXT", 1, 0],
    ["published_at", "TEXT", 1, 0],
  ],
  current_index_versions: [
    ["document_index_id", "TEXT", 0, 1],
    ["index_version", "TEXT", 1, 0],
  ],
  ingestion_publications: [
    ["publication_id", "TEXT", 0, 1],
    ["source_id", "TEXT", 1, 0],
    ["previous_publication_id", "TEXT", 0, 0],
    ["publication_json", "TEXT", 1, 0],
    ["produced_at", "TEXT", 1, 0],
    ["ready_notified", "INTEGER", 1, 0],
  ],
  latest_ingestion_publications: [
    ["source_id", "TEXT", 0, 1],
    ["publication_id", "TEXT", 1, 0],
  ],
  markdown_publication_checkpoints: [
    ["source_id", "TEXT", 0, 1],
    ["target_key", "TEXT", 1, 0],
    ["source_type", "TEXT", 1, 0],
    ["document_id", "TEXT", 1, 0],
    ["checkpoint_json", "TEXT", 1, 0],
  ],
  published_scope_catalog: [
    ["scope_id", "TEXT", 1, 1],
    ["scope_version", "TEXT", 1, 2],
    ["document_index_id", "TEXT", 1, 0],
    ["index_version", "TEXT", 1, 0],
    ["scope_json", "TEXT", 1, 0],
    ["publication_fingerprint", "TEXT", 1, 0],
  ],
  publication_scope_definitions: [
    ["scope_id", "TEXT", 1, 1],
    ["scope_version", "TEXT", 1, 2],
    ["scope_json", "TEXT", 1, 0],
  ],
} as const;

const EXPECTED_SCHEMA = {
  ...EXPECTED_SCHEMA_V2,
  index_staging_attempts: [
    ["document_index_id", "TEXT", 1, 1],
    ["index_version", "TEXT", 1, 2],
    ["connector_id", "TEXT", 1, 0],
    ["access_handle", "TEXT", 1, 0],
    ["first_attempted_at", "TEXT", 1, 0],
    ["last_attempted_at", "TEXT", 1, 0],
    ["state", "TEXT", 1, 0],
    ["owner_lease_id", "TEXT", 0, 0],
    ["owner_expires_at", "TEXT", 0, 0],
  ],
} as const;

function assertExpectedSchema(
  database: DatabaseSync,
  schema: Readonly<Record<string, readonly (readonly unknown[])[]>> =
    EXPECTED_SCHEMA,
): void {
  for (const [table, expected] of Object.entries(schema)) {
    const rows = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{
      readonly name?: unknown;
      readonly type?: unknown;
      readonly notnull?: unknown;
      readonly pk?: unknown;
    }>;
    const actual = rows.map((row) => [
      row.name,
      typeof row.type === "string" ? row.type.toUpperCase() : row.type,
      row.notnull,
      row.pk,
    ]);
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new IngestionDatabaseSchemaError("schema_invalid");
    }
  }
}

function assertHealthy(database: DatabaseSync): void {
  const quickCheck = database.prepare("PRAGMA quick_check").all() as Array<
    Readonly<Record<string, unknown>>
  >;
  if (
    quickCheck.length !== 1 ||
    Object.values(quickCheck[0] ?? {})[0] !== "ok" ||
    database.prepare("PRAGMA foreign_key_check").all().length !== 0
  ) {
    throw new IngestionDatabaseSchemaError("schema_invalid");
  }
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
