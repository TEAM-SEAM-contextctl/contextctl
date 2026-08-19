import type { PublicationId, SourceId } from "@contextctl/contracts";

import type { ChainCursor } from "../domain/publication-chain.js";

/**
 * What Registry has consumed: which Publications were claimed, and how far each
 * Source's chain has been followed.
 *
 * The two are separate questions. A claim record answers "was this Publication
 * already handled", which makes redelivery a no-op. A cursor answers "what may
 * be handled next", which is what keeps a Source's chain linear. A store that
 * only kept claims would accept a Publication whose predecessor never arrived,
 * and the Card built on it would sit on a change nobody consumed.
 */
export interface ConsumerCheckpointStore {
  hasProcessed(publicationId: PublicationId): Promise<boolean>;

  /** How far this Source's chain has been consumed, or nothing yet. */
  findCursor(sourceId: SourceId): Promise<ChainCursor | undefined>;

  /**
   * Records the claim and moves the Source's cursor to it, together.
   *
   * One call rather than two so a crash cannot leave a Publication claimed with
   * the cursor still behind it: the next run would then refuse the successor as
   * a gap forever, because the predecessor it waits for is already consumed and
   * will never be redelivered as new work.
   */
  markProcessed(cursor: ChainCursor): Promise<void>;

  /** Every Source's cursor, for the reachability report. */
  listCursors(): Promise<readonly ChainCursor[]>;
}
