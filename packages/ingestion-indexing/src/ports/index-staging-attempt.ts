export type IndexStagingAttemptState =
  | "pending"
  | "publishing"
  | "cleaning";

export interface IndexStagingAttemptKey {
  readonly documentIndexId: string;
  readonly indexVersion: string;
}

/** Durable control-plane record for one vector-only staging version. */
export interface IndexStagingAttempt extends IndexStagingAttemptKey {
  readonly connectorId: string;
  readonly accessHandle: string;
  readonly firstAttemptedAt: string;
  readonly lastAttemptedAt: string;
  readonly state: IndexStagingAttemptState;
  readonly ownerLeaseId?: string;
  readonly ownerExpiresAt?: string;
}

export interface AcquireIndexStagingPublicationInput
  extends IndexStagingAttemptKey {
  readonly connectorId: string;
  readonly accessHandle: string;
  readonly attemptedAt: string;
  readonly leaseId: string;
  readonly leaseExpiresAt: string;
}

export interface IndexStagingLeaseInput extends IndexStagingAttemptKey {
  readonly leaseId: string;
}

export interface RenewIndexStagingPublicationInput
  extends IndexStagingLeaseInput {
  readonly renewedAt: string;
  readonly leaseExpiresAt: string;
}

export interface RenewIndexStagingCleanupInput extends IndexStagingLeaseInput {
  readonly renewedAt: string;
  readonly leaseExpiresAt: string;
}

export interface ClaimIndexStagingCleanupInput {
  readonly eligibleBefore: string;
  readonly now: string;
  readonly leaseId: string;
  readonly leaseExpiresAt: string;
  readonly limit: number;
}

export interface AcquireIndexStagingPublicationResult {
  readonly status: "acquired" | "busy";
  readonly attempt: IndexStagingAttempt;
}

/**
 * Coordinates publishers and the explicit orphan cleanup operation.
 * Production compositions bind the durable SQLite implementation.
 */
export interface IndexStagingAttemptStore {
  acquirePublication(
    input: AcquireIndexStagingPublicationInput,
  ): Promise<AcquireIndexStagingPublicationResult>;
  renewPublication(
    input: RenewIndexStagingPublicationInput,
  ): Promise<boolean>;
  abandonPublication(input: IndexStagingLeaseInput): Promise<boolean>;
  forgetReferenced(input: IndexStagingAttemptKey): Promise<void>;
  claimCleanup(
    input: ClaimIndexStagingCleanupInput,
  ): Promise<readonly IndexStagingAttempt[]>;
  renewCleanup(input: RenewIndexStagingCleanupInput): Promise<boolean>;
  releaseCleanup(input: IndexStagingLeaseInput): Promise<boolean>;
  completeCleanup(input: IndexStagingLeaseInput): Promise<boolean>;
  countEligible(input: {
    readonly eligibleBefore: string;
    readonly now: string;
  }): Promise<number>;
  countTracked(): Promise<number>;
  find(
    input: IndexStagingAttemptKey,
  ): Promise<IndexStagingAttempt | undefined>;
}

export class IndexStagingAttemptStoreConflict extends Error {
  readonly code = "index_staging_attempt_conflict";

  constructor() {
    super("Index staging attempt store rejected an inconsistent transition");
    this.name = "IndexStagingAttemptStoreConflict";
  }
}

export class IndexStagingAttemptStoreUnavailable extends Error {
  readonly code = "index_staging_attempt_store_unavailable";

  constructor() {
    super("Index staging attempt store is unavailable");
    this.name = "IndexStagingAttemptStoreUnavailable";
  }
}
