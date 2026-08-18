import type { SourceObservation } from "../domain/source-observation.js";

export interface SourceObservationRetentionLease {
  readonly leaseId: string;
  readonly observationId: string;
  readonly acquiredAt: string;
  readonly expiresAt: string;
}

export interface CommitSourceObservationInput {
  readonly observation: SourceObservation;
  readonly retentionLease?: SourceObservationRetentionLease;
  readonly signal?: AbortSignal;
}

export interface CommitSourceObservationResult {
  readonly status: "existing" | "stored";
  readonly observation: SourceObservation;
}

export interface SourceObservationRetentionCandidateInput {
  readonly capturedBefore: string;
  readonly now: string;
  readonly retainLatestCount: number;
  readonly limit: number;
}

export type DeleteSourceObservationResult =
  | "deleted"
  | "missing"
  | "protected";

export interface SourceObservationStore {
  commit(
    input: CommitSourceObservationInput,
  ): Promise<CommitSourceObservationResult>;
  find(observationId: string): Promise<SourceObservation | undefined>;
  latestForSource(sourceId: string): Promise<SourceObservation | undefined>;
  comparisonForSource(
    sourceId: string,
  ): Promise<SourceObservation | undefined>;
  markComparisonBaseline(input: {
    readonly sourceId: string;
    readonly observationId: string;
    readonly expectedObservationId?: string;
  }): Promise<void>;
  releaseRetentionLease(leaseId: string, observationId: string): Promise<boolean>;
  findRetentionCandidates(
    input: SourceObservationRetentionCandidateInput,
  ): Promise<readonly SourceObservation[]>;
  deleteIfUnprotected(
    observationId: string,
    now: string,
  ): Promise<DeleteSourceObservationResult>;
  count(): Promise<number>;
}

export class SourceObservationStoreConflict extends Error {
  readonly code = "observation_store_conflict";

  constructor() {
    super("Source Observation store rejected conflicting immutable content");
    this.name = "SourceObservationStoreConflict";
  }
}

export class SourceObservationStoreUnavailable extends Error {
  readonly code = "observation_store_unavailable";

  constructor() {
    super("Source Observation store is unavailable");
    this.name = "SourceObservationStoreUnavailable";
  }
}
