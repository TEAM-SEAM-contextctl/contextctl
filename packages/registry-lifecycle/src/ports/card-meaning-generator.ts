import type {
  PublishedFact,
  PublishedSourceCoordinate,
} from "@contextctl/contracts";

import type { CardMeaning, CardMeaningOrigin } from "../domain/card-meaning.js";

/**
 * Observed input a generator may describe. Carries no raw source payload.
 *
 * `facts` are the bounded, allowlisted facts Publication v2 delivers. Their
 * names come from a closed vocabulary, which is what lets grounding check a
 * generated identifier against something rather than against anything.
 */
export interface CardMeaningRequest {
  readonly coordinate: PublishedSourceCoordinate;
  readonly facts: readonly PublishedFact[];
}

/**
 * Produces the expression layer of a Card — description, representative
 * questions, aliases, keywords. Typically LLM-backed, so its output is never
 * trusted: `groundCardVersion` re-checks it against the observed source before
 * a version may be validated.
 *
 * The port stays provider-agnostic. Implementations live in `infrastructure/`
 * beside it, including the ones that call a model over the network: the daemon
 * owns loading configuration and resolving credentials, and an adapter that
 * takes those as constructor arguments never learns where they came from. It
 * is the same split as `SqliteCardStore`, which writes to a database the
 * daemon opened.
 */
/**
 * A meaning together with what produced it.
 *
 * The origin travels with the text rather than being logged beside it, because
 * the question it answers — "what wrote the words on this version" — is asked
 * per version, at review time, long after any log has rotated.
 */
export interface GeneratedCardMeaning {
  readonly meaning: CardMeaning;
  readonly origin: CardMeaningOrigin;
}

export interface CardMeaningGenerator {
  generate(request: CardMeaningRequest): Promise<GeneratedCardMeaning>;
}
