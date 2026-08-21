import type { ChainCursor } from "../domain/publication-chain.js";
import type { ContextCard } from "../domain/context-card.js";
import type { LifecycleEvent } from "../domain/lifecycle-event.js";

/** One Card as intake leaves it, with the events describing the change. */
export interface IntakenCard {
  readonly card: ContextCard;
  readonly events: readonly LifecycleEvent[];
}

/** Everything one consumed Publication changes about Registry's state. */
export interface PublicationIntake {
  readonly cards: readonly IntakenCard[];
  /** Where the Source's cursor lands, committed with the Cards above. */
  readonly cursor: ChainCursor;
}

/**
 * Commits a whole Publication's effect on Registry, or none of it.
 *
 * A separate port rather than a wider `CardStore` or `ConsumerCheckpointStore`,
 * because the thing being asked for is neither storing a Card nor recording
 * consumption — it is that those two happen together. Widening either store
 * would put the other's concern inside it: a Card store that knows about
 * consumer cursors, or a checkpoint store that writes Cards.
 *
 * Before this existed the composition wrote Cards one at a time and then marked
 * the Publication consumed. A crash in between left drafts stored with the
 * cursor behind them, and the alternative order was worse — a Publication
 * counted as consumed with no Card to show for it, unrecoverable because
 * redelivery answers `already_claimed`. Neither order is safe, so the ordering
 * question is removed instead of answered.
 *
 * `commit` takes no transaction handle. An adapter that reaches a store with
 * transactions uses one; one that does not has to find another way to be atomic.
 * Exposing a handle here would put a storage concept into a port the domain owns.
 */
export interface IntakeStore {
  commit(intake: PublicationIntake): Promise<void>;
}
