import type { PublicationId } from "@contextctl/contracts";

import type { CardId, CardVersionId } from "./card-version.js";
import type { CardImpactDecision, CardImpactReason } from "./card-impact.js";

export type LifecycleEventId = string;

interface LifecycleEventBase {
  readonly id: LifecycleEventId;
  readonly cardId: CardId;
  readonly occurredAt: string;
}

export interface CardVersionAddedEvent extends LifecycleEventBase {
  readonly kind: "card_version_added";
  readonly versionId: CardVersionId;
  readonly publicationId: PublicationId;
}

export interface CardVersionPromotedEvent extends LifecycleEventBase {
  readonly kind: "card_version_promoted";
  readonly versionId: CardVersionId;
  readonly previousVersionId: CardVersionId | undefined;
}

export interface CardImpactAssessedEvent extends LifecycleEventBase {
  readonly kind: "card_impact_assessed";
  readonly publicationId: PublicationId;
  readonly decision: CardImpactDecision;
  readonly reasons: readonly CardImpactReason[];
}

/**
 * Append-only audit record of what happened to a Card. Promotions and
 * rollbacks share one event kind because both are a current-pointer move; the
 * previous version id is what tells them apart in the trail.
 */
export type LifecycleEvent =
  | CardVersionAddedEvent
  | CardVersionPromotedEvent
  | CardImpactAssessedEvent;

export function recordLifecycleEvent(
  events: readonly LifecycleEvent[],
  event: LifecycleEvent,
): readonly LifecycleEvent[] {
  return [...events, event];
}

export function lifecycleEventsForCard(
  events: readonly LifecycleEvent[],
  cardId: CardId,
): readonly LifecycleEvent[] {
  return events.filter((event) => event.cardId === cardId);
}
