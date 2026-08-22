import type { CardMeaning } from "./card-meaning.js";
import { CardVersionInvariantError } from "./errors.js";
import type { GroundingReport } from "./fact-grounding.js";
import type { CardLineage } from "./lineage.js";
import type { RetrievalScope } from "./retrieval-scope.js";

export type CardId = string;
export type CardVersionId = string;

/** Deterministic evidence-check outcome for one Card Version. Never LLM-decided. */
export type CardValidationState = "draft" | "validated" | "rejected";

/**
 * What changed against the version before this one, computed at intake and
 * stored so an operator's approval screen can show the diff without loading
 * two versions and comparing them by eye.
 */
export interface MeaningChangeComparison {
  readonly previousVersionId: CardVersionId;
  /** Meaning fields whose value differs from the previous version. */
  readonly changedFields: readonly (keyof CardMeaning)[];
  /** Facts that were covered before and no longer are — regressions first. */
  readonly coverageLost: readonly string[];
  /** Facts newly covered by this version's expression. */
  readonly coverageGained: readonly string[];
}

export interface CardVersion {
  readonly id: CardVersionId;
  readonly cardId: CardId;
  readonly lineage: CardLineage;
  readonly scopes: readonly RetrievalScope[];
  readonly validationState: CardValidationState;
  readonly createdAt: string;
  /**
   * The expression this version was validated with. Optional only because
   * rows written before grounding-v1 have none; every new version carries it.
   */
  readonly meaning?: CardMeaning | undefined;
  /** The grounding report that decided this version's validation state. */
  readonly grounding?: GroundingReport | undefined;
  readonly changeFromPrevious?: MeaningChangeComparison | undefined;
}

/** Append-only Card Version history with a current pointer to the last-known-good version. */
export interface CardVersionHistory {
  readonly cardId: CardId;
  readonly versions: readonly CardVersion[];
  readonly currentVersionId: CardVersionId | undefined;
}

export function createCardVersionHistory(cardId: CardId): CardVersionHistory {
  return { cardId, versions: [], currentVersionId: undefined };
}

/** Appends a new Card Version. Existing versions are never modified or removed. */
export function appendCardVersion(
  history: CardVersionHistory,
  version: CardVersion,
): CardVersionHistory {
  if (version.cardId !== history.cardId) {
    throw new CardVersionInvariantError(
      `card version ${version.id} does not belong to card ${history.cardId}`,
    );
  }
  if (history.versions.some((existing) => existing.id === version.id)) {
    throw new CardVersionInvariantError(
      `card version ${version.id} already exists and cannot be replaced`,
    );
  }
  return { ...history, versions: [...history.versions, version] };
}

/**
 * Moves the current pointer to a validated version, forward or as a rollback.
 * A version that failed validation can never become current, so the
 * last-known-good version keeps serving until a validated replacement exists.
 */
export function promoteCardVersion(
  history: CardVersionHistory,
  versionId: CardVersionId,
): CardVersionHistory {
  const target = history.versions.find((version) => version.id === versionId);
  if (target === undefined) {
    throw new CardVersionInvariantError(
      `card version ${versionId} is not part of card ${history.cardId} history`,
    );
  }
  if (target.validationState !== "validated") {
    throw new CardVersionInvariantError(
      `card version ${versionId} has validation state ${target.validationState} and cannot become current`,
    );
  }
  return { ...history, currentVersionId: target.id };
}

/**
 * Clears the current pointer so the Card stops serving. The version history is
 * left intact: withdrawing is a pointer move, not a deletion, so the trail of
 * what was once current stays auditable and can be promoted again later.
 */
export function withdrawCurrentVersion(
  history: CardVersionHistory,
): CardVersionHistory {
  return { ...history, currentVersionId: undefined };
}

/**
 * Whether `versionId` sits before the current pointer in the history.
 *
 * Append order is the only ordering that exists here: versions carry a
 * `createdAt`, but two written in the same millisecond would tie, and the
 * stored order is what the append-only history actually guarantees. False when
 * the Card serves nothing, because there is no "back" to go to.
 */
export function precedesCurrentCardVersion(
  history: CardVersionHistory,
  versionId: CardVersionId,
): boolean {
  if (history.currentVersionId === undefined) {
    return false;
  }
  const target = history.versions.findIndex(
    (version) => version.id === versionId,
  );
  const current = history.versions.findIndex(
    (version) => version.id === history.currentVersionId,
  );
  return target !== -1 && current !== -1 && target < current;
}

/**
 * What `next` changes against `previous`, or undefined when there is nothing
 * to compare — a predecessor written before versions carried their meaning.
 *
 * Field equality is structural. Coverage is compared as sets of fact names:
 * a fact that was reflected and no longer is reads as a regression, which is
 * the thing an approving operator most needs pushed in front of them.
 */
export function compareCardVersionMeaning(
  previous: CardVersion,
  next: CardVersion,
): MeaningChangeComparison | undefined {
  if (previous.meaning === undefined || next.meaning === undefined) {
    return undefined;
  }
  const fields = (
    ["description", "representativeQuestions", "aliases", "keywords"] as const
  ).filter(
    (field) =>
      JSON.stringify(previous.meaning?.[field]) !==
      JSON.stringify(next.meaning?.[field]),
  );

  const before = new Set(previous.grounding?.factCoverage.covered ?? []);
  const after = new Set(next.grounding?.factCoverage.covered ?? []);
  return {
    previousVersionId: previous.id,
    changedFields: fields,
    coverageLost: [...before].filter((name) => !after.has(name)),
    coverageGained: [...after].filter((name) => !before.has(name)),
  };
}

export function getCurrentCardVersion(
  history: CardVersionHistory,
): CardVersion | undefined {
  return history.versions.find(
    (version) => version.id === history.currentVersionId,
  );
}
