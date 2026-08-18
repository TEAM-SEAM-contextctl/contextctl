import type { DatabaseSync } from "node:sqlite";

import {
  assertValidSourceObservation,
  type SourceObservation,
} from "../domain/source-observation.js";
import { isId, isIsoTimestamp } from "../domain/model-validation.js";
import {
  canonicalDigest,
  canonicalJson,
} from "../domain/revision-identity.js";
import type {
  CommitSourceObservationInput,
  CommitSourceObservationResult,
  DeleteSourceObservationResult,
  SourceObservationRetentionCandidateInput,
  SourceObservationStore,
} from "../ports/source-observation.js";
import {
  SourceObservationStoreConflict,
  SourceObservationStoreUnavailable,
} from "../ports/source-observation.js";
import { inIngestionTransaction } from "./sqlite-ingestion-database.js";

interface ObservationRow {
  readonly observation_id: string;
  readonly source_id: string;
  readonly content_digest: string;
  readonly captured_at: string;
  readonly observation_json: string;
  readonly fingerprint: string;
}

export class SqliteSourceObservationStore implements SourceObservationStore {
  constructor(private readonly database: DatabaseSync) {}

  async commit(
    input: CommitSourceObservationInput,
  ): Promise<CommitSourceObservationResult> {
    assertCommitInput(input);
    input.signal?.throwIfAborted();
    try {
      return inIngestionTransaction(this.database, () => {
        input.signal?.throwIfAborted();
        const candidate = structuredClone(input.observation);
        const existing = this.database
          .prepare(
            `SELECT * FROM source_observations
             WHERE source_id = ? AND content_digest = ?`,
          )
          .get(candidate.sourceId, candidate.contentDigest) as
          | ObservationRow
          | undefined;
        const stored = existing === undefined ? candidate : parseRow(existing);
        if (
          stored.id !== candidate.id ||
          stored.sourceId !== candidate.sourceId ||
          stored.contentDigest !== candidate.contentDigest
        ) {
          throw new SourceObservationStoreConflict();
        }
        if (existing === undefined) {
          this.database
            .prepare(
              `INSERT INTO source_observations (
                 observation_id, source_id, content_digest, captured_at,
                 observation_json, fingerprint
               ) VALUES (?, ?, ?, ?, ?, ?)`,
            )
            .run(
              candidate.id,
              candidate.sourceId,
              candidate.contentDigest,
              candidate.capturedAt,
              canonicalJson(candidate),
              observationFingerprint(candidate),
            );
        }
        this.database
          .prepare(
            `INSERT INTO latest_source_observations (source_id, observation_id)
             VALUES (?, ?)
             ON CONFLICT(source_id) DO UPDATE
             SET observation_id = excluded.observation_id`,
          )
          .run(stored.sourceId, stored.id);
        if (input.retentionLease !== undefined) {
          this.database
            .prepare(
              `INSERT INTO source_observation_retention_leases (
                 lease_id, observation_id, acquired_at, expires_at
               ) VALUES (?, ?, ?, ?)
               ON CONFLICT(lease_id, observation_id) DO UPDATE SET
                 acquired_at = excluded.acquired_at,
                 expires_at = excluded.expires_at`,
            )
            .run(
              input.retentionLease.leaseId,
              stored.id,
              input.retentionLease.acquiredAt,
              input.retentionLease.expiresAt,
            );
        }
        input.signal?.throwIfAborted();
        return {
          status: existing === undefined ? "stored" : "existing",
          observation: structuredClone(stored),
        };
      });
    } catch (error) {
      throw mapStoreError(error);
    }
  }

  async find(observationId: string): Promise<SourceObservation | undefined> {
    assertObservationId(observationId);
    try {
      const row = this.database
        .prepare(
          "SELECT * FROM source_observations WHERE observation_id = ?",
        )
        .get(observationId) as ObservationRow | undefined;
      return row === undefined ? undefined : parseRow(row);
    } catch (error) {
      throw mapStoreError(error);
    }
  }

  async latestForSource(
    sourceId: string,
  ): Promise<SourceObservation | undefined> {
    return this.#findPointer("latest_source_observations", sourceId);
  }

  async comparisonForSource(
    sourceId: string,
  ): Promise<SourceObservation | undefined> {
    return this.#findPointer("comparison_source_observations", sourceId);
  }

  async markComparisonBaseline(input: {
    readonly sourceId: string;
    readonly observationId: string;
    readonly expectedObservationId?: string;
  }): Promise<void> {
    assertSourceId(input.sourceId);
    assertObservationId(input.observationId);
    if (input.expectedObservationId !== undefined) {
      assertObservationId(input.expectedObservationId);
    }
    try {
      inIngestionTransaction(this.database, () => {
        const observation = this.database
          .prepare(
            `SELECT source_id FROM source_observations
             WHERE observation_id = ?`,
          )
          .get(input.observationId) as
          | { readonly source_id: string }
          | undefined;
        const current = this.database
          .prepare(
            `SELECT observation_id FROM comparison_source_observations
             WHERE source_id = ?`,
          )
          .get(input.sourceId) as
          | { readonly observation_id: string }
          | undefined;
        if (
          observation?.source_id !== input.sourceId ||
          current?.observation_id !== input.expectedObservationId
        ) {
          throw new SourceObservationStoreConflict();
        }
        this.database
          .prepare(
            `INSERT INTO comparison_source_observations (
               source_id, observation_id
             ) VALUES (?, ?)
             ON CONFLICT(source_id) DO UPDATE
             SET observation_id = excluded.observation_id`,
          )
          .run(input.sourceId, input.observationId);
      });
    } catch (error) {
      throw mapStoreError(error);
    }
  }

  async releaseRetentionLease(
    leaseId: string,
    observationId: string,
  ): Promise<boolean> {
    assertLeaseIdentity(leaseId, observationId);
    try {
      const result = this.database
        .prepare(
          `DELETE FROM source_observation_retention_leases
           WHERE lease_id = ? AND observation_id = ?`,
        )
        .run(leaseId, observationId);
      return result.changes === 1;
    } catch (error) {
      throw mapStoreError(error);
    }
  }

  async findRetentionCandidates(
    input: SourceObservationRetentionCandidateInput,
  ): Promise<readonly SourceObservation[]> {
    assertCandidateInput(input);
    try {
      const rows = this.database
        .prepare(
          `WITH ranked AS (
             SELECT source_observations.*,
                    ROW_NUMBER() OVER (
                      PARTITION BY source_id
                      ORDER BY captured_at DESC, observation_id DESC
                    ) AS recency_rank
             FROM source_observations
           )
           SELECT observation_id, source_id, content_digest, captured_at,
                  observation_json, fingerprint
           FROM ranked
           WHERE recency_rank > ? AND captured_at <= ?
             AND NOT EXISTS (
               SELECT 1 FROM latest_source_observations AS latest
               WHERE latest.observation_id = ranked.observation_id
             )
             AND NOT EXISTS (
               SELECT 1 FROM comparison_source_observations AS comparison
               WHERE comparison.observation_id = ranked.observation_id
             )
             AND NOT EXISTS (
               SELECT 1 FROM source_observation_retention_leases AS lease
               WHERE lease.observation_id = ranked.observation_id
                 AND lease.expires_at > ?
             )
             AND NOT EXISTS (
               SELECT 1 FROM publication_recovery_intents AS intent
               WHERE intent.observation_id = ranked.observation_id
                 AND (
                   intent.committed = 0 OR EXISTS (
                     SELECT 1 FROM latest_ingestion_publications AS latest
                     WHERE latest.publication_id = intent.publication_id
                   )
                 )
             )
           ORDER BY captured_at, observation_id
           LIMIT ?`,
        )
        .all(
          input.retainLatestCount,
          input.capturedBefore,
          input.now,
          input.limit,
        ) as unknown as ObservationRow[];
      return rows.map(parseRow);
    } catch (error) {
      throw mapStoreError(error);
    }
  }

  async deleteIfUnprotected(
    observationId: string,
    now: string,
  ): Promise<DeleteSourceObservationResult> {
    assertObservationId(observationId);
    if (!isIsoTimestamp(now)) throw new SourceObservationStoreConflict();
    try {
      return inIngestionTransaction(this.database, () => {
        const found = this.database
          .prepare(
            `SELECT 1 AS present FROM source_observations
             WHERE observation_id = ?`,
          )
          .get(observationId);
        if (found === undefined) return "missing";
        const protectedReference = this.database
          .prepare(
            `SELECT 1 AS protected
             WHERE EXISTS (
               SELECT 1 FROM latest_source_observations
               WHERE observation_id = ?
             ) OR EXISTS (
               SELECT 1 FROM comparison_source_observations
               WHERE observation_id = ?
             ) OR EXISTS (
               SELECT 1 FROM source_observation_retention_leases
               WHERE observation_id = ? AND expires_at > ?
             ) OR EXISTS (
               SELECT 1 FROM publication_recovery_intents AS intent
               WHERE intent.observation_id = ?
                 AND (
                   intent.committed = 0 OR EXISTS (
                     SELECT 1 FROM latest_ingestion_publications AS latest
                     WHERE latest.publication_id = intent.publication_id
                   )
                 )
             )`,
          )
          .get(
            observationId,
            observationId,
            observationId,
            now,
            observationId,
          );
        if (protectedReference !== undefined) return "protected";
        this.database
          .prepare(
            `DELETE FROM source_observation_retention_leases
             WHERE observation_id = ? AND expires_at <= ?`,
          )
          .run(observationId, now);
        const result = this.database
          .prepare(
            "DELETE FROM source_observations WHERE observation_id = ?",
          )
          .run(observationId);
        return result.changes === 1 ? "deleted" : "missing";
      });
    } catch (error) {
      throw mapStoreError(error);
    }
  }

  async count(): Promise<number> {
    try {
      const row = this.database
        .prepare("SELECT COUNT(*) AS count FROM source_observations")
        .get() as { readonly count?: unknown } | undefined;
      if (!Number.isSafeInteger(row?.count)) {
        throw new SourceObservationStoreConflict();
      }
      return row!.count as number;
    } catch (error) {
      throw mapStoreError(error);
    }
  }

  async #findPointer(
    table: "comparison_source_observations" | "latest_source_observations",
    sourceId: string,
  ): Promise<SourceObservation | undefined> {
    assertSourceId(sourceId);
    try {
      const row = this.database
        .prepare(
          `SELECT o.* FROM ${table} AS p
           JOIN source_observations AS o
             ON o.observation_id = p.observation_id
           WHERE p.source_id = ?`,
        )
        .get(sourceId) as ObservationRow | undefined;
      return row === undefined ? undefined : parseRow(row);
    } catch (error) {
      throw mapStoreError(error);
    }
  }
}

function parseRow(row: ObservationRow): SourceObservation {
  let observation: SourceObservation;
  try {
    observation = JSON.parse(row.observation_json) as SourceObservation;
    assertValidSourceObservation(observation);
  } catch {
    throw new SourceObservationStoreConflict();
  }
  if (
    observation.id !== row.observation_id ||
    observation.sourceId !== row.source_id ||
    observation.contentDigest !== row.content_digest ||
    observation.capturedAt !== row.captured_at ||
    canonicalJson(observation) !== row.observation_json ||
    observationFingerprint(observation) !== row.fingerprint
  ) {
    throw new SourceObservationStoreConflict();
  }
  return structuredClone(observation);
}

function observationFingerprint(observation: SourceObservation): string {
  return canonicalDigest(observation);
}

function assertCommitInput(input: CommitSourceObservationInput): void {
  try {
    assertValidSourceObservation(input.observation);
    if (input.retentionLease !== undefined) {
      const lease = input.retentionLease;
      if (
        lease.observationId !== input.observation.id ||
        !isId(lease.leaseId, "lease") ||
        !isIsoTimestamp(lease.acquiredAt) ||
        !isIsoTimestamp(lease.expiresAt) ||
        Date.parse(lease.expiresAt) <= Date.parse(lease.acquiredAt)
      ) {
        throw new SourceObservationStoreConflict();
      }
    }
  } catch (error) {
    if (error instanceof SourceObservationStoreConflict) throw error;
    throw new SourceObservationStoreConflict();
  }
}

function assertCandidateInput(
  input: SourceObservationRetentionCandidateInput,
): void {
  if (
    !isIsoTimestamp(input.capturedBefore) ||
    !isIsoTimestamp(input.now) ||
    Date.parse(input.capturedBefore) > Date.parse(input.now) ||
    !Number.isSafeInteger(input.retainLatestCount) ||
    input.retainLatestCount < 1 ||
    !Number.isSafeInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > 1_000
  ) {
    throw new SourceObservationStoreConflict();
  }
}

function assertLeaseIdentity(leaseId: string, observationId: string): void {
  if (!isId(leaseId, "lease") || !isId(observationId, "obs")) {
    throw new SourceObservationStoreConflict();
  }
}

function assertObservationId(value: string): void {
  if (!isId(value, "obs")) throw new SourceObservationStoreConflict();
}

function assertSourceId(value: string): void {
  if (!isId(value, "src")) throw new SourceObservationStoreConflict();
}

function mapStoreError(error: unknown): Error {
  if (
    error instanceof SourceObservationStoreConflict ||
    error instanceof SourceObservationStoreUnavailable
  ) {
    return error;
  }
  return new SourceObservationStoreUnavailable();
}
