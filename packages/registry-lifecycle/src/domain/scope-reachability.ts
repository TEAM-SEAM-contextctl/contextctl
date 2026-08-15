import type { PublicationId } from "@contextctl/contracts";

import type {
  CardId,
  CardValidationState,
  CardVersionId,
} from "./card-version.js";
import { ScopeReachabilityInvariantError } from "./errors.js";
import type {
  RetrievalScope,
  RetrievalScopeReference,
} from "./retrieval-scope.js";

/**
 * Whether a query can reach a published Scope version through an approved Card.
 *
 * This is a different axis from freshness lag. Lag says Registry is behind and
 * clears on its own; these states say whether the knowledge is reachable at
 * all, and the unreachable ones only clear when a person decides something.
 *
 * - `pending_registry`: a ready Publication exists, but the checkpoint has not
 *   processed it yet. The only state that applies before processing.
 * - `broken`: a current approved Card references the Scope, but the reference
 *   does not hold up.
 * - `reachable`: at least one current approved Card references this exact
 *   Scope version.
 * - `pending_approval`: a draft or revision references it, but no current
 *   approved Card does yet.
 * - `intentionally_unexposed`: an operator decided against exposing it, and
 *   said why.
 * - `orphaned`: processed, yet no Card, no review in flight, and no recorded
 *   decision. Nobody has decided anything, so nothing will resolve it.
 */
export type ScopeReachabilityState =
  | "pending_registry"
  | "broken"
  | "reachable"
  | "pending_approval"
  | "intentionally_unexposed"
  | "orphaned";

/** One Card Version that carries this Scope version, current or not. */
export interface ScopeCarrier {
  readonly cardId: CardId;
  readonly versionId: CardVersionId;
  readonly scope: RetrievalScope;
  readonly validationState: CardValidationState;
  /** True when this version is its Card's current pointer, and so is serving. */
  readonly isCurrent: boolean;
  readonly createdAt: string;
}

/**
 * An operator decision that touched a Card carrying this Scope version.
 *
 * `note` is what separates a deliberate exclusion from an accident: a refusal
 * or withdrawal that says why becomes `intentionally_unexposed`, and one that
 * says nothing leaves the Scope `orphaned`. That is deliberate — an unexplained
 * exclusion is indistinguishable from a mistake six months later, and the
 * release gate refuses to ship one.
 */
export interface ScopeDecision {
  readonly kind: "promoted" | "refused" | "withdrawn";
  readonly cardId: CardId;
  readonly occurredAt: string;
  readonly note: string | undefined;
}

/**
 * Everything known about one Scope version, gathered from Registry's own store.
 *
 * `processed` is separate from the carriers because an unprocessed Publication
 * has no Card Versions yet: absence of carriers means "not reached yet" before
 * the checkpoint and "nothing points here" after it, and only the caller knows
 * which.
 */
export interface ScopeObservation {
  readonly reference: RetrievalScopeReference;
  readonly publicationId: PublicationId;
  readonly processed: boolean;
  readonly carriers: readonly ScopeCarrier[];
  readonly decisions: readonly ScopeDecision[];
}

export interface ScopeReachability {
  readonly reference: RetrievalScopeReference;
  readonly publicationId: PublicationId;
  readonly state: ScopeReachabilityState;
  /** When the Scope entered this state, where the evidence carries a time. */
  readonly stateSince: string | undefined;
  /** The Card Versions that took part in the verdict, not every Card seen. */
  readonly cardVersionIds: readonly CardVersionId[];
  /** Always present for `intentionally_unexposed`, absent otherwise. */
  readonly reason: string | undefined;
}

/**
 * Decides the one state a Scope version is in.
 *
 * The order below is the priority order, and it is exhaustive: every
 * observation leaves with exactly one state. `pending_registry` is checked
 * first and short-circuits, because the remaining states describe what
 * processing found and there has been no processing yet.
 *
 * Nothing here widens a search or approves anything. A Scope that turns out to
 * be `orphaned` stays out of the catalog; naming the problem is the whole job,
 * and the decision belongs to an operator.
 */
export function judgeScopeReachability(
  observation: ScopeObservation,
): ScopeReachability {
  const { reference, carriers, decisions } = observation;

  for (const carrier of carriers) {
    if (
      carrier.scope.reference.scopeId !== reference.scopeId ||
      carrier.scope.reference.scopeVersion !== reference.scopeVersion
    ) {
      throw new ScopeReachabilityInvariantError(
        `card version ${carrier.versionId} carries scope ${carrier.scope.reference.scopeId}@${carrier.scope.reference.scopeVersion}, not ${reference.scopeId}@${reference.scopeVersion}`,
      );
    }
  }

  if (!observation.processed) {
    return verdict(observation, "pending_registry", undefined, [], undefined);
  }

  const serving = carriers.filter((carrier) => carrier.isCurrent);

  if (serving.length > 0) {
    const disagreement = findScopeDisagreement(carriers);
    if (disagreement !== undefined) {
      return verdict(observation, "broken", undefined, serving, undefined);
    }

    return verdict(
      observation,
      "reachable",
      latestDecisionAt(decisions, "promoted", serving),
      serving,
      undefined,
    );
  }

  const awaiting = carriers.filter(
    (carrier) => carrier.validationState !== "rejected",
  );
  if (awaiting.length > 0) {
    return verdict(
      observation,
      "pending_approval",
      earliestCreatedAt(awaiting),
      awaiting,
      undefined,
    );
  }

  const explained = explainedDecision(decisions);
  if (explained !== undefined) {
    return verdict(
      observation,
      "intentionally_unexposed",
      explained.occurredAt,
      carriers,
      explained.note,
    );
  }

  return verdict(
    observation,
    "orphaned",
    latestUnexplainedDecisionAt(decisions),
    carriers,
    undefined,
  );
}

function verdict(
  observation: ScopeObservation,
  state: ScopeReachabilityState,
  stateSince: string | undefined,
  deciding: readonly ScopeCarrier[],
  reason: string | undefined,
): ScopeReachability {
  return {
    reference: observation.reference,
    publicationId: observation.publicationId,
    state,
    stateSince,
    cardVersionIds: deciding.map((carrier) => carrier.versionId),
    reason,
  };
}

/**
 * Finds carriers that claim the same Scope version but describe it differently.
 *
 * A `scopeVersion` is derived from the Scope kind, a fixed index version, and a
 * canonical selector, so two Card Versions naming the same version must
 * describe the same range. When they disagree, one of them is pointing at
 * something that is no longer what it says it is.
 */
function findScopeDisagreement(
  carriers: readonly ScopeCarrier[],
): ScopeCarrier | undefined {
  const [first, ...rest] = carriers;
  if (first === undefined) {
    return undefined;
  }
  const shape = scopeShape(first.scope);
  return rest.find((carrier) => scopeShape(carrier.scope) !== shape);
}

/** A comparable rendering of what a Scope points at, ignoring its reference. */
function scopeShape(scope: RetrievalScope): string {
  if (scope.kind === "managed_document") {
    const selection =
      scope.selection.kind === "document"
        ? "document"
        : [...scope.selection.semanticUnitIds].sort().join(",");
    const index = scope.documentIndex;
    return [
      scope.kind,
      index.documentIndexId,
      index.sourceId,
      index.documentId,
      index.indexVersion,
      index.connectorId,
      selection,
    ].join("|");
  }

  if (scope.kind === "sql_source") {
    return [
      scope.kind,
      scope.connector,
      scope.table,
      [...scope.columns].sort().join(","),
    ].join("|");
  }

  return [scope.kind, scope.connector, scope.method, scope.path].join("|");
}

function latestDecisionAt(
  decisions: readonly ScopeDecision[],
  kind: ScopeDecision["kind"],
  carriers: readonly ScopeCarrier[],
): string | undefined {
  const cardIds = new Set(carriers.map((carrier) => carrier.cardId));
  const times = decisions
    .filter(
      (decision) => decision.kind === kind && cardIds.has(decision.cardId),
    )
    .map((decision) => decision.occurredAt);
  return maximum(times) ?? earliestCreatedAt(carriers);
}

function earliestCreatedAt(
  carriers: readonly ScopeCarrier[],
): string | undefined {
  const times = carriers.map((carrier) => carrier.createdAt).sort();
  return times[0];
}

/** The most recent refusal or withdrawal that recorded a reason. */
function explainedDecision(
  decisions: readonly ScopeDecision[],
): { occurredAt: string; note: string } | undefined {
  let latest: { occurredAt: string; note: string } | undefined;
  for (const decision of decisions) {
    if (decision.kind === "promoted") {
      continue;
    }
    const note = decision.note?.trim();
    if (note === undefined || note.length === 0) {
      continue;
    }
    if (latest === undefined || decision.occurredAt > latest.occurredAt) {
      latest = { occurredAt: decision.occurredAt, note };
    }
  }
  return latest;
}

function latestUnexplainedDecisionAt(
  decisions: readonly ScopeDecision[],
): string | undefined {
  return maximum(
    decisions
      .filter((decision) => decision.kind !== "promoted")
      .map((decision) => decision.occurredAt),
  );
}

function maximum(values: readonly string[]): string | undefined {
  return [...values].sort().at(-1);
}
