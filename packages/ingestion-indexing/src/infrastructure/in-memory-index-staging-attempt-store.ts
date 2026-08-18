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
  IndexStagingAttemptStore,
  IndexStagingLeaseInput,
  RenewIndexStagingCleanupInput,
  RenewIndexStagingPublicationInput,
} from "../ports/index-staging-attempt.js";
import { IndexStagingAttemptStoreConflict } from "../ports/index-staging-attempt.js";

export class InMemoryIndexStagingAttemptStore
  implements IndexStagingAttemptStore
{
  readonly #attempts = new Map<string, IndexStagingAttempt>();

  async acquirePublication(
    input: AcquireIndexStagingPublicationInput,
  ): Promise<AcquireIndexStagingPublicationResult> {
    assertAcquireInput(input);
    const key = attemptKey(input);
    const existing = this.#attempts.get(key);
    if (
      existing !== undefined &&
      (existing.connectorId !== input.connectorId ||
        existing.accessHandle !== input.accessHandle)
    ) {
      throw new IndexStagingAttemptStoreConflict();
    }
    if (
      existing !== undefined &&
      isActivelyOwned(existing, input.attemptedAt, input.leaseId)
    ) {
      return { status: "busy", attempt: structuredClone(existing) };
    }
    const attempt: IndexStagingAttempt = {
      documentIndexId: input.documentIndexId,
      indexVersion: input.indexVersion,
      connectorId: input.connectorId,
      accessHandle: input.accessHandle,
      firstAttemptedAt: existing?.firstAttemptedAt ?? input.attemptedAt,
      lastAttemptedAt: input.attemptedAt,
      state: "publishing",
      ownerLeaseId: input.leaseId,
      ownerExpiresAt: input.leaseExpiresAt,
    };
    assertValidIndexStagingAttempt(attempt);
    this.#attempts.set(key, attempt);
    return { status: "acquired", attempt: structuredClone(attempt) };
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
    const existing = this.#attempts.get(attemptKey(input));
    if (
      existing?.state !== "publishing" ||
      existing.ownerLeaseId !== input.leaseId
    ) {
      return false;
    }
    this.#attempts.set(attemptKey(input), {
      ...existing,
      lastAttemptedAt: input.renewedAt,
      ownerExpiresAt: input.leaseExpiresAt,
    });
    return true;
  }

  async abandonPublication(input: IndexStagingLeaseInput): Promise<boolean> {
    assertLeaseInput(input);
    return this.#release(input, "publishing");
  }

  async forgetReferenced(input: IndexStagingAttemptKey): Promise<void> {
    assertValidIndexStagingAttemptKey(input);
    this.#attempts.delete(attemptKey(input));
  }

  async claimCleanup(
    input: ClaimIndexStagingCleanupInput,
  ): Promise<readonly IndexStagingAttempt[]> {
    assertClaimInput(input);
    const eligible = [...this.#attempts.values()]
      .filter((attempt) => isEligible(attempt, input.eligibleBefore, input.now))
      .sort(compareAttempts)
      .slice(0, input.limit);
    return eligible.map((attempt) => {
      const claimed: IndexStagingAttempt = {
        ...attempt,
        state: "cleaning",
        ownerLeaseId: input.leaseId,
        ownerExpiresAt: input.leaseExpiresAt,
      };
      this.#attempts.set(attemptKey(attempt), claimed);
      return structuredClone(claimed);
    });
  }

  async releaseCleanup(input: IndexStagingLeaseInput): Promise<boolean> {
    assertLeaseInput(input);
    return this.#release(input, "cleaning");
  }

  async renewCleanup(input: RenewIndexStagingCleanupInput): Promise<boolean> {
    assertRenewalInput(input);
    const existing = this.#attempts.get(attemptKey(input));
    if (
      existing?.state !== "cleaning" ||
      existing.ownerLeaseId !== input.leaseId
    ) {
      return false;
    }
    this.#attempts.set(attemptKey(input), {
      ...existing,
      ownerExpiresAt: input.leaseExpiresAt,
    });
    return true;
  }

  async completeCleanup(input: IndexStagingLeaseInput): Promise<boolean> {
    assertLeaseInput(input);
    const key = attemptKey(input);
    const existing = this.#attempts.get(key);
    if (
      existing?.state !== "cleaning" ||
      existing.ownerLeaseId !== input.leaseId
    ) {
      return false;
    }
    this.#attempts.delete(key);
    return true;
  }

  async countEligible(input: {
    readonly eligibleBefore: string;
    readonly now: string;
  }): Promise<number> {
    assertEligibilityInput(input);
    return [...this.#attempts.values()].filter((attempt) =>
      isEligible(attempt, input.eligibleBefore, input.now),
    ).length;
  }

  async countTracked(): Promise<number> {
    return this.#attempts.size;
  }

  async find(
    input: IndexStagingAttemptKey,
  ): Promise<IndexStagingAttempt | undefined> {
    assertValidIndexStagingAttemptKey(input);
    const attempt = this.#attempts.get(attemptKey(input));
    return attempt === undefined ? undefined : structuredClone(attempt);
  }

  #release(
    input: IndexStagingLeaseInput,
    expectedState: "publishing" | "cleaning",
  ): boolean {
    const key = attemptKey(input);
    const existing = this.#attempts.get(key);
    if (
      existing?.state !== expectedState ||
      existing.ownerLeaseId !== input.leaseId
    ) {
      return false;
    }
    const {
      ownerLeaseId: _ownerLeaseId,
      ownerExpiresAt: _ownerExpiresAt,
      ...withoutOwner
    } = existing;
    this.#attempts.set(key, {
      ...withoutOwner,
      state: "pending",
    });
    return true;
  }
}

function isActivelyOwned(
  attempt: IndexStagingAttempt | undefined,
  now: string,
  requestedLeaseId: string,
): boolean {
  return (
    attempt !== undefined &&
    attempt.state !== "pending" &&
    (attempt.state !== "publishing" ||
      attempt.ownerLeaseId !== requestedLeaseId) &&
    Date.parse(attempt.ownerExpiresAt!) > Date.parse(now)
  );
}

function isEligible(
  attempt: IndexStagingAttempt,
  eligibleBefore: string,
  now: string,
): boolean {
  return (
    Date.parse(attempt.lastAttemptedAt) <= Date.parse(eligibleBefore) &&
    (attempt.state === "pending" ||
      Date.parse(attempt.ownerExpiresAt!) <= Date.parse(now))
  );
}

function compareAttempts(left: IndexStagingAttempt, right: IndexStagingAttempt) {
  return (
    left.lastAttemptedAt.localeCompare(right.lastAttemptedAt) ||
    left.documentIndexId.localeCompare(right.documentIndexId) ||
    left.indexVersion.localeCompare(right.indexVersion)
  );
}

function attemptKey(input: IndexStagingAttemptKey): string {
  return `${input.documentIndexId}\u0000${input.indexVersion}`;
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
