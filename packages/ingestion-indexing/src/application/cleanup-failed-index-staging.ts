import { randomUUID } from "node:crypto";

import { expirationAfter } from "../domain/index-staging-attempt.js";
import type {
  IndexPublicationStoreV2 as IndexPublicationStore,
} from "../ports/index-publication-store.js";
import type {
  IndexStagingAttempt,
  IndexStagingAttemptStore,
} from "../ports/index-staging-attempt.js";
import type { VectorIndexConnectorResolver } from "../ports/managed-document-search.js";
import { VectorIndexFault } from "../ports/vector-index.js";

export interface FailedIndexStagingCleanupPolicy {
  readonly gracePeriodMs: number;
  readonly cleanupLeaseMs: number;
  readonly batchSize: number;
}

export const DEFAULT_FAILED_INDEX_STAGING_CLEANUP_POLICY: FailedIndexStagingCleanupPolicy =
  Object.freeze({
    gracePeriodMs: 24 * 60 * 60 * 1_000,
    cleanupLeaseMs: 5 * 60 * 1_000,
    batchSize: 100,
  });

export interface FailedIndexStagingCleanupDependencies {
  readonly attempts: IndexStagingAttemptStore;
  readonly publications: IndexPublicationStore;
  readonly vectorIndexes: VectorIndexConnectorResolver;
  readonly policy?: FailedIndexStagingCleanupPolicy;
  readonly clock?: () => string;
  readonly leaseIds?: () => string;
}

export type FailedIndexStagingCleanupOutcome =
  | "deleted"
  | "failed"
  | "referenced"
  | "retained";

export interface FailedIndexStagingCleanupItem {
  readonly documentIndexId: string;
  readonly indexVersion: string;
  readonly connectorId: string;
  readonly outcome: FailedIndexStagingCleanupOutcome;
  readonly code?: FailedIndexStagingCleanupItemCode;
}

export type FailedIndexStagingCleanupItemCode =
  | "cleanup_lease_lost"
  | "connector_unavailable"
  | "index_version_retained"
  | "publication_check_failed"
  | "staging_delete_failed";

export interface FailedIndexStagingCleanupReport {
  readonly startedAt: string;
  readonly completedAt: string;
  readonly eligibleBefore: string;
  readonly examined: number;
  readonly deleted: number;
  readonly referenced: number;
  readonly retained: number;
  readonly failed: number;
  readonly remainingEligible: number;
  readonly remainingOrphans: number;
  readonly items: readonly FailedIndexStagingCleanupItem[];
}

/** Explicit maintenance operation for vector-only versions never published. */
export class FailedIndexStagingCleanup {
  readonly #dependencies: FailedIndexStagingCleanupDependencies;
  readonly #policy: FailedIndexStagingCleanupPolicy;

  constructor(dependencies: FailedIndexStagingCleanupDependencies) {
    assertValidPolicy(
      dependencies.policy ?? DEFAULT_FAILED_INDEX_STAGING_CLEANUP_POLICY,
    );
    this.#dependencies = dependencies;
    this.#policy =
      dependencies.policy ?? DEFAULT_FAILED_INDEX_STAGING_CLEANUP_POLICY;
  }

  async execute(): Promise<FailedIndexStagingCleanupReport> {
    const startedAt = this.#now();
    const eligibleBefore = new Date(
      Date.parse(startedAt) - this.#policy.gracePeriodMs,
    ).toISOString();
    const leaseId = this.#leaseId();
    const attempts = await this.#dependencies.attempts.claimCleanup({
      eligibleBefore,
      now: startedAt,
      leaseId,
      leaseExpiresAt: expirationAfter(startedAt, this.#policy.cleanupLeaseMs),
      limit: this.#policy.batchSize,
    });
    const items: FailedIndexStagingCleanupItem[] = [];
    for (const attempt of attempts) {
      items.push(await this.#cleanupOne(attempt, leaseId, this.#now()));
    }
    const completedAt = this.#now();
    if (Date.parse(completedAt) < Date.parse(startedAt)) {
      throw new TypeError("failed Index staging cleanup clock moved backwards");
    }
    const remainingEligible = await this.#dependencies.attempts.countEligible({
      eligibleBefore,
      now: completedAt,
    });
    const remainingOrphans = await this.#dependencies.attempts.countTracked();
    return {
      startedAt,
      completedAt,
      eligibleBefore,
      examined: items.length,
      deleted: count(items, "deleted"),
      referenced: count(items, "referenced"),
      retained: count(items, "retained"),
      failed: count(items, "failed"),
      remainingEligible,
      remainingOrphans,
      items,
    };
  }

  async #cleanupOne(
    attempt: IndexStagingAttempt,
    leaseId: string,
    now: string,
  ): Promise<FailedIndexStagingCleanupItem> {
    const key = {
      documentIndexId: attempt.documentIndexId,
      indexVersion: attempt.indexVersion,
    };
    const renewed = await this.#dependencies.attempts.renewCleanup({
      ...key,
      leaseId,
      renewedAt: now,
      leaseExpiresAt: expirationAfter(now, this.#policy.cleanupLeaseMs),
    });
    if (!renewed) {
      return item(attempt, "failed", "cleanup_lease_lost");
    }
    try {
      const publication = await this.#dependencies.publications.findVersion(key);
      if (publication !== undefined) {
        await this.#dependencies.attempts.forgetReferenced(key);
        return item(attempt, "referenced");
      }
    } catch {
      await this.#release(attempt, leaseId);
      return item(attempt, "failed", "publication_check_failed");
    }

    const vectorIndex = this.#dependencies.vectorIndexes.resolve(
      attempt.connectorId,
    );
    if (vectorIndex === undefined) {
      await this.#release(attempt, leaseId);
      return item(attempt, "failed", "connector_unavailable");
    }

    try {
      await vectorIndex.deleteVersion({
        accessHandle: attempt.accessHandle,
        documentIndexId: attempt.documentIndexId,
        indexVersion: attempt.indexVersion,
        now,
      });
    } catch (error) {
      await this.#release(attempt, leaseId);
      if (
        error instanceof VectorIndexFault &&
        error.code === "index_version_retained"
      ) {
        return item(attempt, "retained", "index_version_retained");
      }
      return item(attempt, "failed", "staging_delete_failed");
    }

    const completed = await this.#dependencies.attempts.completeCleanup({
      ...key,
      leaseId,
    });
    return completed
      ? item(attempt, "deleted")
      : item(attempt, "failed", "cleanup_lease_lost");
  }

  async #release(attempt: IndexStagingAttempt, leaseId: string): Promise<void> {
    try {
      await this.#dependencies.attempts.releaseCleanup({
        documentIndexId: attempt.documentIndexId,
        indexVersion: attempt.indexVersion,
        leaseId,
      });
    } catch {
      // The bounded item report remains useful when a cleanup lease expires.
    }
  }

  #now(): string {
    const now = this.#dependencies.clock?.() ?? new Date().toISOString();
    if (
      !Number.isFinite(Date.parse(now)) ||
      new Date(Date.parse(now)).toISOString() !== now
    ) {
      throw new TypeError("failed Index staging cleanup clock is invalid");
    }
    return now;
  }

  #leaseId(): string {
    const leaseId =
      this.#dependencies.leaseIds?.() ??
      `lease_${randomUUID().replaceAll("-", "")}`;
    if (!/^lease_[a-z0-9]+(?:[a-z0-9_-]*[a-z0-9])?$/.test(leaseId)) {
      throw new TypeError("failed Index staging cleanup lease ID is invalid");
    }
    return leaseId;
  }
}

function item(
  attempt: IndexStagingAttempt,
  outcome: FailedIndexStagingCleanupOutcome,
  code?: FailedIndexStagingCleanupItemCode,
): FailedIndexStagingCleanupItem {
  return {
    documentIndexId: attempt.documentIndexId,
    indexVersion: attempt.indexVersion,
    connectorId: attempt.connectorId,
    outcome,
    ...(code === undefined ? {} : { code }),
  };
}

function count(
  items: readonly FailedIndexStagingCleanupItem[],
  outcome: FailedIndexStagingCleanupOutcome,
): number {
  return items.filter((candidate) => candidate.outcome === outcome).length;
}

function assertValidPolicy(policy: FailedIndexStagingCleanupPolicy): void {
  if (
    !Number.isSafeInteger(policy.gracePeriodMs) ||
    policy.gracePeriodMs <= 0 ||
    !Number.isSafeInteger(policy.cleanupLeaseMs) ||
    policy.cleanupLeaseMs <= 0 ||
    !Number.isSafeInteger(policy.batchSize) ||
    policy.batchSize <= 0 ||
    policy.batchSize > 1_000
  ) {
    throw new TypeError("failed Index staging cleanup policy is invalid");
  }
}
