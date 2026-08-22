import type { LaneCapacity } from "./profile.js";

/**
 * The lanes the daemon admits work into.
 *
 * Named rather than free-form so a lane cannot be created by a caller that
 * wanted its own capacity. The design fixes four, and a fifth would be capacity
 * nobody sized.
 */
export type LaneName =
  | "resolve"
  | "registry_consume"
  | "selection_assets"
  | "ingestion";

/**
 * The lane refused the work outright.
 *
 * Thrown rather than returned so a caller cannot continue past it by ignoring a
 * result. Every operating entry point translates this into its own surface's
 * refusal, and none of them may start the work anyway.
 */
export class LaneOverloadedError extends Error {
  readonly retriable = true;

  constructor(
    readonly lane: LaneName,
    readonly activeCount: number,
    readonly queuedCount: number,
  ) {
    super(`${lane} lane is at capacity`);
    this.name = "LaneOverloadedError";
  }
}

/** The work was cancelled before or while it ran. */
export class LaneCancelledError extends Error {
  constructor(readonly lane: LaneName) {
    super(`${lane} lane work was cancelled`);
    this.name = "LaneCancelledError";
  }
}

/** The lane stopped accepting because the daemon is shutting down. */
export class LaneClosedError extends Error {
  readonly retriable = true;

  constructor(readonly lane: LaneName) {
    super(`${lane} lane is not accepting new work`);
    this.name = "LaneClosedError";
  }
}

/** What a lane is doing right now, for operator status. */
export interface LaneDepth {
  readonly lane: LaneName;
  readonly active: number;
  readonly queued: number;
  readonly concurrency: number;
  readonly queueDepth: number;
}

interface QueuedEntry<T> {
  readonly run: (signal: AbortSignal) => Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
  readonly signal: AbortSignal | undefined;
  readonly detach: () => void;
  settled: boolean;
}

/**
 * One bounded execution lane.
 *
 * Three states a submission can land in, and no fourth: it runs now, it waits in
 * a queue with a fixed ceiling, or it is refused. There is no path where work is
 * accepted and then held indefinitely, which is what an unbounded queue is —
 * backpressure converted into memory, where the eventual failure is an OOM
 * instead of a refusal the caller could have retried.
 *
 * Lanes hold their own capacity and never lend it. That is how the design's
 * reservation for Resolve is implemented: not as a priority that background work
 * outranks, but as capacity background work has no reference to.
 */
export class AdmissionLane {
  readonly #name: LaneName;
  readonly #capacity: LaneCapacity;
  readonly #queue: QueuedEntry<unknown>[] = [];
  #active = 0;
  #accepting = true;

  constructor(name: LaneName, capacity: LaneCapacity) {
    this.#name = name;
    this.#capacity = capacity;
  }

  get name(): LaneName {
    return this.#name;
  }

  get depth(): LaneDepth {
    return {
      lane: this.#name,
      active: this.#active,
      queued: this.#queue.length,
      concurrency: this.#capacity.concurrency,
      queueDepth: this.#capacity.queueDepth,
    };
  }

  /** Whether anything is still running or waiting. Drives drain completion. */
  get idle(): boolean {
    return this.#active === 0 && this.#queue.length === 0;
  }

  /**
   * Stops admitting, and refuses everything already waiting.
   *
   * Queued work has not started, so refusing it is not a loss — it is the
   * accurate answer, and the caller can retry against whichever process takes
   * over. Running work is left alone; draining waits for it separately.
   */
  stopAccepting(): void {
    this.#accepting = false;
    for (const entry of this.#queue.splice(0)) {
      if (entry.settled) continue;
      entry.settled = true;
      entry.detach();
      entry.reject(new LaneClosedError(this.#name));
    }
  }

  /**
   * Admits work, queues it, or refuses.
   *
   * `run` receives a signal that is already aborted-aware: it composes the
   * caller's cancellation with the lane's own, so a task does not have to
   * re-derive which of the two ended it.
   *
   * A caller that cancels while queued is removed without ever occupying a slot.
   * That matters at the ceiling — a queue full of abandoned requests that still
   * counted would refuse live ones on behalf of callers that had already left.
   */
  async run<T>(
    task: (signal: AbortSignal) => Promise<T>,
    options: { readonly signal?: AbortSignal | undefined } = {},
  ): Promise<T> {
    if (!this.#accepting) {
      throw new LaneClosedError(this.#name);
    }
    if (options.signal?.aborted === true) {
      throw new LaneCancelledError(this.#name);
    }

    if (this.#active < this.#capacity.concurrency) {
      return await this.#start(task, options.signal);
    }
    if (this.#queue.length >= this.#capacity.queueDepth) {
      throw new LaneOverloadedError(
        this.#name,
        this.#active,
        this.#queue.length,
      );
    }

    return await new Promise<T>((resolve, reject) => {
      const onAbort = (): void => {
        if (entry.settled) return;
        entry.settled = true;
        entry.detach();
        this.#removeQueued(entry as QueuedEntry<unknown>);
        reject(new LaneCancelledError(this.#name));
      };
      const entry: QueuedEntry<T> = {
        run: task,
        resolve,
        reject,
        signal: options.signal,
        detach: () => {
          options.signal?.removeEventListener("abort", onAbort);
        },
        settled: false,
      };

      options.signal?.addEventListener("abort", onAbort, { once: true });
      this.#queue.push(entry as QueuedEntry<unknown>);
    });
  }

  #removeQueued(entry: QueuedEntry<unknown>): void {
    const index = this.#queue.indexOf(entry);
    if (index >= 0) {
      this.#queue.splice(index, 1);
    }
  }

  async #start<T>(
    task: (signal: AbortSignal) => Promise<T>,
    caller: AbortSignal | undefined,
  ): Promise<T> {
    this.#active += 1;
    const controller = new AbortController();
    const onCallerAbort = (): void => {
      controller.abort(new LaneCancelledError(this.#name));
    };
    if (caller !== undefined) {
      if (caller.aborted) {
        onCallerAbort();
      } else {
        caller.addEventListener("abort", onCallerAbort, { once: true });
      }
    }
    try {
      return await task(controller.signal);
    } finally {
      caller?.removeEventListener("abort", onCallerAbort);
      this.#active -= 1;
      this.#drainOne();
    }
  }

  /**
   * Promotes the oldest waiting entry, if there is room.
   *
   * FIFO, and deliberately not a priority queue. Within one lane every entry is
   * the same kind of work, so a priority would only encode arrival luck; across
   * lanes the separation is the priority, and it is expressed by capacity rather
   * than by ordering.
   */
  #drainOne(): void {
    if (!this.#accepting) return;
    if (this.#active >= this.#capacity.concurrency) return;
    const entry = this.#queue.shift();
    if (entry === undefined) return;
    if (entry.settled) {
      this.#drainOne();
      return;
    }
    entry.settled = true;
    entry.detach();
    this.#start(entry.run, entry.signal).then(entry.resolve, entry.reject);
  }
}
