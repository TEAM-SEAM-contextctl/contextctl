import type {
  IngestionMaintenance,
  IngestionMaintenanceReport,
} from "@contextctl/ingestion-indexing";

import {
  LaneCancelledError,
  LaneClosedError,
  type AdmissionLane,
} from "./admission.js";
import type { RuntimeClock } from "./clock.js";

export const INGESTION_MAINTENANCE_WORKER_POLICY_VERSION =
  "ingestion-maintenance-worker-v1";

export interface IngestionMaintenanceWorkerPolicy {
  readonly version: string;
  /** Delay after a fully completed cycle. */
  readonly intervalMs: number;
  /** Shorter delay after a degraded or failed cycle. */
  readonly retryIntervalMs: number;
}

export const DEFAULT_INGESTION_MAINTENANCE_WORKER_POLICY: IngestionMaintenanceWorkerPolicy =
  Object.freeze({
    version: INGESTION_MAINTENANCE_WORKER_POLICY_VERSION,
    intervalMs: 30_000,
    retryIntervalMs: 5_000,
  });

export type IngestionMaintenanceWorkerPhase =
  | "idle"
  | "scheduled"
  | "running"
  | "stopping"
  | "stopped";

export type IngestionMaintenanceWorkerOutcome =
  | "completed"
  | "degraded"
  | "failed"
  | "cancelled";

export interface IngestionMaintenanceWorkerStatus {
  readonly phase: IngestionMaintenanceWorkerPhase;
  readonly policyVersion: string;
  readonly cycles: number;
  readonly degradedCycles: number;
  readonly failedCycles: number;
  readonly lastOutcome?: IngestionMaintenanceWorkerOutcome;
  readonly lastDiagnosticCode?: string;
  readonly lastStartedAt?: number;
  readonly lastCompletedAt?: number;
  readonly nextRunAt?: number;
}

export interface IngestionMaintenanceWorkerOptions {
  readonly maintenance: Pick<IngestionMaintenance, "runOnce">;
  readonly lane: AdmissionLane;
  readonly clock: RuntimeClock;
  readonly policy?: IngestionMaintenanceWorkerPolicy;
}

/**
 * Owns only the process lifecycle of Ingestion's bounded maintenance cycle.
 *
 * The cycle's order, leases, batch sizes and retention rules remain inside
 * Ingestion. This worker starts it immediately after daemon startup, schedules
 * the next run only after the previous one settled, and stops scheduling as
 * soon as daemon draining begins. There is no `setInterval`: a slow store must
 * not turn elapsed time into an unbounded in-memory backlog.
 */
export class IngestionMaintenanceWorker {
  readonly #maintenance: Pick<IngestionMaintenance, "runOnce">;
  readonly #lane: AdmissionLane;
  readonly #clock: RuntimeClock;
  readonly #policy: IngestionMaintenanceWorkerPolicy;
  readonly #controller = new AbortController();
  #phase: IngestionMaintenanceWorkerPhase = "idle";
  #cancelTimer: (() => void) | undefined;
  #active: Promise<void> | undefined;
  #cycles = 0;
  #degradedCycles = 0;
  #failedCycles = 0;
  #lastOutcome: IngestionMaintenanceWorkerOutcome | undefined;
  #lastDiagnosticCode: string | undefined;
  #lastStartedAt: number | undefined;
  #lastCompletedAt: number | undefined;
  #nextRunAt: number | undefined;

  constructor(options: IngestionMaintenanceWorkerOptions) {
    this.#maintenance = options.maintenance;
    this.#lane = options.lane;
    this.#clock = options.clock;
    this.#policy = Object.freeze({
      ...(options.policy ?? DEFAULT_INGESTION_MAINTENANCE_WORKER_POLICY),
    });
    assertIngestionMaintenanceWorkerPolicy(this.#policy);
    this.#now();
  }

  get status(): IngestionMaintenanceWorkerStatus {
    return {
      phase: this.#phase,
      policyVersion: this.#policy.version,
      cycles: this.#cycles,
      degradedCycles: this.#degradedCycles,
      failedCycles: this.#failedCycles,
      ...(this.#lastOutcome === undefined
        ? {}
        : { lastOutcome: this.#lastOutcome }),
      ...(this.#lastDiagnosticCode === undefined
        ? {}
        : { lastDiagnosticCode: this.#lastDiagnosticCode }),
      ...(this.#lastStartedAt === undefined
        ? {}
        : { lastStartedAt: this.#lastStartedAt }),
      ...(this.#lastCompletedAt === undefined
        ? {}
        : { lastCompletedAt: this.#lastCompletedAt }),
      ...(this.#nextRunAt === undefined
        ? {}
        : { nextRunAt: this.#nextRunAt }),
    };
  }

  /** Starts once. The first cycle is scheduled for the current turn. */
  start(): void {
    if (this.#phase === "scheduled" || this.#phase === "running") return;
    if (this.#phase === "stopping" || this.#phase === "stopped") {
      throw new IngestionMaintenanceWorkerClosedError();
    }
    this.#schedule(0);
  }

  /** Synchronously prevents timers or queued lane work from starting. */
  beginDraining(): void {
    if (this.#phase === "stopping" || this.#phase === "stopped") return;
    this.#cancelTimer?.();
    this.#cancelTimer = undefined;
    this.#nextRunAt = undefined;
    this.#phase = "stopping";
    this.#controller.abort(new IngestionMaintenanceWorkerClosedError());
  }

  /** Stops once and waits for the currently admitted safe cycle boundary. */
  async stop(): Promise<void> {
    if (this.#phase === "stopped") return;
    this.beginDraining();
    await this.#active;
    this.#phase = "stopped";
  }

  #schedule(delayMs: number): void {
    if (this.#controller.signal.aborted) return;
    const now = this.#now();
    this.#phase = "scheduled";
    this.#nextRunAt = now + delayMs;
    this.#cancelTimer = this.#clock.schedule(delayMs, () => {
      this.#cancelTimer = undefined;
      this.#nextRunAt = undefined;
      if (this.#controller.signal.aborted) return;
      const active = this.#runCycle();
      this.#active = active;
      void active.finally(() => {
        if (this.#active === active) this.#active = undefined;
      });
    });
  }

  async #runCycle(): Promise<void> {
    this.#phase = "running";
    this.#lastStartedAt = this.#now();
    this.#lastDiagnosticCode = undefined;
    let retry = false;
    try {
      const report = await this.#lane.run(
        async (signal) => await this.#maintenance.runOnce({ signal }),
        { signal: this.#controller.signal },
      );
      this.#recordReport(report);
      retry = report.status === "degraded";
    } catch (error: unknown) {
      if (
        this.#controller.signal.aborted ||
        error instanceof LaneCancelledError ||
        error instanceof LaneClosedError
      ) {
        this.#lastOutcome = "cancelled";
      } else {
        this.#failedCycles += 1;
        this.#lastOutcome = "failed";
        this.#lastDiagnosticCode = safeDiagnosticCode(
          error,
          "ingestion_maintenance_cycle_failed",
        );
        retry = true;
      }
    } finally {
      this.#cycles += 1;
      this.#lastCompletedAt = this.#now();
    }

    if (!this.#controller.signal.aborted) {
      this.#schedule(
        retry ? this.#policy.retryIntervalMs : this.#policy.intervalMs,
      );
    }
  }

  #recordReport(report: IngestionMaintenanceReport): void {
    this.#lastOutcome = report.status;
    if (report.status === "degraded") {
      this.#degradedCycles += 1;
      const failure = report.steps.find((step) => step.status === "failed");
      this.#lastDiagnosticCode = failure?.diagnosticCode;
    }
  }

  #now(): number {
    const value = this.#clock.now();
    if (!Number.isFinite(value) || value < 0) {
      throw new TypeError("Ingestion maintenance worker clock is invalid");
    }
    return value;
  }
}

export class IngestionMaintenanceWorkerClosedError extends Error {
  readonly code = "ingestion_maintenance_worker_closed";

  constructor() {
    super("Ingestion maintenance worker is closed");
    this.name = "IngestionMaintenanceWorkerClosedError";
  }
}

export function assertIngestionMaintenanceWorkerPolicy(
  policy: IngestionMaintenanceWorkerPolicy,
): void {
  if (
    policy.version.trim() === "" ||
    !Number.isSafeInteger(policy.intervalMs) ||
    policy.intervalMs <= 0 ||
    !Number.isSafeInteger(policy.retryIntervalMs) ||
    policy.retryIntervalMs <= 0 ||
    policy.retryIntervalMs > policy.intervalMs
  ) {
    throw new TypeError("Ingestion maintenance worker policy is invalid");
  }
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
