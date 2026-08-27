import type {
  CardVersionHistory,
  CardVersionId,
} from "./card-version.js";
import type { LifecycleEvent } from "./lifecycle-event.js";

/**
 * Validated versions that still require an operator decision.
 *
 * A version leaves the review queue when it is promoted or refused. Promoting
 * a later version also closes every older undecided version: append order is
 * the Card's authoritative chronology, and resurfacing an older candidate
 * after a newer one served would turn historical state back into new work.
 * The current pointer is considered reviewed even for legacy databases whose
 * promotion event is unavailable.
 */
export function pendingReviewCardVersionIds(
  history: CardVersionHistory,
  events: readonly LifecycleEvent[],
): readonly CardVersionId[] {
  const versionIndex = new Map(
    history.versions.map((version, index) => [version.id, index]),
  );
  const decided = new Set<CardVersionId>();
  let latestPromotedIndex = -1;

  for (const event of events) {
    if (event.cardId !== history.cardId) {
      continue;
    }
    if (
      event.kind !== "card_version_promoted" &&
      event.kind !== "card_version_refused"
    ) {
      continue;
    }
    decided.add(event.versionId);
    if (event.kind === "card_version_promoted") {
      latestPromotedIndex = Math.max(
        latestPromotedIndex,
        versionIndex.get(event.versionId) ?? -1,
      );
    }
  }

  const currentIndex = history.versions.findIndex(
    (version) => version.id === history.currentVersionId,
  );
  const reviewedThrough = Math.max(currentIndex, latestPromotedIndex);

  return history.versions
    .filter(
      (version, index) =>
        version.validationState === "validated" &&
        !decided.has(version.id) &&
        version.id !== history.currentVersionId &&
        index > reviewedThrough,
    )
    .map((version) => version.id);
}
