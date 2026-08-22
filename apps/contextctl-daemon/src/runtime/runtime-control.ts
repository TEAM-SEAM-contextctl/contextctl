import {
  ResolveContextFailure,
  type ContextResolution,
  type ResolveContextApplication,
  type ResolveContextRequest,
} from "@contextctl/selection-delivery";

import type { BudgetedResolveApplication } from "../context-application.js";
import {
  AdmissionLane,
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
  assertDaemonRuntimeProfile,
  DAEMON_RUNTIME_PROFILE_V1,
  type DaemonRuntimeProfile,
} from "./profile.js";

/**
 * The four lanes and the lifecycle that closes them.
 *
 * One object rather than four loose values, because they are only correct
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
  readonly lifecycle: DaemonLifecycle;

  constructor(
    options: {
      readonly profile?: DaemonRuntimeProfile;
      readonly clock?: RuntimeClock;
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
      ],
      drainTimeoutMs: this.profile.deadlines.totalMs,
    });
  }

  /** Every lane's activity, in a fixed order an operator can scan. */
  depths(): readonly LaneDepth[] {
    return [
      this.resolve.depth,
      this.registryConsume.depth,
      this.selectionAssets.depth,
      this.ingestion.depth,
    ];
  }

  /** Opens a request budget at the current instant. Called before admission. */
  openBudget(caller?: AbortSignal | undefined): RequestBudget {
    return RequestBudget.open(this.clock, this.profile.deadlines, caller);
  }
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
 * The budget is opened here, before admission, so queue time is inside the
 * request's total. That ordering is the whole reason this class exists rather
 * than a bare `lane.run(...)` at each entry point — three transports opening
 * their own budgets would be three chances to start the clock in the wrong
 * place.
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
    const budget = this.#control.openBudget();
    try {
      return await this.#control.resolve.run(async () => {
        // Re-checked after the wait. A request that queued past its own total
        // has nothing left to spend, and starting a selection for it would be
        // work done on behalf of a caller who is no longer there.
        budget.assertCanAssemble();
        return await this.#application.resolveWithin(request, budget);
      });
    } catch (cause: unknown) {
      throw toResolveFailure(cause);
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
