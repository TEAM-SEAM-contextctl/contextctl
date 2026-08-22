import type { AdmissionLane } from "./admission.js";
import type { RuntimeClock } from "./clock.js";

/**
 * What the process will accept right now.
 *
 * Three states and one direction. A daemon that could return to `accepting`
 * after draining would have to decide what to do with the work it already
 * refused, and there is no answer that is not a lie to one of the two callers.
 */
export type DaemonLifecycleState = "accepting" | "draining" | "closed";

/** One resource that failed to close, named without exposing what it was. */
export interface CloseFailure {
  /** The registered name. A label, never a path or a connection string. */
  readonly resource: string;
  readonly reason: string;
}

export interface DaemonLifecycleOptions {
  readonly clock: RuntimeClock;
  /** Lanes to stop admitting into, in the order they should stop. */
  readonly lanes: readonly AdmissionLane[];
  /**
   * How long to wait for admitted work after draining begins.
   *
   * Defaults to the request total, which is the longest any single admitted
   * Resolve may still legitimately run. Waiting longer would mean waiting on
   * work that has already exceeded its own budget and will fail anyway.
   */
  readonly drainTimeoutMs: number;
}

interface RegisteredCloseable {
  readonly name: string;
  readonly close: () => void | Promise<void>;
  closed: boolean;
}

/**
 * The process's accept/drain/close boundary.
 *
 * Shutdown is a sequence, not a single act, and the order is what makes it
 * graceful: refuse first so nothing new arrives, then wait for what was already
 * admitted, then release resources. Releasing before waiting would close the
 * database under a request that is still reading it, and waiting before
 * refusing would wait on a queue that keeps growing.
 *
 * Every closeable runs exactly once and independently. A failure closing one is
 * recorded and the rest still run — a shutdown that stopped at its first error
 * would leave sockets and file handles open for a reason unrelated to them.
 */
export class DaemonLifecycle {
  readonly #clock: RuntimeClock;
  readonly #lanes: readonly AdmissionLane[];
  readonly #drainTimeoutMs: number;
  readonly #closeables: RegisteredCloseable[] = [];
  #state: DaemonLifecycleState = "accepting";
  #shutdown: Promise<readonly CloseFailure[]> | undefined;

  constructor(options: DaemonLifecycleOptions) {
    this.#clock = options.clock;
    this.#lanes = options.lanes;
    this.#drainTimeoutMs = options.drainTimeoutMs;
  }

  get state(): DaemonLifecycleState {
    return this.#state;
  }

  get accepting(): boolean {
    return this.#state === "accepting";
  }

  /**
   * Registers something to release during shutdown.
   *
   * The name is for operator diagnostics and is a fixed label chosen here, not
   * anything derived from the resource. A shutdown report that carried a
   * database path or a socket address would put infrastructure bindings into the
   * one output an operator is most likely to paste somewhere.
   */
  registerCloseable(name: string, close: () => void | Promise<void>): void {
    this.#closeables.push({ name, close, closed: false });
  }

  /**
   * Stops accepting, everywhere, at once.
   *
   * Idempotent because both signal handlers and the stdin end path call it, and
   * a terminal that sends SIGINT twice is a person pressing Ctrl-C again rather
   * than a second decision.
   */
  beginDraining(): void {
    if (this.#state !== "accepting") return;
    this.#state = "draining";
    for (const lane of this.#lanes) {
      lane.stopAccepting();
    }
  }

  /**
   * Drains and releases, once.
   *
   * The returned promise is shared: SIGTERM arriving while a SIGINT shutdown is
   * already running joins that shutdown instead of starting a second one that
   * would close every resource twice.
   */
  async shutdown(): Promise<readonly CloseFailure[]> {
    this.#shutdown ??= this.#runShutdown();
    return await this.#shutdown;
  }

  async #runShutdown(): Promise<readonly CloseFailure[]> {
    this.beginDraining();
    await this.#awaitLanesIdle();
    const failures = await this.#closeAll();
    this.#state = "closed";
    return failures;
  }

  /**
   * Waits for admitted work, bounded.
   *
   * Bounded because a task that ignores its own deadline must not hold the
   * process open indefinitely. When the bound is reached the remaining work is
   * left to settle on its own; resources close underneath it, which is the
   * failure that task already earned by outliving its budget.
   */
  async #awaitLanesIdle(): Promise<void> {
    const deadline = this.#clock.now() + this.#drainTimeoutMs;
    for (;;) {
      if (this.#lanes.every((lane) => lane.idle)) return;
      if (this.#clock.now() >= deadline) return;
      await new Promise<void>((resolve) => {
        // Short poll rather than a completion event on every lane: the lane's
        // job is admission, and giving it a shutdown listener would put process
        // lifecycle into a type that otherwise knows nothing about it.
        this.#clock.schedule(DRAIN_POLL_MS, resolve);
      });
    }
  }

  async #closeAll(): Promise<readonly CloseFailure[]> {
    const failures: CloseFailure[] = [];
    // Reverse registration order: a composition registers from the outside in,
    // so releasing from the inside out would close a database while the server
    // in front of it is still able to hand it a request.
    for (const closeable of [...this.#closeables].reverse()) {
      if (closeable.closed) continue;
      closeable.closed = true;
      try {
        await closeable.close();
      } catch (cause: unknown) {
        failures.push({
          resource: closeable.name,
          reason: cause instanceof Error ? cause.name : "unknown_error",
        });
      }
    }
    return failures;
  }
}

/** How often draining re-checks whether the lanes have emptied. */
const DRAIN_POLL_MS = 10;
