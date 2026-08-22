import {
  createCardVersionHistory,
  type CardId,
  type CardVersion,
  type CardVersionHistory,
} from "./card-version.js";

import type { CardMeaning } from "./card-meaning.js";

export type { CardMeaning, CardMeaningOrigin } from "./card-meaning.js";

export interface CardPolicy {
  readonly sensitive: boolean;
  readonly allowedUsage: readonly string[];
}

export interface ContextCard {
  readonly id: CardId;
  readonly meaning: CardMeaning;
  readonly policy: CardPolicy;
  readonly versions: CardVersionHistory;
}

export function createContextCard(
  id: CardId,
  meaning: CardMeaning,
  policy: CardPolicy,
): ContextCard {
  return { id, meaning, policy, versions: createCardVersionHistory(id) };
}

export function withCardVersions(
  card: ContextCard,
  versions: CardVersionHistory,
): ContextCard {
  return { ...card, versions };
}

export function isCardApproved(card: ContextCard): boolean {
  return card.versions.currentVersionId !== undefined;
}

/**
 * The Card with its expression replaced.
 *
 * Used when a promotion moves the current pointer to a version that carries
 * its own meaning: the Card-level meaning is the projection consumers read, so
 * it has to say what the serving version says, not what the first version did.
 */
export function withCardMeaning(
  card: ContextCard,
  meaning: CardMeaning,
): ContextCard {
  return { ...card, meaning };
}

export type { CardId, CardVersion, CardVersionHistory };
