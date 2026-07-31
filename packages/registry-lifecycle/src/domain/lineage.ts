import type {
  KnowledgeUnitId,
  ObservationId,
  PublicationId,
} from "@contextctl/contracts";

/**
 * Pins a Card Version to the Publication and Observation it was created from.
 * Scope revisions are pinned separately by each `RetrievalScope.reference`, so
 * a Card Version stays version-consistent even while newer Publications are
 * being processed.
 */
export interface CardLineage {
  readonly publicationId: PublicationId;
  readonly observationId: ObservationId;
  readonly knowledgeUnitId: KnowledgeUnitId;
}

export type { KnowledgeUnitId, ObservationId, PublicationId };
