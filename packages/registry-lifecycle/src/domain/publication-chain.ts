import type { PublicationId, SourceId } from "@contextctl/contracts";

/**
 * Why a Source's chain could not be consumed, in a form a program can act on.
 *
 * The design requires a refused Publication to leave an operator diagnostic, and
 * the design says what one is made of: a bounded machine-readable code plus the
 * logical object ids, not prose. A sentence alone cannot be classified, so the
 * daemon receiving it could not tell which lane to degrade or which refusals are
 * the same kind of problem.
 */
export type ConsumptionDiagnosticCode =
  | "publication_chain_gap"
  | "publication_chain_forked";

/**
 * The grammar a diagnostic code has to fit.
 *
 * The same shape Selection requires of an executor's failure codes: lowercase,
 * underscore-separated, starting with a letter, at most 64 characters. Stated
 * again here rather than shared, because it is a convention about how a code
 * looks and not a contract between two domains — promoting it would make a
 * boundary type out of a value the daemon only classifies and prints. What
 * matters is that both domains produce codes the daemon can treat one way.
 */
export const CONSUMPTION_DIAGNOSTIC_CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/u;

/**
 * One refusal, as a code and the sentence a person reads.
 *
 * The two are kept apart on purpose. `code` is what the daemon branches on and
 * groups by; `detail` names the specific Publications that collided, which no
 * code can carry and an operator needs to resolve the fork by hand.
 */
export interface ConsumptionDiagnostic {
  readonly code: ConsumptionDiagnosticCode;
  readonly detail: string;
}

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
      readonly diagnostic: ConsumptionDiagnostic;
    }
  /**
   * Two Publications claim the same predecessor, or none is named where one
   * must be. The chain is not linear any more and no reading of it is safe.
   */
  | { readonly kind: "fork"; readonly diagnostic: ConsumptionDiagnostic };

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
    return gap(link.previousPublicationId, link.publicationId);
  }

  if (cursor.sourceId !== link.sourceId) {
    return fork(
      `cursor belongs to source ${cursor.sourceId}, publication to ${link.sourceId}`,
    );
  }

  if (link.previousPublicationId === undefined) {
    // A second chain start for a Source that already consumed one. Accepting it
    // would silently abandon everything the cursor already covers.
    return fork(
      `publication ${link.publicationId} starts a second chain for source ${link.sourceId}, which already consumed ${cursor.publicationId}`,
    );
  }

  return link.previousPublicationId === cursor.publicationId
    ? { kind: "next" }
    : gap(link.previousPublicationId, link.publicationId);
}

function gap(
  expectedAfter: PublicationId,
  awaiting: PublicationId,
): ChainPosition {
  return {
    kind: "gap",
    expectedAfter,
    awaiting,
    diagnostic: {
      code: "publication_chain_gap",
      detail: `publication ${awaiting} follows ${expectedAfter}, which has not been consumed`,
    },
  };
}

function fork(detail: string): ChainPosition {
  return { kind: "fork", diagnostic: { code: "publication_chain_forked", detail } };
}
