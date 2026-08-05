import {
  getCurrentCardVersion,
  promoteCardVersion,
  withdrawCurrentVersion,
  type CardId,
  type CardVersionId,
} from "../domain/card-version.js";
import { withCardVersions, type ContextCard } from "../domain/context-card.js";
import type { LifecycleEvent } from "../domain/lifecycle-event.js";
import { CardNotFoundError } from "./errors.js";
import type { CardStore } from "../ports/card-store.js";
import type { Clock } from "../ports/clock.js";
import type { IdGenerator } from "../ports/id-generator.js";

export interface CardDecisionPorts {
  readonly cards: CardStore;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

/** Who made the call and why, so the audit trail explains itself later. */
export interface OperatorDecision {
  readonly decidedBy: string;
  readonly note?: string;
}

/**
 * Promotes a validated Card Version to current on an operator's approval.
 *
 * The domain refuses to promote a version that failed grounding, so an
 * approval cannot push an unvalidated version into service — the previous
 * last-known-good version keeps serving instead.
 */
export async function approveCardVersion(
  ports: CardDecisionPorts,
  cardId: CardId,
  versionId: CardVersionId,
  decision: OperatorDecision,
): Promise<ContextCard> {
  const card = await loadCard(ports, cardId);
  const previousVersionId = card.versions.currentVersionId;
  const versions = promoteCardVersion(card.versions, versionId);

  return save(ports, withCardVersions(card, versions), {
    id: ports.ids.nextId(),
    kind: "card_version_promoted",
    cardId,
    occurredAt: ports.clock.now(),
    versionId,
    previousVersionId,
    decidedBy: decision.decidedBy,
    note: decision.note,
  });
}

/**
 * Records that an operator refused a Card Version. Nothing is promoted and no
 * version is removed: the refusal itself is the fact worth keeping, and the
 * version stays in history so a later review can see what was rejected.
 */
export async function rejectCardVersion(
  ports: CardDecisionPorts,
  cardId: CardId,
  versionId: CardVersionId,
  decision: OperatorDecision,
): Promise<ContextCard> {
  const card = await loadCard(ports, cardId);
  if (!card.versions.versions.some((version) => version.id === versionId)) {
    throw new CardNotFoundError(
      `card version ${versionId} is not part of card ${cardId} history`,
    );
  }

  return save(ports, card, {
    id: ports.ids.nextId(),
    kind: "card_version_refused",
    cardId,
    occurredAt: ports.clock.now(),
    versionId,
    decidedBy: decision.decidedBy,
    note: decision.note,
  });
}

/**
 * Takes a Card out of service by clearing its current pointer. This is how a
 * `disable` or `block` impact decision is finally carried out; the version
 * history survives so the Card can be restored by promoting a version again.
 */
export async function disableCard(
  ports: CardDecisionPorts,
  cardId: CardId,
  decision: OperatorDecision,
): Promise<ContextCard> {
  const card = await loadCard(ports, cardId);
  const withdrawnVersionId = getCurrentCardVersion(card.versions)?.id;
  const versions = withdrawCurrentVersion(card.versions);

  return save(ports, withCardVersions(card, versions), {
    id: ports.ids.nextId(),
    kind: "card_withdrawn",
    cardId,
    occurredAt: ports.clock.now(),
    withdrawnVersionId,
    decidedBy: decision.decidedBy,
    note: decision.note,
  });
}

async function loadCard(
  ports: CardDecisionPorts,
  cardId: CardId,
): Promise<ContextCard> {
  const card = await ports.cards.findCard(cardId);
  if (card === undefined) {
    throw new CardNotFoundError(`card ${cardId} was not found`);
  }
  return card;
}

async function save(
  ports: CardDecisionPorts,
  card: ContextCard,
  event: LifecycleEvent,
): Promise<ContextCard> {
  // saveCard writes the card and the event as one unit, so a decision is never
  // visible without the audit record that explains it.
  await ports.cards.saveCard(card, [event]);
  return card;
}
