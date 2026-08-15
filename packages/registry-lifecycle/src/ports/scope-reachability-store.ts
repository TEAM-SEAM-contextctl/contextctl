import type { LifecycleEvent } from "../domain/lifecycle-event.js";
import type { ScopeSighting } from "../domain/scope-reachability.js";

/**
 * Reads what reachability judges: every Scope version Registry has processed,
 * and the operator decisions behind the Cards that carry them.
 *
 * Kept apart from `CardStore` because the questions differ. `CardStore` serves
 * Cards that are current, and every consumer of it wants only those; this port
 * needs the versions that stopped serving, since a refused or withdrawn one is
 * exactly what separates a deliberate exclusion from an orphaned Scope. An
 * adapter is free to answer both from the same database.
 */
export interface ScopeReachabilityStore {
  /**
   * Every Scope version ever carried by any Card Version, current or not,
   * flattened so a Card Version carrying several yields one row each.
   */
  listScopeSightings(): Promise<readonly ScopeSighting[]>;

  /**
   * Every approval, refusal, and withdrawal across all Cards.
   *
   * Asking per Card would issue one query per Card, and the remaining event
   * kinds decide nothing about whether a Scope is exposed.
   */
  listOperatorDecisions(): Promise<readonly LifecycleEvent[]>;
}
