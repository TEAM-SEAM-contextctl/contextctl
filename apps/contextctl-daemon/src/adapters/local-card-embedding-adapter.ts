import {
  EmbeddingProviderFault,
  type EmbeddingPort,
  type EmbeddingProfile,
} from "@contextctl/ingestion-indexing";
import {
  cardSelectionProfilesMatch,
  CardEmbeddingFault,
  type CardEmbeddingFaultCode,
  type CardEmbeddingOutput,
  type CardEmbeddingPort,
  type CardEmbeddingRequest,
  type CardSelectionProfile,
} from "@contextctl/selection-delivery";

/**
 * A `CardEmbeddingPort` served by the inference session the document path
 * already loaded.
 *
 * This class is the whole of the "one session, two families" decision, and it
 * lives here because the daemon is the only place entitled to make it: a domain
 * package may not name another domain package, but the Composition Root already
 * names both. Nothing about ONNX, tokenizers or artifact verification is
 * reimplemented — every one of those lives in Indexing's local adapter, which
 * this delegates to.
 *
 * What is *not* shared is everything that has state or a lifecycle. The port is
 * separate, the profile is separate, the vectors are separate, the index is
 * separate, and the rebuild that follows a Card approval has nothing to do with
 * the rebuild that follows a document publication. What is shared is one
 * stateless thing: a loaded model file answering `embed`. Loading it twice would
 * hold two copies of the same 390MB of weights in one process for no difference
 * in output — the artifact digest, the precision and the pooling are identical
 * by construction, which is exactly the condition under which sharing is sound.
 *
 * The two profiles therefore both appear on the constructor. `session` is the
 * profile the underlying provider was built for and will refuse anything else
 * under; `card` is the profile this port answers under and the one the candidate
 * index is keyed on. They describe the same weights and different vector
 * families, and the day the Card family moves to another model, only `card` and
 * the provider behind it change.
 */
export interface LocalCardEmbeddingAdapterOptions {
  /** The provider holding the loaded session. Never constructed here. */
  readonly provider: EmbeddingPort;
  /** Exactly the profile that provider accepts; it compares field for field. */
  readonly session: EmbeddingProfile;
  readonly card: CardSelectionProfile;
}

export class LocalCardEmbeddingAdapter implements CardEmbeddingPort {
  readonly providerKind = "local" as const;
  /** The Card family this port serves — `card` as given, stated for binding. */
  readonly profile: CardSelectionProfile;
  readonly #provider: EmbeddingPort;
  readonly #session: EmbeddingProfile;
  readonly #card: CardSelectionProfile;

  constructor(options: LocalCardEmbeddingAdapterOptions) {
    if (options.session.dimensions !== options.card.dimensions) {
      // Checked at construction rather than at the first query: the two
      // profiles name one set of weights, so a disagreement about how wide a
      // vector is means the graph was assembled wrong, and a graph assembled
      // wrong should not start.
      throw new TypeError(
        `card profile ${options.card.id} declares ${options.card.dimensions} dimensions where the session profile declares ${options.session.dimensions}`,
      );
    }
    this.#provider = options.provider;
    this.#session = options.session;
    this.#card = options.card;
    this.profile = options.card;
  }

  async embed(
    request: CardEmbeddingRequest,
  ): Promise<readonly CardEmbeddingOutput[]> {
    if (!cardSelectionProfilesMatch(request.profile, this.#card)) {
      // The caller asked for a vector space this port does not serve. Answering
      // in the space it does serve would put two families' vectors in one index.
      throw new CardEmbeddingFault("invalid_request", false);
    }
    if (request.inputs.length === 0) {
      return [];
    }

    // Indexing's port requires a signal; an unabortable request supplies one
    // that is never triggered rather than a cast.
    const signal = request.signal ?? new AbortController().signal;
    try {
      const outputs = await this.#provider.embed({
        profile: this.#session,
        inputs: request.inputs.map((input) => ({
          key: input.key,
          text: input.text,
        })),
        signal,
      });
      // Copied field by field rather than returned as-is: the two output types
      // agree today, and a field added to Indexing's would otherwise cross into
      // a Card record without anyone deciding it should.
      return outputs.map((output) => ({
        key: output.key,
        vector: output.vector,
      }));
    } catch (cause: unknown) {
      if (signal.aborted) {
        throw cause;
      }
      throw toCardEmbeddingFault(cause);
    }
  }
}

/**
 * Restates Indexing's fault in this port's own vocabulary.
 *
 * The two vocabularies name the same seven conditions today, so the mapping is
 * the identity — written out rather than cast, because the two types are owned
 * by two packages and a code added to one does not appear in the other until
 * someone decides it should. `authentication_failed` and `rate_limited` used to
 * be folded into `provider_unavailable` on the grounds that a Card selection
 * had no remote binding to have either; Selection's port now admits a remote
 * provider, so they travel under their own names. A local session never
 * raises them, which this function does not need to know.
 *
 * Anything that is not Indexing's own fault becomes `provider_unavailable` and
 * is marked retriable, because an arbitrary exception out of a model session is
 * most often a load that has not finished or a resource that was briefly gone —
 * and the caller's degradation policy, not this function, decides what that
 * costs.
 */
function toCardEmbeddingFault(cause: unknown): CardEmbeddingFault {
  if (!(cause instanceof EmbeddingProviderFault)) {
    return new CardEmbeddingFault("provider_unavailable", true);
  }
  const mapped: Record<string, CardEmbeddingFaultCode> = {
    authentication_failed: "authentication_failed",
    embedding_artifact_unavailable: "embedding_artifact_unavailable",
    input_limit_exceeded: "input_limit_exceeded",
    invalid_request: "invalid_request",
    invalid_response: "invalid_response",
    provider_unavailable: "provider_unavailable",
    rate_limited: "rate_limited",
  };
  return new CardEmbeddingFault(
    mapped[cause.code] ?? "provider_unavailable",
    cause.retriable,
  );
}
