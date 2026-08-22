import { AsyncLocalStorage } from "node:async_hooks";

import type { RequestBudget } from "./deadline.js";

interface ActiveRequestExecution {
  readonly budget: RequestBudget;
  readonly signal: AbortSignal;
  resolutionReady: boolean;
}

/** Carries daemon-owned request state through Delivery's protocol handler. */
export class RequestExecutionContext {
  readonly #storage = new AsyncLocalStorage<ActiveRequestExecution>();

  run<T>(
    input: {
      readonly budget: RequestBudget;
      readonly signal: AbortSignal;
    },
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.#storage.run(
      { budget: input.budget, signal: input.signal, resolutionReady: false },
      operation,
    );
  }

  get budget(): RequestBudget | undefined {
    return this.#storage.getStore()?.budget;
  }

  get signal(): AbortSignal | undefined {
    return this.#storage.getStore()?.signal;
  }

  markResolutionReady(): void {
    const execution = this.#storage.getStore();
    if (execution !== undefined) {
      execution.resolutionReady = true;
    }
  }

  assertResponseCanCommit(): void {
    const execution = this.#storage.getStore();
    if (execution?.resolutionReady === true) {
      execution.budget.assertCanAssemble();
    }
  }
}
