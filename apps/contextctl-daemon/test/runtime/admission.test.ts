import { describe, expect, it } from "vitest";

import {
  AdmissionLane,
  LaneCancelledError,
  LaneClosedError,
  LaneOverloadedError,
} from "../../src/runtime/admission.js";
import { DAEMON_RUNTIME_PROFILE_V1 } from "../../src/runtime/profile.js";

/**
 * The lane's three outcomes, at the boundary between them.
 *
 * Every case here is written with promises the test resolves by hand rather than
 * with timers, because what is being asserted is ordering: which submission runs,
 * which waits, which is refused. A test that produced that ordering by sleeping
 * would be asserting against the machine's scheduler, and the usual repair for
 * such a test is a longer sleep, which removes the assertion rather than fixing
 * it.
 */

/** A task that only finishes when the test says so. */
function gate(): {
  readonly task: () => Promise<string>;
  readonly release: (value?: string) => void;
  readonly started: () => boolean;
} {
  let resolveTask: ((value: string) => void) | undefined;
  let started = false;
  let released: string | undefined;
  return {
    task: () => {
      started = true;
      // A queued entry does not build its promise until the lane promotes it, so
      // a release that arrived while it was waiting has to still apply. Without
      // this the test would hold a resolver for a promise nobody is awaiting.
      if (released !== undefined) return Promise.resolve(released);
      return new Promise<string>((resolve) => {
        resolveTask = resolve;
      });
    },
    release: (value = "done") => {
      released = value;
      resolveTask?.(value);
    },
    started: () => started,
  };
}

/** Lets already-scheduled microtasks run, without advancing any clock. */
async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("AdmissionLane", () => {
  describe("capacity", () => {
    it("runs up to the concurrency and queues the rest", async () => {
      const lane = new AdmissionLane("resolve", {
        concurrency: 2,
        queueDepth: 2,
      });
      const gates = [gate(), gate(), gate(), gate()];
      const running = gates.map((each) => lane.run(each.task));
      await settle();

      expect(gates.map((each) => each.started())).toEqual([
        true,
        true,
        false,
        false,
      ]);
      expect(lane.depth).toMatchObject({ active: 2, queued: 2 });

      for (const each of gates) each.release();
      await Promise.all(running);
      expect(lane.idle).toBe(true);
    });

    it("refuses the request past the queue ceiling", async () => {
      const lane = new AdmissionLane("resolve", {
        concurrency: 1,
        queueDepth: 1,
      });
      const first = gate();
      const second = gate();
      const running = [lane.run(first.task), lane.run(second.task)];
      await settle();

      await expect(lane.run(async () => "third")).rejects.toBeInstanceOf(
        LaneOverloadedError,
      );

      first.release();
      second.release();
      await Promise.all(running);
    });

    it("refuses the 41st Resolve at the design's own limits", async () => {
      // Eight running and thirty-two waiting is the profile's Resolve lane, and
      // the number that matters is the first one past it.
      const lane = new AdmissionLane(
        "resolve",
        DAEMON_RUNTIME_PROFILE_V1.lanes.resolve,
      );
      const gates = Array.from({ length: 40 }, () => gate());
      const running = gates.map((each) => lane.run(each.task));
      await settle();

      expect(lane.depth).toMatchObject({ active: 8, queued: 32 });
      await expect(lane.run(async () => "overflow")).rejects.toBeInstanceOf(
        LaneOverloadedError,
      );

      for (const each of gates) each.release();
      await Promise.all(running);
    });

    it("does not lend one lane's capacity to another", async () => {
      // The reservation rule, stated as an absence: a saturated background lane
      // leaves the Resolve lane exactly as free as it was.
      const resolve = new AdmissionLane("resolve", {
        concurrency: 1,
        queueDepth: 0,
      });
      const ingestion = new AdmissionLane("ingestion", {
        concurrency: 1,
        queueDepth: 0,
      });
      const background = gate();
      const busy = ingestion.run(background.task);
      await settle();

      await expect(ingestion.run(async () => "second")).rejects.toBeInstanceOf(
        LaneOverloadedError,
      );
      await expect(resolve.run(async () => "query")).resolves.toBe("query");

      background.release();
      await busy;
    });
  });

  describe("cancellation", () => {
    it("removes a queued entry without ever spending a slot", async () => {
      const lane = new AdmissionLane("resolve", {
        concurrency: 1,
        queueDepth: 1,
      });
      const held = gate();
      const running = lane.run(held.task);
      await settle();

      const abandoned = new AbortController();
      const queued = lane.run(async () => "queued", {
        signal: abandoned.signal,
      });
      await settle();
      expect(lane.depth.queued).toBe(1);

      abandoned.abort();
      await expect(queued).rejects.toBeInstanceOf(LaneCancelledError);
      expect(lane.depth.queued).toBe(0);

      // The freed place is real: a new submission takes it rather than being
      // refused on behalf of a caller that already left.
      const replacement = lane.run(async () => "replacement");
      await settle();
      expect(lane.depth.queued).toBe(1);

      held.release();
      await running;
      await expect(replacement).resolves.toBe("replacement");
    });

    it("hands running work a signal that aborts with the caller", async () => {
      const lane = new AdmissionLane("resolve", {
        concurrency: 1,
        queueDepth: 0,
      });
      const caller = new AbortController();
      let observed: AbortSignal | undefined;

      const running = lane.run(
        async (signal) => {
          observed = signal;
          await new Promise<void>((resolve) => {
            signal.addEventListener("abort", () => resolve(), { once: true });
          });
          return "stopped";
        },
        { signal: caller.signal },
      );
      await settle();

      expect(observed?.aborted).toBe(false);
      caller.abort();
      await expect(running).resolves.toBe("stopped");
      expect(observed?.aborted).toBe(true);
    });

    it("refuses a submission whose caller already gave up", async () => {
      const lane = new AdmissionLane("resolve", {
        concurrency: 4,
        queueDepth: 4,
      });
      const caller = new AbortController();
      caller.abort();

      await expect(
        lane.run(async () => "never", { signal: caller.signal }),
      ).rejects.toBeInstanceOf(LaneCancelledError);
      expect(lane.depth).toMatchObject({ active: 0, queued: 0 });
    });
  });

  describe("draining", () => {
    it("refuses new work and releases what was waiting", async () => {
      const lane = new AdmissionLane("resolve", {
        concurrency: 1,
        queueDepth: 2,
      });
      const held = gate();
      const running = lane.run(held.task);
      const waiting = lane.run(async () => "waiting");
      await settle();

      lane.stopAccepting();

      // Queued work never started, so refusing it loses nothing and is the
      // accurate answer for a caller that can retry elsewhere.
      await expect(waiting).rejects.toBeInstanceOf(LaneClosedError);
      await expect(lane.run(async () => "new")).rejects.toBeInstanceOf(
        LaneClosedError,
      );

      // Admitted work is left alone.
      held.release("finished");
      await expect(running).resolves.toBe("finished");
      expect(lane.idle).toBe(true);
    });
  });
});
