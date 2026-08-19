import {
  appendCardVersion,
  approveCardVersion,
  claimPublication,
  createContextCard,
  withCardVersions,
  type CardDecisionPorts,
  type CardMeaningGenerator,
  type CardPolicy,
  type CardStore,
  type CardValidationState,
  type ClaimPublicationPorts,
  type ConsumptionDiagnostic,
  type ContextCard,
  type GroundingFinding,
  type LifecycleEvent,
  type OperatorDecision,
  type PublicationRepository,
} from "@contextctl/registry-lifecycle";

/**
 * Registry's consumption of one Ingestion Publication, assembled.
 *
 * `claimPublication` is a pure read: it turns a Publication into Card Versions
 * and records that the Publication was consumed, but it never writes a Card.
 * Nothing else in Registry writes one either, so between "claimed" and
 * "approvable" there is a gap only a composition can close — find or create the
 * Card, append the version, persist. This file is that gap, and it lives in the
 * daemon because it is the only place allowed to open the database Registry
 * writes into.
 *
 * Claiming and approving stay two calls on purpose. ADR 0003 keeps approval in
 * an operator's hands, so a Publication arriving must not promote itself into
 * service; what `claim` produces is a Card with history and no current pointer,
 * which serves nothing until someone decides. A caller that wants both —  the
 * end-to-end test, a demo script — makes both calls, and the audit trail then
 * names who approved rather than recording that ingestion did.
 */
export interface RegistryIntakePorts extends ClaimPublicationPorts, CardDecisionPorts {
  readonly publications: PublicationRepository;
  readonly meanings: CardMeaningGenerator;
  readonly cards: CardStore;
}

/**
 * The policy a Card is created under when Registry first sees its Knowledge
 * Unit.
 *
 * A Publication carries no policy — Ingestion observes a source, it does not
 * classify what may be done with it — so the first version of every Card has to
 * start somewhere, and the composition is where that "somewhere" is named
 * rather than being buried in a domain that has no basis for the judgement.
 * `sensitive: false` is the honest default for the local single-domain
 * composition this daemon assembles; a deployment with real tenants overrides it
 * here, in one place, instead of per Card.
 */
export const DEFAULT_CARD_POLICY: CardPolicy = {
  sensitive: false,
  allowedUsage: ["retrieval"],
};

/** One Card Version a claim produced and this intake persisted. */
export interface IntakenCardVersion {
  readonly cardId: string;
  readonly versionId: string;
  /** `validated` is the only state `approve` will promote. */
  readonly validationState: CardValidationState;
  /** Why grounding refused the version, empty when it did not. */
  readonly findings: readonly GroundingFinding[];
}

export type RegistryIntakeResult =
  | {
      readonly status: "already_claimed";
      readonly publicationId: string;
      readonly cardVersions: readonly IntakenCardVersion[];
    }
  | {
      readonly status: "claimed";
      readonly publicationId: string;
      readonly cardVersions: readonly IntakenCardVersion[];
    }
  /**
   * Registry refused the Publication for now: its predecessor in the Source's
   * chain has not been consumed. Nothing was written, so the notification is
   * still work — reconciliation retries it once the missing one lands.
   */
  | {
      readonly status: "deferred";
      readonly publicationId: string;
      readonly cardVersions: readonly IntakenCardVersion[];
      readonly sourceId: string;
      readonly awaiting: string;
      readonly diagnostic: ConsumptionDiagnostic;
    }
  /**
   * The Source's chain is not linear and Registry consumed nothing. Reported
   * rather than retried: no ordering exists to retry into, and choosing one
   * successor would drop what the other published.
   */
  | {
      readonly status: "forked";
      readonly publicationId: string;
      readonly cardVersions: readonly IntakenCardVersion[];
      readonly sourceId: string;
      readonly diagnostic: ConsumptionDiagnostic;
    };

/** The Publication shape this file reads, derived so no contract import appears. */
type ClaimablePublication = NonNullable<
  Awaited<ReturnType<PublicationRepository["findById"]>>
>;
type PublishedUnit = ClaimablePublication["knowledgeUnits"][number];

export interface RegistryIntakeOptions {
  readonly policy?: CardPolicy;
}

export class RegistryIntake {
  readonly #ports: RegistryIntakePorts;
  readonly #policy: CardPolicy;

  constructor(ports: RegistryIntakePorts, options: RegistryIntakeOptions = {}) {
    this.#ports = ports;
    this.#policy = options.policy ?? DEFAULT_CARD_POLICY;
  }

  /**
   * Consumes one Publication and persists a Card Version per Knowledge Unit.
   *
   * Idempotent by way of the claim record: a redelivered `PublicationReady`
   * answers `already_claimed` and writes nothing, so the append-only history
   * cannot gain the same version twice. The record is written here rather than
   * inside the use case, after the Cards are stored — see the comment at that
   * call.
   *
   * Registry may also refuse on chain order — `deferred` when a predecessor is
   * missing, `forked` when the chain is not linear. Both are passed through with
   * no Card written, because in both cases Registry committed nothing and this
   * file has nothing to persist.
   */
  async claim(publicationId: string): Promise<RegistryIntakeResult> {
    const claimed = await claimPublication(this.#ports, publicationId);
    if (claimed.status === "already_claimed") {
      return { status: "already_claimed", publicationId, cardVersions: [] };
    }
    // Both refusals are passed through with their diagnostic intact rather than
    // being flattened into a message. The code is what a lane status can be
    // keyed on, and `sourceId` says which lane — this file is not the place that
    // decides either, so it forwards both instead of interpreting them.
    if (claimed.status === "deferred") {
      return {
        status: "deferred",
        publicationId,
        cardVersions: [],
        sourceId: claimed.sourceId,
        awaiting: claimed.awaiting,
        diagnostic: claimed.diagnostic,
      };
    }
    if (claimed.status === "forked") {
      return {
        status: "forked",
        publicationId,
        cardVersions: [],
        sourceId: claimed.sourceId,
        diagnostic: claimed.diagnostic,
      };
    }

    // Read after the claim rather than before: `claimPublication` already
    // proved the Publication exists by consuming it, and reading first would
    // fetch a record for a claim that turns out to be a no-op.
    const units = await this.#unitsOf(publicationId);
    const intaken: IntakenCardVersion[] = [];

    for (const { version, findings } of claimed.cardVersions) {
      const card = await this.#cardFor(version.cardId, units);
      const event: LifecycleEvent = {
        id: this.#ports.ids.nextId(),
        kind: "card_version_added",
        cardId: version.cardId,
        occurredAt: version.createdAt,
        versionId: version.id,
        publicationId: version.lineage.publicationId,
      };
      await this.#ports.cards.saveCard(
        withCardVersions(card, appendCardVersion(card.versions, version)),
        [event],
      );
      intaken.push({
        cardId: version.cardId,
        versionId: version.id,
        validationState: version.validationState,
        findings,
      });
    }

    // Marked consumed only now, with the cursor `claimPublication` handed back.
    // Doing it before this loop would count the Publication as consumed while
    // its Cards did not exist yet, and a crash in between would be unrecoverable
    // — redelivery answers `already_claimed`. This order fails the other way: a
    // crash here leaves the Cards stored and the Publication unconsumed, so a
    // retry re-produces the same Card Versions and an operator sees duplicate
    // drafts rather than silently missing knowledge.
    await this.#ports.checkpoints.markProcessed(claimed.cursor);

    return { status: "claimed", publicationId, cardVersions: intaken };
  }

  /**
   * Promotes one persisted Card Version to current.
   *
   * A thin pass-through to the use case, and deliberately not folded into
   * `claim`: the decision, and the operator named in it, is the thing being
   * recorded.
   */
  async approve(
    cardId: string,
    versionId: string,
    decision: OperatorDecision,
  ): Promise<ContextCard> {
    return approveCardVersion(this.#ports, cardId, versionId, decision);
  }

  /**
   * The existing Card, or a new one described from its Knowledge Unit.
   *
   * The meaning is generated a second time here — `claimPublication` generated
   * one to ground the version against and kept it to itself. Regenerating is
   * safe rather than merely tolerable: the generator is a port whose local
   * implementation is deterministic, so the description a Card is created with
   * is the same text grounding already accepted. A model-backed generator would
   * make the two differ, and at that point the meaning belongs on the claim
   * result rather than being re-derived — which is Registry's call to make, not
   * this composition's.
   */
  async #cardFor(
    cardId: string,
    units: ReadonlyMap<string, PublishedUnit>,
  ): Promise<ContextCard> {
    const existing = await this.#ports.cards.findCard(cardId);
    if (existing !== undefined) {
      return existing;
    }
    const unit = units.get(cardId);
    if (unit === undefined) {
      // A claimed version always names a unit of the Publication it came from,
      // so this is unreachable for any record `claimPublication` produced.
      throw new Error(`claimed card ${cardId} has no knowledge unit`);
    }
    const meaning = await this.#ports.meanings.generate({
      coordinate: unit.sourceCoordinate,
      facts: unit.facts,
    });
    return createContextCard(cardId, meaning, this.#policy);
  }

  async #unitsOf(
    publicationId: string,
  ): Promise<ReadonlyMap<string, PublishedUnit>> {
    const publication = await this.#ports.publications.findById(publicationId);
    if (publication === undefined) {
      throw new Error(`claimed publication ${publicationId} disappeared`);
    }
    return new Map(publication.knowledgeUnits.map((unit) => [unit.id, unit]));
  }
}
