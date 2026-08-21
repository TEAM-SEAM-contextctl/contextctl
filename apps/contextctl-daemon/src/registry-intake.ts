import {
  approveCardVersion,
  intakePublication,
  type CardDecisionPorts,
  type CardMeaningGenerator,
  type CardPolicy,
  type CardStore,
  type CardValidationState,
  type ConsumptionDiagnostic,
  type ContextCard,
  type GroundingFinding,
  type IntakePublicationPorts,
  type OperatorDecision,
  type PublicationRepository,
} from "@contextctl/registry-lifecycle";

/**
 * Registry's consumption of one Ingestion Publication, assembled.
 *
 * `intakePublication` consumes the Publication and commits everything it changes
 * in one transaction — Cards, versions, the current pointer, the lifecycle
 * events and the consumer cursor. This file used to assemble that itself, one
 * `saveCard` at a time followed by `markProcessed`, which left partial drafts
 * behind whenever the process died in the middle. Ordering the two writes could
 * only choose which side the failure fell on, so the ordering question moved
 * into Registry along with the transaction that removes it.
 *
 * What is left here is composition: the ports, the policy a new Card starts
 * from, and the translation of a domain result into the shape the CLI reports.
 * The daemon opens the database Registry writes into, and decides nothing about
 * what goes in it.
 *
 * Claiming and approving stay two calls on purpose. ADR 0003 keeps approval in
 * an operator's hands, so a Publication arriving must not promote itself into
 * service; what `claim` produces is a Card with history and no current pointer,
 * which serves nothing until someone decides. A caller that wants both —  the
 * end-to-end test, a demo script — makes both calls, and the audit trail then
 * names who approved rather than recording that ingestion did.
 */
export interface RegistryIntakePorts
  extends IntakePublicationPorts,
    CardDecisionPorts {
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
   * Consumes one Publication, or reports why Registry refused it.
   *
   * Idempotent by way of the claim record: a redelivered `PublicationReady`
   * answers `already_claimed` and writes nothing, so the append-only history
   * cannot gain the same version twice.
   *
   * Registry may also refuse on chain order — `deferred` when a predecessor is
   * missing, `forked` when the chain is not linear. Both are passed through with
   * their diagnostic intact rather than flattened into a message: the code is
   * what a lane status can be keyed on and `sourceId` says which lane, and this
   * file decides neither.
   */
  async claim(publicationId: string): Promise<RegistryIntakeResult> {
    const claimed = await intakePublication(this.#ports, publicationId, {
      policy: this.#policy,
    });

    switch (claimed.status) {
      case "already_claimed":
        return { status: "already_claimed", publicationId, cardVersions: [] };
      case "deferred":
        return {
          status: "deferred",
          publicationId,
          cardVersions: [],
          sourceId: claimed.sourceId,
          awaiting: claimed.awaiting,
          diagnostic: claimed.diagnostic,
        };
      case "forked":
        return {
          status: "forked",
          publicationId,
          cardVersions: [],
          sourceId: claimed.sourceId,
          diagnostic: claimed.diagnostic,
        };
      case "claimed":
        return {
          status: "claimed",
          publicationId,
          cardVersions: claimed.cardVersions.map(({ version, findings }) => ({
            cardId: version.cardId,
            versionId: version.id,
            validationState: version.validationState,
            findings,
          })),
        };
      default: {
        const unreachable: never = claimed;
        throw new Error(`unknown claim status: ${JSON.stringify(unreachable)}`);
      }
    }
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
}
