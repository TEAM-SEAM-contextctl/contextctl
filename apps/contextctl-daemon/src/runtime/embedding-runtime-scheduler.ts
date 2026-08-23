import type {
  EmbeddingPort,
  EmbeddingProfile,
  EmbeddingProviderKind,
  EmbeddingProviderOutput,
  EmbeddingProviderRequest,
} from "@contextctl/ingestion-indexing";
import { EmbeddingProviderFault } from "@contextctl/ingestion-indexing";
import type {
  CardEmbeddingOutput,
  CardEmbeddingPort,
  CardEmbeddingProviderKind,
  CardEmbeddingRequest,
  CardSelectionProfile,
} from "@contextctl/selection-delivery";
import { CardEmbeddingFault } from "@contextctl/selection-delivery";

import type { RuntimeClock } from "./clock.js";

export const EMBEDDING_RUNTIME_SCHEDULER_VERSION =
  "embedding-runtime-scheduler-v1";

export interface EmbeddingRuntimeSchedulerProfile {
  readonly version: string;
  readonly concurrency: number;
  readonly resolveQueueDepth: number;
  readonly backgroundQueueDepth: number;
  readonly backgroundBatchSize: number;
  readonly resolveQuietPeriodMs: number;
  readonly backgroundYieldMs: number;
  readonly eventLoopSampleMs: number;
  readonly eventLoopWarningMs: number;
  readonly rssLimitBytes: number;
}

export const EMBEDDING_RUNTIME_SCHEDULER_V1: EmbeddingRuntimeSchedulerProfile =
  Object.freeze({
    version: EMBEDDING_RUNTIME_SCHEDULER_VERSION,
    // A shared local Transformers.js pipeline has not demonstrated safe
    // concurrent invocation. Serialising the native call is the closed-safe
    // default; priority still decides which accepted call gets that one slot.
    concurrency: 1,
    resolveQueueDepth: 32,
    backgroundQueueDepth: 32,
    // Thirty-two is the design ceiling, not a safe default. On the CPU Granite
    // runtime one 32-input native call can consume the whole 3-second Resolve
    // budget, and a scheduler cannot pre-empt it after it starts. One input per
    // background call creates an honest promotion boundary for waiting Resolve
    // work. A larger value needs a new profile plus the same load evidence.
    backgroundBatchSize: 1,
    // Protect a short burst of sequential transport requests. A 1ms timer was
    // too short on Linux: it promoted a 90-130ms native call between requests
    // even though the next request was already arriving on the following I/O
    // turn. Ten milliseconds still admitted background work between worker-RPC
    // requests. Fifty milliseconds delays only low-priority work, remains tiny
    // beside the polling interval, and gives a transport burst a stable lease.
    resolveQuietPeriodMs: 50,
    // Once the user-facing burst is over, yield one event-loop turn between
    // background native calls without imposing the Resolve quiet period on
    // the whole indexing job.
    backgroundYieldMs: 1,
    eventLoopSampleMs: 250,
    eventLoopWarningMs: 100,
    rssLimitBytes: 1_536 * 1024 * 1024,
  });

export type EmbeddingRuntimePriority = "resolve" | "background";

export type EmbeddingRuntimeSchedulerProblem =
  | "version_missing"
  | "limit_invalid"
  | "event_loop_threshold_invalid";

export class EmbeddingRuntimeSchedulerProfileError extends Error {
  constructor(
    readonly problem: EmbeddingRuntimeSchedulerProblem,
    readonly field: string,
  ) {
    super(`embedding runtime scheduler profile is invalid: ${problem} (${field})`);
    this.name = "EmbeddingRuntimeSchedulerProfileError";
  }
}

export function assertEmbeddingRuntimeSchedulerProfile(
  profile: EmbeddingRuntimeSchedulerProfile,
): void {
  if (profile.version.trim() === "") {
    throw new EmbeddingRuntimeSchedulerProfileError(
      "version_missing",
      "version",
    );
  }
  const positive: readonly (readonly [string, number])[] = [
    ["concurrency", profile.concurrency],
    ["resolveQueueDepth", profile.resolveQueueDepth],
    ["backgroundQueueDepth", profile.backgroundQueueDepth],
    ["backgroundBatchSize", profile.backgroundBatchSize],
    ["resolveQuietPeriodMs", profile.resolveQuietPeriodMs],
    ["backgroundYieldMs", profile.backgroundYieldMs],
    ["eventLoopSampleMs", profile.eventLoopSampleMs],
    ["eventLoopWarningMs", profile.eventLoopWarningMs],
    ["rssLimitBytes", profile.rssLimitBytes],
  ];
  for (const [field, value] of positive) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new EmbeddingRuntimeSchedulerProfileError("limit_invalid", field);
    }
  }
  if (profile.eventLoopWarningMs >= profile.eventLoopSampleMs) {
    throw new EmbeddingRuntimeSchedulerProfileError(
      "event_loop_threshold_invalid",
      "eventLoopWarningMs",
    );
  }
}

export class EmbeddingRuntimeOverloadedError extends Error {
  readonly retriable = true;

  constructor(
    readonly priority: EmbeddingRuntimePriority,
    readonly queued: number,
  ) {
    super(`${priority} embedding queue is at capacity`);
    this.name = "EmbeddingRuntimeOverloadedError";
  }
}

export class EmbeddingRuntimeClosedError extends Error {
  readonly retriable = true;

  constructor() {
    super("embedding runtime scheduler is not accepting new work");
    this.name = "EmbeddingRuntimeClosedError";
  }
}

export class EmbeddingRuntimeCancelledError extends Error {
  constructor(readonly reason?: unknown) {
    super("embedding runtime work was cancelled");
    this.name = "EmbeddingRuntimeCancelledError";
  }
}

export interface EmbeddingRuntimeSnapshot {
  readonly profileVersion: string;
  readonly accepting: boolean;
  readonly active: number;
  readonly resolveStarts: number;
  readonly backgroundStarts: number;
  readonly resolveReservations: number;
  readonly resolveQueued: number;
  readonly backgroundQueued: number;
  readonly eventLoopLagMs: number;
  readonly eventLoopState: "normal" | "delayed";
  readonly rssBytes: number;
  readonly rssLimitBytes: number;
  readonly memoryState: "normal" | "limited";
  readonly backgroundStartsSuppressed: boolean;
}

interface ScheduledEntry<T> {
  readonly priority: EmbeddingRuntimePriority;
  readonly operation: () => Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
  readonly signal: AbortSignal | undefined;
  readonly detach: () => void;
  settled: boolean;
}

export interface EmbeddingRuntimeSchedulerOptions {
  readonly clock: RuntimeClock;
  readonly profile?: EmbeddingRuntimeSchedulerProfile;
  readonly readRssBytes?: () => number;
}

/**
 * Arbitrates calls into one physically shared local inference session.
 *
 * It knows only execution priority and resource pressure. It never sees an
 * embedding profile, vector or cache, so the two domain ports remain separate
 * and independently versioned. Resolve work is always promoted before accepted
 * background work. A running native call is never pretended to be pre-emptible.
 */
export class EmbeddingRuntimeScheduler {
  readonly profile: EmbeddingRuntimeSchedulerProfile;
  readonly #clock: RuntimeClock;
  readonly #readRssBytes: () => number;
  readonly #resolveQueue: ScheduledEntry<unknown>[] = [];
  readonly #backgroundQueue: ScheduledEntry<unknown>[] = [];
  #active = 0;
  #resolveStarts = 0;
  #backgroundStarts = 0;
  #resolveReservations = 0;
  #accepting = true;
  #eventLoopLagMs = 0;
  #rssBytes = 0;
  #cancelSample: (() => void) | undefined;
  #cancelBackgroundPromotion: (() => void) | undefined;

  constructor(options: EmbeddingRuntimeSchedulerOptions) {
    this.#clock = options.clock;
    this.profile = options.profile ?? EMBEDDING_RUNTIME_SCHEDULER_V1;
    assertEmbeddingRuntimeSchedulerProfile(this.profile);
    this.#readRssBytes = options.readRssBytes ?? (() => process.memoryUsage().rss);
    this.#rssBytes = this.#readRssBytes();
  }

  get idle(): boolean {
    return (
      this.#active === 0 &&
      this.#resolveQueue.length === 0 &&
      this.#backgroundQueue.length === 0
    );
  }

  get snapshot(): EmbeddingRuntimeSnapshot {
    const delayed = this.#eventLoopLagMs > this.profile.eventLoopWarningMs;
    const limited = this.#rssBytes > this.profile.rssLimitBytes;
    return {
      profileVersion: this.profile.version,
      accepting: this.#accepting,
      active: this.#active,
      resolveStarts: this.#resolveStarts,
      backgroundStarts: this.#backgroundStarts,
      resolveReservations: this.#resolveReservations,
      resolveQueued: this.#resolveQueue.length,
      backgroundQueued: this.#backgroundQueue.length,
      eventLoopLagMs: this.#eventLoopLagMs,
      eventLoopState: delayed ? "delayed" : "normal",
      rssBytes: this.#rssBytes,
      rssLimitBytes: this.profile.rssLimitBytes,
      memoryState: limited ? "limited" : "normal",
      // RSS is a release gate and an operator signal, not an admission lock.
      // Holding background work while RSS is high cannot make a loaded model
      // disappear from the process; it can instead deadlock Ingestion forever.
      // Event-loop delay is transient and is therefore the only resource
      // signal that pauses new background calls.
      backgroundStartsSuppressed: delayed,
    };
  }

  /** Starts the unreferenced resource sampler exactly once. */
  startMonitoring(): void {
    if (!this.#accepting || this.#cancelSample !== undefined) return;
    this.#scheduleSample();
  }

  /** Stops new work and refuses work that has not entered the native call. */
  stopAccepting(): void {
    if (!this.#accepting) return;
    this.#accepting = false;
    this.#cancelSample?.();
    this.#cancelSample = undefined;
    this.#cancelBackgroundPromotion?.();
    this.#cancelBackgroundPromotion = undefined;
    for (const entry of [
      ...this.#resolveQueue.splice(0),
      ...this.#backgroundQueue.splice(0),
    ]) {
      if (entry.settled) continue;
      entry.settled = true;
      entry.detach();
      entry.reject(new EmbeddingRuntimeClosedError());
    }
  }

  async run<T>(
    priority: EmbeddingRuntimePriority,
    operation: () => Promise<T>,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<T> {
    if (!this.#accepting) throw new EmbeddingRuntimeClosedError();
    if (options.signal?.aborted === true) {
      throw new EmbeddingRuntimeCancelledError(options.signal.reason);
    }

    if (priority === "resolve") {
      // A Resolve arriving during the background yield window owns the next
      // honest native-call boundary. Cancelling the timer is what makes the
      // quiet period a reservation opportunity rather than a cosmetic delay.
      this.#cancelScheduledBackgroundPromotion();
      if (this.#mayStartResolve()) {
        return await this.#start(priority, operation);
      }
    }

    const queue =
      priority === "resolve" ? this.#resolveQueue : this.#backgroundQueue;
    const limit =
      priority === "resolve"
        ? this.profile.resolveQueueDepth
        : this.profile.backgroundQueueDepth;
    if (queue.length >= limit) {
      throw new EmbeddingRuntimeOverloadedError(priority, queue.length);
    }

    return await new Promise<T>((resolve, reject) => {
      const onAbort = (): void => {
        if (entry.settled) return;
        entry.settled = true;
        entry.detach();
        this.#remove(entry as ScheduledEntry<unknown>);
        reject(new EmbeddingRuntimeCancelledError(options.signal?.reason));
      };
      const entry: ScheduledEntry<T> = {
        priority,
        operation,
        resolve,
        reject,
        signal: options.signal,
        detach: () => options.signal?.removeEventListener("abort", onAbort),
        settled: false,
      };
      options.signal?.addEventListener("abort", onAbort, { once: true });
      if (options.signal?.aborted === true) {
        onAbort();
        return;
      }
      queue.push(entry as ScheduledEntry<unknown>);
      if (priority === "background") {
        this.#scheduleBackgroundPromotion(this.profile.backgroundYieldMs);
      }
    });
  }

  /**
   * Reserves the shared session for one whole admitted Resolve request.
   *
   * Card selection and managed document search are two separate domain calls.
   * Without this outer scope, a background native call can start in the gap
   * between them and consume the rest of the request budget. Existing native
   * work is still never interrupted; the reservation only controls what may
   * start at the next honest call boundary.
   */
  async runResolveScope<T>(operation: () => Promise<T>): Promise<T> {
    this.#cancelScheduledBackgroundPromotion();
    this.#resolveReservations += 1;
    try {
      return await operation();
    } finally {
      this.#resolveReservations -= 1;
      if (this.#resolveReservations === 0) {
        this.#cancelScheduledBackgroundPromotion();
        this.#scheduleBackgroundPromotion(this.profile.resolveQuietPeriodMs);
      }
    }
  }

  #mayStartResolve(): boolean {
    return this.#active < this.profile.concurrency;
  }

  async #start<T>(
    priority: EmbeddingRuntimePriority,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (priority === "resolve") this.#resolveStarts += 1;
    else this.#backgroundStarts += 1;
    this.#active += 1;
    try {
      return await operation();
    } finally {
      this.#active -= 1;
      this.#rssBytes = this.#readRssBytes();
      if (this.#resolveQueue.length > 0) {
        this.#drain();
      } else if (this.#backgroundQueue.length > 0) {
        // Never chain background native calls in the same turn. Apart from
        // starving sequential Resolve traffic, back-to-back tokenizer and
        // ONNX work can keep the event loop beyond its release threshold.
        this.#scheduleBackgroundPromotion(
          priority === "resolve"
            ? this.profile.resolveQuietPeriodMs
            : this.profile.backgroundYieldMs,
        );
      }
    }
  }

  #drain(): void {
    if (!this.#accepting) return;
    while (this.#active < this.profile.concurrency) {
      const entry =
        this.#resolveQueue.shift() ??
        (this.#resolveReservations > 0 ||
        this.#cancelBackgroundPromotion !== undefined ||
        this.snapshot.backgroundStartsSuppressed
          ? undefined
          : this.#backgroundQueue.shift());
      if (entry === undefined) return;
      if (entry.settled || entry.signal?.aborted === true) {
        if (!entry.settled) {
          entry.settled = true;
          entry.detach();
          entry.reject(new EmbeddingRuntimeCancelledError(entry.signal?.reason));
        }
        continue;
      }
      entry.settled = true;
      entry.detach();
      void this.#start(entry.priority, entry.operation).then(
        entry.resolve,
        entry.reject,
      );
    }
  }

  #remove(entry: ScheduledEntry<unknown>): void {
    const queue =
      entry.priority === "resolve" ? this.#resolveQueue : this.#backgroundQueue;
    const index = queue.indexOf(entry);
    if (index >= 0) queue.splice(index, 1);
  }

  #scheduleSample(): void {
    const expectedAt = this.#clock.now() + this.profile.eventLoopSampleMs;
    this.#cancelSample = this.#clock.schedule(
      this.profile.eventLoopSampleMs,
      () => {
        this.#cancelSample = undefined;
        if (!this.#accepting) return;
        this.#eventLoopLagMs = Math.max(0, this.#clock.now() - expectedAt);
        this.#rssBytes = this.#readRssBytes();
        this.#drain();
        this.#scheduleSample();
      },
    );
  }

  #scheduleBackgroundPromotion(delayMs: number): void {
    if (
      !this.#accepting ||
      this.#backgroundQueue.length === 0 ||
      this.#cancelBackgroundPromotion !== undefined
    ) {
      return;
    }
    this.#cancelBackgroundPromotion = this.#clock.schedule(
      delayMs,
      () => {
        this.#cancelBackgroundPromotion = undefined;
        this.#drain();
      },
    );
  }

  #cancelScheduledBackgroundPromotion(): void {
    const cancel = this.#cancelBackgroundPromotion;
    this.#cancelBackgroundPromotion = undefined;
    cancel?.();
  }
}

/** Document-port view of one scheduler priority. */
export class ScheduledDocumentEmbedding implements EmbeddingPort {
  readonly providerKind?: EmbeddingProviderKind;
  readonly embeddingProfile?: EmbeddingProfile;
  readonly #inner: EmbeddingPort;
  readonly #scheduler: EmbeddingRuntimeScheduler;
  readonly #priority: EmbeddingRuntimePriority;

  constructor(
    inner: EmbeddingPort,
    scheduler: EmbeddingRuntimeScheduler,
    priority: EmbeddingRuntimePriority,
  ) {
    this.#inner = inner;
    this.#scheduler = scheduler;
    this.#priority = priority;
    if (inner.providerKind !== undefined) this.providerKind = inner.providerKind;
    if (inner.embeddingProfile !== undefined) {
      this.embeddingProfile = inner.embeddingProfile;
    }
  }

  async embed(
    request: EmbeddingProviderRequest,
  ): Promise<readonly EmbeddingProviderOutput[]> {
    try {
      return await runBatches(
        request.inputs,
        this.#priority === "background"
          ? this.#scheduler.profile.backgroundBatchSize
          : request.inputs.length,
        async (inputs) =>
          await this.#scheduler.run(
            this.#priority,
            async () =>
              await this.#inner.embed({
                profile: request.profile,
                inputs,
                signal: request.signal,
              }),
            { signal: request.signal },
          ),
      );
    } catch (cause: unknown) {
      if (cause instanceof EmbeddingRuntimeOverloadedError) {
        throw new EmbeddingProviderFault("rate_limited", true);
      }
      if (cause instanceof EmbeddingRuntimeClosedError) {
        throw new EmbeddingProviderFault("provider_unavailable", true);
      }
      if (cause instanceof EmbeddingRuntimeCancelledError) {
        throw request.signal.reason ?? cause;
      }
      throw cause;
    }
  }
}

/** Card-port view of one scheduler priority. */
export class ScheduledCardEmbedding implements CardEmbeddingPort {
  readonly providerKind?: CardEmbeddingProviderKind;
  readonly profile?: CardSelectionProfile;
  readonly #inner: CardEmbeddingPort;
  readonly #scheduler: EmbeddingRuntimeScheduler;
  readonly #priority: EmbeddingRuntimePriority;

  constructor(
    inner: CardEmbeddingPort,
    scheduler: EmbeddingRuntimeScheduler,
    priority: EmbeddingRuntimePriority,
  ) {
    this.#inner = inner;
    this.#scheduler = scheduler;
    this.#priority = priority;
    if (inner.providerKind !== undefined) this.providerKind = inner.providerKind;
    if (inner.profile !== undefined) this.profile = inner.profile;
  }

  async embed(
    request: CardEmbeddingRequest,
  ): Promise<readonly CardEmbeddingOutput[]> {
    try {
      return await runBatches(
        request.inputs,
        this.#priority === "background"
          ? this.#scheduler.profile.backgroundBatchSize
          : request.inputs.length,
        async (inputs) =>
          await this.#scheduler.run(
            this.#priority,
            async () =>
              await this.#inner.embed({
                profile: request.profile,
                inputs,
                ...(request.signal === undefined
                  ? {}
                  : { signal: request.signal }),
              }),
            request.signal === undefined ? {} : { signal: request.signal },
          ),
      );
    } catch (cause: unknown) {
      if (cause instanceof EmbeddingRuntimeOverloadedError) {
        throw new CardEmbeddingFault("rate_limited", true);
      }
      if (cause instanceof EmbeddingRuntimeClosedError) {
        throw new CardEmbeddingFault("provider_unavailable", true);
      }
      if (cause instanceof EmbeddingRuntimeCancelledError) {
        throw request.signal?.reason ?? cause;
      }
      throw cause;
    }
  }
}

async function runBatches<Input, Output>(
  inputs: readonly Input[],
  requestedSize: number,
  run: (batch: readonly Input[]) => Promise<readonly Output[]>,
): Promise<readonly Output[]> {
  if (inputs.length === 0) return [];
  const size = Math.max(1, requestedSize);
  const outputs: Output[] = [];
  for (let offset = 0; offset < inputs.length; offset += size) {
    outputs.push(...(await run(inputs.slice(offset, offset + size))));
  }
  return outputs;
}
