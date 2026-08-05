import type { CardCatalogEntry } from "../domain/card-catalog.js";
import type { CardId, CardVersion } from "../domain/card-version.js";
import type { ContextCard } from "../domain/context-card.js";
import type { LifecycleEvent } from "../domain/lifecycle-event.js";

/**
 * Persists Cards and their append-only version history.
 *
 * Every method returns a Promise even though a given adapter may reach a
 * synchronous store, so swapping in an asynchronous database never changes
 * these signatures. No transaction handle is exposed: `saveCard` takes the
 * events that describe the change so each adapter can make the whole write
 * atomic its own way.
 */
export interface CardStore {
  findCard(cardId: CardId): Promise<ContextCard | undefined>;

  /** Current version of every Card that has one, for impact assessment. */
  listCurrentVersions(): Promise<readonly CardVersion[]>;

  /**
   * The approved Card catalog, with meaning, policy, and scopes all inline.
   *
   * Returning them together is the point: a caller that had to fetch meaning
   * per Card would issue one query per Card, and the catalog is read on every
   * query. Cards with no current version are absent, so a withdrawn Card stops
   * being served without any extra filtering by the caller.
   */
  listApprovedCards(): Promise<readonly CardCatalogEntry[]>;

  /**
   * Writes the Card, any version it gained, and the given events as one unit.
   * Versions already stored are never rewritten, so history stays append-only
   * and the last-known-good version cannot be clobbered by a later save.
   */
  saveCard(
    card: ContextCard,
    events: readonly LifecycleEvent[],
  ): Promise<void>;
}
