import {
  cardSelectionProfilesMatch,
  isCardSelectionEmbeddingProfile,
  type CardSelectionProfile,
} from "../domain/card-selection-profile.js";

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
  /**
   * The exact vector family this provider serves.
   *
   * Kind alone is not a binding: two remote endpoints, or two local artifacts,
   * report the same kind and produce incompatible vectors. A production
   * adapter states the whole profile it was built for, and composition compares
   * it field for field with the profile the index is keyed on before anything
   * is embedded — see `assertCardEmbeddingProviderBinding`. A test double may
   * omit it, and is then bindable to nothing but a test profile.
   */
  readonly profile?: CardSelectionProfile;
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

/**
 * Why a provider could not answer.
 *
 * `authentication_failed` and `rate_limited` are facts about a remote
 * provider's account and quota. They are in this vocabulary because a Card
 * selection can be served by a remote endpoint, and an operator diagnosing a
 * 401 needs to see a 401 rather than a generic unavailability — the two are
 * fixed in different places. A local provider never raises either.
 */
export type CardEmbeddingFaultCode =
  | "authentication_failed"
  | "embedding_artifact_unavailable"
  | "input_limit_exceeded"
  | "invalid_request"
  | "invalid_response"
  | "provider_unavailable"
  | "rate_limited";

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

/**
 * Refuses a provider that is not bound to exactly this profile.
 *
 * Two checks, both required. The kind has to be the kind the profile's
 * execution declares — `test` for a profile that pins no artifact — so hash
 * vectors are never served under a model's name. And the provider has to state
 * a profile that matches this one field for field, so two providers of one
 * kind cannot be swapped for each other: a local adapter over a different
 * artifact digest, or a remote endpoint serving a different model, would
 * produce vectors the candidate index compares as if they were comparable.
 *
 * Checked where the graph is assembled rather than on the first query, so a
 * wrong binding ends the assembly instead of producing an index nothing can be
 * scored against.
 */
export function assertCardEmbeddingProviderBinding(
  profile: CardSelectionProfile,
  provider: CardEmbeddingPort,
): void {
  const expected: CardEmbeddingProviderKind = isCardSelectionEmbeddingProfile(profile)
    ? profile.execution.kind
    : "test";
  if (provider.providerKind !== expected) {
    throw new TypeError(
      `Card selection profile ${profile.id} requires a ${expected} provider, received ${String(provider.providerKind)}`,
    );
  }
  if (provider.profile === undefined) {
    throw new TypeError(
      `Card selection profile ${profile.id} requires a provider that states the profile it serves`,
    );
  }
  if (!cardSelectionProfilesMatch(provider.profile, profile)) {
    throw new TypeError(
      `Card selection profile ${profile.id} does not match the profile the provider serves (${provider.profile.id})`,
    );
  }
}
