import { describe, expect, it } from "vitest";

import {
  ResolveContextFailure,
  resolveContextErrorStatus,
  toResolveContextErrorCode,
  type ContextResolution,
  type ResolveContextRequest,
} from "@contextctl/selection-delivery";

import type { BudgetedResolveApplication } from "../../src/context-application.js";
import { ManualRuntimeClock } from "../../src/runtime/clock.js";
import type { RequestBudget } from "../../src/runtime/deadline.js";
import {
  AdmissionControlledResolve,
  DaemonRuntimeControl,
} from "../../src/runtime/runtime-control.js";

/**
 * What a caller receives when the process cannot take the request.
 *
 * The three transports project one vocabulary — HTTP a status, MCP an `isError`
 * payload, the CLI an exit code — so the assertion that matters is that they are
 * all reading the same code, not that each one formats it. The formatting is
 * already covered where each transport lives.
 */

const EMPTY_RESOLUTION = {
  payloadSchemaVersion: 3,
} as unknown as ContextResolution;

/** An application that never finishes, so the lane fills and stays full. */
function blockingApplication(): {
  readonly application: BudgetedResolveApplication;
  readonly releaseAll: () => void;
  readonly started: () => number;
} {
  const releases: (() => void)[] = [];
  let started = 0;
  let open = false;
  return {
    application: {
      resolveWithin: async (
        _request: ResolveContextRequest,
        _budget: RequestBudget,
      ) => {
        started += 1;
        // Once released, entries promoted out of the queue must not block on a
        // list the test has already drained — they would hold the lane open and
        // the test would time out rather than assert anything.
        if (!open) {
          await new Promise<void>((resolve) => releases.push(resolve));
        }
        return EMPTY_RESOLUTION;
      },
    },
    releaseAll: () => {
      open = true;
      for (const release of releases.splice(0)) release();
    },
    started: () => started,
  };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("AdmissionControlledResolve", () => {
  it("refuses past capacity with the overloaded code", async () => {
    const control = new DaemonRuntimeControl({ clock: new ManualRuntimeClock() });
    const { application, releaseAll, started } = blockingApplication();
    const resolve = new AdmissionControlledResolve(control, application);

    // Eight running plus thirty-two waiting is the profile's Resolve lane.
    const inflight = Array.from({ length: 40 }, () =>
      resolve.resolveContext({ query: "q" }),
    );
    await settle();
    expect(control.resolve.depth).toMatchObject({ active: 8, queued: 32 });
    expect(started()).toBe(8);

    let refused: unknown;
    try {
      await resolve.resolveContext({ query: "one too many" });
    } catch (cause: unknown) {
      refused = cause;
    }

    expect(refused).toBeInstanceOf(ResolveContextFailure);
    expect((refused as ResolveContextFailure).code).toBe("overloaded");
    expect((refused as ResolveContextFailure).retriable).toBe(true);
    // Refused before any work began: the count of started resolutions is
    // unchanged, so the refusal did not touch the catalog or the index.
    expect(started()).toBe(8);

    releaseAll();
    await Promise.all(inflight);
  });

  it("projects the refusal identically on every surface", () => {
    const failure = new ResolveContextFailure("overloaded", "full");

    // The three transports all start from this code, so agreeing here is what
    // makes them agree with each other.
    expect(toResolveContextErrorCode(failure)).toBe("overloaded");
    expect(resolveContextErrorStatus("overloaded")).toBe(429);
    expect(failure.toResolveContextError()).toEqual({
      code: "overloaded",
      retriable: true,
    });
  });

  it("refuses while draining rather than queueing for a process that is leaving", async () => {
    const control = new DaemonRuntimeControl({ clock: new ManualRuntimeClock() });
    const resolve = new AdmissionControlledResolve(control, {
      resolveWithin: async () => EMPTY_RESOLUTION,
    });

    control.lifecycle.beginDraining();

    let refused: unknown;
    try {
      await resolve.resolveContext({ query: "after shutdown began" });
    } catch (cause: unknown) {
      refused = cause;
    }
    expect((refused as ResolveContextFailure).code).toBe("overloaded");
  });

  it("fails the request when the queue outlasted its total budget", async () => {
    const clock = new ManualRuntimeClock();
    const control = new DaemonRuntimeControl({ clock });
    const { application, releaseAll } = blockingApplication();
    const resolve = new AdmissionControlledResolve(control, application);

    const inflight = Array.from({ length: 8 }, () =>
      resolve.resolveContext({ query: "holding" }),
    );
    await settle();

    const queued = resolve.resolveContext({ query: "waiting" });
    await settle();
    expect(control.resolve.depth.queued).toBe(1);

    // The wait alone consumes the request's whole allowance. When a slot finally
    // opens there is nothing left to spend, and the answer is a deadline rather
    // than a late success.
    clock.advance(3_000);
    releaseAll();

    let failed: unknown;
    try {
      await queued;
    } catch (cause: unknown) {
      failed = cause;
    }
    expect((failed as ResolveContextFailure).code).toBe("deadline_exceeded");
    expect(resolveContextErrorStatus("deadline_exceeded")).toBe(504);

    await Promise.all(inflight);
  });

  it("passes a budget whose clock is the runtime's", async () => {
    const clock = new ManualRuntimeClock();
    const control = new DaemonRuntimeControl({ clock });
    let observed: RequestBudget | undefined;
    const resolve = new AdmissionControlledResolve(control, {
      resolveWithin: async (_request, budget) => {
        observed = budget;
        return EMPTY_RESOLUTION;
      },
    });

    await resolve.resolveContext({ query: "q" });
    expect(observed?.remainingMs).toBe(3_000);
    clock.advance(1_000);
    expect(observed?.remainingMs).toBe(2_000);
  });
});
