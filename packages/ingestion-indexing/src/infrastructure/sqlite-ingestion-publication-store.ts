import type { DatabaseSync } from "node:sqlite";

import {
  assertIngestionPublicationTransition,
  parseIngestionPublication,
  parsePublicationReady,
  type IngestionPublication,
} from "@contextctl/contracts";

import { expirationAfter } from "../domain/index-staging-attempt.js";
import { isIsoTimestamp } from "../domain/model-validation.js";
import {
  canonicalDigest,
  canonicalJson,
} from "../domain/revision-identity.js";
import type {
  ClaimedPublicationReady,
  ClaimPublicationReadyBatchInput,
  CommitIngestionPublicationResult,
  CompletePublicationReadyDeliveryInput,
  IngestionPublicationStore,
  PreparePublicationRecoveryIntentResult,
  PublicationRecoveryIntent,
  ReschedulePublicationReadyDeliveryInput,
} from "../ports/markdown-publication.js";
import {
  IngestionPublicationCommitIncomplete,
  IngestionPublicationStoreConflict,
  MAX_PUBLICATION_READY_BATCH_SIZE,
} from "../ports/markdown-publication.js";
import { inIngestionTransaction } from "./sqlite-ingestion-database.js";

interface PublicationRow {
  readonly publication_id: string;
  readonly source_id: string;
  readonly previous_publication_id: string | null;
  readonly publication_json: string;
  readonly produced_at: string;
  readonly ready_state: "pending" | "delivering" | "delivered";
  readonly ready_owner_id: string | null;
  readonly ready_owner_expires_at: string | null;
  readonly ready_attempt_count: number;
  readonly ready_next_attempt_at: string;
  readonly ready_last_diagnostic_code: string | null;
  readonly ready_delivered_at: string | null;
}

interface RecoveryIntentRow {
  readonly publication_id: string;
  readonly source_id: string;
  readonly observation_id: string;
  readonly previous_publication_id: string | null;
  readonly publication_json: string;
  readonly produced_at: string;
  readonly fingerprint: string;
  readonly committed: number;
}

export class SqliteIngestionPublicationStore
  implements IngestionPublicationStore
{
  constructor(private readonly database: DatabaseSync) {}

  async prepareRecoveryIntent(
    input: IngestionPublication,
  ): Promise<PreparePublicationRecoveryIntentResult> {
    let publication: IngestionPublication;
    try {
      publication = cloneAndParse(input);
    } catch {
      throw new IngestionPublicationStoreConflict();
    }
    const canonicalPayload = canonicalJson(publication);
    try {
      return inIngestionTransaction(this.database, () => {
        const existing = this.#findIntentRow(publication.publicationId);
        if (existing !== undefined) {
          const intent = parseIntentRow(existing);
          if (intent.canonicalPayload !== canonicalPayload) {
            throw new IngestionPublicationStoreConflict();
          }
          return { status: "already_prepared", intent };
        }
        const pending = this.#findPendingIntentRow(publication.sourceId);
        if (pending !== undefined) {
          throw new IngestionPublicationStoreConflict();
        }
        const previous = this.#latestPublication(publication.sourceId);
        assertTransition(previous, publication);
        this.database
          .prepare(
            `INSERT INTO publication_recovery_intents (
               publication_id, source_id, observation_id,
               previous_publication_id, publication_json, produced_at,
               fingerprint, committed
             ) VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
          )
          .run(
            publication.publicationId,
            publication.sourceId,
            publication.observationId,
            publication.previousPublicationId ?? null,
            canonicalPayload,
            publication.producedAt,
            canonicalDigest(publication),
          );
        return {
          status: "prepared",
          intent: {
            publication: structuredClone(publication),
            canonicalPayload,
            state: "pending",
          },
        };
      });
    } catch (error) {
      throw mapStoreError(error);
    }
  }

  async findRecoveryIntent(
    publicationId: string,
  ): Promise<PublicationRecoveryIntent | undefined> {
    try {
      const row = this.#findIntentRow(publicationId);
      return row === undefined ? undefined : parseIntentRow(row);
    } catch (error) {
      throw mapStoreError(error);
    }
  }

  async pendingRecoveryIntentForSource(
    sourceId: string,
  ): Promise<PublicationRecoveryIntent | undefined> {
    try {
      const row = this.#findPendingIntentRow(sourceId);
      return row === undefined ? undefined : parseIntentRow(row);
    } catch (error) {
      throw mapStoreError(error);
    }
  }

  async commitReady(
    input: IngestionPublication,
  ): Promise<CommitIngestionPublicationResult> {
    let publication: IngestionPublication;
    try {
      publication = cloneAndParse(input);
    } catch {
      throw new IngestionPublicationStoreConflict();
    }
    try {
      return inIngestionTransaction(this.database, () => {
        const intentRow = this.#findIntentRow(publication.publicationId);
        if (intentRow === undefined) {
          throw new IngestionPublicationCommitIncomplete();
        }
        const intent = parseIntentRow(intentRow);
        if (intent.canonicalPayload !== canonicalJson(publication)) {
          throw new IngestionPublicationStoreConflict();
        }
        const existing = this.#findRow(publication.publicationId);
        if (existing !== undefined) {
          const stored = parseRow(existing);
          if (canonicalJson(stored) !== canonicalJson(publication)) {
            throw new IngestionPublicationStoreConflict();
          }
          this.#markIntentCommitted(publication.publicationId);
          return { status: "already_published", publication: stored };
        }
        const previous = this.#latestPublication(publication.sourceId);
        assertTransition(previous, publication);
        for (const unit of publication.knowledgeUnits) {
          for (const scope of unit.publishedScopes) {
            const definition = canonicalJson(scope);
            const stored = this.database
              .prepare(
                `SELECT scope_json FROM publication_scope_definitions
                 WHERE scope_id = ? AND scope_version = ?`,
              )
              .get(scope.scopeId, scope.scopeVersion) as
              | { readonly scope_json: string }
              | undefined;
            if (stored !== undefined && stored.scope_json !== definition) {
              throw new IngestionPublicationStoreConflict();
            }
            if (stored === undefined) {
              this.database
                .prepare(
                  `INSERT INTO publication_scope_definitions (
                     scope_id, scope_version, scope_json
                   ) VALUES (?, ?, ?)`,
                )
                .run(scope.scopeId, scope.scopeVersion, definition);
            }
          }
        }
        this.database
          .prepare(
            `INSERT INTO ingestion_publications (
               publication_id, source_id, previous_publication_id,
               publication_json, produced_at, ready_state,
               ready_attempt_count, ready_next_attempt_at
             ) VALUES (?, ?, ?, ?, ?, 'pending', 0, ?)`,
          )
          .run(
            publication.publicationId,
            publication.sourceId,
            publication.previousPublicationId ?? null,
            canonicalJson(publication),
            publication.producedAt,
            publication.producedAt,
          );
        this.database
          .prepare(
            `INSERT INTO latest_ingestion_publications (source_id, publication_id)
             VALUES (?, ?)
             ON CONFLICT (source_id) DO UPDATE
               SET publication_id = excluded.publication_id`,
          )
          .run(publication.sourceId, publication.publicationId);
        this.#markIntentCommitted(publication.publicationId);
        return {
          status: "published",
          publication: structuredClone(publication),
        };
      });
    } catch (error) {
      throw mapStoreError(error);
    }
  }

  async find(
    publicationId: string,
  ): Promise<IngestionPublication | undefined> {
    try {
      const row = this.#findRow(publicationId);
      return row === undefined ? undefined : parseRow(row);
    } catch (error) {
      throw mapStoreError(error);
    }
  }

  async latestForSource(
    sourceId: string,
  ): Promise<IngestionPublication | undefined> {
    try {
      const row = this.database
        .prepare(
          `SELECT publications.*
             FROM latest_ingestion_publications latest
             JOIN ingestion_publications publications
               ON publications.publication_id = latest.publication_id
            WHERE latest.source_id = ?`,
        )
        .get(sourceId) as PublicationRow | undefined;
      if (row !== undefined) return parseRow(row);
      const pointer = this.database
        .prepare(
          "SELECT 1 AS present FROM latest_ingestion_publications WHERE source_id = ?",
        )
        .get(sourceId);
      if (pointer !== undefined) throw new IngestionPublicationStoreCorrupt();
      return undefined;
    } catch (error) {
      throw mapStoreError(error);
    }
  }

  async claimReadyBatch(
    input: ClaimPublicationReadyBatchInput,
  ): Promise<readonly ClaimedPublicationReady[]> {
    assertClaimInput(input);
    const ownerExpiresAt = expirationAfter(input.now, input.leaseDurationMs);
    try {
      return inIngestionTransaction(this.database, () => {
        const candidates = this.database
          .prepare(
            `SELECT * FROM ingestion_publications
             WHERE (ready_state = 'pending' AND ready_next_attempt_at <= ?)
                OR (ready_state = 'delivering' AND ready_owner_expires_at <= ?)
             ORDER BY produced_at, publication_id
             LIMIT ?`,
          )
          .all(input.now, input.now, input.limit) as unknown as PublicationRow[];
        const claimed: ClaimedPublicationReady[] = [];
        for (const row of candidates) {
          const publication = parseRow(row);
          const result = this.database
            .prepare(
              `UPDATE ingestion_publications
                  SET ready_state = 'delivering',
                      ready_owner_id = ?,
                      ready_owner_expires_at = ?,
                      ready_attempt_count = ready_attempt_count + 1,
                      ready_last_diagnostic_code = NULL
                WHERE publication_id = ?
                  AND ((ready_state = 'pending' AND ready_next_attempt_at <= ?)
                    OR (ready_state = 'delivering' AND ready_owner_expires_at <= ?))`,
            )
            .run(
              input.ownerId,
              ownerExpiresAt,
              publication.publicationId,
              input.now,
              input.now,
            );
          if (result.changes !== 1) {
            throw new IngestionPublicationStoreConflict();
          }
          const notification = parsePublicationReady({
            schemaVersion: 1,
            publicationId: publication.publicationId,
          });
          claimed.push({
            ...notification,
            ownerId: input.ownerId,
            ownerExpiresAt,
            attemptCount: row.ready_attempt_count + 1,
          });
        }
        return claimed;
      });
    } catch (error) {
      throw mapStoreError(error);
    }
  }

  async completeReadyDelivery(
    input: CompletePublicationReadyDeliveryInput,
  ): Promise<void> {
    if (!isIsoTimestamp(input.deliveredAt) || input.ownerId.trim() === "") {
      throw new IngestionPublicationStoreConflict();
    }
    try {
      const result = this.database
        .prepare(
          `UPDATE ingestion_publications
              SET ready_state = 'delivered',
                  ready_owner_id = NULL,
                  ready_owner_expires_at = NULL,
                  ready_last_diagnostic_code = NULL,
                  ready_delivered_at = ?
            WHERE publication_id = ?
              AND ready_state = 'delivering'
              AND ready_owner_id = ?`,
        )
        .run(input.deliveredAt, input.publicationId, input.ownerId);
      if (result.changes !== 1) {
        throw new IngestionPublicationStoreConflict();
      }
    } catch (error) {
      throw mapStoreError(error);
    }
  }

  async rescheduleReadyDelivery(
    input: ReschedulePublicationReadyDeliveryInput,
  ): Promise<void> {
    if (
      input.ownerId.trim() === "" ||
      !isIsoTimestamp(input.nextAttemptAt) ||
      !isDiagnosticCode(input.diagnosticCode)
    ) {
      throw new IngestionPublicationStoreConflict();
    }
    try {
      const result = this.database
        .prepare(
          `UPDATE ingestion_publications
              SET ready_state = 'pending',
                  ready_owner_id = NULL,
                  ready_owner_expires_at = NULL,
                  ready_next_attempt_at = ?,
                  ready_last_diagnostic_code = ?
            WHERE publication_id = ?
              AND ready_state = 'delivering'
              AND ready_owner_id = ?`,
        )
        .run(
          input.nextAttemptAt,
          input.diagnosticCode,
          input.publicationId,
          input.ownerId,
        );
      if (result.changes !== 1) {
        throw new IngestionPublicationStoreConflict();
      }
    } catch (error) {
      throw mapStoreError(error);
    }
  }

  #findRow(publicationId: string): PublicationRow | undefined {
    return this.database
      .prepare(
        "SELECT * FROM ingestion_publications WHERE publication_id = ?",
      )
      .get(publicationId) as PublicationRow | undefined;
  }

  #findIntentRow(publicationId: string): RecoveryIntentRow | undefined {
    return this.database
      .prepare(
        "SELECT * FROM publication_recovery_intents WHERE publication_id = ?",
      )
      .get(publicationId) as RecoveryIntentRow | undefined;
  }

  #findPendingIntentRow(sourceId: string): RecoveryIntentRow | undefined {
    return this.database
      .prepare(
        `SELECT * FROM publication_recovery_intents
         WHERE source_id = ? AND committed = 0`,
      )
      .get(sourceId) as RecoveryIntentRow | undefined;
  }

  #latestPublication(sourceId: string): IngestionPublication | undefined {
    const latest = this.database
      .prepare(
        `SELECT publications.*
           FROM latest_ingestion_publications latest
           JOIN ingestion_publications publications
             ON publications.publication_id = latest.publication_id
          WHERE latest.source_id = ?`,
      )
      .get(sourceId) as PublicationRow | undefined;
    return latest === undefined ? undefined : parseRow(latest);
  }

  #markIntentCommitted(publicationId: string): void {
    const result = this.database
      .prepare(
        `UPDATE publication_recovery_intents
         SET committed = 1
         WHERE publication_id = ?`,
      )
      .run(publicationId);
    if (result.changes !== 1) {
      throw new IngestionPublicationStoreCorrupt();
    }
  }
}

export class IngestionPublicationStoreUnavailable extends Error {
  readonly code = "publication_store_unavailable";

  constructor() {
    super("Ingestion Publication store is unavailable");
    this.name = "IngestionPublicationStoreUnavailable";
  }
}

export class IngestionPublicationStoreCorrupt extends Error {
  readonly code = "publication_store_corrupt";

  constructor() {
    super("Ingestion Publication store contains corrupt data");
    this.name = "IngestionPublicationStoreCorrupt";
  }
}

function parseRow(row: PublicationRow): IngestionPublication {
  let publication: IngestionPublication;
  try {
    publication = parseIngestionPublication(
      JSON.parse(row.publication_json) as unknown,
    );
  } catch {
    throw new IngestionPublicationStoreCorrupt();
  }
  if (
    publication.publicationId !== row.publication_id ||
    publication.sourceId !== row.source_id ||
    (publication.previousPublicationId ?? null) !==
      row.previous_publication_id ||
    publication.producedAt !== row.produced_at ||
    !isValidReadyState(row)
  ) {
    throw new IngestionPublicationStoreCorrupt();
  }
  return publication;
}

function isValidReadyState(row: PublicationRow): boolean {
  if (
    !Number.isSafeInteger(row.ready_attempt_count) ||
    row.ready_attempt_count < 0 ||
    !isIsoTimestamp(row.ready_next_attempt_at) ||
    (row.ready_last_diagnostic_code !== null &&
      !isDiagnosticCode(row.ready_last_diagnostic_code))
  ) {
    return false;
  }
  if (row.ready_state === "pending") {
    return (
      row.ready_owner_id === null &&
      row.ready_owner_expires_at === null &&
      row.ready_delivered_at === null
    );
  }
  if (row.ready_state === "delivering") {
    return (
      typeof row.ready_owner_id === "string" &&
      row.ready_owner_id.trim() !== "" &&
      typeof row.ready_owner_expires_at === "string" &&
      isIsoTimestamp(row.ready_owner_expires_at) &&
      row.ready_delivered_at === null
    );
  }
  return (
    row.ready_state === "delivered" &&
    row.ready_owner_id === null &&
    row.ready_owner_expires_at === null &&
    typeof row.ready_delivered_at === "string" &&
    isIsoTimestamp(row.ready_delivered_at)
  );
}

function assertClaimInput(input: ClaimPublicationReadyBatchInput): void {
  if (
    input.ownerId.trim() === "" ||
    !isIsoTimestamp(input.now) ||
    !Number.isSafeInteger(input.leaseDurationMs) ||
    input.leaseDurationMs <= 0 ||
    !Number.isSafeInteger(input.limit) ||
    input.limit <= 0 ||
    input.limit > MAX_PUBLICATION_READY_BATCH_SIZE
  ) {
    throw new IngestionPublicationStoreConflict();
  }
}

function isDiagnosticCode(value: string): boolean {
  return /^[a-z][a-z0-9_]*$/.test(value);
}

function parseIntentRow(row: RecoveryIntentRow): PublicationRecoveryIntent {
  let publication: IngestionPublication;
  try {
    publication = parseIngestionPublication(
      JSON.parse(row.publication_json) as unknown,
    );
  } catch {
    throw new IngestionPublicationStoreCorrupt();
  }
  if (
    publication.publicationId !== row.publication_id ||
    publication.sourceId !== row.source_id ||
    publication.observationId !== row.observation_id ||
    (publication.previousPublicationId ?? null) !==
      row.previous_publication_id ||
    publication.producedAt !== row.produced_at ||
    canonicalJson(publication) !== row.publication_json ||
    canonicalDigest(publication) !== row.fingerprint ||
    (row.committed !== 0 && row.committed !== 1)
  ) {
    throw new IngestionPublicationStoreCorrupt();
  }
  return {
    publication,
    canonicalPayload: row.publication_json,
    state: row.committed === 1 ? "committed" : "pending",
  };
}

function cloneAndParse(input: IngestionPublication): IngestionPublication {
  return parseIngestionPublication(
    JSON.parse(JSON.stringify(input)) as unknown,
  );
}

function assertTransition(
  previous: IngestionPublication | undefined,
  publication: IngestionPublication,
): void {
  if (publication.previousPublicationId !== previous?.publicationId) {
    throw new IngestionPublicationStoreConflict();
  }
  try {
    assertIngestionPublicationTransition(previous, publication);
  } catch {
    throw new IngestionPublicationStoreConflict();
  }
}

function mapStoreError(error: unknown): Error {
  if (
    error instanceof IngestionPublicationCommitIncomplete ||
    error instanceof IngestionPublicationStoreConflict ||
    error instanceof IngestionPublicationStoreCorrupt ||
    error instanceof IngestionPublicationStoreUnavailable
  ) {
    return error;
  }
  return new IngestionPublicationStoreUnavailable();
}
