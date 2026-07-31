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
 * a version may be validated. Implementations live in the daemon, which also
 * owns provider configuration; this port stays provider-agnostic.
 */
export interface CardMeaningGenerator {
  generate(request: CardMeaningRequest): Promise<CardMeaning>;
}
