import { describe, expect, it } from "vitest";

import type { IngestionMaintenanceReport } from "@contextctl/ingestion-indexing";

import { AdmissionLane } from "../../src/runtime/admission.js";
import { ManualRuntimeClock } from "../../src/runtime/clock.js";
import {
  IngestionMaintenanceWorker,
  IngestionMaintenanceWorkerClosedError,
} from "../../src/runtime/ingestion-maintenance-worker.js";
import { DaemonLifecycle } from "../../src/runtime/lifecycle.js";

const POLICY = {
  version: "maintenance-test-v1",
  intervalMs: 1_000,
  retryIntervalMs: 100,
} as const;

function completedReport(
  status: "completed" | "degraded" = "completed",
): IngestionMaintenanceReport {
  return {
    startedAt: "2026-08-23T00:00:00.000Z",
    completedAt: "2026-08-23T00:00:01.000Z",
    status,
    steps:
      status === "completed"
        ? []
        : [
            {
              step: "publication_ready_reconciliation",
              status: "failed",
              diagnosticCode: "registry_unavailable",
            },
          ],
  };
}

function lane(): AdmissionLane {
  return new AdmissionLane("ingestion", { concurrency: 1, queueDepth: 1 });
}

async function flush(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

describe("IngestionMaintenanceWorker", () => {
  it("runs immediately and schedules the next cycle after completion", async () => {
    const clock = new ManualRuntimeClock();
    let calls = 0;
    const worker = new IngestionMaintenanceWorker({
      maintenance: {
        runOnce: async () => {
          calls += 1;
          return completedReport();
        },
      },
      lane: lane(),
      clock,
      policy: POLICY,
    });

    worker.start();
    expect(worker.status).toMatchObject({ phase: "scheduled", nextRunAt: 0 });
    clock.advance(0);
    await flush();

    expect(calls).toBe(1);
    expect(worker.status).toMatchObject({
      phase: "scheduled",
      cycles: 1,
      lastOutcome: "completed",
      nextRunAt: 1_000,
    });

    clock.advance(1_000);
    await flush();
    expect(calls).toBe(2);
    await worker.stop();
  });

  it("never accumulates timer work behind a slow cycle", async () => {
    const clock = new ManualRuntimeClock();
    let calls = 0;
    let release: (() => void) | undefined;
    const worker = new IngestionMaintenanceWorker({
      maintenance: {
        runOnce: async () => {
          calls += 1;
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          return completedReport();
        },
      },
      lane: lane(),
      clock,
      policy: POLICY,
    });

    worker.start();
    clock.advance(0);
    await flush();
    expect(worker.status.phase).toBe("running");
    expect(clock.pending).toBe(0);

    clock.advance(10_000);
    await flush();
    expect(calls).toBe(1);
    expect(clock.pending).toBe(0);

    release?.();
    await flush();
    expect(worker.status.nextRunAt).toBe(11_000);
    await worker.stop();
  });

  it("uses the retry cadence and exposes only safe degraded diagnostics", async () => {
    const clock = new ManualRuntimeClock();
    const worker = new IngestionMaintenanceWorker({
      maintenance: { runOnce: async () => completedReport("degraded") },
      lane: lane(),
      clock,
      policy: POLICY,
    });

    worker.start();
    clock.advance(0);
    await flush();

    expect(worker.status).toMatchObject({
      cycles: 1,
      degradedCycles: 1,
      failedCycles: 0,
      lastOutcome: "degraded",
      lastDiagnosticCode: "registry_unavailable",
      nextRunAt: 100,
    });
    await worker.stop();
  });

  it("contains unexpected failure text and retries with a stable code", async () => {
    const clock = new ManualRuntimeClock();
    const worker = new IngestionMaintenanceWorker({
      maintenance: {
        runOnce: async () => {
          throw new Error("secret at /private/catalog.sqlite");
        },
      },
      lane: lane(),
      clock,
      policy: POLICY,
    });

    worker.start();
    clock.advance(0);
    await flush();

    expect(worker.status).toMatchObject({
      cycles: 1,
      failedCycles: 1,
      lastOutcome: "failed",
      lastDiagnosticCode: "ingestion_maintenance_cycle_failed",
      nextRunAt: 100,
    });
    expect(JSON.stringify(worker.status)).not.toContain("private");
    await worker.stop();
  });

  it("draining cancels queued work and prevents every later cycle", async () => {
    const clock = new ManualRuntimeClock();
    let calls = 0;
    const worker = new IngestionMaintenanceWorker({
      maintenance: {
        runOnce: async () => {
          calls += 1;
          return completedReport();
        },
      },
      lane: lane(),
      clock,
      policy: POLICY,
    });
    const lifecycle = new DaemonLifecycle({
      clock,
      lanes: [],
      drainTimeoutMs: 1_000,
    });
    lifecycle.registerDrainHook(() => worker.beginDraining());
    lifecycle.registerCloseable("maintenance_worker", () => worker.stop());

    worker.start();
    expect(clock.pending).toBe(1);
    lifecycle.beginDraining();
    expect(clock.pending).toBe(0);
    await lifecycle.shutdown();

    clock.advance(10_000);
    await flush();
    expect(calls).toBe(0);
    expect(worker.status.phase).toBe("stopped");
    expect(() => worker.start()).toThrow(IngestionMaintenanceWorkerClosedError);
  });

  it("passes shutdown cancellation into an active safe cycle", async () => {
    const clock = new ManualRuntimeClock();
    let observed: AbortSignal | undefined;
    const worker = new IngestionMaintenanceWorker({
      maintenance: {
        runOnce: async ({ signal } = {}) => {
          observed = signal;
          await new Promise<void>((resolve) => {
            signal?.addEventListener("abort", () => resolve(), { once: true });
          });
          signal?.throwIfAborted();
          return completedReport();
        },
      },
      lane: lane(),
      clock,
      policy: POLICY,
    });

    worker.start();
    clock.advance(0);
    await flush();
    expect(observed?.aborted).toBe(false);

    await worker.stop();
    expect(observed?.aborted).toBe(true);
    expect(worker.status).toMatchObject({
      phase: "stopped",
      cycles: 1,
      lastOutcome: "cancelled",
    });
  });

  it("rejects unversioned and unbounded cadence policies", () => {
    const clock = new ManualRuntimeClock();
    expect(
      () =>
        new IngestionMaintenanceWorker({
          maintenance: { runOnce: async () => completedReport() },
          lane: lane(),
          clock,
          policy: { version: "", intervalMs: 1_000, retryIntervalMs: 100 },
        }),
    ).toThrow("policy is invalid");
    expect(
      () =>
        new IngestionMaintenanceWorker({
          maintenance: { runOnce: async () => completedReport() },
          lane: lane(),
          clock,
          policy: {
            version: "invalid-v1",
            intervalMs: 100,
            retryIntervalMs: 101,
          },
        }),
    ).toThrow("policy is invalid");
  });
});
