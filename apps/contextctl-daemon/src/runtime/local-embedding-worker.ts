import { parentPort, workerData } from "node:worker_threads";

import {
  EmbeddingProviderFault,
  loadLocalDocumentEmbeddingInferenceResource,
} from "@contextctl/ingestion-indexing";

import {
  postLocalEmbeddingWorkerResponse,
  type LocalEmbeddingWorkerBootstrap,
  type LocalEmbeddingWorkerRequest,
  type LocalEmbeddingWorkerResponse,
} from "./local-embedding-worker-protocol.js";

if (parentPort === null) {
  throw new Error("the local embedding worker requires a parent port");
}

const port = parentPort;
const bootstrap = workerData as LocalEmbeddingWorkerBootstrap;
const resource = loadLocalDocumentEmbeddingInferenceResource({
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
      await resource;
      post({ id: request.id, status: "ready" });
      return;
    }
    const loaded = await resource;
    if (request.kind === "token_count") {
      const count = await loaded.tokenCount(request.text);
      post({ id: request.id, status: "token_counted", count });
      return;
    }
    if (request.kind === "token_counts") {
      const counts = await Promise.all(
        request.texts.map(async (text) => await loaded.tokenCount(text)),
      );
      post({ id: request.id, status: "token_counts_counted", counts });
      return;
    }
    // Native inference is not safely pre-emptible. The parent may stop waiting,
    // but this worker lets the call reach its honest completion boundary before
    // accepting another message.
    const tensor = await loaded.embed(request.texts, {
      pooling: request.pooling,
      normalize: true,
    });
    post({
      id: request.id,
      status: "embedded",
      dimensions: tensor.dimensions,
      data: tensor.data,
    });
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
  postLocalEmbeddingWorkerResponse(port, response);
}
