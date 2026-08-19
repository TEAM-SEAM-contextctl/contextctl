import type {
  IndexPublicationStoreV2,
  IngestionPublicationStore,
} from "@contextctl/ingestion-indexing";
import type { PublicationRepository } from "@contextctl/registry-lifecycle";

/**
 * Serves Registry's `PublicationRepository` out of Ingestion's Publication
 * outbox, across the contract version the two domains disagree on.
 *
 * ★ This is a bridge, not a translation the design calls for. Ingestion
 * publishes `IngestionPublication` schema version 2; Registry's
 * `claimPublication` still consumes schema version 1. Nothing in either domain
 * spans the two, so without this file the vertical path stops between "the
 * document was indexed" and "a Card exists" — which is where it actually stood
 * before this was written. The daemon is the only place allowed to name both
 * domains, so the bridge lives here rather than inside either of them, and it
 * is deliberately one file so that deleting it is the whole migration once
 * Registry adopts v2.
 *
 * Two differences have to be carried:
 *
 *  1. **The physical binding.** v2 removed `connectorId` and `accessHandle`
 *     from a published Scope on purpose — the shared contract fixture asserts
 *     they never appear there — and moved them into the catalog record's
 *     `binding`, which stays inside Indexing. Registry's `RetrievalScope` and
 *     Selection's approved read model both still require them, and Selection's
 *     retriever searches with them. They are read back out of the index catalog
 *     rather than invented: the catalog record for the exact `indexVersion` the
 *     Scope pins is the one physical binding that Scope was published against.
 *
 *  2. **`kind: "segment"`.** v2 added a fifth Knowledge Unit kind that v1 has no
 *     name for. It is mapped to `section`, which is inert — nothing in Registry
 *     reads `kind`; `claimPublication` uses `id`, `sourceCoordinate`,
 *     `evidence`, and `publishedScopes`. The mapping exists so the value is
 *     legal, not because the two mean the same thing.
 *
 * Types are derived from the two ports rather than imported from
 * `@contextctl/contracts`, for the reason `ingestion-managed-document-retriever.ts`
 * derives its Scope type: the daemon declares three workspace dependencies and
 * the contract package is not one of them.
 */
export class IngestionPublicationRepository implements PublicationRepository {
  readonly #publications: IngestionPublicationStore;
  readonly #catalog: IndexPublicationStoreV2;

  constructor(
    publications: IngestionPublicationStore,
    catalog: IndexPublicationStoreV2,
  ) {
    this.#publications = publications;
    this.#catalog = catalog;
  }

  async findById(
    publicationId: Parameters<PublicationRepository["findById"]>[0],
  ): Promise<Awaited<ReturnType<PublicationRepository["findById"]>>> {
    const published = await this.#publications.find(publicationId);
    if (published === undefined) {
      return undefined;
    }
    const knowledgeUnits: RegistryUnit[] = [];
    for (const unit of published.knowledgeUnits) {
      // Named field by field rather than spread: the two Knowledge Unit
      // versions differ in more than the two fields translated below, and a
      // spread would carry whatever v2 adds next into a v1 record unnoticed.
      knowledgeUnits.push({
        id: unit.id,
        kind: toRegistryUnitKind(unit.kind),
        sourceCoordinate: unit.sourceCoordinate,
        // v2 renamed the field to `facts`; the values are the same observed
        // facts Registry grounds a Card's meaning against.
        evidence: unit.facts,
        publishedScopes: await this.#toRegistryScopes(unit.publishedScopes),
        provenance: unit.provenance,
        contentDigest: unit.contentDigest,
      });
    }
    return { ...published, schemaVersion: 1, knowledgeUnits };
  }

  async #toRegistryScopes(
    scopes: readonly IngestionScope[],
  ): Promise<RegistryScope[]> {
    const translated: RegistryScope[] = [];
    for (const scope of scopes) {
      if (scope.kind !== "managed_document") {
        // SQL and HTTP Scopes carry no physical binding in either version, so
        // v2's shape is v1's shape plus fields v1 never named.
        translated.push(scope);
        continue;
      }
      translated.push({
        ...scope,
        documentIndex: {
          ...scope.documentIndex,
          ...(await this.#bindingFor(scope.documentIndex)),
        },
      });
    }
    return translated;
  }

  /**
   * The connector and access handle the pinned index version was published
   * under.
   *
   * `findVersion` rather than `current`: a Scope names an `indexVersion`, and
   * answering from whatever is current would attach the binding of a different
   * version of the document to a Card that approved this one.
   */
  async #bindingFor(documentIndex: {
    readonly documentIndexId: string;
    readonly indexVersion: string;
  }): Promise<{ readonly connectorId: string; readonly accessHandle: string }> {
    const publication = await this.#catalog.findVersion({
      documentIndexId: documentIndex.documentIndexId,
      indexVersion: documentIndex.indexVersion,
    });
    if (publication === undefined) {
      // Refused rather than defaulted. A Card whose Scope carries a guessed
      // handle would be approved, served, and then fail every retrieval, and
      // the guess would be indistinguishable from a real binding in the store.
      throw new TypeError(
        `no index catalog record for ${documentIndex.documentIndexId} at ${documentIndex.indexVersion}`,
      );
    }
    return {
      connectorId: publication.binding.connectorId,
      accessHandle: publication.binding.accessHandle,
    };
  }
}

type RegistryPublication = NonNullable<
  Awaited<ReturnType<PublicationRepository["findById"]>>
>;
type RegistryUnit = RegistryPublication["knowledgeUnits"][number];
type RegistryScope = RegistryUnit["publishedScopes"][number];

type IngestionPublicationRecord = NonNullable<
  Awaited<ReturnType<IngestionPublicationStore["find"]>>
>;
type IngestionUnit = IngestionPublicationRecord["knowledgeUnits"][number];
type IngestionScope = IngestionUnit["publishedScopes"][number];

function toRegistryUnitKind(kind: IngestionUnit["kind"]): RegistryUnit["kind"] {
  return kind === "segment" ? "section" : kind;
}
