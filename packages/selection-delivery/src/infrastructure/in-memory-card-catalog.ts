import type { ApprovedCard } from "../domain/card-catalog.js";
import type { ApprovedCardCatalog } from "../ports/approved-card-catalog.js";

/**
 * An `ApprovedCardCatalog` served from a fixed set of Cards held in memory.
 *
 * The registry-backed adapter this port was written for does not exist yet, so
 * the demo and the end-to-end tests run against a catalog whose contents the
 * caller supplies. Keeping it here rather than in `test/` follows
 * ingestion-indexing, where adapters live in the package's `infrastructure/`
 * regardless of who assembles them; the daemon stays the only Composition Root.
 *
 * Both the constructor input and every result are copied, so a catalog cannot
 * be mutated through the array it was built from, and a caller that mutates a
 * returned array cannot change what the next call sees. The Cards themselves
 * are shared, not cloned: `ApprovedCard` is deeply readonly, so the type system
 * already forbids reaching into one.
 */
export class InMemoryCardCatalog implements ApprovedCardCatalog {
  readonly #cards: readonly ApprovedCard[];

  constructor(cards: readonly ApprovedCard[]) {
    this.#cards = [...cards];
  }

  listApprovedCards(): Promise<readonly ApprovedCard[]> {
    return Promise.resolve([...this.#cards]);
  }
}
