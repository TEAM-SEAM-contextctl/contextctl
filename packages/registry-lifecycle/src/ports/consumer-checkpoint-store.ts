import type { PublicationId } from "@contextctl/contracts";

/** Tracks which Publications Registry has already claimed, for idempotent consumption. */
export interface ConsumerCheckpointStore {
  hasProcessed(publicationId: PublicationId): Promise<boolean>;
  markProcessed(publicationId: PublicationId): Promise<void>;
}
