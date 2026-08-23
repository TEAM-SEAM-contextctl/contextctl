import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

import {
  embeddingProfilesMatch,
  EmbeddingProviderFault,
  type DocumentRetrievalEmbeddingProfile,
  type EmbeddingPort,
  type EmbeddingProviderInput,
  type EmbeddingProviderOutput,
  type EmbeddingProviderRequest,
} from "@contextctl/ingestion-indexing";

import type {
  LocalEmbeddingWorkerBootstrap,
  LocalEmbeddingWorkerRequest,
  LocalEmbeddingWorkerResponse,
} from "./local-embedding-worker-protocol.js";

interface PendingWorkerRequest {
  readonly resolve: (response: LocalEmbeddingWorkerResponse) => void;
  readonly reject: (reason: unknown) => void;
  readonly detach: () => void;
}

/**
 * Daemon execution wrapper for Ingestion's local embedding adapter.
 *
 * The worker owns exactly one domain adapter and therefore one tokenizer and
 * ONNX session. Requests and responses still use Ingestion's port unchanged;
 * this wrapper only keeps CPU-heavy tokenization/inference off the daemon event
 * loop. It is persistent for the daemon lifetime, so no per-request process or
 * model-startup cost is introduced.
 */
export class WorkerThreadLocalEmbeddingAdapter implements EmbeddingPort {
  readonly providerKind = "local" as const;
  readonly embeddingProfile: DocumentRetrievalEmbeddingProfile;
  readonly #bootstrap: LocalEmbeddingWorkerBootstrap;
  readonly #pending = new Map<number, PendingWorkerRequest>();
  #worker: Worker | undefined;
  #sequence = 0;
  #closed = false;

  constructor(input: {
    readonly artifactDirectory: string;
    readonly profile: DocumentRetrievalEmbeddingProfile;
  }) {
    this.embeddingProfile = input.profile;
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

  async embed(
    request: EmbeddingProviderRequest,
  ): Promise<readonly EmbeddingProviderOutput[]> {
    request.signal.throwIfAborted();
    if (!embeddingProfilesMatch(request.profile, this.embeddingProfile)) {
      throw new EmbeddingProviderFault("invalid_request", false);
    }
    if (request.inputs.length === 0) return [];
    const response = await this.#request(
      { kind: "embed", inputs: request.inputs },
      request.signal,
    );
    if (response.status !== "embedded") {
      throw new EmbeddingProviderFault("invalid_response", false);
    }
    return response.outputs;
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
    if (worker !== undefined) await worker.terminate();
  }

  async #request(
    request:
      | { readonly kind: "ready" }
      | {
          readonly kind: "embed";
          readonly inputs: readonly EmbeddingProviderInput[];
        },
    signal?: AbortSignal,
  ): Promise<LocalEmbeddingWorkerResponse> {
    if (this.#closed) {
      throw new EmbeddingProviderFault("provider_unavailable", true);
    }
    signal?.throwIfAborted();
    const id = this.#sequence++;
    const message: LocalEmbeddingWorkerRequest =
      request.kind === "ready"
        ? { kind: "ready", id }
        : { kind: "embed", id, inputs: request.inputs };
    const worker = this.#getWorker();
    return await new Promise<LocalEmbeddingWorkerResponse>((resolve, reject) => {
      const onAbort = (): void => {
        const pending = this.#pending.get(id);
        if (pending === undefined) return;
        this.#pending.delete(id);
        pending.detach();
        reject(signal?.reason);
        this.#unrefIfIdle();
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
      worker.ref();
      try {
        worker.postMessage(message);
      } catch (cause: unknown) {
        this.#pending.delete(id);
        signal?.removeEventListener("abort", onAbort);
        reject(cause);
        this.#unrefIfIdle();
      }
    });
  }

  #getWorker(): Worker {
    if (this.#worker !== undefined) return this.#worker;
    const worker = new Worker(resolveWorkerUrl(), {
      workerData: this.#bootstrap,
    });
    worker.unref();
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
      this.#unrefIfIdle();
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
    this.#unrefIfIdle();
  }

  #unrefIfIdle(): void {
    if (this.#pending.size === 0) this.#worker?.unref();
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
