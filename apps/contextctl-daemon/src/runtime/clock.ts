/**
 * The daemon's view of time, narrow enough to substitute.
 *
 * Two operations, because those are the two the runtime control actually
 * performs: read the current instant to decide how much budget is left, and
 * arrange for something to happen when a budget runs out. Anything wider would
 * be a general timer library that tests then have to reimplement.
 *
 * The substitution is not a testing convenience. Every rule this module exists
 * to enforce — a queue that empties in order, a stage that stops at 750ms, a
 * request that refuses to serialize after 3,000ms — is a statement about
 * ordering, and a test that asserts ordering against a real clock is asserting
 * against the machine's scheduler. Those tests pass on a fast laptop, fail in
 * CI, and get their thresholds widened until they no longer test anything.
 */
export interface RuntimeClock {
  /** Milliseconds since an arbitrary fixed origin. Monotonic within a process. */
  now(): number;
  /**
   * Runs `onFire` after `delayMs`, and returns the cancel for it.
   *
   * Cancelling must be safe to call more than once and after the timer has
   * fired: a request that finishes normally cancels its deadline, and a request
   * that times out has already fired one.
   */
  schedule(delayMs: number, onFire: () => void): () => void;
}

/**
 * The process clock.
 *
 * `performance.now()` rather than `Date.now()` because a budget is an elapsed
 * measurement and a wall clock can step backwards — an NTP correction mid-request
 * would otherwise hand a request more budget than it started with, or expire it
 * immediately.
 *
 * Timers are unreferenced so a pending deadline never holds the process open.
 * During shutdown the runtime waits on the work, not on the timer that would
 * have cancelled it.
 */
export class SystemRuntimeClock implements RuntimeClock {
  now(): number {
    return performance.now();
  }

  schedule(delayMs: number, onFire: () => void): () => void {
    const timer = setTimeout(onFire, Math.max(0, delayMs));
    timer.unref?.();
    return () => {
      clearTimeout(timer);
    };
  }
}

/**
 * A clock that only moves when told.
 *
 * Test-only, and exported from the runtime rather than from a test helper
 * because the admission and deadline modules both take a `RuntimeClock` and a
 * second implementation living beside the first is what keeps the interface
 * honest — an operation the fake cannot express is one the real code should not
 * be performing.
 *
 * `advance` fires every timer whose deadline the new instant has reached, in
 * scheduled order, and re-reads the pending set between callbacks so a timer
 * scheduled by a firing timer is honoured within the same advance.
 */
export class ManualRuntimeClock implements RuntimeClock {
  #current: number;
  #sequence = 0;
  readonly #timers = new Map<
    number,
    { readonly at: number; readonly onFire: () => void }
  >();

  constructor(start = 0) {
    this.#current = start;
  }

  now(): number {
    return this.#current;
  }

  schedule(delayMs: number, onFire: () => void): () => void {
    const id = this.#sequence++;
    this.#timers.set(id, { at: this.#current + Math.max(0, delayMs), onFire });
    return () => {
      this.#timers.delete(id);
    };
  }

  /** Moves time forward and fires whatever that reaches. */
  advance(byMs: number): void {
    const target = this.#current + byMs;
    for (;;) {
      const due = [...this.#timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort(([leftId, left], [rightId, right]) =>
          left.at === right.at ? leftId - rightId : left.at - right.at,
        );
      const next = due[0];
      if (next === undefined) break;
      const [id, timer] = next;
      this.#timers.delete(id);
      // Time is at the timer's own instant while it runs, so a callback that
      // schedules another timer measures from when it fired rather than from
      // wherever this advance was headed.
      this.#current = timer.at;
      timer.onFire();
    }
    this.#current = target;
  }

  /** How many timers are still armed. Guards against leaks in tests. */
  get pending(): number {
    return this.#timers.size;
  }
}
