import type {
  IngestionPublication,
  PublicationId,
  SourceId,
} from "@contextctl/contracts";

/** Fetches the immutable Publication a PublicationReady envelope points to. */
export interface PublicationRepository {
  findById(
    publicationId: PublicationId,
  ): Promise<IngestionPublication | undefined>;
}

/**
 * The newest Publication Ingestion has made ready for one Source.
 *
 * Separate from `PublicationRepository` because the questions are different, and
 * so are the callers. Consuming asks "give me the record this notification names"
 * and needs nothing else; measuring how far behind we are asks "what is the
 * newest thing there is", which is a read no consumption path performs. A single
 * interface would hand every claim path a capability it must not use — Registry
 * consuming the newest Publication instead of the next one is precisely the
 * out-of-order consumption the chain guard exists to prevent.
 */
export interface SourcePublicationFeed {
  latestForSource(sourceId: SourceId): Promise<IngestionPublication | undefined>;
}
