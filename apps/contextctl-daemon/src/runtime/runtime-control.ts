import {
  ResolveContextFailure,
  type ContextResolution,
  type DeliveryRequestExecution,
  type ResolveContextApplication,
  type ResolveContextRequest,
} from "@contextctl/selection-delivery";

import type { BudgetedResolveApplication } from "../context-application.js";
import {
  AdmissionLane,
  LaneCancelledError,
  LaneClosedError,
  LaneOverloadedError,
  type LaneDepth,
} from "./admission.js";
import { SystemRuntimeClock, type RuntimeClock } from "./clock.js";
import {
  RequestBudget,
  RequestDeadlineExceededError,
  StageDeadlineExceededError,
} from "./deadline.js";
import { DaemonLifecycle } from "./lifecycle.js";
import {
  EmbeddingRuntimeScheduler,
  type EmbeddingRuntimeSchedulerProfile,
} from "./embedding-runtime-scheduler.js";
import { RequestExecutionContext } from "./request-execution-context.js";
import {
  assertDaemonRuntimeProfile,
  DAEMON_RUNTIME_PROFILE_V1,
  type DaemonRuntimeProfile,
} from "./profile.js";

/**
 * The operating lanes and the lifecycle that closes them.
 *
 * One object rather than loose values, because they are only correct
 * together: the lifecycle has to know every lane in order to stop admitting
 * into all of them at once, and a status surface has to read every lane in
 * order to report a process rather than a part of one.
 */
export class DaemonRuntimeControl {
  readonly profile: DaemonRuntimeProfile;
  readonly clock: RuntimeClock;
  readonly resolve: AdmissionLane;
  readonly registryConsume: AdmissionLane;
  readonly selectionAssets: AdmissionLane;
  readonly ingestion: AdmissionLane;
  readonly ingestionEmbedding: AdmissionLane;
  readonly embeddingScheduler: EmbeddingRuntimeScheduler;
  readonly lifecycle: DaemonLifecycle;
  readonly #requests = new RequestExecutionContext();

  constructor(
    options: {
      readonly profile?: DaemonRuntimeProfile;
      readonly clock?: RuntimeClock;
      readonly embeddingSchedulerProfile?: EmbeddingRuntimeSchedulerProfile;
    } = {},
  ) {
    this.profile = options.profile ?? DAEMON_RUNTIME_PROFILE_V1;
    // Validated even when it is the built-in default, because the default is the
    // one profile nobody re-checks and a bad edit to it would reach every
    // deployment at once.
    assertDaemonRuntimeProfile(this.profile);
    this.clock = options.clock ?? new SystemRuntimeClock();

    this.resolve = new AdmissionLane("resolve", this.profile.lanes.resolve);
    this.registryConsume = new AdmissionLane(
      "registry_consume",
      this.profile.lanes.registryConsume,
    );
    this.selectionAssets = new AdmissionLane(
      "selection_assets",
      this.profile.lanes.selectionAssets,
    );
    this.ingestion = new AdmissionLane("ingestion", this.profile.lanes.ingestion);
    this.ingestionEmbedding = new AdmissionLane(
      "ingestion_embedding",
      this.profile.lanes.ingestionEmbedding,
    );
    this.embeddingScheduler = new EmbeddingRuntimeScheduler({
      clock: this.clock,
      ...(options.embeddingSchedulerProfile === undefined
        ? {}
        : { profile: options.embeddingSchedulerProfile }),
    });

    this.lifecycle = new DaemonLifecycle({
      clock: this.clock,
      // Resolve stops first. It is the lane a caller is waiting on, and refusing
      // it immediately turns a shutdown into a retryable answer rather than a
      // hung connection.
      lanes: [
        this.resolve,
        this.registryConsume,
        this.selectionAssets,
        this.ingestion,
        this.ingestionEmbedding,
      ],
      drainTimeoutMs: this.profile.deadlines.totalMs,
    });
    this.lifecycle.registerCloseable("embedding_scheduler", () => {
      this.embeddingScheduler.stopAccepting();
    });
  }

  /** Every top-level operating area's activity, in a fixed order. */
  depths(): readonly LaneDepth[] {
    return [
      this.resolve.depth,
      this.registryConsume.depth,
      this.selectionAssets.depth,
      this.ingestion.depth,
    ];
  }

  /** Safe, text-free activity snapshot for an in-process status surface. */
  activity() {
    return {
      lifecycle: this.lifecycle.state,
      profileVersion: this.profile.version,
      depths: this.depths(),
      embedding: this.embeddingScheduler.snapshot,
    } as const;
  }

  /** Opens a request budget at transport arrival. Called before admission. */
  openBudget(
    caller?: AbortSignal | undefined,
    startedAt?: number | undefined,
  ): RequestBudget {
    return RequestBudget.open(
      this.clock,
      this.profile.deadlines,
      caller,
      startedAt ?? this.clock.now(),
    );
  }

  async runTransportRequest<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    options: {
      readonly arrivedAt?: number;
      readonly signal?: AbortSignal;
    } = {},
  ): Promise<T> {
    const budget = this.openBudget(options.signal, options.arrivedAt);
    const lifetime = budget.totalSignal();
    try {
      return await this.#requests.run(
        { budget, signal: lifetime.signal },
        () => operation(lifetime.signal),
      );
    } catch (cause: unknown) {
      throw toResolveFailure(cause);
    } finally {
      lifetime.dispose();
    }
  }

  currentRequestBudget(): RequestBudget | undefined {
    return this.#requests.budget;
  }

  currentRequestSignal(): AbortSignal | undefined {
    return this.#requests.signal;
  }

  markResolutionReady(): void {
    this.#requests.markResolutionReady();
  }

  assertResponseCanCommit(): void {
    this.#requests.assertResponseCanCommit();
  }
}

/** Delivery-owned transports call this adapter; daemon keeps every policy. */
export function createDeliveryRequestExecution(
  control: DaemonRuntimeControl,
): DeliveryRequestExecution {
  return {
    maximumInFlightRequests:
      control.profile.lanes.resolve.concurrency +
      control.profile.lanes.resolve.queueDepth +
      1,
    now: () => control.clock.now(),
    runRequest: async (input, operation) =>
      await control.runTransportRequest(operation, {
        arrivedAt: input.arrivedAt,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      }),
    assertResponseCanCommit: () => control.assertResponseCanCommit(),
  };
}

/**
 * The Resolve surface every transport actually calls.
 *
 * A wrapper rather than a change to `DaemonContextApplication`, because the two
 * responsibilities are genuinely separate: the application knows how to answer a
 * query, and this knows whether the process is willing to start one right now.
 * Folding admission into the application would make every focused test of the
 * pipeline go through a queue it is not testing.
 *
 * A Delivery transport opens the budget at byte arrival through the injected
 * execution adapter. Direct application callers, including focused tests, get
 * a budget here immediately before admission. In both paths the same wrapper
 * is the only object allowed to enter the Resolve lane.
 */
export class AdmissionControlledResolve implements ResolveContextApplication {
  readonly #control: DaemonRuntimeControl;
  readonly #application: BudgetedResolveApplication;

  constructor(
    control: DaemonRuntimeControl,
    application: BudgetedResolveApplication,
  ) {
    this.#control = control;
    this.#application = application;
  }

  async resolveContext(
    request: ResolveContextRequest,
  ): Promise<ContextResolution> {
    const transportBudget = this.#control.currentRequestBudget();
    const budget = transportBudget ?? this.#control.openBudget();
    const localLifetime =
      transportBudget === undefined ? budget.totalSignal() : undefined;
    const signal =
      this.#control.currentRequestSignal() ?? localLifetime?.signal;
    try {
      const resolution = await this.#control.resolve.run(
        async () => {
          // Re-checked after the wait. A request that queued past its own total
          // has nothing left to spend, and starting a selection for it would be
          // work done on behalf of a caller who is no longer there.
          budget.assertCanAssemble();
          const resolution = await this.#control.embeddingScheduler.runResolveScope(
            async () =>
              await this.#application.resolveWithin(request, budget),
          );
          // The concrete daemon application checks after assembly too, but the
          // admission boundary must hold for every implementation of this
          // internal port. A late success from a replacement implementation is
          // still a late success and must not reach a transport.
          budget.assertCanAssemble();
          return resolution;
        },
        { ...(signal === undefined ? {} : { signal }) },
      );
      this.#control.markResolutionReady();
      return resolution;
    } catch (cause: unknown) {
      throw toResolveFailure(cause);
    } finally {
      localLifetime?.dispose();
    }
  }
}

/**
 * Translates a runtime refusal into the request-level failure vocabulary.
 *
 * Every transport already knows how to project a `ResolveContextFailure` — HTTP
 * to a status, MCP to `isError`, the CLI to an exit code — so the translation
 * happens once here rather than three times at the edges. A refusal that reached
 * a transport as a raw `LaneOverloadedError` would arrive as an unexpected
 * failure, which says the daemon broke rather than that it is full.
 */
export function toResolveFailure(cause: unknown): unknown {
  if (
    cause instanceof LaneCancelledError &&
    cause.reason instanceof RequestDeadlineExceededError
  ) {
    return new ResolveContextFailure(
      "deadline_exceeded",
      "The request exceeded its time budget.",
    );
  }
  if (cause instanceof LaneOverloadedError || cause instanceof LaneClosedError) {
    return new ResolveContextFailure(
      "overloaded",
      "The daemon is at capacity for query resolution.",
    );
  }
  if (
    cause instanceof RequestDeadlineExceededError ||
    cause instanceof StageDeadlineExceededError
  ) {
    // A stage deadline reaching this point means the stage had no answer to
    // degrade to — selection, which produces the plan everything else needs.
    return new ResolveContextFailure(
      "deadline_exceeded",
      "The request exceeded its time budget.",
    );
  }
  return cause;
}
