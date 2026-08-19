import type { CardSelectionProfile } from "../domain/card-selection-profile.js";

/**
 * Turns Card selection text and query text into vectors.
 *
 * Declared here, by Selection, because Selection is the side that needs the
 * shape — the same rule that put `ApprovedCardCatalog` in this directory. It is
 * deliberately *not* Indexing's `EmbeddingPort` reused, and that is the decision
 * worth stating: a deployment may serve both families from one stateless
 * inference session over one installed model file, and the temptation is
 * therefore to say the two ports are the same port. They are not. The artifact,
 * the digest check and the session are shareable because they are stateless; the
 * profile, the vectors, the index, the rebuild lifecycle and the input limits
 * are per-family and are the things a port carries. A single merged port would
 * make a document profile change silently invalidate Card vectors, and it would
 * make either domain unable to move its own profile without the other's consent.
 *
 * One method, taking a batch. Building a candidate index means embedding every
 * approved Card at once, and a per-text method would turn that into N provider
 * calls that a local ONNX session cannot batch back together.
 */
export interface CardEmbeddingPort {
  /**
   * Which kind of provider this is, so a production profile can refuse one that
   * does not match. `test` is the network-free deterministic adapter and is
   * never valid under a profile that pins an artifact.
   */
  readonly providerKind?: CardEmbeddingProviderKind;
  embed(
    request: CardEmbeddingRequest,
  ): Promise<readonly CardEmbeddingOutput[]>;
}

export type CardEmbeddingProviderKind = "local" | "remote" | "test";

export interface CardEmbeddingInput {
  /**
   * The caller's own name for this text, echoed back on the output.
   *
   * Results are joined by key rather than by position, because a provider that
   * batches, retries or reorders internally would otherwise attach one Card's
   * vector to another Card's record — and nothing downstream could detect it.
   */
  readonly key: string;
  readonly text: string;
}

export interface CardEmbeddingRequest {
  /**
   * The vector space the caller expects. An adapter refuses a profile it was not
   * built for rather than answering in a space of its own.
   */
  readonly profile: CardSelectionProfile;
  readonly inputs: readonly CardEmbeddingInput[];
  readonly signal?: AbortSignal;
}

export interface CardEmbeddingOutput {
  readonly key: string;
  readonly vector: readonly number[];
}

export type CardEmbeddingFaultCode =
  | "embedding_artifact_unavailable"
  | "input_limit_exceeded"
  | "invalid_request"
  | "invalid_response"
  | "provider_unavailable";

/**
 * A failure of the provider itself, as the provider states it.
 *
 * Separate from `ResolveContextFailure` on purpose: whether a request survives
 * an unavailable provider is a *policy* decision made by the caller — degrade to
 * lexical, or refuse the query — and a provider is in no position to make it.
 * The fault says what went wrong; `select-context.ts` decides what it costs.
 */
export class CardEmbeddingFault extends Error {
  readonly code: CardEmbeddingFaultCode;
  readonly retriable: boolean;

  constructor(code: CardEmbeddingFaultCode, retriable: boolean) {
    super(`Card embedding provider failed: ${code}`);
    this.name = "CardEmbeddingFault";
    this.code = code;
    this.retriable = retriable;
  }
}
