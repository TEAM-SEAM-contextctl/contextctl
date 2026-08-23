import { describe, expect, it, vi } from "vitest";

import {
  IngestionMaintenance,
  type FailedIndexStagingCleanupReport,
  type SourceObservationRetentionReport,
} from "../src/index.js";

const STARTED_AT = "2026-08-23T05:00:00.000Z";
const COMPLETED_AT = "2026-08-23T05:00:01.000Z";

const stagingReport = {
  startedAt: STARTED_AT,
  completedAt: STARTED_AT,
  eligibleBefore: "2026-08-22T05:00:00.000Z",
  examined: 1,
  deleted: 1,
  referenced: 0,
  retained: 0,
  failed: 0,
  remainingEligible: 0,
  remainingOrphans: 0,
  items: [],
} satisfies FailedIndexStagingCleanupReport;

const retentionReport = {
  startedAt: STARTED_AT,
  completedAt: STARTED_AT,
  capturedBefore: "2026-08-16T05:00:00.000Z",
  examined: 1,
  deleted: 1,
  protected: 0,
  missing: 0,
  remainingSnapshots: 2,
  items: [],
} satisfies SourceObservationRetentionReport;

describe("IngestionMaintenance", () => {
  it("runs every bounded maintenance step in the owned order", async () => {
    const order: string[] = [];
    const maintenance = new IngestionMaintenance({
      readyReconciler: {
        reconcile: vi.fn(async () => {
          order.push("ready");
          return [
            {
              publicationId: "pub_0198d3ea-8810-75bf-9b78-e0d05d58a908",
              status: "delivered" as const,
            },
          ];
        }),
      },
      stagingCleanup: {
        execute: vi.fn(async () => {
          order.push("staging");
          return stagingReport;
        }),
      },
      observationRetention: {
        execute: vi.fn(async () => {
          order.push("observations");
          return retentionReport;
        }),
      },
      clock: sequenceClock(STARTED_AT, COMPLETED_AT),
    });

    await expect(maintenance.runOnce()).resolves.toEqual({
      startedAt: STARTED_AT,
      completedAt: COMPLETED_AT,
      status: "completed",
      steps: [
        {
          step: "publication_ready_reconciliation",
          status: "completed",
          report: [
            {
              publicationId: "pub_0198d3ea-8810-75bf-9b78-e0d05d58a908",
              status: "delivered",
            },
          ],
        },
        {
          step: "failed_index_staging_cleanup",
          status: "completed",
          report: stagingReport,
        },
        {
          step: "source_observation_retention",
          status: "completed",
          report: retentionReport,
        },
      ],
    });
    expect(order).toEqual(["ready", "staging", "observations"]);
  });

  it("coalesces overlapping calls without duplicating leases or cleanup", async () => {
    let releaseReady!: () => void;
    const readyGate = new Promise<void>((resolve) => {
      releaseReady = resolve;
    });
    const ready = vi.fn(async () => {
      await readyGate;
      return [];
    });
    const staging = vi.fn(async () => stagingReport);
    const retention = vi.fn(async () => retentionReport);
    const maintenance = new IngestionMaintenance({
      readyReconciler: { reconcile: ready },
      stagingCleanup: { execute: staging },
      observationRetention: { execute: retention },
      clock: () => STARTED_AT,
    });

    const first = maintenance.runOnce();
    const second = maintenance.runOnce();
    await vi.waitFor(() => expect(ready).toHaveBeenCalledOnce());
    releaseReady();

    const [firstReport, secondReport] = await Promise.all([first, second]);
    expect(secondReport).toEqual(firstReport);
    expect(ready).toHaveBeenCalledOnce();
    expect(staging).toHaveBeenCalledOnce();
    expect(retention).toHaveBeenCalledOnce();
  });

  it("isolates step failures and never exposes their messages", async () => {
    const readyError = Object.assign(new Error("secret ready-store detail"), {
      code: "publication_store_unavailable",
    });
    const maintenance = new IngestionMaintenance({
      readyReconciler: {
        reconcile: vi.fn(async () => Promise.reject(readyError)),
      },
      stagingCleanup: {
        execute: vi.fn(async () => stagingReport),
      },
      observationRetention: {
        execute: vi.fn(async () =>
          Promise.reject(new Error("secret observation-store detail")),
        ),
      },
      clock: sequenceClock(STARTED_AT, COMPLETED_AT),
    });

    const report = await maintenance.runOnce();

    expect(report.status).toBe("degraded");
    expect(report.steps).toEqual([
      {
        step: "publication_ready_reconciliation",
        status: "failed",
        diagnosticCode: "publication_store_unavailable",
      },
      {
        step: "failed_index_staging_cleanup",
        status: "completed",
        report: stagingReport,
      },
      {
        step: "source_observation_retention",
        status: "failed",
        diagnosticCode: "source_observation_retention_failed",
      },
    ]);
    expect(JSON.stringify(report)).not.toContain("secret");
  });

  it("does not start a later step after cancellation at a safe boundary", async () => {
    const controller = new AbortController();
    const staging = vi.fn(async () => stagingReport);
    const retention = vi.fn(async () => retentionReport);
    const maintenance = new IngestionMaintenance({
      readyReconciler: {
        reconcile: vi.fn(async () => {
          controller.abort(new Error("daemon shutdown"));
          return [];
        }),
      },
      stagingCleanup: { execute: staging },
      observationRetention: { execute: retention },
      clock: () => STARTED_AT,
    });

    await expect(
      maintenance.runOnce({ signal: controller.signal }),
    ).rejects.toThrow("daemon shutdown");
    expect(staging).not.toHaveBeenCalled();
    expect(retention).not.toHaveBeenCalled();
  });

  it("clears the active cycle after completion so a later tick can run", async () => {
    const ready = vi.fn(async () => []);
    const maintenance = new IngestionMaintenance({
      readyReconciler: { reconcile: ready },
      stagingCleanup: { execute: vi.fn(async () => stagingReport) },
      observationRetention: { execute: vi.fn(async () => retentionReport) },
      clock: () => STARTED_AT,
    });

    await maintenance.runOnce();
    await maintenance.runOnce();

    expect(ready).toHaveBeenCalledTimes(2);
  });

  it("rejects invalid or backwards maintenance clocks", async () => {
    const dependencies = {
      readyReconciler: { reconcile: vi.fn(async () => []) },
      stagingCleanup: { execute: vi.fn(async () => stagingReport) },
      observationRetention: { execute: vi.fn(async () => retentionReport) },
    };
    const invalid = new IngestionMaintenance({
      ...dependencies,
      clock: () => "not-a-timestamp",
    });
    const backwards = new IngestionMaintenance({
      ...dependencies,
      clock: sequenceClock(COMPLETED_AT, STARTED_AT),
    });

    await expect(invalid.runOnce()).rejects.toThrow(
      "Ingestion maintenance clock is invalid",
    );
    await expect(backwards.runOnce()).rejects.toThrow(
      "Ingestion maintenance clock moved backwards",
    );
  });
});

function sequenceClock(first: string, second: string): () => string {
  let calls = 0;
  return () => (calls++ === 0 ? first : second);
}
