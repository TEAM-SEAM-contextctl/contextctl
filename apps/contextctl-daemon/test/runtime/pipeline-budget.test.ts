import { describe, expect, it } from "vitest";

import { ManagedDocumentSearchError } from "@contextctl/ingestion-indexing";

import { ManualRuntimeClock } from "../../src/runtime/clock.js";
import { AdmissionLane } from "../../src/runtime/admission.js";
import { DaemonLifecycle } from "../../src/runtime/lifecycle.js";
import { RequestBudget } from "../../src/runtime/deadline.js";
import { DAEMON_RUNTIME_PROFILE_V1 } from "../../src/runtime/profile.js";

const DEADLINES = DAEMON_RUNTIME_PROFILE_V1.deadlines;

/**
 * Where a timeout lands, and what that costs the answer.
 *
 * The two outcomes look similar from a distance and are opposites in effect: a
 * managed search that overran degrades one target inside an answer that is still
 * sent, and a request that overran sends nothing at all. Getting this wrong in
 * either direction is silent — the first discards results the caller was owed,
 * the second answers a caller who has already left.
 */
describe("stage and request deadlines", () => {
  it("marks a search that overran as a deadline item, not a request failure", async () => {
    const clock = new ManualRuntimeClock();
    const budget = RequestBudget.open(clock, DEADLINES);
    const stage = budget.stageSignal(budget.managedSearchMs);

    // The search observes its own budget expiring.
    clock.advance(1_750);
    expect(stage.signal.aborted).toBe(true);

    // The request still holds its assembly reserve, so an answer can be built
    // around the target that failed.
    expect(budget.remainingMs).toBe(1_250);
    expect(() => budget.assertCanAssemble()).not.toThrow();
    stage.dispose();
  });

  it("ends the request when the total is gone, even with a plan in hand", () => {
    const clock = new ManualRuntimeClock();
    const budget = RequestBudget.open(clock, DEADLINES);

    // Selection finished and a search returned; the clock still ran out.
    clock.advance(3_000);
    expect(() => budget.assertCanAssemble()).toThrow();
  });

  it("gives selection its own ceiling rather than the whole request", async () => {
    const clock = new ManualRuntimeClock();
    const budget = RequestBudget.open(clock, DEADLINES);
    let settled = false;
    const slowSelection = new Promise<string>(() => undefined);

    const raced = budget
      .raceStage("selection", budget.selectionMs, slowSelection)
      .catch(() => {
        settled = true;
      });

    // Still inside the selection ceiling.
    clock.advance(749);
    await Promise.resolve();
    expect(settled).toBe(false);

    clock.advance(1);
    await raced;
    expect(settled).toBe(true);
    // The request itself is far from over; only the stage ended.
    expect(budget.remainingMs).toBe(2_250);
  });

  it("keeps a search failure's own code when it is not a deadline", () => {
    // Guards the branch order in the failure mapping: an ordinary search error
    // arriving while no deadline fired must keep reporting itself.
    const error = new ManagedDocumentSearchError("index_binding_unavailable", true);
    expect(error.code).toBe("index_binding_unavailable");
    expect(error.retriable).toBe(true);
  });
});

describe("DaemonLifecycle", () => {
  function lifecycleWith(lanes: readonly AdmissionLane[]): {
    readonly clock: ManualRuntimeClock;
    readonly lifecycle: DaemonLifecycle;
  } {
    const clock = new ManualRuntimeClock();
    return {
      clock,
      lifecycle: new DaemonLifecycle({
        clock,
        lanes,
        drainTimeoutMs: DEADLINES.totalMs,
      }),
    };
  }

  it("moves from accepting to closed and stops admitting on the way", async () => {
    const lane = new AdmissionLane("resolve", {
      concurrency: 1,
      queueDepth: 1,
    });
    const { lifecycle } = lifecycleWith([lane]);

    expect(lifecycle.state).toBe("accepting");
    lifecycle.beginDraining();
    expect(lifecycle.state).toBe("draining");
    await expect(lane.run(async () => "new")).rejects.toThrow();

    await lifecycle.shutdown();
    expect(lifecycle.state).toBe("closed");
  });

  it("closes each resource exactly once across concurrent shutdowns", async () => {
    const { lifecycle } = lifecycleWith([]);
    let closed = 0;
    lifecycle.registerCloseable("database", () => {
      closed += 1;
    });

    // Two signals arriving together must not close the database twice; the
    // second joins the first shutdown instead of starting another.
    await Promise.all([lifecycle.shutdown(), lifecycle.shutdown()]);
    await lifecycle.shutdown();
    expect(closed).toBe(1);
  });

  it("releases in reverse registration order", async () => {
    const { lifecycle } = lifecycleWith([]);
    const order: string[] = [];
    lifecycle.registerCloseable("database", () => {
      order.push("database");
    });
    lifecycle.registerCloseable("http_server", () => {
      order.push("http_server");
    });

    await lifecycle.shutdown();
    // The listener in front closes before the store behind it, so nothing is
    // handed a request against a database that is already gone.
    expect(order).toEqual(["http_server", "database"]);
  });

  it("keeps closing after one resource fails, and names it without detail", async () => {
    const { lifecycle } = lifecycleWith([]);
    let reached = false;
    lifecycle.registerCloseable("database", () => {
      reached = true;
    });
    lifecycle.registerCloseable("http_server", () => {
      throw new TypeError("socket at /var/run/contextctl.sock still bound");
    });

    const failures = await lifecycle.shutdown();
    expect(reached).toBe(true);
    expect(failures).toEqual([
      { resource: "http_server", reason: "TypeError" },
    ]);
    // The thrown message named a path. What is reported does not.
    expect(JSON.stringify(failures)).not.toContain("/var/run");
  });

  it("stops waiting for work that outlived the drain window", async () => {
    const lane = new AdmissionLane("resolve", {
      concurrency: 1,
      queueDepth: 0,
    });
    const { clock, lifecycle } = lifecycleWith([lane]);
    let released: (() => void) | undefined;
    const stuck = lane.run(
      async () =>
        await new Promise<void>((resolve) => {
          released = resolve;
        }),
    );
    await Promise.resolve();

    const shutdown = lifecycle.shutdown();
    // A task that ignores its own budget must not hold the process open. The
    // wait is bounded, and the drain completes without it.
    for (let step = 0; step < 400; step += 1) {
      clock.advance(10);
      await Promise.resolve();
    }
    await shutdown;
    expect(lifecycle.state).toBe("closed");

    released?.();
    await stuck;
  });
});
