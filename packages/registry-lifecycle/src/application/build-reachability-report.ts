import {
  collectScopeObservations,
  judgeScopeReachability,
  summarizeScopeReachability,
  toScopeDecisions,
  type ReachabilityReport,
} from "../domain/scope-reachability.js";
import type { Clock } from "../ports/clock.js";
import type { ConsumerCheckpointStore } from "../ports/consumer-checkpoint-store.js";
import type { ScopeReachabilityStore } from "../ports/scope-reachability-store.js";

export interface BuildReachabilityReportPorts {
  readonly scopes: ScopeReachabilityStore;
  readonly checkpoints: ConsumerCheckpointStore;
  readonly clock: Clock;
}

/**
 * Reports whether each published Scope version can still be reached by a query.
 *
 * Nothing is stored. The verdict is derived from committed Card state and the
 * audit trail on every call, so it cannot drift from the catalog the way a
 * second copy of the state would: a Scope is never reported reachable while it
 * is also awaiting approval, because both answers come from one read.
 *
 * Reading is all this does. An `orphaned` Scope stays out of the catalog and
 * out of every search; naming it is the point, and deciding what to do about
 * it belongs to an operator.
 */
export async function buildReachabilityReport(
  ports: BuildReachabilityReportPorts,
): Promise<ReachabilityReport> {
  const [sightings, decisions, cursors] = await Promise.all([
    ports.scopes.listScopeSightings(),
    ports.scopes.listOperatorDecisions(),
    ports.checkpoints.listCursors(),
  ]);

  const observations = collectScopeObservations(
    sightings,
    toScopeDecisions(decisions),
  );

  return summarizeScopeReachability(
    ports.clock.now(),
    observations.map(judgeScopeReachability),
    // Only what Registry consumed. The latest ready Publication per Source is
    // Ingestion's to report and arrives with the notification path, so the field
    // stays absent rather than guessed from the newest thing we happened to see.
    cursors.map((cursor) => ({
      sourceId: cursor.sourceId,
      processedPublicationId: cursor.publicationId,
    })),
  );
}
