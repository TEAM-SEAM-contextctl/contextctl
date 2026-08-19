import {
  embeddingProfilesMatch,
  embeddingVectorMatchesProfile,
  validateEmbeddingProfile,
  type EmbeddingProfile,
} from "../domain/embedding-profile.js";
import type { ManagedChunk } from "../domain/document-model.js";
import {
  EmbeddingProviderFault,
  type EmbeddingPort,
  type EmbeddingProviderOutput,
} from "../ports/embedding.js";

export interface ChunkEmbedding {
  readonly chunkId: string;
  readonly chunkRevisionId: string;
  readonly contentDigest: string;
  readonly vector: readonly number[];
  readonly origin: "generated" | "reused";
}

export interface ReusableChunkEmbedding {
  readonly chunkRevisionId: string;
  readonly contentDigest: string;
  readonly profile: EmbeddingProfile;
  readonly vector: readonly number[];
}

export interface EmbeddingPipelinePolicy {
  readonly batchSize: number;
  readonly timeoutMs: number;
  readonly maxAttempts: number;
  readonly retryDelayMs: number;
}

export const DEFAULT_EMBEDDING_PIPELINE_POLICY: EmbeddingPipelinePolicy =
  Object.freeze({
    batchSize: 32,
    timeoutMs: 30_000,
    maxAttempts: 3,
    retryDelayMs: 250,
  });

export interface EmbedManagedChunksCommand {
  readonly chunks: readonly ManagedChunk[];
  readonly profile: EmbeddingProfile;
  readonly reusable?: readonly ReusableChunkEmbedding[];
  readonly signal?: AbortSignal;
}

export interface EmbedManagedChunksResult {
  readonly profile: EmbeddingProfile;
  readonly embeddings: readonly ChunkEmbedding[];
  readonly generatedCount: number;
  readonly reusedCount: number;
}

export interface EmbeddingPipelineDependencies {
  readonly provider: EmbeddingPort;
  readonly policy?: EmbeddingPipelinePolicy;
  readonly delay?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

export type EmbeddingPipelineErrorCode =
  | "cancelled"
  | "embedding_artifact_unavailable"
  | "input_limit_exceeded"
  | "invalid_chunk_set"
  | "invalid_profile"
  | "invalid_provider_response"
  | "invalid_reusable_embedding"
  | "provider_failure"
  | "retry_exhausted"
  | "text_measure_profile_mismatch"
  | "timeout";

export class EmbeddingPipelineError extends Error {
  constructor(
    readonly code: EmbeddingPipelineErrorCode,
    readonly chunkRevisionId?: string,
  ) {
    super(`Embedding pipeline failed: ${code}`);
    this.name = "EmbeddingPipelineError";
  }
}

export class EmbeddingPipeline {
  readonly #provider: EmbeddingPort;
  readonly #policy: EmbeddingPipelinePolicy;
  readonly #delay: (
    milliseconds: number,
    signal: AbortSignal,
  ) => Promise<void>;

  constructor(dependencies: EmbeddingPipelineDependencies) {
    this.#provider = dependencies.provider;
    this.#policy = validatePolicy(
      dependencies.policy ?? DEFAULT_EMBEDDING_PIPELINE_POLICY,
    );
    this.#delay = dependencies.delay ?? abortableDelay;
  }

  async embed(
    command: EmbedManagedChunksCommand,
  ): Promise<EmbedManagedChunksResult> {
    if (command.signal?.aborted === true) {
      throw new EmbeddingPipelineError("cancelled");
    }
    validateCommand(command);
    const reusableByRevision = reusableEmbeddingMap(
      command.reusable ?? [],
      command.profile,
    );
    const resultByRevision = new Map<string, ChunkEmbedding>();
    const missing: ManagedChunk[] = [];

    for (const chunk of command.chunks) {
      const reusable = reusableByRevision.get(chunk.revisionId);
      if (reusable === undefined) {
        missing.push(chunk);
        continue;
      }
      if (reusable.contentDigest !== chunk.contentDigest) {
        throw new EmbeddingPipelineError(
          "invalid_reusable_embedding",
          chunk.revisionId,
        );
      }
      resultByRevision.set(
        chunk.revisionId,
        toChunkEmbedding(chunk, reusable.vector, "reused"),
      );
    }

    for (const batch of batches(missing, this.#policy.batchSize)) {
      const outputs = await this.#embedBatch(
        batch,
        command.profile,
        command.signal,
      );
      for (const chunk of batch) {
        const output = outputs.get(chunk.revisionId);
        if (output === undefined) {
          throw new EmbeddingPipelineError(
            "invalid_provider_response",
            chunk.revisionId,
          );
        }
        resultByRevision.set(
          chunk.revisionId,
          toChunkEmbedding(chunk, output.vector, "generated"),
        );
      }
    }

    const embeddings = command.chunks.map((chunk) => {
      const embedding = resultByRevision.get(chunk.revisionId);
      if (embedding === undefined) {
        throw new EmbeddingPipelineError(
          "invalid_provider_response",
          chunk.revisionId,
        );
      }
      return embedding;
    });
    const reusedCount = embeddings.filter(
      (embedding) => embedding.origin === "reused",
    ).length;
    return {
      profile: command.profile,
      embeddings,
      generatedCount: embeddings.length - reusedCount,
      reusedCount,
    };
  }

  async #embedBatch(
    chunks: readonly ManagedChunk[],
    profile: EmbeddingProfile,
    parentSignal?: AbortSignal,
  ): Promise<ReadonlyMap<string, EmbeddingProviderOutput>> {
    for (let attempt = 1; attempt <= this.#policy.maxAttempts; attempt += 1) {
      try {
        const outputs = await runWithDeadline(
          (signal) =>
            this.#provider.embed({
              profile,
              inputs: chunks.map((chunk) => ({
                key: chunk.revisionId,
                text: chunk.text,
              })),
              signal,
            }),
          this.#policy.timeoutMs,
          parentSignal,
        );
        return validateProviderOutputs(outputs, chunks, profile);
      } catch (error) {
        if (error instanceof EmbeddingPipelineError) {
          throw error;
        }
        if (error instanceof OperationInterruptedError) {
          throw new EmbeddingPipelineError(error.reason);
        }
        if (!(error instanceof EmbeddingProviderFault)) {
          throw new EmbeddingPipelineError("provider_failure");
        }
        if (error.code === "invalid_response") {
          throw new EmbeddingPipelineError("invalid_provider_response");
        }
        if (error.code === "embedding_artifact_unavailable") {
          throw new EmbeddingPipelineError("embedding_artifact_unavailable");
        }
        if (error.code === "input_limit_exceeded") {
          throw new EmbeddingPipelineError("input_limit_exceeded");
        }
        if (!error.retriable) {
          throw new EmbeddingPipelineError("provider_failure");
        }
        if (attempt === this.#policy.maxAttempts) {
          throw new EmbeddingPipelineError("retry_exhausted");
        }
        await this.#waitBeforeRetry(parentSignal);
      }
    }
    throw new EmbeddingPipelineError("retry_exhausted");
  }

  async #waitBeforeRetry(parentSignal?: AbortSignal): Promise<void> {
    if (parentSignal?.aborted === true) {
      throw new EmbeddingPipelineError("cancelled");
    }
    const signal = parentSignal ?? new AbortController().signal;
    try {
      await this.#delay(this.#policy.retryDelayMs, signal);
    } catch {
      throw new EmbeddingPipelineError(
        signal.aborted ? "cancelled" : "provider_failure",
      );
    }
  }
}

function validateCommand(command: EmbedManagedChunksCommand): void {
  if (validateEmbeddingProfile(command.profile).length > 0) {
    throw new EmbeddingPipelineError("invalid_profile");
  }
  const revisions = new Set<string>();
  const chunkIds = new Set<string>();
  for (const chunk of command.chunks) {
    if (revisions.has(chunk.revisionId) || chunkIds.has(chunk.id)) {
      throw new EmbeddingPipelineError("invalid_chunk_set", chunk.revisionId);
    }
    revisions.add(chunk.revisionId);
    chunkIds.add(chunk.id);
    if (
      chunk.textMeasureProfileVersion !==
      command.profile.textMeasureProfileVersion
    ) {
      throw new EmbeddingPipelineError(
        "text_measure_profile_mismatch",
        chunk.revisionId,
      );
    }
    if (chunk.tokenCount > command.profile.maxInputTokens) {
      throw new EmbeddingPipelineError(
        "input_limit_exceeded",
        chunk.revisionId,
      );
    }
  }
}

function reusableEmbeddingMap(
  reusable: readonly ReusableChunkEmbedding[],
  profile: EmbeddingProfile,
): ReadonlyMap<string, ReusableChunkEmbedding> {
  const byRevision = new Map<string, ReusableChunkEmbedding>();
  for (const candidate of reusable) {
    if (!embeddingProfilesMatch(candidate.profile, profile)) {
      continue;
    }
    if (byRevision.has(candidate.chunkRevisionId)) {
      throw new EmbeddingPipelineError(
        "invalid_reusable_embedding",
        candidate.chunkRevisionId,
      );
    }
    validateVector(
      candidate.vector,
      profile,
      "invalid_reusable_embedding",
      candidate.chunkRevisionId,
    );
    byRevision.set(candidate.chunkRevisionId, candidate);
  }
  return byRevision;
}

function validateProviderOutputs(
  outputs: readonly EmbeddingProviderOutput[],
  chunks: readonly ManagedChunk[],
  profile: EmbeddingProfile,
): ReadonlyMap<string, EmbeddingProviderOutput> {
  if (outputs.length !== chunks.length) {
    throw new EmbeddingPipelineError("invalid_provider_response");
  }
  const expected = new Set(chunks.map((chunk) => chunk.revisionId));
  const byKey = new Map<string, EmbeddingProviderOutput>();
  for (const output of outputs) {
    if (!expected.has(output.key) || byKey.has(output.key)) {
      throw new EmbeddingPipelineError(
        "invalid_provider_response",
        output.key,
      );
    }
    validateVector(
      output.vector,
      profile,
      "invalid_provider_response",
      output.key,
    );
    byKey.set(output.key, output);
  }
  return byKey;
}

function validateVector(
  vector: readonly number[],
  profile: EmbeddingProfile,
  code: "invalid_provider_response" | "invalid_reusable_embedding",
  chunkRevisionId: string,
): void {
  if (!embeddingVectorMatchesProfile(profile, vector)) {
    throw new EmbeddingPipelineError(code, chunkRevisionId);
  }
}

function toChunkEmbedding(
  chunk: ManagedChunk,
  vector: readonly number[],
  origin: ChunkEmbedding["origin"],
): ChunkEmbedding {
  return {
    chunkId: chunk.id,
    chunkRevisionId: chunk.revisionId,
    contentDigest: chunk.contentDigest,
    vector,
    origin,
  };
}

function batches<T>(values: readonly T[], size: number): readonly T[][] {
  const result: T[][] = [];
  for (let offset = 0; offset < values.length; offset += size) {
    result.push(values.slice(offset, offset + size));
  }
  return result;
}

function validatePolicy(
  policy: EmbeddingPipelinePolicy,
): EmbeddingPipelinePolicy {
  if (
    !Number.isSafeInteger(policy.batchSize) ||
    policy.batchSize <= 0 ||
    !Number.isSafeInteger(policy.timeoutMs) ||
    policy.timeoutMs <= 0 ||
    !Number.isSafeInteger(policy.maxAttempts) ||
    policy.maxAttempts <= 0 ||
    !Number.isSafeInteger(policy.retryDelayMs) ||
    policy.retryDelayMs < 0
  ) {
    throw new RangeError("embedding pipeline policy values are invalid");
  }
  return Object.freeze({ ...policy });
}

class OperationInterruptedError extends Error {
  constructor(readonly reason: "cancelled" | "timeout") {
    super(`Embedding operation ${reason}`);
    this.name = "OperationInterruptedError";
  }
}

async function runWithDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  parentSignal?: AbortSignal,
): Promise<T> {
  if (parentSignal?.aborted === true) {
    throw new OperationInterruptedError("cancelled");
  }
  const controller = new AbortController();
  let interruption: "cancelled" | "timeout" = "timeout";
  const onParentAbort = (): void => {
    interruption = "cancelled";
    controller.abort();
  };
  parentSignal?.addEventListener("abort", onParentAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await Promise.race([
      operation(controller.signal).catch((error: unknown) => {
        if (controller.signal.aborted) {
          throw new OperationInterruptedError(interruption);
        }
        throw error;
      }),
      new Promise<never>((_resolve, reject) => {
        controller.signal.addEventListener(
          "abort",
          () => reject(new OperationInterruptedError(interruption)),
          { once: true },
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener("abort", onParentAbort);
  }
}

function abortableDelay(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(new OperationInterruptedError("cancelled"));
  }
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new OperationInterruptedError("cancelled"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
