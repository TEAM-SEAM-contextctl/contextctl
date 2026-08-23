import { parentPort, workerData } from "node:worker_threads";

import {
  EmbeddingProviderFault,
  TransformersJsLocalEmbeddingAdapter,
} from "@contextctl/ingestion-indexing";

import type {
  LocalEmbeddingWorkerBootstrap,
  LocalEmbeddingWorkerRequest,
  LocalEmbeddingWorkerResponse,
} from "./local-embedding-worker-protocol.js";

if (parentPort === null) {
  throw new Error("the local embedding worker requires a parent port");
}

const port = parentPort;
const bootstrap = workerData as LocalEmbeddingWorkerBootstrap;
const provider = new TransformersJsLocalEmbeddingAdapter({
  artifactDirectory: bootstrap.artifactDirectory,
  profile: bootstrap.profile,
});

// Message listeners may be called again while an async handler is awaiting.
// Chaining requests here is the final physical-session safety boundary: even if
// a caller is cancelled after native inference starts, the next message cannot
// enter the same ONNX session until that native call really finishes.
let tail = Promise.resolve();
port.on("message", (request: LocalEmbeddingWorkerRequest) => {
  tail = tail.then(
    async () => await handle(request),
    async () => await handle(request),
  );
});

async function handle(request: LocalEmbeddingWorkerRequest): Promise<void> {
  try {
    if (request.kind === "ready") {
      await provider.ready();
      post({ id: request.id, status: "ready" });
      return;
    }
    const outputs = await provider.embed({
      profile: bootstrap.profile,
      inputs: request.inputs,
      // Native inference is not safely pre-emptible. The parent may stop
      // waiting, but this worker deliberately lets the call reach its honest
      // completion boundary before accepting another one.
      signal: new AbortController().signal,
    });
    post({ id: request.id, status: "embedded", outputs });
  } catch (cause: unknown) {
    const fault =
      cause instanceof EmbeddingProviderFault
        ? cause
        : new EmbeddingProviderFault("provider_unavailable", true);
    post({
      id: request.id,
      status: "failed",
      code: fault.code,
      retriable: fault.retriable,
    });
  }
}

function post(response: LocalEmbeddingWorkerResponse): void {
  port.postMessage(response);
}
