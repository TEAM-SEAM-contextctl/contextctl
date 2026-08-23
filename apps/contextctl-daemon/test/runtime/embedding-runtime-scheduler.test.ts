import {
  DEFAULT_DOCUMENT_RETRIEVAL_EMBEDDING_PROFILE,
  type EmbeddingPort,
  type EmbeddingProviderRequest,
} from "@contextctl/ingestion-indexing";
import {
  CARD_SELECTION_EMBEDDING_PROFILE,
  type CardEmbeddingPort,
  type CardEmbeddingRequest,
} from "@contextctl/selection-delivery";
import { describe, expect, it } from "vitest";

import {
  SystemRuntimeClock,
  type RuntimeClock,
} from "../../src/runtime/clock.js";
import {
  EMBEDDING_RUNTIME_SCHEDULER_V1,
  EmbeddingRuntimeClosedError,
  EmbeddingRuntimeScheduler,
  EmbeddingRuntimeSchedulerProfileError,
  ScheduledCardEmbedding,
  ScheduledDocumentEmbedding,
} from "../../src/runtime/embedding-runtime-scheduler.js";

function gate(): {
  readonly operation: () => Promise<string>;
  readonly release: () => void;
  readonly started: () => boolean;
} {
  let started = false;
  let release: (() => void) | undefined;
  return {
    operation: async () => {
      started = true;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return "done";
    },
    release: () => release?.(),
    started: () => started,
  };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

class ControlledClock implements RuntimeClock {
  current = 0;
  #sequence = 0;
  readonly #timers = new Map<
    number,
    { readonly at: number; readonly callback: () => void }
  >();

  now(): number {
    return this.current;
  }

  schedule(delayMs: number, onFire: () => void): () => void {
    const id = this.#sequence++;
    this.#timers.set(id, {
      at: this.current + Math.max(0, delayMs),
      callback: onFire,
    });
    return () => {
      this.#timers.delete(id);
    };
  }

  fireAt(now: number): void {
    this.current = now;
    for (;;) {
      const next = [...this.#timers.entries()]
        .filter(([, timer]) => timer.at <= now)
        .sort(([leftId, left], [rightId, right]) =>
          left.at === right.at ? leftId - rightId : left.at - right.at,
        )[0];
      if (next === undefined) return;
      const [id, timer] = next;
      this.#timers.delete(id);
      timer.callback();
    }
  }
}

function scheduler(
  options: {
    readonly clock?: RuntimeClock;
    readonly readRssBytes?: () => number;
    readonly profile?: typeof EMBEDDING_RUNTIME_SCHEDULER_V1;
  } = {},
): EmbeddingRuntimeScheduler {
  return new EmbeddingRuntimeScheduler({
    clock: options.clock ?? new SystemRuntimeClock(),
    ...(options.readRssBytes === undefined
      ? {}
      : { readRssBytes: options.readRssBytes }),
    ...(options.profile === undefined ? {} : { profile: options.profile }),
  });
}

describe("EmbeddingRuntimeScheduler", () => {
  it("runs a waiting Resolve before accepted background work", async () => {
    const clock = new ControlledClock();
    const runtime = scheduler({ clock });
    const firstBackground = gate();
    const secondBackground = gate();
    const resolve = gate();

    const first = runtime.run("background", firstBackground.operation);
    clock.fireAt(EMBEDDING_RUNTIME_SCHEDULER_V1.backgroundYieldMs);
    await settle();
    const second = runtime.run("background", secondBackground.operation);
    const query = runtime.run("resolve", resolve.operation);
    await settle();

    expect(firstBackground.started()).toBe(true);
    expect(secondBackground.started()).toBe(false);
    expect(resolve.started()).toBe(false);
    expect(runtime.snapshot).toMatchObject({
      active: 1,
      resolveQueued: 1,
      backgroundQueued: 1,
    });

    firstBackground.release();
    await first;
    await settle();
    expect(resolve.started()).toBe(true);
    expect(secondBackground.started()).toBe(false);

    resolve.release();
    await query;
    await settle();
    clock.fireAt(
      clock.current + EMBEDDING_RUNTIME_SCHEDULER_V1.resolveQuietPeriodMs,
    );
    await settle();
    expect(secondBackground.started()).toBe(true);
    secondBackground.release();
    await second;
  });

  it("gives an arriving Resolve the initial background promotion boundary", async () => {
    const clock = new ControlledClock();
    const runtime = scheduler({ clock });
    const background = gate();
    const resolve = gate();

    const pendingBackground = runtime.run("background", background.operation);
    const pendingResolve = runtime.run("resolve", resolve.operation);
    await settle();

    expect(resolve.started()).toBe(true);
    expect(background.started()).toBe(false);
    resolve.release();
    await pendingResolve;
    clock.fireAt(EMBEDDING_RUNTIME_SCHEDULER_V1.backgroundYieldMs);
    await settle();
    expect(background.started()).toBe(false);
    clock.fireAt(EMBEDDING_RUNTIME_SCHEDULER_V1.resolveQuietPeriodMs);
    await settle();
    expect(background.started()).toBe(true);
    background.release();
    await pendingBackground;
  });

  it("does not start background work between calls in one Resolve request", async () => {
    const clock = new ControlledClock();
    const runtime = scheduler({ clock });
    let releaseScope: (() => void) | undefined;
    const reserved = runtime.runResolveScope(
      async () =>
        await new Promise<void>((resolve) => {
          releaseScope = resolve;
        }),
    );
    await settle();

    const background = gate();
    const pending = runtime.run("background", background.operation);
    await settle();
    expect(runtime.snapshot.resolveReservations).toBe(1);
    expect(background.started()).toBe(false);

    releaseScope?.();
    await reserved;
    await settle();
    expect(background.started()).toBe(false);
    clock.fireAt(EMBEDDING_RUNTIME_SCHEDULER_V1.backgroundYieldMs);
    await settle();
    expect(background.started()).toBe(false);
    clock.fireAt(EMBEDDING_RUNTIME_SCHEDULER_V1.resolveQuietPeriodMs);
    await settle();
    expect(background.started()).toBe(true);
    background.release();
    await pending;
  });

  it("refuses queued work when draining starts but leaves the native call alone", async () => {
    const clock = new ControlledClock();
    const runtime = scheduler({ clock });
    const active = gate();
    const running = runtime.run("background", active.operation);
    clock.fireAt(EMBEDDING_RUNTIME_SCHEDULER_V1.backgroundYieldMs);
    await settle();
    const queued = runtime.run("resolve", async () => "never");
    await settle();

    runtime.stopAccepting();
    await expect(queued).rejects.toBeInstanceOf(EmbeddingRuntimeClosedError);
    expect(runtime.snapshot.accepting).toBe(false);

    active.release();
    await expect(running).resolves.toBe("done");
    expect(runtime.idle).toBe(true);
  });

  it("suppresses new background starts while event-loop delay is above the profile", async () => {
    const clock = new ControlledClock();
    const runtime = scheduler({ clock });
    runtime.startMonitoring();

    // The 250ms sample fires at 400ms: 150ms late, over the 100ms warning.
    clock.fireAt(400);
    expect(runtime.snapshot).toMatchObject({
      eventLoopLagMs: 150,
      eventLoopState: "delayed",
      backgroundStartsSuppressed: true,
    });

    const work = gate();
    const pending = runtime.run("background", work.operation);
    await settle();
    expect(work.started()).toBe(false);

    // The next sample was due at 650ms and arrives on time, releasing the queue.
    clock.fireAt(650);
    await settle();
    expect(work.started()).toBe(true);
    expect(runtime.snapshot.eventLoopState).toBe("normal");
    work.release();
    await pending;
  });

  it("reports RSS above the release limit without deadlocking background work", async () => {
    const clock = new ControlledClock();
    const rss = EMBEDDING_RUNTIME_SCHEDULER_V1.rssLimitBytes + 1;
    const runtime = scheduler({ clock, readRssBytes: () => rss });
    runtime.startMonitoring();

    const work = gate();
    const pending = runtime.run("background", work.operation);
    clock.fireAt(EMBEDDING_RUNTIME_SCHEDULER_V1.backgroundYieldMs);
    await settle();
    expect(work.started()).toBe(true);
    expect(runtime.snapshot).toMatchObject({
      memoryState: "limited",
      backgroundStartsSuppressed: false,
    });
    work.release();
    await pending;
  });

  it("refuses an unversioned or internally inconsistent profile", () => {
    expect(
      () =>
        scheduler({
          profile: {
            ...EMBEDDING_RUNTIME_SCHEDULER_V1,
            version: "",
          },
        }),
    ).toThrow(EmbeddingRuntimeSchedulerProfileError);
    expect(
      () =>
        scheduler({
          profile: {
            ...EMBEDDING_RUNTIME_SCHEDULER_V1,
            eventLoopWarningMs:
              EMBEDDING_RUNTIME_SCHEDULER_V1.eventLoopSampleMs,
          },
        }),
    ).toThrow(EmbeddingRuntimeSchedulerProfileError);
  });
});

describe("scheduled domain-port views", () => {
  it("uses the closed-safe one-input document background batch", async () => {
    const batchSizes: number[] = [];
    const inner: EmbeddingPort = {
      providerKind: "local",
      embeddingProfile: DEFAULT_DOCUMENT_RETRIEVAL_EMBEDDING_PROFILE,
      embed: async (request: EmbeddingProviderRequest) => {
        batchSizes.push(request.inputs.length);
        return request.inputs.map((input) => ({ key: input.key, vector: [1] }));
      },
    };
    const provider = new ScheduledDocumentEmbedding(
      inner,
      scheduler(),
      "background",
    );
    const signal = new AbortController().signal;
    const outputs = await provider.embed({
      profile: DEFAULT_DOCUMENT_RETRIEVAL_EMBEDDING_PROFILE,
      inputs: Array.from({ length: 65 }, (_, index) => ({
        key: String(index),
        text: String(index),
      })),
      signal,
    });

    expect(batchSizes).toEqual(Array.from({ length: 65 }, () => 1));
    expect(outputs.map((output) => output.key)).toEqual(
      Array.from({ length: 65 }, (_, index) => String(index)),
    );
    expect(provider.providerKind).toBe("local");
    expect(provider.embeddingProfile).toBe(
      DEFAULT_DOCUMENT_RETRIEVAL_EMBEDDING_PROFILE,
    );
  });

  it("uses the same promotion boundary for Card candidate builds", async () => {
    const batchSizes: number[] = [];
    const inner: CardEmbeddingPort = {
      providerKind: "local",
      profile: CARD_SELECTION_EMBEDDING_PROFILE,
      embed: async (request: CardEmbeddingRequest) => {
        batchSizes.push(request.inputs.length);
        return request.inputs.map((input) => ({ key: input.key, vector: [1] }));
      },
    };
    const provider = new ScheduledCardEmbedding(
      inner,
      scheduler(),
      "background",
    );
    const outputs = await provider.embed({
      profile: CARD_SELECTION_EMBEDDING_PROFILE,
      inputs: Array.from({ length: 33 }, (_, index) => ({
        key: String(index),
        text: String(index),
      })),
    });

    expect(batchSizes).toEqual(Array.from({ length: 33 }, () => 1));
    expect(outputs).toHaveLength(33);
    expect(provider.profile).toBe(CARD_SELECTION_EMBEDDING_PROFILE);
  });
});
