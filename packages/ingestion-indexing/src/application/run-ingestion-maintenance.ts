import type {
  FailedIndexStagingCleanup,
  FailedIndexStagingCleanupReport,
} from "./cleanup-failed-index-staging.js";
import type {
  PublicationReadyReconciler,
  PublicationReadyReconciliationItem,
} from "./reconcile-publication-ready.js";
import type {
  SourceObservationRetention,
  SourceObservationRetentionReport,
} from "./retain-source-observations.js";

export interface IngestionMaintenanceDependencies {
  readonly readyReconciler: Pick<PublicationReadyReconciler, "reconcile">;
  readonly stagingCleanup: Pick<FailedIndexStagingCleanup, "execute">;
  readonly observationRetention: Pick<SourceObservationRetention, "execute">;
  readonly clock?: () => string;
}

export type IngestionMaintenanceStep =
  | "publication_ready_reconciliation"
  | "failed_index_staging_cleanup"
  | "source_observation_retention";

export type IngestionMaintenanceStepResult =
  | {
      readonly step: "publication_ready_reconciliation";
      readonly status: "completed";
      readonly report: readonly PublicationReadyReconciliationItem[];
    }
  | {
      readonly step: "failed_index_staging_cleanup";
      readonly status: "completed";
      readonly report: FailedIndexStagingCleanupReport;
    }
  | {
      readonly step: "source_observation_retention";
      readonly status: "completed";
      readonly report: SourceObservationRetentionReport;
    }
  | {
      readonly step: IngestionMaintenanceStep;
      readonly status: "failed";
      readonly diagnosticCode: string;
    };

export interface IngestionMaintenanceReport {
  readonly startedAt: string;
  readonly completedAt: string;
  readonly status: "completed" | "degraded";
  readonly steps: readonly IngestionMaintenanceStepResult[];
}

export interface RunIngestionMaintenanceOptions {
  /**
   * Cancellation is observed before the cycle and between bounded steps.
   * A step already holding a durable lease is allowed to finish its own safe
   * boundary instead of being interrupted halfway through a store mutation.
   */
  readonly signal?: AbortSignal;
}

/**
 * Runs one bounded Ingestion maintenance cycle.
 *
 * Scheduling and repetition belong to the daemon. This application surface
 * owns the order, coalesces overlapping process-local calls and reports each
 * independent step without allowing one store outage to starve the others.
 */
export class IngestionMaintenance {
  readonly #clock: () => string;
  #active: Promise<IngestionMaintenanceReport> | undefined;

  constructor(
    private readonly dependencies: IngestionMaintenanceDependencies,
  ) {
    this.#clock = dependencies.clock ?? (() => new Date().toISOString());
  }

  async runOnce(
    options: RunIngestionMaintenanceOptions = {},
  ): Promise<IngestionMaintenanceReport> {
    options.signal?.throwIfAborted();
    if (this.#active !== undefined) return this.#active;

    const active = this.#run(options.signal);
    this.#active = active;
    try {
      return await active;
    } finally {
      if (this.#active === active) this.#active = undefined;
    }
  }

  async #run(
    signal: AbortSignal | undefined,
  ): Promise<IngestionMaintenanceReport> {
    const startedAt = this.#now();
    const steps: IngestionMaintenanceStepResult[] = [];

    signal?.throwIfAborted();
    steps.push(await this.#reconcilePublicationReady());

    signal?.throwIfAborted();
    steps.push(await this.#cleanupFailedIndexStaging());

    signal?.throwIfAborted();
    steps.push(await this.#retainSourceObservations());

    const completedAt = this.#now();
    if (Date.parse(completedAt) < Date.parse(startedAt)) {
      throw new TypeError("Ingestion maintenance clock moved backwards");
    }
    return {
      startedAt,
      completedAt,
      status: steps.some((step) => step.status === "failed")
        ? "degraded"
        : "completed",
      steps,
    };
  }

  async #reconcilePublicationReady(): Promise<IngestionMaintenanceStepResult> {
    try {
      return {
        step: "publication_ready_reconciliation",
        status: "completed",
        report: await this.dependencies.readyReconciler.reconcile(),
      };
    } catch (error) {
      return failedStep("publication_ready_reconciliation", error);
    }
  }

  async #cleanupFailedIndexStaging(): Promise<IngestionMaintenanceStepResult> {
    try {
      return {
        step: "failed_index_staging_cleanup",
        status: "completed",
        report: await this.dependencies.stagingCleanup.execute(),
      };
    } catch (error) {
      return failedStep("failed_index_staging_cleanup", error);
    }
  }

  async #retainSourceObservations(): Promise<IngestionMaintenanceStepResult> {
    try {
      return {
        step: "source_observation_retention",
        status: "completed",
        report: await this.dependencies.observationRetention.execute(),
      };
    } catch (error) {
      return failedStep("source_observation_retention", error);
    }
  }

  #now(): string {
    const value = this.#clock();
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
      throw new TypeError("Ingestion maintenance clock is invalid");
    }
    return value;
  }
}

function failedStep(
  step: IngestionMaintenanceStep,
  error: unknown,
): IngestionMaintenanceStepResult {
  return {
    step,
    status: "failed",
    diagnosticCode: safeDiagnosticCode(error, `${step}_failed`),
  };
}

function safeDiagnosticCode(error: unknown, fallback: string): string {
  if (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string" &&
    /^[a-z][a-z0-9_]*$/.test(error.code)
  ) {
    return error.code;
  }
  return fallback;
}
