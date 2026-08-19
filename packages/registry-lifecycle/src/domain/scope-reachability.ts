import type { PublicationId } from "@contextctl/contracts";

import type { SourceProcessingLag } from "./processing-lag.js";
import type {
  CardId,
  CardValidationState,
  CardVersionId,
} from "./card-version.js";
import { ScopeReachabilityInvariantError } from "./errors.js";
import type { LifecycleEvent } from "./lifecycle-event.js";
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
  /** The Card Version the decision landed on, where the event names one. */
  readonly versionId: CardVersionId | undefined;
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
  /**
   * The Publication that first published this Scope version.
   *
   * Kept apart from `lastSeenPublicationId` because an immutable Scope carries
   * forward: an edit elsewhere in the document republishes the same Scope
   * unchanged, and folding both into one id would either lose when the Scope
   * appeared or claim it appeared later than it did.
   */
  readonly introducedByPublicationId: PublicationId;
  /** The most recent Publication in the same chain that still carried it. */
  readonly lastSeenPublicationId: PublicationId;
  readonly processed: boolean;
  readonly carriers: readonly ScopeCarrier[];
  readonly decisions: readonly ScopeDecision[];
}

export interface ScopeReachability {
  readonly reference: RetrievalScopeReference;
  readonly introducedByPublicationId: PublicationId;
  readonly lastSeenPublicationId: PublicationId;
  readonly state: ScopeReachabilityState;
  /** When the Scope entered this state, where the evidence carries a time. */
  readonly stateSince: string | undefined;
  /** The Card Versions that took part in the verdict, not every Card seen. */
  readonly cardVersionIds: readonly CardVersionId[];
  /** Always present for `intentionally_unexposed`, absent otherwise. */
  readonly reason: string | undefined;
}

/**
 * Reads the operator decisions out of the audit trail.
 *
 * Only the three operator-decided kinds carry a verdict about exposure; an
 * impact assessment or a version being added decides nothing on its own.
 */
export function toScopeDecisions(
  events: readonly LifecycleEvent[],
): readonly ScopeDecision[] {
  const decisions: ScopeDecision[] = [];
  for (const event of events) {
    // Switched on the discriminant rather than a lookup so `note` is read off
    // the narrowed event: the kinds without one must not silently become
    // reasons.
    switch (event.kind) {
      case "card_version_promoted":
        decisions.push(toDecision("promoted", event, event.versionId));
        break;
      case "card_version_refused":
        decisions.push(toDecision("refused", event, event.versionId));
        break;
      case "card_withdrawn":
        decisions.push(toDecision("withdrawn", event, event.withdrawnVersionId));
        break;
      default:
        break;
    }
  }
  return decisions;
}

function toDecision(
  kind: ScopeDecision["kind"],
  event: {
    readonly cardId: CardId;
    readonly occurredAt: string;
    readonly note: string | undefined;
  },
  versionId: CardVersionId | undefined,
): ScopeDecision {
  return {
    kind,
    cardId: event.cardId,
    versionId,
    occurredAt: event.occurredAt,
    note: event.note,
  };
}

/** One Card Version carrying one Scope version, as the store hands it over. */
export interface ScopeSighting extends ScopeCarrier {
  readonly publicationId: PublicationId;
}

/**
 * Operational view of reachability across every Scope version Registry knows.
 *
 * This is a Registry read model for operators. It is not a `RetrievalGuide`,
 * and it is not an input to Selection: nothing here widens what a query can
 * reach.
 */

export interface ReachabilityReport {
  readonly generatedAt: string;
  /**
   * Per Source, in `sourceId` order.
   *
   * Per Source rather than one global position, because no ordering exists
   * between two Sources' chains. A single "processed up to here" number would
   * invent one, and a Source that is behind would look current whenever another
   * Source moved.
   */
  readonly sourceCheckpoints: readonly SourceProcessingLag[];
  readonly counts: Readonly<Record<ScopeReachabilityState, number>>;
  /**
   * Share of exposable Scope versions that a query can actually reach.
   *
   * Scopes awaiting processing are excluded because nothing has been decided
   * about them yet, and deliberately unexposed ones because they are not
   * meant to be reachable. Counting either would move the number for reasons
   * that are not problems. `1` when there is nothing to expose.
   */
  readonly currentReachabilityCoverage: number;
  readonly scopes: readonly ScopeReachability[];
}

export interface ReachabilityGateViolation {
  readonly rule: string;
  readonly message: string;
}

/**
 * Groups sightings into one observation per Scope version.
 *
 * Every sighting comes from a Card Version, and a Card Version only exists
 * once its Publication was processed, so these are all `processed`. Scope
 * versions of a Publication Registry has not consumed yet are invisible here
 * by construction; reporting them needs the ready-notification path, which
 * does not exist yet.
 */
export function collectScopeObservations(
  sightings: readonly ScopeSighting[],
  decisions: readonly ScopeDecision[],
): readonly ScopeObservation[] {
  const decisionsByCard = new Map<CardId, ScopeDecision[]>();
  for (const decision of decisions) {
    const existing = decisionsByCard.get(decision.cardId);
    if (existing === undefined) {
      decisionsByCard.set(decision.cardId, [decision]);
    } else {
      existing.push(decision);
    }
  }

  const observations = new Map<string, ScopeObservation>();
  for (const sighting of sightings) {
    const { publicationId, ...carrier } = sighting;
    const reference = carrier.scope.reference;
    const key = `${reference.scopeId}\u0000${reference.scopeVersion}`;
    const existing = observations.get(key);

    if (existing === undefined) {
      observations.set(key, {
        reference,
        introducedByPublicationId: publicationId,
        lastSeenPublicationId: publicationId,
        processed: true,
        carriers: [carrier],
        decisions: decisionsByCard.get(carrier.cardId) ?? [],
      });
      continue;
    }

    observations.set(key, {
      ...existing,
      // Sightings arrive in append order, so a later one is the more recent
      // Publication that still carried this Scope. The first stays fixed.
      lastSeenPublicationId: publicationId,
      carriers: [...existing.carriers, carrier],
      decisions: [
        ...existing.decisions,
        ...(decisionsByCard.get(carrier.cardId) ?? []).filter(
          (decision) => !existing.decisions.includes(decision),
        ),
      ],
    });
  }

  return [...observations.values()];
}

/** Rolls verdicts up into the report operators read. */
export function summarizeScopeReachability(
  generatedAt: string,
  verdicts: readonly ScopeReachability[],
  sourceCheckpoints: readonly SourceProcessingLag[] = [],
): ReachabilityReport {
  const counts: Record<ScopeReachabilityState, number> = {
    pending_registry: 0,
    broken: 0,
    reachable: 0,
    pending_approval: 0,
    intentionally_unexposed: 0,
    orphaned: 0,
  };
  for (const verdict of verdicts) {
    counts[verdict.state] += 1;
  }

  const exposable =
    verdicts.length -
    counts.pending_registry -
    counts.intentionally_unexposed;

  return {
    generatedAt,
    sourceCheckpoints: [...sourceCheckpoints].sort((left, right) =>
      left.sourceId < right.sourceId ? -1 : left.sourceId > right.sourceId ? 1 : 0,
    ),
    counts,
    currentReachabilityCoverage:
      exposable === 0 ? 1 : counts.reachable / exposable,
    scopes: verdicts,
  };
}

/**
 * Checks the report against the `registry-reachability-v1` release gate.
 *
 * A `broken` Scope means an approved Card points at something that no longer
 * holds. An `orphaned` one means knowledge was indexed and then left with no
 * decision recorded about it — and since a recorded reason makes a Scope
 * `intentionally_unexposed` instead, every `orphaned` Scope is by definition
 * one nobody explained. Neither ships.
 */
export function reachabilityGateViolations(
  report: ReachabilityReport,
): readonly ReachabilityGateViolation[] {
  const violations: ReachabilityGateViolation[] = [];

  if (report.counts.broken > 0) {
    violations.push({
      rule: "reachability.broken",
      message: `${report.counts.broken} scope version(s) are referenced by an approved Card that no longer resolves`,
    });
  }

  if (report.counts.orphaned > 0) {
    violations.push({
      rule: "reachability.orphaned_without_reason",
      message: `${report.counts.orphaned} scope version(s) are unreachable with no recorded reason`,
    });
  }

  return violations;
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

  // A version an operator already refused or withdrew is not awaiting review.
  // Withdrawing leaves the version `validated`, so its state alone would read
  // as promotable and hide a Scope nobody is serving any more behind a review
  // that is not happening.
  const decidedAgainst = new Set(
    decisions
      .filter((decision) => decision.kind !== "promoted")
      .map((decision) => decision.versionId),
  );
  const awaiting = carriers.filter(
    (carrier) =>
      carrier.validationState !== "rejected" &&
      !decidedAgainst.has(carrier.versionId),
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
    introducedByPublicationId: observation.introducedByPublicationId,
    lastSeenPublicationId: observation.lastSeenPublicationId,
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
      selection,
    ].join("|");
  }

  if (scope.kind === "sql_source") {
    // The schema belongs in the comparison: two schemas can hold a table of the
    // same name, and leaving it out would call those two Scopes identical.
    return [
      scope.kind,
      scope.connector,
      scope.schema,
      scope.table,
      [...scope.columns].sort().join(","),
    ].join("|");
  }

  // Operation ID and parameters are part of the Scope definition, so two
  // operations that differ only by their parameters must not compare equal.
  return [
    scope.kind,
    scope.connector,
    scope.method,
    scope.path,
    scope.operationId ?? "",
    scope.parameters
      .map((parameter) =>
        [parameter.location, parameter.name, parameter.required].join(":"),
      )
      .sort()
      .join(","),
  ].join("|");
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
