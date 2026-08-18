import {
  assertValidSourceObservation,
  type SourceObservation,
} from "../domain/source-observation.js";
import { isId, isIsoTimestamp } from "../domain/model-validation.js";
import type {
  CommitSourceObservationInput,
  CommitSourceObservationResult,
  DeleteSourceObservationResult,
  SourceObservationRetentionCandidateInput,
  SourceObservationRetentionLease,
  SourceObservationStore,
} from "../ports/source-observation.js";
import { SourceObservationStoreConflict } from "../ports/source-observation.js";

export class InMemorySourceObservationStore implements SourceObservationStore {
  readonly #observations = new Map<string, SourceObservation>();
  readonly #observationIdByDigest = new Map<string, string>();
  readonly #latestBySource = new Map<string, string>();
  readonly #comparisonBySource = new Map<string, string>();
  readonly #leases = new Map<string, SourceObservationRetentionLease>();

  async commit(
    input: CommitSourceObservationInput,
  ): Promise<CommitSourceObservationResult> {
    assertCommitInput(input);
    input.signal?.throwIfAborted();
    const candidate = structuredClone(input.observation);
    const digestKey = sourceDigestKey(candidate.sourceId, candidate.contentDigest);
    const existingId = this.#observationIdByDigest.get(digestKey);
    const existing =
      existingId === undefined ? undefined : this.#observations.get(existingId);
    if (
      existing !== undefined &&
      (existing.id !== candidate.id ||
        existing.sourceId !== candidate.sourceId ||
        existing.contentDigest !== candidate.contentDigest)
    ) {
      throw new SourceObservationStoreConflict();
    }
    const sameId = this.#observations.get(candidate.id);
    if (
      sameId !== undefined &&
      (sameId.sourceId !== candidate.sourceId ||
        sameId.contentDigest !== candidate.contentDigest)
    ) {
      throw new SourceObservationStoreConflict();
    }
    const stored = existing ?? sameId ?? candidate;
    if (existing === undefined && sameId === undefined) {
      this.#observations.set(stored.id, stored);
      this.#observationIdByDigest.set(digestKey, stored.id);
    }
    this.#latestBySource.set(stored.sourceId, stored.id);
    if (input.retentionLease !== undefined) {
      this.#leases.set(leaseKey(input.retentionLease), {
        ...input.retentionLease,
        observationId: stored.id,
      });
    }
    input.signal?.throwIfAborted();
    return {
      status: existing === undefined && sameId === undefined ? "stored" : "existing",
      observation: structuredClone(stored),
    };
  }

  async find(observationId: string): Promise<SourceObservation | undefined> {
    assertObservationId(observationId);
    const observation = this.#observations.get(observationId);
    return observation === undefined ? undefined : structuredClone(observation);
  }

  async latestForSource(
    sourceId: string,
  ): Promise<SourceObservation | undefined> {
    assertSourceId(sourceId);
    return this.#byPointer(this.#latestBySource.get(sourceId));
  }

  async comparisonForSource(
    sourceId: string,
  ): Promise<SourceObservation | undefined> {
    assertSourceId(sourceId);
    return this.#byPointer(this.#comparisonBySource.get(sourceId));
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
    const observation = this.#observations.get(input.observationId);
    if (
      observation?.sourceId !== input.sourceId ||
      this.#comparisonBySource.get(input.sourceId) !==
        input.expectedObservationId
    ) {
      throw new SourceObservationStoreConflict();
    }
    this.#comparisonBySource.set(input.sourceId, input.observationId);
  }

  async releaseRetentionLease(
    leaseId: string,
    observationId: string,
  ): Promise<boolean> {
    assertLeaseIdentity(leaseId, observationId);
    return this.#leases.delete(`${leaseId}\u0000${observationId}`);
  }

  async findRetentionCandidates(
    input: SourceObservationRetentionCandidateInput,
  ): Promise<readonly SourceObservation[]> {
    assertCandidateInput(input);
    const bySource = new Map<string, SourceObservation[]>();
    for (const observation of this.#observations.values()) {
      const values = bySource.get(observation.sourceId) ?? [];
      values.push(observation);
      bySource.set(observation.sourceId, values);
    }
    return [...bySource.values()]
      .flatMap((values) =>
        values
          .sort(compareNewestFirst)
          .slice(input.retainLatestCount)
          .filter(
            (observation) =>
              Date.parse(observation.capturedAt) <=
                Date.parse(input.capturedBefore) &&
              !this.#isProtected(observation, input.now),
          ),
      )
      .sort(compareOldestFirst)
      .slice(0, input.limit)
      .map((observation) => structuredClone(observation));
  }

  async deleteIfUnprotected(
    observationId: string,
    now: string,
  ): Promise<DeleteSourceObservationResult> {
    assertObservationId(observationId);
    if (!isIsoTimestamp(now)) throw new SourceObservationStoreConflict();
    const observation = this.#observations.get(observationId);
    if (observation === undefined) return "missing";
    if (this.#isProtected(observation, now)) {
      return "protected";
    }
    this.#observations.delete(observationId);
    this.#observationIdByDigest.delete(
      sourceDigestKey(observation.sourceId, observation.contentDigest),
    );
    for (const [key, lease] of this.#leases) {
      if (lease.observationId === observationId) this.#leases.delete(key);
    }
    return "deleted";
  }

  async count(): Promise<number> {
    return this.#observations.size;
  }

  #byPointer(observationId: string | undefined): SourceObservation | undefined {
    if (observationId === undefined) return undefined;
    const observation = this.#observations.get(observationId);
    if (observation === undefined) throw new SourceObservationStoreConflict();
    return structuredClone(observation);
  }

  #isProtected(observation: SourceObservation, now: string): boolean {
    return (
      this.#latestBySource.get(observation.sourceId) === observation.id ||
      this.#comparisonBySource.get(observation.sourceId) === observation.id ||
      [...this.#leases.values()].some(
        (lease) =>
          lease.observationId === observation.id &&
          Date.parse(lease.expiresAt) > Date.parse(now),
      )
    );
  }
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

function sourceDigestKey(sourceId: string, contentDigest: string): string {
  return `${sourceId}\u0000${contentDigest}`;
}

function leaseKey(lease: SourceObservationRetentionLease): string {
  return `${lease.leaseId}\u0000${lease.observationId}`;
}

function compareNewestFirst(left: SourceObservation, right: SourceObservation) {
  return (
    right.capturedAt.localeCompare(left.capturedAt) ||
    right.id.localeCompare(left.id)
  );
}

function compareOldestFirst(left: SourceObservation, right: SourceObservation) {
  return (
    left.capturedAt.localeCompare(right.capturedAt) ||
    left.id.localeCompare(right.id)
  );
}
