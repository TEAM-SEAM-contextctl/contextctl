import {
  getCurrentCardVersion,
  type CardId,
  type CardVersionId,
} from "./card-version.js";
import type {
  CardMeaning,
  CardPolicy,
  ContextCard,
} from "./context-card.js";
import type { RetrievalScope } from "./retrieval-scope.js";

/**
 * One approved Card as consumers see it.
 *
 * This is the catalog read model Registry publishes: meaning, search range, and
 * policy, with nothing of how Registry got there. Version history, validation
 * states, and lineage stay behind the boundary, so a consumer cannot come to
 * depend on Registry's storage or lifecycle internals.
 *
 * Named apart from Selection's `ApprovedCard` on purpose — both appear in the
 * daemon adapter that translates between them, and one vocabulary must not
 * silently stand in for the other.
 */
export interface CardCatalogEntry {
  readonly cardId: CardId;
  /** The version that is current, and therefore the one being served. */
  readonly versionId: CardVersionId;
  readonly meaning: CardMeaning;
  readonly policy: CardPolicy;
  readonly scopes: readonly RetrievalScope[];
}

/**
 * Projects a Card into the catalog, or nothing if it is not serving.
 *
 * A Card with no current version has either never been approved or been
 * withdrawn; either way it must not appear in the catalog.
 */
export function toCardCatalogEntry(
  card: ContextCard,
): CardCatalogEntry | undefined {
  const current = getCurrentCardVersion(card.versions);
  if (current === undefined) {
    return undefined;
  }

  return {
    cardId: card.id,
    versionId: current.id,
    meaning: card.meaning,
    policy: card.policy,
    scopes: current.scopes,
  };
}
