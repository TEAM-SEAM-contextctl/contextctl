import type { ApprovedCard } from "../domain/card-catalog.js";

/**
 * Supplies the approved Cards a query is selected over.
 *
 * Selection declares this port because Selection is the side that needs the
 * shape; the implementation is a registry-backed adapter the daemon assembles.
 * Meaning and Scopes come back inline rather than behind further lookups, so
 * an N+1 access pattern is ruled out by the contract instead of by adapter
 * discipline.
 */
export interface ApprovedCardCatalog {
  listApprovedCards(): Promise<readonly ApprovedCard[]>;
}
