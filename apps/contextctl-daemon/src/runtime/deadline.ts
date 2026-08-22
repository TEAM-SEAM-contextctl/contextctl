import type { RuntimeClock } from "./clock.js";
import type { DaemonDeadlineProfile } from "./profile.js";

/**
 * A stage ran out of its own budget while the request still had time.
 *
 * Distinct from the request running out, and the distinction is the whole point:
 * a managed search that overruns produces one failed target inside an answer
 * that is still assembled and sent, while a request that overruns produces no
 * answer at all. Collapsing them would either discard results the caller was
 * entitled to, or send an answer after the caller stopped waiting for it.
 */
export class StageDeadlineExceededError extends Error {
  constructor(readonly stage: string) {
    super(`${stage} exceeded its stage budget`);
    this.name = "StageDeadlineExceededError";
  }
}

/**
 * The request has no time left to produce a safe answer.
 *
 * Raised rather than returned so no caller can serialize past it. The design is
 * explicit that a late success payload is worse than a timeout — the caller has
 * moved on, and a response arriving after the deadline is indistinguishable from
 * one that was never bounded.
 */
export class RequestDeadlineExceededError extends Error {
  constructor() {
    super("request exceeded its total budget");
    this.name = "RequestDeadlineExceededError";
  }
}

/**
 * One request's time, measured from the instant the transport received it.
 *
 * From arrival, not from admission. Queue time is time the caller spent waiting,
 * and a budget that started when a slot opened would let a request queued for
 * two seconds still spend a full three — which is how a saturated process
 * answers every request late while every individual measurement looks fine.
 *
 * The budget is not a parameter. A caller may narrow the amount of context it
 * receives and nothing else; letting a request state its own deadline would turn
 * a capacity decision into something the load itself controls.
 */
export class RequestBudget {
  readonly #clock: RuntimeClock;
  readonly #profile: DaemonDeadlineProfile;
  readonly #startedAt: number;
  readonly #caller: AbortSignal | undefined;

  private constructor(
    clock: RuntimeClock,
    profile: DaemonDeadlineProfile,
    startedAt: number,
    caller: AbortSignal | undefined,
  ) {
    this.#clock = clock;
    this.#profile = profile;
    this.#startedAt = startedAt;
    this.#caller = caller;
  }

  /**
   * Opens a budget at the current instant.
   *
   * Called by the transport adapter before admission, so the queue wait is
   * inside the measurement.
   */
  static open(
    clock: RuntimeClock,
    profile: DaemonDeadlineProfile,
    caller?: AbortSignal | undefined,
  ): RequestBudget {
    return new RequestBudget(clock, profile, clock.now(), caller);
  }

  get elapsedMs(): number {
    return this.#clock.now() - this.#startedAt;
  }

  /** Time before the total deadline. Never negative. */
  get remainingMs(): number {
    return Math.max(0, this.#profile.totalMs - this.elapsedMs);
  }

  /**
   * Time before the assembly reserve begins.
   *
   * What any stage that produces material for the answer is actually allowed to
   * spend. The reserve is not slack — it is the time assembling and serializing
   * a finished answer takes, and a stage that borrows it wins nothing, because
   * the answer it produced then cannot be sent.
   */
  get workableMs(): number {
    return Math.max(
      0,
      this.remainingMs - this.#profile.assemblyReserveMs,
    );
  }

  /** Whether the caller gave up, independently of the clock. */
  get cancelled(): boolean {
    return this.#caller?.aborted === true;
  }

  /**
   * A signal for the whole request, including time spent waiting for admission.
   *
   * The Resolve lane consumes this signal while an entry is queued. Merely
   * checking the clock after promotion would account for queue time in a metric
   * but would not bound it: a saturated queue could keep an expired request in
   * memory indefinitely. Aborting at the remaining total removes it at the
   * actual deadline and also gives running cancellable work the same reason.
   */
  totalSignal(): {
    readonly signal: AbortSignal;
    readonly dispose: () => void;
  } {
    const controller = new AbortController();
    const remaining = this.remainingMs;
    if (this.cancelled || remaining <= 0) {
      controller.abort(new RequestDeadlineExceededError());
      return { signal: controller.signal, dispose: () => undefined };
    }

    const cancelTimer = this.#clock.schedule(remaining, () => {
      controller.abort(new RequestDeadlineExceededError());
    });
    const onCallerAbort = (): void => {
      controller.abort(new RequestDeadlineExceededError());
    };
    this.#caller?.addEventListener("abort", onCallerAbort, { once: true });
    // Close the same lost-abort window as the admission queue. A caller may
    // cancel between the initial check and listener attachment.
    if (this.#caller?.aborted === true) {
      onCallerAbort();
    }

    let disposed = false;
    return {
      signal: controller.signal,
      dispose: () => {
        if (disposed) return;
        disposed = true;
        cancelTimer();
        this.#caller?.removeEventListener("abort", onCallerAbort);
      },
    };
  }

  /**
   * The selection stage's allowance.
   *
   * Its own ceiling or whatever is workable, whichever is smaller. A selection
   * that cannot finish inside the workable window has nothing to hand the rest
   * of the pipeline, so shortening it is not a degradation.
   */
  get selectionMs(): number {
    return Math.min(this.#profile.selectionMs, this.workableMs);
  }

  /**
   * The managed search allowance: `min(ceiling, remaining - reserve)`.
   *
   * The design states this formula outright. Both terms matter — the ceiling
   * keeps one slow backend from consuming a whole request even when the request
   * is fresh, and the remainder keeps a request that already spent its time on
   * selection from starting a search it cannot finish.
   */
  get managedSearchMs(): number {
    return Math.min(this.#profile.managedSearchCeilingMs, this.workableMs);
  }

  /**
   * Refuses to continue when no safe answer can still be produced.
   *
   * Checked before assembly and again before serialization. Two checks rather
   * than one because the work between them is exactly what the reserve was set
   * aside for, and a request that arrived at assembly with time left can still
   * lose it there.
   */
  assertCanAssemble(): void {
    if (this.cancelled || this.remainingMs <= 0) {
      throw new RequestDeadlineExceededError();
    }
  }

  /**
   * Runs a stage that cannot be cancelled, and abandons it if it overruns.
   *
   * The honest treatment of a boundary that takes no signal. Selection is
   * synchronous from this side — its public API accepts no `AbortSignal`, and
   * widening that API to add one is a domain change this composition is not
   * entitled to make. So the stage is raced: if the budget wins, the request
   * fails and the late result is dropped on arrival.
   *
   * Dropped, not reported as finished. A stage whose result is discarded did not
   * complete, and an answer assembled from it would be an answer built out of
   * work the request had already given up on.
   */
  async raceStage<T>(stage: string, limitMs: number, work: Promise<T>): Promise<T> {
    if (this.cancelled) {
      void work.catch(() => undefined);
      throw new RequestDeadlineExceededError();
    }
    if (limitMs <= 0) {
      void work.catch(() => undefined);
      throw new StageDeadlineExceededError(stage);
    }
    let cancelTimer: (() => void) | undefined;
    let onCallerAbort: (() => void) | undefined;
    try {
      return await new Promise<T>((resolve, reject) => {
        let settled = false;
        const settleWith = (fail: Error): void => {
          if (settled) return;
          settled = true;
          reject(fail);
        };
        cancelTimer = this.#clock.schedule(limitMs, () => {
          settleWith(new StageDeadlineExceededError(stage));
        });
        if (this.#caller !== undefined) {
          onCallerAbort = () => {
            settleWith(new RequestDeadlineExceededError());
          };
          this.#caller.addEventListener("abort", onCallerAbort, { once: true });
          if (this.#caller.aborted) {
            onCallerAbort();
          }
        }
        work.then(
          (value) => {
            if (settled) return;
            settled = true;
            resolve(value);
          },
          (cause: unknown) => {
            if (settled) return;
            settled = true;
            reject(cause);
          },
        );
      });
    } finally {
      cancelTimer?.();
      if (onCallerAbort !== undefined) {
        this.#caller?.removeEventListener("abort", onCallerAbort);
      }
      // The abandoned work still settles somewhere. Attaching a sink keeps a
      // late rejection from surfacing as an unhandled rejection and taking the
      // process down for a request that already failed cleanly.
      void work.catch(() => undefined);
    }
  }

  /**
   * A signal for a stage that does accept one, aborting at its budget.
   *
   * Composed with the caller's cancellation so a boundary sees one signal rather
   * than having to decide which of two ended it. The returned `dispose` must be
   * called on every path — an armed timer that outlives its request is a leak
   * the process pays for under load, which is exactly when it cannot afford to.
   */
  stageSignal(limitMs: number): {
    readonly signal: AbortSignal;
    readonly dispose: () => void;
  } {
    const controller = new AbortController();
    if (limitMs <= 0) {
      controller.abort(new StageDeadlineExceededError("managed_search"));
      return { signal: controller.signal, dispose: () => undefined };
    }
    const cancelTimer = this.#clock.schedule(limitMs, () => {
      controller.abort(new StageDeadlineExceededError("managed_search"));
    });
    const onCallerAbort = (): void => {
      controller.abort(new RequestDeadlineExceededError());
    };
    this.#caller?.addEventListener("abort", onCallerAbort, { once: true });
    if (this.#caller?.aborted === true) {
      onCallerAbort();
    }
    return {
      signal: controller.signal,
      dispose: () => {
        cancelTimer();
        this.#caller?.removeEventListener("abort", onCallerAbort);
      },
    };
  }
}
