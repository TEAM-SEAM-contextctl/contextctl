import type { IngestionPublicationStore } from "@contextctl/ingestion-indexing";
import type { PublicationRepository } from "@contextctl/registry-lifecycle";

/**
 * Serves Registry's `PublicationRepository` out of Ingestion's Publication
 * outbox.
 *
 * Both domains now speak `IngestionPublication` schema version 2, so nothing is
 * translated here — what is left is the wiring the two ports cannot do
 * themselves: Ingestion answers `find`, Registry asks `findById`, and the daemon
 * is the only place allowed to name both. Registry deliberately ships no adapter
 * for this port, because a Publication is Ingestion's output and Registry
 * storing it would reverse who owns it.
 *
 * ★ This file used to be a bridge across the version the two domains disagreed
 * on: it renamed `facts` back to `evidence`, mapped v2's `segment` kind onto
 * `section`, and read `connectorId`/`accessHandle` back out of the index catalog
 * because Registry and Selection still required a physical binding v2 had
 * removed. All of that is gone. Selection dropped the binding from its approved
 * read model (SEAM-79) and Registry consumes v2 directly (SEAM-69), so the
 * values no longer have anywhere to go — which also closes the risk that a v1
 * `.strict()` parse would refuse a record carrying v2's extra Scope fields.
 */
export class IngestionPublicationRepository implements PublicationRepository {
  readonly #publications: IngestionPublicationStore;

  constructor(publications: IngestionPublicationStore) {
    this.#publications = publications;
  }

  async findById(
    publicationId: Parameters<PublicationRepository["findById"]>[0],
  ): Promise<Awaited<ReturnType<PublicationRepository["findById"]>>> {
    return this.#publications.find(publicationId);
  }
}
