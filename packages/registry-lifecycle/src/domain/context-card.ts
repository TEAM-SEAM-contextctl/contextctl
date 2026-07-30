import {
  createCardVersionHistory,
  type CardId,
  type CardVersion,
  type CardVersionHistory,
} from "./card-version.js";

/** Expression fields an LLM may generate; grounded against Observation before use. */
export interface CardMeaning {
  readonly description: string;
  readonly representativeQuestions: readonly string[];
  readonly aliases: readonly string[];
  readonly keywords: readonly string[];
}

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

export type { CardId, CardVersion, CardVersionHistory };
