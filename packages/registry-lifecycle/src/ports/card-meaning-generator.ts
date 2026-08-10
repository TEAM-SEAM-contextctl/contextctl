import type { PublishedFact, PublishedSourceCoordinate } from "@contextctl/contracts";

import type { CardMeaning } from "../domain/context-card.js";

/** Observed input a generator may describe. Carries no raw source payload. */
export interface CardMeaningRequest {
  readonly coordinate: PublishedSourceCoordinate;
  readonly evidence: readonly PublishedFact[];
}

/**
 * Produces the expression layer of a Card — description, representative
 * questions, aliases, keywords. Typically LLM-backed, so its output is never
 * trusted: `groundCardVersion` re-checks it against the observed source before
 * a version may be validated.
 *
 * The port stays provider-agnostic. An implementation that needs an endpoint,
 * a model name, or a credential belongs in the daemon, which owns
 * configuration and secrets; one that needs none of those can live beside this
 * port, the way Selection keeps its own fixture adapters in `infrastructure/`.
 */
export interface CardMeaningGenerator {
  generate(request: CardMeaningRequest): Promise<CardMeaning>;
}
