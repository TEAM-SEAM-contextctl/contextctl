import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

import {
  EmbeddingProviderFault,
  type DocumentRetrievalEmbeddingProfile,
  type LocalDocumentEmbeddingExecution,
  type LocalDocumentEmbeddingInferenceResource,
} from "@contextctl/ingestion-indexing";
import type {
  LocalEmbeddingWorkerBootstrap,
  LocalEmbeddingWorkerRequest,
  LocalEmbeddingWorkerResponse,
} from "./local-embedding-worker-protocol.js";

const LOCAL_EMBEDDING_WORKER_EXPORT_CONDITION =
  "contextctl-local-embedding-worker";

interface PendingWorkerRequest {
  readonly resolve: (response: LocalEmbeddingWorkerResponse) => void;
  readonly reject: (reason: unknown) => void;
  readonly detach: () => void;
}

/**
 * Daemon-owned proxy for one physical local inference session.
 *
 * It implements only the two domains' minimal resource interfaces, never either
 * embedding port. Their adapters stay in their packages and retain profile,
 * input, output and fault semantics. The worker keeps tokenizer and ONNX work
 * off the daemon event loop and is persistent for the daemon lifetime.
 */
export class WorkerThreadLocalEmbeddingInferenceResource
  implements LocalDocumentEmbeddingInferenceResource
{
  readonly execution: LocalDocumentEmbeddingExecution;
  readonly modelMaxTokens: number;
  readonly #bootstrap: LocalEmbeddingWorkerBootstrap;
  readonly #pending = new Map<number, PendingWorkerRequest>();
  #worker: Worker | undefined;
  #sequence = 0;
  #closed = false;

  constructor(input: {
    readonly artifactDirectory: string;
    readonly profile: DocumentRetrievalEmbeddingProfile;
  }) {
    if (input.profile.execution.kind !== "local") {
      throw new TypeError("local inference worker requires a local profile");
    }
    this.execution = input.profile.execution;
    this.modelMaxTokens = input.profile.modelMaxTokens;
    this.#bootstrap = {
      artifactDirectory: input.artifactDirectory,
      profile: input.profile,
    };
  }

  async ready(): Promise<void> {
    const response = await this.#request({ kind: "ready" });
    if (response.status !== "ready") {
      throw new EmbeddingProviderFault("invalid_response", false);
    }
  }

  async tokenCount(text: string): Promise<number> {
    const response = await this.#request({ kind: "token_count", text });
    if (response.status !== "token_counted") {
      throw new EmbeddingProviderFault("invalid_response", false);
    }
    return response.count;
  }

  async tokenCounts(texts: readonly string[]): Promise<readonly number[]> {
    const response = await this.#request({ kind: "token_counts", texts });
    if (response.status !== "token_counts_counted") {
      throw new EmbeddingProviderFault("invalid_response", false);
    }
    return response.counts;
  }

  async embed(
    texts: readonly string[],
    options: { readonly pooling: "cls" | "mean"; readonly normalize: true },
  ): Promise<{
    readonly dimensions: readonly number[];
    readonly data: readonly number[] | Float32Array;
  }> {
    if (options.normalize !== true) {
      throw new EmbeddingProviderFault("invalid_request", false);
    }
    const response = await this.#request(
      { kind: "embed", texts, pooling: options.pooling },
    );
    if (response.status !== "embedded") {
      throw new EmbeddingProviderFault("invalid_response", false);
    }
    return { dimensions: response.dimensions, data: response.data };
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const failure = new EmbeddingProviderFault("provider_unavailable", true);
    for (const pending of this.#pending.values()) {
      pending.detach();
      pending.reject(failure);
    }
    this.#pending.clear();
    const worker = this.#worker;
    this.#worker = undefined;
    if (worker !== undefined) {
      await worker.terminate();
    }
  }

  async #request(
    request:
      | { readonly kind: "ready" }
      | { readonly kind: "token_count"; readonly text: string }
      | { readonly kind: "token_counts"; readonly texts: readonly string[] }
      | {
          readonly kind: "embed";
          readonly texts: readonly string[];
          readonly pooling: "cls" | "mean";
        },
    signal?: AbortSignal,
  ): Promise<LocalEmbeddingWorkerResponse> {
    if (this.#closed) {
      throw new EmbeddingProviderFault("provider_unavailable", true);
    }
    signal?.throwIfAborted();
    const id = this.#sequence++;
    const message: LocalEmbeddingWorkerRequest = { ...request, id };
    const worker = this.#getWorker();
    return await new Promise<LocalEmbeddingWorkerResponse>((resolve, reject) => {
      const onAbort = (): void => {
        const pending = this.#pending.get(id);
        if (pending === undefined) return;
        this.#pending.delete(id);
        pending.detach();
        reject(signal?.reason);
      };
      this.#pending.set(id, {
        resolve,
        reject,
        detach: () => signal?.removeEventListener("abort", onAbort),
      });
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted === true) {
        onAbort();
        return;
      }
      try {
        worker.postMessage(message);
      } catch (cause: unknown) {
        this.#pending.delete(id);
        signal?.removeEventListener("abort", onAbort);
        reject(cause);
      }
    });
  }

  #getWorker(): Worker {
    if (this.#worker !== undefined) return this.#worker;
    const worker = new Worker(resolveWorkerUrl(), {
      workerData: this.#bootstrap,
      // Keep the public package-root import while selecting the inference-only
      // entry in this isolate. Without it the Worker evaluates the complete
      // Ingestion package, including parsers and stores it can never call.
      execArgv: [
        ...process.execArgv,
        `--conditions=${LOCAL_EMBEDDING_WORKER_EXPORT_CONDITION}`,
      ],
    });
    worker.on("message", (response: LocalEmbeddingWorkerResponse) => {
      const pending = this.#pending.get(response.id);
      if (pending === undefined) return;
      this.#pending.delete(response.id);
      pending.detach();
      if (response.status === "failed") {
        pending.reject(
          new EmbeddingProviderFault(response.code, response.retriable),
        );
      } else {
        pending.resolve(response);
      }
    });
    worker.on("error", (cause) => {
      this.#failPending(cause);
    });
    worker.on("exit", (code) => {
      if (!this.#closed) {
        this.#failPending(
          new Error(`local embedding worker exited with code ${String(code)}`),
        );
      }
      if (this.#worker === worker) this.#worker = undefined;
    });
    this.#worker = worker;
    return worker;
  }

  #failPending(cause: unknown): void {
    const failure =
      cause instanceof EmbeddingProviderFault
        ? cause
        : new EmbeddingProviderFault("provider_unavailable", true);
    for (const pending of this.#pending.values()) {
      pending.detach();
      pending.reject(failure);
    }
    this.#pending.clear();
  }
}

function resolveWorkerUrl(): URL {
  const sibling = new URL("./local-embedding-worker.js", import.meta.url);
  if (existsSync(fileURLToPath(sibling))) return sibling;
  // Vitest resolves `../src/*.js` imports to TypeScript sources. External
  // integration runs after `npm run build`, so source-mode tests can execute
  // the same emitted worker the packaged daemon uses.
  return new URL("../../dist/runtime/local-embedding-worker.js", import.meta.url);
}
