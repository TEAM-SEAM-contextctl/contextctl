import type {
  KnowledgeUnitId,
  ObservationId,
  PublicationId,
  PublishedScopeRef,
} from "@contextctl/contracts";

/**
 * Pins a Card Version to the specific Publication, Observation, and
 * versioned Retrieval Scope Reference it was created from. Registry never
 * evaluates a Card independently of this lineage.
 */
export interface CardLineage {
  readonly publicationId: PublicationId;
  readonly observationId: ObservationId;
  readonly knowledgeUnitId: KnowledgeUnitId;
  readonly scopeRef: PublishedScopeRef;
}

export type { KnowledgeUnitId, ObservationId, PublicationId, PublishedScopeRef };
