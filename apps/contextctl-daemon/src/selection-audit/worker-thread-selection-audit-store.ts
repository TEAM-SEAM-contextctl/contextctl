import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

import type {
  SelectionAuditRecord,
  SelectionAuditStore,
  SelectionAuditSummary,
} from "@contextctl/selection-delivery";

import type { DaemonStateIdentity } from "../runtime/state-identity.js";

interface WorkerResponse {
  readonly requestId?: number;
  readonly status: "ready" | "fulfilled" | "rejected";
  readonly value?: unknown;
  readonly error?: { readonly name: string; readonly message: string };
}

/**
 * Keeps node:sqlite's synchronous calls off the request event loop.
 *
 * One worker owns one connection for the lifetime of a CLI runtime. The
 * Selection deadline can therefore race a real asynchronous boundary instead
 * of arming a timer that SQLite blocks from firing.
 */
export class WorkerThreadSelectionAuditStore implements SelectionAuditStore {
  readonly #worker: Worker;
  readonly #ready: Promise<void>;
  readonly #pending = new Map<
    number,
    {
      readonly resolve: (value: unknown) => void;
      readonly reject: (error: Error) => void;
    }
  >();
  #nextRequestId = 1;
  #closed = false;
  #rejectReady: ((error: Error) => void) | undefined;

  constructor(input: {
    readonly location: string;
    readonly stateIdentity: DaemonStateIdentity;
  }) {
    this.#worker = new Worker(resolveWorkerUrl(), { workerData: input });
    this.#ready = new Promise<void>((resolve, reject) => {
      this.#rejectReady = reject;
      const onFirstMessage = (message: WorkerResponse): void => {
        if (message.status !== "ready") {
          reject(new Error("selection audit worker did not become ready"));
          return;
        }
        this.#rejectReady = undefined;
        resolve();
      };
      this.#worker.once("message", onFirstMessage);
      this.#worker.once("error", reject);
    });
    this.#worker.on("message", (message: WorkerResponse) => {
      if (message.status === "ready" || message.requestId === undefined) return;
      const pending = this.#pending.get(message.requestId);
      if (pending === undefined) return;
      this.#pending.delete(message.requestId);
      if (message.status === "fulfilled") {
        pending.resolve(message.value);
      } else {
        const error = new Error(
          message.error?.message ?? "selection audit worker failed",
        );
        error.name = message.error?.name ?? "Error";
        pending.reject(error);
      }
    });
    this.#worker.on("error", (error) => {
      this.#rejectReady?.(error);
      this.#rejectReady = undefined;
      this.#rejectAll(error);
    });
    this.#worker.on("exit", (code) => {
      if (!this.#closed || code !== 0) {
        const error = new Error(
          `selection audit worker exited with code ${String(code)}`,
        );
        this.#rejectReady?.(error);
        this.#rejectReady = undefined;
        this.#rejectAll(error);
      }
    });
  }

  async append(record: SelectionAuditRecord): Promise<void> {
    await this.#request("append", record);
  }

  async list(limit: number): Promise<readonly SelectionAuditSummary[]> {
    return (await this.#request(
      "list",
      limit,
    )) as readonly SelectionAuditSummary[];
  }

  async find(auditId: string): Promise<SelectionAuditRecord | undefined> {
    return (await this.#request("find", auditId)) as
      | SelectionAuditRecord
      | undefined;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    try {
      await this.#request("close", undefined);
    } finally {
      this.#closed = true;
      await this.#worker.terminate();
    }
  }

  async #request(
    operation: "append" | "list" | "find" | "close",
    value: unknown,
  ): Promise<unknown> {
    if (this.#closed) throw new Error("selection audit worker is closed");
    await this.#ready;
    const requestId = this.#nextRequestId;
    this.#nextRequestId += 1;
    const response = new Promise<unknown>((resolve, reject) => {
      this.#pending.set(requestId, { resolve, reject });
    });
    try {
      this.#worker.postMessage({ requestId, operation, value });
    } catch (error) {
      this.#pending.delete(requestId);
      throw error;
    }
    return await response;
  }

  #rejectAll(error: Error): void {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }
}

function resolveWorkerUrl(): URL {
  const sibling = new URL("./selection-audit-worker.js", import.meta.url);
  if (existsSync(fileURLToPath(sibling))) return sibling;
  return new URL(
    "../../dist/selection-audit/selection-audit-worker.js",
    import.meta.url,
  );
}
