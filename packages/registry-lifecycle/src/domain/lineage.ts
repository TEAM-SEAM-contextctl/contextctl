// Mirrors the identifier shapes @contextctl/contracts publishes for
// IngestionPublication. Reused as plain strings here because slice 1 only
// needs domain invariants; the real contracts dependency arrives with slice 2
// once this package actually parses an IngestionPublication.
export type PublicationId = string;
export type ObservationId = string;
export type KnowledgeUnitId = string;
export interface PublishedScopeRef {
  readonly scopeId: string;
  readonly scopeVersion: string;
}

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
