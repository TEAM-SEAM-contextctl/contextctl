import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

/**
 * The owner mark Registry stamps into its database file's header.
 *
 * "CTXR" as bytes. Deliberately different from Ingestion's `0x4354584C`
 * ("CTXL"): the whole point of the mark is to tell the two domains' files
 * apart, and a shared value would let one open the other's.
 */
export const REGISTRY_DATABASE_APPLICATION_ID = 0x43545852;

/**
 * The schema shape this build writes and understands, in `PRAGMA user_version`.
 *
 * `1` because that is what this file has always produced — the grounding
 * columns are added to the same shape rather than versioned separately. Its
 * job is not to describe history but to let a build refuse a file a *newer*
 * build wrote: without it, an older daemon opens a future registry.db, sees
 * tables it recognises, and reads rows whose meaning has moved.
 */
export const REGISTRY_DATABASE_SCHEMA_VERSION = 1;

export type RegistryDatabaseIdentityErrorCode =
  | "identity_mismatch"
  | "unidentified_schema"
  | "schema_invalid"
  | "schema_newer";

export interface OpenRegistryDatabaseOptions {
  readonly location: string;
  /**
   * Which deployment's state this file holds. The same pair
   * `openIngestionDatabase` requires: `application_id` says which domain a
   * file belongs to, these say which installation — a registry.db written
   * under one security domain must not be served under another.
   */
  readonly stateNamespaceId: string;
  readonly securityDomain: string;
}

export type RegistryDatabaseInspectionProblem =
  | RegistryDatabaseIdentityErrorCode
  | "schema_older";

export type RegistryDatabaseInspection =
  | { readonly status: "missing" }
  | {
      readonly status: "compatible";
      readonly schemaVersion: typeof REGISTRY_DATABASE_SCHEMA_VERSION;
    }
  | {
      readonly status: "incompatible";
      readonly code: RegistryDatabaseInspectionProblem;
    }
  | { readonly status: "unreadable"; readonly detail: string };

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
export function openRegistryDatabase(
  options: OpenRegistryDatabaseOptions,
): DatabaseSync {
  const { location, stateNamespaceId, securityDomain } = options;
  validateRegistryDatabaseOptions(options);
  const database = new DatabaseSync(location);
  try {
    database.exec("PRAGMA foreign_keys = ON");
    // The CLI and a running daemon both open this file. Without a wait, the
    // second one fails instantly with SQLITE_BUSY on a lock the first holds
    // for milliseconds.
    database.exec("PRAGMA busy_timeout = 5000");
    // Every refusal happens before migrate touches the file: another
    // installation's data, data of unprovable origin, or a shape a newer build
    // wrote must not have this build's columns added to it.
    const state = assertDatabaseClaimable(database);
    // Version first, then identity. A file a newer build wrote may have moved
    // `registry_metadata` itself, so reading the identity out of it before
    // knowing the shape is trusted would report a mismatch for a file whose
    // real problem is that this build cannot read it at all.
    assertSchemaNotNewer(database);
    if (state === "registry") {
      assertRecordedIdentity(database, stateNamespaceId, securityDomain);
    }
    if (location !== ":memory:") {
      configureDurability(database);
    }
    // One transaction, so a first open either finishes or leaves the file as
    // it was. Half of it — tables without the mark — would now be refused for
    // good as unidentified, and the operator's only recourse would be to
    // delete a file they never got to use. The shape check is inside for the
    // same reason: a file that fails it must not keep the columns this open
    // added on the way to finding out.
    inTransaction(database, () => {
      migrate(database);
      if (state === "empty") {
        recordIdentity(database, stateNamespaceId, securityDomain);
      }
      claimSchemaVersion(database);
      claimDatabaseApplicationId(database);
      assertExpectedSchema(database);
    });
    assertHealthy(database);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

/**
 * Inspects an existing Registry database without creating or migrating it.
 *
 * This is deliberately a separate surface from `openRegistryDatabase`:
 * opening is a state transition that may claim a blank file and run a
 * migration, while inspection is an observation and must be safe for health
 * checks, read-only mounts and pre-flight validation. The read-only SQLite
 * handle is never configured for WAL and every validation below issues only
 * read statements.
 */
export function inspectRegistryDatabase(
  options: OpenRegistryDatabaseOptions,
): RegistryDatabaseInspection {
  const { location, stateNamespaceId, securityDomain } = options;
  validateRegistryDatabaseOptions(options);
  if (location === ":memory:" || !existsSync(location)) {
    return { status: "missing" };
  }

  let database: DatabaseSync | undefined;
  try {
    database = openInspectionDatabase(location);
    const state = assertDatabaseClaimable(database);
    if (state !== "registry") {
      throw new RegistryDatabaseIdentityError("unidentified_schema");
    }
    const schemaVersion = readSchemaVersion(database);
    if (schemaVersion > REGISTRY_DATABASE_SCHEMA_VERSION) {
      throw new RegistryDatabaseIdentityError("schema_newer");
    }
    if (schemaVersion < REGISTRY_DATABASE_SCHEMA_VERSION) {
      return { status: "incompatible", code: "schema_older" };
    }
    assertExpectedSchema(database);
    assertRecordedIdentity(database, stateNamespaceId, securityDomain);
    assertHealthy(database);
    return {
      status: "compatible",
      schemaVersion: REGISTRY_DATABASE_SCHEMA_VERSION,
    };
  } catch (error) {
    if (error instanceof RegistryDatabaseIdentityError) {
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
  // an otherwise clean directory. `immutable=1` opens the checkpointed main
  // database without any filesystem write. Identity and schema are stable
  // control-plane metadata, so that snapshot is the correct inspection target.
  url.searchParams.set("immutable", "1");
  return new DatabaseSync(url, { readOnly: true });
}

function validateRegistryDatabaseOptions(
  options: OpenRegistryDatabaseOptions,
): void {
  if (options.location.trim() === "") {
    throw new TypeError("Registry database location is invalid");
  }
  if (
    options.stateNamespaceId.trim() === "" ||
    options.securityDomain.trim() === ""
  ) {
    throw new TypeError("Registry database identity is invalid");
  }
}

/**
 * Refuses a file a newer build wrote.
 *
 * `0` means the version was never stamped — every registry.db from before this
 * check — and is claimed rather than refused. Anything above what this build
 * knows is data whose meaning may have moved, and reading it would be the
 * quiet corruption the check exists to prevent.
 */
function assertSchemaNotNewer(database: DatabaseSync): void {
  if (readSchemaVersion(database) > REGISTRY_DATABASE_SCHEMA_VERSION) {
    throw new RegistryDatabaseIdentityError("schema_newer");
  }
}

function claimSchemaVersion(database: DatabaseSync): void {
  if (readSchemaVersion(database) !== REGISTRY_DATABASE_SCHEMA_VERSION) {
    database.exec(
      `PRAGMA user_version = ${String(REGISTRY_DATABASE_SCHEMA_VERSION)}`,
    );
  }
}

function readSchemaVersion(database: DatabaseSync): number {
  const row = database.prepare("PRAGMA user_version").get() as
    | { readonly user_version?: unknown }
    | undefined;
  if (
    !Number.isSafeInteger(row?.user_version) ||
    (row!.user_version as number) < 0
  ) {
    throw new RegistryDatabaseIdentityError("schema_invalid");
  }
  return row!.user_version as number;
}

/**
 * Makes the file durable, and refuses it if the settings did not take.
 *
 * This database holds the approval trail — the record of what a person decided
 * may be served. Losing the last decisions to a power cut is not a delay that
 * resolves itself: nothing re-derives an approval, and the Cards would come
 * back serving what they served before someone withdrew them. Verified rather
 * than assumed, because a `PRAGMA` on a read-only or locked file silently does
 * nothing.
 */
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
    throw new RegistryDatabaseIdentityError("schema_invalid");
  }
}

/**
 * The exact column shape this build expects, checked after migration.
 *
 * The pair to `user_version`: the version says which shape a file claims, this
 * says whether it actually has it. A file that claims the right version with
 * the wrong columns was edited by hand or left half-migrated, and either way
 * the stores above it would read columns that are not there.
 *
 * Columns are `[name, type, notnull, pk]`, in declaration order — the same
 * tuple `PRAGMA table_info` returns.
 */
const EXPECTED_SCHEMA: Readonly<
  Record<string, readonly (readonly unknown[])[]>
> = {
  registry_metadata: [
    ["singleton", "INTEGER", 0, 1],
    ["state_namespace_id", "TEXT", 1, 0],
    ["security_domain", "TEXT", 1, 0],
  ],
  cards: [
    ["card_id", "TEXT", 0, 1],
    ["description", "TEXT", 1, 0],
    ["representative_questions", "TEXT", 1, 0],
    ["aliases", "TEXT", 1, 0],
    ["keywords", "TEXT", 1, 0],
    ["sensitive", "INTEGER", 1, 0],
    ["allowed_usage", "TEXT", 1, 0],
    ["current_version_id", "TEXT", 0, 0],
  ],
  card_versions: [
    ["version_id", "TEXT", 0, 1],
    ["card_id", "TEXT", 1, 0],
    ["publication_id", "TEXT", 1, 0],
    ["observation_id", "TEXT", 1, 0],
    ["knowledge_unit_id", "TEXT", 1, 0],
    ["scopes", "TEXT", 1, 0],
    ["validation_state", "TEXT", 1, 0],
    ["created_at", "TEXT", 1, 0],
    ["append_order", "INTEGER", 1, 0],
    ["meaning", "TEXT", 0, 0],
    ["grounding", "TEXT", 0, 0],
    ["change_from_previous", "TEXT", 0, 0],
  ],
  lifecycle_events: [
    ["event_id", "TEXT", 0, 1],
    ["card_id", "TEXT", 1, 0],
    ["kind", "TEXT", 1, 0],
    ["occurred_at", "TEXT", 1, 0],
    ["payload", "TEXT", 1, 0],
    ["append_order", "INTEGER", 1, 0],
  ],
  consumer_checkpoints: [
    ["publication_id", "TEXT", 0, 1],
    ["source_id", "TEXT", 1, 0],
    ["processed_at", "TEXT", 1, 0],
  ],
  consumer_source_cursors: [
    ["source_id", "TEXT", 0, 1],
    ["publication_id", "TEXT", 1, 0],
    ["processed_at", "TEXT", 1, 0],
  ],
};

function assertExpectedSchema(database: DatabaseSync): void {
  for (const [table, expected] of Object.entries(EXPECTED_SCHEMA)) {
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
      throw new RegistryDatabaseIdentityError("schema_invalid");
    }
  }
}

/** Refuses a corrupt file at open rather than at the first read that trips. */
function assertHealthy(database: DatabaseSync): void {
  const quickCheck = database.prepare("PRAGMA quick_check").all() as Array<
    Readonly<Record<string, unknown>>
  >;
  if (
    quickCheck.length !== 1 ||
    Object.values(quickCheck[0] ?? {})[0] !== "ok" ||
    database.prepare("PRAGMA foreign_key_check").all().length !== 0
  ) {
    throw new RegistryDatabaseIdentityError("schema_invalid");
  }
}

/**
 * Compares the recorded deployment identity against the configured one.
 *
 * A marked file must be able to say which installation it belongs to. A
 * missing table or a missing row is a half-initialised file rather than an
 * older one — the mark and the identity are written in the same open — so it
 * is refused instead of adopted.
 */
function assertRecordedIdentity(
  database: DatabaseSync,
  stateNamespaceId: string,
  securityDomain: string,
): void {
  // The columns are checked before they are selected. Reading first would let
  // a table of the right name and the wrong shape surface as a raw SQLite
  // `no such column`, which no caller can branch on and which says nothing
  // about the file being unusable.
  const columns = new Set(
    (
      database.prepare("PRAGMA table_info(registry_metadata)").all() as {
        readonly name?: unknown;
      }[]
    ).map((row) => row.name),
  );
  if (
    !columns.has("singleton") ||
    !columns.has("state_namespace_id") ||
    !columns.has("security_domain")
  ) {
    throw new RegistryDatabaseIdentityError("schema_invalid");
  }
  const row = database
    .prepare(
      "SELECT state_namespace_id, security_domain FROM registry_metadata WHERE singleton = 1",
    )
    .get() as
    | {
        readonly state_namespace_id?: unknown;
        readonly security_domain?: unknown;
      }
    | undefined;
  if (row === undefined) {
    throw new RegistryDatabaseIdentityError("schema_invalid");
  }
  if (
    row.state_namespace_id !== stateNamespaceId ||
    row.security_domain !== securityDomain
  ) {
    throw new RegistryDatabaseIdentityError("identity_mismatch");
  }
}

function recordIdentity(
  database: DatabaseSync,
  stateNamespaceId: string,
  securityDomain: string,
): void {
  database
    .prepare(
      `INSERT INTO registry_metadata (singleton, state_namespace_id, security_domain)
       VALUES (1, ?, ?)
       ON CONFLICT (singleton) DO NOTHING`,
    )
    .run(stateNamespaceId, securityDomain);
}

/** What the file at the location turned out to be. */
type ClaimableState =
  /** Nothing in it — this open initialises it and takes ownership. */
  | "empty"
  /** Marked as Registry's, so its recorded identity decides the rest. */
  | "registry";

/**
 * Whether this file is Registry's to write into.
 *
 * Only two files are accepted: one already marked as Registry's, and one that
 * is completely empty. Everything else is refused, including a file that holds
 * Cards but carries no mark.
 *
 * That last case is the one worth stating plainly, because the data looks like
 * ours and the temptation is to adopt it. Nothing in an unmarked file says
 * which installation wrote it, so adopting it means a deployment silently
 * absorbing state whose origin cannot be shown — and if that state came from
 * another security domain, its Cards would then be served under this one. A
 * fingerprint (`cards` exists, so it must be a registry.db) proves the shape
 * and not the owner, which is the wrong question. `openIngestionDatabase`
 * draws the same line, and unmarked Registry files exist only from builds
 * before this check, so the refusal costs a rebuild of local state and buys
 * an invariant: every file this opener writes to has said whose it is.
 */
function assertDatabaseClaimable(database: DatabaseSync): ClaimableState {
  const applicationId = readApplicationId(database);
  if (applicationId === REGISTRY_DATABASE_APPLICATION_ID) {
    return "registry";
  }
  if (applicationId !== 0) {
    throw new RegistryDatabaseIdentityError("identity_mismatch");
  }

  const objects = database
    .prepare(
      "SELECT 1 AS present FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' LIMIT 1",
    )
    .get();
  if (objects !== undefined) {
    throw new RegistryDatabaseIdentityError("unidentified_schema");
  }
  return "empty";
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
    // Not a mismatch — the header itself did not read back as a number, which
    // says the file is not a usable SQLite database at all.
    throw new RegistryDatabaseIdentityError("schema_invalid");
  }
  return row!.application_id as number;
}

function migrate(database: DatabaseSync): void {
  ensureGroundingColumns(database);
  database.exec(`
    CREATE TABLE IF NOT EXISTS registry_metadata (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      state_namespace_id TEXT NOT NULL,
      security_domain TEXT NOT NULL
    );

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
