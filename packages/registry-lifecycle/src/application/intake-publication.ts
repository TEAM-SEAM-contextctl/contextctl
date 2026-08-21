import type {
  PublicationId,
  PublishedKnowledgeUnit,
} from "@contextctl/contracts";

import { appendCardVersion } from "../domain/card-version.js";
import {
  createContextCard,
  withCardVersions,
  type CardPolicy,
} from "../domain/context-card.js";
import type { LifecycleEvent } from "../domain/lifecycle-event.js";
import type { CardMeaningRequest } from "../ports/card-meaning-generator.js";
import type { CardStore } from "../ports/card-store.js";
import type { IntakeStore, IntakenCard } from "../ports/intake-store.js";
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
  const units = new Map(
    publication.knowledgeUnits.map((unit) => [unit.id, unit] as const),
  );

  const cards: IntakenCard[] = [];
  for (const claimedVersion of claimed.cardVersions) {
    cards.push(await toIntakenCard(ports, options, claimedVersion, units));
  }

  await ports.intake.commit({ cards, cursor: claimed.cursor });
  return claimed;
}

/**
 * The Card this version belongs to, with the version appended.
 *
 * A Card that already exists gains a version; one Registry has not seen before
 * is created from its Knowledge Unit. The meaning is generated again here rather
 * than reused from the claim — the local generator is deterministic, so the text
 * is the same one grounding accepted. A model-backed generator makes the two
 * differ, and carrying the meaning on the claim result is the fix; it belongs
 * with the fact-grounding work (SEAM-112) rather than here, because that is
 * where the two texts start being compared at all.
 */
async function toIntakenCard(
  ports: IntakePublicationPorts,
  options: IntakePublicationOptions,
  claimed: ClaimedCardVersion,
  units: ReadonlyMap<string, PublishedKnowledgeUnit>,
): Promise<IntakenCard> {
  const { version } = claimed;
  const existing = await ports.cards.findCard(version.cardId);
  const card = existing ?? createContextCard(
    version.cardId,
    await ports.meanings.generate(meaningRequestFor(version.cardId, units)),
    options.policy,
  );

  const event: LifecycleEvent = {
    id: ports.ids.nextId(),
    kind: "card_version_added",
    cardId: version.cardId,
    occurredAt: version.createdAt,
    versionId: version.id,
    publicationId: version.lineage.publicationId,
  };

  return {
    card: withCardVersions(card, appendCardVersion(card.versions, version)),
    events: [event],
  };
}

/**
 * The generator input for a Card being created, from the unit it describes.
 *
 * Unreachable for anything a claim produced — a claimed version always names a
 * unit of the Publication it came from — so the throw is a statement about that
 * invariant rather than a case a caller has to handle.
 */
function meaningRequestFor(
  cardId: string,
  units: ReadonlyMap<string, PublishedKnowledgeUnit>,
): CardMeaningRequest {
  const unit = units.get(cardId);
  if (unit === undefined) {
    throw new Error(`claimed card ${cardId} has no knowledge unit`);
  }
  return { coordinate: unit.sourceCoordinate, facts: unit.facts };
}
