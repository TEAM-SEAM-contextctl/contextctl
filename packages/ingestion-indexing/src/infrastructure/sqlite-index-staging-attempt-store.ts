import type { DatabaseSync, SQLInputValue } from "node:sqlite";

import {
  assertValidIndexStagingAttempt,
  assertValidIndexStagingAttemptKey,
} from "../domain/index-staging-attempt.js";
import { isId, isIsoTimestamp } from "../domain/model-validation.js";
import type {
  AcquireIndexStagingPublicationInput,
  AcquireIndexStagingPublicationResult,
  ClaimIndexStagingCleanupInput,
  IndexStagingAttempt,
  IndexStagingAttemptKey,
  IndexStagingAttemptState,
  IndexStagingAttemptStore,
  IndexStagingLeaseInput,
  RenewIndexStagingCleanupInput,
  RenewIndexStagingPublicationInput,
} from "../ports/index-staging-attempt.js";
import {
  IndexStagingAttemptStoreConflict,
  IndexStagingAttemptStoreUnavailable,
} from "../ports/index-staging-attempt.js";
import { inIngestionTransaction } from "./sqlite-ingestion-database.js";

interface IndexStagingAttemptRow {
  readonly document_index_id: string;
  readonly index_version: string;
  readonly connector_id: string;
  readonly access_handle: string;
  readonly first_attempted_at: string;
  readonly last_attempted_at: string;
  readonly state: string;
  readonly owner_lease_id: string | null;
  readonly owner_expires_at: string | null;
}

export class SqliteIndexStagingAttemptStore
  implements IndexStagingAttemptStore
{
  constructor(private readonly database: DatabaseSync) {}

  async acquirePublication(
    input: AcquireIndexStagingPublicationInput,
  ): Promise<AcquireIndexStagingPublicationResult> {
    assertAcquireInput(input);
    try {
      return inIngestionTransaction(this.database, () => {
        const existing = this.#findRow(input);
        if (
          existing !== undefined &&
          (existing.connector_id !== input.connectorId ||
            existing.access_handle !== input.accessHandle)
        ) {
          throw new IndexStagingAttemptStoreConflict();
        }
        if (
          existing !== undefined &&
          existing.state !== "pending" &&
          (existing.state !== "publishing" ||
            existing.owner_lease_id !== input.leaseId) &&
          existing.owner_expires_at !== null &&
          existing.owner_expires_at > input.attemptedAt
        ) {
          return { status: "busy", attempt: parseRow(existing) };
        }
        this.database
          .prepare(
            `INSERT INTO index_staging_attempts (
               document_index_id, index_version, connector_id, access_handle,
               first_attempted_at, last_attempted_at, state,
               owner_lease_id, owner_expires_at
             ) VALUES (?, ?, ?, ?, ?, ?, 'publishing', ?, ?)
             ON CONFLICT (document_index_id, index_version) DO UPDATE SET
               last_attempted_at = excluded.last_attempted_at,
               state = 'publishing',
               owner_lease_id = excluded.owner_lease_id,
               owner_expires_at = excluded.owner_expires_at`,
          )
          .run(
            input.documentIndexId,
            input.indexVersion,
            input.connectorId,
            input.accessHandle,
            input.attemptedAt,
            input.attemptedAt,
            input.leaseId,
            input.leaseExpiresAt,
          );
        const stored = this.#findRow(input);
        if (stored === undefined) {
          throw new IndexStagingAttemptStoreConflict();
        }
        return { status: "acquired", attempt: parseRow(stored) };
      });
    } catch (error) {
      throw mapStoreError(error);
    }
  }

  async renewPublication(
    input: RenewIndexStagingPublicationInput,
  ): Promise<boolean> {
    assertLeaseInput(input);
    if (
      !isIsoTimestamp(input.renewedAt) ||
      !isIsoTimestamp(input.leaseExpiresAt) ||
      Date.parse(input.leaseExpiresAt) <= Date.parse(input.renewedAt)
    ) {
      throw new IndexStagingAttemptStoreConflict();
    }
    return this.#transition(
      `UPDATE index_staging_attempts
       SET last_attempted_at = ?, owner_expires_at = ?
       WHERE document_index_id = ? AND index_version = ?
         AND state = 'publishing' AND owner_lease_id = ?`,
      [
        input.renewedAt,
        input.leaseExpiresAt,
        input.documentIndexId,
        input.indexVersion,
        input.leaseId,
      ],
    );
  }

  async abandonPublication(input: IndexStagingLeaseInput): Promise<boolean> {
    assertLeaseInput(input);
    return this.#release(input, "publishing");
  }

  async forgetReferenced(input: IndexStagingAttemptKey): Promise<void> {
    assertValidIndexStagingAttemptKey(input);
    try {
      this.database
        .prepare(
          `DELETE FROM index_staging_attempts
           WHERE document_index_id = ? AND index_version = ?`,
        )
        .run(input.documentIndexId, input.indexVersion);
    } catch (error) {
      throw mapStoreError(error);
    }
  }

  async claimCleanup(
    input: ClaimIndexStagingCleanupInput,
  ): Promise<readonly IndexStagingAttempt[]> {
    assertClaimInput(input);
    try {
      return inIngestionTransaction(this.database, () => {
        const rows = this.database
          .prepare(
            `SELECT * FROM index_staging_attempts
             WHERE last_attempted_at <= ?
               AND (state = 'pending' OR owner_expires_at <= ?)
             ORDER BY last_attempted_at, document_index_id, index_version
             LIMIT ?`,
          )
          .all(input.eligibleBefore, input.now, input.limit) as unknown as
          IndexStagingAttemptRow[];
        for (const row of rows) {
          this.database
            .prepare(
              `UPDATE index_staging_attempts
               SET state = 'cleaning', owner_lease_id = ?, owner_expires_at = ?
               WHERE document_index_id = ? AND index_version = ?`,
            )
            .run(
              input.leaseId,
              input.leaseExpiresAt,
              row.document_index_id,
              row.index_version,
            );
        }
        return rows.map((row) =>
          parseRow({
            ...row,
            state: "cleaning",
            owner_lease_id: input.leaseId,
            owner_expires_at: input.leaseExpiresAt,
          }),
        );
      });
    } catch (error) {
      throw mapStoreError(error);
    }
  }

  async releaseCleanup(input: IndexStagingLeaseInput): Promise<boolean> {
    assertLeaseInput(input);
    return this.#release(input, "cleaning");
  }

  async renewCleanup(input: RenewIndexStagingCleanupInput): Promise<boolean> {
    assertRenewalInput(input);
    return this.#transition(
      `UPDATE index_staging_attempts
       SET owner_expires_at = ?
       WHERE document_index_id = ? AND index_version = ?
         AND state = 'cleaning' AND owner_lease_id = ?`,
      [
        input.leaseExpiresAt,
        input.documentIndexId,
        input.indexVersion,
        input.leaseId,
      ],
    );
  }

  async completeCleanup(input: IndexStagingLeaseInput): Promise<boolean> {
    assertLeaseInput(input);
    return this.#transition(
      `DELETE FROM index_staging_attempts
       WHERE document_index_id = ? AND index_version = ?
         AND state = 'cleaning' AND owner_lease_id = ?`,
      [input.documentIndexId, input.indexVersion, input.leaseId],
    );
  }

  async countEligible(input: {
    readonly eligibleBefore: string;
    readonly now: string;
  }): Promise<number> {
    assertEligibilityInput(input);
    try {
      const row = this.database
        .prepare(
          `SELECT COUNT(*) AS count FROM index_staging_attempts
           WHERE last_attempted_at <= ?
             AND (state = 'pending' OR owner_expires_at <= ?)`,
        )
        .get(input.eligibleBefore, input.now) as { readonly count: number };
      return row.count;
    } catch (error) {
      throw mapStoreError(error);
    }
  }

  async countTracked(): Promise<number> {
    try {
      const row = this.database
        .prepare("SELECT COUNT(*) AS count FROM index_staging_attempts")
        .get() as { readonly count: number };
      return row.count;
    } catch (error) {
      throw mapStoreError(error);
    }
  }

  async find(
    input: IndexStagingAttemptKey,
  ): Promise<IndexStagingAttempt | undefined> {
    assertValidIndexStagingAttemptKey(input);
    try {
      const row = this.#findRow(input);
      return row === undefined ? undefined : parseRow(row);
    } catch (error) {
      throw mapStoreError(error);
    }
  }

  #findRow(
    input: IndexStagingAttemptKey,
  ): IndexStagingAttemptRow | undefined {
    return this.database
      .prepare(
        `SELECT * FROM index_staging_attempts
         WHERE document_index_id = ? AND index_version = ?`,
      )
      .get(input.documentIndexId, input.indexVersion) as
      | IndexStagingAttemptRow
      | undefined;
  }

  #release(
    input: IndexStagingLeaseInput,
    state: Exclude<IndexStagingAttemptState, "pending">,
  ): Promise<boolean> {
    return this.#transition(
      `UPDATE index_staging_attempts
       SET state = 'pending', owner_lease_id = NULL, owner_expires_at = NULL
       WHERE document_index_id = ? AND index_version = ?
         AND state = ? AND owner_lease_id = ?`,
      [
        input.documentIndexId,
        input.indexVersion,
        state,
        input.leaseId,
      ],
    );
  }

  async #transition(
    sql: string,
    values: readonly SQLInputValue[],
  ): Promise<boolean> {
    try {
      return this.database.prepare(sql).run(...values).changes === 1;
    } catch (error) {
      throw mapStoreError(error);
    }
  }
}

function parseRow(row: IndexStagingAttemptRow): IndexStagingAttempt {
  const ownsLease = row.state !== "pending";
  const attempt: IndexStagingAttempt = {
    documentIndexId: row.document_index_id,
    indexVersion: row.index_version,
    connectorId: row.connector_id,
    accessHandle: row.access_handle,
    firstAttemptedAt: row.first_attempted_at,
    lastAttemptedAt: row.last_attempted_at,
    state: row.state as IndexStagingAttemptState,
    ...(ownsLease && row.owner_lease_id !== null
      ? { ownerLeaseId: row.owner_lease_id }
      : {}),
    ...(ownsLease && row.owner_expires_at !== null
      ? { ownerExpiresAt: row.owner_expires_at }
      : {}),
  };
  try {
    assertValidIndexStagingAttempt(attempt);
  } catch {
    throw new IndexStagingAttemptStoreConflict();
  }
  return attempt;
}

function assertAcquireInput(input: AcquireIndexStagingPublicationInput): void {
  assertValidIndexStagingAttemptKey(input);
  if (
    input.connectorId.trim() === "" ||
    input.accessHandle.trim() === "" ||
    !isIsoTimestamp(input.attemptedAt) ||
    !isId(input.leaseId, "lease") ||
    !isIsoTimestamp(input.leaseExpiresAt) ||
    Date.parse(input.leaseExpiresAt) <= Date.parse(input.attemptedAt)
  ) {
    throw new IndexStagingAttemptStoreConflict();
  }
}

function assertLeaseInput(input: IndexStagingLeaseInput): void {
  assertValidIndexStagingAttemptKey(input);
  if (!isId(input.leaseId, "lease")) {
    throw new IndexStagingAttemptStoreConflict();
  }
}

function assertEligibilityInput(input: {
  readonly eligibleBefore: string;
  readonly now: string;
}): void {
  if (
    !isIsoTimestamp(input.eligibleBefore) ||
    !isIsoTimestamp(input.now) ||
    Date.parse(input.eligibleBefore) > Date.parse(input.now)
  ) {
    throw new IndexStagingAttemptStoreConflict();
  }
}

function assertClaimInput(input: ClaimIndexStagingCleanupInput): void {
  assertEligibilityInput(input);
  if (
    !isId(input.leaseId, "lease") ||
    !isIsoTimestamp(input.leaseExpiresAt) ||
    Date.parse(input.leaseExpiresAt) <= Date.parse(input.now) ||
    !Number.isSafeInteger(input.limit) ||
    input.limit <= 0
  ) {
    throw new IndexStagingAttemptStoreConflict();
  }
}

function assertRenewalInput(input: RenewIndexStagingCleanupInput): void {
  assertLeaseInput(input);
  if (
    !isIsoTimestamp(input.renewedAt) ||
    !isIsoTimestamp(input.leaseExpiresAt) ||
    Date.parse(input.leaseExpiresAt) <= Date.parse(input.renewedAt)
  ) {
    throw new IndexStagingAttemptStoreConflict();
  }
}

function mapStoreError(error: unknown): Error {
  if (
    error instanceof IndexStagingAttemptStoreConflict ||
    error instanceof IndexStagingAttemptStoreUnavailable
  ) {
    return error;
  }
  return new IndexStagingAttemptStoreUnavailable();
}
