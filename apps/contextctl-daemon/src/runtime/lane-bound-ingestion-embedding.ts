import {
  EmbeddingProviderFault,
  type EmbeddingPort,
  type EmbeddingProfile,
  type EmbeddingProviderKind,
  type EmbeddingProviderRequest,
  type EmbeddingProviderOutput,
} from "@contextctl/ingestion-indexing";

import {
  AdmissionLane,
  LaneClosedError,
  LaneOverloadedError,
} from "./admission.js";

/**
 * Applies Ingestion's batch ceiling without placing document queries behind it.
 *
 * The same concrete provider may serve publication and managed-search query
 * embeddings. Wrapping the provider globally would let a long publication use
 * the capacity reserved for Resolve, so only the reference handed to the
 * publication runtime is wrapped. Profile metadata is forwarded unchanged;
 * vector-family binding still validates against the owning adapter.
 */
export class LaneBoundIngestionEmbedding implements EmbeddingPort {
  readonly providerKind?: EmbeddingProviderKind;
  readonly embeddingProfile?: EmbeddingProfile;
  readonly #inner: EmbeddingPort;
  readonly #lane: AdmissionLane;

  constructor(inner: EmbeddingPort, lane: AdmissionLane) {
    this.#inner = inner;
    this.#lane = lane;
    if (inner.providerKind !== undefined) {
      this.providerKind = inner.providerKind;
    }
    if (inner.embeddingProfile !== undefined) {
      this.embeddingProfile = inner.embeddingProfile;
    }
  }

  async embed(
    request: EmbeddingProviderRequest,
  ): Promise<readonly EmbeddingProviderOutput[]> {
    try {
      return await this.#lane.run(
        async (signal) =>
          await this.#inner.embed({
            profile: request.profile,
            inputs: request.inputs,
            signal,
          }),
        { signal: request.signal },
      );
    } catch (cause: unknown) {
      if (cause instanceof LaneOverloadedError) {
        throw new EmbeddingProviderFault("rate_limited", true);
      }
      if (cause instanceof LaneClosedError) {
        throw new EmbeddingProviderFault("provider_unavailable", true);
      }
      throw cause;
    }
  }
}
