import {
  collectScopeObservations,
  judgeScopeReachability,
  summarizeScopeReachability,
  toScopeDecisions,
  type ReachabilityReport,
} from "../domain/scope-reachability.js";
import type { Clock } from "../ports/clock.js";
import type { ScopeReachabilityStore } from "../ports/scope-reachability-store.js";

export interface BuildReachabilityReportPorts {
  readonly scopes: ScopeReachabilityStore;
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
  const [sightings, decisions] = await Promise.all([
    ports.scopes.listScopeSightings(),
    ports.scopes.listOperatorDecisions(),
  ]);

  const observations = collectScopeObservations(
    sightings,
    toScopeDecisions(decisions),
  );

  return summarizeScopeReachability(
    ports.clock.now(),
    observations.map(judgeScopeReachability),
  );
}
