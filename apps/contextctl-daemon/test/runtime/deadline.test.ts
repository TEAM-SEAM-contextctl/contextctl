import { describe, expect, it } from "vitest";

import { ManualRuntimeClock } from "../../src/runtime/clock.js";
import {
  RequestBudget,
  RequestDeadlineExceededError,
  StageDeadlineExceededError,
} from "../../src/runtime/deadline.js";
import {
  assertDaemonRuntimeProfile,
  DAEMON_RUNTIME_PROFILE_V1,
  DaemonRuntimeProfileError,
  defineDaemonRuntimeProfile,
} from "../../src/runtime/profile.js";

const DEADLINES = DAEMON_RUNTIME_PROFILE_V1.deadlines;

describe("daemon runtime profile", () => {
  it("carries the design's own values", () => {
    expect(DEADLINES).toEqual({
      totalMs: 3_000,
      selectionMs: 750,
      assemblyReserveMs: 500,
      managedSearchCeilingMs: 1_750,
    });
    expect(DAEMON_RUNTIME_PROFILE_V1.lanes.resolve).toEqual({
      concurrency: 8,
      queueDepth: 32,
    });
    expect(DAEMON_RUNTIME_PROFILE_V1.lanes.ingestionEmbedding).toEqual({
      concurrency: 2,
      queueDepth: 0,
    });
    expect(DAEMON_RUNTIME_PROFILE_V1.version).toBe("daemon-runtime-profile-v1");
  });

  it("validates the built-in default", () => {
    expect(() =>
      assertDaemonRuntimeProfile(DAEMON_RUNTIME_PROFILE_V1),
    ).not.toThrow();
  });

  it("requires a new version for adjusted values", () => {
    expect(() =>
      defineDaemonRuntimeProfile({ version: "  " }),
    ).toThrowError(DaemonRuntimeProfileError);
  });

  it("refuses stages that would leave no room for a search", () => {
    // Selection plus the assembly reserve filling the whole total is a budget
    // where the search between them has nothing.
    expect(() =>
      defineDaemonRuntimeProfile({
        version: "daemon-runtime-profile-test",
        deadlines: { ...DEADLINES, selectionMs: 2_500 },
      }),
    ).toThrowError(
      expect.objectContaining({ problem: "stages_exceed_total" }),
    );
  });

  it("refuses a search ceiling that reaches into the reserve", () => {
    expect(() =>
      defineDaemonRuntimeProfile({
        version: "daemon-runtime-profile-test",
        deadlines: { ...DEADLINES, managedSearchCeilingMs: 2_600 },
      }),
    ).toThrowError(
      expect.objectContaining({ problem: "search_ceiling_exceeds_budget" }),
    );
  });

  it("refuses a lane that could admit nothing", () => {
    expect(() =>
      defineDaemonRuntimeProfile({
        version: "daemon-runtime-profile-test",
        lanes: { resolve: { concurrency: 0, queueDepth: 32 } },
      }),
    ).toThrowError(
      expect.objectContaining({ problem: "concurrency_invalid" }),
    );
  });

  it("freezes what it returns", () => {
    const profile = defineDaemonRuntimeProfile({
      version: "daemon-runtime-profile-test",
    });
    expect(Object.isFrozen(profile)).toBe(true);
    expect(Object.isFrozen(profile.lanes.resolve)).toBe(true);
    expect(Object.isFrozen(profile.deadlines)).toBe(true);
  });
});

describe("RequestBudget", () => {
  describe("stage allowances", () => {
    it("gives selection its ceiling while the request is fresh", () => {
      const clock = new ManualRuntimeClock();
      const budget = RequestBudget.open(clock, DEADLINES);

      expect(budget.selectionMs).toBe(750);
      // `min(1750, 3000 - 500)` — the ceiling, not the remainder.
      expect(budget.managedSearchMs).toBe(1_750);
    });

    it("narrows the search to what the request has left", () => {
      const clock = new ManualRuntimeClock();
      const budget = RequestBudget.open(clock, DEADLINES);

      // A selection that took its whole ceiling leaves 2,250, of which 500 is
      // reserved: `min(1750, 1750)`.
      clock.advance(750);
      expect(budget.managedSearchMs).toBe(1_750);

      // Another second gone. `min(1750, 3000 - 1750 - 500)` is now the
      // remainder rather than the ceiling.
      clock.advance(1_000);
      expect(budget.managedSearchMs).toBe(750);
    });

    it("never lets a stage reach into the assembly reserve", () => {
      const clock = new ManualRuntimeClock();
      const budget = RequestBudget.open(clock, DEADLINES);

      clock.advance(2_600);
      expect(budget.remainingMs).toBe(400);
      // Less than the reserve is left, so no stage may spend anything.
      expect(budget.workableMs).toBe(0);
      expect(budget.managedSearchMs).toBe(0);
      expect(budget.selectionMs).toBe(0);
    });

    it("counts queue time against the total", () => {
      const clock = new ManualRuntimeClock();
      // Opened at arrival, as a transport does, and only admitted later.
      const budget = RequestBudget.open(clock, DEADLINES);
      clock.advance(2_000);

      expect(budget.elapsedMs).toBe(2_000);
      expect(budget.remainingMs).toBe(1_000);
      expect(budget.managedSearchMs).toBe(500);
    });
  });

  describe("assembly", () => {
    it("permits assembly while any time remains", () => {
      const clock = new ManualRuntimeClock();
      const budget = RequestBudget.open(clock, DEADLINES);
      clock.advance(2_999);

      expect(() => budget.assertCanAssemble()).not.toThrow();
    });

    it("refuses to assemble once the total is spent", () => {
      const clock = new ManualRuntimeClock();
      const budget = RequestBudget.open(clock, DEADLINES);
      clock.advance(3_000);

      expect(() => budget.assertCanAssemble()).toThrowError(
        RequestDeadlineExceededError,
      );
    });

    it("refuses to assemble for a caller that gave up", () => {
      const clock = new ManualRuntimeClock();
      const caller = new AbortController();
      const budget = RequestBudget.open(clock, DEADLINES, caller.signal);

      caller.abort();
      expect(() => budget.assertCanAssemble()).toThrowError(
        RequestDeadlineExceededError,
      );
    });
  });

  describe("whole-request signalling", () => {
    it("aborts at the total deadline and disarms on dispose", () => {
      const clock = new ManualRuntimeClock();
      const budget = RequestBudget.open(clock, DEADLINES);
      clock.advance(1_000);

      const lifetime = budget.totalSignal();
      expect(clock.pending).toBe(1);
      clock.advance(1_999);
      expect(lifetime.signal.aborted).toBe(false);
      clock.advance(1);
      expect(lifetime.signal.reason).toBeInstanceOf(
        RequestDeadlineExceededError,
      );
      lifetime.dispose();
      expect(clock.pending).toBe(0);
    });

    it("opens aborted when its caller already left", () => {
      const clock = new ManualRuntimeClock();
      const caller = new AbortController();
      caller.abort();
      const budget = RequestBudget.open(clock, DEADLINES, caller.signal);

      const lifetime = budget.totalSignal();
      expect(lifetime.signal.aborted).toBe(true);
      expect(lifetime.signal.reason).toBeInstanceOf(
        RequestDeadlineExceededError,
      );
      expect(clock.pending).toBe(0);
    });
  });

  describe("racing a stage that cannot be cancelled", () => {
    it("returns the value when the stage finishes in time", async () => {
      const clock = new ManualRuntimeClock();
      const budget = RequestBudget.open(clock, DEADLINES);

      await expect(
        budget.raceStage("selection", 750, Promise.resolve("plan")),
      ).resolves.toBe("plan");
      expect(clock.pending).toBe(0);
    });

    it("abandons a stage that overruns", async () => {
      const clock = new ManualRuntimeClock();
      const budget = RequestBudget.open(clock, DEADLINES);
      let resolveLate: ((value: string) => void) | undefined;
      const late = new Promise<string>((resolve) => {
        resolveLate = resolve;
      });

      const raced = budget.raceStage("selection", 750, late);
      clock.advance(750);
      await expect(raced).rejects.toBeInstanceOf(StageDeadlineExceededError);

      // The late value still arrives, and is dropped rather than assembled.
      resolveLate?.("late plan");
      await expect(late).resolves.toBe("late plan");
    });

    it("refuses a stage with no allowance left", async () => {
      const clock = new ManualRuntimeClock();
      const budget = RequestBudget.open(clock, DEADLINES);

      await expect(
        budget.raceStage("selection", 0, Promise.resolve("plan")),
      ).rejects.toBeInstanceOf(StageDeadlineExceededError);
    });

    it("does not leave a timer armed after settling", async () => {
      const clock = new ManualRuntimeClock();
      const budget = RequestBudget.open(clock, DEADLINES);

      await budget.raceStage("selection", 750, Promise.resolve("plan"));
      expect(clock.pending).toBe(0);
    });
  });

  describe("signalling a stage that can be cancelled", () => {
    it("aborts at the stage budget with a stage reason", () => {
      const clock = new ManualRuntimeClock();
      const budget = RequestBudget.open(clock, DEADLINES);
      const stage = budget.stageSignal(budget.managedSearchMs);

      expect(stage.signal.aborted).toBe(false);
      clock.advance(1_750);
      expect(stage.signal.aborted).toBe(true);
      expect(stage.signal.reason).toBeInstanceOf(StageDeadlineExceededError);
      stage.dispose();
    });

    it("aborts with a request reason when the caller gives up", () => {
      const clock = new ManualRuntimeClock();
      const caller = new AbortController();
      const budget = RequestBudget.open(clock, DEADLINES, caller.signal);
      const stage = budget.stageSignal(budget.managedSearchMs);

      caller.abort();
      // The distinction the two reasons carry: a stage timeout degrades one
      // item, a caller giving up ends the request.
      expect(stage.signal.reason).toBeInstanceOf(RequestDeadlineExceededError);
      stage.dispose();
    });

    it("opens already aborted when nothing is left", () => {
      const clock = new ManualRuntimeClock();
      const budget = RequestBudget.open(clock, DEADLINES);
      clock.advance(2_600);

      const stage = budget.stageSignal(budget.managedSearchMs);
      expect(stage.signal.aborted).toBe(true);
      stage.dispose();
    });

    it("disarms its timer on dispose", () => {
      const clock = new ManualRuntimeClock();
      const budget = RequestBudget.open(clock, DEADLINES);
      const stage = budget.stageSignal(1_750);

      expect(clock.pending).toBe(1);
      stage.dispose();
      expect(clock.pending).toBe(0);
    });
  });
});
