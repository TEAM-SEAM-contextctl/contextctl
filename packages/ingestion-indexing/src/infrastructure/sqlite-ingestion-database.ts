import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

import { isUuidV7Id } from "../domain/model-validation.js";

export const INGESTION_DATABASE_SCHEMA_VERSION = 8;
export const INGESTION_DATABASE_APPLICATION_ID = 0x4354584c;

export interface OpenIngestionDatabaseOptions {
  readonly location: string;
  readonly stateNamespaceId: string;
  readonly securityDomain: string;
}

export type IngestionDatabaseSchemaErrorCode =
  | "identity_mismatch"
  | "identity_format_unsupported"
  | "schema_invalid"
  | "schema_newer";

export type IngestionDatabaseInspectionProblem =
  | IngestionDatabaseSchemaErrorCode
  | "schema_older";

export type IngestionDatabaseInspection =
  | { readonly status: "missing" }
  | {
      readonly status: "compatible";
      readonly schemaVersion: typeof INGESTION_DATABASE_SCHEMA_VERSION;
    }
  | {
      readonly status: "incompatible";
      readonly code: IngestionDatabaseInspectionProblem;
    }
  | { readonly status: "unreadable"; readonly detail: string };

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
  validateIngestionDatabaseOptions(options);
  const database = new DatabaseSync(location);
  try {
    database.exec("PRAGMA foreign_keys = ON");
    database.exec("PRAGMA busy_timeout = 5000");
    assertDatabaseClaimable(database);
    if (location !== ":memory:") {
      configureDurability(database);
    }
    migrate(database, stateNamespaceId, securityDomain);
    claimDatabaseApplicationId(database);
    assertHealthy(database);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

/**
 * Inspects an existing Ingestion database without claiming or migrating it.
 *
 * `openIngestionDatabase` is intentionally mutating: it owns schema migration,
 * identity stamping and WAL durability. Health checks need the opposite
 * contract, so this path opens SQLite read-only and accepts only the exact
 * schema this build already understands.
 */
export function inspectIngestionDatabase(
  options: OpenIngestionDatabaseOptions,
): IngestionDatabaseInspection {
  const { location, stateNamespaceId, securityDomain } = options;
  validateIngestionDatabaseOptions(options);
  if (location === ":memory:" || !existsSync(location)) {
    return { status: "missing" };
  }

  let database: DatabaseSync | undefined;
  try {
    database = openInspectionDatabase(location);
    const applicationId = readApplicationId(database);
    if (applicationId !== INGESTION_DATABASE_APPLICATION_ID) {
      throw new IngestionDatabaseSchemaError(
        applicationId === 0 ? "schema_invalid" : "identity_mismatch",
      );
    }
    const schemaVersion = readSchemaVersion(database);
    if (schemaVersion > INGESTION_DATABASE_SCHEMA_VERSION) {
      throw new IngestionDatabaseSchemaError("schema_newer");
    }
    if (schemaVersion < INGESTION_DATABASE_SCHEMA_VERSION) {
      return { status: "incompatible", code: "schema_older" };
    }
    assertExpectedSchema(database);
    assertDatabaseIdentity(database, stateNamespaceId, securityDomain);
    assertPersistedIdentityFormat(database);
    assertHealthy(database);
    return {
      status: "compatible",
      schemaVersion: INGESTION_DATABASE_SCHEMA_VERSION,
    };
  } catch (error) {
    if (error instanceof IngestionDatabaseSchemaError) {
      return { status: "incompatible", code: error.code };
    }
    return {
      status: "unreadable",
      detail: error instanceof Error ? error.message : String(error),
    };
  } finally {
    database?.close();
  }
}

function openInspectionDatabase(location: string): DatabaseSync {
  if (existsSync(`${location}-wal`) && existsSync(`${location}-shm`)) {
    // A live writer has already created the WAL coordination files. Reusing
    // them lets inspection see committed WAL frames without introducing a new
    // filesystem entry. The connection itself is still SQLite read-only.
    return new DatabaseSync(location, { readOnly: true });
  }
  const url = pathToFileURL(location);
  // A plain read-only WAL connection may create `-wal` and `-shm` sidecars in
  // an otherwise clean directory. `immutable=1` observes the checkpointed
  // database file without changing the source. Schema and state identity are
  // stable metadata and do not depend on application rows still in a live WAL.
  url.searchParams.set("immutable", "1");
  return new DatabaseSync(url, { readOnly: true });
}

function validateIngestionDatabaseOptions(
  options: OpenIngestionDatabaseOptions,
): void {
  if (options.location.trim() === "") {
    throw new TypeError("Ingestion database location is invalid");
  }
  if (
    options.stateNamespaceId.trim() === "" ||
    options.securityDomain.trim() === ""
  ) {
    throw new TypeError("Ingestion database identity is invalid");
  }
}

function assertDatabaseClaimable(database: DatabaseSync): void {
  const applicationId = readApplicationId(database);
  if (
    applicationId !== 0 &&
    applicationId !== INGESTION_DATABASE_APPLICATION_ID
  ) {
    throw new IngestionDatabaseSchemaError("identity_mismatch");
  }
  if (readSchemaVersion(database) !== 0) return;
  const object = database
    .prepare(
      `SELECT 1 AS present
         FROM sqlite_schema
        WHERE name NOT LIKE 'sqlite_%'
        LIMIT 1`,
    )
    .get();
  if (object !== undefined) {
    throw new IngestionDatabaseSchemaError("schema_invalid");
  }
}

function configureDurability(database: DatabaseSync): void {
  database.exec("PRAGMA journal_mode = WAL");
  database.exec("PRAGMA synchronous = FULL");
  const journal = database.prepare("PRAGMA journal_mode").get() as
    | { readonly journal_mode?: unknown }
    | undefined;
  const synchronous = database.prepare("PRAGMA synchronous").get() as
    | { readonly synchronous?: unknown }
    | undefined;
  if (
    typeof journal?.journal_mode !== "string" ||
    journal.journal_mode.toLowerCase() !== "wal" ||
    synchronous?.synchronous !== 2
  ) {
    throw new IngestionDatabaseSchemaError("schema_invalid");
  }
}

function claimDatabaseApplicationId(database: DatabaseSync): void {
  const applicationId = readApplicationId(database);
  if (applicationId === 0) {
    database.exec(
      `PRAGMA application_id = ${String(INGESTION_DATABASE_APPLICATION_ID)}`,
    );
  }
  if (readApplicationId(database) !== INGESTION_DATABASE_APPLICATION_ID) {
    throw new IngestionDatabaseSchemaError("identity_mismatch");
  }
}

function readApplicationId(database: DatabaseSync): number {
  const row = database.prepare("PRAGMA application_id").get() as
    | { readonly application_id?: unknown }
    | undefined;
  if (!Number.isSafeInteger(row?.application_id)) {
    throw new IngestionDatabaseSchemaError("schema_invalid");
  }
  return row!.application_id as number;
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
    assertPersistedIdentityFormat(database);
    return;
  }
  if (version === 7) {
    assertExpectedSchema(database);
    assertDatabaseIdentity(database, stateNamespaceId, securityDomain);
    inIngestionTransaction(database, () => {
      finalizeUuidV7IdentityMigration(database);
    });
    return;
  }
  if (version === 6) {
    assertExpectedSchema(database);
    assertDatabaseIdentity(database, stateNamespaceId, securityDomain);
    inIngestionTransaction(database, () => {
      finalizeUuidV7IdentityMigration(database);
    });
    return;
  }
  if (version === 5) {
    assertExpectedSchema(database, EXPECTED_SCHEMA_V5);
    assertDatabaseIdentity(database, stateNamespaceId, securityDomain);
    inIngestionTransaction(database, () => {
      createSchemaV6(database);
      assertExpectedSchema(database);
      finalizeUuidV7IdentityMigration(database);
    });
    return;
  }
  if (version === 4) {
    assertExpectedSchema(database, EXPECTED_SCHEMA_V4);
    assertDatabaseIdentity(database, stateNamespaceId, securityDomain);
    inIngestionTransaction(database, () => {
      createSchemaV5(database);
      createSchemaV6(database);
      assertExpectedSchema(database);
      finalizeUuidV7IdentityMigration(database);
    });
    return;
  }
  if (version === 3) {
    assertExpectedSchema(database, EXPECTED_SCHEMA_V3);
    assertDatabaseIdentity(database, stateNamespaceId, securityDomain);
    inIngestionTransaction(database, () => {
      createSchemaV4(database);
      createSchemaV5(database);
      createSchemaV6(database);
      assertExpectedSchema(database);
      finalizeUuidV7IdentityMigration(database);
    });
    return;
  }
  if (version === 2) {
    assertExpectedSchema(database, EXPECTED_SCHEMA_V2);
    assertDatabaseIdentity(database, stateNamespaceId, securityDomain);
    inIngestionTransaction(database, () => {
      createSchemaV3(database);
      createSchemaV4(database);
      createSchemaV5(database);
      createSchemaV6(database);
      assertExpectedSchema(database);
      finalizeUuidV7IdentityMigration(database);
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
    createSchemaV4(database);
    createSchemaV5(database);
    createSchemaV6(database);
    database
      .prepare(
        `INSERT INTO ingestion_metadata (
           singleton, state_namespace_id, security_domain
         ) VALUES (1, ?, ?)`,
      )
      .run(stateNamespaceId, securityDomain);
    assertExpectedSchema(database);
    finalizeUuidV7IdentityMigration(database);
  });
}

function finalizeUuidV7IdentityMigration(database: DatabaseSync): void {
  assertPersistedIdentityFormat(database);
  database.exec(
    `PRAGMA user_version = ${String(INGESTION_DATABASE_SCHEMA_VERSION)}`,
  );
}

function assertPersistedIdentityFormat(database: DatabaseSync): void {
  const checks = [
    ["markdown_publication_checkpoints", "source_id", "src"],
    ["markdown_publication_checkpoints", "document_id", "doc"],
    ["source_observations", "observation_id", "obs"],
    ["source_observations", "source_id", "src"],
    ["publication_recovery_intents", "publication_id", "pub"],
    ["publication_recovery_intents", "source_id", "src"],
    ["publication_recovery_intents", "observation_id", "obs"],
    ["publication_recovery_intents", "previous_publication_id", "pub"],
    ["ingestion_publications", "publication_id", "pub"],
    ["ingestion_publications", "source_id", "src"],
    ["ingestion_publications", "previous_publication_id", "pub"],
  ] as const;
  for (const [table, column, prefix] of checks) {
    const rows = database
      .prepare(`SELECT ${column} AS value FROM ${table} WHERE ${column} IS NOT NULL`)
      .all() as Array<{ readonly value?: unknown }>;
    if (
      rows.some(
        ({ value }) =>
          typeof value !== "string" || !isUuidV7Id(value, prefix),
      )
    ) {
      throw new IngestionDatabaseSchemaError("identity_format_unsupported");
    }
  }
  for (const [table, column] of [
    ["index_versions", "publication_json"],
    ["markdown_publication_checkpoints", "checkpoint_json"],
    ["source_observations", "observation_json"],
    ["publication_recovery_intents", "publication_json"],
    ["ingestion_publications", "publication_json"],
  ] as const) {
    const rows = database.prepare(`SELECT ${column} AS value FROM ${table}`).all() as Array<{
      readonly value?: unknown;
    }>;
    for (const { value } of rows) {
      if (typeof value !== "string") {
        throw new IngestionDatabaseSchemaError("schema_invalid");
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(value) as unknown;
      } catch {
        throw new IngestionDatabaseSchemaError("schema_invalid");
      }
      assertIdentityFields(parsed);
    }
  }
}

function assertIdentityFields(value: unknown, container?: string): void {
  if (Array.isArray(value)) {
    for (const item of value) assertIdentityFields(item, container);
    return;
  }
  if (value === null || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  const containerPrefix = CONTAINER_ID_PREFIXES[container ?? ""];
  if (
    containerPrefix !== undefined &&
    (typeof record.id !== "string" ||
      !isUuidV7Id(record.id, containerPrefix))
  ) {
    throw new IngestionDatabaseSchemaError("identity_format_unsupported");
  }
  if (
    container === "knowledgeUnits" &&
    isRecord(record.sourceCoordinate) &&
    record.sourceCoordinate.kind === "document" &&
    (typeof record.id !== "string" || !isUuidV7Id(record.id, "unit"))
  ) {
    throw new IngestionDatabaseSchemaError("identity_format_unsupported");
  }
  for (const [key, item] of Object.entries(value)) {
    // Source payloads and published Fact values are external knowledge, not
    // control-plane identity fields even when they contain the same key names.
    if (key === "payload" || key === "facts") continue;
    const prefix = IDENTITY_FIELDS[key];
    if (
      prefix !== undefined &&
      (typeof item !== "string" || !isUuidV7Id(item, prefix))
    ) {
      throw new IngestionDatabaseSchemaError("identity_format_unsupported");
    }
    const listPrefix = IDENTITY_LIST_FIELDS[key];
    if (
      listPrefix !== undefined &&
      (!Array.isArray(item) ||
        item.some(
          (candidate) =>
            typeof candidate !== "string" ||
            !isUuidV7Id(candidate, listPrefix),
        ))
    ) {
      throw new IngestionDatabaseSchemaError("identity_format_unsupported");
    }
    const recordKeyPrefix = IDENTITY_RECORD_KEY_FIELDS[key];
    if (
      recordKeyPrefix !== undefined &&
      (!isRecord(item) ||
        Object.keys(item).some(
          (candidate) => !isUuidV7Id(candidate, recordKeyPrefix),
        ))
    ) {
      throw new IngestionDatabaseSchemaError("identity_format_unsupported");
    }
    assertIdentityFields(item, key);
  }
}

const IDENTITY_FIELDS: Readonly<Record<string, string>> = {
  blockId: "blk",
  chunkId: "chk",
  documentId: "doc",
  nextChunkId: "chk",
  observationId: "obs",
  previousChunkId: "chk",
  previousPublicationId: "pub",
  publicationId: "pub",
  semanticUnitId: "unit",
  sourceId: "src",
};

const IDENTITY_LIST_FIELDS: Readonly<Record<string, string>> = {
  blockIds: "blk",
  childIds: "unit",
  sectionPath: "blk",
  semanticUnitIds: "unit",
};

const IDENTITY_RECORD_KEY_FIELDS: Readonly<Record<string, string>> = {
  chunkBindings: "chk",
  chunkRevisions: "chk",
  semanticUnitRevisions: "unit",
};

const CONTAINER_ID_PREFIXES: Readonly<Record<string, string>> = {
  blocks: "blk",
  chunks: "chk",
  semanticUnits: "unit",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function createSchemaV6(database: DatabaseSync): void {
  database.exec(`
    ALTER TABLE latest_ingestion_publications
      RENAME TO latest_ingestion_publications_v5;
    ALTER TABLE ingestion_publications
      RENAME TO ingestion_publications_v5;
    DROP INDEX ingestion_publications_by_source;

    CREATE TABLE ingestion_publications (
      publication_id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL,
      previous_publication_id TEXT,
      publication_json TEXT NOT NULL,
      produced_at TEXT NOT NULL,
      ready_state TEXT NOT NULL CHECK (
        ready_state IN ('pending', 'delivering', 'delivered')
      ),
      ready_owner_id TEXT,
      ready_owner_expires_at TEXT,
      ready_attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (
        ready_attempt_count >= 0
      ),
      ready_next_attempt_at TEXT NOT NULL,
      ready_last_diagnostic_code TEXT,
      ready_delivered_at TEXT,
      CHECK (
        (ready_state = 'pending'
          AND ready_owner_id IS NULL
          AND ready_owner_expires_at IS NULL
          AND ready_delivered_at IS NULL)
        OR
        (ready_state = 'delivering'
          AND ready_owner_id IS NOT NULL
          AND ready_owner_expires_at IS NOT NULL
          AND ready_delivered_at IS NULL)
        OR
        (ready_state = 'delivered'
          AND ready_owner_id IS NULL
          AND ready_owner_expires_at IS NULL
          AND ready_delivered_at IS NOT NULL)
      )
    );

    CREATE INDEX ingestion_publications_by_source
      ON ingestion_publications (source_id, produced_at, publication_id);

    CREATE INDEX publication_ready_by_eligibility
      ON ingestion_publications (
        ready_state, ready_next_attempt_at, ready_owner_expires_at,
        produced_at, publication_id
      );

    INSERT INTO ingestion_publications (
      publication_id, source_id, previous_publication_id,
      publication_json, produced_at, ready_state,
      ready_owner_id, ready_owner_expires_at, ready_attempt_count,
      ready_next_attempt_at, ready_last_diagnostic_code, ready_delivered_at
    )
    SELECT publication_id, source_id, previous_publication_id,
           publication_json, produced_at,
           CASE ready_notified WHEN 1 THEN 'delivered' ELSE 'pending' END,
           NULL, NULL, 0, produced_at, NULL,
           CASE ready_notified WHEN 1 THEN produced_at ELSE NULL END
      FROM ingestion_publications_v5;

    CREATE TABLE latest_ingestion_publications (
      source_id TEXT PRIMARY KEY,
      publication_id TEXT NOT NULL
        REFERENCES ingestion_publications (publication_id)
    );

    INSERT INTO latest_ingestion_publications (source_id, publication_id)
      SELECT source_id, publication_id
        FROM latest_ingestion_publications_v5;

    DROP TABLE latest_ingestion_publications_v5;
    DROP TABLE ingestion_publications_v5;
  `);
}

function createSchemaV5(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS publication_recovery_intents (
      publication_id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL,
      observation_id TEXT NOT NULL,
      previous_publication_id TEXT,
      publication_json TEXT NOT NULL,
      produced_at TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      committed INTEGER NOT NULL DEFAULT 0 CHECK (committed IN (0, 1))
    );

    CREATE UNIQUE INDEX IF NOT EXISTS pending_publication_intent_by_source
      ON publication_recovery_intents (source_id)
      WHERE committed = 0;

    CREATE INDEX IF NOT EXISTS publication_intents_by_source
      ON publication_recovery_intents (source_id, produced_at, publication_id);
  `);
}

function createSchemaV4(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS source_observations (
      observation_id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL,
      content_digest TEXT NOT NULL,
      captured_at TEXT NOT NULL,
      observation_json TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      UNIQUE (source_id, content_digest)
    );

    CREATE INDEX IF NOT EXISTS source_observations_by_source_capture
      ON source_observations (source_id, captured_at DESC, observation_id DESC);

    CREATE TABLE IF NOT EXISTS latest_source_observations (
      source_id TEXT PRIMARY KEY,
      observation_id TEXT NOT NULL UNIQUE
        REFERENCES source_observations (observation_id)
    );

    CREATE TABLE IF NOT EXISTS comparison_source_observations (
      source_id TEXT PRIMARY KEY,
      observation_id TEXT NOT NULL UNIQUE
        REFERENCES source_observations (observation_id)
    );

    CREATE TABLE IF NOT EXISTS source_observation_retention_leases (
      lease_id TEXT NOT NULL,
      observation_id TEXT NOT NULL
        REFERENCES source_observations (observation_id) ON DELETE CASCADE,
      acquired_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      PRIMARY KEY (lease_id, observation_id)
    );

    CREATE INDEX IF NOT EXISTS source_observation_leases_by_protection
      ON source_observation_retention_leases (observation_id, expires_at);
  `);
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

const EXPECTED_SCHEMA_V3 = {
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

const EXPECTED_SCHEMA_V4 = {
  ...EXPECTED_SCHEMA_V3,
  source_observations: [
    ["observation_id", "TEXT", 0, 1],
    ["source_id", "TEXT", 1, 0],
    ["content_digest", "TEXT", 1, 0],
    ["captured_at", "TEXT", 1, 0],
    ["observation_json", "TEXT", 1, 0],
    ["fingerprint", "TEXT", 1, 0],
  ],
  latest_source_observations: [
    ["source_id", "TEXT", 0, 1],
    ["observation_id", "TEXT", 1, 0],
  ],
  comparison_source_observations: [
    ["source_id", "TEXT", 0, 1],
    ["observation_id", "TEXT", 1, 0],
  ],
  source_observation_retention_leases: [
    ["lease_id", "TEXT", 1, 1],
    ["observation_id", "TEXT", 1, 2],
    ["acquired_at", "TEXT", 1, 0],
    ["expires_at", "TEXT", 1, 0],
  ],
} as const;

const EXPECTED_SCHEMA_V5 = {
  ...EXPECTED_SCHEMA_V4,
  publication_recovery_intents: [
    ["publication_id", "TEXT", 0, 1],
    ["source_id", "TEXT", 1, 0],
    ["observation_id", "TEXT", 1, 0],
    ["previous_publication_id", "TEXT", 0, 0],
    ["publication_json", "TEXT", 1, 0],
    ["produced_at", "TEXT", 1, 0],
    ["fingerprint", "TEXT", 1, 0],
    ["committed", "INTEGER", 1, 0],
  ],
} as const;

const EXPECTED_SCHEMA = {
  ...EXPECTED_SCHEMA_V5,
  ingestion_publications: [
    ["publication_id", "TEXT", 0, 1],
    ["source_id", "TEXT", 1, 0],
    ["previous_publication_id", "TEXT", 0, 0],
    ["publication_json", "TEXT", 1, 0],
    ["produced_at", "TEXT", 1, 0],
    ["ready_state", "TEXT", 1, 0],
    ["ready_owner_id", "TEXT", 0, 0],
    ["ready_owner_expires_at", "TEXT", 0, 0],
    ["ready_attempt_count", "INTEGER", 1, 0],
    ["ready_next_attempt_at", "TEXT", 1, 0],
    ["ready_last_diagnostic_code", "TEXT", 0, 0],
    ["ready_delivered_at", "TEXT", 0, 0],
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
