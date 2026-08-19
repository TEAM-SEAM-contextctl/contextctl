import type { PublicationId, SourceId } from "@contextctl/contracts";

/** Where a Publication sits relative to what this Source has already consumed. */
export type ChainPosition =
  /** No cursor yet, and this Publication starts the chain. */
  | { readonly kind: "first" }
  /** Follows the cursor exactly, so it may be consumed now. */
  | { readonly kind: "next" }
  /**
   * A later Publication arrived before its predecessor. Consumable once the
   * missing one lands, so it waits rather than failing.
   */
  | {
      readonly kind: "gap";
      readonly expectedAfter: PublicationId;
      readonly awaiting: PublicationId;
    }
  /**
   * Two Publications claim the same predecessor, or none is named where one
   * must be. The chain is not linear any more and no reading of it is safe.
   */
  | { readonly kind: "fork"; readonly reason: string };

/** What the Source has consumed so far, as far as this consumer is concerned. */
export interface ChainCursor {
  readonly sourceId: SourceId;
  readonly publicationId: PublicationId;
}

/** The chain fields of a Publication. Nothing else takes part in ordering. */
export interface ChainLink {
  readonly publicationId: PublicationId;
  readonly sourceId: SourceId;
  readonly previousPublicationId?: PublicationId | undefined;
}

/**
 * Places a Publication in its Source's chain.
 *
 * Publications form one linear chain per Source, and `previousPublicationId` is
 * the only thing that says where a link belongs. `producedAt`, arrival order,
 * and array order are all excluded on purpose: a retry can be produced later
 * than the Publication that follows it, and notifications arrive in whatever
 * order the transport managed. Ordering by any of those would consume a chain
 * that was never published.
 *
 * "Have I consumed this already?" is not asked here — that is a question for the
 * claim record, and the caller answers it first. This function only answers
 * whether a Publication follows what the cursor covers.
 *
 * The distinction that matters most is gap from fork. A gap is a Publication
 * that will become consumable once its predecessor lands, so it is kept for
 * reconciliation. A fork means two links claim the same place and no ordering
 * exists at all, so the Source stops rather than picking one.
 */
export function locateInChain(
  cursor: ChainCursor | undefined,
  link: ChainLink,
): ChainPosition {
  if (cursor === undefined) {
    if (link.previousPublicationId === undefined) {
      return { kind: "first" };
    }
    // The predecessor may simply not have been consumed yet — that is a gap the
    // reconciler can close. Calling it a fork would stop a Source that is only
    // out of order.
    return {
      kind: "gap",
      expectedAfter: link.previousPublicationId,
      awaiting: link.publicationId,
    };
  }

  if (cursor.sourceId !== link.sourceId) {
    return {
      kind: "fork",
      reason: `cursor belongs to source ${cursor.sourceId}, publication to ${link.sourceId}`,
    };
  }

  if (link.previousPublicationId === undefined) {
    // A second chain start for a Source that already consumed one. Accepting it
    // would silently abandon everything the cursor already covers.
    return {
      kind: "fork",
      reason: `publication ${link.publicationId} starts a second chain for source ${link.sourceId}, which already consumed ${cursor.publicationId}`,
    };
  }

  return link.previousPublicationId === cursor.publicationId
    ? { kind: "next" }
    : {
        kind: "gap",
        expectedAfter: link.previousPublicationId,
        awaiting: link.publicationId,
      };
}
