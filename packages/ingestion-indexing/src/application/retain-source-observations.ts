import type { SourceObservationStore } from "../ports/source-observation.js";

export interface SourceObservationRetentionPolicy {
  /** Minimum newest snapshots kept for each Source regardless of age. */
  readonly minimumSnapshotsPerSource: number;
  /** Minimum age before an otherwise unprotected snapshot is eligible. */
  readonly retentionPeriodMs: number;
  readonly batchSize: number;
}

export const DEFAULT_SOURCE_OBSERVATION_RETENTION_POLICY: SourceObservationRetentionPolicy =
  Object.freeze({
    minimumSnapshotsPerSource: 2,
    retentionPeriodMs: 7 * 24 * 60 * 60 * 1_000,
    batchSize: 100,
  });

export interface SourceObservationRetentionDependencies {
  readonly observations: SourceObservationStore;
  readonly policy?: SourceObservationRetentionPolicy;
  readonly clock?: () => string;
}

export interface SourceObservationRetentionItem {
  readonly observationId: string;
  readonly sourceId: string;
  readonly outcome: "deleted" | "missing" | "protected";
}

export interface SourceObservationRetentionReport {
  readonly startedAt: string;
  readonly completedAt: string;
  readonly capturedBefore: string;
  readonly examined: number;
  readonly deleted: number;
  readonly protected: number;
  readonly missing: number;
  readonly remainingSnapshots: number;
  readonly items: readonly SourceObservationRetentionItem[];
}

/** Explicit bounded maintenance operation for unreferenced raw observations. */
export class SourceObservationRetention {
  readonly #dependencies: SourceObservationRetentionDependencies;
  readonly #policy: SourceObservationRetentionPolicy;

  constructor(dependencies: SourceObservationRetentionDependencies) {
    this.#policy =
      dependencies.policy ?? DEFAULT_SOURCE_OBSERVATION_RETENTION_POLICY;
    assertPolicy(this.#policy);
    this.#dependencies = dependencies;
  }

  async execute(): Promise<SourceObservationRetentionReport> {
    const startedAt = this.#now();
    const capturedBefore = new Date(
      Date.parse(startedAt) - this.#policy.retentionPeriodMs,
    ).toISOString();
    const candidates = await this.#dependencies.observations.findRetentionCandidates({
      capturedBefore,
      now: startedAt,
      retainLatestCount: this.#policy.minimumSnapshotsPerSource,
      limit: this.#policy.batchSize,
    });
    const items: SourceObservationRetentionItem[] = [];
    for (const observation of candidates) {
      const outcome = await this.#dependencies.observations.deleteIfUnprotected(
        observation.id,
        this.#now(),
      );
      items.push({
        observationId: observation.id,
        sourceId: observation.sourceId,
        outcome,
      });
    }
    const completedAt = this.#now();
    if (Date.parse(completedAt) < Date.parse(startedAt)) {
      throw new TypeError("Source Observation retention clock moved backwards");
    }
    return {
      startedAt,
      completedAt,
      capturedBefore,
      examined: items.length,
      deleted: count(items, "deleted"),
      protected: count(items, "protected"),
      missing: count(items, "missing"),
      remainingSnapshots: await this.#dependencies.observations.count(),
      items,
    };
  }

  #now(): string {
    const value = this.#dependencies.clock?.() ?? new Date().toISOString();
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
      throw new TypeError("Source Observation retention clock is invalid");
    }
    return value;
  }
}

function assertPolicy(policy: SourceObservationRetentionPolicy): void {
  if (
    !Number.isSafeInteger(policy.minimumSnapshotsPerSource) ||
    policy.minimumSnapshotsPerSource < 1 ||
    !Number.isSafeInteger(policy.retentionPeriodMs) ||
    policy.retentionPeriodMs < 1 ||
    !Number.isSafeInteger(policy.batchSize) ||
    policy.batchSize < 1 ||
    policy.batchSize > 1_000
  ) {
    throw new TypeError("Source Observation retention policy is invalid");
  }
}

function count(
  items: readonly SourceObservationRetentionItem[],
  outcome: SourceObservationRetentionItem["outcome"],
): number {
  return items.filter((item) => item.outcome === outcome).length;
}
