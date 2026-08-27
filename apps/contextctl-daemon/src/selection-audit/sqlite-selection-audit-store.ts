import { chmodSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

import {
  assertSelectionAuditListLimit,
  assertSelectionAuditRecord,
  assertSelectionAuditSummary,
  SELECTION_AUDIT_RETENTION_POLICY,
  summarizeSelectionAuditRecord,
  type SelectionAuditRecord,
  type SelectionAuditStore,
  type SelectionAuditSummary,
} from "@contextctl/selection-delivery";

import type { DaemonStateIdentity } from "../runtime/state-identity.js";

const SCHEMA_VERSION = 1;
const APPLICATION_ID = 0x4354_5841; // "CTXA"
// node:sqlite runs in the dedicated audit Worker. Keep lock waiting far below
// the 500ms assembly reserve as well, so a busy database fails quickly without
// leaving the Worker occupied for SQLite's customary seconds.
const BUSY_TIMEOUT_MS = 100;

interface AuditRow {
  readonly audit_id: string;
  readonly recorded_at: string;
  readonly recorded_at_ms: number;
  readonly record_json: string;
  readonly record_bytes: number;
}

interface SummaryRow {
  readonly audit_id: string;
  readonly recorded_at: string;
  readonly recorded_at_ms: number;
  readonly summary_json: string;
  readonly summary_bytes: number;
}

/** Durable bounded adapter for Selection's operator-only audit port. */
export class SqliteSelectionAuditStore implements SelectionAuditStore {
  constructor(
    readonly database: DatabaseSync,
    readonly now: () => number = Date.now,
    readonly location: string = ":memory:",
  ) {}

  async append(record: SelectionAuditRecord): Promise<void> {
    assertSelectionAuditRecord(record);
    const payload = JSON.stringify(record);
    const summaryPayload = JSON.stringify(
      summarizeSelectionAuditRecord(record),
    );
    const bytes = Buffer.byteLength(payload, "utf8");
    const summaryBytes = Buffer.byteLength(summaryPayload, "utf8");
    const recordedAtMs = Date.parse(record.recordedAt);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database
        .prepare(
          `INSERT INTO selection_audit_records(
             audit_id, recorded_at, recorded_at_ms,
             summary_json, summary_bytes, record_json, record_bytes
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          record.auditId,
          record.recordedAt,
          recordedAtMs,
          summaryPayload,
          summaryBytes,
          payload,
          bytes,
        );
      this.#prune(this.now());
      this.database.exec("COMMIT");
      protectDatabaseFiles(this.location);
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  async list(limit: number): Promise<readonly SelectionAuditSummary[]> {
    assertSelectionAuditListLimit(limit);
    const rows = this.database
      .prepare(
        `SELECT audit_id, recorded_at, recorded_at_ms,
                summary_json, summary_bytes
         FROM selection_audit_records
         WHERE recorded_at_ms >= ?
         ORDER BY recorded_at_ms DESC, audit_id DESC
         LIMIT ?`,
      )
      .all(
        this.now() - SELECTION_AUDIT_RETENTION_POLICY.maximumAgeMs,
        limit,
      ) as unknown as readonly SummaryRow[];
    return rows.map(parseSummaryRow);
  }

  async find(auditId: string): Promise<SelectionAuditRecord | undefined> {
    const row = this.database
      .prepare(
        `SELECT audit_id, recorded_at, recorded_at_ms,
                record_json, record_bytes
         FROM selection_audit_records
         WHERE audit_id = ? AND recorded_at_ms >= ?`,
      )
      .get(
        auditId,
        this.now() - SELECTION_AUDIT_RETENTION_POLICY.maximumAgeMs,
      ) as unknown as AuditRow | undefined;
    return row === undefined ? undefined : parseRow(row);
  }

  #prune(now: number): void {
    const policy = SELECTION_AUDIT_RETENTION_POLICY;
    this.database
      .prepare("DELETE FROM selection_audit_records WHERE recorded_at_ms < ?")
      .run(now - policy.maximumAgeMs);
    this.database
      .prepare(
        `DELETE FROM selection_audit_records
         WHERE audit_id IN (
           SELECT audit_id FROM selection_audit_records
           ORDER BY recorded_at_ms DESC, audit_id DESC
           LIMIT -1 OFFSET ?
         )`,
      )
      .run(policy.maximumRecords);
    this.database
      .prepare(
        `DELETE FROM selection_audit_records
         WHERE audit_id IN (
           SELECT audit_id FROM (
             SELECT audit_id,
                    SUM(record_bytes + summary_bytes) OVER (
                      ORDER BY recorded_at_ms DESC, audit_id DESC
                      ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
                    ) AS retained_bytes
             FROM selection_audit_records
           ) WHERE retained_bytes > ?
         )`,
      )
      .run(policy.maximumBytes);
  }
}

export function openSelectionAuditDatabase(input: {
  readonly location: string;
  readonly stateIdentity: DaemonStateIdentity;
  readonly readOnly?: boolean;
}): DatabaseSync {
  if (!input.readOnly && input.location !== ":memory:") {
    mkdirSync(dirname(input.location), { recursive: true, mode: 0o700 });
  }
  const source = readOnlyDatabaseSource(input.location, input.readOnly === true);
  const database = new DatabaseSync(source, {
    readOnly: input.readOnly ?? false,
  });
  try {
    database.exec(`PRAGMA busy_timeout = ${String(BUSY_TIMEOUT_MS)}`);
    if (input.readOnly) {
      assertCompatible(database, input.stateIdentity);
    } else {
      initializeOrAssert(database, input.stateIdentity);
      database.exec("PRAGMA journal_mode = WAL");
      protectDatabaseFiles(input.location);
    }
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

function readOnlyDatabaseSource(
  location: string,
  readOnly: boolean,
): string | URL {
  if (!readOnly || location === ":memory:") return location;
  const walExists = existsSync(`${location}-wal`);
  const shmExists = existsSync(`${location}-shm`);
  if (walExists && !shmExists) {
    throw new Error(
      "selection audit database has a WAL without its shared-memory snapshot",
    );
  }
  return walExists && shmExists ? location : immutableDatabaseUrl(location);
}

function immutableDatabaseUrl(location: string): URL {
  const url = pathToFileURL(location);
  url.searchParams.set("immutable", "1");
  return url;
}

export function inspectSelectionAuditDatabase(input: {
  readonly location: string;
  readonly stateIdentity: DaemonStateIdentity;
}):
  | { readonly status: "missing" }
  | { readonly status: "compatible"; readonly recordCount: number }
  | { readonly status: "incompatible"; readonly detail: string } {
  if (!existsSync(input.location)) return { status: "missing" };
  let database: DatabaseSync | undefined;
  try {
    database = openSelectionAuditDatabase({ ...input, readOnly: true });
    const row = database
      .prepare(
        "SELECT COUNT(*) AS count FROM selection_audit_records WHERE recorded_at_ms >= ?",
      )
      .get(
        Date.now() - SELECTION_AUDIT_RETENTION_POLICY.maximumAgeMs,
      ) as unknown as { readonly count: number };
    return { status: "compatible", recordCount: row.count };
  } catch (error) {
    return {
      status: "incompatible",
      detail: error instanceof Error ? error.message : String(error),
    };
  } finally {
    database?.close();
  }
}

function initializeOrAssert(
  database: DatabaseSync,
  identity: DaemonStateIdentity,
): void {
  const tables = applicationTables(database);
  const applicationId = pragmaNumber(database, "application_id");
  const userVersion = pragmaNumber(database, "user_version");
  if (tables.length === 0 && applicationId === 0 && userVersion === 0) {
    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(`
        CREATE TABLE selection_audit_metadata (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          schema_version INTEGER NOT NULL,
          state_namespace_id TEXT NOT NULL,
          security_domain TEXT NOT NULL
        );
        CREATE TABLE selection_audit_records (
          audit_id TEXT PRIMARY KEY,
          recorded_at TEXT NOT NULL,
          recorded_at_ms INTEGER NOT NULL,
          summary_json TEXT NOT NULL,
          summary_bytes INTEGER NOT NULL CHECK (summary_bytes > 0),
          record_json TEXT NOT NULL,
          record_bytes INTEGER NOT NULL CHECK (record_bytes > 0)
        );
        CREATE INDEX selection_audit_records_order
          ON selection_audit_records(recorded_at_ms DESC, audit_id DESC);
        PRAGMA application_id = ${String(APPLICATION_ID)};
        PRAGMA user_version = ${String(SCHEMA_VERSION)};
      `);
      database
        .prepare(
          `INSERT INTO selection_audit_metadata(
             singleton, schema_version, state_namespace_id, security_domain
           ) VALUES (1, ?, ?, ?)`,
        )
        .run(
          SCHEMA_VERSION,
          identity.stateNamespaceId,
          identity.securityDomain,
        );
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    return;
  }
  assertCompatible(database, identity);
}

function assertCompatible(
  database: DatabaseSync,
  identity: DaemonStateIdentity,
): void {
  if (
    pragmaNumber(database, "application_id") !== APPLICATION_ID ||
    pragmaNumber(database, "user_version") !== SCHEMA_VERSION
  ) {
    throw new Error("selection audit database is unidentified or incompatible");
  }
  const quickCheck = database.prepare("PRAGMA quick_check").get() as unknown as
    | { readonly quick_check: string }
    | undefined;
  if (quickCheck?.quick_check !== "ok") {
    throw new Error("selection audit database failed SQLite quick_check");
  }
  const tables = applicationTables(database);
  if (
    tables.length !== 2 ||
    tables[0] !== "selection_audit_metadata" ||
    tables[1] !== "selection_audit_records"
  ) {
    throw new Error(
      "selection audit database schema is incomplete or unexpected",
    );
  }
  assertColumns(database, "selection_audit_metadata", [
    "singleton:INTEGER:0:1",
    "schema_version:INTEGER:1:0",
    "state_namespace_id:TEXT:1:0",
    "security_domain:TEXT:1:0",
  ]);
  assertColumns(database, "selection_audit_records", [
    "audit_id:TEXT:0:1",
    "recorded_at:TEXT:1:0",
    "recorded_at_ms:INTEGER:1:0",
    "summary_json:TEXT:1:0",
    "summary_bytes:INTEGER:1:0",
    "record_json:TEXT:1:0",
    "record_bytes:INTEGER:1:0",
  ]);
  const indexColumns = (
    database
      .prepare("PRAGMA index_info(selection_audit_records_order)")
      .all() as unknown as readonly { readonly name: string }[]
  ).map((row) => row.name);
  if (indexColumns.join(",") !== "recorded_at_ms,audit_id") {
    throw new Error("selection audit ordering index is incompatible");
  }
  const metadataRows = database
    .prepare(
      `SELECT schema_version, state_namespace_id, security_domain
       FROM selection_audit_metadata`,
    )
    .all() as unknown as readonly {
      readonly schema_version: number;
      readonly state_namespace_id: string;
      readonly security_domain: string;
    }[];
  const metadata = metadataRows[0];
  if (metadataRows.length !== 1 || metadata?.schema_version !== SCHEMA_VERSION) {
    throw new Error("selection audit schema version is incompatible");
  }
  if (
    metadata.state_namespace_id !== identity.stateNamespaceId ||
    metadata.security_domain !== identity.securityDomain
  ) {
    throw new Error("selection audit state identity does not match this daemon");
  }
}

function applicationTables(database: DatabaseSync): string[] {
  return (
    database
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as unknown as readonly { readonly name: string }[]
  ).map((row) => row.name);
}

function pragmaNumber(database: DatabaseSync, name: string): number {
  const row = database.prepare(`PRAGMA ${name}`).get() as unknown as
    | Record<string, number>
    | undefined;
  return row?.[name] ?? -1;
}

function assertColumns(
  database: DatabaseSync,
  table: string,
  expected: readonly string[],
): void {
  const actual = (
    database.prepare(`PRAGMA table_info(${table})`).all() as unknown as readonly {
      readonly name: string;
      readonly type: string;
      readonly notnull: number;
      readonly pk: number;
    }[]
  ).map((column) =>
    [column.name, column.type, column.notnull, column.pk].join(":"),
  );
  if (actual.join("|") !== expected.join("|")) {
    throw new Error(`selection audit table ${table} has an incompatible shape`);
  }
}

function parseSummaryRow(row: SummaryRow): SelectionAuditSummary {
  if (Buffer.byteLength(row.summary_json, "utf8") !== row.summary_bytes) {
    throw new Error(`selection audit summary byte count is invalid: ${row.audit_id}`);
  }
  const summary = JSON.parse(row.summary_json) as SelectionAuditSummary;
  assertSelectionAuditSummary(summary);
  if (
    summary.auditId !== row.audit_id ||
    summary.recordedAt !== row.recorded_at ||
    Date.parse(summary.recordedAt) !== row.recorded_at_ms
  ) {
    throw new Error(`selection audit summary row does not match: ${row.audit_id}`);
  }
  return summary;
}

function parseRow(row: AuditRow): SelectionAuditRecord {
  if (Buffer.byteLength(row.record_json, "utf8") !== row.record_bytes) {
    throw new Error(`selection audit byte count is invalid: ${row.audit_id}`);
  }
  const record = JSON.parse(row.record_json) as SelectionAuditRecord;
  assertSelectionAuditRecord(record);
  if (
    record.auditId !== row.audit_id ||
    record.recordedAt !== row.recorded_at ||
    Date.parse(record.recordedAt) !== row.recorded_at_ms
  ) {
    throw new Error(`selection audit row does not match its payload: ${row.audit_id}`);
  }
  return record;
}

function protectDatabaseFiles(location: string): void {
  if (location === ":memory:") return;
  for (const path of [location, `${location}-wal`, `${location}-shm`]) {
    if (existsSync(path) && statSync(path).isFile()) chmodSync(path, 0o600);
  }
}
