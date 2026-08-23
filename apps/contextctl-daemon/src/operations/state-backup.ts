import { createHash, randomUUID } from "node:crypto";
import {
  constants as fsConstants,
  createReadStream,
  type Stats,
} from "node:fs";
import {
  access,
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { DatabaseSync, backup as backupSqlite } from "node:sqlite";

import {
  INGESTION_DATABASE_APPLICATION_ID,
  INGESTION_DATABASE_SCHEMA_VERSION,
  listPublishedQdrantBackupTargets,
  type PublishedQdrantBackupTarget,
} from "@contextctl/ingestion-indexing";
import {
  REGISTRY_DATABASE_APPLICATION_ID,
  REGISTRY_DATABASE_SCHEMA_VERSION,
} from "@contextctl/registry-lifecycle";

export const STATE_BACKUP_FORMAT_VERSION = 1;
export const STATE_BACKUP_MANIFEST_FILE = "manifest.json";

const MAX_MANIFEST_BYTES = 1024 * 1024;
const SQLITE_BUSY_TIMEOUT_MS = 5_000;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const COLLECTION_PATTERN = /^contextctl_[a-f0-9]{32}$/;
const BACKUP_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface StateBackupIdentity {
  readonly stateNamespaceId: string;
  readonly securityDomain: string;
}

export interface StateBackupSourcePaths {
  readonly ingestionDatabase: string;
  readonly registryDatabase: string;
  readonly sourcesFile?: string;
}

export interface StateBackupManifest {
  readonly formatVersion: 1;
  readonly backupId: string;
  readonly createdAt: string;
  readonly consistencyProtocol: "sqlite-write-freeze-qdrant-snapshot-v1";
  readonly stateNamespaceId: string;
  readonly securityDomain: string;
  readonly sqlite: readonly StateBackupSqliteArtifact[];
  readonly qdrant: readonly StateBackupQdrantArtifact[];
  readonly sources?: StateBackupFileArtifact;
}

export interface StateBackupFileArtifact {
  readonly path: string;
  readonly sizeBytes: number;
  readonly sha256: string;
}

export interface StateBackupSqliteArtifact extends StateBackupFileArtifact {
  readonly role: "ingestion" | "registry";
  readonly applicationId: number;
  readonly schemaVersion: number;
}

export interface StateBackupQdrantArtifact extends StateBackupFileArtifact {
  readonly collectionName: string;
  readonly qdrantChecksum?: string;
}

export interface VectorSnapshotRestoreLease {
  /** Removes only the collections created by this attempted restore. */
  rollback(): Promise<void>;
}

/** Infrastructure adapter used by the daemon backup coordinator. */
export interface VectorSnapshotArchive {
  create(input: {
    readonly targets: readonly PublishedQdrantBackupTarget[];
    readonly directory: string;
  }): Promise<readonly StateBackupQdrantArtifact[]>;
  restore(input: {
    readonly artifacts: readonly StateBackupQdrantArtifact[];
    readonly directory: string;
  }): Promise<VectorSnapshotRestoreLease>;
}

export type StateBackupErrorCode =
  | "backup_destination_exists"
  | "backup_identity_invalid"
  | "backup_manifest_invalid"
  | "backup_source_invalid"
  | "backup_state_busy"
  | "backup_state_corrupt"
  | "backup_write_failed"
  | "restore_destination_exists"
  | "restore_identity_mismatch"
  | "restore_integrity_failed"
  | "restore_write_failed";

export class StateBackupError extends Error {
  constructor(
    readonly code: StateBackupErrorCode,
    options?: ErrorOptions,
  ) {
    const causeCode = safeCauseCode(options?.cause);
    super(
      `Contextctl state backup failed: ${code}${causeCode === undefined ? "" : ` (${causeCode})`}`,
      options,
    );
    this.name = "StateBackupError";
  }
}

export async function createStateBackup(input: {
  readonly destination: string;
  readonly identity: StateBackupIdentity;
  readonly paths: StateBackupSourcePaths;
  readonly vectors: VectorSnapshotArchive;
  readonly now?: () => Date;
}): Promise<StateBackupManifest> {
  const identity = assertIdentity(input.identity);
  const destination = resolve(input.destination);
  await assertPathAbsent(destination, "backup_destination_exists");
  await assertRegularFile(input.paths.ingestionDatabase);
  await assertRegularFile(input.paths.registryDatabase);
  if (input.paths.sourcesFile !== undefined) {
    await assertRegularFile(input.paths.sourcesFile);
  }

  await mkdir(dirname(destination), { recursive: true });
  const staging = await mkdtemp(
    join(dirname(destination), ".contextctl-backup-staging-"),
  );
  await chmod(staging, 0o700);

  let ingestionLock: DatabaseSync | undefined;
  let registryLock: DatabaseSync | undefined;
  let committed = false;
  try {
    ingestionLock = openLockConnection(input.paths.ingestionDatabase);
    assertSqliteHealthy(ingestionLock);
    assertStoredIdentity(ingestionLock, "ingestion_metadata", identity);
    beginWriteFreeze(ingestionLock);

    registryLock = openLockConnection(input.paths.registryDatabase);
    assertSqliteHealthy(registryLock);
    assertStoredIdentity(registryLock, "registry_metadata", identity);
    beginWriteFreeze(registryLock);

    const targets = listPublishedQdrantBackupTargets(ingestionLock, identity);
    const qdrantDirectory = join(staging, "qdrant");
    await mkdir(qdrantDirectory, { recursive: true, mode: 0o700 });
    const qdrant = await input.vectors.create({
      targets,
      directory: qdrantDirectory,
    });
    await assertVectorArtifacts(staging, targets, qdrant);

    const sqliteDirectory = join(staging, "sqlite");
    await mkdir(sqliteDirectory, { recursive: true, mode: 0o700 });
    // Sequential on purpose. Promise.all would reject as soon as one backup
    // failed, release both write locks in `finally`, and remove the staging
    // directory while the other SQLite backup was still writing into it.
    const sqlite: readonly StateBackupSqliteArtifact[] = [
      await createSqliteArtifact({
        role: "ingestion",
        source: input.paths.ingestionDatabase,
        destination: join(sqliteDirectory, "ingestion.db"),
      }),
      await createSqliteArtifact({
        role: "registry",
        source: input.paths.registryDatabase,
        destination: join(sqliteDirectory, "registry.db"),
      }),
    ];

    const sources =
      input.paths.sourcesFile === undefined
        ? undefined
        : await createFileArtifact(
            input.paths.sourcesFile,
            join(staging, "sources.json"),
            "sources.json",
          );
    const createdAt = (input.now ?? (() => new Date()))().toISOString();
    const manifest: StateBackupManifest = {
      formatVersion: STATE_BACKUP_FORMAT_VERSION,
      backupId: randomUUID(),
      createdAt,
      consistencyProtocol: "sqlite-write-freeze-qdrant-snapshot-v1",
      ...identity,
      sqlite,
      qdrant: [...qdrant].sort((left, right) =>
        left.collectionName.localeCompare(right.collectionName),
      ),
      ...(sources === undefined ? {} : { sources }),
    };
    assertManifest(manifest);
    await writeFile(
      join(staging, STATE_BACKUP_MANIFEST_FILE),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600, flush: true },
    );
    await rename(staging, destination);
    committed = true;
    return manifest;
  } catch (error) {
    if (error instanceof StateBackupError) throw error;
    if (isSqliteBusy(error)) {
      throw new StateBackupError("backup_state_busy", { cause: error });
    }
    throw new StateBackupError("backup_write_failed", { cause: error });
  } finally {
    rollbackWriteFreeze(registryLock);
    registryLock?.close();
    rollbackWriteFreeze(ingestionLock);
    ingestionLock?.close();
    if (!committed) {
      await rm(staging, { recursive: true, force: true });
    }
  }
}

/**
 * Restores into a new home and empty Qdrant collections only.
 *
 * Existing state is never replaced in place. An operator validates the new
 * home, switches deployment configuration, and can roll back by switching back
 * to the untouched old home and vector service.
 */
export async function restoreStateBackup(input: {
  readonly source: string;
  readonly destinationHome: string;
  readonly expectedIdentity: StateBackupIdentity;
  readonly vectors: VectorSnapshotArchive;
}): Promise<StateBackupManifest> {
  const expectedIdentity = assertIdentity(input.expectedIdentity);
  const source = resolve(input.source);
  const destination = resolve(input.destinationHome);
  await assertPathAbsent(destination, "restore_destination_exists");
  const manifest = await readStateBackupManifest(source);
  if (
    manifest.stateNamespaceId !== expectedIdentity.stateNamespaceId ||
    manifest.securityDomain !== expectedIdentity.securityDomain
  ) {
    throw new StateBackupError("restore_identity_mismatch");
  }

  await verifyArtifacts(source, manifest);
  await mkdir(dirname(destination), { recursive: true });
  const staging = await mkdtemp(
    join(dirname(destination), ".contextctl-restore-staging-"),
  );
  await chmod(staging, 0o700);
  let vectorLease: VectorSnapshotRestoreLease | undefined;
  let committed = false;
  try {
    for (const artifact of manifest.sqlite) {
      const destinationFile = join(
        staging,
        artifact.role === "ingestion" ? "ingestion.db" : "registry.db",
      );
      await copyFile(
        safeArtifactPath(source, artifact.path),
        destinationFile,
        fsConstants.COPYFILE_EXCL,
      );
      await chmod(destinationFile, 0o600);
      await syncFile(destinationFile);
      const restored = new DatabaseSync(destinationFile, { readOnly: true });
      try {
        assertSqliteHealthy(restored);
        assertSqliteHeader(restored, artifact.role, artifact);
        assertStoredIdentity(
          restored,
          artifact.role === "ingestion"
            ? "ingestion_metadata"
            : "registry_metadata",
          expectedIdentity,
        );
      } finally {
        restored.close();
      }
    }
    if (manifest.sources !== undefined) {
      const destinationFile = join(staging, "sources.json");
      await copyFile(
        safeArtifactPath(source, manifest.sources.path),
        destinationFile,
        fsConstants.COPYFILE_EXCL,
      );
      await chmod(destinationFile, 0o600);
      await syncFile(destinationFile);
    }

    vectorLease = await input.vectors.restore({
      artifacts: manifest.qdrant,
      directory: join(source, "qdrant"),
    });
    await rename(staging, destination);
    committed = true;
    return manifest;
  } catch (error) {
    let rollbackFailure: unknown;
    if (vectorLease !== undefined) {
      try {
        await vectorLease.rollback();
      } catch (rollbackError) {
        rollbackFailure = rollbackError;
      }
    }
    if (rollbackFailure !== undefined) {
      throw new StateBackupError("restore_write_failed", {
        cause: new AggregateError([error, rollbackFailure]),
      });
    }
    if (error instanceof StateBackupError) throw error;
    throw new StateBackupError("restore_write_failed", { cause: error });
  } finally {
    if (!committed) {
      await rm(staging, { recursive: true, force: true });
    }
  }
}

export async function readStateBackupManifest(
  source: string,
): Promise<StateBackupManifest> {
  let bytes: Buffer;
  try {
    const path = join(resolve(source), STATE_BACKUP_MANIFEST_FILE);
    const details = await stat(path);
    if (!details.isFile() || details.size > MAX_MANIFEST_BYTES) {
      throw new StateBackupError("backup_manifest_invalid");
    }
    bytes = await readFile(path);
  } catch (error) {
    if (error instanceof StateBackupError) throw error;
    throw new StateBackupError("backup_manifest_invalid", { cause: error });
  }
  try {
    const decoded = JSON.parse(bytes.toString("utf8")) as unknown;
    return assertManifest(decoded);
  } catch (error) {
    if (error instanceof StateBackupError) throw error;
    throw new StateBackupError("backup_manifest_invalid", { cause: error });
  }
}

async function createSqliteArtifact(input: {
  readonly role: "ingestion" | "registry";
  readonly source: string;
  readonly destination: string;
}): Promise<StateBackupSqliteArtifact> {
  const source = new DatabaseSync(input.source, { readOnly: true });
  try {
    await backupSqlite(source, input.destination);
  } finally {
    source.close();
  }
  await chmod(input.destination, 0o600);
  await syncFile(input.destination);
  const snapshot = new DatabaseSync(input.destination, { readOnly: true });
  try {
    assertSqliteHealthy(snapshot);
    const applicationId = pragmaInteger(snapshot, "application_id");
    const schemaVersion = pragmaInteger(snapshot, "user_version");
    assertSqliteHeader(snapshot, input.role, {
      applicationId,
      schemaVersion,
    });
    const details = await stat(input.destination);
    return {
      role: input.role,
      path: `sqlite/${input.role}.db`,
      applicationId,
      schemaVersion,
      sizeBytes: details.size,
      sha256: await sha256File(input.destination),
    };
  } finally {
    snapshot.close();
  }
}

async function assertVectorArtifacts(
  root: string,
  targets: readonly PublishedQdrantBackupTarget[],
  artifacts: readonly StateBackupQdrantArtifact[],
): Promise<void> {
  const expected = targets.map((target) => target.collectionName).sort();
  const actual = artifacts.map((artifact) => artifact.collectionName).sort();
  if (
    expected.length !== actual.length ||
    expected.some((collection, index) => collection !== actual[index])
  ) {
    throw new StateBackupError("backup_write_failed");
  }
  for (const candidate of artifacts) {
    const artifact = assertQdrantArtifact(candidate);
    const path = safeArtifactPath(root, artifact.path);
    try {
      const details = await stat(path);
      if (
        !details.isFile() ||
        details.size !== artifact.sizeBytes ||
        (await sha256File(path)) !== artifact.sha256
      ) {
        throw new StateBackupError("backup_write_failed");
      }
    } catch (error) {
      if (error instanceof StateBackupError) throw error;
      throw new StateBackupError("backup_write_failed", { cause: error });
    }
  }
}

async function createFileArtifact(
  source: string,
  destination: string,
  relativePath: string,
): Promise<StateBackupFileArtifact> {
  await copyFile(source, destination, fsConstants.COPYFILE_EXCL);
  await chmod(destination, 0o600);
  await syncFile(destination);
  const details = await stat(destination);
  return {
    path: relativePath,
    sizeBytes: details.size,
    sha256: await sha256File(destination),
  };
}

async function verifyArtifacts(
  source: string,
  manifest: StateBackupManifest,
): Promise<void> {
  for (const artifact of [
    ...manifest.sqlite,
    ...manifest.qdrant,
    ...(manifest.sources === undefined ? [] : [manifest.sources]),
  ]) {
    const path = safeArtifactPath(source, artifact.path);
    try {
      const details = await stat(path);
      if (
        !details.isFile() ||
        details.size !== artifact.sizeBytes ||
        (await sha256File(path)) !== artifact.sha256
      ) {
        throw new StateBackupError("restore_integrity_failed");
      }
    } catch (error) {
      if (error instanceof StateBackupError) throw error;
      throw new StateBackupError("restore_integrity_failed", { cause: error });
    }
  }
}

function openLockConnection(location: string): DatabaseSync {
  const database = new DatabaseSync(location);
  database.exec(`PRAGMA busy_timeout = ${String(SQLITE_BUSY_TIMEOUT_MS)}`);
  return database;
}

function beginWriteFreeze(database: DatabaseSync): void {
  database.exec("BEGIN IMMEDIATE");
}

function rollbackWriteFreeze(database: DatabaseSync | undefined): void {
  if (database?.isTransaction === true) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // Closing the connection releases the lock even if rollback reporting
      // itself fails. The original backup error remains the useful diagnosis.
    }
  }
}

function assertSqliteHealthy(database: DatabaseSync): void {
  let quickCheck: readonly Record<string, unknown>[];
  let foreignKeys: readonly Record<string, unknown>[];
  try {
    quickCheck = database.prepare("PRAGMA quick_check").all();
    foreignKeys = database.prepare("PRAGMA foreign_key_check").all();
  } catch (error) {
    throw new StateBackupError("backup_state_corrupt", { cause: error });
  }
  if (
    quickCheck.length !== 1 ||
    Object.values(quickCheck[0] ?? {})[0] !== "ok" ||
    foreignKeys.length !== 0
  ) {
    throw new StateBackupError("backup_state_corrupt");
  }
}

function assertStoredIdentity(
  database: DatabaseSync,
  metadataTable: "ingestion_metadata" | "registry_metadata",
  expected: StateBackupIdentity,
): void {
  let row:
    | {
        readonly state_namespace_id?: unknown;
        readonly security_domain?: unknown;
      }
    | undefined;
  try {
    row = database
      .prepare(
        `SELECT state_namespace_id, security_domain FROM ${metadataTable} WHERE singleton = 1`,
      )
      .get() as typeof row;
  } catch (error) {
    throw new StateBackupError("backup_state_corrupt", { cause: error });
  }
  if (
    row?.state_namespace_id !== expected.stateNamespaceId ||
    row.security_domain !== expected.securityDomain
  ) {
    throw new StateBackupError("backup_state_corrupt");
  }
}

function pragmaInteger(database: DatabaseSync, name: string): number {
  const row = database.prepare(`PRAGMA ${name}`).get();
  const value = Object.values(row ?? {})[0];
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new StateBackupError("backup_state_corrupt");
  }
  return value as number;
}

function assertSqliteHeader(
  database: DatabaseSync,
  role: "ingestion" | "registry",
  recorded: { readonly applicationId: number; readonly schemaVersion: number },
): void {
  const applicationId = pragmaInteger(database, "application_id");
  const schemaVersion = pragmaInteger(database, "user_version");
  const expectedApplicationId =
    role === "ingestion"
      ? INGESTION_DATABASE_APPLICATION_ID
      : REGISTRY_DATABASE_APPLICATION_ID;
  const latestSchemaVersion =
    role === "ingestion"
      ? INGESTION_DATABASE_SCHEMA_VERSION
      : REGISTRY_DATABASE_SCHEMA_VERSION;
  if (
    applicationId !== expectedApplicationId ||
    applicationId !== recorded.applicationId ||
    schemaVersion !== recorded.schemaVersion ||
    schemaVersion > latestSchemaVersion
  ) {
    throw new StateBackupError("backup_state_corrupt");
  }
}

function assertIdentity(input: StateBackupIdentity): StateBackupIdentity {
  if (
    typeof input.stateNamespaceId !== "string" ||
    typeof input.securityDomain !== "string" ||
    input.stateNamespaceId.trim() === "" ||
    input.securityDomain.trim() === "" ||
    input.stateNamespaceId.length > 256 ||
    input.securityDomain.length > 256
  ) {
    throw new StateBackupError("backup_identity_invalid");
  }
  return {
    stateNamespaceId: input.stateNamespaceId,
    securityDomain: input.securityDomain,
  };
}

function assertManifest(input: unknown): StateBackupManifest {
  if (!isRecord(input) || !hasExactKeys(input, [
    "backupId",
    "consistencyProtocol",
    "createdAt",
    "formatVersion",
    "qdrant",
    "securityDomain",
    "sqlite",
    "stateNamespaceId",
  ], ["sources"])) {
    throw new StateBackupError("backup_manifest_invalid");
  }
  if (
    input.formatVersion !== STATE_BACKUP_FORMAT_VERSION ||
    typeof input.backupId !== "string" ||
    !BACKUP_ID_PATTERN.test(input.backupId) ||
    typeof input.createdAt !== "string" ||
    !isCanonicalTimestamp(input.createdAt) ||
    input.consistencyProtocol !== "sqlite-write-freeze-qdrant-snapshot-v1" ||
    typeof input.stateNamespaceId !== "string" ||
    typeof input.securityDomain !== "string" ||
    !Array.isArray(input.sqlite) ||
    !Array.isArray(input.qdrant) ||
    input.qdrant.length > 128
  ) {
    throw new StateBackupError("backup_manifest_invalid");
  }
  assertIdentity({
    stateNamespaceId: input.stateNamespaceId,
    securityDomain: input.securityDomain,
  });
  const sqlite = input.sqlite.map(assertSqliteArtifact);
  if (
    sqlite.length !== 2 ||
    sqlite[0]?.role !== "ingestion" ||
    sqlite[1]?.role !== "registry"
  ) {
    throw new StateBackupError("backup_manifest_invalid");
  }
  const qdrant = input.qdrant.map(assertQdrantArtifact);
  if (new Set(qdrant.map((artifact) => artifact.collectionName)).size !== qdrant.length) {
    throw new StateBackupError("backup_manifest_invalid");
  }
  const sources =
    input.sources === undefined
      ? undefined
      : isRecord(input.sources)
        ? assertFileArtifact(input.sources, "sources.json")
        : (() => {
            throw new StateBackupError("backup_manifest_invalid");
          })();
  return {
    formatVersion: 1,
    backupId: input.backupId,
    createdAt: input.createdAt,
    consistencyProtocol: "sqlite-write-freeze-qdrant-snapshot-v1",
    stateNamespaceId: input.stateNamespaceId,
    securityDomain: input.securityDomain,
    sqlite,
    qdrant,
    ...(sources === undefined ? {} : { sources }),
  };
}

function assertSqliteArtifact(input: unknown): StateBackupSqliteArtifact {
  if (!isRecord(input) || !hasExactKeys(input, [
    "applicationId",
    "path",
    "role",
    "schemaVersion",
    "sha256",
    "sizeBytes",
  ])) {
    throw new StateBackupError("backup_manifest_invalid");
  }
  if (
    (input.role !== "ingestion" && input.role !== "registry") ||
    input.path !== `sqlite/${String(input.role)}.db` ||
    !Number.isSafeInteger(input.applicationId) ||
    (input.applicationId as number) < 0 ||
    !Number.isSafeInteger(input.schemaVersion) ||
    (input.schemaVersion as number) < 0
  ) {
    throw new StateBackupError("backup_manifest_invalid");
  }
  const file = assertFileArtifact(input, input.path);
  return {
    ...file,
    role: input.role,
    applicationId: input.applicationId as number,
    schemaVersion: input.schemaVersion as number,
  };
}

function assertQdrantArtifact(input: unknown): StateBackupQdrantArtifact {
  if (!isRecord(input) || !hasExactKeys(input, [
    "collectionName",
    "path",
    "sha256",
    "sizeBytes",
  ], ["qdrantChecksum"])) {
    throw new StateBackupError("backup_manifest_invalid");
  }
  if (
    typeof input.collectionName !== "string" ||
    !COLLECTION_PATTERN.test(input.collectionName) ||
    input.path !== `qdrant/${input.collectionName}.snapshot` ||
    (input.qdrantChecksum !== undefined &&
      (typeof input.qdrantChecksum !== "string" ||
        input.qdrantChecksum.length > 256))
  ) {
    throw new StateBackupError("backup_manifest_invalid");
  }
  const file = assertFileArtifact(input, input.path);
  return {
    ...file,
    collectionName: input.collectionName,
    ...(input.qdrantChecksum === undefined
      ? {}
      : { qdrantChecksum: input.qdrantChecksum }),
  };
}

function assertFileArtifact(
  input: Record<string, unknown>,
  expectedPath: string,
): StateBackupFileArtifact {
  if (
    input.path !== expectedPath ||
    !Number.isSafeInteger(input.sizeBytes) ||
    (input.sizeBytes as number) < 0 ||
    typeof input.sha256 !== "string" ||
    !SHA256_PATTERN.test(input.sha256)
  ) {
    throw new StateBackupError("backup_manifest_invalid");
  }
  return {
    path: expectedPath,
    sizeBytes: input.sizeBytes as number,
    sha256: input.sha256,
  };
}

function safeArtifactPath(root: string, relative: string): string {
  const absoluteRoot = resolve(root);
  const candidate = resolve(absoluteRoot, relative);
  if (!candidate.startsWith(`${absoluteRoot}${sep}`)) {
    throw new StateBackupError("backup_manifest_invalid");
  }
  return candidate;
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolveHash, rejectHash) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("end", resolveHash);
    stream.once("error", rejectHash);
  });
  return hash.digest("hex");
}

async function syncFile(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function assertRegularFile(path: string): Promise<Stats> {
  try {
    const details = await lstat(path);
    if (!details.isFile() || details.isSymbolicLink()) {
      throw new StateBackupError("backup_source_invalid");
    }
    await access(path, fsConstants.R_OK);
    return details;
  } catch (error) {
    if (error instanceof StateBackupError) throw error;
    throw new StateBackupError("backup_source_invalid", { cause: error });
  }
}

async function assertPathAbsent(
  path: string,
  code: "backup_destination_exists" | "restore_destination_exists",
): Promise<void> {
  try {
    await lstat(path);
    throw new StateBackupError(code);
  } catch (error) {
    if (error instanceof StateBackupError) throw error;
    if (isNotFound(error)) return;
    throw new StateBackupError(code, { cause: error });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCanonicalTimestamp(value: string): boolean {
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const keys = Object.keys(value).sort();
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    keys.every((key) => allowed.has(key))
  );
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function isSqliteBusy(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "ERR_SQLITE_BUSY" || error.code === "SQLITE_BUSY")
  );
}

function safeCauseCode(cause: unknown): string | undefined {
  if (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    typeof cause.code === "string" &&
    /^[a-z][a-z0-9_]{0,63}$/.test(cause.code)
  ) {
    return cause.code;
  }
  return undefined;
}
