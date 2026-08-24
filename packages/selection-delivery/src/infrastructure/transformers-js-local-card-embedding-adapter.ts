import { canonicalJson } from "../domain/canonical-digest.js";
import {
  assertValidCardSelectionProfile,
  cardSelectionProfilesMatch,
  cardSelectionVectorMatchesProfile,
  isCardSelectionEmbeddingProfile,
  type CardSelectionEmbeddingProfile,
  type LocalCardEmbeddingExecution,
} from "../domain/card-selection-profile.js";
import {
  CardEmbeddingFault,
  type CardEmbeddingFaultCode,
  type CardEmbeddingOutput,
  type CardEmbeddingPort,
  type CardEmbeddingRequest,
} from "../ports/card-embedding.js";

/**
 * Minimal, stateless inference resource consumed by Selection's local adapter.
 *
 * A composition root may inject the same physical object into the document
 * adapter when the execution records match. This is deliberately not either
 * domain's embedding port: profile binding, request validation, pooling,
 * vector validation and fault translation remain here in Selection.
 */
export interface LocalCardEmbeddingInferenceResource {
  readonly execution: LocalCardEmbeddingExecution;
  /** The tokenizer limit of the loaded model, independent of product admission. */
  readonly modelMaxTokens: number;
  tokenCount(text: string): number | Promise<number>;
  /** Optional batch form used by out-of-process resources to avoid one IPC hop per text. */
  tokenCounts?(
    texts: readonly string[],
  ): readonly number[] | Promise<readonly number[]>;
  embed(
    texts: readonly string[],
    options: {
      readonly pooling: "cls" | "mean";
      readonly normalize: true;
    },
  ): Promise<{
    readonly dimensions: readonly number[];
    readonly data: readonly number[];
  }>;
}

export interface TransformersJsLocalCardEmbeddingAdapterOptions {
  readonly inferenceResource: LocalCardEmbeddingInferenceResource;
  readonly profile: CardSelectionEmbeddingProfile;
  /** The most inputs one physical inference call may carry. Defaults to 32. */
  readonly maxBatchSize?: number;
}

const DEFAULT_MAX_BATCH_SIZE = 32;
const MAX_CONFIGURED_BATCH_SIZE = 2_048;
const MAX_LOGICAL_INPUTS = 10_000;

/** Selection-owned local adapter over a verified, composition-owned session. */
export class TransformersJsLocalCardEmbeddingAdapter
  implements CardEmbeddingPort
{
  readonly providerKind = "local" as const;
  readonly profile: CardSelectionEmbeddingProfile;

  readonly #resource: LocalCardEmbeddingInferenceResource;
  readonly #maxBatchSize: number;

  constructor(options: TransformersJsLocalCardEmbeddingAdapterOptions) {
    assertValidCardSelectionProfile(options.profile);
    if (
      !isCardSelectionEmbeddingProfile(options.profile) ||
      options.profile.execution.kind !== "local"
    ) {
      throw new TypeError("local Card embedding adapter requires a local profile");
    }
    if (
      canonicalJson(options.inferenceResource.execution) !==
      canonicalJson(options.profile.execution)
    ) {
      throw new TypeError(
        "local Card embedding inference resource does not match the configured execution",
      );
    }
    if (
      !Number.isSafeInteger(options.inferenceResource.modelMaxTokens) ||
      options.inferenceResource.modelMaxTokens <= 0
    ) {
      throw new TypeError("local Card embedding resource has an invalid token limit");
    }
    const maxBatchSize = options.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE;
    if (
      !Number.isSafeInteger(maxBatchSize) ||
      maxBatchSize <= 0 ||
      maxBatchSize > MAX_CONFIGURED_BATCH_SIZE
    ) {
      throw new TypeError("local Card embedding batch size is invalid");
    }
    this.profile = freezeProfile(options.profile);
    this.#resource = options.inferenceResource;
    this.#maxBatchSize = maxBatchSize;
  }

  /** Identity proof for a composition root deciding physical-session sharing. */
  usesInferenceResource(resource: LocalCardEmbeddingInferenceResource): boolean {
    return this.#resource === resource;
  }

  async embed(
    request: CardEmbeddingRequest,
  ): Promise<readonly CardEmbeddingOutput[]> {
    request.signal?.throwIfAborted();
    if (!cardSelectionProfilesMatch(request.profile, this.profile)) {
      throw new CardEmbeddingFault("invalid_request", false);
    }
    if (request.inputs.length === 0) return [];
    if (
      request.inputs.length > MAX_LOGICAL_INPUTS ||
      new Set(request.inputs.map((input) => input.key)).size !==
        request.inputs.length ||
      request.inputs.some(
        (input) => input.key.trim() === "" || input.text.trim() === "",
      )
    ) {
      throw new CardEmbeddingFault("invalid_request", false);
    }

    for (let offset = 0; offset < request.inputs.length; offset += this.#maxBatchSize) {
      const inputs = request.inputs.slice(offset, offset + this.#maxBatchSize);
      let tokenCounts: readonly number[];
      try {
        tokenCounts = await withAbort(
          this.#tokenCounts(inputs.map((input) => input.text)),
          request.signal,
        );
      } catch (cause: unknown) {
        if (request.signal?.aborted) throw cause;
        throw toCardEmbeddingFault(cause, "invalid_request", false);
      }
      if (
        tokenCounts.length !== inputs.length ||
        tokenCounts.some((count) => !Number.isSafeInteger(count) || count <= 0)
      ) {
        throw new CardEmbeddingFault("invalid_request", false);
      }
      if (tokenCounts.some((count) => count > this.#resource.modelMaxTokens)) {
        throw new CardEmbeddingFault("input_limit_exceeded", false);
      }
    }

    const pooling = this.profile.pooling;
    if (pooling === "provider_defined") {
      throw new CardEmbeddingFault("invalid_request", false);
    }
    const outputs: CardEmbeddingOutput[] = [];
    for (let offset = 0; offset < request.inputs.length; offset += this.#maxBatchSize) {
      request.signal?.throwIfAborted();
      const inputs = request.inputs.slice(offset, offset + this.#maxBatchSize);
      outputs.push(...(await this.#embedBatch(inputs, pooling, request.signal)));
    }
    return outputs;
  }

  async #tokenCounts(texts: readonly string[]): Promise<readonly number[]> {
    if (this.#resource.tokenCounts !== undefined) {
      return await this.#resource.tokenCounts(texts);
    }
    const counts: number[] = [];
    for (const text of texts) {
      counts.push(await this.#resource.tokenCount(text));
    }
    return counts;
  }

  async #embedBatch(
    inputs: CardEmbeddingRequest["inputs"],
    pooling: "cls" | "mean",
    signal?: AbortSignal,
  ): Promise<readonly CardEmbeddingOutput[]> {
    let tensor;
    try {
      tensor = await withAbort(
        this.#resource.embed(
          inputs.map((input) => input.text),
          { pooling, normalize: true },
        ),
        signal,
      );
    } catch (cause: unknown) {
      if (signal?.aborted) throw cause;
      throw toCardEmbeddingFault(cause, "provider_unavailable", true);
    }
    if (
      tensor.dimensions.length !== 2 ||
      tensor.dimensions[0] !== inputs.length ||
      tensor.dimensions[1] !== this.profile.dimensions ||
      tensor.data.length !== inputs.length * this.profile.dimensions
    ) {
      throw new CardEmbeddingFault("invalid_response", false);
    }
    return inputs.map((input, index) => {
      const vector = tensor.data.slice(
        index * this.profile.dimensions,
        (index + 1) * this.profile.dimensions,
      );
      if (!cardSelectionVectorMatchesProfile(this.profile, vector)) {
        throw new CardEmbeddingFault("invalid_response", false);
      }
      return { key: input.key, vector };
    });
  }
}

function toCardEmbeddingFault(
  cause: unknown,
  fallback: CardEmbeddingFaultCode,
  retriable: boolean,
): CardEmbeddingFault {
  if (cause instanceof CardEmbeddingFault) return cause;
  if (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    "retriable" in cause
  ) {
    const code = cause.code;
    const known: readonly CardEmbeddingFaultCode[] = [
      "authentication_failed",
      "embedding_artifact_unavailable",
      "input_limit_exceeded",
      "invalid_request",
      "invalid_response",
      "provider_unavailable",
      "rate_limited",
    ];
    if (
      typeof code === "string" &&
      known.includes(code as CardEmbeddingFaultCode) &&
      typeof cause.retriable === "boolean"
    ) {
      return new CardEmbeddingFault(
        code as CardEmbeddingFaultCode,
        cause.retriable,
      );
    }
  }
  return new CardEmbeddingFault(fallback, retriable);
}

function freezeProfile(
  profile: CardSelectionEmbeddingProfile,
): CardSelectionEmbeddingProfile {
  return Object.freeze({
    ...structuredClone(profile),
    execution: Object.freeze({ ...profile.execution }),
    admissionLimits: Object.freeze({ ...profile.admissionLimits }),
  });
}

async function withAbort<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (signal === undefined) return await promise;
  signal.throwIfAborted();
  return await new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}
