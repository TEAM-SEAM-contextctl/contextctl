import type { IngestionPublication, PublicationId } from "@contextctl/contracts";

/** Fetches the immutable Publication a PublicationReady envelope points to. */
export interface PublicationRepository {
  findById(
    publicationId: PublicationId,
  ): Promise<IngestionPublication | undefined>;
}
