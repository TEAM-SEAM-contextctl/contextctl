import { describe, expect, it } from "vitest";

import {
  EmbeddingPipeline,
  EmbeddingProviderFault,
  type EmbeddingPort,
  type EmbeddingProfile,
  type EmbeddingProviderRequest,
  type DocumentRetrievalEmbeddingProfile,
  type ManagedChunk,
  type ReusableChunkEmbedding,
} from "../src/index.js";
import { createManagedChunkFixture } from "./fixtures/document-fixture.js";
import { structuralId } from "./fixtures/root-id-fixture.js";

const profile: EmbeddingProfile = {
  id: "ci-profile",
  version: "1.0.0",
  model: "ci-model-v1",
  dimensions: 3,
  distance: "cosine",
  maxInputTokens: 480,
  textMeasureProfileVersion: "unicode-estimate-v1",
};

describe("Embedding pipeline", () => {
  it("reuses compatible revisions, batches misses, and preserves Chunk order", async () => {
    const chunks = createChunks(5);
    const reusable: ReusableChunkEmbedding = {
      chunkRevisionId: requiredChunk(chunks, 1).revisionId,
      contentDigest: requiredChunk(chunks, 1).contentDigest,
      profile,
      vector: [0.9, 0.8, 0.7],
    };
    const provider = new RecordingEmbeddingPort();
    const pipeline = new EmbeddingPipeline({
      provider,
      policy: {
        batchSize: 2,
        timeoutMs: 100,
        maxAttempts: 2,
        retryDelayMs: 0,
      },
    });

    const result = await pipeline.embed({
      chunks,
      profile,
      reusable: [reusable],
    });

    expect(provider.requests).toHaveLength(2);
    expect(provider.requests.map((request) => request.inputs.length)).toEqual([
      2, 2,
    ]);
    expect(provider.requests.flatMap((request) => request.inputs)).toEqual(
      [chunks[0], chunks[2], chunks[3], chunks[4]].map((chunk) => ({
        key: chunk?.revisionId,
        text: chunk?.text,
      })),
    );
    expect(
      result.embeddings.map((embedding) => embedding.chunkRevisionId),
    ).toEqual(chunks.map((chunk) => chunk.revisionId));
    expect(result.embeddings.map((embedding) => embedding.origin)).toEqual([
      "generated",
      "reused",
      "generated",
      "generated",
      "generated",
    ]);
    expect(result).toMatchObject({ generatedCount: 4, reusedCount: 1 });
  });

  it("does not reuse an embedding from a different profile", async () => {
    const chunks = createChunks(1);
    const chunk = requiredChunk(chunks, 0);
    const provider = new RecordingEmbeddingPort();
    const pipeline = new EmbeddingPipeline({ provider });

    const result = await pipeline.embed({
      chunks,
      profile,
      reusable: [
        {
          chunkRevisionId: chunk.revisionId,
          contentDigest: chunk.contentDigest,
          profile: { ...profile, model: "other-model" },
          vector: [0.1, 0.2, 0.3],
        },
      ],
    });

    expect(provider.requests).toHaveLength(1);
    expect(result.embeddings[0]?.origin).toBe("generated");
  });

  it("rejects input limits and text-measure incompatibility before provider calls", async () => {
    const provider = new RecordingEmbeddingPort();
    const pipeline = new EmbeddingPipeline({ provider });
    const chunk = requiredChunk(createChunks(1), 0);

    await expect(
      pipeline.embed({
        chunks: [{ ...chunk, tokenCount: profile.maxInputTokens + 1 }],
        profile,
      }),
    ).rejects.toMatchObject({ code: "input_limit_exceeded" });
    await expect(
      pipeline.embed({
        chunks: [{ ...chunk, textMeasureProfileVersion: "other-measure" }],
        profile,
      }),
    ).rejects.toMatchObject({ code: "text_measure_profile_mismatch" });
    await expect(
      pipeline.embed({
        chunks: [chunk],
        profile: { ...profile, dimensions: 0 },
      }),
    ).rejects.toMatchObject({ code: "invalid_profile" });
    expect(provider.requests).toEqual([]);
  });

  it("retries transient provider faults and reports exhaustion distinctly", async () => {
    const provider = new FaultingEmbeddingPort(3);
    const pipeline = new EmbeddingPipeline({
      provider,
      policy: {
        batchSize: 4,
        timeoutMs: 100,
        maxAttempts: 3,
        retryDelayMs: 0,
      },
      delay: async () => undefined,
    });

    await expect(
      pipeline.embed({ chunks: createChunks(1), profile }),
    ).rejects.toMatchObject({ code: "retry_exhausted" });
    expect(provider.attempts).toBe(3);
  });

  it("returns the provider result after a transient failure", async () => {
    const provider = new FaultingEmbeddingPort(1);
    const pipeline = new EmbeddingPipeline({
      provider,
      policy: {
        batchSize: 4,
        timeoutMs: 100,
        maxAttempts: 2,
        retryDelayMs: 0,
      },
      delay: async () => undefined,
    });

    const result = await pipeline.embed({ chunks: createChunks(1), profile });

    expect(provider.attempts).toBe(2);
    expect(result.generatedCount).toBe(1);
  });

  it("does not retry a non-retriable provider fault", async () => {
    const provider: EmbeddingPort = {
      embed: async () => {
        throw new EmbeddingProviderFault("authentication_failed", false);
      },
    };
    let delayCalls = 0;
    const pipeline = new EmbeddingPipeline({
      provider,
      delay: async () => {
        delayCalls += 1;
      },
    });

    await expect(
      pipeline.embed({ chunks: createChunks(1), profile }),
    ).rejects.toMatchObject({ code: "provider_failure" });
    expect(delayCalls).toBe(0);
  });

  it("reports timeout and caller cancellation as separate failures", async () => {
    const provider: EmbeddingPort = {
      embed: (request) =>
        new Promise((_resolve, reject) => {
          request.signal.addEventListener(
            "abort",
            () => reject(request.signal.reason),
            { once: true },
          );
        }),
    };
    const pipeline = new EmbeddingPipeline({
      provider,
      policy: {
        batchSize: 1,
        timeoutMs: 5,
        maxAttempts: 1,
        retryDelayMs: 0,
      },
    });

    await expect(
      pipeline.embed({ chunks: createChunks(1), profile }),
    ).rejects.toMatchObject({ code: "timeout" });

    const controller = new AbortController();
    controller.abort();
    await expect(
      pipeline.embed({
        chunks: createChunks(1),
        profile,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: "cancelled" });

    const chunk = requiredChunk(createChunks(1), 0);
    await expect(
      pipeline.embed({
        chunks: [chunk],
        profile,
        reusable: [
          {
            chunkRevisionId: chunk.revisionId,
            contentDigest: chunk.contentDigest,
            profile,
            vector: [0.1, 0.2, 0.3],
          },
        ],
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: "cancelled" });
  });

  it("rejects malformed provider vectors and stale reusable content", async () => {
    const chunk = requiredChunk(createChunks(1), 0);
    const malformed: EmbeddingPort = {
      embed: async (request) => [
        { key: request.inputs[0]?.key ?? "missing", vector: [1, 2] },
      ],
    };
    await expect(
      new EmbeddingPipeline({ provider: malformed }).embed({
        chunks: [chunk],
        profile,
      }),
    ).rejects.toMatchObject({ code: "invalid_provider_response" });

    await expect(
      new EmbeddingPipeline({ provider: new RecordingEmbeddingPort() }).embed({
        chunks: [chunk],
        profile,
        reusable: [
          {
            chunkRevisionId: chunk.revisionId,
            contentDigest: `sha256:${"f".repeat(64)}`,
            profile,
            vector: [0.1, 0.2, 0.3],
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "invalid_reusable_embedding" });
  });

  it("enforces declared L2 semantics for generated and reusable vectors", async () => {
    const chunk = requiredChunk(createChunks(1), 0);
    const unnormalized: EmbeddingPort = {
      embed: async (request) => [
        { key: request.inputs[0]!.key, vector: [1, 1, 1] },
      ],
    };
    await expect(
      new EmbeddingPipeline({ provider: unnormalized }).embed({
        chunks: [chunk],
        profile: productionProfile,
      }),
    ).rejects.toMatchObject({ code: "invalid_provider_response" });

    await expect(
      new EmbeddingPipeline({ provider: unnormalized }).embed({
        chunks: [chunk],
        profile: productionProfile,
        reusable: [
          {
            chunkRevisionId: chunk.revisionId,
            contentDigest: chunk.contentDigest,
            profile: productionProfile,
            vector: [0, 0, 0],
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "invalid_reusable_embedding" });
  });

  it("rejects multiple revisions of one logical Chunk in a single build", async () => {
    const chunk = requiredChunk(createChunks(1), 0);

    await expect(
      new EmbeddingPipeline({ provider: new RecordingEmbeddingPort() }).embed({
        chunks: [chunk, { ...chunk, revisionId: "crv_bbbbbbbb" }],
        profile,
      }),
    ).rejects.toMatchObject({ code: "invalid_chunk_set" });
  });
});

class RecordingEmbeddingPort implements EmbeddingPort {
  readonly requests: EmbeddingProviderRequest[] = [];

  async embed(request: EmbeddingProviderRequest) {
    this.requests.push(request);
    return request.inputs.map((input, index) => ({
      key: input.key,
      vector: [index + 0.1, index + 0.2, index + 0.3],
    }));
  }
}

class FaultingEmbeddingPort implements EmbeddingPort {
  attempts = 0;

  constructor(readonly failures: number) {}

  async embed(request: EmbeddingProviderRequest) {
    this.attempts += 1;
    if (this.attempts <= this.failures) {
      throw new EmbeddingProviderFault("provider_unavailable", true);
    }
    return request.inputs.map((input) => ({
      key: input.key,
      vector: [0.1, 0.2, 0.3],
    }));
  }
}

function createChunks(count: number): readonly ManagedChunk[] {
  const base = requiredChunk(createManagedChunkFixture(), 0);
  return Array.from({ length: count }, (_unused, index) => ({
    ...base,
    id: structuralId("chk", index),
    revisionId: `crv_${String.fromCharCode(97 + index).repeat(8)}`,
    sourceId: `src_${index}`,
    observationId: `obs_${index}`,
    documentId: `doc_${index}`,
    semanticUnitId: structuralId("unit", index),
    ordinal: 0,
  }));
}

function requiredChunk(
  chunks: readonly ManagedChunk[],
  index: number,
): ManagedChunk {
  const chunk = chunks[index];
  if (chunk === undefined) {
    throw new Error(`missing test Chunk at index ${index}`);
  }
  return chunk;
}

const productionProfile: DocumentRetrievalEmbeddingProfile = {
  ...profile,
  modelRevision: "revision-1",
  execution: {
    kind: "remote",
    adapter: "openai-compatible",
    adapterVersion: "1.0.0",
    model: profile.model,
  },
  pooling: "provider_defined",
  normalization: "l2",
  documentInputTransformVersion: "identity-v1",
  queryInputTransformVersion: "identity-v1",
  modelMaxTokens: 512,
  admissionLimit: {
    textMeasureProfileVersion: profile.textMeasureProfileVersion,
    maxUnits: profile.maxInputTokens,
  },
};
