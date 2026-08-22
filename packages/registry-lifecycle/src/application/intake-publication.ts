import type { IngestionPublication, PublicationId } from "@contextctl/contracts";

import type { CardImpact } from "../domain/card-impact.js";
import {
  appendCardVersion,
  compareCardVersionMeaning,
  withdrawCurrentVersion,
  type CardId,
  type CardVersion,
} from "../domain/card-version.js";
import {
  createContextCard,
  withCardVersions,
  type CardPolicy,
  type ContextCard,
} from "../domain/context-card.js";
import type { LifecycleEvent } from "../domain/lifecycle-event.js";
import type { CardStore } from "../ports/card-store.js";
import type { IntakeStore, IntakenCard } from "../ports/intake-store.js";
import { assessPublicationImpact } from "./assess-publication-impact.js";
import {
  claimPublication,
  type ClaimPublicationPorts,
  type ClaimPublicationResult,
  type ClaimedCardVersion,
} from "./claim-publication.js";
import { PublicationNotFoundError } from "./errors.js";

export interface IntakePublicationPorts extends ClaimPublicationPorts {
  readonly cards: CardStore;
  readonly intake: IntakeStore;
}

export interface IntakePublicationOptions {
  /**
   * The policy a Card is created under when Registry first sees its unit.
   *
   * A Publication carries none — Ingestion observes a source, it does not
   * classify what may be done with what it found — so the first version of every
   * Card starts from a value someone chose. The caller passes it rather than this
   * function assuming one, because the basis for the judgement is the deployment,
   * not the domain.
   */
  readonly policy: CardPolicy;
}

/**
 * Consumes one Publication and commits everything it changes, or nothing.
 *
 * `claimPublication` decides and produces; this decides nothing and stores.
 * Keeping them apart is what lets the reachability report and the operator
 * surfaces keep using a claim that writes no state, while consumption gets the
 * one thing it actually needs: Cards, versions, the current pointer, the
 * lifecycle events and the consumer cursor landing together.
 *
 * Two things happen to Cards here, and they are different questions. A
 * Publication's units produce new versions — that is what the claim returns. A
 * Publication's *changes* decide what happens to the Cards already serving, and
 * that is what the impact assessment answers. A single Card can be on both sides
 * at once: its unit was updated, so it gains a draft, and the update moved a
 * coordinate out from under it, so the version currently serving has to go.
 *
 * Every asynchronous read happens before the commit — the meaning generator, the
 * Card lookups — so the store is handed a value it can write synchronously. An
 * adapter that opens a transaction therefore never has to hold it open across an
 * await, which is where a half-open transaction would come from.
 */
export async function intakePublication(
  ports: IntakePublicationPorts,
  publicationId: PublicationId,
  options: IntakePublicationOptions,
): Promise<ClaimPublicationResult> {
  const claimed = await claimPublication(ports, publicationId);
  if (claimed.status !== "claimed") {
    // `already_claimed`, `deferred` and `forked` all committed nothing, and none
    // of them has state for this function to persist.
    return claimed;
  }

  // Read after the claim rather than before: the claim already proved the
  // Publication exists by consuming it, and reading first would fetch a record
  // for a claim that turns out to be a no-op.
  const publication = await ports.publications.findById(publicationId);
  if (publication === undefined) {
    throw new PublicationNotFoundError(publicationId);
  }

  const draft = new IntakeDraft();
  await addClaimedVersions(ports, options, claimed.cardVersions, draft);
  await applyImpacts(ports, publication, draft);

  await ports.intake.commit({ cards: draft.entries(), cursor: claimed.cursor });
  return claimed;
}

/**
 * The Cards one intake touches, each with the events explaining why.
 *
 * An accumulator rather than two lists, because a Card reached from both sides —
 * a new version and an impact on the version already serving — has to be
 * committed once. Two entries for the same Card would mean two writes of the
 * same row, and the second would overwrite whatever the first decided about the
 * current pointer.
 */
class IntakeDraft {
  readonly #cards = new Map<CardId, IntakenCard>();

  get(cardId: CardId): IntakenCard | undefined {
    return this.#cards.get(cardId);
  }

  set(cardId: CardId, card: ContextCard, events: readonly LifecycleEvent[]): void {
    const existing = this.#cards.get(cardId);
    this.#cards.set(cardId, {
      card,
      events: existing === undefined ? events : [...existing.events, ...events],
    });
  }

  entries(): readonly IntakenCard[] {
    return [...this.#cards.values()];
  }
}

/** Appends every version the claim produced to the Card it belongs to. */
async function addClaimedVersions(
  ports: IntakePublicationPorts,
  options: IntakePublicationOptions,
  claimedVersions: readonly ClaimedCardVersion[],
  draft: IntakeDraft,
): Promise<void> {
  for (const { version } of claimedVersions) {
    const card = await loadOrCreateCard(ports, options, version);
    const event: LifecycleEvent = {
      id: ports.ids.nextId(),
      kind: "card_version_added",
      cardId: version.cardId,
      occurredAt: version.createdAt,
      versionId: version.id,
      publicationId: version.lineage.publicationId,
    };
    draft.set(
      version.cardId,
      withCardVersions(
        card,
        appendCardVersion(card.versions, withChangeComparison(card, version)),
      ),
      [event],
    );
  }
}

/**
 * The version, annotated with what it changes against the Card's latest one.
 *
 * Computed here rather than in the claim because only intake holds the stored
 * Card: the claim decides from the Publication alone and has no predecessor to
 * compare against. First versions, and successors of versions written before
 * meanings were stored, carry no comparison.
 */
function withChangeComparison(card: ContextCard, version: CardVersion): CardVersion {
  const previous = card.versions.versions.at(-1);
  if (previous === undefined) {
    return version;
  }
  const comparison = compareCardVersionMeaning(previous, version);
  return comparison === undefined ? version : { ...version, changeFromPrevious: comparison };
}

/**
 * Applies what the Publication's changes mean for the Cards already serving.
 *
 * `disable` and `block` both take the current pointer away, and for the same
 * reason: the Card can no longer be verified against the source. `disable` means
 * the knowledge is gone, `block` means a coordinate it named is. Neither is a
 * case for keeping the last-known-good version — that rule exists for a *new*
 * version failing validation, where the source still says what the serving
 * version claims. See ADR 0005.
 *
 * `review` changes nothing about what is served. A paragraph was edited, so the
 * Card is older than its source and a draft is waiting for an operator; serving
 * the previous version meanwhile is the design's answer, not a gap in it.
 *
 * The event is the impact assessment alone. `card_withdrawn` is not emitted even
 * though a pointer moved: it requires the operator who decided, and reachability
 * reads it as a deliberate exclusion — so using it here would record a decision
 * nobody made and report removed knowledge as intentionally unexposed.
 */
async function applyImpacts(
  ports: IntakePublicationPorts,
  publication: IngestionPublication,
  draft: IntakeDraft,
): Promise<void> {
  const currentVersions = await ports.cards.listCurrentVersions();
  const { impacts, events } = assessPublicationImpact(
    ports,
    publication,
    currentVersions,
  );
  if (impacts.length === 0) {
    return;
  }

  const eventsByCard = new Map<CardId, LifecycleEvent[]>();
  for (const event of events) {
    const forCard = eventsByCard.get(event.cardId) ?? [];
    forCard.push(event);
    eventsByCard.set(event.cardId, forCard);
  }

  for (const impact of impacts) {
    const card = await cardUnderImpact(ports, draft, impact);
    if (card === undefined) {
      // The impact was judged against a current version, so the Card exists.
      // Reaching here would mean the store lost it between two reads.
      continue;
    }
    draft.set(
      impact.cardId,
      withdraws(impact) ? withCardVersions(card, withdrawCurrentVersion(card.versions)) : card,
      eventsByCard.get(impact.cardId) ?? [],
    );
  }
}

/** Whether this decision takes the current pointer away. */
function withdraws(impact: CardImpact): boolean {
  switch (impact.decision) {
    case "disable":
    case "block":
      return true;
    case "review":
    case "none":
      return false;
    default: {
      const unreachable: never = impact.decision;
      throw new Error(`unknown impact decision: ${String(unreachable)}`);
    }
  }
}

/**
 * The Card this impact applies to, as the draft has it or as the store does.
 *
 * Preferring the draft is what keeps a Card that gained a version in this same
 * intake from losing it: the impact has to be applied on top of the appended
 * version, not on the copy that was read before it.
 */
async function cardUnderImpact(
  ports: IntakePublicationPorts,
  draft: IntakeDraft,
  impact: CardImpact,
): Promise<ContextCard | undefined> {
  return draft.get(impact.cardId)?.card ?? ports.cards.findCard(impact.cardId);
}

/**
 * The stored Card, or a new one carrying the version's own meaning.
 *
 * The claim already generated the meaning once and the version carries it, so
 * intake reuses that text instead of calling the generator again. With the
 * deterministic generator the two calls were identical; with a model they are
 * not, and a Card whose stored meaning differed from the text grounding
 * actually judged would make the grounding report describe words the catalog
 * never serves.
 */
async function loadOrCreateCard(
  ports: IntakePublicationPorts,
  options: IntakePublicationOptions,
  version: CardVersion,
): Promise<ContextCard> {
  const existing = await ports.cards.findCard(version.cardId);
  if (existing !== undefined) {
    return existing;
  }
  if (version.meaning === undefined) {
    // A claim always grounds a meaning before returning a version, so this is
    // an invariant statement, not a case a Publication can reach.
    throw new Error(`claimed card ${version.cardId} carries no meaning`);
  }
  return createContextCard(version.cardId, version.meaning, options.policy);
}
